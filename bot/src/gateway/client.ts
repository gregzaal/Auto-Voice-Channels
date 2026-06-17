import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Options,
  Partials,
  type ClientOptions,
} from 'discord.js';

/**
 * The bot's resting presence — a custom status (no "Playing" prefix) pointing
 * first-time users at the `/setup` entry point and the website. Applied at
 * identify on every shard via {@link ClientOptions.presence}. For
 * {@link ActivityType.Custom}, Discord renders the activity's `state`; `name`
 * is required on the activity object, so we set both to the same text.
 */
const SETUP_STATUS = 'dotsbots.com · /setup';

export interface GatewayOptions {
  /** Total shard count; shard ids are derived per Discord's formula. */
  totalShards: number;
  /** Specific shard ids this instance owns (from the lease manager). */
  shardIds: number[];
  /**
   * Cluster-wide identify throttler factory (see {@link PgIdentifyThrottler}).
   * Wired into `@discordjs/ws` so identifies are serialized across instances and
   * respect Discord's `max_concurrency`. Omitted → discord.js's per-process default.
   */
  buildIdentifyThrottler?: NonNullable<ClientOptions['ws']>['buildIdentifyThrottler'];
}

/**
 * Builds a discord.js client tuned for "DB is the source of truth": caches are
 * aggressively disabled/limited, and only the intents we need are requested.
 *
 * Presence is handled *lazily* (rewrite.md decision 12): we keep no presence
 * *event* bookkeeping of our own and only act when a member in a tracked voice
 * channel changes activity (debounced). We do retain discord.js's presence and
 * guild-member caches, because the game-name template reads each in-channel
 * member's current activity from `member.presence` at render time — disabling
 * that cache would blind game detection. The heavy caches we don't need
 * (messages/reactions/users/threads) are dropped below.
 */
export function buildGatewayClient(options: GatewayOptions): Client {
  const clientOptions: ClientOptions = {
    shards: options.shardIds,
    shardCount: options.totalShards,
    presence: {
      status: 'online',
      activities: [{ type: ActivityType.Custom, name: SETUP_STATUS, state: SETUP_STATUS }],
    },
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
    ],
    // We act on raw events; we don't rely on partial-driven caches but enable
    // the partials we might touch so events aren't silently dropped.
    //
    // `Partials.User` is REQUIRED here: discord.js's PRESENCE_UPDATE handler
    // resolves `data.user` from the user cache, and a presence payload only
    // carries `{ id }` (no username). With the user cache disabled (UserManager:
    // 0), that lookup misses; without Partials.User the handler bails early and
    // never updates `guild.presences` — so presence/game detection freezes at the
    // value loaded in GUILD_CREATE. Partials.User lets it construct a transient
    // user and proceed, with no global user-cache memory cost.
    partials: [Partials.Channel, Partials.GuildMember, Partials.User],
    // Minimal caches: keep guilds/channels/voice states, guild members (needed
    // to resolve voice-channel membership) and presences (needed for the
    // game-name template — `member.presence` is only available from cache). Drop
    // the rest; the DB is authoritative.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
      UserManager: 0,
      ThreadManager: 0,
    }),
    sweepers: Options.DefaultSweeperSettings,
    ...(options.buildIdentifyThrottler
      ? { ws: { buildIdentifyThrottler: options.buildIdentifyThrottler } }
      : {}),
  };
  return new Client(clientOptions);
}
