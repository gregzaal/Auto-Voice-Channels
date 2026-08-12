import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { TIER_IDS } from '../domain/tiers.js';

/** zod schema validating a subscription row read from the DB (boundary validation). */
export const subscriptionRowSchema = z.object({
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
  /** Latest refund adjustment state. Never affects entitlement. See schema.ts. */
  refundStatus: z.string().nullish(),
  refundTotal: z.string().nullish(),
  refundAt: z.date().nullish(),
  /** Pending Paddle change: 'cancel' | 'pause' | 'resume'. Null = renewing normally. */
  scheduledChangeAction: z.string().nullish(),
  scheduledChangeAt: z.date().nullish(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
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
 * Paddle subscription statuses that count as "in good standing" for
 * entitlement purposes (dunning states are not — they ride the leniency
 * ladder instead; monetization.md §9).
 */
export const SUBSCRIPTION_OK_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

/**
 * Billing source of truth per guild, synced from Paddle webhooks (one
 * subscription per guild). Same boundary-validation style as GuildRepository.
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
   * Every subscription bought by this user (Auth.js user id), regardless of
   * whether they still manage, or are even in, the guild.
   *
   * This is the only path to a subscription for someone who left the server:
   * the dashboard's normal query starts from the user's manageable guilds, so
   * without this they would keep being charged with no self-serve way to stop.
   */
  async listByPurchaser(purchaserUserId: string): Promise<SubscriptionRow[]> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.purchaserUserId, purchaserUserId));
    return rows.map((row) => subscriptionRowSchema.parse(row));
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
    totals: { total: string; tax?: string | null; currency?: string | null },
  ): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        chargedTotal: totals.total,
        chargedTax: totals.tax ?? null,
        chargedCurrency: totals.currency ?? null,
        updatedAt: new Date(),
      })
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
}
