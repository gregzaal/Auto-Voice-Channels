import type {
  AutoChannelRepository,
  GuildRepository,
  Logger,
  SecondaryChannelRepository,
  SecondaryChannelRow,
} from '@avc/core';
import { isEntitled } from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { GuildVoiceView, MemberActivity, VoiceMember, VoiceStateEvent } from './types.js';
import { DEFAULT_CHANNEL_NAME_TEMPLATE, getGameName, renderChannelName } from './nameTemplate.js';

/** Guild settings relevant to the voice feature (read from `guilds.settings`). */
interface VoiceSettings {
  enabled: boolean;
  channelNameTemplate: string;
  aliases: Record<string, string>;
  general: string;
  /** Per-user custom display names for `@@creator@@` (set via `/nick`). */
  customNicks: Record<string, string>;
}

function asStringMap(value: unknown): Record<string, string> {
  return typeof value === 'object' && value !== null ? (value as Record<string, string>) : {};
}

function parseSettings(settings: Record<string, unknown>): VoiceSettings {
  return {
    enabled: settings.enabled !== false,
    channelNameTemplate:
      typeof settings.channel_name_template === 'string'
        ? settings.channel_name_template
        : DEFAULT_CHANNEL_NAME_TEMPLATE,
    aliases: asStringMap(settings.aliases),
    general: typeof settings.general === 'string' ? settings.general : 'General',
    customNicks: asStringMap(settings.custom_nicks),
  };
}

/** The display name to use for a member, honouring their `/nick` override. */
function displayName(settings: VoiceSettings, member: VoiceMember): string {
  return settings.customNicks[member.id] ?? member.displayName;
}

/** A fresh 31-bit random seed for a channel's `[[random]]` picks. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
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
  guilds: GuildRepository;
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
   * Optional sink for per-guild event logging (`/logging`). Level 1 = lifecycle
   * (create/delete), 2 = config changes, 3 = joins/leaves. Fire-and-forget.
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
        touched.push(beforeChannelId);
      }
    }

    if (afterChannelId !== undefined) {
      await this.maybeCreate(guildId, afterChannelId, event.member);
      // Joining an existing secondary (not a primary) may change its name.
      if (await this.deps.secondaries.isSecondary(guildId, afterChannelId)) {
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
    const settings = parseSettings(guild.settings);
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
      above: primary?.template.above !== false,
      ...(primary?.template.inheritperms ? { inheritFrom: primary.template.inheritperms } : {}),
    });

    await this.deps.secondaries.create({
      channelId: newChannelId,
      guildId,
      primaryChannelId: channelId,
      ownerId: member.id,
      state: { name, index, seed },
    });

    await this.deps.actions.moveMember(guildId, member.id, newChannelId);

    this.deps.logger.info(
      { guildId, primaryId: channelId, secondaryId: newChannelId, name, creator: member.id },
      'created secondary channel',
    );
    this.deps.serverLog?.(guildId, 1, `➕ <@${member.id}> created **${name}**`);
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
    this.deps.serverLog?.(guildId, 2, `🗑 Deleted **${secondary.state.name ?? channelId}**`);
    return { action: 'deleted' };
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
    const settings = parseSettings(guild.settings);
    const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
    // A per-channel `/name` override wins over the primary's template.
    const template =
      secondary.state.template ?? primary?.template.name ?? settings.channelNameTemplate;
    const owner = secondary.ownerId ? members.find((m) => m.id === secondary.ownerId) : undefined;
    // Reconciliation may pass a freshly-computed sibling position to renumber
    // `##` tokens after a middle channel was deleted; otherwise use the stored one.
    const index = opts.index ?? secondary.state.index ?? 0;
    const name = renderChannelName(template, {
      index,
      members,
      aliases: settings.aliases,
      general: settings.general,
      ...(secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
      ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
    });

    this.deps.logger.debug(
      {
        guildId,
        secondaryId: channelId,
        currentName: secondary.state.name,
        computedName: name,
        members: members.map((m) => ({ id: m.id, bot: m.bot, playing: m.playing })),
      },
      'rerenderSecondary evaluated',
    );

    if (name === secondary.state.name) return {};
    if (opts.dryRun) return { name };

    const { rateLimited } = await this.deps.actions.renameChannel(guildId, channelId, name);
    // Persist the index + name even when deferred — the queued rename will apply.
    await this.deps.secondaries.updateState(channelId, { ...secondary.state, name, index });

    this.deps.logger.info(
      { guildId, secondaryId: channelId, name, rateLimited },
      're-rendered secondary channel name',
    );
    return { name, ...(rateLimited ? { rateLimited: true } : {}) };
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
    const settings = parseSettings(guild.settings);
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
