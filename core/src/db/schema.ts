import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Allowed guild auth statuses, inlined here because this file is also the
 * drizzle-kit migration entrypoint (its bundler can't resolve cross-file `.js`
 * imports). MUST stay in sync with `AUTH_STATUSES` in `domain/auth.ts`; a unit
 * test (`schema.unit.test.ts`) asserts they match.
 */
const AUTH_STATUSES = ['trial', 'active', 'expired', 'blocked'] as const;

/**
 * Drizzle schema. Postgres is the source of truth.
 *
 * Conventions:
 * - Discord snowflake ids are stored as `text` to avoid JS bigint precision
 *   loss and to keep them opaque.
 * - All timestamps are `timestamptz` with DB-side defaults.
 * - Per-guild data is keyed by `guild_id`; a corrupt row quarantines to its
 *   guild without affecting others.
 *
 * Migrations follow strict expand/contract discipline (see AGENTS.md): add
 * columns/tables first; drop only in a later release once nothing references them.
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** Per-guild settings + auth state. Settings cache is invalidated via NOTIFY. */
export const guilds = pgTable('guilds', {
  guildId: text('guild_id').primaryKey(),
  authStatus: text('auth_status', { enum: AUTH_STATUSES }).notNull().default('trial'),
  /** When the current trial/subscription window ends (drives time-based transitions). */
  authExpiresAt: timestamp('auth_expires_at', { withTimezone: true }),
  /** Arbitrary per-guild settings, mirroring the old per-guild JSON shape. */
  settings: jsonb('settings')
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Free-form metadata (support notes, flags, etc.). */
  metadata: jsonb('metadata')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Append-only audit log of guild auth-state transitions. */
export const guildAuthEvents = pgTable(
  'guild_auth_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    fromStatus: text('from_status', { enum: AUTH_STATUSES }),
    toStatus: text('to_status', { enum: AUTH_STATUSES }).notNull(),
    reason: text('reason'),
    /** Actor that caused the transition (e.g. 'system', 'agent', a user id). */
    actor: text('actor'),
    createdAt: createdAt(),
  },
  (t) => [index('guild_auth_events_guild_idx').on(t.guildId, t.createdAt)],
);

/** Primary / creator channels: joining one spawns a secondary. */
export const autoChannels = pgTable(
  'auto_channels',
  {
    channelId: text('channel_id').primaryKey(),
    guildId: text('guild_id').notNull(),
    /** Template config for spawned secondaries (name template, limits, etc.). */
    template: jsonb('template')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auto_channels_guild_idx').on(t.guildId)],
);

/** Bot-managed temporary voice channels, tracked for reconciliation. */
export const secondaryChannels = pgTable(
  'secondary_channels',
  {
    channelId: text('channel_id').primaryKey(),
    guildId: text('guild_id').notNull(),
    /** The primary/auto channel that spawned this secondary. */
    primaryChannelId: text('primary_channel_id').notNull(),
    /** Current owner (the member who controls this channel). */
    ownerId: text('owner_id'),
    /** Lifecycle / reconciliation state. */
    state: jsonb('state')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('secondary_channels_guild_idx').on(t.guildId),
    index('secondary_channels_primary_idx').on(t.primaryChannelId),
  ],
);

/**
 * "⇩ Join {creator}" companion channels for private secondaries. Joining one
 * raises a join request to the private channel's owner. One row per private
 * secondary; deleted when the channel goes public or is cleaned up.
 */
export const joinChannels = pgTable(
  'join_channels',
  {
    channelId: text('channel_id').primaryKey(),
    guildId: text('guild_id').notNull(),
    /** The private secondary this join channel fronts (and where requests are posted). */
    secondaryChannelId: text('secondary_channel_id').notNull(),
    /** The private channel's owner, who approves/denies requests. */
    creatorId: text('creator_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('join_channels_secondary_idx').on(t.secondaryChannelId)],
);

/** Per-guild game-name aliases. */
export const aliases = pgTable(
  'aliases',
  {
    guildId: text('guild_id').notNull(),
    /** The detected game/activity name. */
    gameName: text('game_name').notNull(),
    /** The alias to display instead. */
    alias: text('alias').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.gameName] })],
);

// ---------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------

/** Shard ownership leases. A heartbeated row grants an instance a shard. */
export const shardLeases = pgTable(
  'shard_leases',
  {
    shardId: integer('shard_id').primaryKey(),
    /** Total shard count this lease was claimed under. */
    totalShards: integer('total_shards').notNull(),
    /** The instance currently holding the lease (null = unclaimed). */
    instanceId: text('instance_id'),
    /** Last heartbeat; an expired heartbeat lets another instance re-claim. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [index('shard_leases_instance_idx').on(t.instanceId)],
);

/** DB-backed feature flags / kill-switches togglable without a deploy. */
export const runtimeFlags = pgTable('runtime_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
});

/** Append-only log of operational actions (flag changes, forced reconciles, blocks). */
export const opsAudit = pgTable(
  'ops_audit',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Who performed the action: 'agent', 'system', or a human identifier. */
    actor: text('actor').notNull(),
    /** What action was taken (e.g. 'flag.set', 'guild.block', 'reconcile.force'). */
    action: text('action').notNull(),
    /** Optional target (e.g. a guild id or flag key). */
    target: text('target'),
    /** Why, and any structured details. */
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('ops_audit_created_idx').on(t.createdAt)],
);
