import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { memberPoolGuilds } from '../db/schema.js';
import { GuildRepository } from './guilds.js';
import { MemberPoolRepository } from './memberPools.js';
import { SubscriptionRepository } from './subscriptions.js';
import type { TierId } from '../domain/tiers.js';

/**
 * Pool membership, with history (`plans/member-based-pricing.md` §6.1). The
 * durable record; `guilds.pool_id` is the denormalized pointer the hot paths
 * (the reconciler, the entitlement gate) read instead of joining here.
 */
export const memberPoolGuildRowSchema = z.object({
  poolId: z.string(),
  guildId: z.string(),
  addedAt: z.date(),
  removedAt: z.date().nullable(),
});

export type MemberPoolGuildRow = z.infer<typeof memberPoolGuildRowSchema>;

/** Thrown when a guild is already in a different live pool. */
export class GuildAlreadyPooledError extends Error {
  constructor(readonly guildId: string) {
    super(`Guild ${guildId} is already in a live pool`);
  }
}

export class MemberPoolGuildRepository {
  constructor(private readonly db: Database) {}

  /**
   * Adds a guild to a pool. Throws {@link GuildAlreadyPooledError} if the
   * guild already has a live membership elsewhere — the partial unique index
   * `member_pool_guilds_live_guild_idx` is the actual enforcement; this just
   * turns the resulting constraint violation into a typed error the caller
   * can show a friendly message for, rather than a bare Postgres error code.
   */
  async add(poolId: string, guildId: string, at = new Date()): Promise<void> {
    try {
      await this.db.insert(memberPoolGuilds).values({ poolId, guildId, addedAt: at });
    } catch (err) {
      if (isUniqueViolation(err)) throw new GuildAlreadyPooledError(guildId);
      throw err;
    }
  }

  /** Marks a membership removed. No-op if the guild has no live row in this pool. */
  async remove(poolId: string, guildId: string, at = new Date()): Promise<void> {
    await this.db
      .update(memberPoolGuilds)
      .set({ removedAt: at })
      .where(
        and(
          eq(memberPoolGuilds.poolId, poolId),
          eq(memberPoolGuilds.guildId, guildId),
          isNull(memberPoolGuilds.removedAt),
        ),
      );
  }

  /**
   * Marks a guild's live pool membership removed, wherever it is — for the
   * `guildDelete` path (§5.6), which knows only the guild, not which pool.
   * Returns the pool id it was removed from, or null if it was in none.
   */
  async removeByGuildId(guildId: string, at = new Date()): Promise<string | null> {
    const [row] = await this.db
      .update(memberPoolGuilds)
      .set({ removedAt: at })
      .where(and(eq(memberPoolGuilds.guildId, guildId), isNull(memberPoolGuilds.removedAt)))
      .returning({ poolId: memberPoolGuilds.poolId });
    return row?.poolId ?? null;
  }

  /** Every guild currently live in a pool. */
  async listLive(poolId: string): Promise<MemberPoolGuildRow[]> {
    const rows = await this.db
      .select()
      .from(memberPoolGuilds)
      .where(and(eq(memberPoolGuilds.poolId, poolId), isNull(memberPoolGuilds.removedAt)));
    return rows.map((r) => memberPoolGuildRowSchema.parse(r));
  }

  /** The pool a guild currently lives in, or null. */
  async livePoolFor(guildId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ poolId: memberPoolGuilds.poolId })
      .from(memberPoolGuilds)
      .where(and(eq(memberPoolGuilds.guildId, guildId), isNull(memberPoolGuilds.removedAt)))
      .limit(1);
    return row?.poolId ?? null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Adds a guild to a pool and points `guilds.pool_id`/`guilds.tier` at it, in
 * ONE transaction. `schema.ts`'s docblock on `guilds.pool_id` states this as
 * an invariant ("the two are written together, in the same statement, by
 * every add/remove path") — this is that one statement, so every caller
 * (the web dashboard's `addGuildToPool`, the pool-creation webhook path) uses
 * it instead of two sequential awaits. A failure between the two writes,
 * without this, leaves a guild live in `member_pool_guilds` but with
 * `pool_id` still null: invisible to the per-guild reconciler walk's skip
 * check, so it is evaluated (and can be transitioned) by BOTH the pool pass
 * and the per-guild walk, forever.
 */
export async function addGuildToPoolAtomically(
  db: Database,
  poolId: string,
  guildId: string,
  tier: TierId | null,
  at = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await new MemberPoolGuildRepository(tx).add(poolId, guildId, at);
    await new GuildRepository(tx).setPoolId(guildId, poolId, tier);
  });
}

/**
 * The removal-axis sibling of {@link addGuildToPoolAtomically}, for a caller
 * that already knows the pool id (the dashboard's `removeGuildFromPool`).
 */
export async function removeGuildFromPoolAtomically(
  db: Database,
  poolId: string,
  guildId: string,
  at = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await new MemberPoolGuildRepository(tx).remove(poolId, guildId, at);
    await new GuildRepository(tx).setPoolId(guildId, null, null);
  });
}

/**
 * The removal-axis sibling for a caller that knows only the guild (the bot's
 * `guildDelete` handler, §5.6). Returns the pool id the guild was removed
 * from, or null if it was in none.
 */
export async function removeGuildFromAnyPoolAtomically(
  db: Database,
  guildId: string,
  at = new Date(),
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const poolId = await new MemberPoolGuildRepository(tx).removeByGuildId(guildId, at);
    if (poolId) await new GuildRepository(tx).setPoolId(guildId, null, null);
    return poolId;
  });
}

/**
 * Converts an ordinary GUILD subscription into a pool covering that guild
 * plus one more, in a single transaction.
 *
 * The dashboard presents every subscription as a plain "subscription" a
 * customer can add servers to, whether or not it already covers more than
 * one (`plans/member-based-pricing.md` §7.4 addendum). A subscription that
 * has never been added to is still guild-keyed under
 * `subscriptions_guild_xor_pool`, so the first "add a server" against it has
 * to create the pool it should have been from the start: a fresh
 * `member_pools` row, the existing Paddle subscription re-keyed onto it
 * (`repointToPool`), and both guilds recorded as live members with their
 * `pool_id`/`tier` pointer set — all four writes or none, for the same
 * stranding reason `addGuildToPoolAtomically`'s docblock gives.
 */
export async function promoteSubscriptionToPool(
  db: Database,
  input: {
    subscriptionId: string;
    ownerUserId: string;
    existingGuildId: string;
    newGuildId: string;
    tier: TierId;
    poolName: string;
  },
  at = new Date(),
): Promise<string> {
  const poolId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await new MemberPoolRepository(tx).create({
      id: poolId,
      ownerUserId: input.ownerUserId,
      name: input.poolName,
      billedTier: input.tier,
    });
    await new SubscriptionRepository(tx).repointToPool(input.subscriptionId, poolId);
    const poolGuilds = new MemberPoolGuildRepository(tx);
    await poolGuilds.add(poolId, input.existingGuildId, at);
    await poolGuilds.add(poolId, input.newGuildId, at);
    const guilds = new GuildRepository(tx);
    await guilds.setPoolId(input.existingGuildId, poolId, input.tier);
    await guilds.setPoolId(input.newGuildId, poolId, input.tier);
  });
  return poolId;
}
