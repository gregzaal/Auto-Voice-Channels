import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { legacyCustomers } from '../db/schema.js';

export interface LegacyCustomer {
  discordUserId: string;
  priorTier: string | null;
  lifetimeCents: number;
  patreonName: string | null;
  redeemedAt: Date | null;
}

export interface LegacyCustomerSeed {
  discordUserId: string;
  priorTier?: string | null;
  tierSource?: string | null;
  lifetimeCents?: number;
  patreonUserId?: string | null;
  patreonName?: string | null;
  discordUsername?: string | null;
  evidence?: string | null;
  guildIds?: string[];
}

/**
 * Who is owed the permanent 30% loyalty discount (`plans/monetization.md` §2,
 * §0 Phase 7).
 *
 * Read on the checkout path, so {@link isLegacy} is deliberately the narrowest
 * possible query: one indexed primary-key lookup returning a boolean. The
 * richer {@link get} exists for the dashboard and support.
 *
 * **Fails closed, and that is a real decision.** If this table is unreachable
 * the caller charges full price rather than guessing, because handing out a
 * permanent discount on the strength of a failed query is unrecoverable once
 * Paddle has attached the discounted price to a live subscription, whereas an
 * overcharged legacy customer is a refund and an apology.
 */
export class LegacyCustomerRepository {
  constructor(private readonly db: Database) {}

  /** Whether this Discord user paid for the old gold/sapphire/diamond model. */
  async isLegacy(discordUserId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: legacyCustomers.discordUserId })
      .from(legacyCustomers)
      .where(eq(legacyCustomers.discordUserId, discordUserId))
      .limit(1);
    return rows.length > 0;
  }

  async get(discordUserId: string): Promise<LegacyCustomer | null> {
    const rows = await this.db
      .select({
        discordUserId: legacyCustomers.discordUserId,
        priorTier: legacyCustomers.priorTier,
        lifetimeCents: legacyCustomers.lifetimeCents,
        patreonName: legacyCustomers.patreonName,
        redeemedAt: legacyCustomers.redeemedAt,
      })
      .from(legacyCustomers)
      .where(eq(legacyCustomers.discordUserId, discordUserId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Stamps first use of the discount. Only the first one counts, so uptake can
   * be measured without inferring it from Paddle price ids, and a customer who
   * subscribes for a second server does not reset their own history.
   */
  async markRedeemed(discordUserId: string, at: Date = new Date()): Promise<void> {
    await this.db
      .update(legacyCustomers)
      .set({ redeemedAt: at, updatedAt: new Date() })
      .where(
        sql`${legacyCustomers.discordUserId} = ${discordUserId} AND ${legacyCustomers.redeemedAt} IS NULL`,
      );
  }

  /**
   * Inserts or refreshes seed rows.
   *
   * `redeemed_at` is never touched here: re-running the seed must not erase the
   * fact that someone already used their discount.
   */
  async upsertMany(rows: readonly LegacyCustomerSeed[]): Promise<number> {
    if (rows.length === 0) return 0;
    let written = 0;
    // Chunked so a full re-seed stays well inside Postgres' parameter limit.
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({
        discordUserId: r.discordUserId,
        priorTier: r.priorTier ?? null,
        tierSource: r.tierSource ?? null,
        lifetimeCents: r.lifetimeCents ?? 0,
        patreonUserId: r.patreonUserId ?? null,
        patreonName: r.patreonName ?? null,
        discordUsername: r.discordUsername ?? null,
        evidence: r.evidence ?? null,
        guildIds: r.guildIds ?? [],
      }));
      await this.db
        .insert(legacyCustomers)
        .values(chunk)
        .onConflictDoUpdate({
          target: legacyCustomers.discordUserId,
          set: {
            priorTier: sql`excluded.prior_tier`,
            tierSource: sql`excluded.tier_source`,
            lifetimeCents: sql`excluded.lifetime_cents`,
            patreonUserId: sql`excluded.patreon_user_id`,
            patreonName: sql`excluded.patreon_name`,
            discordUsername: sql`excluded.discord_username`,
            evidence: sql`excluded.evidence`,
            guildIds: sql`excluded.guild_ids`,
            updatedAt: new Date(),
          },
        });
      written += chunk.length;
    }
    return written;
  }

  async count(): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(legacyCustomers);
    return rows[0]?.n ?? 0;
  }
}
