import type {
  AutoChannelRepository,
  GuildSettingsReader,
  Logger,
  SecondaryChannelRepository,
  SecondaryChannelRow,
} from '@avc/core';
import { isEntitled } from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { GuildVoiceView, MemberActivity, VoiceMember, VoiceStateEvent } from './types.js';
import { getGameName, MAX_STATUS_LENGTH, renderChannelName } from './nameTemplate.js';
import { displayName, parseVoiceSettings } from './guildSettings.js';

/** A fresh 31-bit random seed for a channel's `[[random]]` picks. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** Whether two id lists are element-wise equal (to skip no-op roster writes). */
function sameOrder(a: readonly string[], b: readonly string[] | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/** Decision returned by a {@link CreationGate}. */
export interface CreateGateDecision {
  allowed: boolean;
  /** Human-readable reason when not allowed (for logs/diagnostics). */
  reason?: string;
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
}

/** Common option for state-changing operations: report without acting. */
export interface ReconcileOptions {
  dryRun?: boolean;
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
export type EditorScope = 'channel' | 'primary';
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
  /** Tracked secondaries whose Discord channel had vanished (record dropped). */
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
      }
    }

    return touched;
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
    if (!(await this.deps.autoChannels.isPrimary(guildId, channelId))) return { action: 'skip' };

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
    if (this.deps.gate) {
      const decision = await this.deps.gate.allowCreate(guildId);
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

    const primary = await this.deps.autoChannels.get(channelId);
    const index = await this.deps.secondaries.countByPrimary(channelId);
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

    const newChannelId = await this.deps.actions.createVoiceChannel({
      guildId,
      name,
      userLimit: primary?.template.limit ?? 0,
      // Place the secondary in the primary's category, above/below per config.
      nearChannelId: channelId,
      // Default is below the primary; only `above: true` positions above it.
      above: primary?.template.above === true,
      ...(primary?.template.inheritperms ? { inheritFrom: primary.template.inheritperms } : {}),
    });

    await this.deps.secondaries.create({
      channelId: newChannelId,
      guildId,
      primaryChannelId: channelId,
      ownerId: member.id,
      // Seed the arrival roster with the creator (longest-present from birth).
      state: { name, index, seed, roster: [member.id] },
    });

    // Default-private primaries: lock the new channel before the creator lands in
    // it (granting Connect to them by id, since their move isn't cached yet).
    if (primary?.template.defaultPrivate) {
      await this.deps.makePrivateOnCreate?.(
        guildId,
        newChannelId,
        member.id,
        displayName(settings, member),
      );
    }

    await this.deps.actions.moveMember(guildId, member.id, newChannelId);

    this.deps.logger.info(
      { guildId, primaryId: channelId, secondaryId: newChannelId, name, creator: member.id },
      'created secondary channel',
    );
    this.deps.serverLog?.(guildId, 1, `➕ <@${member.id}> created <#${newChannelId}>`);
    return { action: 'created', channelId: newChannelId };
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

    await this.deps.actions.deleteChannel(guildId, channelId);
    await this.deps.secondaries.remove(channelId);
    await this.deps.onSecondaryRemoved?.(guildId, channelId);

    this.deps.logger.info({ guildId, secondaryId: channelId }, 'deleted empty secondary channel');
    this.deps.serverLog?.(
      guildId,
      1,
      `🗑 Deleted **${secondary.state.name ?? channelId}** (\`${channelId}\`)`,
    );
    return { action: 'deleted' };
  }

  /**
   * Handles a member leaving a secondary that still has members: prunes them from
   * the arrival roster, and — if they owned the channel — hands ownership to the
   * longest-present remaining member. Keeps `@@creator@@` resolvable after the
   * creator leaves and re-points a private channel's "⇩ Join" companion at the
   * new owner. Idempotent: a replayed leave sees the roster already pruned and
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
      this.deps.serverLog?.(guildId, 2, `✏️ <#${channelId}> renamed to **${name}**`);
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
    const rows = await this.deps.secondaries.listByPrimary(primaryChannelId);
    if (rows.length === 0) return 0;
    const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // Build the move list: each secondary preceded by its "⇩ Join" companion (if
    // private) so the pair stays adjacent — the companion always sits just above.
    const channelBlock: string[] = [];
    for (const row of ordered) {
      const companion = await this.deps.joinCompanionFor?.(row.channelId);
      if (companion) channelBlock.push(companion);
      channelBlock.push(row.channelId);
    }
    await this.deps.actions.repositionSecondaries(guildId, primaryChannelId, channelBlock, above);
    this.deps.logger.info(
      { guildId, primaryChannelId, above, count: ordered.length },
      'repositioned secondaries',
    );
    return ordered.length;
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
    const guild = await this.deps.guilds.ensure(guildId);
    const settings = parseVoiceSettings(guild.settings);
    const empty: EditorFieldState = { effectiveTemplate: '', preview: '' };
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return { found: false, scope, name: empty, status: empty };
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

    // First pass: drop vanished records, delete emptied channels, and collect the
    // survivors so we can renumber them by sibling order below.
    const survivors: SecondaryChannelRow[] = [];
    for (const secondary of await this.deps.secondaries.listByGuild(guildId)) {
      const { channelId } = secondary;
      if (!this.deps.voice.channelExists(channelId)) {
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

    // Second pass: renumber surviving secondaries by creation order within each
    // primary, so `##` compacts after a middle channel was deleted (and a number
    // can never be duplicated). This mirrors the legacy periodic `check_rename`.
    const byPrimary = new Map<string, SecondaryChannelRow[]>();
    for (const s of survivors) {
      const group = byPrimary.get(s.primaryChannelId) ?? [];
      group.push(s);
      byPrimary.set(s.primaryChannelId, group);
    }
    for (const group of byPrimary.values()) {
      group.sort(
        (a: SecondaryChannelRow, b: SecondaryChannelRow) =>
          a.createdAt.getTime() - b.createdAt.getTime() || a.channelId.localeCompare(b.channelId),
      );
      for (let i = 0; i < group.length; i++) {
        const { name } = await this.rerenderSecondary(guildId, group[i]!.channelId, {
          dryRun,
          index: i,
        });
        if (name !== undefined) drift.renamed.push({ channelId: group[i]!.channelId, to: name });
      }
    }

    // Catch-up: members who joined a primary while we were disconnected are still
    // sitting in it; each needs their own secondary.
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
}
