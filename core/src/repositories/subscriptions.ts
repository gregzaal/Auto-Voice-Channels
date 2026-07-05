import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { TIER_IDS } from '../domain/tiers.js';

/** zod schema validating a subscription row read from the DB (boundary validation). */
export const subscriptionRowSchema = z.object({
  guildId: z.string(),
  paddleSubscriptionId: z.string(),
  paddleCustomerId: z.string(),
  tier: z.enum(TIER_IDS),
  status: z.string(),
  currentPeriodEnd: z.date().nullable(),
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
  tier: SubscriptionRow['tier'];
  status: string;
  currentPeriodEnd?: Date | null;
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
      tier: input.tier,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      price: input.price ?? null,
      currency: input.currency ?? null,
    };
    const [row] = await this.db
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: subscriptions.guildId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return subscriptionRowSchema.parse(row);
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
