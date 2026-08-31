import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { accounts, subscriptions } from '../db/schema.js';
import type { AdjustmentRecord, RefundVerdict } from '../domain/refunds.js';
import { TIER_IDS, compareTiers, type TierId } from '../domain/tiers.js';

/**
 * zod schema validating a GUILD subscription row read from the DB (boundary
 * validation). Every query here that filters on `guild_id` (equality, `IN`,
 * or matches a specific fetched row) only ever returns rows satisfying
 * `subscriptions_guild_xor_pool`, so `guildId` stays a required string for
 * that whole family of reads. Pool subscriptions (`guild_id` null) are a
 * separate shape — see {@link poolSubscriptionRowSchema} — and never appear
 * here because nothing below queries the table without a guild filter.
 */
export const subscriptionRowSchema = z.object({
  /**
   * Surrogate key (`plans/member-based-pricing.md` §6.2). Added alongside the
   * primary-key change that made `guild_id` nullable; not used by any guild
   * read path yet, kept for parity with the row shape and for callers that
   * want a stable id independent of which axis (guild or pool) it bills.
   */
  id: z.string(),
  guildId: z.string(),
  paddleSubscriptionId: z.string(),
  paddleCustomerId: z.string(),
  /**
   * Auth.js user id (our `users.id`) that completed checkout, not a Discord
   * snowflake. Null for rows created before the column existed.
   * `.nullish()` so a build that predates the migration still parses (web and
   * bot deploy independently).
   */
  purchaserUserId: z.string().nullish(),
  /** Server name at checkout; only for rendering guilds the viewer cannot see. */
  guildName: z.string().nullish(),
  tier: z.enum(TIER_IDS),
  status: z.string(),
  currentPeriodEnd: z.date().nullable(),
  /** Actually-charged total (minor units, tax-inclusive). See schema.ts. */
  chargedTotal: z.string().nullish(),
  /** The transaction that bought the current period. See schema.ts for why it matters. */
  chargedTransactionId: z.string().nullish(),
  /** When that transaction was paid. What the refund window is measured from. */
  chargedAt: z.date().nullish(),
  chargedTax: z.string().nullish(),
  chargedCurrency: z.string().nullish(),
  /**
   * Latest refund adjustment state, for display. See `refundSettledAt` for authority.
   *
   * `.default(null)` rather than a bare `.nullish()`, and the same on
   * `refundSettledAt` below. `.nullish()` alone makes the KEY OPTIONAL in zod's
   * output type, so a full `SubscriptionRow` would not satisfy the predicates'
   * required-property signatures and every full-row caller would fail to
   * compile alongside the narrow projections the requirement exists to catch.
   * The default keeps the input tolerant, which is the point of `.nullish()`
   * here, and guarantees the key is present on the way out.
   */
  refundStatus: z.string().nullish().default(null),
  /**
   * Which adjustment ACTION these fields describe. Null reads as `refund`,
   * because every row written before the column existed was one. Any surface
   * rendering "Refunded" has to check it, or a chargeback tells a customer their
   * money came back from us when their bank reversed the charge instead.
   */
  refundAction: z.string().nullish().default(null),
  refundTotal: z.string().nullish(),
  /** When WE received the adjustment. Not the ordering guard's input: see schema.ts. */
  refundAt: z.date().nullish(),
  /** The adjustment's own Paddle timestamp, which IS the ordering guard's input. */
  refundUpdatedAt: z.date().nullish().default(null),
  /**
   * The authority for "access is revoked": a full, approved refund of the
   * transaction that bought the current period.
   *
   * `.nullish()` like every other added column, so a build predating the
   * migration still parses. That is also why `subscriptionInGoodStanding` keeps
   * a compat branch on `refundStatus`: until the writer ships, this is null on
   * every row, and a predicate reading only this would report a refunded
   * subscription as healthy.
   */
  refundSettledAt: z.date().nullish().default(null),
  refundAdjustmentId: z.string().nullish(),
  refundCurrency: z.string().nullish(),
  /** Pending Paddle change: 'cancel' | 'pause' | 'resume'. Null = renewing normally. */
  scheduledChangeAction: z.string().nullish(),
  scheduledChangeAt: z.date().nullish(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  /**
   * Billing origin, resolved at `transaction.completed`. See schema.ts for why
   * the band cannot be recovered from the amount.
   *
   * `.nullish()` for the usual two reasons plus a third specific to these: web
   * and bot deploy independently, rows predate the column, AND the country is a
   * best-effort second API call that is allowed to fail without failing the
   * webhook. A null here is "not resolved", never "no country".
   */
  billingCountryCode: z.string().nullish(),
  billedPriceId: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SubscriptionRow = z.infer<typeof subscriptionRowSchema>;

export interface UpsertSubscriptionInput {
  guildId: string;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  /** Auth.js user id from the transaction's custom data, when present. */
  purchaserUserId?: string | null;
  guildName?: string | null;
  tier: SubscriptionRow['tier'];
  status: string;
  currentPeriodEnd?: Date | null;
  scheduledChangeAction?: string | null;
  scheduledChangeAt?: Date | null;
  price?: string | null;
  currency?: string | null;
}

/**
 * A POOL subscription row — the same table, the other axis of
 * `subscriptions_guild_xor_pool`. `guildName` is dropped: a pool checkout
 * never starts from one specific server's identity.
 */
export const poolSubscriptionRowSchema = subscriptionRowSchema
  .omit({ guildId: true, guildName: true })
  .extend({ poolId: z.string() });

export type PoolSubscriptionRow = z.infer<typeof poolSubscriptionRowSchema>;

export interface UpsertPoolSubscriptionInput {
  poolId: string;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  purchaserUserId?: string | null;
  tier: SubscriptionRow['tier'];
  status: string;
  currentPeriodEnd?: Date | null;
  scheduledChangeAction?: string | null;
  scheduledChangeAt?: Date | null;
  price?: string | null;
  currency?: string | null;
}

/**
 * Which axis a subscription row bills, without committing to either row
 * shape. Used only where the caller has a Paddle subscription id and does not
 * yet know whether it belongs to a guild or a pool (`applyRefund`) — everyone
 * else already knows which one they are asking for.
 */
/**
 * Which axis a subscription bills through, plus the two fields an adjustment
 * decision needs. Both are carried here rather than fetched separately because
 * the axis lookup is already the one query every adjustment does, and neither
 * field parses through the axis-specific row schemas.
 */
export type AnySubscriptionRef = { id: string; refundContext: RefundContext } & (
  | { kind: 'guild'; guildId: string }
  | { kind: 'pool'; poolId: string }
);

/** What {@link classifyAdjustment} needs to know about the row it is judging. */
export interface RefundContext {
  chargedTransactionId: string | null;
  refundAdjustmentId: string | null;
}

/**
 * Paddle subscription statuses that count as "in good standing" for
 * entitlement purposes (dunning states are not — they ride the leniency
 * ladder instead; monetization.md §9).
 */
export const SUBSCRIPTION_OK_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

/**
 * Whether a subscription is paying its way *right now*.
 *
 * Status alone is not enough: **an approved refund revokes standing even while
 * Paddle still reports `active`.** A refund does not cancel a subscription, so
 * without this the reconcile job would see a healthy `active` row and
 * reactivate a guild we had just gated for being refunded, on the next hourly
 * tick. Policy (owner, 2026-08-12): a granted refund stops access immediately.
 * A merely requested one does not, which is what the `approved` check below is
 * for. The amount refunded is a human decision taken in Paddle and is not
 * modelled here.
 *
 * Shared so the bot's ladder and the webhook planner cannot drift apart.
 */
export function subscriptionInGoodStanding(sub: {
  status: string;
  refundStatus: string | null | undefined;
  refundSettledAt: Date | null | undefined;
  refundUpdatedAt: Date | null | undefined;
}): boolean {
  if (sub.refundSettledAt) return false;
  /**
   * Compat branch, scoped to rows the derived writer has never touched.
   *
   * `refund_settled_at` is null on every row until that writer ships, so a
   * predicate reading only it would report the one live refunded subscription as
   * perfectly healthy. But the branch cannot be unconditional either:
   * `refundStatus` is `'approved'` for a PARTIAL refund too, and for a full
   * refund of some earlier period's transaction, and gating on those is exactly
   * the "a refund punishes" defect the settled marker exists to avoid.
   *
   * `refundUpdatedAt` is the discriminator, and it is reliable because only
   * `applyAdjustment` writes it and it writes all four columns together. Null
   * means no derived write has happened, so the old status is the best answer we
   * have. Non-null means the marker is the whole answer, and its absence is a
   * decision rather than a gap.
   */
  if (!sub.refundUpdatedAt && sub.refundStatus === 'approved') return false;
  return SUBSCRIPTION_OK_STATUSES.has(sub.status);
}

/**
 * Paddle statuses where the money has not arrived but the customer has not gone
 * anywhere either: the charge failed and Paddle is retrying it.
 */
export const SUBSCRIPTION_DUNNING_STATUSES: ReadonlySet<string> = new Set(['past_due']);

/** Scheduled Paddle changes that end a subscription rather than pausing it. */
const SUBSCRIPTION_TERMINAL_CHANGES: ReadonlySet<string> = new Set(['cancel']);

/**
 * Whether this subscription can still produce a future charge.
 *
 * The complement of {@link subscriptionInGoodStanding}, not its negation, and
 * the two are independent: an approved refund revokes standing immediately
 * while Paddle keeps billing on schedule, so a refunded subscription with no
 * cancellation behind it renews and charges again for service we have already
 * stopped delivering.
 *
 * That gap is what this answers, and two decisions depend on it. A customer
 * cannot be offered a second subscription for a server whose existing one will
 * charge again, or they are billed twice. And a subscription that will never
 * charge again is settled: it needs no cancel control, so the server it used to
 * cover can be sold a fresh subscription instead of being stuck behind a dead
 * row until Paddle's own cancellation date lands.
 *
 * `pause` is deliberately NOT terminal: a paused subscription resumes and bills
 * again, so it counts as live. `canceled` is, whatever the refund says.
 */
export function subscriptionWillChargeAgain(sub: {
  status: string;
  scheduledChangeAction?: string | null | undefined;
}): boolean {
  if (sub.status === 'canceled' || sub.status === 'cancelled') return false;
  if (sub.scheduledChangeAction && SUBSCRIPTION_TERMINAL_CHANGES.has(sub.scheduledChangeAction)) {
    return false;
  }
  return true;
}

/**
 * Whether a subscription is finished: delivering nothing and charging nothing
 * ever again. A row in this state exists only as history.
 */
export function subscriptionIsSettled(sub: {
  status: string;
  refundStatus: string | null | undefined;
  refundSettledAt: Date | null | undefined;
  refundUpdatedAt: Date | null | undefined;
  scheduledChangeAction?: string | null | undefined;
}): boolean {
  return !subscriptionInGoodStanding(sub) && !subscriptionWillChargeAgain(sub);
}

/**
 * Whether a subscription earns its purchaser public recognition, as distinct
 * from whether it is paying its way right now.
 *
 * **Deliberately NOT an entitlement check, and nothing may ever use it as one.**
 * The only caller is the supporter-role sync. Access is decided by
 * {@link subscriptionInGoodStanding} and the leniency ladder, and this being
 * looser must never leak into that.
 *
 * The difference is dunning. `subscriptionInGoodStanding` excludes `past_due`
 * on the first failed retry, while the ladder deliberately keeps that customer's
 * servers running for another 60 days. Applying the strict rule to a badge meant
 * a role visibly disappearing from a public member list on day one of a 60-day
 * window, which is a bad way to learn your card expired, and a worse one for
 * everyone else in the server to watch happen.
 *
 * Expressed in terms of the strict predicate rather than restating it, so the
 * two cannot drift: a refund still revokes recognition immediately, because a
 * refunded customer is not a supporter. `paused` and `canceled` are absent on
 * purpose, in both. Owner's call, 2026-08-27.
 */
export function subscriptionEarnsRecognition(sub: {
  status: string;
  refundStatus: string | null | undefined;
  refundSettledAt: Date | null | undefined;
  refundUpdatedAt: Date | null | undefined;
}): boolean {
  if (subscriptionInGoodStanding(sub)) return true;
  if (sub.refundStatus === 'approved') return false;
  return SUBSCRIPTION_DUNNING_STATUSES.has(sub.status);
}

/**
 * Billing source of truth, synced from Paddle webhooks. One row per Paddle
 * subscription, covering either **one pool of servers (the default)** or a
 * single guild (legacy, promoted into a pool on the first server added to it).
 * Exactly one of the two, enforced by `subscriptions_guild_xor_pool`.
 *
 * The two axes are not interchangeable at the call site: `upsert` conflicts on
 * `guildId` and `upsertForPool` on `poolId`, and pointing a pool row at "the
 * guild checkout started from" would clobber that guild's own subscription
 * (`plans/member-based-pricing.md` §6.2). Same boundary-validation style as
 * GuildRepository.
 */
export class SubscriptionRepository {
  constructor(private readonly db: Database) {}

  /** Idempotent upsert keyed on `guild_id` — webhook replays converge. */
  async upsert(input: UpsertSubscriptionInput): Promise<SubscriptionRow> {
    const values = {
      guildId: input.guildId,
      paddleSubscriptionId: input.paddleSubscriptionId,
      paddleCustomerId: input.paddleCustomerId,
      purchaserUserId: input.purchaserUserId ?? null,
      guildName: input.guildName ?? null,
      tier: input.tier,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      // Straight overwrite, NOT coalesced like purchaser/guildName: revoking a
      // scheduled cancellation is reported as `scheduled_change: null`, and
      // keeping the old value would leave the UI claiming it still ends.
      scheduledChangeAction: input.scheduledChangeAction ?? null,
      scheduledChangeAt: input.scheduledChangeAt ?? null,
      price: input.price ?? null,
      currency: input.currency ?? null,
    };
    const [row] = await this.db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: subscriptions.guildId,
        set: {
          ...values,
          // Never regress a known purchaser to null. Paddle propagates custom
          // data to renewals, but a subscription created before this column
          // existed has none, and a renewal for it must not erase a purchaser
          // recorded some other way. Prefer the incoming value, keep the
          // stored one otherwise.
          purchaserUserId: sql`coalesce(excluded.purchaser_user_id, ${subscriptions.purchaserUserId})`,
          guildName: sql`coalesce(excluded.guild_name, ${subscriptions.guildName})`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return subscriptionRowSchema.parse(row);
  }

  /**
   * Every GUILD subscription bought by this user (Auth.js user id), regardless
   * of whether they still manage, or are even in, the guild.
   *
   * This is the only path to a subscription for someone who left the server:
   * the dashboard's normal query starts from the user's manageable guilds, so
   * without this they would keep being charged with no self-serve way to stop.
   *
   * `safeParse`, not `parse`: a purchaser who also owns a pool has pool rows
   * in this same result set (`guild_id` null), which do not fit this schema
   * and must be skipped rather than crash the whole query. Use
   * {@link listPoolsByPurchaser} for those.
   */
  async listByPurchaser(purchaserUserId: string): Promise<SubscriptionRow[]> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.purchaserUserId, purchaserUserId));
    const out: SubscriptionRow[] = [];
    for (const row of rows) {
      const parsed = subscriptionRowSchema.safeParse(row);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /**
   * The best tier each of these **Discord snowflakes** is currently paying for,
   * across both billing axes, for whoever has more than one subscription.
   *
   * Takes the ids it should answer for rather than returning every paying
   * customer, and that is the whole scaling argument: the only caller is the
   * support guild's role sync, so the result is bounded by that one guild's
   * membership and never by the size of the customer base. Chunked so a large
   * member list cannot build a parameter array Postgres refuses.
   *
   * Standing here is {@link subscriptionEarnsRecognition}, which is
   * {@link subscriptionInGoodStanding} plus dunning: a customer whose card just
   * failed keeps the badge, because the leniency ladder keeps their servers
   * running for 60 more days and a role vanishing on day one is a bad way to
   * learn about it. A refund still revokes it immediately, since a refund does
   * not cancel a Paddle subscription and `status` alone would keep badging
   * someone whose money went back. A cancelled-but-still-paid subscription keeps
   * its badge until the period ends, which is what `active` already means here.
   *
   * Snowflakes with nothing in good standing are simply absent from the map.
   * That is a real answer, not a missing one, and the caller depends on it to
   * know whose badge to remove.
   */
  async listSupporterTiersFor(discordUserIds: readonly string[]): Promise<Map<string, TierId>> {
    const best = new Map<string, TierId>();
    const chunkSize = 2_000;
    for (let i = 0; i < discordUserIds.length; i += chunkSize) {
      const chunk = discordUserIds.slice(i, i + chunkSize);
      if (chunk.length === 0) continue;
      const rows = await this.db
        .select({
          discordUserId: accounts.providerAccountId,
          tier: subscriptions.tier,
          status: subscriptions.status,
          refundStatus: subscriptions.refundStatus,
          // Required by `subscriptionEarnsRecognition`, and it did not compile
          // without it. That is the required-property trick working: a badge
          // decided off a projection missing the settled marker would keep a
          // refunded customer's role indefinitely.
          refundSettledAt: subscriptions.refundSettledAt,
          refundUpdatedAt: subscriptions.refundUpdatedAt,
        })
        .from(subscriptions)
        .innerJoin(accounts, eq(accounts.userId, subscriptions.purchaserUserId))
        .where(
          and(
            eq(accounts.provider, 'discord'),
            inArray(accounts.providerAccountId, [...chunk]),
            isNotNull(subscriptions.purchaserUserId),
          ),
        );
      for (const row of rows) {
        if (!subscriptionEarnsRecognition(row)) continue;
        const tier = TIER_IDS.find((t) => t === row.tier);
        // A tier the running build does not know is skipped rather than
        // guessed at: expand/contract means an older instance can legitimately
        // read a row a newer one wrote.
        if (!tier || tier === 'free') continue;
        const current = best.get(row.discordUserId);
        if (!current || compareTiers(tier, current) > 0) best.set(row.discordUserId, tier);
      }
    }
    return best;
  }

  /**
   * The Auth.js user id that bought a Paddle subscription, on either axis.
   *
   * Exists for the refund path, which holds a Paddle subscription id and
   * nothing else: `getByPaddleIdAny` answers which axis it bills, not who is
   * paying for it, and a refund has to reach the purchaser to un-badge them.
   */
  async getPurchaserByPaddleId(paddleSubscriptionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ purchaserUserId: subscriptions.purchaserUserId })
      .from(subscriptions)
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
      .limit(1);
    return row?.purchaserUserId ?? null;
  }

  /** Every POOL subscription bought by this user. The pool-axis sibling of {@link listByPurchaser}. */
  async listPoolsByPurchaser(purchaserUserId: string): Promise<PoolSubscriptionRow[]> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.purchaserUserId, purchaserUserId));
    const out: PoolSubscriptionRow[] = [];
    for (const row of rows) {
      const parsed = poolSubscriptionRowSchema.safeParse(row);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /**
   * Idempotent upsert keyed on `pool_id` — the pool-axis sibling of
   * {@link upsert}. Same shape, same reasoning: a Paddle subscription for a
   * pool converges on repeat webhook delivery exactly like a guild one does.
   */
  async upsertForPool(input: UpsertPoolSubscriptionInput): Promise<PoolSubscriptionRow> {
    const values = {
      poolId: input.poolId,
      paddleSubscriptionId: input.paddleSubscriptionId,
      paddleCustomerId: input.paddleCustomerId,
      purchaserUserId: input.purchaserUserId ?? null,
      tier: input.tier,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      scheduledChangeAction: input.scheduledChangeAction ?? null,
      scheduledChangeAt: input.scheduledChangeAt ?? null,
      price: input.price ?? null,
      currency: input.currency ?? null,
    };
    const [row] = await this.db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: subscriptions.poolId,
        set: {
          ...values,
          purchaserUserId: sql`coalesce(excluded.purchaser_user_id, ${subscriptions.purchaserUserId})`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return poolSubscriptionRowSchema.parse(row);
  }

  async getByPoolId(poolId: string): Promise<PoolSubscriptionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.poolId, poolId))
      .limit(1);
    return row ? poolSubscriptionRowSchema.parse(row) : undefined;
  }

  /**
   * Every pool subscription in a set of pools, in one query.
   *
   * The batch form exists so a page rendering many guilds can resolve their
   * shared subscriptions without one round trip per guild. Rows that fail
   * validation are dropped rather than thrown, the same boundary rule the rest
   * of this repository follows: one corrupt row must not blank a whole page.
   */
  async listByPoolIds(poolIds: readonly string[]): Promise<PoolSubscriptionRow[]> {
    if (poolIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.poolId, [...poolIds]));
    const parsed: PoolSubscriptionRow[] = [];
    for (const row of rows) {
      const result = poolSubscriptionRowSchema.safeParse(row);
      if (result.success) parsed.push(result.data);
    }
    return parsed;
  }

  /**
   * Which axis a Paddle subscription id belongs to, without assuming either.
   * `applyRefund` is the one caller that genuinely does not know: a refund
   * event carries only the Paddle subscription id, which is equally valid on
   * either axis.
   */
  async getByPaddleIdAny(paddleSubscriptionId: string): Promise<AnySubscriptionRef | undefined> {
    const [row] = await this.db
      .select({
        id: subscriptions.id,
        guildId: subscriptions.guildId,
        poolId: subscriptions.poolId,
        chargedTransactionId: subscriptions.chargedTransactionId,
        refundAdjustmentId: subscriptions.refundAdjustmentId,
      })
      .from(subscriptions)
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
      .limit(1);
    if (!row) return undefined;
    const refundContext: RefundContext = {
      chargedTransactionId: row.chargedTransactionId,
      refundAdjustmentId: row.refundAdjustmentId,
    };
    if (row.guildId) return { kind: 'guild', id: row.id, guildId: row.guildId, refundContext };
    if (row.poolId) return { kind: 'pool', id: row.id, poolId: row.poolId, refundContext };
    return undefined;
  }

  /**
   * Records what a customer was actually charged, from `transaction.completed`.
   *
   * Separate from `upsert` because the subscription events cannot carry it: the
   * item only ever reports the baseline `unit_price`, so the regional discount
   * is invisible until a transaction settles. Keyed on the Paddle subscription
   * id, and a no-op for a transaction we have no subscription for.
   */
  async recordChargedTotals(
    paddleSubscriptionId: string,
    totals: {
      total: string;
      tax?: string | null;
      currency?: string | null;
      countryCode?: string | null;
      priceId?: string | null;
      transactionId?: string | null;
      chargedAt?: Date | null;
    },
  ): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        chargedTotal: totals.total,
        chargedTax: totals.tax ?? null,
        chargedCurrency: totals.currency ?? null,
        /**
         * Overwritten with the totals, deliberately, unlike the origin fields
         * below: they describe where the money came from and must not be
         * nulled by a payload we merely failed to parse, while this identifies
         * WHICH charge the totals are for. Keeping a previous period's id
         * beside a new period's totals is the one combination that would make
         * the refund test wrong in the dangerous direction, gating a customer
         * who is paid up.
         */
        chargedTransactionId: totals.transactionId ?? null,
        chargedAt: totals.chargedAt ?? null,
        // Origin fields are written only when we HAVE one, unlike the totals
        // above, which always arrive together on the same event and are
        // meaningless individually. A payload shape we do not recognise yields
        // no price id, and nulling a good one over that would lose a fact we
        // had for a fact we merely failed to parse.
        //
        // Uppercased because `bandForCountry` matches uppercase ISO literals
        // and returns band A for anything unrecognised, so a lowercase code
        // would be silently reported as full-price revenue.
        ...(totals.countryCode ? { billingCountryCode: totals.countryCode.toUpperCase() } : {}),
        ...(totals.priceId ? { billedPriceId: totals.priceId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId));
  }

  /**
   * Records the billing country on its own, after the totals are already down.
   *
   * Separate from `recordChargedTotals` because the two have different
   * reliability: the totals arrive inside the webhook payload and are the
   * reason the event exists, while the country costs a second Paddle API call
   * that is deliberately allowed to fail. Writing them together would make the
   * money figure wait on the optional one.
   *
   * Only ever called with a resolved value, so there is no null branch here: a
   * failed lookup simply does not call it, and the previous value stands. That
   * is what stops one API blip erasing a good country at a renewal, silently,
   * and leaving the row reading as "this customer has no country" rather than
   * "we did not ask successfully".
   */
  async recordBillingCountry(paddleSubscriptionId: string, countryCode: string): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ billingCountryCode: countryCode.toUpperCase(), updatedAt: new Date() })
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId));
  }

  /**
   * Records the latest refund adjustment. Keyed on the Paddle subscription id,
   * and a no-op for an adjustment on a subscription we do not know.
   *
   * Last write wins: `adjustment.updated` carries the approval outcome for the
   * same adjustment, so overwriting is the point.
   */
  async recordRefund(
    paddleSubscriptionId: string,
    refund: { status: string; total?: string | null; at?: Date | null },
  ): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        refundStatus: refund.status,
        refundTotal: refund.total ?? null,
        refundAt: refund.at ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId));
  }

  /**
   * Records an adjustment and applies its verdict, ORDER-GUARDED.
   *
   * `recordRefund` above is last-write-wins and its docblock says overwriting is
   * the point. That is `plans/refunds.md` §2.6: a second refund request arrives
   * `pending_approval`, overwrites `'approved'`, standing flips back true and the
   * ladder reactivates a guild whose money we already returned. A `rejected` or
   * `reversed` adjustment did the same.
   *
   * So this one applies only when the incoming adjustment is at least as new as
   * what we hold, compared on the ADJUSTMENT's own timestamp and never on
   * `refund_at`, which is receipt wall-clock and would judge every incoming
   * event stale. The comparison is in the WHERE clause rather than read-then-
   * written, so two concurrent deliveries cannot both win.
   *
   * Returns whether it applied, so a caller can tell "we ignored a replay" from
   * "we changed nothing".
   */
  async applyAdjustment(
    adjustment: AdjustmentRecord,
    verdict: RefundVerdict,
    now = new Date(),
  ): Promise<boolean> {
    if (!adjustment.paddleSubscriptionId) return false;
    const settled = verdict.kind === 'settle' ? now : verdict.kind === 'clear' ? null : undefined;
    const rows = await this.db
      .update(subscriptions)
      .set({
        refundAction: adjustment.action,
        refundStatus: adjustment.status,
        refundTotal: adjustment.total,
        refundAt: now,
        refundUpdatedAt: adjustment.updatedAt,
        refundCurrency: adjustment.currency,
        /**
         * The adjustment id is written with the marker and cleared with it, so
         * the clearing rule always has the id of whichever adjustment revoked
         * access and can refuse one that did not.
         */
        ...(settled === undefined
          ? {}
          : {
              refundSettledAt: settled,
              refundAdjustmentId: settled ? adjustment.adjustmentId : null,
            }),
        updatedAt: now,
      })
      .where(
        and(
          eq(subscriptions.paddleSubscriptionId, adjustment.paddleSubscriptionId),
          /**
           * `<=` and not `<`: Paddle can deliver two events with the same
           * timestamp (an approval stamped in the same second it was created),
           * and refusing the second would drop a real state change. Replaying
           * an identical event is harmless because every write is idempotent.
           */
          or(
            isNull(subscriptions.refundUpdatedAt),
            adjustment.updatedAt
              ? lte(subscriptions.refundUpdatedAt, adjustment.updatedAt)
              : sql`true`,
          ),
        ),
      )
      .returning({ id: subscriptions.id });
    return rows.length > 0;
  }

  async getByGuild(guildId: string): Promise<SubscriptionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.guildId, guildId))
      .limit(1);
    return row ? subscriptionRowSchema.parse(row) : undefined;
  }

  async getByPaddleId(paddleSubscriptionId: string): Promise<SubscriptionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
      .limit(1);
    return row ? subscriptionRowSchema.parse(row) : undefined;
  }

  async remove(guildId: string): Promise<void> {
    await this.db.delete(subscriptions).where(eq(subscriptions.guildId, guildId));
  }

  /**
   * Re-keys an existing GUILD subscription onto a pool, in place: same Paddle
   * subscription and customer, now billing a pool instead of one guild
   * (`plans/member-based-pricing.md` §7.4 addendum, "add to subscription" from
   * an ordinary server row). One statement setting both columns together,
   * same reasoning `addGuildToPoolAtomically`'s docblock gives:
   * `subscriptions_guild_xor_pool` is checked against the finished row, and
   * clearing `guild_id` before setting `pool_id` in two statements would fail
   * the constraint on the first one.
   */
  async repointToPool(subscriptionId: string, poolId: string): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({ guildId: null, poolId, updatedAt: new Date() })
      .where(eq(subscriptions.id, subscriptionId));
  }
}
