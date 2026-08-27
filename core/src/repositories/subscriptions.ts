import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { accounts, subscriptions } from '../db/schema.js';
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
  chargedTax: z.string().nullish(),
  chargedCurrency: z.string().nullish(),
  /** Latest refund adjustment state. Consumed by `subscriptionInGoodStanding`. */
  refundStatus: z.string().nullish(),
  refundTotal: z.string().nullish(),
  refundAt: z.date().nullish(),
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
export type AnySubscriptionRef =
  | { kind: 'guild'; id: string; guildId: string }
  | { kind: 'pool'; id: string; poolId: string };

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
  refundStatus?: string | null | undefined;
}): boolean {
  if (sub.refundStatus === 'approved') return false;
  return SUBSCRIPTION_OK_STATUSES.has(sub.status);
}

/**
 * Paddle statuses where the money has not arrived but the customer has not gone
 * anywhere either: the charge failed and Paddle is retrying it.
 */
export const SUBSCRIPTION_DUNNING_STATUSES: ReadonlySet<string> = new Set(['past_due']);

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
  refundStatus?: string | null | undefined;
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
      })
      .from(subscriptions)
      .where(eq(subscriptions.paddleSubscriptionId, paddleSubscriptionId))
      .limit(1);
    if (!row) return undefined;
    if (row.guildId) return { kind: 'guild', id: row.id, guildId: row.guildId };
    if (row.poolId) return { kind: 'pool', id: row.id, poolId: row.poolId };
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
    },
  ): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        chargedTotal: totals.total,
        chargedTax: totals.tax ?? null,
        chargedCurrency: totals.currency ?? null,
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
