/**
 * Plain domain types for the voice feature, deliberately decoupled from
 * discord.js so the pipeline can be exercised with a fake REST/action recorder
 * and an in-memory voice view in tests.
 */

/**
 * `MemberActivity` and `VoiceMember` are the engine's render inputs, so they
 * moved to `@avc/core/template` with it and are
 * re-exported here. Everything below this line is bot-only: it depends on a
 * live discord.js cache, which `core` deliberately knows nothing about.
 */
export type { MemberActivity } from '@avc/core/template';

import type { VoiceMember as TemplateVoiceMember } from '@avc/core/template';
import type { CommandCaller } from './commandAccess.js';

/**
 * The engine's member, plus the one fact about them the bot needs and the engine
 * must not know: whether `/restrict` can apply to them.
 *
 * Declared here and not in `core`, which would put a moderation concept into the
 * template engine's input that the marketing site's demos then have to carry.
 */
export interface VoiceMember extends TemplateVoiceMember {
  /**
   * Manage Channels or Administrator in the guild, which no restriction can stop.
   * Absent reads as false: a snapshot that was not built from a live member
   * cannot show they are exempt, so a rule that names them applies.
   */
  canManage?: boolean;
}

export interface VoiceChannelView {
  id: string;
  name: string;
  /** Current members in the channel (includes bots). */
  members: VoiceMember[];
}

/** What {@link GuildVoiceView.memberFacts} says of a member. */
export interface MemberFacts {
  bot: boolean;
  /** Holds Administrator, which bypasses every overwrite. */
  administrator: boolean;
  /** Owns the server, which bypasses every overwrite and cannot be removed from it. */
  guildOwner: boolean;
}

/** What {@link GuildVoiceView.botPermissionsIn} says of the bot's standing in a channel. */
export interface BotChannelPermissions {
  /**
   * Whether the bot can edit the channel's permission overwrites (Manage Roles, which
   * Discord calls Manage Permissions at channel level), as the cache resolves it.
   */
  manageRoles: boolean;
}

/** What {@link GuildVoiceView.botRoleAccess} says of a set of roles. */
export interface BotRoleAccess {
  /** The bot's own managed role, whose overwrite is left exactly as it is, or null. */
  leaveRoleId: string | null;
  /** The roles, of those asked about, that the bot cannot edit an overwrite for. */
  uneditableRoleIds: string[];
}

/**
 * Read-only view of a guild's live voice state. Backed by discord.js voice-state
 * cache in production, and by an in-memory model in tests.
 */
export interface GuildVoiceView {
  /** The members currently in a voice channel, or `[]` if unknown/empty. */
  membersInChannel(channelId: string): VoiceMember[];
  /**
   * Whether the channel still exists in Discord. Reconciliation needs to tell an
   * *empty* channel (delete it) apart from a *vanished* one (just drop the stale
   * DB record) — both yield `[]` from {@link membersInChannel}.
   */
  channelExists(channelId: string): boolean;
  /**
   * The channel's parent **category** id, or `null` when it sits at the server
   * root, or `undefined` when the channel/category isn't known. Optional so the
   * many test fakes (and any caller without a live cache) keep compiling; absent
   * → callers treat the category as unknown and fall back to per-primary behavior
   * (no grouping). Used by the `/group` feature to scope a category's channels.
   */
  categoryOf?(channelId: string): string | null | undefined;
  /**
   * Those of `channelIds` this instance can see, in the order Discord renders
   * them (position, then id). `undefined` when none of them are knowable.
   *
   * Optional like {@link categoryOf}, and read the same way: absent, or
   * `undefined`, means "cannot say", which callers must treat as "leave it
   * alone" rather than as "it is wrong". The only caller repairs channel order
   * with a bulk reorder, and reordering a guild's channels on a guess is far
   * worse than leaving them as they are.
   */
  displayOrderOf?(channelIds: string[]): string[] | undefined;
  /**
   * A primary's live bitrate/region/video-quality/age-restriction, for a
   * spawned secondary to copy. Optional like {@link categoryOf}: `undefined`
   * means "cannot say" (e.g. a cold cache), which a caller must treat as
   * "leave these properties unset on the new channel" rather than guessing at
   * a value.
   */
  voicePropertiesOf?(channelId: string): VoiceChannelProperties | undefined;
  /**
   * The channel's LIVE user limit (0 = unlimited), for `@@limit@@`,
   * `@@slots@@`, `{{FULL}}` and `@@party_size@@`'s fallback. `undefined` when
   * the channel is not known, read the same way as {@link categoryOf}: "cannot
   * say", which callers treat as unlimited so a room is never wrongly reported
   * as full.
   *
   * The stored `primary.template.limit` is the configured DEFAULT, not this:
   * `/limit` writes straight through to Discord and stores nothing, so only a
   * live read tells the truth.
   */
  userLimitOf?(channelId: string): number | undefined;
  /**
   * Who a room's owner is for `/restrict`: their id, their role ids without
   * `@everyone`, and whether they can manage channels. `undefined` when it cannot
   * be said (the room or the member is not in the cache).
   *
   * Optional and read like {@link userLimitOf}: absent or `undefined` means
   * "cannot say", which the panel treats as "do not hide anything" and not as
   * "nothing is restricted". `channelId` is the room, and is only how the guild is
   * found. A cache read, so it is cheap enough for every panel re-render.
   */
  ownerAccessOf?(channelId: string, ownerId: string): CommandCaller | undefined;
  /**
   * What a member is, for the lists that must not apply to some of them: a bot, an
   * Administrator, the server's owner. `undefined` when the member is not in the
   * cache, which a caller reads as "cannot say" and so does not skip them.
   *
   * Optional and read like {@link ownerAccessOf}. A cache read, so it is cheap
   * enough to ask once per listed member on every apply. Administrators and the
   * server owner bypass every channel overwrite, so a deny written for one does
   * nothing and moving them out of a room would be wrong. A member can BECOME an
   * Administrator after they were listed, which is why this is asked at apply time
   * and not only when somebody is added to a list.
   */
  memberFacts?(guildId: string, memberId: string): MemberFacts | undefined;
  /**
   * What the bot's own role position means for a set of roles: which of them it
   * cannot edit an overwrite for, and which is its own managed role. `undefined`
   * when the guild or the bot's member is not in the cache.
   *
   * Optional and read like {@link memberFacts}. Writing an overwrite for a role
   * above the bot's top role is assumed to fail, and one failure refuses a whole
   * bulk write, so the planner is told up front and refuses a hide such a role
   * would defeat. Unverified against Discord: see `uneditableRoleIds` in
   * `accessPlan.ts`.
   */
  botRoleAccess?(guildId: string, roleIds: readonly string[]): BotRoleAccess | undefined;
  /**
   * What the bot itself may do in a channel, from the cache: today only whether it can
   * edit the channel's overwrites. `undefined` when the channel or the bot's own member
   * is not cached, which a caller reads as "cannot say" and so goes ahead.
   *
   * Optional and read like {@link memberFacts}. A refusal here is a preflight and not
   * the authority (Discord is), so it is asked only before a change that would
   * otherwise delete something before a write that was bound to fail, and it is never
   * asked before an undo: a stale cache must not be able to stop somebody opening a room.
   */
  botPermissionsIn?(channelId: string): BotChannelPermissions | undefined;
  /**
   * Whether Discord has actually given us this guild's data, i.e. whether
   * {@link channelExists} means anything for it.
   *
   * **Required, not optional, unlike `categoryOf`.** Reconcile deletes records
   * for channels `channelExists` reports gone, and for a guild we hold no data
   * for that is every channel. A permissive default on a delete guard is the
   * wrong default, and there are only two implementers, so the interface can
   * insist.
   *
   * The state this exists for is routine, not exotic: `READY` stubs every guild
   * into the cache as unavailable, and `WebSocketShard.checkReady` marks the
   * shard ready once `waitGuildTimeout` (15s) expires even with guilds still
   * outstanding. The boot reconcile then walks the whole cache. `ownsGuild`
   * cannot rule those out, because shard ownership is arithmetic and says
   * nothing about hydration.
   */
  guildAvailable(guildId: string): boolean;
}

/**
 * A primary channel's own Discord-set properties, read live so a spawned
 * secondary can copy them the way the legacy bot always did. `rtcRegion` and
 * `videoQualityMode` are `null` when the primary has no explicit override
 * (Discord's "Automatic" / "Auto"), which callers should treat the same as
 * "leave it unset" rather than copying the null itself.
 */
export interface VoiceChannelProperties {
  bitrate: number;
  rtcRegion: string | null;
  /** 1 = Auto, 2 = Full (720p) — mirrors discord.js's `VideoQualityMode`. */
  videoQualityMode: 1 | 2 | null;
  nsfw: boolean;
}

/** A normalized voice-state transition (a member moved between channels). */
export interface VoiceStateEvent {
  guildId: string;
  member: VoiceMember;
  /** Channel the member was in before (undefined if they just connected). */
  beforeChannelId?: string;
  /** Channel the member is in after (undefined if they disconnected). */
  afterChannelId?: string;
}
