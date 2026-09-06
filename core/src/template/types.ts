/**
 * The render inputs the channel-name engine consumes, deliberately decoupled
 * from discord.js.
 *
 * These live in `core` rather than in the bot because the marketing site's live
 * demos render real templates through the same engine
 * (`plans/name-tokens.md` §4.1). The bot re-exports them from
 * `bot/src/features/voice/types.ts`, which keeps the rest of the voice feature
 * importing from where it always did.
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
