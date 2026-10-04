import type {
  AutoChannelRepository,
  AutoChannelRow,
  GuildSettingsReader,
  Logger,
  ManagedChannelRepository,
  ManagedChannelRow,
  MemberAccessLists,
  MemberRoomPrefs,
  MemberRoomPrefsRepository,
  PrimaryTemplate,
  SecondaryChannelRepository,
  SecondaryChannelRow,
  StartMode,
} from '@avc/core';
import { isEntitled, startModeOf } from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { GuildVoiceView, MemberActivity, VoiceMember, VoiceStateEvent } from './types.js';
import {
  getChannelGames,
  getGameName,
  MAX_STATUS_LENGTH,
  renderChannelName,
  type RenderContext,
} from './nameTemplate.js';
import {
  displayName,
  groupKeyFor,
  parseVoiceSettings,
  readGroups,
  type VoiceSettings,
} from './guildSettings.js';
import { ChannelObfuscatedError, isPermissionError, withoutRequestBody } from './discordAdapter.js';
import { CreationRefusedError, type PrivateCreation } from './privacy.js';
import {
  LOST_ACCESS_RETRY_MS,
  permissionProblemMessage,
  type PermissionOperation,
  type PermissionProblemTracker,
} from './permissionProblems.js';
import type { CommandResult } from './commands.js';
import type { PanelOwnerAccess, RoomPanelView } from './controlPanel.js';
import type { PanelRoomRow } from './controlPanelPoster.js';
import { roomMode, type RoomMode } from './roomMode.js';
import { restoreRemembered, standingOf } from './rememberedStart.js';
import { savedListsInert, type CommandAccess, type CommandCaller } from './commandAccess.js';

/** A fresh 31-bit random seed for a channel's `[[random]]` picks. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * What `{{PRIVATE}}` and `{{HIDDEN}}` read for a room that exists, from its row.
 *
 * Through `roomMode`, so a hidden room is hidden and private whatever a stale whole-state
 * write did to `state.private`, and the render agrees with every other reader about what
 * mode a room is in. The row's own `access` is null both for no record and for one this
 * build cannot read, and a render takes both as not hidden: telling them apart costs a
 * second read of the row on every render, and an unreadable record is a newer build's.
 */
function renderPrivacyOf(
  row: Pick<SecondaryChannelRow, 'state' | 'access'>,
): Pick<RenderContextInput, 'isPrivate' | 'isHidden'> {
  const mode = roomMode({ state: row.state, access: { readable: true, access: row.access } });
  return { isPrivate: mode !== 'public', isHidden: mode === 'hidden' };
}

/**
 * Everything a render context needs that is not derivable from the settings.
 *
 * `channelId` is the LIVE channel, read for its user limit. `startAt` comes
 * from the owning primary's template, and is absent for an adopted channel.
 */
export interface RenderContextInput {
  channelId: string;
  settings: VoiceSettings;
  members: VoiceMember[];
  index: number;
  ownerId?: string | null;
  seed?: number | undefined;
  /** Not public: locked, or hidden, which is a kind of locked. For `{{PRIVATE}}`. */
  isPrivate?: boolean;
  /** Hidden from the channel list, for `{{HIDDEN}}`. A hidden room is also `isPrivate`. */
  isHidden?: boolean;
  startAt?: number | undefined;
  /**
   * Whoever created the room, for `@@original_creator@@`: the id so the
   * per-user `/nick` override can still be applied, and the RAW display name
   * cached on the row.
   *
   * Both, because caching the resolved name would freeze a nickname the server
   * can still change, and caching only the id would need a member fetch on the
   * render path for somebody who has usually left.
   */
  originalCreatorId?: string | null | undefined;
  originalCreatorName?: string | undefined;
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
  /**
   * Whether to skip creating a room's companion text channel, for the same
   * reason and by the same mechanism as {@link orderRepairDisabled}.
   *
   * Creation only. Teardown and membership convergence are never gated: a lever
   * that stopped deleting would leave a row outliving its channel permanently,
   * and one that stopped syncing would leave a departed member reading a room
   * they have left, which is the failure the feature exists to prevent.
   */
  companionTextDisabled?: boolean;
  /**
   * Whether to skip posting a room's control panel, by the same mechanism as
   * {@link companionTextDisabled}.
   *
   * New panels only. A panel already posted keeps working, because its buttons
   * run the same ownership checks and the same `/restrict` guard as the slash
   * commands, at click time, so a button a rule has since withdrawn is refused
   * even on a panel that has not caught up, and withdrawing one would mean
   * editing a message in every live room.
   */
  controlPanelDisabled?: boolean;
}

/**
 * Runtime guard consulted before actually creating a secondary — the seam for
 * the no-deploy control plane (global pause, per-guild creation throttle). Kept
 * as an interface so the feature stays decoupled from the flags store and is
 * testable without one. Absent → creation is always allowed.
 */
export interface CreationGate {
  allowCreate(guildId: string): Promise<CreateGateDecision>;
  /**
   * The companion lever alone, for callers that create one OUTSIDE a room
   * create: the reconciler's "this room should have one and does not" repair.
   *
   * Its own method because `allowCreate` also consumes a slot of the per-guild
   * creation throttle, which a repair must not do. Absent → not disabled.
   */
  companionTextDisabled?(): Promise<boolean>;
  /**
   * The control panel lever alone, for the re-render path.
   *
   * Its own method for the same reason the companion's is: `allowCreate` also
   * spends a slot of the per-guild creation throttle, and a re-render must not.
   * Absent means not disabled.
   */
  controlPanelDisabled?(): Promise<boolean>;
  /**
   * The `/restrict` lever alone, for the one restriction a render enforces: a
   * saved nickname that a rule now covers stops showing in room names.
   *
   * Its own method for the same reason as the two above. Absent means not
   * disabled, which keeps the rules in force.
   */
  commandAccessDisabled?(): Promise<boolean>;
  /**
   * The room access lever alone (`room_access.disabled`), for the two things a room create
   * does with it: make a locked room where the creator channel asks for a hidden one, and
   * skip applying the creator's saved lists to the room it just made.
   *
   * Its own method, and not a field of the decision, because the lever is not a creation
   * lever and a room is created whatever it says. Asked through the gate's cached snapshot
   * and failing open, so it costs no query and a blip hides the room and lets the lists
   * apply. Absent means not disabled.
   */
  roomAccessDisabled?(): Promise<boolean>;
  /**
   * The remembered room settings lever alone (`member_prefs.disabled`), for the two things
   * this feature does with it: not restoring what a member saved into the room they are making,
   * and saying "switched off for now" where an admin reads about the setting.
   *
   * Its own method, and not a field of the decision, for the reason the one above is: it is not
   * a creation lever and a room is made whatever it says. Asked only for a creator channel that
   * remembers, through the gate's cached snapshot (no query), and failing open, so a blip
   * restores what the member saved. Absent means not disabled.
   */
  memberPrefsDisabled?(): Promise<boolean>;
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
   * What members have remembered about their own rooms: counted for the two admin readouts
   * (the creator channel editor and `/channelinfo`), and read, for the member who is making
   * a room, to start it the way they left their last one. Optional like every other repository
   * here, so the feature is testable without it, and absent means "not counted" rather than
   * "nobody", and a room made from the creator channel's own defaults.
   *
   * `get` is optional on its own: a construction that only counts restores nothing.
   */
  memberPrefs?: Pick<MemberRoomPrefsRepository, 'countByPrimary'> &
    Partial<Pick<MemberRoomPrefsRepository, 'get'>>;
  /**
   * Called after a secondary's record is removed (deletion or reconcile), so
   * dependent resources (e.g. a private channel's "⇩ Join" companion) can be
   * cleaned up. Must be idempotent and tolerate an unknown channel.
   */
  onSecondaryRemoved?: (guildId: string, channelId: string) => Promise<void>;
  /**
   * Per-room companion text channels, when the feature is wired.
   *
   * Optional like every other companion here, so the feature is testable and
   * self-host-identical without it. Each hook is called for its own reason and
   * each one already swallows its failures: a room whose chat could not be made
   * is a working room, and nothing on the voice path may fail because of one.
   */
  companionText?: {
    createForRoom(
      guildId: string,
      roomId: string,
      primaryChannelId: string,
      initialMemberIds: readonly string[],
    ): Promise<string | null>;
    syncRoom(guildId: string, roomId: string): Promise<void>;
    handleChannelDeleted(guildId: string, channelId: string): Promise<boolean>;
    describeRoom(
      guildId: string,
      roomId: string,
    ): Promise<{ channelId: string; roleId: string | null } | null>;
    reconcileGuild(
      guildId: string,
      opts: { allowCreate: boolean; dryRun?: boolean },
    ): Promise<{ created: number; synced: number; removed: number }>;
  };
  /**
   * The room control panel, when the feature is wired.
   *
   * Optional and structural like {@link companionText}, so the feature stays
   * testable without a Discord client and behaves identically on self-host.
   * `postForRoom` swallows its own failures: a room with no panel is a working
   * room, and nothing on the voice path may fail because a message did not send.
   *
   * There is deliberately no teardown hook. The panel lives in a channel that
   * dies with the room, so there is nothing to converge and nothing to clean up
   * - which is the whole reason the panel is per room rather than the per-guild
   * pinned message this replaced.
   */
  controlPanel?: {
    postForRoom(
      guildId: string,
      roomId: string,
      primaryChannelId: string,
      destinationChannelId: string,
      view: RoomPanelView,
      known?: PanelRoomRow,
    ): Promise<void>;
    refreshForRoom(
      guildId: string,
      roomId: string,
      row: PanelRoomRow,
      view: RoomPanelView,
    ): Promise<void>;
  };
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
    /**
     * `handover` is set for a deliberate `/transfer` or claim, and not when the owner
     * left. Only a handover changes whose saved lists apply to the room.
     */
    opts?: { handover?: boolean },
  ) => Promise<void>;
  /**
   * Resolves a secondary's "⇩ Join" companion channel id, if it has one (private
   * channels). Used by `/position` so a companion moves with its secondary.
   */
  joinCompanionFor?: (secondaryChannelId: string) => Promise<string | undefined>;
  /**
   * The clock, for the date and time tokens. Unset means the real one.
   *
   * Exists so a test can pin an instant: the engine takes `now` as an argument
   * rather than reading it, and this is the seam that supplies it.
   */
  clock?: () => Date;
  /**
   * Applies the private treatment to a just-spawned secondary when its primary starts
   * its rooms locked or hidden (`mode`; mirrors `/private` or `/hide`, but grants the
   * owner access by id since their move may not be in the voice cache yet). Idempotent;
   * no-op when unset.
   *
   * **Throws when it cannot, which is what the create path's rollback reads**: a room
   * meant to be locked or hidden that a permission error or a refusal stopped is deleted
   * rather than left open, and a hidden one is deleted for any failure. A locked room that
   * fails for another reason is left to the sweep, as it always was.
   */
  makePrivateOnCreate?: (
    guildId: string,
    channelId: string,
    ownerId: string,
    ownerName: string,
    mode: 'locked' | 'hidden',
  ) => Promise<void>;
  /**
   * {@link makePrivateOnCreate} for a mode the MEMBER remembered, which answers instead of
   * throwing (the privacy service's `tryMakePrivateForCreation`). Optional, and without it a
   * remembered privacy is not restored at all: the only other way to make a room private on
   * creation is the one whose failure deletes the room, which is right for an admin's own
   * default and never for what a member happened to choose last time.
   *
   * A failure is logged and the room is made as the creator channel's own default would have
   * it, which for a public default is a plain public room. It is never deleted for this, and
   * never thrown. `quiet` keeps a permission failure off the guild's problem list, for a call
   * that is about to be followed by the admin's own default, whose rollback reports it.
   */
  tryMakePrivateOnCreate?: (
    guildId: string,
    channelId: string,
    ownerId: string,
    ownerName: string,
    mode: 'locked' | 'hidden',
    opts?: { quiet?: boolean },
  ) => Promise<PrivateCreation>;
  /**
   * Applies the creator's saved trusted and blocked lists to a just-made room (the privacy
   * service's `applyAccessLists`), after the owner's move and any default-private step.
   * `creator.standing` is who they are from the member's own snapshot, absent when it
   * carries no roles. Optional so the feature runs without saved lists, and it never
   * throws: a room whose lists could not be applied is a working room, and the sweep
   * applies them within one interval.
   */
  applyAccessLists?: (
    guildId: string,
    roomChannelId: string,
    creator: {
      id: string;
      standing?: CommandCaller | undefined;
      /** The creator's lists, read while the room was being made. Absent: the service reads them. */
      saved?: MemberAccessLists | undefined;
    },
  ) => Promise<{ status: string; error?: unknown }>;
  /**
   * Reads a creator's saved lists (the privacy service's), so the create path can start the
   * read beside the Discord create instead of after it. Optional, and never relied on:
   * without it the service reads them itself, one serial query later.
   */
  readSavedLists?: (guildId: string, ownerId: string) => Promise<MemberAccessLists | undefined>;
  /**
   * The sweep's pass over a guild's saved lists and hidden rooms (the privacy service's
   * `convergeGuild`), given the guild's live rooms. Gated by `room_access.disabled` inside,
   * and never throws.
   */
  roomAccess?: {
    convergeGuild(guildId: string, rooms: readonly SecondaryChannelRow[]): Promise<unknown>;
  };
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
   *
   * The guild id is passed because a `created` event is also written per guild,
   * daily, and that series is the only durable evidence a given server actually
   * uses AVC - the row this call sits beside is gone as soon as the room empties.
   */
  countRoom?: (event: 'created' | 'deleted', guildId: string) => void;
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

/**
 * What AVC considers a voice channel to be. `unmanaged` is a real answer, not a
 * failure: it is what `/channelinfo` tells someone standing in an ordinary voice
 * channel, and it is the state `/template` offers to adopt.
 */
export type ChannelKind = 'room' | 'creator' | 'managed' | 'unmanaged';

/** Where an effective template came from, for the "why this name" explanation. */
export type TemplateSource = 'channel' | 'creator' | 'server' | 'managed';

/**
 * The template half of {@link ChannelInfo}: the context to render against and
 * the templates in effect, with their provenance.
 */
export interface ChannelRenderInfo {
  /**
   * The render context. Built by {@link VoiceFeature.buildRenderContext} for
   * every kind except `creator`, where it is synthetic (see {@link synthetic}),
   * and handed out so a diagnostic surface renders through the real engine
   * rather than describing what it thinks the engine would do.
   */
  ctx: RenderContext;
  /**
   * True when {@link ctx} describes a channel that does not exist: a creator
   * channel has no room of its own, so its template is previewed against the
   * FIRST room it would spawn. A surface showing this must say so, or it
   * reports a name no channel has ever had as if it were live.
   */
  synthetic: boolean;
  nameTemplate: string;
  nameSource: TemplateSource;
  statusTemplate: string;
  statusSource: TemplateSource;
}

/** The creator channel's own configuration, for the admin half of the panel. */
export interface PrimaryConfig {
  channelId: string;
  startAt?: number | undefined;
  above?: boolean | undefined;
  limit?: number | undefined;
  /** How new rooms start: open, locked or hidden. A hidden default needs `defaultPrivate` too. */
  defaultMode: StartMode;
  inheritperms?: string | undefined;
  /** Whether rooms from this creator channel get a private text channel. */
  textChannel?: boolean | undefined;
  /** Whether a member who comes back gets the name, size and privacy they chose last time. */
  rememberPrefs?: boolean | undefined;
  /**
   * How many members have something saved for this creator channel. Present only while it
   * remembers and only when the count could be read: the line is an admin's, so the read is
   * not paid for a creator channel that does not remember, and a count that failed is left out
   * and not shown as nobody.
   */
  savedSettings?: number | undefined;
  /**
   * True while `member_prefs.disabled` is on for a creator channel that remembers, so the
   * readout can say it is switched off for now and not "on" about a feature that is doing
   * nothing. Present only when true, and read with the count, so only for a viewer who sees it.
   */
  rememberPaused?: boolean | undefined;
}

/** Lifts a creator channel's stored template into the reportable subset. */
function primaryConfig(row: { channelId: string; template: PrimaryTemplate }): PrimaryConfig {
  return {
    channelId: row.channelId,
    startAt: row.template.startAt,
    above: row.template.above,
    limit: row.template.limit,
    defaultMode: startModeOf(row.template),
    inheritperms: row.template.inheritperms,
    textChannel: row.template.textChannel,
    rememberPrefs: row.template.rememberPrefs,
  };
}

/**
 * Everything `/channelinfo` reports about one voice channel.
 *
 * Deliberately not {@link ChannelDebug}. That one is a raw dump whose shape we
 * change freely, and it exists to be read by us; this one backs a command any
 * member can run, so it carries the resolved answers rather than the raw state.
 */
export interface ChannelInfo {
  channelId: string;
  kind: ChannelKind;
  /** Absent for `unmanaged`, which has no template and nothing to render. */
  render?: ChannelRenderInfo;
  ownerId: string | null;
  /** Whoever holds the durable claim, so `/reclaim` can be explained. */
  originalCreator: string | null;
  primary?: PrimaryConfig;
  seed?: number;
  /** The stored sibling index, which the `##` family renders from. */
  index?: number;
  /** LIVE, from Discord, not the creator channel's configured default. */
  userLimit: number;
  isPrivate: boolean;
  /**
   * How open a room is, as `/channelinfo` states it: public, locked, hidden from the
   * channel list, or `unknown` when its access record cannot be read (a newer build wrote
   * it, and saying "public" or "locked" for what may be a hidden room is the harm).
   * `public` for every kind that is not a room. `isPrivate` stays true for a hidden room,
   * which is a locked one, and is what `{{PRIVATE}}` reads.
   */
  accessMode: RoomMode;
  /**
   * The moderator role this room's record says can see it while it is hidden, so the
   * readout can name who else sees a room hidden from the channel list. Absent when the
   * room is not hidden, has no such role, or its record cannot be read.
   */
  viewerRoleId?: string;
  members: { total: number; bots: number };
  /** The representative game after aliases, and the raw names behind it. */
  game: string;
  rawGames: string[];
  general: string;
  enabled: boolean;
  aliasCount: number;
  /**
   * This room's companion text channel, when it has one.
   *
   * Carried so the readout can DISCLOSE who else can read it. The moderator
   * role is a guild setting a member never sees, and a private chat whose
   * audience is larger than the room is exactly the thing they should be able
   * to check for themselves.
   */
  companion?: { channelId: string; roleId: string | null };
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
  /**
   * Creator channel editors only (`scope: 'primary'`): whether this creator channel remembers
   * members' room settings, which the editor's switch shows and flips.
   */
  rememberPrefs?: boolean;
  /**
   * Creator channel editors only: how many members have something saved for it. Counted
   * whether or not it remembers, because what is saved is kept when it is turned off and the
   * editor's "Clear saved settings" acts on it. Absent when it could not be counted.
   */
  savedSettings?: number;
  /**
   * Creator channel editors only: true while `member_prefs.disabled` is on for a creator
   * channel that remembers, so the field says it is switched off for now. Absent otherwise.
   */
  rememberPaused?: boolean;
}

/** What the room control panel's buttons need to know about a room. */
export interface RoomPanelState {
  ownerId: string | null;
  /** Who is in the room now, for the Transfer and Kick pickers. */
  members: VoiceMember[];
  /**
   * The room's LIVE user limit (0 = unlimited), for the Limit modal's prefill.
   *
   * Read from Discord, not from the creator channel's stored default: `/limit`
   * writes straight through and stores nothing, so only a live read is true.
   * Zero when the cache cannot say, which prefills an empty box rather than a
   * wrong number.
   */
  userLimit: number;
  /** The per-room name override, for the Rename modal's prefill. */
  nameOverride?: string;
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

  /**
   * Rooms the sweep has stopped renaming for a while, by channel id, because the bot can no
   * longer edit them. In memory, so a restart asks once more.
   */
  private readonly unrenamable = new Map<string, { guildId: string; at: number }>();

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
        // `@@owner@@` resolves to the new owner (not "Unknown") and a private
        // channel's "⇩ Join" follows suit.
        await this.handleSecondaryLeave(guildId, beforeChannelId, event.member.id);
        // The leaver loses sight of the room's text channel. Derived from the
        // live roster inside, so a missed event is repaired rather than
        // accumulated, and a no-op costs no request.
        await this.deps.companionText?.syncRoom(guildId, beforeChannelId);
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
        await this.deps.companionText?.syncRoom(guildId, afterChannelId);
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
    const settings = await this.voiceSettings(guild.settings, guildId);
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

    // What this member left behind for this creator channel, started HERE and not at the top:
    // everything above can still decide there is no room to make, and a join to a server that
    // is paused or not entitled must not cost a read. It runs beside the reads below and is
    // awaited before the first render, which is the first thing that needs it.
    const rememberedRead = this.startRememberedRead(guildId, primary, member);
    // The creator's saved lists, for the same reason and read beside the same work: they are
    // applied after the move, and a read that waited for it would stand between the owner and
    // the companion channel and the panel, which every room pays for.
    const savedListsRead = this.startSavedListsRead(guildId, member);

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
    // category numbers and places against the whole GROUP instead, so it reads all
    // of that off `groupState` rather than off this one primary.
    const siblings = group ? [] : await this.deps.secondaries.listIdsByPrimary(channelId);
    const groupState = group ? await this.groupMembers(guildId, categoryKey) : undefined;
    /**
     * Where the room is placed, and which way up.
     *
     * **A grouped category is anchored to the GROUP, not to the primary the member
     * joined, and takes the GROUP's direction.** `repositionGroup` puts the block
     * above every creator channel in the category or below every one of them, so
     * anchoring the create at one primary and using that primary's own `above`
     * flag placed the room somewhere the group rule then had to undo — twice over
     * in a guild whose primary says `above` while its group says below, which is
     * the three-jump case in the recording this fixes.
     */
    const above = group ? group.above : primary?.template.above === true;
    const groupPrimaries = groupState
      ? (this.deps.voice.displayOrderOf?.(groupState.primaryIds) ?? groupState.primaryIds)
      : [];
    const anchorId =
      (above ? groupPrimaries[0] : groupPrimaries[groupPrimaries.length - 1]) ?? channelId;
    // Plain room ids, deliberately not `companionBlock`: the walk that reads this
    // already steps over a private room's companion (it sits directly above its
    // room and is never the last thing in a block), so resolving companions here
    // would add a Postgres read per room to the path a member waits on.
    const blockIds = groupState ? groupState.secondaries.map((sec) => sec.channelId) : siblings;
    // Checked BEFORE the create, so it describes the block we inherited rather
    // than one this create has just added to.
    const misordered =
      !group && !gate?.orderRepairDisabled && this.blockMisordered(channelId, siblings, above);
    const index = groupState ? groupState.secondaries.length : siblings.length;
    /**
     * Repair an inherited misorder BEFORE creating, not after.
     *
     * The repair is the same single bulk reorder either way, but running it first
     * means the new room is placed into a block that is already right, so its first
     * appearance is its final position. Running it afterwards, as this did, moved
     * the room the member was watching.
     *
     * Best-effort and contained: nothing has happened yet, so a failure here just
     * means the create proceeds exactly as it would have before, and the
     * collision check after the create is still the backstop.
     */
    if (misordered) {
      this.deps.logger.info(
        { guildId, primaryId: channelId },
        'repairing out-of-order secondaries before creating',
      );
      try {
        await this.repositionSecondaries(guildId, channelId, above);
      } catch (err) {
        this.deps.logger.warn(
          { guildId, primaryId: channelId, err },
          'could not repair secondary order',
        );
      }
    }
    /**
     * What the member's own remembered settings change about this room, which is nothing for a
     * creator channel that does not remember, a member who has saved nothing, a read that
     * failed, or a field their standing does not allow. Every applied field goes into the
     * create below and into the first render and the first panel, never into an edit after
     * them, so a remembered name costs no rename of the two a room gets per ten minutes.
     */
    const defaultMode: StartMode = primary ? startModeOf(primary.template) : 'public';
    const remembered = restoreRemembered(await rememberedRead, {
      access: settings.commandAccess,
      standing: standingOf(member),
      defaultMode,
    });
    const template = remembered.name ?? primary?.template.name ?? settings.channelNameTemplate;
    // The creator channel's default limit, unless the member chose one. Their 0 is a choice too.
    const userLimit = remembered.limit ?? primary?.template.limit ?? 0;
    /**
     * How this room starts: open, locked or hidden. ONE value read ONE time, because the
     * render, the slot reservation, the privacy step and the panel all have to agree on
     * it, and four separate reads of the stored booleans are how they drift. It is the
     * creator channel's default, or the member's remembered privacy when that is STRICTER
     * (`restoreRemembered` has already dropped one that is not).
     *
     * A remembered mode needs the hook that does not throw. Without it the only way to make a
     * room private is the one whose failure deletes the room, which is the admin's own default
     * and never a member's earlier choice.
     */
    let startMode: StartMode = defaultMode;
    let rememberedMode = this.deps.tryMakePrivateOnCreate ? remembered.privacy : undefined;
    if (rememberedMode !== undefined) startMode = rememberedMode;
    /**
     * `room_access.disabled` stops new hides, and a creator channel that starts its rooms
     * hidden is the one creation that hides. Without this the lever could not reach it, and
     * a fleet where hiding fails would delete a room on every join to such a channel until a
     * deploy. A locked room is what an instance that predates hiding makes from the same
     * stored setting, so the room is still private to join, and it is the only thing the
     * lever changes about a creation: it never makes a room open. Decided HERE, before the
     * render, so `{{HIDDEN}}` and the panel agree with the room that is actually made.
     *
     * Asked only of a room that would be hidden, through the gate's cached snapshot (no
     * query), and failing open: a blip hides the room as asked. A hide the MEMBER remembered
     * is not turned into a lock: it is skipped, and the room is what the creator channel
     * would have made without it, since a member who wanted their room hidden has not asked
     * for it to be locked.
     */
    if (
      startMode === 'hidden' &&
      (await this.deps.gate?.roomAccessDisabled?.().catch(() => false))
    ) {
      if (rememberedMode === 'hidden') {
        startMode = defaultMode;
        rememberedMode = undefined;
        this.deps.logger.info(
          { guildId, primaryId: channelId },
          'room_access.disabled is on: not restoring the hidden room a member remembered',
        );
      } else {
        startMode = 'locked';
        this.deps.logger.info(
          { guildId, primaryId: channelId },
          'room_access.disabled is on: making a locked room where the creator channel asks for hidden',
        );
      }
    }
    // Generate the per-channel random seed once, here, so `[[random]]` picks are
    // fixed for this channel's lifetime and never trigger a later rename.
    const seed = randomSeed();
    const name = renderChannelName(template, {
      ...this.buildRenderContext({
        channelId,
        settings,
        members: [member],
        index,
        ownerId: member.id,
        seed,
        // The room does not exist yet, so `{{PRIVATE}}` and `{{HIDDEN}}` have to come
        // from the primary's intent. `makePrivateOnCreate` runs AFTER this render, so
        // reading them back would render `false` and cost an immediate second
        // rename on every default-private room. A hidden room is private as well.
        isPrivate: startMode !== 'public',
        isHidden: startMode === 'hidden',
        startAt: primary?.template.startAt,
        // On the create path the joining member IS the original creator, so
        // the token renders correctly on the very first name.
        originalCreatorId: member.id,
        originalCreatorName: member.displayName,
      }),
      // `buildRenderContext` reads the LIVE channel's limit, and the live
      // channel here is the CREATOR channel, which is not the room being made.
      // The room is created with the limit decided above (the member's remembered one,
      // else the primary's configured default), so that is the honest value for this
      // one render.
      userLimit,
    });

    // Copy the primary's own bitrate/region/video-quality/nsfw, matching the
    // legacy bot (`create_secondary`). `voicePropertiesOf` is "cannot say" when
    // absent (cold cache), in which case none of these are set and Discord's
    // own defaults apply, same as before this copy existed. A `null` region or
    // video-quality mode means the primary itself has no override ("Automatic"
    // / "Auto"), which is already what a freshly created channel gets, so it is
    // left unset rather than copied literally.
    const primaryProps = this.deps.voice.voicePropertiesOf?.(channelId);
    let newChannelId: string;
    try {
      newChannelId = await this.deps.actions.createVoiceChannel({
        guildId,
        name,
        userLimit,
        ...(primaryProps
          ? {
              bitrate: primaryProps.bitrate,
              nsfw: primaryProps.nsfw,
              ...(primaryProps.rtcRegion !== null ? { rtcRegion: primaryProps.rtcRegion } : {}),
              ...(primaryProps.videoQualityMode !== null
                ? { videoQualityMode: primaryProps.videoQualityMode }
                : {}),
            }
          : {}),
        // The primary the member joined: its category, and the permissions the
        // room inherits. Never the group's anchor, which is a different channel
        // whose overwrites are none of this room's business.
        nearChannelId: channelId,
        // Where to PUT it: this primary, or the group's end primary when the
        // category is grouped (see where the two are resolved, above).
        anchorChannelId: anchorId,
        // Default is below the anchor; only `above: true` positions above it.
        above,
        // Below the anchor means below its existing rooms too, not between them.
        afterChannelIds: blockIds,
        // A default-private room's "join" companion is created moments later and
        // has to sit directly above it, so keep that slot free now. A hidden room has
        // no Join channel, so there is nothing to reserve a slot for.
        ...(startMode === 'locked' ? { reserveSlotAbove: true } : {}),
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

    const roomRow = await this.deps.secondaries.create({
      channelId: newChannelId,
      guildId,
      primaryChannelId: channelId,
      ownerId: member.id,
      // Seed the arrival roster with the owner (longest-present from birth).
      // The RAW display name, not `displayName(settings, member)`: the `/nick`
      // override is applied at render so a later change to it still takes.
      state: {
        name,
        index,
        seed,
        roster: [member.id],
        originalCreatorName: member.displayName,
        // The member's own template, exactly as `/name` would have stored it, so every later
        // render of this room reads it from the same place and agrees with `name` above.
        ...(remembered.name !== undefined ? { template: remembered.name } : {}),
      },
    });
    this.deps.countRoom?.('created', guildId);

    // What the member remembered about privacy, made first and by the hook that does not
    // throw. A failure leaves the room as the creator channel's own default would make it,
    // which the step below then makes in the strict way, and is never a reason to delete
    // the room: this is a preference, and the only room worth deleting for want of a lock
    // is the one an admin asked for. Not when only the Join channel could not be made, which
    // leaves the room in the mode that was asked for, and the sweep makes the channel. The
    // name above was rendered for the mode that was asked for, so a template that reads
    // `{{PRIVATE}}` or `{{HIDDEN}}` is corrected by the re-render that follows the owner's
    // arrival, at the cost of one rename.
    let privacyDone = false;
    if (rememberedMode !== undefined) {
      const held = await this.restorePrivacy(guildId, channelId, newChannelId, member, settings, {
        mode: rememberedMode,
        // A strict step follows when the creator channel starts its rooms private too, and
        // it reports its own failure against the creator channel.
        quiet: defaultMode !== 'public',
      });
      if (held) privacyDone = true;
      else startMode = defaultMode;
    }

    // Default-private primaries: lock or hide the new channel before the owner lands in
    // it (granting them access by id, since their move isn't cached yet). Hidden
    // writes the owner's View and Connect, the bot's allow and the `@everyone` deny,
    // and makes no Join channel.
    //
    // A hidden room is therefore as visible as the creator channel it copies, and named,
    // from the create above until this write lands: the create payload carries the copied
    // overwrites as they are, with no hide in them. It is a few requests, and closing it
    // means sending the bot's allow, the owner's access and the deny in the create itself.
    if (startMode !== 'public' && !privacyDone) {
      try {
        await this.deps.makePrivateOnCreate?.(
          guildId,
          newChannelId,
          member.id,
          displayName(settings, member),
          startMode,
        );
      } catch (err) {
        // A refusal is a failure of the same kind as a missing permission: the plan will
        // not hide the room (a role the bot cannot edit would still show it), so the room
        // would be open to everyone. It is not a Discord error, so it needs its own check.
        const refused = isPermissionError(err) || err instanceof CreationRefusedError;
        if (!refused && startMode !== 'hidden') throw err;
        // Same recovery as a failed move: a channel we can't finish locking
        // down is worse than no channel, since nobody (not even the owner) can
        // get into it, and a room meant to be hidden that is open is worse
        // still. Stop tracking it, best-effort delete, and notify.
        if (!refused) {
          // Any OTHER failure to hide (a Discord 5xx, a dropped socket) leaves the same
          // open room, named after its owner and in everyone's channel list, with nobody
          // in it. It is empty because the owner is not moved until this succeeds, so
          // deleting it loses nothing. The failure itself is still rethrown, so the
          // guild's breaker counts it and no notice blames the admin for a fault of ours.
          await this.discardUnfinishedRoom(guildId, newChannelId).catch(() => undefined);
          throw err;
        }
        await this.discardUnfinishedRoom(guildId, newChannelId);
        this.deps.permissionProblems?.record(guildId, {
          channelId,
          operation: 'privacy',
          at: Date.now(),
        });
        this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId, 'privacy'));
        this.deps.logger.warn(
          { guildId, primaryId: channelId, secondaryId: newChannelId, mode: startMode, err },
          'created secondary but cannot make it private',
        );
        return { action: 'skip' };
      }
    }

    let moved: boolean;
    try {
      moved = await this.deps.actions.moveMember(guildId, member.id, newChannelId);
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
     * A creator who left voice while the room was being made (the move answers 40032, which the
     * adapter swallows) has nobody to be moved in, and the room is empty. Everything below
     * would make a companion channel in a category capped at 50 and post a panel for a room
     * that nobody is in, and the sweep would delete it all minutes later. So it is removed
     * now, like any room that could not be finished, and nothing here is an error: leaving a
     * creator channel at once is ordinary. `=== false`, so an action seam that answers nothing
     * still reads as moved.
     */
    if (moved === false) {
      await this.discardUnfinishedRoom(guildId, newChannelId).catch(() => undefined);
      this.deps.logger.info(
        { guildId, primaryId: channelId, secondaryId: newChannelId },
        'the creator left voice before the room was ready; removed it',
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
    /**
     * Narrowed to the operations this success speaks for.
     *
     * A companion failure is recorded against this same creator channel, and a
     * blanket clear here would reset the notifier's backoff on every room
     * create, turning a four-notice ladder into one notice per room for any
     * guild that can make rooms but not their text channels.
     */
    this.deps.permissionProblems?.clear(guildId, channelId, ['create', 'move', 'privacy']);

    /**
     * The creator's saved trusted and blocked lists, applied to the room they just made.
     *
     * AFTER the move and after any default-private step, never before them: both
     * rollbacks above delete the room, and this must not be something they have to
     * unwind. By here the room is committed, and what this adds is a block that has to
     * be in place before anyone else can join it.
     */
    await this.applySavedLists(
      guildId,
      newChannelId,
      member,
      settings.commandAccess,
      await savedListsRead,
    );

    /**
     * The companion text channel, for a creator channel that opted in.
     *
     * AFTER the move, not after the row insert: both rollbacks above delete the
     * room they just made, so anything created before them would have to be
     * unwound by each. By here the room is committed.
     *
     * The member is passed BY ID rather than read from the roster for the reason
     * the seeded `roster` above documents: their move into the room has not
     * reached the voice cache yet.
     */
    const companionId = gate?.companionTextDisabled
      ? null
      : ((await this.deps.companionText?.createForRoom(guildId, newChannelId, channelId, [
          member.id,
        ])) ?? null);

    /**
     * The room control panel, in the room's own chat, or in its companion text
     * channel when the creator channel has those switched on.
     *
     * **Outside the companion lever above, not inside it.** Freezing companion
     * creation fleet-wide must not silently take the panel with it: a guild
     * whose companions are frozen still gets its rooms, and those rooms still
     * have a built-in chat to put the buttons in. So the destination is
     * whatever companion actually got made, and the room itself otherwise.
     *
     * Awaited rather than fired off, so its write to `state` cannot race the
     * rename the debounced scheduler is about to queue for this same room. It
     * is cheap and it never throws.
     */
    if (!gate?.controlPanelDisabled) {
      await this.deps.controlPanel?.postForRoom(
        guildId,
        newChannelId,
        channelId,
        companionId ?? newChannelId,
        {
          ownerId: member.id,
          primaryChannelId: channelId,
          // From the mode the room was just made in, rather than read back from Discord:
          // the overwrites were applied moments ago and the channel cache may not carry
          // them yet, and a create is the one moment we know the answer for certain.
          isPrivate: startMode !== 'public',
          // On a replay that finds a live room the row says whether it is hidden, as it
          // does for the settings above.
          isHidden: startMode === 'hidden' || roomRow?.access?.hidden === true,
          userLimit,
          ownerAccess: this.panelOwnerAccess(newChannelId, member.id),
        },
        // The row the insert above returned, which on a conflict is the LIVE
        // one, so it answers the poster's replay guard without a second read
        // on the path a member is waiting on. Nothing between here and there
        // writes the panel keys, so it is still the right answer.
        roomRow,
      );
    }

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
    } else if (!gate?.orderRepairDisabled) {
      /**
       * The backstop, for the one thing create-time placement cannot promise:
       * this room having had nowhere unique to land.
       *
       * A tie decays into a real misorder if left, because a client renders one in
       * an order of its own and Discord eventually makes that order permanent. The
       * INHERITED-misorder case is repaired before the create now, so the room is
       * placed into a block that is already right and never has to be moved
       * afterwards — but this still runs in that case rather than being skipped,
       * because a pre-create repair that failed AND a re-space that failed would
       * otherwise leave a tie with nothing left to repair it.
       *
       * The reorder also re-spaces the block, so the next create finds a free slot
       * and needs no reorder at all. That is what keeps this off the common path
       * rather than on every join.
       */
      // Contained as ONE unit, the deciding included, because by this point the
      // room exists and the member is in it. `repositionSecondaries` reads the
      // join companions from Postgres, so a blip there would otherwise reject a
      // create that has already succeeded: no `created` result, no `/logging`
      // line, and a task failure counted against this guild's circuit-breaker,
      // all for a cosmetic reorder. The collision check sits inside the same
      // guard rather than above it for that reason, whatever its implementation
      // happens to do today.
      try {
        const tied = (await this.deps.actions.positionCollides?.(guildId, newChannelId)) ?? false;
        if (tied) {
          this.deps.logger.info(
            { guildId, primaryId: channelId, secondaryId: newChannelId },
            'repairing a secondary that had nowhere unique to land',
          );
          await this.repositionSecondaries(guildId, channelId, above);
        }
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
   * Stops tracking a room that was just made and could not be finished, and deletes it
   * from Discord, best effort. Idempotent, and tolerates a channel that is already gone.
   */
  private async discardUnfinishedRoom(guildId: string, roomId: string): Promise<void> {
    await this.deps.secondaries.remove(roomId);
    await this.deps.onSecondaryRemoved?.(guildId, roomId);
    await this.deps.actions.deleteChannel(guildId, roomId).catch(() => undefined);
  }

  /**
   * Starts reading what this member remembered for this creator channel, or resolves to nothing
   * at once for a creator channel that does not remember or a feature with nothing to read it
   * with. **The promise never rejects**, and its catch is attached HERE, where it is made: it is
   * awaited a good way down, after reads and a Discord create that can each throw first, and a
   * rejection nobody was yet waiting for would be an unhandled one. A read that fails is logged
   * with ids and reads as nothing saved, so a prefs error makes the room with the creator
   * channel's defaults and never fails the join.
   *
   * `member_prefs.disabled` is asked only for a creator channel that remembers, through the
   * gate's cached snapshot and failing open, so every other creator channel pays nothing.
   * While it is on nothing is read at all. Read-only, so a replay (the sweep's catch-up call
   * is one) can run it again and costs a read, never a write.
   */
  private startRememberedRead(
    guildId: string,
    primary: AutoChannelRow,
    member: VoiceMember,
  ): Promise<MemberRoomPrefs | undefined> {
    const get = this.deps.memberPrefs?.get?.bind(this.deps.memberPrefs);
    if (primary.template.rememberPrefs !== true || !get) return Promise.resolve(undefined);
    const read = async (): Promise<MemberRoomPrefs | undefined> =>
      (await this.memberPrefsPaused()) ? undefined : get(primary.channelId, member.id);
    return read().catch((err: unknown) => {
      this.deps.logger.warn(
        { err, guildId, primaryId: primary.channelId, memberId: member.id },
        'could not read remembered room settings; making the room from the creator channel defaults',
      );
      return undefined;
    });
  }

  /**
   * Starts reading the creator's saved lists, or resolves to nothing at once for a feature with
   * nothing to read them with and while `room_access.disabled` is on (nothing is applied then).
   * **Never rejects**, with its catch attached HERE for the reason {@link startRememberedRead}
   * gives: it is awaited a long way down, after calls that can throw first. A read that fails
   * is logged with ids and reads as nothing read, and the service reads them itself.
   */
  private startSavedListsRead(
    guildId: string,
    member: VoiceMember,
  ): Promise<MemberAccessLists | undefined> {
    const read = this.deps.readSavedLists;
    if (!read) return Promise.resolve(undefined);
    const start = async (): Promise<MemberAccessLists | undefined> =>
      (await this.deps.gate?.roomAccessDisabled?.().catch(() => false))
        ? undefined
        : read(guildId, member.id);
    return start().catch((err: unknown) => {
      this.deps.logger.warn(
        { err, guildId, memberId: member.id },
        'could not read the creator saved lists early; the service reads them when it applies them',
      );
      return undefined;
    });
  }

  /** Whether `member_prefs.disabled` is on. Fails open, whatever the gate does. */
  private async memberPrefsPaused(): Promise<boolean> {
    try {
      return (await this.deps.gate?.memberPrefsDisabled?.()) === true;
    } catch {
      return false;
    }
  }

  /**
   * Makes a room as private as its creator remembered it, by the hook that answers and never
   * throws, and says whether the room is now in that mode. A failure is logged with ids and the
   * reason, never the owner's name, and the caller makes the room as its creator channel would
   * have: nothing here deletes the room, and nothing here counts against the guild.
   *
   * A room whose only fault is its Join channel is in the mode that was asked for, so it is
   * not described as open: the sweep makes the missing channel.
   */
  private async restorePrivacy(
    guildId: string,
    primaryId: string,
    roomId: string,
    member: VoiceMember,
    settings: VoiceSettings,
    opts: { mode: 'locked' | 'hidden'; quiet: boolean },
  ): Promise<boolean> {
    let result: PrivateCreation;
    try {
      result = await this.deps.tryMakePrivateOnCreate!(
        guildId,
        roomId,
        member.id,
        displayName(settings, member),
        opts.mode,
        { quiet: opts.quiet },
      );
    } catch (err) {
      // The hook is meant to answer, but a preference must never fail a room, whatever it does.
      result = { ok: false, reason: 'failed', error: err };
    }
    if (result.ok) return true;
    this.deps.logger.warn(
      {
        guildId,
        primaryId,
        secondaryId: roomId,
        mode: opts.mode,
        reason: result.reason,
        held: result.held === true,
        err: withoutRequestBody(result.error),
      },
      'could not make a room private as its creator remembered',
    );
    return result.held === true;
  }

  /**
   * Applies the creator's saved lists to a room that has just been made, so a block they
   * saved reaches the public room they create tomorrow and a trusted friend is let into a
   * locked or hidden one.
   *
   * **Never throws, and never fails the room.** The room exists and the member is in it,
   * and the sweep applies the same lists to every room within one interval, so a failure
   * here costs a few minutes and nothing else. It is also contained for the breaker's
   * sake: an error out of the create path counts against the guild. The service records an
   * access problem for a permission failure (Missing Access or Missing Permissions), and
   * anything else is only logged, with ids and never a name.
   *
   * Skipped while `room_access.disabled` is on, read through the gate's cached snapshot
   * (no query, failing open), and skipped for a creator who is denied Saved lists, whose
   * lists are inert. The creator's standing is the member's own
   * snapshot, which is truer than the cache while they are still moving into the room; a
   * snapshot that carries no roles says nothing about them, and the service falls back to
   * the cache and, failing that, to applying the lists.
   *
   * Cheap when there is nothing to do: a creator who has blocked nobody costs one indexed
   * read and no call to Discord (a trusted entry grants nothing in an open room, and a room
   * made private by default was planned from the lists already). Replay-safe: it is a
   * converge, so a second run writes nothing.
   */
  private async applySavedLists(
    guildId: string,
    roomId: string,
    member: VoiceMember,
    commandAccess: CommandAccess,
    saved: MemberAccessLists | undefined,
  ): Promise<void> {
    const apply = this.deps.applyAccessLists;
    if (!apply) return;
    try {
      // The real gate fails open itself; a gate that throws must not take the lists with it.
      const disabled = await this.deps.gate?.roomAccessDisabled?.().catch(() => false);
      if (disabled) return;
      const standing = standingOf(member);
      if (savedListsInert(commandAccess, standing)) return;
      const result = await apply(guildId, roomId, { id: member.id, standing, saved });
      if (result.status === 'failed') {
        this.deps.logger.warn(
          { err: result.error, guildId, roomId, creatorId: member.id },
          'could not apply the creator saved lists to a new room',
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, roomId, creatorId: member.id },
        'could not apply the creator saved lists to a new room',
      );
    }
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

    this.deps.countRoom?.('deleted', guildId);
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
   * longest-present remaining member. Keeps `@@owner@@` resolvable after the
   * owner leaves and re-points a private channel's "⇩ Join" companion at the
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
    const newOwnerName = displayName(await this.voiceSettings(guild.settings, guildId), newOwner);

    this.deps.logger.info(
      { guildId, secondaryId: channelId, from: leaverId, to: newOwner.id },
      'transferred ownership after owner left',
    );
    this.deps.serverLog?.(guildId, 2, `👑 <@${newOwner.id}> now owns <#${channelId}>`);
    // Re-point a private channel's "⇩ Join" companion (no-op if not private).
    await this.deps.onOwnerChanged?.(guildId, channelId, newOwner.id, newOwnerName);
  }

  /**
   * A handover that was not the owner leaving: `/transfer` and `/reclaim`.
   *
   * Re-points a private room's "⇩ Join" companion at the new owner, the same way
   * the leave path does through the same hook. Without it the join row keeps
   * naming the PREVIOUS owner, so only they can answer a knock and the new owner
   * is refused their own room's Approve button.
   *
   * It also says this was a handover (the leave path does not), which is what makes
   * the new owner's saved lists apply to the room: the repository has already moved
   * the room's creator, and the hook applies the lists that creator has.
   *
   * Never throws: the handover has already happened, and a failed rename of the
   * companion must not turn a successful `/transfer` into an error reply.
   */
  async repointJoinCompanion(
    guildId: string,
    channelId: string,
    newOwner: VoiceMember,
  ): Promise<void> {
    if (!this.deps.onOwnerChanged) return;
    try {
      const guild = await this.deps.guilds.ensure(guildId);
      const name = displayName(await this.voiceSettings(guild.settings, guildId), newOwner);
      await this.deps.onOwnerChanged(guildId, channelId, newOwner.id, name, { handover: true });
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, channelId, newOwnerId: newOwner.id },
        'could not re-point the join channel after a handover',
      );
    }
  }

  /**
   * A member's name as rooms show it: their `/nick` applied, unless a restriction on
   * Nickname now covers them. For a "⇩ Join {owner}" channel made by something other
   * than this class, which should name its owner the way every other site does and
   * not by the raw display name.
   */
  async nameFor(guildId: string, member: VoiceMember): Promise<string> {
    const guild = await this.deps.guilds.ensure(guildId);
    return displayName(await this.voiceSettings(guild.settings, guildId), member);
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
   * longest-present member its owner — so `@@owner@@` resolves once occupied.
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
    const settings = await this.voiceSettings(guild.settings, guildId);
    const members = this.deps.voice.membersInChannel(channelId);
    // An adopted standalone channel has no privacy model and no owning primary,
    // so `{{PRIVATE}}` is false and the numbering tokens keep rendering `?`.
    const renderCtx = this.buildRenderContext({
      channelId,
      settings,
      members,
      index: 0,
      ownerId: row.ownerId,
      seed: row.state.seed,
    });

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

    /**
     * A companion text channel somebody deleted by hand.
     *
     * Before the adopted branch because leaving the row behind is not harmless:
     * every later sync would write overwrites to a channel that no longer
     * exists, costing that guild a failed request on every voice event in the
     * room it used to belong to.
     */
    if (await this.deps.companionText?.handleChannelDeleted(guildId, channelId)) return;

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
    return `__${safe}/@@owner@@'s room__`;
  }

  /**
   * Adopts an otherwise-unmanaged voice channel so the bot manages its name. Seeds
   * the roster/owner from who's currently in it (so `@@owner@@` resolves right
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
    const settings = await this.voiceSettings(guild.settings, guildId);
    const members = this.deps.voice.membersInChannel(channelId);
    const renderCtx = this.buildRenderContext({
      channelId,
      settings,
      members,
      index: 0,
      ownerId: row.ownerId,
      seed: row.state.seed,
    });
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
  /**
   * The ONE place a {@link RenderContext} is assembled.
   *
   * It exists because there were eight hand-assembled ones and they had already
   * diverged: `userLimit` was passed on the create path and nowhere else, so
   * `@@party_size@@`'s fallback worked exactly once per channel and silently
   * degraded to `0` on every re-render afterwards. That is not "somebody forgot
   * an argument", it is "there are eight places to forget", so
   * `renderContextGuard.unit.test.ts` reads this file and fails if a new call
   * site hand-rolls one.
   *
   * The user limit is read LIVE rather than from `primary.template.limit`,
   * which is the configured default: `/limit` writes straight through to
   * Discord and stores nothing. An unknown limit reads as unlimited, so
   * `{{FULL}}` fails open and never claims a room is full on missing data.
   */
  /**
   * The clock, in one place and overridable.
   *
   * Injectable so an integration test can pin a Friday evening without waiting
   * for one, and a method rather than a bare `new Date()` at the call site so
   * every render in a single pass shares one instant.
   */
  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /**
   * The guild's voice settings as a RENDER should read them: with the
   * `/restrict` rules withdrawn while `command_access.disabled` is on.
   *
   * A saved nickname is the one restriction enforced at render time and not at a
   * guard, so this is where the lever has to reach it. Without it "enforcement is
   * paused" would be untrue for the one rule that changes what everybody reads in
   * a room name. Asked only when the guild has a rule at all, through the gate's
   * cached snapshot, so a server with none pays nothing. The gate never throws and
   * a failed flag read counts as not disabled, so the rules keep applying. Like
   * the lever everywhere else it freezes rather than strips: a room's name
   * catches up at its next re-render, in either direction.
   */
  private async voiceSettings(
    raw: Record<string, unknown>,
    guildId: string,
  ): Promise<VoiceSettings> {
    const settings = parseVoiceSettings(raw, guildId);
    if (Object.keys(settings.commandAccess).length === 0) return settings;
    if (!(await this.deps.gate?.commandAccessDisabled?.())) return settings;
    return { ...settings, commandAccess: {} };
  }

  buildRenderContext(input: RenderContextInput): RenderContext {
    const { settings, members, channelId } = input;
    const owner = input.ownerId ? members.find((m) => m.id === input.ownerId) : undefined;
    /**
     * The original creator's name: the cached one, else the live one if they
     * happen to be in the room, else nothing (the engine then falls back to the
     * current owner, and to `Unknown`).
     *
     * The live fallback is what stops a room that predates the cache costing an
     * extra rename: without it the first render after the upgrade names the
     * CURRENT owner, the backfill then stores the real name, and the next sweep
     * renames again to the right one. Two renames and a wrong name in between,
     * for a token justified on the grounds that it reduces churn.
     * The cache still wins when present, because
     * stability is the token's whole point.
     */
    const rawOriginalCreator =
      input.originalCreatorName ??
      (input.originalCreatorId
        ? members.find((m) => m.id === input.originalCreatorId)?.displayName
        : undefined);
    /**
     * What a restriction on Nickname needs to know about the original creator: their
     * roles and whether they can manage channels. From the room's snapshot while
     * they are in it, else from the cache, because they have usually left and a
     * rule naming their ROLE would otherwise never apply to them. Asked only when
     * a Nickname rule exists. Only a member the cache has also lost is unresolved,
     * and then only a rule naming the person applies (see `displayName`).
     */
    const creatorStanding =
      input.originalCreatorId && settings.commandAccess.nick !== undefined
        ? (members.find((m) => m.id === input.originalCreatorId) ??
          this.deps.voice.ownerAccessOf?.(channelId, input.originalCreatorId))
        : undefined;
    const originalCreatorName =
      rawOriginalCreator === undefined || !input.originalCreatorId
        ? rawOriginalCreator
        : displayName(settings, {
            id: input.originalCreatorId,
            displayName: rawOriginalCreator,
            roleIds: creatorStanding?.roleIds,
            canManage: creatorStanding?.canManage,
          });
    return {
      index: input.index,
      members,
      aliases: settings.aliases,
      general: settings.general,
      gameNameMode: settings.gameNameMode,
      userLimit: this.deps.voice.userLimitOf?.(channelId) ?? 0,
      isPrivate: input.isPrivate ?? false,
      isHidden: input.isHidden ?? false,
      // `startAt` is what the admin typed (the first room's number), so the
      // offset is one less. Absent means the default, 1.
      numberOffset: input.startAt === undefined ? 0 : input.startAt - 1,
      /**
       * The clock is read HERE and injected, because the engine is pure and
       * must stay so: it is imported by the marketing site's browser bundle and
       * by every unit test, both of which need a render to be reproducible.
       */
      now: this.now(),
      lists: settings.lists,
      ...(settings.timezone !== undefined ? { timezone: settings.timezone } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(owner ? { creatorName: displayName(settings, owner), creator: owner } : {}),
      /**
       * Resolved from the cache, then from the live member, and left unset
       * otherwise so the engine falls back to the current owner. A member fetch
       * is not an option here: the original creator has usually left, which is
       * the whole reason the name is cached at creation.
       */
      ...(originalCreatorName !== undefined ? { originalCreatorName } : {}),
    };
  }

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
    const settings = await this.voiceSettings(guild.settings, guildId);
    const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
    // Reconciliation may pass a freshly-computed sibling position to renumber
    // `##` tokens after a middle channel was deleted; otherwise use the stored one.
    const index = opts.index ?? secondary.state.index ?? 0;
    const renderCtx = this.buildRenderContext({
      channelId,
      settings,
      members,
      index,
      ownerId: secondary.ownerId,
      seed: secondary.state.seed,
      ...renderPrivacyOf(secondary),
      startAt: primary?.template.startAt,
      originalCreatorId: secondary.originalCreator,
      originalCreatorName: secondary.state.originalCreatorName,
    });

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

    /**
     * The control panel, brought back into step with the room.
     *
     * Here rather than in each of the six places that change a room, because
     * this method is already called from every one of them: `/limit`, `/name`,
     * `/transfer`, `/reclaim`, `/private`, `/public`, and the debounced
     * scheduler that fires after an owner leaves and ownership moves. It is
     * ABOVE the name/status early-return on purpose - the panel can change when
     * the name does not, which is most of the time.
     *
     * Free when nothing moved: the poster fingerprints the rendered payload and
     * returns without a request when it matches what was last drawn, so the
     * bulk sweeps that walk a whole guild cost a hash per room.
     *
     * Below the empty-room early return above, and deliberately: a room nobody
     * is in is about to be cleaned up, and editing the panel of a message that
     * is seconds from being deleted with its channel is work for nobody.
     *
     * **After the `updateState` below, in both paths, and that ordering is
     * load-bearing.** The panel keys live in the same `state` blob, the poster
     * writes them with a jsonb merge, and `updateState` REPLACES the column
     * with the snapshot read at the top of this method. Refreshing first
     * therefore wrote a fingerprint and then reverted it, so the next render
     * saw a mismatch and issued a second, byte-identical edit - the "an edit per
     * room on every sweep" outcome the fingerprint exists to prevent - and it
     * resurrected a message id the poster had just cleared, so a deleted panel
     * was retried for the life of the room.
     */
    const nameChanged = name !== secondary.state.name;
    const statusChanged = status !== (secondary.state.status ?? '');

    this.deps.logger.debug(
      { guildId, secondaryId: channelId, name, status, nameChanged, statusChanged },
      'rerenderSecondary evaluated',
    );

    if (!nameChanged && !statusChanged) {
      await this.refreshRoomPanel(guildId, secondary, primary?.channelId);
      return {};
    }
    // No panel write under a dry run, which must not touch anything.
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
    /**
     * Backfills the cached original-creator name, but ONLY on a write this
     * method was going to make anyway.
     *
     * Rooms that predate the cache have no name stored, and neither do rooms
     * whose key an older instance stripped before `passthrough` shipped. Both
     * self-heal the first time the room is renamed while its creator happens to
     * be present. Never a write of its own: a state write per render on every
     * room in the install base, to fix a token most guilds do not use, is not a
     * trade worth making.
     */
    const creatorPresent = secondary.originalCreator
      ? members.find((m) => m.id === secondary.originalCreator)
      : undefined;
    const backfill =
      secondary.state.originalCreatorName === undefined && creatorPresent
        ? { originalCreatorName: creatorPresent.displayName }
        : {};
    // Persist both even if only one changed (and even if a rename was deferred —
    // the queued rename will still apply).
    //
    // A merge of these keys, not the snapshot read at the top written back whole: the
    // rename above can sit rate limited for seconds, a `/private` or `/public` can
    // finalise in that time (`private` lives in `state`), and a whole write would
    // revert it. The detached re-renders after `/limit` and a lock are not queued
    // behind the transition they follow, so nothing else orders the two.
    await this.deps.secondaries.mergeState(channelId, { ...backfill, name, status, index });

    // Strictly after the write above: see the note on the other call site.
    await this.refreshRoomPanel(guildId, secondary, primary?.channelId);

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

  /**
   * {@link rerenderSecondary} for the sweep's renumbering, where a room the bot can no longer
   * edit costs that room and not the guild.
   *
   * The loops that call this have no other per-room catch, so a rename that threw ended the
   * guild's sweep at that room: the rooms after it were never renumbered and members whose
   * join event was missed never got a room, every five minutes. A room Discord shows only as
   * an obfuscated shell (the bot lost View of it, mandatory from 2026-11-16) stays in the
   * cache, so it reaches here and its rename throws `ChannelObfuscatedError`, which is a
   * permission error. That is recorded once, and the room is left alone for
   * {@link LOST_ACCESS_RETRY_MS}: asking again each sweep would repeat the incident, and the
   * retry after it is how a restored permission is noticed. Anything that is not a permission
   * error still throws, as it always did.
   */
  private async rerenderInSweep(
    guildId: string,
    channelId: string,
    opts: RerenderOptions,
  ): Promise<RerenderResult> {
    const gaveUp = this.unrenamable.get(channelId);
    if (gaveUp !== undefined && !opts.dryRun) {
      if (Date.now() - gaveUp.at < LOST_ACCESS_RETRY_MS) return {};
      this.unrenamable.delete(channelId);
    }
    try {
      const result = await this.rerenderSecondary(guildId, channelId, opts);
      // Asked again after the long wait and answered: the incident is over.
      if (gaveUp !== undefined && !opts.dryRun) {
        this.deps.permissionProblems?.clear(guildId, channelId, ['delete', 'rename']);
      }
      return result;
    } catch (err) {
      if (!isPermissionError(err)) throw err;
      this.giveUpRenaming(guildId, channelId, err);
      return {};
    }
  }

  /** Remembers a room the sweep could not rename, and tells the guild once. Ids only in the log. */
  private giveUpRenaming(guildId: string, channelId: string, err: unknown): void {
    this.unrenamable.set(channelId, { guildId, at: Date.now() });
    // A channel the bot can no longer see is lost access, recorded as the access pass does,
    // so a room both of them find is one incident.
    const operation = err instanceof ChannelObfuscatedError ? 'delete' : 'rename';
    const told = this.deps.permissionProblems
      ?.recent(guildId)
      .some((p) => p.channelId === channelId && p.operation === operation);
    if (told !== true) {
      this.deps.permissionProblems?.record(guildId, { channelId, operation, at: Date.now() });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId));
    }
    this.deps.logger.warn(
      { err: withoutRequestBody(err), guildId, channelId },
      'could not rename a room, leaving it alone for a while',
    );
  }

  /** Forgets the rooms of a guild that no longer exist, so the map holds only rooms still being left alone. */
  private forgetGoneRooms(guildId: string, survivors: readonly SecondaryChannelRow[]): void {
    if (this.unrenamable.size === 0) return;
    const live = new Set(survivors.map((s) => s.channelId));
    for (const [channelId, gaveUp] of this.unrenamable) {
      if (gaveUp.guildId === guildId && !live.has(channelId)) this.unrenamable.delete(channelId);
    }
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
   * stack the same way new rooms do. Returns how many were moved.
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
      // "asked for", not "did": `applyOrder` sends nothing when the category
      // already renders this way, and it is the common case now.
      'requested secondary reposition',
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
    // Concurrent, not sequential: `joinCompanionFor` is a Postgres read per room,
    // and this sits on the path a member waits on while their room is created (the
    // pre-create repair reaches it). Order comes from the index, never from which
    // lookup answers first.
    const companions = await Promise.all(
      orderedSecondaryIds.map((id) => this.deps.joinCompanionFor?.(id)),
    );
    const block: string[] = [];
    orderedSecondaryIds.forEach((id, i) => {
      const companion = companions[i];
      if (companion) block.push(companion);
      block.push(id);
    });
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
    const settings = await this.voiceSettings(guild.settings, guildId);
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
      renderedName = renderChannelName(
        effectiveTemplate,
        this.buildRenderContext({
          channelId,
          settings,
          members,
          index: secondary.state.index ?? 0,
          ownerId: secondary.ownerId,
          seed: secondary.state.seed,
          ...renderPrivacyOf(secondary),
          startAt: primary?.template.startAt,
          originalCreatorId: secondary.originalCreator,
          originalCreatorName: secondary.state.originalCreatorName,
        }),
      );
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
      // Resolved exactly as the render path does, mode and owner included, or
      // this reports a different game from the one the room is named after.
      computedGame: getGameName(members, {
        aliases: settings.aliases,
        general: settings.general,
        mode: settings.gameNameMode,
        ...(inGuild && secondary.ownerId ? { ownerId: secondary.ownerId } : {}),
      }),
      ...(renderedName !== undefined ? { renderedName } : {}),
      ...(inGuild && secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
    };
  }

  /**
   * Resolves everything `/channelinfo` reports for one voice channel.
   *
   * Related to {@link debugChannel} and deliberately separate from it. That one
   * is the dev dump and covers only rooms, so an adopted channel reads back as
   * `unmanaged`; this one answers all four kinds and returns the resolved
   * templates with their provenance rather than the raw state blob.
   *
   * It renders nothing. The {@link RenderContext} goes out intact so the panel
   * probes the real engine, which is the only way a token readout cannot drift
   * from what the channel is actually named.
   *
   * `savedCount` says whether to count the members with remembered settings, which costs a
   * read and which only the panel's admin section shows. It is the one thing here that is
   * not free for a viewer who will never see it, on the one command any member can run, so
   * the caller says false for them. It defaults to true, for a caller that cannot tell.
   */
  async channelInfo(
    guildId: string,
    channelId: string,
    opts: { savedCount?: boolean } = {},
  ): Promise<ChannelInfo> {
    const savedCount = opts.savedCount ?? true;
    const guild = await this.deps.guilds.ensure(guildId);
    const settings = await this.voiceSettings(guild.settings, guildId);
    const members = this.deps.voice.membersInChannel(channelId);
    const userLimit = this.deps.voice.userLimitOf?.(channelId) ?? 0;
    const secondary = await this.deps.secondaries.get(channelId);
    // Read before `base` purely so the game resolution can see the owner, who
    // breaks a tie. The four kinds below still each report their own ownership.
    const isRoom = secondary !== undefined && secondary.guildId === guildId;
    // `general` is the positional argument of `getChannelGames`, so it is
    // deliberately NOT in here: a second copy in the options would read as if
    // it could override the one beside it.
    const gameOptions = {
      aliases: settings.aliases,
      mode: settings.gameNameMode,
      ...(isRoom && secondary.ownerId ? { ownerId: secondary.ownerId } : {}),
    };
    const base = {
      channelId,
      ownerId: null as string | null,
      originalCreator: null as string | null,
      userLimit,
      isPrivate: false,
      accessMode: 'public' as RoomMode,
      members: { total: members.length, bots: members.filter((m) => m.bot).length },
      game: getGameName(members, { ...gameOptions, general: settings.general }),
      rawGames: getChannelGames(members, settings.general, gameOptions),
      general: settings.general,
      enabled: settings.enabled,
      aliasCount: Object.keys(settings.aliases).length,
    };

    if (isRoom) {
      const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
      const companion = (await this.deps.companionText?.describeRoom(guildId, channelId)) ?? null;
      // The row's own `access` cannot say whether a record was unreadable, so it is read as
      // one: a command anyone may run, and the one that has to tell a hidden room from a
      // locked one.
      const access = (await this.deps.secondaries.readAccess(channelId)) ?? {
        readable: true as const,
        access: secondary.access,
      };
      const viewerRoleId = access.readable ? access.access?.viewerRoleId : undefined;
      const accessMode = roomMode({ state: secondary.state, access });
      const renderCtx = this.buildRenderContext({
        channelId,
        settings,
        members,
        index: secondary.state.index ?? 0,
        ownerId: secondary.ownerId,
        seed: secondary.state.seed,
        // From the record as READ, so an unreadable one is not guessed at, and a hidden
        // room is private as well, exactly as the render itself treats it.
        isPrivate: secondary.state.private === true || accessMode === 'hidden',
        isHidden: accessMode === 'hidden',
        startAt: primary?.template.startAt,
        originalCreatorId: secondary.originalCreator,
        originalCreatorName: secondary.state.originalCreatorName,
      });
      return {
        ...base,
        kind: 'room',
        ownerId: secondary.ownerId,
        originalCreator: secondary.originalCreator,
        isPrivate: secondary.state.private === true || accessMode === 'hidden',
        accessMode,
        ...(viewerRoleId ? { viewerRoleId } : {}),
        render: {
          ctx: renderCtx,
          synthetic: false,
          nameTemplate:
            secondary.state.template ?? primary?.template.name ?? settings.channelNameTemplate,
          /**
           * `!== undefined`, matching the `??` above rather than truthiness.
           * An empty-string template is a real stored value the renderer will
           * use, so a truthy test would report it as inherited from a creator
           * channel whose template is not the one being rendered.
           */
          nameSource:
            secondary.state.template !== undefined
              ? 'channel'
              : primary?.template.name !== undefined
                ? 'creator'
                : 'server',
          statusTemplate:
            secondary.state.statusTemplate ??
            primary?.template.status ??
            settings.channelStatusTemplate,
          statusSource:
            secondary.state.statusTemplate !== undefined
              ? 'channel'
              : primary?.template.status !== undefined
                ? 'creator'
                : 'server',
        },
        ...(primary ? { primary: await this.primaryConfigOf(guildId, primary, savedCount) } : {}),
        ...(companion ? { companion } : {}),
        ...(secondary.state.seed !== undefined ? { seed: secondary.state.seed } : {}),
        ...(secondary.state.index !== undefined ? { index: secondary.state.index } : {}),
      };
    }

    const own = await this.deps.autoChannels.get(channelId);
    if (own && own.guildId === guildId) {
      /**
       * A creator channel has no room of its own, so there is nothing live to
       * render. Preview the FIRST room it would spawn, from an empty member
       * list at index 0, exactly as `getEditorState` does for the same reason.
       *
       * Hand-assembled rather than routed through `buildRenderContext`, and
       * that is the point of `synthetic: true`: the assembler reads the LIVE
       * channel, so it would report whoever is standing in the creator channel
       * right now, and its user limit, as if they belonged to a room that does
       * not exist. `renderContextGuard.unit.test.ts` exempts the same shape in
       * `getEditorState`, under the name `previewCtx`.
       */
      const startMode = startModeOf(own.template);
      const previewCtx: RenderContext = {
        index: 0,
        members: [],
        aliases: settings.aliases,
        general: settings.general,
        gameNameMode: settings.gameNameMode,
        numberOffset: own.template.startAt === undefined ? 0 : own.template.startAt - 1,
        // The first room is born in the creator channel's own mode, so `{{PRIVATE}}` and
        // `{{HIDDEN}}` preview as the room will name itself. The readout beside it says how
        // new rooms start, and a probe that said "no" under it would contradict it.
        isPrivate: startMode !== 'public',
        isHidden: startMode === 'hidden',
      };
      return {
        ...base,
        kind: 'creator',
        render: {
          ctx: previewCtx,
          synthetic: true,
          nameTemplate: own.template.name ?? settings.channelNameTemplate,
          nameSource: own.template.name !== undefined ? 'creator' : 'server',
          statusTemplate: own.template.status ?? settings.channelStatusTemplate,
          statusSource: own.template.status !== undefined ? 'creator' : 'server',
        },
        primary: await this.primaryConfigOf(guildId, own, savedCount),
      };
    }

    const managed = await this.deps.managed?.get(channelId);
    if (managed && managed.guildId === guildId) {
      const renderCtx = this.buildRenderContext({
        channelId,
        settings,
        members,
        index: 0,
        ownerId: managed.ownerId,
        seed: managed.state.seed,
      });
      return {
        ...base,
        kind: 'managed',
        ownerId: managed.ownerId,
        render: {
          ctx: renderCtx,
          synthetic: false,
          // An adopted channel has no inherited default: its templates are
          // whatever `/template` wrote, and an empty one means "leave it alone".
          nameTemplate: managed.template.name ?? '',
          nameSource: 'managed',
          statusTemplate: managed.template.status ?? '',
          statusSource: 'managed',
        },
        ...(managed.state.seed !== undefined ? { seed: managed.state.seed } : {}),
      };
    }

    return { ...base, kind: 'unmanaged' };
  }

  /**
   * Re-renders one room's control panel if it has drifted from the room.
   *
   * Never throws: it hangs off work that has already succeeded, and a panel one
   * edit behind is not worth failing a rename or a command over, let alone
   * counting against the guild's circuit breaker.
   */
  private async refreshRoomPanel(
    guildId: string,
    secondary: SecondaryChannelRow,
    primaryChannelId?: string,
  ): Promise<void> {
    if (!this.deps.controlPanel) return;
    try {
      /**
       * The lever stops EDITS as well as posts, so it can actually shed the
       * load its doc comment claims. Safe to do because it self-heals: the
       * stored fingerprint still holds whatever was last drawn, so the first
       * re-render after the lever is lifted sees a mismatch and catches every
       * frozen panel up in one edit each. A briefly stale panel is what load
       * shedding is; a permanently stale one would not be.
       */
      if (await this.deps.gate?.controlPanelDisabled?.()) return;
      const isHidden = await this.panelHidden(secondary);
      await this.deps.controlPanel.refreshForRoom(guildId, secondary.channelId, secondary, {
        ownerId: secondary.ownerId,
        primaryChannelId: primaryChannelId ?? secondary.primaryChannelId,
        // A hidden room is a locked one, whatever a stale whole-state write did to `private`.
        isPrivate: secondary.state.private === true || isHidden === true,
        isHidden,
        userLimit: this.deps.voice.userLimitOf?.(secondary.channelId) ?? 0,
        ownerAccess: this.panelOwnerAccess(secondary.channelId, secondary.ownerId),
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, secondaryId: secondary.channelId },
        'could not refresh the room control panel',
      );
    }
  }

  /**
   * Whether a room is hidden, for the panel's Hide control: `unknown` when its access
   * record cannot be read, which leaves the control off rather than guess.
   *
   * The row's own `access` is null both for no record and for one this build cannot
   * read, so it cannot say on its own. A row that has a record is readable and answers
   * for itself. One without is read only when the room is locked, which is the only
   * state an unreadable record changes anything for: a public room with an unreadable
   * record is offered Hide, which is refused with an explanation, and that is the
   * price of not reading a second row on every panel refresh for every public room. A
   * read that throws is left to the caller, which skips this refresh and tries again.
   */
  private async panelHidden(row: SecondaryChannelRow): Promise<boolean | 'unknown'> {
    if (row.access !== null) return row.access.hidden === true;
    if (row.state.private !== true) return false;
    const read = await this.deps.secondaries.readAccess(row.channelId);
    if (!read) return false;
    const mode = roomMode({ state: row.state, access: read });
    return mode === 'unknown' ? 'unknown' : mode === 'hidden';
  }

  /**
   * The room owner's raw standing under `/restrict`, for the panel's view.
   *
   * Raw, not a verdict, so the poster applies the rules in one place for the
   * create-time post and every re-render, and the two cannot diverge. `unknown`
   * when the view cannot say (a cold cache, or no accessor wired): the panel
   * hides nothing for an owner it cannot resolve. Absent for an ownerless room,
   * which the panel judges by its own rule.
   */
  private panelOwnerAccess(
    channelId: string,
    ownerId: string | null,
  ): PanelOwnerAccess | undefined {
    if (ownerId === null) return undefined;
    try {
      return this.deps.voice.ownerAccessOf?.(channelId, ownerId) ?? 'unknown';
    } catch (err) {
      // On the create path this sits in an argument after the room exists, outside
      // any catch, so a throw would fail a create that already succeeded. Failing
      // open is the same answer as a cold cache: hide nothing.
      this.deps.logger.warn(
        { err, secondaryId: channelId },
        'could not resolve the room owner for the control panel',
      );
      return 'unknown';
    }
  }

  /**
   * Re-renders every live panel in a guild, for a `/controlpanel` change.
   *
   * The one caller is an admin toggling a button, and the promise the reply
   * makes is that the rooms already open are updated too. Bounded by the
   * guild's live room count, and each one is fingerprinted, so the rooms whose
   * panel did not actually change cost nothing.
   *
   * Sequential rather than concurrent: this is a background fan-out behind an
   * already-sent reply, nobody is waiting on it, and a guild with thirty rooms
   * firing thirty simultaneous edits is how a bot finds a rate limit it did not
   * know it had.
   */
  async refreshGuildPanels(guildId: string): Promise<{ considered: number }> {
    if (!this.deps.controlPanel) return { considered: 0 };
    const rows = await this.deps.secondaries.listByGuild(guildId);
    // Only the rows that have a panel are work, and the count says so: an admin
    // reading the log should not see a guild's whole room list reported as
    // panels considered.
    const withPanels = rows.filter((r) => r.state.controlPanelMessageId);
    for (const row of withPanels) {
      await this.refreshRoomPanel(guildId, row);
    }
    return { considered: withPanels.length };
  }

  /**
   * The room behind a control panel button, or null when there is not one.
   *
   * One row read plus two cache lookups, deliberately light: this runs on the
   * path to `showModal`, which is itself the interaction's acknowledgement, so
   * it cannot be deferred and has the whole three-second budget to fit inside.
   * That is also why the caller does NOT route it through the per-guild queue,
   * where it would sit behind every create and rename in flight.
   */
  async getRoomPanelState(guildId: string, channelId: string): Promise<RoomPanelState | null> {
    const row = await this.deps.secondaries.get(channelId);
    if (!row || row.guildId !== guildId) return null;
    return {
      ownerId: row.ownerId,
      members: this.deps.voice.membersInChannel(channelId),
      userLimit: this.deps.voice.userLimitOf?.(channelId) ?? 0,
      ...(row.state.template === undefined ? {} : { nameOverride: row.state.template }),
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
    const settings = await this.voiceSettings(guild.settings, guildId);
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
      //
      // `numberOffset` carries `/position`'s `startAt`, so a guild numbering
      // from 4 previews `#4` here as well as in `/channelinfo`. Without it this
      // panel said `#1` for a first room that will be called `#4`, and the two
      // surfaces disagreed about the same channel.
      //
      // And in the mode that room is born in, so a `{{HIDDEN ?? ...}}` name previews as the
      // room will be named and not as an open one.
      const startMode = startModeOf(own.template);
      const previewCtx = {
        index: 0,
        members: [],
        aliases: settings.aliases,
        general: settings.general,
        gameNameMode: settings.gameNameMode,
        numberOffset: own.template.startAt === undefined ? 0 : own.template.startAt - 1,
        isPrivate: startMode !== 'public',
        isHidden: startMode === 'hidden',
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
        ...(await this.rememberedState(guildId, own)),
      };
    }
    const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
    const members = this.deps.voice.membersInChannel(channelId);
    const renderCtx = this.buildRenderContext({
      channelId,
      settings,
      members,
      index: secondary.state.index ?? 0,
      ownerId: secondary.ownerId,
      seed: secondary.state.seed,
      ...renderPrivacyOf(secondary),
      startAt: primary?.template.startAt,
      originalCreatorId: secondary.originalCreator,
      originalCreatorName: secondary.state.originalCreatorName,
    });

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
      // The same creator channel's own switch, on the one editor scope that has buttons for it.
      ...(scope === 'primary' && primary ? await this.rememberedState(guildId, primary) : {}),
    };
  }

  /**
   * What a creator channel's editor shows about remembered room settings: whether it remembers,
   * and how many members have something saved.
   *
   * The count is read whether or not it remembers (see {@link EditorState.savedSettings}), at
   * the cost of one indexed count each time an admin opens or edits the panel.
   */
  private async rememberedState(
    guildId: string,
    primary: AutoChannelRow,
  ): Promise<Pick<EditorState, 'rememberPrefs' | 'savedSettings' | 'rememberPaused'>> {
    const savedSettings = await this.savedSettingsOf(guildId, primary.channelId);
    const remembers = primary.template.rememberPrefs === true;
    return {
      rememberPrefs: remembers,
      ...(savedSettings === undefined ? {} : { savedSettings }),
      // Asked only of a creator channel that remembers, and a cached read at that.
      ...(remembers && (await this.memberPrefsPaused()) ? { rememberPaused: true } : {}),
    };
  }

  /**
   * How many members have something saved for one creator channel, or `undefined` when this
   * feature has no way to count or the count could not be read.
   *
   * Fails OPEN: a number on an admin's panel is not worth the panel, so a read error is logged
   * by id and the count is left out, which the panel shows as no count and never as nobody.
   */
  private async savedSettingsOf(
    guildId: string,
    primaryChannelId: string,
  ): Promise<number | undefined> {
    if (!this.deps.memberPrefs) return undefined;
    try {
      return await this.deps.memberPrefs.countByPrimary(guildId, primaryChannelId);
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, channelId: primaryChannelId },
        'could not count remembered room settings',
      );
      return undefined;
    }
  }

  /**
   * A creator channel's own configuration for `/channelinfo`, with the count of members who
   * have something saved, and whether remembering is switched off for now, when it remembers
   * and the viewer will see it. Neither is paid for a creator channel that does not remember,
   * nor for a viewer who is not an admin.
   */
  private async primaryConfigOf(
    guildId: string,
    row: AutoChannelRow,
    countSaved: boolean,
  ): Promise<PrimaryConfig> {
    const config = primaryConfig(row);
    if (config.rememberPrefs !== true || !countSaved) return config;
    const savedSettings = await this.savedSettingsOf(guildId, row.channelId);
    return {
      ...config,
      ...(savedSettings === undefined ? {} : { savedSettings }),
      ...((await this.memberPrefsPaused()) ? { rememberPaused: true } : {}),
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
   * - a surviving secondary whose saved lists or hidden state drifted → bring its
   *   overwrites and Join channel back in line (see `roomAccess`);
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

    /**
     * Saved lists and hidden rooms: converge each live room's overwrites and Join channel
     * on what its creator's lists and its own access record say.
     *
     * Here, ahead of the renumber pass, because a hidden room is the one thing in this
     * sweep that is a privacy fault when it is wrong, so it must not wait behind a rename
     * that throws (the loops below have no per-room catch, and one 50013 aborts everything
     * after it). It does not have to run first for the name's sake: the render reads a
     * hidden room's privacy from its record, not from the `private` flag this pass repairs.
     * Skipped under a dry run, which reports and never acts.
     * Everything behind it is contained inside, per room, so nothing here can abort the
     * passes that follow, and `room_access.disabled` turns it off.
     */
    if (this.deps.roomAccess && !dryRun) {
      try {
        await this.deps.roomAccess.convergeGuild(guildId, survivors);
      } catch (err) {
        this.deps.logger.warn({ err, guildId }, 'room access pass failed; continuing the sweep');
      }
    }

    // Second pass: renumber survivors so `##` compacts after a deletion and a
    // number is never duplicated within its scope. A **grouped** category numbers
    // across ALL its primaries as one block; ungrouped primaries number
    // independently (the legacy per-primary `check_rename`).
    this.forgetGoneRooms(guildId, survivors);
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
        const { name } = await this.rerenderInSweep(guildId, rows[i]!.channelId, {
          dryRun,
          index: i,
        });
        if (name !== undefined) drift.renamed.push({ channelId: rows[i]!.channelId, to: name });
      }
    }
    for (const [categoryKey, rows] of groupedByCategory) {
      rows.sort(byCreated);
      for (let i = 0; i < rows.length; i++) {
        const { name } = await this.rerenderInSweep(guildId, rows[i]!.channelId, {
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

    /**
     * Companion text channels, in all three directions: create the ones an
     * opted-in room is missing (nothing else ever retries a create that 429'd),
     * converge each existing one's viewers on who is actually in the room, and
     * remove the ones whose room is gone.
     *
     * Runs after the catch-up pass so rooms created a moment ago are included.
     * The creation half asks the gate's own lever rather than `allowCreate`,
     * which would also spend a slot of the guild's creation throttle on a
     * repair. A gate with no such method means not disabled.
     */
    if (this.deps.companionText) {
      const disabled = (await this.deps.gate?.companionTextDisabled?.()) ?? false;
      await this.deps.companionText.reconcileGuild(guildId, {
        allowCreate: !disabled,
        dryRun,
      });
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
