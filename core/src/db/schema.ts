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
const AUTH_STATUSES = ['trial', 'active', 'grace', 'expired', 'blocked'] as const;

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
  /** When the current grace window ends (the leniency ladder; null = not in grace). */
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  /** Latest member-count sample (a hint, never ground truth — see monetization.md §5). */
  memberCount: integer('member_count'),
  memberCountUpdatedAt: timestamp('member_count_updated_at', { withTimezone: true }),
  /**
   * Billed tier cache (what the guild's subscription covers), for the dashboard
   * and the over-limit check. The *required* tier is always re-derived from the
   * member count via `tierFor()` — never stored.
   */
  tier: text('tier'),
  /** Arbitrary per-guild settings, mirroring the old per-guild JSON shape. */
  settings: jsonb('settings')
    .notNull()
    .default(sql`'{}'::jsonb`),
  /** Free-form metadata (support notes, billing samples/notifications, flags, etc.). */
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
 * Standalone voice channels AVC manages the *name* of, adopted via `/template`
 * on an otherwise-unmanaged channel. Unlike secondaries these are persistent:
 * they are never created or deleted by the bot, only renamed between an "empty"
 * and "occupied" form as members come and go. One row per adopted channel,
 * removed when the channel vanishes or management is turned off.
 */
export const managedChannels = pgTable(
  'managed_channels',
  {
    channelId: text('channel_id').primaryKey(),
    guildId: text('guild_id').notNull(),
    /** Current occupant-owner (longest-present), for `@@creator@@`. Null when empty. */
    ownerId: text('owner_id'),
    /** Name/status templates configured for this channel (the `/template` editor). */
    template: jsonb('template')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Last-rendered name/status, random seed, and arrival roster (change detection). */
    state: jsonb('state')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('managed_channels_guild_idx').on(t.guildId)],
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
// Billing (monetization.md §7). Self-hosted deployments run these migrations
// too but never populate the tables (SELF_HOSTED bypasses entitlement).
// ---------------------------------------------------------------------------

/** Billing source of truth per guild, synced from Paddle webhooks. */
export const subscriptions = pgTable('subscriptions', {
  guildId: text('guild_id').primaryKey(),
  paddleSubscriptionId: text('paddle_subscription_id').notNull().unique(),
  paddleCustomerId: text('paddle_customer_id').notNull(),
  /** The tier this subscription pays for (`s`/`m`/`l`/`xl`/`xxl`). */
  tier: text('tier').notNull(),
  /** Paddle subscription status (e.g. active, past_due, canceled). */
  status: text('status').notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  /** Unit price as reported by Paddle (minor units string, e.g. '1900'). */
  price: text('price'),
  currency: text('currency'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Append-only Paddle webhook log; the unique event id makes processing idempotent. */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Paddle's event id — UNIQUE, so a redelivered webhook is a no-op. */
    paddleEventId: text('paddle_event_id').notNull().unique(),
    eventType: text('event_type').notNull(),
    guildId: text('guild_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('billing_events_guild_idx').on(t.guildId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Web auth (Auth.js Drizzle-adapter tables for auto-voice.io). Column TS
// property names must match what @auth/drizzle-adapter expects; SQL names
// follow the repo's snake_case convention.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  image: text('image'),
});

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
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

/**
 * Per-bucket identify spacing. Discord requires identifies within a
 * `max_concurrency` bucket (`shardId % max_concurrency`) to be spaced apart; this
 * row records the last identify time per bucket so the identify throttler can
 * serialize them cluster-wide (checked under the identify advisory lock).
 */
export const identifyBuckets = pgTable('identify_buckets', {
  bucket: integer('bucket').primaryKey(),
  lastIdentifyAt: timestamp('last_identify_at', { withTimezone: true }),
  updatedAt: updatedAt(),
});

/**
 * Durable last-run bookkeeping for cluster-singleton background jobs (e.g. the
 * billing/trial reconcile job). Checked/updated under a per-job advisory lock —
 * the same pattern as `identify_buckets` — so exactly one instance runs a job
 * per spacing window.
 */
export const billingRuns = pgTable('billing_runs', {
  /** Job key (e.g. 'billing.advance'). */
  job: text('job').primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  /** Instance that ran it last (diagnostics). */
  lastRunBy: text('last_run_by'),
  updatedAt: updatedAt(),
});

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
