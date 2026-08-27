/**
 * Plain domain types for the voice feature, deliberately decoupled from
 * discord.js so the pipeline can be exercised with a fake REST/action recorder
 * and an in-memory voice view in tests.
 */

/**
 * A single presence activity, carrying the rich-presence fields the richer name
 * templates consume (party size/state/details, stream title). Mirrors the
 * discord.js `Activity` shape but decoupled from it for testing.
 */
export interface MemberActivity {
  /** Mapped from discord.js ActivityType: Playing / Streaming / everything else. */
  kind: 'playing' | 'streaming' | 'other';
  name: string;
  state?: string;
  details?: string;
  /** Rich-presence party: `size` is `[current, max]`. */
  party?: { id?: string; size?: [number, number] };
}

export interface VoiceMember {
  id: string;
  displayName: string;
  bot: boolean;
  /** Names of "playing" activities (presence), for game-name templating. */
  playing: string[];
  /** Full presence activities (party/stream/details), for the rich tokens. */
  activities?: MemberActivity[];
  /** The member's role ids, for the `{{ROLE:id ?? …}}` conditional. */
  roleIds?: string[];
  /** Whether the member is screen-sharing in voice (Discord "Go Live"). */
  selfStreaming?: boolean;
}

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

/** A normalized voice-state transition (a member moved between channels). */
export interface VoiceStateEvent {
  guildId: string;
  member: VoiceMember;
  /** Channel the member was in before (undefined if they just connected). */
  beforeChannelId?: string;
  /** Channel the member is in after (undefined if they disconnected). */
  afterChannelId?: string;
}
