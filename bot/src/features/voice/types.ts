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
export type { MemberActivity, VoiceMember } from '@avc/core/template';

import type { VoiceMember } from '@avc/core/template';

export interface VoiceChannelView {
  id: string;
  name: string;
  /** Current members in the channel (includes bots). */
  members: VoiceMember[];
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
