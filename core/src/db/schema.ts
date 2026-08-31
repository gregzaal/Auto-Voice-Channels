import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Allowed guild auth statuses, inlined here because this file is also the
 * drizzle-kit migration entrypoint (its bundler can't resolve cross-file `.js`
 * imports). MUST stay in sync with `AUTH_STATUSES` in `domain/auth.ts`; a unit
 * test (`schema.unit.test.ts`) asserts they match.
 */
const AUTH_STATUSES = ['trial', 'active', 'grace', 'expired', 'blocked'] as const;

/**
 * Hosted fleets, inlined for the same reason as {@link AUTH_STATUSES}. MUST stay
 * in sync with `FLEETS` in `domain/fleets.ts`; `schema.unit.test.ts` asserts it.
 *
 * Every fleet-scoped column below defaults to `'prod'`, which is what makes this
 * migration additive: rows written before fleets existed, and every row a
 * self-host will ever write, are production rows.
 */
const FLEETS = ['prod', 'beta'] as const;

/** A fleet-scoping column. See `plans/fleets.md` §2 for what gets one and why. */
const fleet = () => text('fleet', { enum: FLEETS }).notNull().default('prod');

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
  /**
   * When the bot was last removed from this guild (null = it is in the guild).
   * Set by the `guildDelete` handler and cleared on re-add.
   *
   * Rows are never deleted on removal: a guild can still be covered by a live
   * subscription, and the dashboard has to keep showing it.
   *
   * **Nothing reads this column, and nothing new should.** It is a per-fleet
   * fact wearing a shared one: a single boolean written by whichever fleet's
   * bot acted, so two fleets race over it. Ask `guild_fleet_presence` whether
   * ANY fleet is present instead.
   */
  botRemovedAt: timestamp('bot_removed_at', { withTimezone: true }),
  /**
   * Guild display name, icon hash and owner, denormalized from `GUILD_CREATE`/
   * `GUILD_UPDATE`. Nothing else in this schema can name a guild across users:
   * the dashboard only resolves names from the signed-in user's own OAuth
   * token, and `subscriptions.guild_name` exists only for guilds that paid.
   *
   * A hint, not ground truth (same standing as `member_count`). Goes stale
   * once the bot is removed, which is correct: it becomes the last name that
   * will ever exist for that guild.
   */
  name: text('name'),
  /** Icon hash only; the CDN URL is derived, so a CDN move is not a migration. */
  iconHash: text('icon_hash'),
  ownerId: text('owner_id'),
  /** Latest member-count sample (a hint, never ground truth — see monetization.md §5). */
  memberCount: integer('member_count'),
  memberCountUpdatedAt: timestamp('member_count_updated_at', { withTimezone: true }),
  /**
   * Billed tier cache: what the subscription covering this guild pays for,
   * whether that subscription is keyed to this guild or to its pool. For the
   * dashboard and the over-limit check. The *required* tier is always
   * re-derived from the member count via `tierFor()` — never stored.
   *
   * Not cleared when a subscription lapses, deliberately: every use of it in
   * the leniency machine is gated on the subscription being healthy, and
   * keeping it is what lets the bot name the plan that ended.
   */
  tier: text('tier'),
  /**
   * The member pool this guild bills through, or null for a legacy guild-keyed
   * subscription (promoted into a pool on the first server added to it) or a
   * guild with no subscription at all
   * (`plans/member-based-pricing.md` §6.1). Denormalized pointer: the
   * durable record with history is `member_pool_guilds`, and this column is
   * what the reconciler and the entitlement gate read without a join. The two
   * are written together, in the same statement, by every add/remove path.
   */
  poolId: text('pool_id'),
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

/**
 * Which fleets are present in a guild, and since when (`plans/fleets.md` §6.1).
 *
 * `guilds.bot_removed_at` is a per-fleet fact wearing a shared column: with two
 * live bots, "the bot was removed" has to name which one. This table answers it,
 * and answers a question the column never could — a guild can be running beta
 * with prod absent, which is a healthy state, not a missing bot.
 *
 * **Read presence across ALL fleets before telling a customer anything.** The
 * dashboard's question is "is any fleet here"; only the badge cares which. Asking
 * per fleet is how you tell a subscribed customer happily using beta that they
 * are paying for a server AVC is not in.
 */
export const guildFleetPresence = pgTable(
  'guild_fleet_presence',
  {
    guildId: text('guild_id').notNull(),
    fleet: fleet(),
    /** First time this fleet saw the guild. Never updated after insert. */
    firstSeenAt: createdAt(),
    /** When this fleet was removed (null = present). Cleared on re-add. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.fleet] }),
    // "which guilds is this fleet in", for reconcile and the operator console.
    index('guild_fleet_presence_fleet_idx').on(t.fleet, t.removedAt),
  ],
);

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
    /**
     * The `guilds.auth_expires_at` pair either side of the transition.
     *
     * `transitionAuth` overwrites that column in place and this log recorded
     * only the statuses, so a wrong write DESTROYED a trial deadline with no
     * record anywhere and the only recovery was a backup restore, at up to a
     * 24-hour RPO (`plans/refunds.md` §7.6). That matters most for exactly the
     * change that reads the column to decide entitlement.
     *
     * Both nullable: a null is a real value here (a guild with no deadline), so
     * these cannot be distinguished from "not recorded" on rows written before
     * the columns existed. Read them as evidence when present, never as proof
     * of absence.
     */
    fromExpiresAt: timestamp('from_expires_at', { withTimezone: true }),
    toExpiresAt: timestamp('to_expires_at', { withTimezone: true }),
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
    fleet: fleet(),
    /** Template config for spawned secondaries (name template, limits, etc.). */
    template: jsonb('template')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('auto_channels_guild_idx').on(t.fleet, t.guildId)],
);

/** Bot-managed temporary voice channels, tracked for reconciliation. */
export const secondaryChannels = pgTable(
  'secondary_channels',
  {
    channelId: text('channel_id').primaryKey(),
    guildId: text('guild_id').notNull(),
    fleet: fleet(),
    /** The primary/auto channel that spawned this secondary. */
    primaryChannelId: text('primary_channel_id').notNull(),
    /** Current owner (the member who controls this channel). */
    ownerId: text('owner_id'),
    /**
     * The member with a durable claim on this channel: whoever created it, or
     * whoever last took it over via `/transfer` or `/reclaim`. Unlike {@link ownerId}
     * — which auto-reassigns to a caretaker each time the owner leaves — this only
     * changes on a deliberate handover, so the original creator can `/reclaim` the
     * channel back from a caretaker even while the caretaker is still present.
     */
    originalCreator: text('original_creator'),
    /** Lifecycle / reconciliation state. */
    state: jsonb('state')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('secondary_channels_guild_idx').on(t.fleet, t.guildId),
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
    fleet: fleet(),
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
  (t) => [index('managed_channels_guild_idx').on(t.fleet, t.guildId)],
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
    fleet: fleet(),
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

/**
 * A member pool: one subscription covering any number of servers whose member
 * counts sum to under the band ceiling (`plans/member-based-pricing.md` §6.1).
 *
 * **`status` is `active | grace | expired`, and NEVER `trial`** (§5.4). A pool
 * comes into existence by completing checkout, so it always starts `active`;
 * giving it its own trial would let a guild launder an expired or mid-trial
 * state back to a full year by joining one.
 *
 * `billed_tier` is written only by the Paddle webhook and is what the
 * subscription pays for. The *required* tier is always re-derived from
 * `member_count` (a hint, refreshed by the reconciler's pool sampler) and is
 * never stored here, for the same reason `guilds.tier` is never conflated with
 * `tierFor()` (§5.1).
 */
export const memberPools = pgTable(
  'member_pools',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Auth.js `users.id` (a UUID), NOT a Discord snowflake. Who pays. */
    ownerUserId: text('owner_user_id').notNull(),
    /**
     * Optional, defaulted, editable (`plans/member-based-pricing.md` §6.1).
     * Never read by any backend rule; it exists only so an owner with more
     * than one pool can tell them apart. Defaulted at creation to
     * "Server pool N" and never renumbered afterward.
     */
    name: text('name'),
    billedTier: text('billed_tier'),
    status: text('status', { enum: ['active', 'grace', 'expired'] })
      .notNull()
      .default('active'),
    graceUntil: timestamp('grace_until', { withTimezone: true }),
    /** Last observed pooled member-count sum (a hint, never ground truth). */
    memberCount: integer('member_count'),
    memberCountUpdatedAt: timestamp('member_count_updated_at', { withTimezone: true }),
    /**
     * The pool's OWN daily samples and notification dedupe map, in the exact
     * shape `domain/billing.ts`'s `BillingMeta` already validates
     * (`{ billing: { samples, notifications, pendingAnomaly? } }`) — reused
     * rather than re-invented, so the forward-only sampler and anti-flap
     * counters are the same tested code as the per-guild path (§5.2a). Reset
     * (samples cleared, notifications kept) on every membership change, so an
     * add or a remove can never fabricate history for a breach/drop the pool
     * did not actually sustain.
     */
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('member_pools_owner_idx').on(t.ownerUserId)],
);

/**
 * Pool membership, with history. The durable record; `guilds.pool_id` is the
 * denormalized pointer the hot paths read instead of joining here.
 *
 * The partial unique index is the load-bearing constraint: at most one LIVE
 * pool per guild, enforced by the database rather than by application code
 * racing a check-then-insert. A guild may appear in many historical rows
 * (added, removed, re-added, possibly to a different pool) but never in two
 * live ones at once.
 */
export const memberPoolGuilds = pgTable(
  'member_pool_guilds',
  {
    poolId: text('pool_id').notNull(),
    guildId: text('guild_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.poolId, t.guildId] }),
    uniqueIndex('member_pool_guilds_live_guild_idx')
      .on(t.guildId)
      .where(sql`removed_at is null`),
    index('member_pool_guilds_pool_idx').on(t.poolId, t.removedAt),
  ],
);

/**
 * Billing source of truth, synced from Paddle webhooks. One row per Paddle
 * subscription, covering either one guild or one member pool (never both,
 * never neither, enforced by `subscriptions_guild_xor_pool` below).
 *
 * `id` is the primary key (`plans/member-based-pricing.md` §6.2, phase 2 —
 * the contract half of a two-release expand/contract: phase 1, migration
 * 0024, added `id` and `pool_id` while `guild_id` was still the primary key).
 * A pool subscription belongs to no single guild, so `guild_id` cannot stay
 * the identity column once pool rows exist: the rejected alternative was a
 * synthetic `guild_id` like `pool:<id>`, which leaks a dangling row into
 * every `subscriptions -> guilds` join in `/admin` (§6.2).
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    /**
     * `$defaultFn` alone is not enough: `subscriptions` is the one pool-schema
     * table an OLD (pre-pool) binary can still write to during a rolling
     * deploy, and its INSERT omits `id` from the column list entirely. The
     * SQL-level `.default()` below saves that write from a NOT NULL violation.
     * `member_pools`/`users` don't need it: no pre-existing binary ever wrote
     * to those tables without knowing their schema (migration 0029).
     */
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$defaultFn(() => crypto.randomUUID()),
    /**
     * Null for a pool subscription. Plain (non-partial) unique: Postgres does
     * not enforce uniqueness among NULLs in a standard unique index, so this
     * already allows any number of pool-only rows while still keying at most
     * one live subscription per guild, and it works with the ordinary
     * `ON CONFLICT (guild_id)` upsert form `SubscriptionRepository.upsert`
     * already uses.
     */
    guildId: text('guild_id').unique(),
    /** Null for a guild subscription. Same plain-unique reasoning as above. */
    poolId: text('pool_id').unique(),
    paddleSubscriptionId: text('paddle_subscription_id').notNull().unique(),
    paddleCustomerId: text('paddle_customer_id').notNull(),
    /**
     * The Auth.js user id (our `users.id`, a UUID) of whoever completed
     * checkout, captured from the transaction's custom data. NOT a Discord
     * snowflake: it is `session.user.id`, which is what the dashboard compares
     * against, so matching it to a Discord id will silently never match.
     *
     * Without it, a subscription is only reachable through the guild, so someone
     * who leaves the server (or loses Manage Server) can no longer see or cancel
     * a subscription they are still being charged for. Nullable because
     * subscriptions created before this column existed have no purchaser.
     */
    purchaserUserId: text('purchaser_user_id'),
    /**
     * Server name at checkout time, denormalized from the transaction's custom
     * data. Only used to render a subscription for a guild the viewer can no
     * longer see (they left it), where there is no Discord guild object and no
     * name anywhere else in our schema. A stale name beats a bare snowflake id.
     */
    guildName: text('guild_name'),
    /** The tier this subscription pays for (`s`/`m`/`l`/`xl`/`xxl`). */
    tier: text('tier').notNull(),
    /** Paddle subscription status (e.g. active, past_due, canceled). */
    status: text('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /**
     * Paddle's pending `scheduled_change`, if any: `cancel`, `pause` or `resume`.
     *
     * Load-bearing, and easy to miss. A subscription the customer has cancelled
     * keeps `status: 'active'` right up to the end of the paid period, and the
     * cancellation lives ONLY here. Reading status alone reports a cancelled
     * subscription as renewing, which is both wrong and alarming to whoever just
     * cancelled it.
     */
    scheduledChangeAction: text('scheduled_change_action'),
    /** When that scheduled change takes effect. */
    scheduledChangeAt: timestamp('scheduled_change_at', { withTimezone: true }),
    /**
     * The **list** unit price from the subscription item (minor units, e.g.
     * '5900'). NOT what the customer pays: regional bands are applied per
     * country via `unit_price_overrides`, and the subscription event only ever
     * carries the baseline. A band-B customer on the M tier has `price = 5900`
     * here and is charged 3900.
     */
    price: text('price'),
    currency: text('currency'),
    /**
     * What the customer was actually charged, from `transaction.completed`
     * (minor units, tax-inclusive). Null until the first transaction lands, and
     * for subscriptions created before this column existed.
     *
     * The subscription event genuinely cannot supply this, so it has to come
     * from the transaction. Without it, every report and support answer for a
     * discounted region is wrong by the size of the discount.
     */
    chargedTotal: text('charged_total'),
    /** Tax included within `chargedTotal` (prices are tax-inclusive). */
    chargedTax: text('charged_tax'),
    chargedCurrency: text('charged_currency'),
    /**
     * ISO 3166-1 alpha-2 country the customer is billed in, resolved from the
     * transaction's `address_id` at `transaction.completed`.
     *
     * **The band cannot be recovered from the amount** - this column is what
     * makes regional revenue reportable at all:
     *   1. Two USD cells collide exactly (USD 8 at S, USD 27 at M), each
     *      meaning either "band C standard" or "band B legacy", and every
     *      USD-denominated banded country (50 of 108) sits behind them.
     *   2. A country with no override is AUTO-CONVERTED by Paddle, so its
     *      amount is not in our table at any rounding (e.g. Iceland/Romania
     *      pay EUR 50.50 at M against our own EUR 49.00 override, and it
     *      moves with the rate).
     *   3. A band is a policy view of a country: storing the country lets
     *      re-cutting the bands re-derive history correctly, where storing
     *      the band would freeze today's policy into every past row.
     *
     * Null for rows written before this column existed and for a failed
     * address lookup. Both are backfillable from `billing_events.payload`,
     * which keeps `address_id` forever. See `scripts/backfill-billing-origin.ts`.
     */
    billingCountryCode: text('billing_country_code'),
    /**
     * The Paddle price id actually charged, from the transaction's line item.
     *
     * Free (it is already in the payload) and it is what distinguishes a legacy
     * purchase from a standard one: the two carry different price ids, tagged
     * `custom_data.avc_legacy`. `legacy_customers.redeemed_at` cannot answer this
     * -- it is keyed by Discord user, not by subscription, so it says the
     * purchaser was ELIGIBLE, never that this particular subscription was sold at
     * the discount.
     */
    billedPriceId: text('billed_price_id'),
    /**
     * Latest refund/credit adjustment on this subscription, from `adjustment.*`
     * webhooks: `pending_approval`, `approved` or `rejected`.
     *
     * An **approved** refund revokes entitlement immediately, via
     * `subscriptionInGoodStanding`. A refund does not cancel the Paddle
     * subscription, so without reading this field the reconcile job would see a
     * healthy `active` row an hour later and reactivate the guild.
     *
     * `pending_approval` changes nothing: Paddle is still reviewing it, and
     * cutting someone off while their request is judged would punish them for
     * asking.
     */
    /**
     * Which of Paddle's seven adjustment ACTIONS the row's refund fields
     * describe: `refund`, `chargeback`, `credit`, and so on.
     *
     * Needed because these columns are no longer refund-only. Before
     * `classifyAdjustment` they were, since anything that was not a refund was
     * dropped before it reached the store. Now a chargeback is recorded here
     * too, and without this every surface reading `refund_status = 'approved'`
     * would tell a customer their money had been refunded when their bank had
     * reversed the charge instead.
     *
     * Null on rows written before this existed, and those are all refunds, so a
     * null reads as `refund`.
     */
    refundAction: text('refund_action'),
    refundStatus: text('refund_status'),
    /**
     * The transaction id that bought the CURRENT period, from
     * `transaction.completed`.
     *
     * Exists so a refund can be tested against the term it actually paid for.
     * Paddle's `type: 'full'` describes a TRANSACTION, not the paid term, so
     * without this a goodwill refund of month one's charge on an annual
     * subscription reads as a full refund and gates a customer who is eight
     * months paid up. That was found by review of `plans/refunds.md` §7.1.
     */
    chargedTransactionId: text('charged_transaction_id'),
    /**
     * When the current period was actually paid for, from the transaction's own
     * timestamp rather than from when we happened to receive the webhook.
     *
     * The refund window is measured from a payment, and nothing here recorded
     * one: `refund_at` is the receipt time of a REFUND, `created_at` is when we
     * first wrote the row, and `current_period_end` is a year out. So no surface
     * could tell a customer whether their 14 days were still open, which is the
     * one fact they need at the moment they are looking for it.
     */
    chargedAt: timestamp('charged_at', { withTimezone: true }),
    /**
     * The FIRST charge on this subscription, set once and never overwritten.
     *
     * `charged_at` moves to each renewal, so it cannot answer "is this still the
     * first charge", and the self-serve refund cap has to: `/refunds` §2 scopes
     * the no-questions guarantee to a first subscription, and §11 notes the cap
     * must test the first CHARGE or a renewal reopens the window every year.
     *
     * Comparing it against `charged_at` for equality is that test, and it is
     * exact and idempotent, unlike a counter that a redelivered
     * `transaction.completed` would double.
     */
    firstChargedAt: timestamp('first_charged_at', { withTimezone: true }),
    /**
     * When the purchaser asked for a refund through the SELF-SERVE button.
     *
     * The cap is claimed by writing this in the same statement that tests it,
     * because `refund_status` is written by the webhook seconds to minutes later:
     * two requests 200ms apart would both read it as null and both pass. Modelled
     * on `AiUsageRepository.reserveBuild`, which is the same shape.
     *
     * Never a reason to refuse the SUPPORT route. The cap governs the convenience
     * path only: a statutory withdrawal right is not declinable for abuse, so
     * anything past the cap goes to a human rather than being refused.
     */
    refundRequestedAt: timestamp('refund_requested_at', { withTimezone: true }),
    /** Refunded amount (minor units) for that adjustment. */
    refundTotal: text('refund_total'),
    /**
     * When WE received the adjustment, not when Paddle stamped it.
     *
     * Load-bearing distinction, and the reason `refund_updated_at` exists
     * beside it: `recordRefund` writes `refund.at ?? new Date()` and no caller
     * passes `at`, so this is always receipt wall-clock. Two customer-facing
     * surfaces render it as the refund date. It cannot double as the ordering
     * guard's input, because a receipt time is always LATER than the
     * adjustment's own timestamp, so the guard would judge every incoming event
     * stale and freeze the status it was meant to protect.
     */
    refundAt: timestamp('refund_at', { withTimezone: true }),
    /**
     * The adjustment's own `updated_at`, from Paddle. The ordering guard's
     * input: an incoming adjustment is applied only when its timestamp is at or
     * after what we hold, so a redelivered `created` cannot regress an
     * `approved` (`plans/refunds.md` §2.6, §7.2).
     */
    refundUpdatedAt: timestamp('refund_updated_at', { withTimezone: true }),
    /**
     * Set when a FULL, APPROVED refund of the transaction that bought the
     * CURRENT period arrives. **The authority for "access is revoked"**, read
     * first by `subscriptionInGoodStanding`.
     *
     * All three qualifiers matter. `full` comes from Paddle's own label, never
     * from comparing amounts. `approved` excludes a request still being judged.
     * And the transaction test is what stops a goodwill refund of an old charge
     * gating a customer who is fully paid up: `type: 'full'` describes a
     * transaction, not the paid term.
     *
     * Cleared when the ordering guard admits a `rejected` or `reversed` status
     * for the adjustment named in `refund_adjustment_id`. Without that, a
     * reversal, which is Paddle giving us the money back, would leave the
     * servers gated and the supporter badge revoked forever.
     */
    refundSettledAt: timestamp('refund_settled_at', { withTimezone: true }),
    /** Which adjustment set `refund_settled_at`, so the clearing rule can match it. */
    refundAdjustmentId: text('refund_adjustment_id'),
    /**
     * Which adjustment we have already asked Paddle to cancel for.
     *
     * The webhook's own idempotency gate is not enough for an outbound call:
     * `markProcessed` is its LAST statement, so any throw between the refund
     * write and it returns 500, Paddle retries with a fresh signature, the gate
     * does not fire, and the cancellation is scheduled twice. The harm is a
     * duplicate cancellation email to a customer we just refunded.
     *
     * Claimed by a conditional UPDATE before the call, so a failed attempt is
     * NOT retried: one attempt, and a failure is surfaced on the operator queue
     * and the customer's card rather than repeated at a live payment provider.
     */
    cancelRequestedAdjustmentId: text('cancel_requested_adjustment_id'),
    /** The adjustment's own currency, which is not necessarily the charge's. */
    refundCurrency: text('refund_currency'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Exactly one of guild_id / pool_id, never both, never neither
    // (`plans/member-based-pricing.md` §6.2). `num_nonnulls` is the concise
    // Postgres builtin for "count how many of these are not null".
    check('subscriptions_guild_xor_pool', sql`num_nonnulls(${t.guildId}, ${t.poolId}) = 1`),
  ],
);

/** Append-only Paddle webhook log; the unique event id makes processing idempotent. */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Paddle's event id — UNIQUE, so a redelivered webhook is a no-op. */
    paddleEventId: text('paddle_event_id').notNull().unique(),
    eventType: text('event_type').notNull(),
    /**
     * Null for a pool event, which is now the ordinary case: pooling is the
     * default billing unit, so a pool checkout's custom data carries `pool_id`
     * and no `guild_id` at all. `pool_id` below is what answers "what happened
     * to this customer's billing" for those, and the two are read together.
     */
    guildId: text('guild_id'),
    /**
     * The pool an event concerns, for the events `guild_id` cannot describe.
     *
     * Not a foreign key and deliberately unvalidated: this table is an
     * append-only archive of what Paddle said, and an event referring to a
     * pool row that was never written (a webhook arriving before its own
     * checkout committed, a pool later deleted) is exactly the case worth
     * keeping rather than rejecting. Backfillable from `payload`, which holds
     * the verbatim wire body forever — see `scripts/backfill-billing-pool.ts`.
     */
    poolId: text('pool_id'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('billing_events_guild_idx').on(t.guildId, t.createdAt),
    index('billing_events_pool_idx').on(t.poolId, t.createdAt),
  ],
);

/**
 * Operational alerts, as rows: a persisted row first, delivery a renderer
 * over it (`plans/agentic_management.md`). Before this table, alerting was
 * fire-and-forget into a Discord channel, so a delivery failure was
 * indistinguishable from quiet and every dedupe was in-process memory a
 * restart re-armed.
 *
 * Shape copied from `billing_notifications`, including the part that matters
 * most: the unique index is PARTIAL, on unresolved rows only. A total
 * constraint on `(fleet, key, target)` would let the first occurrence of a
 * repeating condition silence every later one forever.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /**
     * Which fleet the condition was observed on. Plain text, not the FLEETS
     * enum, for the same reason `metrics_hourly.fleet` is: the out-of-process
     * checker raises alerts that are about the cluster rather than about a bot,
     * and needs a value (`shared`) that is not a fleet.
     */
    fleet: text('fleet').notNull().default('prod'),
    /** Stable slug for the CONDITION: `db.ping`, `reconcile.failed`. */
    key: text('key').notNull(),
    /**
     * What the condition is about, when that narrows it: a guild id, a shard
     * id, a metric name. Empty string when the condition is fleet-wide, rather
     * than null, so it can sit in a unique index without null semantics.
     */
    target: text('target').notNull().default(''),
    /**
     * Who should see it. The two populations only partly overlap: shard-lease
     * health is meaningless to a self-hoster and a permission failure is
     * theirs alone to fix.
     */
    audience: text('audience', { enum: ['hosted', 'self_host', 'both'] })
      .notNull()
      .default('hosted'),
    severity: text('severity', { enum: ['info', 'warn', 'critical'] })
      .notNull()
      .default('warn'),
    message: text('message').notNull(),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped each time the condition is seen again while still open. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    occurrences: integer('occurrences').notNull().default(1),
    /**
     * Set when the condition stops being true. An alert that resolves itself is
     * still worth keeping: "this flapped nine times last week" is a different
     * and more useful fact than nine unrelated rows.
     */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /**
     * Claim lease for the retry loop, exactly as `billing_notifications` uses
     * it. `FOR UPDATE ... SKIP LOCKED` is not sufficient on its own: the row
     * lock dies with the claiming transaction and the Discord post deliberately
     * happens after the commit, so the lock only separates *simultaneous*
     * claims. This is what stops two instances a second apart both sending.
     */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    /**
     * Partial, on open rows only. See the note above: a total constraint would
     * mean a condition that recurs after being resolved could never open again.
     */
    uniqueIndex('alerts_open_key')
      .on(t.fleet, t.key, t.target)
      .where(sql`resolved_at IS NULL`),
    index('alerts_undelivered_idx')
      .on(t.openedAt)
      .where(sql`delivered_at IS NULL`),
    /**
     * What the retry loop actually claims over.
     *
     * `alerts_undelivered_idx` above is not it: nothing set `delivered_at`
     * until the delivery loop existed, so that partial index covered 100% of
     * the table and was worth nothing. This one also excludes resolved rows,
     * which is the difference between "still true and nobody has been told"
     * and "was true once".
     */
    index('alerts_claimable_idx')
      .on(t.fleet, t.openedAt)
      .where(sql`delivered_at IS NULL AND resolved_at IS NULL`),
    index('alerts_recent_idx').on(t.openedAt),
  ],
);

/**
 * Billing notifications waiting to be delivered (`plans/fleets.md` §4).
 *
 * **Exists because advancing the ladder and delivering its message are done
 * by different bots.** Advancement is fleet-wide work on shared rows, so
 * exactly one instance across the cluster does it (`BILLING_ADVISORY_LOCK`,
 * deliberately not fleet-scoped); delivery needs a bot actually in the guild,
 * which the lock winner may not be. Without the split, a guild transitioned
 * by a fleet that cannot see it would never be told anything.
 *
 * Rows are the *intent* to notify. The dedupe stamp that stops the ladder
 * re-deciding lives in `guilds.metadata.billing.notifications` and is written
 * only once delivery actually lands, so an undelivered row keeps being
 * re-derived by every advance pass - which is why enqueue must be idempotent,
 * not merely cheap.
 */
export const billingNotifications = pgTable(
  'billing_notifications',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /**
     * Null for a pool-billing notification (`pool_id` set instead) — payment
     * failed / over limit / renewal, addressed to the purchaser rather than a
     * server (`plans/member-based-pricing.md` §6.6). Every notification still
     * carries exactly one of the two: a hard-gate or reactivation notice is
     * fanned out as one ordinary guild-scoped row per affected member, same as
     * it always was, with `pool_id` stamped alongside for traceability.
     */
    guildId: text('guild_id'),
    /** The pool this notification is about, when it is not guild-scoped. */
    poolId: text('pool_id'),
    /** The leniency dedupe key (e.g. `trial_warning:7:m`). Repeats over time. */
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    /** The whole `LeniencyNotification`, so delivery needs no re-derivation. */
    notification: jsonb('notification')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Member count as the advance pass saw it, carried rather than re-read.
     *
     * The message quotes a tier that was chosen from this number. Re-reading it
     * at delivery time would let the two disagree, and a notice that names a
     * tier the count no longer implies is worse than a slightly stale one.
     */
    memberCount: integer('member_count').notNull().default(0),
    /**
     * Named `enqueued_at`, not the schema-wide `created_at`.
     *
     * The drain's claim is a raw CTE (the `FOR UPDATE ... SKIP LOCKED` form
     * has no builder equivalent), so the SQL column name is written out by
     * hand and a property/column mismatch here is a runtime error nothing
     * typechecks.
     */
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When this stops being worth sending.
     *
     * A trial-ending warning delivered three weeks late is not a late warning,
     * it is a wrong one. Expiry is what keeps a guild no fleet can reach from
     * accumulating a backlog that would all arrive at once if a bot were ever
     * re-added.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Which fleet delivered it. Diagnostics only; nothing branches on it. */
    deliveredByFleet: text('fleet', { enum: FLEETS }),
    attempts: integer('attempts').notNull().default(0),
    /**
     * A claim lease: this row is spoken for until then.
     *
     * `FOR UPDATE ... SKIP LOCKED` alone is not enough: the row lock lives
     * only as long as the claiming transaction, and delivery deliberately
     * happens *after* it commits (a Discord round-trip inside the transaction
     * would serialize the whole drain on the slowest HTTP call). Two
     * instances ticking a second apart would each claim the row and each
     * send. This column is what makes the claim outlive its transaction.
     */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    /**
     * Idempotent enqueue, and **partial on purpose**: every advance pass
     * re-derives the same pending notification, so the unique key makes
     * re-enqueue a no-op. It must be scoped to undelivered rows because
     * `grace_nudge` is re-sent weekly, and a total constraint on (guild, key)
     * would let the first nudge silence every one after it.
     */
    uniqueIndex('billing_notifications_pending_key')
      .on(t.guildId, t.key)
      .where(sql`delivered_at IS NULL`),
    /**
     * The pool-scoped equivalent. A plain (non-partial) unique index already
     * tolerates any number of `NULL`s in Postgres, so a guild-scoped row
     * (`pool_id` null) never collides here — this index only ever constrains
     * rows that actually have a `pool_id`.
     */
    uniqueIndex('billing_notifications_pool_pending_key')
      .on(t.poolId, t.key)
      .where(sql`delivered_at IS NULL`),
    // The drain's own query: undelivered, unclaimed, unexpired, oldest first.
    index('billing_notifications_pending_idx').on(
      t.deliveredAt,
      t.claimedUntil,
      t.expiresAt,
      t.enqueuedAt,
    ),
    index('billing_notifications_guild_idx').on(t.guildId, t.enqueuedAt),
    index('billing_notifications_pool_idx').on(t.poolId, t.enqueuedAt),
  ],
);

/**
 * `/templateassistant` usage, one row per guild per calendar month
 * (`plans/assisted_templates.md` §5).
 *
 * **Not a billing table.** The per-guild cap it backs is identical on every
 * tier and is never raised by paying — it is a runaway-cost backstop, and the
 * token columns exist only to enforce the fleet-wide spend ceiling (§5.2).
 *
 * The calendar-month key IS the reset mechanism: a new month simply gets a new
 * row, so "the cap resets on the 1st" holds with no job to run and no clock to
 * race. Old rows are harmless history and are never read outside their month.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    guildId: text('guild_id').notNull(),
    /** UTC calendar month, `YYYY-MM`. */
    month: text('month').notNull(),
    /** Builds consumed this month (a reservation, taken before the model call). */
    builds: integer('builds').notNull().default(0),
    /** Builds refunded because the provider call itself failed (diagnostics). */
    refunds: integer('refunds').notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.month] }), index('ai_usage_month_idx').on(t.month)],
);

/**
 * People who paid for the old gold/sapphire/diamond model, and are therefore
 * owed a **permanent 30% loyalty discount** on the new service
 * (`plans/monetization.md` §2, §0 Phase 7).
 *
 * **Keyed by the person, not the server.** The discount is loyalty to whoever
 * paid, so it follows them to any guild they subscribe for, and does NOT
 * transfer to whoever inherits a server they used to run. `guild_ids` is
 * reference data for support, never the eligibility test.
 *
 * The id here is a **Discord snowflake**, not our Auth.js `users.id`. Checkout
 * resolves it via `accounts.provider_account_id` for the signed-in user;
 * comparing it to `users.id` will silently never match (the same trap
 * documented on `subscriptions.purchaser_user_id`, from the other direction).
 *
 * Rows are permanent and never recomputed from Patreon (that campaign is
 * retired): a legacy customer who lapses, resubscribes, cancels and returns
 * is still a legacy customer, and the evidence columns are a snapshot of why
 * the row exists rather than a live source. Self-host runs this migration and
 * never populates it, like the other billing tables.
 */
export const legacyCustomers = pgTable(
  'legacy_customers',
  {
    /** Discord user id of the person who paid. */
    discordUserId: text('discord_user_id').primaryKey(),
    /**
     * Best-known tier on the old model: `gold`, `sapphire`, `diamond`, or
     * `unknown` where they demonstrably paid but no surviving record says at
     * what level. Metadata only. The discount is a flat 30% on every tier, so
     * nothing reads this to decide money.
     */
    priorTier: text('prior_tier'),
    /** How `prior_tier` was established, e.g. `sapphire_slot_29`, `owner_roster`. */
    tierSource: text('tier_source'),
    /** Total ever paid, in cents, across every Patreon account we tied to them. */
    lifetimeCents: integer('lifetime_cents').notNull().default(0),
    /** Patreon account id, where one is known. Null for dedicated-instance
     * customers recovered from the old bot's own config rather than Patreon. */
    patreonUserId: text('patreon_user_id'),
    /** Name on the Patreon account, kept so a support claim can be checked. */
    patreonName: text('patreon_name'),
    /** Discord username at seed time, for the same reason. Not kept current. */
    discordUsername: text('discord_username'),
    /** Which sources agreed this person paid, joined by `+`. Audit trail for a
     * row that grants a permanent discount. */
    evidence: text('evidence'),
    /** Guilds they ran the old bot in. Support reference, not an entitlement. */
    guildIds: jsonb('guild_ids')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Set when the discount is first actually used, so uptake is measurable
     * without inferring it from Paddle price ids. */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('legacy_customers_patreon_idx').on(t.patreonUserId)],
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
    /**
     * Fleet-scoped: two fleets shard independently and would otherwise fight
     * over shard 0. Part of the primary key, not just a column.
     */
    fleet: fleet(),
    shardId: integer('shard_id').notNull(),
    /** Total shard count this lease was claimed under. */
    totalShards: integer('total_shards').notNull(),
    /** The instance currently holding the lease (null = unclaimed). */
    instanceId: text('instance_id'),
    /** Last heartbeat; an expired heartbeat lets another instance re-claim. */
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fleet, t.shardId] }),
    index('shard_leases_instance_idx').on(t.instanceId),
  ],
);

/**
 * Per-bucket identify spacing. Discord requires identifies within a
 * `max_concurrency` bucket (`shardId % max_concurrency`) to be spaced apart; this
 * row records the last identify time per bucket so the identify throttler can
 * serialize them cluster-wide (checked under the identify advisory lock).
 */
export const identifyBuckets = pgTable(
  'identify_buckets',
  {
    /**
     * Fleet-scoped because Discord's `max_concurrency` is per APPLICATION. A
     * shared bucket would make one fleet delay the other's identifies and
     * compute the wrong spacing for both.
     */
    fleet: fleet(),
    bucket: integer('bucket').notNull(),
    lastIdentifyAt: timestamp('last_identify_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.fleet, t.bucket] })],
);

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
export const runtimeFlags = pgTable(
  'runtime_flags',
  {
    /** Fleet-scoped: pausing beta must not pause production. */
    fleet: fleet(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    description: text('description'),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.fleet, t.key] })],
);

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
    /**
     * Which fleet acted. NULLABLE on purpose: actions taken from the web
     * console originate outside any fleet, and recording a fleet for them
     * would be a lie rather than a default.
     */
    fleet: text('fleet', { enum: FLEETS }),
    /** Why, and any structured details. */
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('ops_audit_created_idx').on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Metric store (plans/admin-dashboard.md §3.4). Two narrow tables hold every
// operational time series; `domain/metrics.ts` owns what each name means.
// ---------------------------------------------------------------------------

/**
 * The fleet column on a metric row: a `Fleet`, or the literal `'shared'` for a
 * fact about the customer base rather than about one bot.
 *
 * Deliberately plain `text` and NOT the `FLEETS` enum, and deliberately NOT
 * NULL. See `METRIC_SHARED_SCOPE` in `domain/metrics.ts` for the reasoning:
 * nullable is impossible in a primary key, and widening `Fleet` to carry
 * `'shared'` would leak a non-fleet into `shard_leases`, `runtime_flags` and the
 * advisory-lock ordinals.
 */
const metricFleet = () => text('fleet').notNull().default('prod');

/**
 * The writing instance, or `''` for a row nobody owns privately.
 *
 * This column is what makes a counter write idempotent instead of additive. Each
 * instance owns its own row per bucket and rewrites its own running total, so a
 * retried flush lands on the same number rather than doubling it (golden rule 1,
 * applied to telemetry). Readers sum across instances. Rows computed by the
 * cluster-singleton rollup are shared facts and carry `''`.
 */
const metricInstance = () => text('instance').notNull().default('');

/**
 * Hourly operational metrics.
 *
 * The five-column primary key is the whole design and every part earns its
 * place: `bucket` is when, `metric` is what, `fleet` is whose bot (or nobody's),
 * `instance` is which writer (see above), and `key` is the metric's own
 * dimension - a command name, an auth status, a tier - or `''` for a metric with
 * no dimension.
 *
 * Retention is 90 days here and forever in {@link metricsDaily}.
 */
export const metricsHourly = pgTable(
  'metrics_hourly',
  {
    /** `date_trunc('hour', ...)`, UTC. */
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    fleet: metricFleet(),
    instance: metricInstance(),
    key: text('key').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.metric, t.fleet, t.instance, t.key] }),
    /**
     * "One metric over time" is every chart's query, and the primary key leads
     * with `bucket`, so it cannot serve it without scanning every metric in the
     * range.
     */
    index('metrics_hourly_metric_idx').on(t.metric, t.bucket),
  ],
);

/**
 * Daily operational metrics, kept forever.
 *
 * Derived from {@link metricsHourly} by a recompute-and-overwrite rollup, which
 * is what makes re-running it idempotent, and **collapses `instance` to `''`**:
 * nobody asks which machine created rooms on a given day two years ago, and
 * machine ids churn, so keeping them here would grow the long-term table without
 * bound for no reader.
 */
export const metricsDaily = pgTable(
  'metrics_daily',
  {
    /** `date_trunc('day', ...)`, UTC. */
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    fleet: metricFleet(),
    instance: metricInstance(),
    key: text('key').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.metric, t.fleet, t.instance, t.key] }),
    index('metrics_daily_metric_idx').on(t.metric, t.bucket),
  ],
);

/**
 * Per-guild delivery record for a one-shot broadcast sent via
 * `bot/src/ops/announce.ts` (`plans/marketing.md` §5.1 item 6).
 *
 * Distinct from `billing_notifications`: a broadcast has no ladder
 * re-deriving it every tick, so this row is the only record of what a guild
 * was sent, by which delivery method, and whether it landed. Before this
 * table, "did this guild get the cutover announcement" lived only in
 * `guilds.metadata.announcements`, a JSONB blob with no delivery method and
 * no opt-out - enough to stop a redeploy re-broadcasting, but not enough to
 * report on or to honour an opt-out.
 */
export const announcementDeliveries = pgTable(
  'announcement_deliveries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
    /** Which announcement, e.g. `rewrite_2026_08`. Stable across every touch. */
    key: text('key').notNull(),
    /** Which staged touch of that announcement, e.g. `heads_up`, `announcement`. */
    touch: text('touch').notNull(),
    /** Where it landed: `system_channel` | `owner_dm` | `creator_channel` | `failed`. */
    target: text('target'),
    /** Set only on a successful send. Null means not yet delivered. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    /**
     * Set once, on any row for this `(guildId, key)`, once an opt-out
     * mechanism exists to write it. Read across every touch of the same
     * `key` rather than scoped to one touch: opting out of an announcement
     * should skip every remaining touch of it, not just the one that
     * offered the opt-out.
     */
    optedOut: boolean('opted_out').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One row per guild per touch per announcement, ever. A retried send
    // updates this row rather than inserting a duplicate, which is what
    // stops a redeploy mid-broadcast from re-sending a touch that already
    // landed.
    uniqueIndex('announcement_deliveries_guild_key_touch').on(t.guildId, t.key, t.touch),
    index('announcement_deliveries_key_idx').on(t.key, t.touch),
  ],
);
