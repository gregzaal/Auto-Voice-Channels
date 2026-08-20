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
   * Rows are never deleted on removal: a guild can still have a live paid
   * subscription, and the dashboard must keep showing it so the owner can
   * cancel. Without this marker the dashboard cannot tell "subscribed and
   * working" from "subscribed and paying for nothing".
   */
  botRemovedAt: timestamp('bot_removed_at', { withTimezone: true }),
  /**
   * Guild display name, icon hash and owner, denormalized from the gateway's
   * `GUILD_CREATE`/`GUILD_UPDATE` payloads.
   *
   * Denormalizing public Discord metadata looks redundant until you try to
   * operate the service: nothing else in this schema can name a guild. The
   * customer dashboard resolves names from the *signed-in user's* OAuth token,
   * which only ever covers guilds that user is in, so any operator-side or
   * cross-guild view built the same way is a list of bare snowflakes. The one
   * other name we hold, `subscriptions.guild_name`, is captured at checkout and
   * therefore exists only for guilds that have paid.
   *
   * A hint, not ground truth — same standing as `member_count`. It is refreshed
   * on gateway events, so it goes stale for a guild the bot has been removed
   * from, and a stale name is exactly what we want there (it is the only name
   * that will ever exist for it again).
   */
  name: text('name'),
  /** Icon hash only; the CDN URL is derived, so a CDN move is not a migration. */
  iconHash: text('icon_hash'),
  ownerId: text('owner_id'),
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
     * whoever last took it over via `/transfer` or `/claim`. Unlike {@link ownerId}
     * — which auto-reassigns to a caretaker each time the owner leaves — this only
     * changes on a deliberate handover, so the original creator can `/claim` the
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

/** Billing source of truth per guild, synced from Paddle webhooks. */
export const subscriptions = pgTable('subscriptions', {
  guildId: text('guild_id').primaryKey(),
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
   * **The band cannot be recovered from the amount, and this is the column that
   * makes regional revenue reportable at all.** Three independent reasons, each
   * sufficient on its own:
   *
   *   1. Two USD cells collide exactly. Across all 280 (currency, amount, tier)
   *      cells in the catalogue only two are ambiguous, but they are USD 8 at S
   *      and USD 27 at M, each meaning either "band C standard" or "band B
   *      legacy" -- and every USD-denominated banded country sits behind them,
   *      50 of 108.
   *   2. Countries we did not override are AUTO-CONVERTED by Paddle, so their
   *      amount is not in our table at any rounding. Measured 2026-08-20:
   *      Iceland and Romania pay EUR 50.50 at tier M where our own EUR override
   *      is EUR 49.00. Nothing matches 5050, and it moves with the rate.
   *   3. A band is a policy view of a country. Storing the country means
   *      re-cutting the bands re-derives history correctly; storing the band
   *      freezes today's policy into every past row.
   *
   * Null for the rows written before this column existed and for any
   * transaction whose address lookup failed. Both are backfillable: the raw
   * webhook body in `billing_events.payload` keeps `address_id` forever, and
   * Paddle resolves it on demand. See `scripts/backfill-billing-origin.ts`.
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
   * A refund that is only *requested* (`pending_approval`) changes nothing.
   * Paddle reviews these, and cutting someone off while their request is still
   * being judged would punish them for asking.
   *
   * This docblock said the exact opposite until 2026-08-18 ("deliberately does
   * NOT affect entitlement... the only inputs to access"). It was written for a
   * display-only design and falsified hours later the same day by the commit
   * that made an approved refund revoke standing. Left uncorrected it went
   * public, contradicting both the code below it and the live refund policy.
   */
  refundStatus: text('refund_status'),
  /** Refunded amount (minor units) for that adjustment. */
  refundTotal: text('refund_total'),
  refundAt: timestamp('refund_at', { withTimezone: true }),
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

/**
 * Billing notifications waiting to be delivered (`plans/fleets.md` §4).
 *
 * **The queue exists because advancing the ladder and delivering its message
 * are done by different bots.** Advancement is fleet-wide work on shared rows,
 * so exactly one instance across the whole cluster does it
 * (`BILLING_ADVISORY_LOCK`, deliberately not fleet-scoped). Delivery needs a
 * bot that is actually in the guild, and the fleet that won the lock may not
 * be. Before this table the two were one loop, which worked only because there
 * has never been more than one fleet: the moment beta and prod are both up, a
 * guild transitioned by the fleet that cannot see it is a guild that is never
 * told anything, silently, forever.
 *
 * Rows are the *intent* to notify. The dedupe stamp that stops the ladder
 * re-deciding lives where it always did, in `guilds.metadata.billing
 * .notifications`, and is written only once a delivery actually lands. So an
 * undelivered row keeps being re-derived by every advance pass, which is why
 * enqueue has to be idempotent rather than merely cheap.
 */
/**
 * Operational alerts, as rows.
 *
 * The load-bearing decision from `plans/agentic_management.md`: an alert is a
 * persisted row first and delivery is a renderer over it. Before this table the
 * only alerting was fire-and-forget into a Discord channel, so a delivery
 * failure was indistinguishable from quiet, "what fired last month" was a
 * scroll rather than a query, and every dedupe was in-process memory that a
 * restart re-armed.
 *
 * Shape copied from `billing_notifications`, which is the reviewed precedent
 * for this pattern here, including the part that matters most: the unique index
 * is PARTIAL, on unresolved rows only. A total constraint on `(fleet, key,
 * target)` would let the first occurrence of a repeating condition silence
 * every later one forever, which is the exact bug the partial form exists to
 * prevent.
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

export const billingNotifications = pgTable(
  'billing_notifications',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    guildId: text('guild_id').notNull(),
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
     * `FOR UPDATE ... SKIP LOCKED` alone is not enough here, and the difference
     * is easy to miss. The row lock lives exactly as long as the claiming
     * transaction, and delivery deliberately happens *after* it commits (a
     * Discord round-trip inside the transaction would serialize the whole drain
     * on the slowest HTTP call). So SKIP LOCKED only separates two claims that
     * overlap in time. Two instances of one fleet ticking a second apart would
     * each claim the same row and each send the message. This column is what
     * makes the claim outlive its transaction.
     */
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    /**
     * Idempotent enqueue, and **partial on purpose**.
     *
     * Every advance pass re-derives the same pending notification until it is
     * delivered, so a plain unique key is what makes re-enqueue a no-op rather
     * than a duplicate message. It has to be scoped to undelivered rows though:
     * `grace_nudge` is deliberately re-sent weekly, and a total unique
     * constraint on (guild, key) would let the first nudge silence every one
     * after it.
     */
    uniqueIndex('billing_notifications_pending_key')
      .on(t.guildId, t.key)
      .where(sql`delivered_at IS NULL`),
    // The drain's own query: undelivered, unclaimed, unexpired, oldest first.
    index('billing_notifications_pending_idx').on(
      t.deliveredAt,
      t.claimedUntil,
      t.expiresAt,
      t.enqueuedAt,
    ),
    index('billing_notifications_guild_idx').on(t.guildId, t.enqueuedAt),
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
 * has to resolve it via `accounts.provider_account_id` for the signed-in user;
 * comparing it to `users.id` will silently never match (the same trap
 * documented on `subscriptions.purchaser_user_id`, from the other direction).
 *
 * Rows are permanent. A legacy customer who lapses, resubscribes, cancels and
 * returns is still a legacy customer, so nothing in the billing machinery ever
 * deletes or expires one. Eligibility is never recomputed from Patreon: that
 * campaign is being retired, and the evidence columns below are a snapshot of
 * why each row exists rather than a live source.
 *
 * Self-host runs this migration and never populates it, like the other billing
 * tables.
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
