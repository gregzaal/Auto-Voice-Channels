import type {
  AutoChannelRepository,
  GuildSettingsReader,
  Logger,
  ManagedChannelRepository,
  ManagedChannelRow,
  SecondaryChannelRepository,
  SecondaryChannelRow,
} from '@avc/core';
import { isEntitled } from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { GuildVoiceView, MemberActivity, VoiceMember, VoiceStateEvent } from './types.js';
import { getGameName, MAX_STATUS_LENGTH, renderChannelName } from './nameTemplate.js';
import { displayName, groupKeyFor, parseVoiceSettings, readGroups } from './guildSettings.js';
import { isPermissionError } from './discordAdapter.js';
import {
  permissionProblemMessage,
  type PermissionOperation,
  type PermissionProblemTracker,
} from './permissionProblems.js';
import type { CommandResult } from './commands.js';

/** A fresh 31-bit random seed for a channel's `[[random]]` picks. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Whether two id lists are element-wise equal (to skip no-op roster writes). */
function sameOrder(a: readonly string[], b: readonly string[] | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/**
 * The per-guild event-log line for a rename (`/logging` level 2). When Discord
 * deferred the rename under its per-channel edit limit (2 / 10 min), say so — the
 * new name is queued and applies once the limit clears — rather than claiming the
 * rename already happened.
 */
function renameLogMessage(channelId: string, name: string, rateLimited: boolean): string {
  return rateLimited
    ? `⏳ Rename of <#${channelId}> to **${name}** deferred. Discord is rate-limiting renames on this channel, so the new name will apply within a few minutes.`
    : `✏️ <#${channelId}> renamed to **${name}**`;
}

/** Decision returned by a {@link CreationGate}. */
export interface CreateGateDecision {
  allowed: boolean;
  /** Human-readable reason when not allowed (for logs/diagnostics). */
  reason?: string;
  /**
   * Whether to skip repairing a block whose rooms render out of order.
   *
   * Rides on this decision rather than being its own dependency because the gate
   * is already consulted once per create and already caches its flag read, so
   * the lever costs no extra database traffic. It exists at all because the
   * repair is the only thing here that rewrites a guild's channel layout without
   * anyone asking, and the alternative levers are `global.pause`, which stops
   * rooms being created at all, and a deploy.
   */
  orderRepairDisabled?: boolean;
}

/**
 * Runtime guard consulted before actually creating a secondary — the seam for
 * the no-deploy control plane (global pause, per-guild creation throttle). Kept
 * as an interface so the feature stays decoupled from the flags store and is
 * testable without one. Absent → creation is always allowed.
 */
export interface CreationGate {
  allowCreate(guildId: string): Promise<CreateGateDecision>;
}

export interface VoiceFeatureDeps {
  autoChannels: AutoChannelRepository;
  secondaries: SecondaryChannelRepository;
  /**
   * Adopted standalone channels whose name the bot manages (`/template` on an
   * unmanaged channel). Optional so the feature is testable without it; when
   * absent, no channel is treated as managed.
   */
  managed?: ManagedChannelRepository;
  guilds: GuildSettingsReader;
  actions: VoiceActions;
  voice: GuildVoiceView;
  selfHosted: boolean;
  logger: Logger;
  /** Optional runtime gate for live creation (pause / throttle). */
  gate?: CreationGate;
  /**
   * Called after a secondary's record is removed (deletion or reconcile), so
   * dependent resources (e.g. a private channel's "⇩ Join" companion) can be
   * cleaned up. Must be idempotent and tolerate an unknown channel.
   */
  onSecondaryRemoved?: (guildId: string, channelId: string) => Promise<void>;
  /**
   * Called when a secondary's ownership is reassigned because the owner left
   * (while others remain), so dependent resources (a private channel's "⇩ Join"
   * companion) can be re-pointed at the new owner. Idempotent.
   */
  onOwnerChanged?: (
    guildId: string,
    channelId: string,
    newOwnerId: string,
    newOwnerName: string,
  ) => Promise<void>;
  /**
   * Resolves a secondary's "⇩ Join" companion channel id, if it has one (private
   * channels). Used by `/position` so a companion moves with its secondary.
   */
  joinCompanionFor?: (secondaryChannelId: string) => Promise<string | undefined>;
  /**
   * Applies the private treatment to a just-spawned secondary when its primary is
   * `defaultPrivate` (mirrors `/private`, but grants Connect to the creator by id
   * since their move may not be in the voice cache yet). Idempotent; no-op when
   * unset.
   */
  makePrivateOnCreate?: (
    guildId: string,
    channelId: string,
    ownerId: string,
    ownerName: string,
  ) => Promise<void>;
  /**
   * Optional sink for per-guild event logging (`/logging`). Level 1 = channels
   * created/deleted, 2 = + renames & ownership changes, 3 = + members
   * joining/leaving. Fire-and-forget.
   */
  serverLog?: (guildId: string, level: 1 | 2 | 3, message: string) => void;
  /**
   * Records "I cannot act on this channel" incidents, feeding three
   * deliberately separate surfaces: `/setup` (on demand), the paired
   * `serverLog` call (contemporaneous, `/logging` guilds only), and
   * `onRecord` -> `PermissionProblemNotifier` (the only one that reaches a
   * guild with nothing configured, so it alone is throttled/aggregated).
   */
  permissionProblems?: PermissionProblemTracker;
  /**
   * Counts a room's birth or death, for the metric store. Fire-and-forget and
   * optional. Counted here because `secondary_channels` rows are deleted with
   * the channel they describe, so an uncounted room is unrecoverable, not
   * merely un-charted.
   *
   * `deleted` means **the bot cleaned a room up**, not "a room stopped
   * existing" - a human deleting it, or reconcile dropping a stale row, are
   * deliberately not counted, or the number would stop answering whether
   * cleanup is working.
   */
  countRoom?: (event: 'created' | 'deleted') => void;
  /**
   * Defense in depth for the "cache says gone, delete the row" branches below.
   * `reconcileGuild` should only run for a guild whose shard this instance
   * holds, but nothing enforces that - and for an unowned guild, the local
   * discord.js cache has no data at all, so `channelExists` reads false for
   * every real, live channel. Omitted → the cache is trusted as-is (tests,
   * self-host, single-instance fleets, where this is always correct).
   */
  ownsGuild?: (guildId: string) => boolean;
}

/** Common option for state-changing operations: report without acting. */
export interface ReconcileOptions {
  dryRun?: boolean;
  /**
   * What to do when the bot turns out to have *lost access* to the channel.
   * Background callers (the re-render scheduler, reconcile) pass `abandon`:
   * the row has to go or every sweep retries the same impossible edit
   * forever. Interactive callers keep the default `report`, which rethrows
   * and leaves the row alone, since an admin who just wrote a template must
   * never have it binned for a problem they can fix by granting a permission.
   * A confirmed *deleted* channel is dropped either way, since no template
   * can outlive the channel it names.
   */
  onUnmanageable?: 'abandon' | 'report';
}

/** Options for a re-render: dry-run plus an optional sibling-position override. */
export interface RerenderOptions extends ReconcileOptions {
  /** Override the channel number (`##`) with a freshly-computed sibling index. */
  index?: number;
}

/** Result of re-rendering one secondary. */
export interface RerenderResult {
  /** The new name when it changed (or would, under dry-run); absent when unchanged. */
  name?: string;
  /** The new voice status when it changed (`''` = cleared); absent when unchanged. */
  status?: string;
  /** True when the rename was deferred by Discord's per-channel rate limit. */
  rateLimited?: boolean;
}

/** Aggregate result of re-rendering several secondaries (e.g. after `/nick`). */
export interface RerenderSummary {
  considered: number;
  renamed: number;
  rateLimited: number;
}

/** A snapshot of everything that feeds a channel's name, for `/debug`. */
export interface ChannelDebug {
  channelId: string;
  isPrimary: boolean;
  isSecondary: boolean;
  secondary?: {
    ownerId: string | null;
    primaryChannelId: string;
    state: Record<string, unknown>;
  };
  /** The template actually used: per-channel override → primary → guild default. */
  effectiveTemplate: string;
  primaryTemplate?: string;
  guildSettings: {
    enabled: boolean;
    general: string;
    defaultTemplate: string;
    aliasCount: number;
  };
  members: {
    id: string;
    displayName: string;
    bot: boolean;
    playing: string[];
    activities: MemberActivity[];
    selfStreaming: boolean;
  }[];
  /** The representative game name the tokens would resolve to right now. */
  computedGame: string;
  /** What `renderChannelName` produces for this channel right now. */
  renderedName?: string;
  seed?: number;
}

type CreateOutcome =
  | { action: 'created'; channelId: string }
  | { action: 'would-create' }
  | { action: 'skip' };

type CleanupOutcome = { action: 'deleted' | 'would-delete' | 'skip' };

/** Whose templates an editor panel edits: one channel (`/name`) or a primary (`/template`). */
export type EditorScope = 'channel' | 'primary' | 'adopted';
/** Which template within a scope. */
export type EditorField = 'name' | 'status';

/** The state of one template (name or status) within an editor panel. */
export interface EditorFieldState {
  /** The saved override/template; undefined → inheriting the default. */
  currentTemplate?: string;
  /** The template in effect (modal-prefill base). */
  effectiveTemplate: string;
  /** What it renders to for the channel right now. */
  preview: string;
}

/** Data backing a `/name` or `/template` editor panel (both name + status). */
export interface EditorState {
  found: boolean;
  scope: EditorScope;
  name: EditorFieldState;
  status: EditorFieldState;
  /** The secondary's owner (for the `/name` permission check). */
  ownerId?: string | null;
  primaryChannelId?: string;
}

/** What a single-guild reconcile changed (or, under dry-run, would change). */
export interface GuildDrift {
  guildId: string;
  dryRun: boolean;
  /**
   * Records whose Discord channel had vanished, so the record was dropped:
   * secondaries and adopted standalone channels. Never a Discord action, and
   * never a creator channel (see the note in the primaries loop).
   */
  orphanedRecords: string[];
  /** Empty secondaries deleted. */
  deletedEmpty: string[];
  /** Secondaries spawned for members still sitting in a primary. */
  created: { primaryChannelId: string; memberId: string; secondaryId?: string }[];
  /** Surviving secondaries whose name drifted and was corrected. */
  renamed: { channelId: string; to: string }[];
}

/**
 * Core voice feature: spawn a secondary when a member joins a primary, and clean
 * it up when it empties. Ported from the legacy `on_voice_state_update` +
 * `create_secondary` + `delete_secondary`.
 *
 * Every operation is idempotent so the dispatcher can safely replay events:
 * - creation is guarded by re-checking the member is *still* in the primary;
 * - deletion only acts on a tracked, empty secondary and tolerates a missing
 *   channel.
 */
export class VoiceFeature {
  constructor(private readonly deps: VoiceFeatureDeps) {}

  async handleVoiceStateUpdate(event: VoiceStateEvent): Promise<string[]> {
    if (event.beforeChannelId === event.afterChannelId) return []; // mute/unmute

    const { afterChannelId, beforeChannelId, guildId } = event;
    const touched: string[] = [];

    // Cleanup runs regardless of enabled/entitlement so disabling never strands
    // channels. A secondary that loses a member but isn't emptied is scheduled
    // for a re-render (its `@@num@@`/game may have changed).
    if (beforeChannelId !== undefined) {
      const { action } = await this.maybeCleanup(guildId, beforeChannelId);
      if (
        action !== 'deleted' &&
        (await this.deps.secondaries.isSecondary(guildId, beforeChannelId))
      ) {
        // Prune the leaver from the arrival roster, and if they owned the channel
        // hand it to the longest-present remainer before the re-render — so
        // `@@creator@@` resolves to the new owner (not "Unknown") and a private
        // channel's "⇩ Join" follows suit.
        await this.handleSecondaryLeave(guildId, beforeChannelId, event.member.id);
        this.deps.serverLog?.(guildId, 3, `🚪 <@${event.member.id}> left <#${beforeChannelId}>`);
        touched.push(beforeChannelId);
      } else if (await this.isManaged(guildId, beforeChannelId)) {
        // An adopted standalone channel: update its roster/owner and re-render
        // (to the resting "empty" name once the last member leaves).
        await this.handleManagedLeave(guildId, beforeChannelId, event.member.id);
        this.deps.serverLog?.(guildId, 3, `🚪 <@${event.member.id}> left <#${beforeChannelId}>`);
        touched.push(beforeChannelId);
      }
    }

    if (afterChannelId !== undefined) {
      await this.maybeCreate(guildId, afterChannelId, event.member);
      // Joining an existing secondary (not a primary) may change its name, and
      // appends the member to its arrival roster.
      if (await this.deps.secondaries.isSecondary(guildId, afterChannelId)) {
        await this.addToRoster(guildId, afterChannelId, event.member.id);
        this.deps.serverLog?.(guildId, 3, `🔊 <@${event.member.id}> joined <#${afterChannelId}>`);
        touched.push(afterChannelId);
      } else if (await this.isManaged(guildId, afterChannelId)) {
        // An adopted standalone channel: claim ownership if empty, then re-render
        // (to the "occupied" name once someone joins).
        await this.handleManagedJoin(guildId, afterChannelId, event.member.id);
        this.deps.serverLog?.(guildId, 3, `🔊 <@${event.member.id}> joined <#${afterChannelId}>`);
        touched.push(afterChannelId);
      }
    }

    return touched;
  }

  /** Whether `channelId` is an adopted managed channel (false when none wired). */
  private async isManaged(guildId: string, channelId: string): Promise<boolean> {
    return (await this.deps.managed?.isManaged(guildId, channelId)) ?? false;
  }

  /**
   * Creates a secondary for `member` joining `channelId` if it's a primary, the
   * guild is enabled+entitled, and the member is still in the primary. Returns
   * the new channel id when created, `would-create` under dry-run, else `skip`.
   */
  private async maybeCreate(
    guildId: string,
    channelId: string,
    member: VoiceMember,
    opts: ReconcileOptions = {},
  ): Promise<CreateOutcome> {
    /**
     * One read, not two: `isPrimary` and `get` fetch the SAME ROW, and this is
     * the first thing a voice join does, so a duplicate round trip here costs
     * real time on every room creation. `get` is fleet-scoped by the
     * repository, so the guild check `isPrimary` added on top is preserved
     * explicitly below rather than lost.
     */
    const primary = await this.deps.autoChannels.get(channelId);
    if (!primary || primary.guildId !== guildId) return { action: 'skip' };

    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    if (!settings.enabled) return { action: 'skip' };
    if (!isEntitled({ status: guild.authStatus, selfHosted: this.deps.selfHosted })) {
      this.deps.logger.debug({ guildId }, 'skipping creation: not entitled');
      return { action: 'skip' };
    }

    // Idempotency guard: only create if the member is *currently* in the primary.
    // On a replayed event they have already been moved into a secondary.
    const inPrimary = this.deps.voice.membersInChannel(channelId).some((m) => m.id === member.id);
    if (!inPrimary) {
      this.deps.logger.debug(
        { guildId, channelId, memberId: member.id },
        'skipping creation: member no longer in primary',
      );
      return { action: 'skip' };
    }

    if (opts.dryRun) return { action: 'would-create' };

    // Runtime control plane: a global pause or per-guild throttle may suppress
    // creation without a deploy. Checked only for real creates (dry-run still
    // reports the drift a pause is hiding).
    let gate: CreateGateDecision | undefined;
    if (this.deps.gate) {
      const decision = await this.deps.gate.allowCreate(guildId);
      gate = decision;
      if (!decision.allowed) {
        this.deps.logger.warn(
          { guildId, reason: decision.reason },
          'creation suppressed by runtime gate',
        );
        return { action: 'skip' };
      }
    }

    this.deps.logger.debug(
      { guildId, memberId: member.id, playing: member.playing },
      'creating secondary: creator presence',
    );

    // When the primary's category is grouped, number group-wide (across all the
    // category's primaries) and append at the bottom; otherwise number per-primary.
    const categoryKey = groupKeyFor(this.deps.voice.categoryOf?.(channelId));
    const group = readGroups(guild.settings)[categoryKey];
    // This primary's existing rooms, oldest first. Their count is the new room's
    // index, their ids place it at the bottom of the block, and their current
    // display order says whether the block needs repairing (see below). A grouped
    // category is positioned wholesale by `repositionGroup`, so it needs none of it.
    const siblings = group ? [] : await this.deps.secondaries.listIdsByPrimary(channelId);
    const above = primary?.template.above === true;
    // Checked BEFORE the create, so it describes the block we inherited rather
    // than one this create has just added to.
    const misordered =
      !group && !gate?.orderRepairDisabled && this.blockMisordered(channelId, siblings, above);
    const index = group
      ? (await this.groupMembers(guildId, categoryKey)).secondaries.length
      : siblings.length;
    const template = primary?.template.name ?? settings.channelNameTemplate;
    // Generate the per-channel random seed once, here, so `[[random]]` picks are
    // fixed for this channel's lifetime and never trigger a later rename.
    const seed = randomSeed();
    const name = renderChannelName(template, {
      index,
      members: [member],
      aliases: settings.aliases,
      general: settings.general,
      creatorName: displayName(settings, member),
      creator: member,
      seed,
      userLimit: primary?.template.limit ?? 0,
    });

    let newChannelId: string;
    try {
      newChannelId = await this.deps.actions.createVoiceChannel({
        guildId,
        name,
        userLimit: primary?.template.limit ?? 0,
        // Place the secondary in the primary's category, above/below per config.
        nearChannelId: channelId,
        // Default is below the primary; only `above: true` positions above it.
        above,
        // Below the primary means below its existing rooms too, not between them.
        afterChannelIds: siblings,
        // Inherit permissions from the primary by default (matching the legacy bot);
        // `/inheritpermissions` can switch the source to the category or a specific
        // channel. Unset must NOT fall through to Discord's category-sync.
        inheritFrom: primary?.template.inheritperms ?? 'primary',
      });
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      // Can't create the channel (missing perms — usually Manage Roles to copy the
      // creator channel's permissions). Tell the admin instead of failing silently.
      this.deps.permissionProblems?.record(guildId, {
        channelId,
        operation: 'create',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId, 'create'));
      this.deps.logger.warn({ guildId, primaryId: channelId, err }, 'cannot create secondary');
      return { action: 'skip' };
    }

    await this.deps.secondaries.create({
      channelId: newChannelId,
      guildId,
      primaryChannelId: channelId,
      ownerId: member.id,
      // Seed the arrival roster with the creator (longest-present from birth).
      state: { name, index, seed, roster: [member.id] },
    });
    this.deps.countRoom?.('created');

    // Default-private primaries: lock the new channel before the creator lands in
    // it (granting Connect to them by id, since their move isn't cached yet).
    if (primary?.template.defaultPrivate) {
      try {
        await this.deps.makePrivateOnCreate?.(
          guildId,
          newChannelId,
          member.id,
          displayName(settings, member),
        );
      } catch (err) {
        if (!isPermissionError(err)) throw err;
        // Same recovery as a failed move: a channel we can't finish locking
        // down is worse than no channel, since nobody (not even the owner) can
        // get into it. Stop tracking it, best-effort delete, and notify.
        await this.deps.secondaries.remove(newChannelId);
        await this.deps.onSecondaryRemoved?.(guildId, newChannelId);
        await this.deps.actions.deleteChannel(guildId, newChannelId).catch(() => undefined);
        this.deps.permissionProblems?.record(guildId, {
          channelId,
          operation: 'privacy',
          at: Date.now(),
        });
        this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId, 'privacy'));
        this.deps.logger.warn(
          { guildId, primaryId: channelId, secondaryId: newChannelId, err },
          'created secondary but cannot make it private',
        );
        return { action: 'skip' };
      }
    }

    try {
      await this.deps.actions.moveMember(guildId, member.id, newChannelId);
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      // Created the channel but can't move the member into it (we've lost access to
      // it). Stop tracking it, best-effort delete (likely also blocked → left for
      // manual cleanup), and notify.
      await this.deps.secondaries.remove(newChannelId);
      await this.deps.onSecondaryRemoved?.(guildId, newChannelId);
      await this.deps.actions.deleteChannel(guildId, newChannelId).catch(() => undefined);
      /**
       * Recorded against the PRIMARY, not the secondary we just deleted: the
       * secondary is gone by this line in the common case, so a `<#id>`
       * mention naming it would be a dead link. The secondary id stays in the
       * log context, just not in the human-facing mention.
       */
      this.deps.permissionProblems?.record(guildId, {
        channelId,
        operation: 'move',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId, 'move'));
      this.deps.logger.warn(
        { guildId, primaryId: channelId, secondaryId: newChannelId, err },
        'created secondary but cannot move member into it',
      );
      return { action: 'skip' };
    }

    /**
     * Cleared after the MOVE succeeds, not the create, even though both
     * failures record against this same primary. Clearing on a bare create
     * would mean a guild missing only Move Members clears and re-records the
     * incident on every join, which resets the notifier's escalating backoff
     * and turns four total notices into one per join.
     */
    this.deps.permissionProblems?.clear(guildId, channelId);

    // Grouped category: slot the new channel into the group block (at the bottom,
    // since it's the newest) with one bulk reorder. Positions aren't rate-limited,
    // and existing siblings keep their numbers, so this adds no rename churn.
    if (group) {
      const { primaryIds, secondaries } = await this.groupMembers(guildId, categoryKey);
      await this.deps.actions.repositionGroup(
        guildId,
        primaryIds,
        await this.companionBlock(secondaries.map((s) => s.channelId)),
        group.above,
      );
    } else if (misordered) {
      // The block we inherited was already in the wrong order, which create-time
      // placement cannot undo on its own — it can only put THIS room in the right
      // slot. One bulk reorder puts the whole block back, and because it also
      // gives every room a unique position, the check above passes from now on:
      // this costs one call on the create that finds the damage, and none after.
      //
      // Contained on its own, because by this point the room exists and the
      // member is in it. `repositionSecondaries` reads the join companions from
      // Postgres, so a database blip there would otherwise reject a create that
      // has already succeeded: no `created` result, no `/logging` line, and a
      // task failure counted against this guild's circuit-breaker, all for a
      // cosmetic reorder.
      try {
        this.deps.logger.info(
          { guildId, primaryId: channelId, secondaryId: newChannelId },
          'repairing out-of-order secondaries',
        );
        await this.repositionSecondaries(guildId, channelId, above);
      } catch (err) {
        this.deps.logger.warn(
          { guildId, primaryId: channelId, err },
          'could not repair secondary order',
        );
      }
    }

    this.deps.logger.info(
      { guildId, primaryId: channelId, secondaryId: newChannelId, name, creator: member.id },
      'created secondary channel',
    );
    this.deps.serverLog?.(guildId, 1, `➕ <@${member.id}> created <#${newChannelId}>`);
    return { action: 'created', channelId: newChannelId };
  }

  /**
   * Cleanup-only entry point, for a guild that is hard-gated.
   *
   * Gated guilds have their voice events dropped before the dispatcher, but a
   * temp channel that empties still has to go: leaving them behind litters the
   * server with dead empty channels an admin then has to delete by hand, which
   * is a worse outcome than tidying up. Deliberately narrow, so nothing else
   * about a gated guild is processed.
   */
  async cleanupEmptySecondary(guildId: string, channelId: string): Promise<void> {
    await this.maybeCleanup(guildId, channelId);
  }

  /**
   * Deletes a tracked secondary that has emptied. Returns `deleted` when removed,
   * `would-delete` under dry-run, else `skip` (not a secondary, or still has
   * members).
   */
  private async maybeCleanup(
    guildId: string,
    channelId: string,
    opts: ReconcileOptions = {},
  ): Promise<CleanupOutcome> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) return { action: 'skip' };

    const remaining = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    if (remaining.length > 0) return { action: 'skip' };

    if (opts.dryRun) return { action: 'would-delete' };

    try {
      await this.deps.actions.deleteChannel(guildId, channelId);
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      // We've lost access to a channel we manage (a permission override hid it from
      // us): stop tracking it so we don't retry the impossible delete on every
      // reconcile, and tell the admin how to restore access.
      await this.deps.secondaries.remove(channelId);
      await this.deps.onSecondaryRemoved?.(guildId, channelId);
      this.deps.permissionProblems?.record(guildId, {
        channelId,
        operation: 'delete',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId));
      this.deps.logger.warn(
        { guildId, secondaryId: channelId, err },
        'lost access to managed channel; stopped managing it',
      );
      return { action: 'skip' };
    }
    await this.deps.secondaries.remove(channelId);
    await this.deps.onSecondaryRemoved?.(guildId, channelId);

    this.deps.countRoom?.('deleted');
    this.deps.logger.info({ guildId, secondaryId: channelId }, 'deleted empty secondary channel');
    this.deps.serverLog?.(
      guildId,
      1,
      `🗑 Deleted **${secondary.state.name ?? channelId}** (\`${channelId}\`)`,
    );
    // A successful op means access is back — clear any stale incident.
    this.deps.permissionProblems?.clear(guildId, channelId);
    return { action: 'deleted' };
  }

  /**
   * Handles a member leaving a secondary that still has members: prunes them from
   * the arrival roster, and — if they owned the channel — hands ownership to the
   * longest-present remaining member. Keeps `@@creator@@` resolvable after the
   * creator leaves and re-points a private channel's "⇩ Join" companion at the
   * new owner. The new owner is only a caretaker: `setOwner` preserves the
   * `originalCreator`, so the original creator can `/reclaim` the channel back on
   * return. Idempotent: a replayed leave sees the roster already pruned and
   * ownership already moved, so it writes nothing.
   */
  private async handleSecondaryLeave(
    guildId: string,
    channelId: string,
    leaverId: string,
  ): Promise<void> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) return;

    // Recompute the roster against who's actually present: keep tracked arrival
    // order for those still here (this drops the leaver and anyone else gone),
    // then append present-but-untracked members in cache order (self-heal after a
    // restart/gap). `ordered[0]` is therefore the longest-present member.
    const members = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    const present = new Set(members.map((m) => m.id));
    const ordered = (secondary.state.roster ?? []).filter((id) => present.has(id));
    for (const m of members) if (!ordered.includes(m.id)) ordered.push(m.id);

    if (!sameOrder(ordered, secondary.state.roster)) {
      await this.deps.secondaries.updateState(channelId, { ...secondary.state, roster: ordered });
    }

    // Ownership only moves when the owner is the one who left and someone remains.
    if (secondary.ownerId !== leaverId) return;
    const newOwner = members.find((m) => m.id === ordered[0]);
    if (!newOwner) return; // emptied — cleanup handles deletion

    await this.deps.secondaries.setOwner(channelId, newOwner.id);
    const guild = await this.deps.guilds.ensure(guildId);
    const newOwnerName = displayName(parseVoiceSettings(guild.settings), newOwner);

    this.deps.logger.info(
      { guildId, secondaryId: channelId, from: leaverId, to: newOwner.id },
      'transferred ownership after owner left',
    );
    this.deps.serverLog?.(guildId, 2, `👑 <@${newOwner.id}> now owns <#${channelId}>`);
    // Re-point a private channel's "⇩ Join" companion (no-op if not private).
    await this.deps.onOwnerChanged?.(guildId, channelId, newOwner.id, newOwnerName);
  }

  /** Appends a member to a secondary's arrival roster (no-op if already tracked). */
  private async addToRoster(guildId: string, channelId: string, memberId: string): Promise<void> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) return;
    const roster = secondary.state.roster ?? [];
    if (roster.includes(memberId)) return; // replay-safe: no duplicate, no write
    await this.deps.secondaries.updateState(channelId, {
      ...secondary.state,
      roster: [...roster, memberId],
    });
  }

  /**
   * A member joined an adopted managed channel: append them to the arrival roster
   * and, if the channel had no current owner (it was empty), make the
   * longest-present member its owner — so `@@creator@@` resolves once occupied.
   * Idempotent: a replayed join writes nothing new.
   */
  private async handleManagedJoin(
    guildId: string,
    channelId: string,
    memberId: string,
  ): Promise<void> {
    const row = await this.deps.managed?.get(channelId);
    if (!this.deps.managed || !row || row.guildId !== guildId) return;

    const members = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    const present = new Set(members.map((m) => m.id));
    present.add(memberId); // the joiner, even if their state hasn't hit the cache yet
    const ordered = (row.state.roster ?? []).filter((id) => present.has(id));
    for (const m of members) if (!ordered.includes(m.id)) ordered.push(m.id);
    if (!ordered.includes(memberId)) ordered.push(memberId);

    if (!sameOrder(ordered, row.state.roster)) {
      await this.deps.managed.updateState(guildId, channelId, { ...row.state, roster: ordered });
    }
    // Owner only set when there isn't a present one (e.g. the channel was empty).
    const ownerPresent = row.ownerId !== null && present.has(row.ownerId);
    if (!ownerPresent && ordered[0])
      await this.deps.managed.setOwner(guildId, channelId, ordered[0]);
  }

  /**
   * A member left an adopted managed channel: prune the roster and, when the
   * owner left, hand ownership to the longest-present remaining member — or clear
   * it (null) when the channel is now empty, so the re-render shows the resting
   * "empty" name. Idempotent.
   */
  private async handleManagedLeave(
    guildId: string,
    channelId: string,
    leaverId: string,
  ): Promise<void> {
    const row = await this.deps.managed?.get(channelId);
    if (!this.deps.managed || !row || row.guildId !== guildId) return;

    const members = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    const present = new Set(members.map((m) => m.id));
    const ordered = (row.state.roster ?? []).filter((id) => present.has(id));
    for (const m of members) if (!ordered.includes(m.id)) ordered.push(m.id);

    if (!sameOrder(ordered, row.state.roster)) {
      await this.deps.managed.updateState(guildId, channelId, { ...row.state, roster: ordered });
    }

    // Reassign ownership only when the owner is the one who left.
    if (row.ownerId !== leaverId) return;
    const nextOwner = ordered[0] ?? null; // null → channel emptied
    await this.deps.managed.setOwner(guildId, channelId, nextOwner);
  }

  /**
   * Re-renders an adopted managed channel's name (and status) from its template +
   * current members. Unlike {@link rerenderSecondary} it does NOT bail when the
   * channel is empty — that's exactly when it must show its resting name — and it
   * never deletes the channel. Idempotent: a no-op when nothing changed.
   */
  async rerenderManaged(
    guildId: string,
    channelId: string,
    opts: ReconcileOptions = {},
  ): Promise<RerenderResult> {
    const row = await this.deps.managed?.get(channelId);
    if (!this.deps.managed || !row || row.guildId !== guildId) return {};
    if (row.template.name === undefined && row.template.status === undefined) return {};

    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    const members = this.deps.voice.membersInChannel(channelId);
    const owner = row.ownerId ? members.find((m) => m.id === row.ownerId) : undefined;
    const renderCtx = {
      index: 0,
      members,
      aliases: settings.aliases,
      general: settings.general,
      ...(row.state.seed !== undefined ? { seed: row.state.seed } : {}),
      ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
    };

    const renderedName =
      row.template.name !== undefined ? renderChannelName(row.template.name, renderCtx) : undefined;
    const renderedStatus =
      row.template.status !== undefined
        ? renderChannelName(row.template.status, renderCtx, {
            maxLength: MAX_STATUS_LENGTH,
            allowEmpty: true,
          })
        : undefined;

    const result: RerenderResult = {};
    if (renderedName !== undefined && renderedName !== row.state.name) result.name = renderedName;
    if (renderedStatus !== undefined && renderedStatus !== (row.state.status ?? '')) {
      result.status = renderedStatus;
    }
    if (result.name === undefined && result.status === undefined) return {};
    if (opts.dryRun) return result;

    if (result.name !== undefined) {
      let rename;
      try {
        rename = await this.deps.actions.renameChannel(guildId, channelId, result.name);
      } catch (err) {
        // Recoverable (grant the permission back), so an interactive caller keeps
        // the row — and the template the admin just wrote — and reports instead.
        if (!isPermissionError(err) || opts.onUnmanageable !== 'abandon') throw err;
        // Background caller: the channel still exists but an override hid it.
        // Stop managing it, or reconcile retries the impossible rename forever.
        await this.abandonManaged(guildId, channelId, 'rename', err);
        return {};
      }
      if (rename.channelGone) {
        // Confirmed deleted on Discord — objective and unrecoverable, so the row
        // goes whoever asked. Nothing to notify about on the background path: the
        // admin deleted it, which is not a problem to report back to them.
        await this.deps.managed.remove(guildId, channelId);
        this.deps.logger.info(
          { guildId, managedId: channelId },
          'managed channel no longer exists; stopped managing it',
        );
        if (opts.onUnmanageable !== 'abandon') {
          // Interactive: say so rather than report a success for a channel that
          // no longer exists (a narrow race — it was deleted mid-command).
          throw new Error('That channel no longer exists.');
        }
        return {};
      }
      if (rename.rateLimited) result.rateLimited = true;
      this.deps.serverLog?.(
        guildId,
        2,
        renameLogMessage(channelId, result.name, rename.rateLimited),
      );
    }
    if (result.status !== undefined) {
      await this.deps.actions.setVoiceStatus(guildId, channelId, result.status);
    }
    // Persist the freshly-rendered values (so change detection is stable next time).
    await this.deps.managed.updateState(guildId, channelId, {
      ...row.state,
      ...(renderedName !== undefined ? { name: renderedName } : {}),
      ...(renderedStatus !== undefined ? { status: renderedStatus } : {}),
    });

    this.deps.logger.info(
      { guildId, managedId: channelId, name: renderedName, status: renderedStatus },
      're-rendered managed channel',
    );
    return result;
  }

  /**
   * Gives up on an adopted channel the bot can no longer act on, and tells the
   * admin how to restore access (mirrors the secondary-side give-up in
   * {@link maybeCleanup}: the row has to go or every reconcile retries the
   * same impossible edit forever). Distinct from {@link stopManaging}, which
   * is the admin *choosing* to un-adopt a channel, a success, not a failure.
   */
  private async abandonManaged(
    guildId: string,
    channelId: string,
    operation: PermissionOperation,
    err: unknown,
  ): Promise<void> {
    await this.deps.managed?.remove(guildId, channelId);
    this.deps.permissionProblems?.record(guildId, { channelId, operation, at: Date.now() });
    this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId));
    this.deps.logger.warn(
      { guildId, managedId: channelId, err },
      'lost access to adopted channel; stopped managing it',
    );
  }

  /**
   * Drops tracking for a channel Discord reports as deleted. This is the
   * cheap, immediate path; the confirm-on-rename fallback in
   * {@link rerenderManaged} covers deletions that happen while the shard is
   * disconnected, where this event is never delivered.
   */
  async handleChannelDeleted(guildId: string, channelId: string): Promise<void> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (secondary && secondary.guildId === guildId) {
      await this.deps.secondaries.remove(channelId);
      await this.deps.onSecondaryRemoved?.(guildId, channelId);
      this.deps.permissionProblems?.clear(guildId, channelId);
      this.deps.logger.info(
        { guildId, secondaryId: channelId },
        'secondary deleted on Discord; stopped tracking it',
      );
      return;
    }

    const managed = await this.deps.managed?.get(channelId);
    if (managed && managed.guildId === guildId) {
      await this.deps.managed?.remove(guildId, channelId);
      this.deps.permissionProblems?.clear(guildId, channelId);
      this.deps.logger.info(
        { guildId, managedId: channelId },
        'managed channel deleted on Discord; stopped managing it',
      );
      return;
    }

    /**
     * Creator channels. This branch did not exist, and neither did any other
     * caller of `AutoChannelRepository.remove`, so an `auto_channels` row
     * outlived its Discord channel forever: `/setup` listed a creator channel
     * that was gone, and nothing an admin could do removed it.
     *
     * Last of the three because it is the rarest event. A secondary is deleted
     * every time a room empties; a creator channel is deleted once, by an admin.
     */
    const primary = await this.deps.autoChannels.get(channelId);
    if (primary && primary.guildId === guildId) {
      await this.deps.autoChannels.remove(guildId, channelId);
      this.deps.permissionProblems?.clear(guildId, channelId);
      this.deps.logger.info(
        { guildId, primaryChannelId: channelId },
        'creator channel deleted on Discord; stopped tracking it',
      );
    }
  }

  /**
   * Re-renders whichever kind of managed channel `channelId` is — an adopted
   * standalone channel or a spawned secondary. The gateway's debounced re-render
   * scheduler routes through this so both kinds pick up join/leave/presence
   * changes; a no-op when the channel is neither.
   */
  async rerenderChannelName(
    guildId: string,
    channelId: string,
    opts: RerenderOptions = {},
  ): Promise<RerenderResult> {
    if (await this.isManaged(guildId, channelId)) {
      return this.rerenderManaged(guildId, channelId, opts);
    }
    return this.rerenderSecondary(guildId, channelId, opts);
  }

  /**
   * The default name template applied when adopting a channel: its current name
   * while empty, and "{owner}'s room" once occupied. The original name is
   * sanitized so it can't break the `__empty/occupied__` token (no `/` to split
   * early, no `__` to close it early).
   */
  private adoptDefaultTemplate(originalName: string): string {
    const safe = originalName.replace(/\//g, '∕').replace(/_{2,}/g, '_').trim() || 'Voice';
    return `__${safe}/@@creator@@'s room__`;
  }

  /**
   * Adopts an otherwise-unmanaged voice channel so the bot manages its name. Seeds
   * the roster/owner from who's currently in it (so `@@creator@@` resolves right
   * away) and renders the default `__empty/occupied__` template once. Refuses a
   * primary, secondary, or already-adopted channel.
   */
  async adoptChannel(
    guildId: string,
    channelId: string,
    originalName: string,
  ): Promise<CommandResult> {
    if (!this.deps.managed) return { ok: false, message: "Managed channels aren't available." };
    if (await this.deps.managed.isManaged(guildId, channelId)) {
      return { ok: false, message: 'AVC already manages this channel.' };
    }
    if (await this.deps.autoChannels.isPrimary(guildId, channelId)) {
      return {
        ok: false,
        message: "That's a creator channel, edit it with `/template` directly.",
      };
    }
    if (await this.deps.secondaries.isSecondary(guildId, channelId)) {
      return { ok: false, message: "That's already a bot-created channel." };
    }
    const roster = this.deps.voice
      .membersInChannel(channelId)
      .filter((m) => !m.bot)
      .map((m) => m.id);
    await this.deps.managed.create({
      channelId,
      guildId,
      ownerId: roster[0] ?? null,
      template: { name: this.adoptDefaultTemplate(originalName) },
      state: { seed: randomSeed(), roster },
    });
    await this.rerenderManaged(guildId, channelId);
    this.deps.logger.info({ guildId, channelId }, 'adopted channel for name management');
    return { ok: true, message: "AVC now manages this channel's name." };
  }

  /** Sets an adopted channel's name template and re-renders it. Name can't be blank. */
  async setManagedName(guildId: string, channelId: string, value: string): Promise<CommandResult> {
    if (!this.deps.managed) return { ok: false, message: "Managed channels aren't available." };
    const row = await this.deps.managed.get(channelId);
    if (!row || row.guildId !== guildId) {
      return { ok: false, message: "AVC doesn't manage this channel." };
    }
    const trimmed = value.trim().replace(/[\r\n]+/g, ' ');
    if (trimmed === '') return { ok: false, message: "The name template can't be empty." };
    await this.deps.managed.setTemplate(guildId, channelId, { ...row.template, name: trimmed });
    await this.rerenderManaged(guildId, channelId);
    return { ok: true, message: "Updated this channel's name template." };
  }

  /**
   * Sets an adopted channel's status template and re-renders it. A blank value (or
   * `reset`) clears the status — adopted channels default to no status.
   */
  async setManagedStatus(
    guildId: string,
    channelId: string,
    value: string,
  ): Promise<CommandResult> {
    if (!this.deps.managed) return { ok: false, message: "Managed channels aren't available." };
    const row = await this.deps.managed.get(channelId);
    if (!row || row.guildId !== guildId) {
      return { ok: false, message: "AVC doesn't manage this channel." };
    }
    const trimmed = value.trim();
    const cleared = trimmed === '' || trimmed.toLowerCase() === 'reset';
    await this.deps.managed.setTemplate(guildId, channelId, {
      ...row.template,
      status: cleared ? '' : trimmed,
    });
    await this.rerenderManaged(guildId, channelId);
    return {
      ok: true,
      message: cleared
        ? "Cleared this channel's status, it will stay blank."
        : "Updated this channel's status template.",
    };
  }

  /** Stops managing an adopted channel (its current name stays as-is). */
  async stopManaging(guildId: string, channelId: string): Promise<CommandResult> {
    if (!this.deps.managed) return { ok: false, message: "Managed channels aren't available." };
    const row = await this.deps.managed.get(channelId);
    if (!row || row.guildId !== guildId) {
      return { ok: false, message: "AVC doesn't manage this channel." };
    }
    await this.deps.managed.remove(guildId, channelId);
    this.deps.logger.info({ guildId, channelId }, 'stopped managing channel');
    return {
      ok: true,
      message: "Stopped managing this channel's name, its current name stays as-is.",
    };
  }

  /**
   * Resolves the `/template` editor state for an adopted standalone channel: its
   * current name + status templates and a live preview against current members.
   */
  async getManagedEditorState(guildId: string, channelId: string): Promise<EditorState> {
    const empty: EditorFieldState = { effectiveTemplate: '', preview: '' };
    const row = await this.deps.managed?.get(channelId);
    if (!this.deps.managed || !row || row.guildId !== guildId) {
      return { found: false, scope: 'adopted', name: empty, status: empty };
    }
    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    const members = this.deps.voice.membersInChannel(channelId);
    const owner = row.ownerId ? members.find((m) => m.id === row.ownerId) : undefined;
    const renderCtx = {
      index: 0,
      members,
      aliases: settings.aliases,
      general: settings.general,
      ...(row.state.seed !== undefined ? { seed: row.state.seed } : {}),
      ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
    };
    const nameTpl = row.template.name ?? '';
    const statusTpl = row.template.status ?? '';
    return {
      found: true,
      scope: 'adopted',
      name: {
        ...(row.template.name !== undefined ? { currentTemplate: row.template.name } : {}),
        effectiveTemplate: nameTpl,
        preview: nameTpl ? renderChannelName(nameTpl, renderCtx) : '',
      },
      status: {
        ...(row.template.status !== undefined ? { currentTemplate: row.template.status } : {}),
        effectiveTemplate: statusTpl,
        preview: statusTpl
          ? renderChannelName(statusTpl, renderCtx, {
              maxLength: MAX_STATUS_LENGTH,
              allowEmpty: true,
            })
          : '',
      },
      ownerId: row.ownerId,
    };
  }

  /**
   * Recomputes a secondary's name from its *current* members and renames it if
   * it changed. Used for dynamic re-rendering on join/leave and presence changes
   * (game switches). Idempotent: a no-op when the name is unchanged, the channel
   * is unknown, or it has emptied (cleanup handles deletion).
   *
   * Returns the new name when a rename was (or, under dry-run, would be) applied,
   * plus whether a rate limit deferred it; an empty object when nothing changed.
   */
  async rerenderSecondary(
    guildId: string,
    channelId: string,
    opts: RerenderOptions = {},
  ): Promise<RerenderResult> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) return {};

    const members = this.deps.voice.membersInChannel(channelId);
    if (members.filter((m) => !m.bot).length === 0) return {};

    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
    const owner = secondary.ownerId ? members.find((m) => m.id === secondary.ownerId) : undefined;
    // Reconciliation may pass a freshly-computed sibling position to renumber
    // `##` tokens after a middle channel was deleted; otherwise use the stored one.
    const index = opts.index ?? secondary.state.index ?? 0;
    const renderCtx = {
      index,
      members,
      aliases: settings.aliases,
      general: settings.general,
      ...(secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
      ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
    };

    // Name: per-channel `/name` override → primary template → server default.
    const nameTemplate =
      secondary.state.template ?? primary?.template.name ?? settings.channelNameTemplate;
    const name = renderChannelName(nameTemplate, renderCtx);
    // Status: per-channel override → primary status template → server default.
    // It allows an empty result (which clears the channel status).
    const statusTemplate =
      secondary.state.statusTemplate ?? primary?.template.status ?? settings.channelStatusTemplate;
    const status = renderChannelName(statusTemplate, renderCtx, {
      maxLength: MAX_STATUS_LENGTH,
      allowEmpty: true,
    });

    const nameChanged = name !== secondary.state.name;
    const statusChanged = status !== (secondary.state.status ?? '');

    this.deps.logger.debug(
      { guildId, secondaryId: channelId, name, status, nameChanged, statusChanged },
      'rerenderSecondary evaluated',
    );

    if (!nameChanged && !statusChanged) return {};
    if (opts.dryRun) {
      return { ...(nameChanged ? { name } : {}), ...(statusChanged ? { status } : {}) };
    }

    let rateLimited = false;
    if (nameChanged) {
      ({ rateLimited } = await this.deps.actions.renameChannel(guildId, channelId, name));
      this.deps.serverLog?.(guildId, 2, renameLogMessage(channelId, name, rateLimited));
    }
    if (statusChanged) {
      await this.deps.actions.setVoiceStatus(guildId, channelId, status);
    }
    // Persist both even if only one changed (and even if a rename was deferred —
    // the queued rename will still apply).
    await this.deps.secondaries.updateState(channelId, {
      ...secondary.state,
      name,
      status,
      index,
    });

    this.deps.logger.info(
      { guildId, secondaryId: channelId, name, status, rateLimited },
      're-rendered secondary channel',
    );
    return {
      ...(nameChanged ? { name } : {}),
      ...(statusChanged ? { status } : {}),
      ...(rateLimited ? { rateLimited: true } : {}),
    };
  }

  /** Re-renders every secondary owned by a member (after `/nick`). */
  async rerenderByOwner(
    guildId: string,
    ownerId: string,
    opts: RerenderOptions = {},
  ): Promise<RerenderSummary> {
    const rows = await this.deps.secondaries.listByOwner(guildId, ownerId);
    return this.rerenderMany(
      guildId,
      rows.map((r) => r.channelId),
      opts,
    );
  }

  /**
   * Repositions every existing secondary of a primary to match a changed
   * above/below setting (after `/position`). Orders them by creation time so they
   * stack the same way new channels do. Returns how many were moved.
   */
  async repositionSecondaries(
    guildId: string,
    primaryChannelId: string,
    above: boolean,
  ): Promise<number> {
    const ordered = await this.deps.secondaries.listIdsByPrimary(primaryChannelId);
    if (ordered.length === 0) return 0;
    const channelBlock = await this.companionBlock(ordered);
    await this.deps.actions.repositionSecondaries(guildId, primaryChannelId, channelBlock, above);
    this.deps.logger.info(
      { guildId, primaryChannelId, above, count: ordered.length },
      'repositioned secondaries',
    );
    return ordered.length;
  }

  /**
   * Whether a primary's rooms have drifted out of the order Discord renders them
   * in: `creator` then oldest-to-newest, or the reverse of that for `above`.
   *
   * This is the one case create-time placement cannot fix. Placing a new room at
   * the bottom of the block is enough for every room created from here on, but it
   * cannot move a room that is ALREADY in the wrong slot, so a block reordered
   * underneath us stays wrong until its rooms happen to turn over. The repair is
   * a bulk reorder, so it is worth spending only when the order is knowably
   * wrong: anything unknowable answers false, never "repair".
   *
   * **Only ever asks about rooms the repair could actually move**, which means
   * the primary's own category and nothing else. Positions in two categories are
   * separate number spaces, so comparing across them is meaningless, and
   * `repositionSecondaries` filters to the primary's parent anyway: a room an
   * admin dragged elsewhere would otherwise read as permanently misordered and
   * buy a bulk reorder on every single join, forever, without ever moving it.
   */
  private blockMisordered(
    primaryChannelId: string,
    orderedSecondaryIds: string[],
    above: boolean,
  ): boolean {
    if (orderedSecondaryIds.length === 0) return false;
    const parent = this.deps.voice.categoryOf?.(primaryChannelId);
    // `null` is the server root and is a real answer; `undefined` is "unknown",
    // and without it a moved room cannot be told from a misordered one.
    if (parent === undefined) return false;
    const here = orderedSecondaryIds.filter((id) => this.deps.voice.categoryOf?.(id) === parent);
    if (here.length === 0) return false;
    const displayed = this.deps.voice.displayOrderOf?.([primaryChannelId, ...here]);
    if (!displayed) return false;
    const visible = new Set(displayed);
    // Without the primary there is no anchor to be above or below.
    if (!visible.has(primaryChannelId)) return false;
    const rooms = here.filter((id) => visible.has(id));
    if (rooms.length === 0) return false;
    const expected = above ? [...rooms, primaryChannelId] : [primaryChannelId, ...rooms];
    return expected.join(',') !== displayed.join(',');
  }

  /**
   * Expands an ordered secondary list into the reorder block Discord receives: each
   * secondary preceded by its "⇩ Join" companion (if private) so the pair stays
   * adjacent — the companion always sits just above its channel.
   */
  private async companionBlock(orderedSecondaryIds: string[]): Promise<string[]> {
    const block: string[] = [];
    for (const id of orderedSecondaryIds) {
      const companion = await this.deps.joinCompanionFor?.(id);
      if (companion) block.push(companion);
      block.push(id);
    }
    return block;
  }

  /** The primary (creator) channel ids that resolve to `categoryKey` right now. */
  async categoryPrimaryIds(guildId: string, categoryKey: string): Promise<string[]> {
    const primaries = await this.deps.autoChannels.listByGuild(guildId);
    return primaries
      .filter((p) => groupKeyFor(this.deps.voice.categoryOf?.(p.channelId)) === categoryKey)
      .map((p) => p.channelId);
  }

  /**
   * The primaries and their secondaries (ordered by creation time) making up
   * one grouping category, resolved live so it reflects channels moved
   * between categories since.
   */
  private async groupMembers(
    guildId: string,
    categoryKey: string,
  ): Promise<{ primaryIds: string[]; secondaries: SecondaryChannelRow[] }> {
    const primaryIds = await this.categoryPrimaryIds(guildId, categoryKey);
    const lists = await Promise.all(
      primaryIds.map((id) => this.deps.secondaries.listByPrimary(id)),
    );
    const secondaries = lists
      .flat()
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.channelId.localeCompare(b.channelId),
      );
    return { primaryIds, secondaries };
  }

  /**
   * Re-numbers and re-positions a whole category to match its current grouping
   * config: **grouped** → one group-wide block, numbered across all the category's
   * primaries; **ungrouped** → per-primary numbering, each primary's own block.
   * Used when grouping is toggled, when `/position` changes a grouped category, and
   * by reconcile. Idempotent.
   */
  async resyncCategory(guildId: string, categoryKey: string): Promise<RerenderSummary> {
    const guild = await this.deps.guilds.ensure(guildId);
    const config = readGroups(guild.settings)[categoryKey];
    const { primaryIds, secondaries } = await this.groupMembers(guildId, categoryKey);
    let renamed = 0;
    let rateLimited = 0;

    if (config) {
      // Group-wide: number by group order, then one bulk reorder of the block.
      for (let i = 0; i < secondaries.length; i++) {
        const r = await this.rerenderSecondary(guildId, secondaries[i]!.channelId, { index: i });
        if (r.name !== undefined) renamed += 1;
        if (r.rateLimited) rateLimited += 1;
      }
      if (secondaries.length > 0) {
        await this.deps.actions.repositionGroup(
          guildId,
          primaryIds,
          await this.companionBlock(secondaries.map((s) => s.channelId)),
          config.above,
        );
      }
      return { considered: secondaries.length, renamed, rateLimited };
    }

    // Ungrouped: renumber + reposition each primary's own block independently.
    let considered = 0;
    for (const primaryId of primaryIds) {
      const rows = (await this.deps.secondaries.listByPrimary(primaryId)).sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.channelId.localeCompare(b.channelId),
      );
      for (let i = 0; i < rows.length; i++) {
        const r = await this.rerenderSecondary(guildId, rows[i]!.channelId, { index: i });
        considered += 1;
        if (r.name !== undefined) renamed += 1;
        if (r.rateLimited) rateLimited += 1;
      }
      if (rows.length > 0) {
        const primary = await this.deps.autoChannels.get(primaryId);
        await this.deps.actions.repositionSecondaries(
          guildId,
          primaryId,
          await this.companionBlock(rows.map((r) => r.channelId)),
          primary?.template.above === true,
        );
      }
    }
    return { considered, renamed, rateLimited };
  }

  /** Re-renders all secondaries sharing a primary with `channelId` (after `/template`). */
  async rerenderSiblings(
    guildId: string,
    channelId: string,
    opts: RerenderOptions = {},
  ): Promise<RerenderSummary> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return { considered: 0, renamed: 0, rateLimited: 0 };
    }
    const rows = await this.deps.secondaries.listByPrimary(secondary.primaryChannelId);
    return this.rerenderMany(
      guildId,
      rows.map((r) => r.channelId),
      opts,
    );
  }

  private async rerenderMany(
    guildId: string,
    channelIds: string[],
    opts: RerenderOptions,
  ): Promise<RerenderSummary> {
    const results = await Promise.all(
      channelIds.map((id) => this.rerenderSecondary(guildId, id, opts)),
    );
    let renamed = 0;
    let rateLimited = 0;
    for (const r of results) {
      if (r.name !== undefined) renamed += 1;
      if (r.rateLimited) rateLimited += 1;
    }
    return { considered: channelIds.length, renamed, rateLimited };
  }

  /**
   * Gathers everything that influences a channel's name — its DB record, the
   * effective/primary/default templates, the live members + their presence, the
   * computed game, and the freshly-rendered name. Powers `/debug`.
   */
  async debugChannel(guildId: string, channelId: string): Promise<ChannelDebug> {
    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    const secondary = await this.deps.secondaries.get(channelId);
    const inGuild = secondary !== undefined && secondary.guildId === guildId;
    const isPrimary = await this.deps.autoChannels.isPrimary(guildId, channelId);
    const primary = inGuild
      ? await this.deps.autoChannels.get(secondary.primaryChannelId)
      : isPrimary
        ? await this.deps.autoChannels.get(channelId)
        : undefined;
    const members = this.deps.voice.membersInChannel(channelId);
    const effectiveTemplate =
      (inGuild ? secondary.state.template : undefined) ??
      primary?.template.name ??
      settings.channelNameTemplate;

    let renderedName: string | undefined;
    if (inGuild) {
      const owner = secondary.ownerId ? members.find((m) => m.id === secondary.ownerId) : undefined;
      renderedName = renderChannelName(effectiveTemplate, {
        index: secondary.state.index ?? 0,
        members,
        aliases: settings.aliases,
        general: settings.general,
        ...(secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
        ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
      });
    }

    return {
      channelId,
      isPrimary,
      isSecondary: inGuild,
      ...(inGuild
        ? {
            secondary: {
              ownerId: secondary.ownerId,
              primaryChannelId: secondary.primaryChannelId,
              state: secondary.state,
            },
          }
        : {}),
      effectiveTemplate,
      ...(primary?.template.name ? { primaryTemplate: primary.template.name } : {}),
      guildSettings: {
        enabled: settings.enabled,
        general: settings.general,
        defaultTemplate: settings.channelNameTemplate,
        aliasCount: Object.keys(settings.aliases).length,
      },
      members: members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        bot: m.bot,
        playing: m.playing,
        activities: m.activities ?? [],
        selfStreaming: m.selfStreaming ?? false,
      })),
      computedGame: getGameName(members, { aliases: settings.aliases, general: settings.general }),
      ...(renderedName !== undefined ? { renderedName } : {}),
      ...(inGuild && secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
    };
  }

  /**
   * Resolves the state behind a `/name` (per-channel override) or `/template`
   * (per-primary) editor panel: the currently-saved template, the effective one,
   * and a live preview rendered against the channel's current members.
   */
  async getEditorState(
    scope: EditorScope,
    guildId: string,
    channelId: string,
  ): Promise<EditorState> {
    // Adopted standalone channels live in their own repo, not as secondaries.
    if (scope === 'adopted') return this.getManagedEditorState(guildId, channelId);
    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    const empty: EditorFieldState = { effectiveTemplate: '', preview: '' };
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      /**
       * `/template` aimed at the CREATOR CHANNEL ITSELF, which has no secondary
       * row. The template being edited is that primary's, so resolve it
       * directly instead of reporting the channel unmanaged.
       *
       * Without this the caller falls through to the adopt prompt, whose button
       * then correctly refuses ("that's a creator channel, edit it with
       * `/template` directly") and the admin is in a loop between two correct
       * messages. Reported by a customer 2026-09-02.
       *
       * `/name` is deliberately NOT given the same fallback: it edits a
       * per-channel override that only a secondary has.
       */
      if (scope !== 'primary') return { found: false, scope, name: empty, status: empty };
      const own = await this.deps.autoChannels.get(channelId);
      if (!own || own.guildId !== guildId) {
        return { found: false, scope, name: empty, status: empty };
      }
      // Preview the FIRST room this creator spawns: empty, and index 0, which
      // the `##` family renders as 1. Rendering against whoever is sitting in
      // the creator right now would preview a channel that never exists.
      const previewCtx = {
        index: 0,
        members: [],
        aliases: settings.aliases,
        general: settings.general,
      };
      const ownName = own.template.name ?? settings.channelNameTemplate;
      const ownStatus = own.template.status ?? settings.channelStatusTemplate;
      return {
        found: true,
        scope,
        name: {
          ...(own.template.name !== undefined ? { currentTemplate: own.template.name } : {}),
          effectiveTemplate: ownName,
          preview: renderChannelName(ownName, previewCtx),
        },
        status: {
          ...(own.template.status !== undefined ? { currentTemplate: own.template.status } : {}),
          effectiveTemplate: ownStatus,
          preview: renderChannelName(ownStatus, previewCtx, {
            maxLength: MAX_STATUS_LENGTH,
            allowEmpty: true,
          }),
        },
        ownerId: null,
        primaryChannelId: channelId,
      };
    }
    const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
    const members = this.deps.voice.membersInChannel(channelId);
    const owner = secondary.ownerId ? members.find((m) => m.id === secondary.ownerId) : undefined;
    const renderCtx = {
      index: secondary.state.index ?? 0,
      members,
      aliases: settings.aliases,
      general: settings.general,
      ...(secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
      ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
    };

    // The current/effective template for a field depends on the editor's scope:
    // a `/name` panel edits the per-channel override; `/template` edits the primary.
    const nameCurrent = scope === 'channel' ? secondary.state.template : primary?.template.name;
    const nameEffective =
      scope === 'channel'
        ? (nameCurrent ?? primary?.template.name ?? settings.channelNameTemplate)
        : (nameCurrent ?? settings.channelNameTemplate);
    const statusCurrent =
      scope === 'channel' ? secondary.state.statusTemplate : primary?.template.status;
    const statusEffective =
      scope === 'channel'
        ? (statusCurrent ?? primary?.template.status ?? settings.channelStatusTemplate)
        : (statusCurrent ?? settings.channelStatusTemplate);

    return {
      found: true,
      scope,
      name: {
        ...(nameCurrent !== undefined ? { currentTemplate: nameCurrent } : {}),
        effectiveTemplate: nameEffective,
        preview: renderChannelName(nameEffective, renderCtx),
      },
      status: {
        ...(statusCurrent !== undefined ? { currentTemplate: statusCurrent } : {}),
        effectiveTemplate: statusEffective,
        preview: renderChannelName(statusEffective, renderCtx, {
          maxLength: MAX_STATUS_LENGTH,
          allowEmpty: true,
        }),
      },
      ownerId: secondary.ownerId,
      primaryChannelId: secondary.primaryChannelId,
    };
  }

  /**
   * Converges a single guild's Discord voice state with the DB — the heart of
   * reconcile-on-READY and the periodic safety-net sweep. Catches up on events
   * missed while the shard was disconnected:
   *
   * - a tracked secondary whose channel vanished from Discord → drop the stale
   *   record (no Discord action);
   * - a tracked secondary that has emptied → delete it (missed leave event);
   * - a surviving secondary whose name drifted → rename it;
   * - a member still sitting in a primary → spawn their secondary and move them
   *   (missed join event).
   *
   * Idempotent and convergent: re-running on an already-consistent guild is a
   * no-op. Under `dryRun`, reports the drift it *would* fix without acting.
   */
  async reconcileGuild(guildId: string, opts: ReconcileOptions = {}): Promise<GuildDrift> {
    const dryRun = opts.dryRun ?? false;
    const drift: GuildDrift = {
      guildId,
      dryRun,
      orphanedRecords: [],
      deletedEmpty: [],
      created: [],
      renamed: [],
    };

    /**
     * A guild Discord has not handed us is one we know nothing about, so there
     * is nothing to converge and everything to lose. Every branch below reads
     * the channel cache, which for such a guild is empty, so each one would
     * read every record it owns as vanished and delete it. See `guildAvailable`
     * for how routine that state is (it is the ordinary shape of a boot that
     * hit `waitGuildTimeout`, not an outage).
     *
     * Bails on a dry run too: reporting drift derived from an empty cache would
     * describe a guild's whole configuration as garbage.
     */
    if (!this.deps.voice.guildAvailable(guildId)) {
      this.deps.logger.debug({ guildId }, 'reconcile skipped: guild not available yet');
      return drift;
    }

    // First pass: drop vanished records, delete emptied channels, and collect the
    // survivors so we can renumber them by sibling order below.
    const survivors: SecondaryChannelRow[] = [];
    for (const secondary of await this.deps.secondaries.listByGuild(guildId)) {
      const { channelId } = secondary;
      if (!this.deps.voice.channelExists(channelId)) {
        // "Gone" is only trustworthy for a guild we actually hold a shard
        // for - see `ownsGuild`'s doc. Skip the row entirely rather than
        // falling through to the survivor path below, which also assumes
        // cache data we don't have for a guild we don't own.
        if (this.deps.ownsGuild && !this.deps.ownsGuild(guildId)) continue;
        if (!dryRun) {
          await this.deps.secondaries.remove(channelId);
          await this.deps.onSecondaryRemoved?.(guildId, channelId);
        }
        drift.orphanedRecords.push(channelId);
        continue;
      }
      const nonBot = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
      if (nonBot.length === 0) {
        const { action } = await this.maybeCleanup(guildId, channelId, { dryRun });
        if (action === 'deleted' || action === 'would-delete') drift.deletedEmpty.push(channelId);
        continue;
      }
      survivors.push(secondary);
    }

    // Second pass: renumber survivors so `##` compacts after a deletion and a
    // number is never duplicated within its scope. A **grouped** category numbers
    // across ALL its primaries as one block; ungrouped primaries number
    // independently (the legacy per-primary `check_rename`).
    const groups = readGroups((await this.deps.guilds.ensure(guildId)).settings);
    const byCreated = (a: SecondaryChannelRow, b: SecondaryChannelRow): number =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.channelId.localeCompare(b.channelId);
    const groupedByCategory = new Map<string, SecondaryChannelRow[]>();
    const ungroupedByPrimary = new Map<string, SecondaryChannelRow[]>();
    for (const s of survivors) {
      const categoryKey = groupKeyFor(this.deps.voice.categoryOf?.(s.primaryChannelId));
      const grouped = groups[categoryKey] !== undefined;
      const target = grouped ? groupedByCategory : ungroupedByPrimary;
      const key = grouped ? categoryKey : s.primaryChannelId;
      const bucket = target.get(key) ?? [];
      bucket.push(s);
      target.set(key, bucket);
    }
    for (const rows of ungroupedByPrimary.values()) {
      rows.sort(byCreated);
      for (let i = 0; i < rows.length; i++) {
        const { name } = await this.rerenderSecondary(guildId, rows[i]!.channelId, {
          dryRun,
          index: i,
        });
        if (name !== undefined) drift.renamed.push({ channelId: rows[i]!.channelId, to: name });
      }
    }
    for (const [categoryKey, rows] of groupedByCategory) {
      rows.sort(byCreated);
      for (let i = 0; i < rows.length; i++) {
        const { name } = await this.rerenderSecondary(guildId, rows[i]!.channelId, {
          dryRun,
          index: i,
        });
        if (name !== undefined) drift.renamed.push({ channelId: rows[i]!.channelId, to: name });
      }
      // Converge the block's position too (one bulk reorder; not rate-limited).
      if (!dryRun && rows.length > 0) {
        const primaryIds = (await this.deps.autoChannels.listByGuild(guildId))
          .filter((p) => groupKeyFor(this.deps.voice.categoryOf?.(p.channelId)) === categoryKey)
          .map((p) => p.channelId);
        await this.deps.actions.repositionGroup(
          guildId,
          primaryIds,
          await this.companionBlock(rows.map((r) => r.channelId)),
          groups[categoryKey]?.above === true,
        );
      }
    }

    /**
     * Catch-up: members who joined a primary while we were disconnected are
     * still sitting in it; each needs their own secondary.
     *
     * **A primary whose channel is absent from the cache is deliberately left
     * alone, not pruned** (owner, 2026-08-27). Absence is not evidence: the
     * sweep draws its guild list from Postgres, so it reaches guilds whose
     * `GUILD_CREATE` has not landed, whose channel cache is empty, and every
     * one of whose primaries therefore reads as vanished. `ownsGuild` does not
     * rule that out, because a shard lease is held right through a resume. The
     * standing rule for a persistent record is the one `rerenderManaged` states
     * above: delete on a signal that is objective and unrecoverable (a
     * `channelDelete` dispatch, or Unknown Channel from the API), never on an
     * inference. A stale row costs a few bytes; a wrongly-deleted one is a dead
     * creator channel until an admin runs `/create` again. `handleChannelDeleted`
     * is the confident path.
     */
    for (const primary of await this.deps.autoChannels.listByGuild(guildId)) {
      const members = this.deps.voice.membersInChannel(primary.channelId).filter((m) => !m.bot);
      for (const member of members) {
        const outcome = await this.maybeCreate(guildId, primary.channelId, member, { dryRun });
        if (outcome.action === 'created' || outcome.action === 'would-create') {
          drift.created.push({
            primaryChannelId: primary.channelId,
            memberId: member.id,
            ...(outcome.action === 'created' ? { secondaryId: outcome.channelId } : {}),
          });
        }
      }
    }

    // Adopted standalone channels: drop records whose Discord channel vanished;
    // otherwise converge ownership/roster from who's present and re-render. These
    // are never deleted — an empty adopted channel just shows its resting name.
    if (this.deps.managed) {
      for (const managed of await this.deps.managed.listByGuild(guildId)) {
        const { channelId } = managed;
        if (!this.deps.voice.channelExists(channelId)) {
          if (this.deps.ownsGuild && !this.deps.ownsGuild(guildId)) continue;
          if (!dryRun) await this.deps.managed.remove(guildId, channelId);
          drift.orphanedRecords.push(channelId);
          continue;
        }
        if (!dryRun) await this.reconcileManagedOwner(guildId, managed);
        const { name } = await this.rerenderManaged(guildId, channelId, {
          dryRun,
          onUnmanageable: 'abandon',
        });
        if (name !== undefined) drift.renamed.push({ channelId, to: name });
      }
    }

    if (drift.orphanedRecords.length || drift.deletedEmpty.length || drift.created.length) {
      this.deps.logger.info(
        {
          guildId,
          dryRun,
          orphaned: drift.orphanedRecords.length,
          deleted: drift.deletedEmpty.length,
          created: drift.created.length,
          renamed: drift.renamed.length,
        },
        dryRun ? 'reconcile drift detected (dry-run)' : 'reconciled guild',
      );
    }
    return drift;
  }

  /** Recomputes an adopted channel's roster + owner from who's currently present. */
  private async reconcileManagedOwner(guildId: string, row: ManagedChannelRow): Promise<void> {
    if (!this.deps.managed || row.guildId !== guildId) return;
    const members = this.deps.voice.membersInChannel(row.channelId).filter((m) => !m.bot);
    const present = new Set(members.map((m) => m.id));
    const ordered = (row.state.roster ?? []).filter((id) => present.has(id));
    for (const m of members) if (!ordered.includes(m.id)) ordered.push(m.id);
    if (!sameOrder(ordered, row.state.roster)) {
      await this.deps.managed.updateState(guildId, row.channelId, {
        ...row.state,
        roster: ordered,
      });
    }
    const ownerPresent = row.ownerId !== null && present.has(row.ownerId);
    const nextOwner = ownerPresent ? row.ownerId : (ordered[0] ?? null);
    if (nextOwner !== row.ownerId)
      await this.deps.managed.setOwner(guildId, row.channelId, nextOwner);
  }
}
