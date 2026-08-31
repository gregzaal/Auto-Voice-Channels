import { and, eq, isNotNull, isNull } from 'drizzle-orm';
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

/** Thrown when a guild is already in a live pool. */
export class GuildAlreadyPooledError extends Error {
  constructor(
    readonly guildId: string,
    /**
     * Whether the live membership is in the pool the caller asked about.
     * `add` collapsed two different constraints into one error, so the
     * dashboard told a customer "that server is already on a subscription"
     * when it was on none: the primary key `(pool_id, guild_id)` fires for a
     * server this pool once had and released, while the partial index
     * `member_pool_guilds_live_guild_idx` is the one that means what the
     * message says. The two now have different causes and different copy.
     */
    readonly samePool = false,
  ) {
    super(
      samePool
        ? `Guild ${guildId} is already live in this pool`
        : `Guild ${guildId} is already in a live pool`,
    );
  }
}

/**
 * Thrown when a removal names a guild that is not live in the pool given.
 *
 * The reason this is an error rather than a no-op is the whole of
 * `plans/refunds.md` §2.2: `remove` matching zero rows used to be silent, and
 * `removeGuildFromPoolAtomically` went on to null `guilds.pool_id` anyway, so
 * owning any pool authorized a write against any guild id in existence. It
 * also closes the race, because the transaction rolls back before the pointer
 * write instead of relying on a check the caller made beforehand.
 */
export class GuildNotInPoolError extends Error {
  constructor(
    readonly guildId: string,
    readonly poolId: string,
  ) {
    super(`Guild ${guildId} is not live in pool ${poolId}`);
  }
}

export class MemberPoolGuildRepository {
  constructor(private readonly db: Database) {}

  /**
   * Adds a guild to a pool, reviving a membership this pool previously
   * released rather than refusing it forever (`plans/refunds.md` §2.10).
   *
   * The primary key is `(pool_id, guild_id)` and `remove` stamps `removed_at`
   * instead of deleting, so a bare insert made "remove a server, change your
   * mind, add it back" a permanent refusal — and reported it with the message
   * for a completely different condition. The upsert is scoped by `setWhere`
   * to rows that are actually removed, so a guild already LIVE in this pool
   * still updates nothing and is still refused, which is the behaviour every
   * existing caller was written against.
   *
   * Throws {@link GuildAlreadyPooledError}, with `samePool` distinguishing the
   * two causes. A guild live in a DIFFERENT pool trips
   * `member_pool_guilds_live_guild_idx` on the revived row, which is the
   * constraint that genuinely means "already on a subscription".
   */
  async add(poolId: string, guildId: string, at = new Date()): Promise<void> {
    let revived: { guildId: string }[];
    try {
      revived = await this.db
        .insert(memberPoolGuilds)
        .values({ poolId, guildId, addedAt: at })
        .onConflictDoUpdate({
          target: [memberPoolGuilds.poolId, memberPoolGuilds.guildId],
          set: { addedAt: at, removedAt: null },
          setWhere: isNotNull(memberPoolGuilds.removedAt),
        })
        .returning({ guildId: memberPoolGuilds.guildId });
    } catch (err) {
      if (isUniqueViolation(err)) throw new GuildAlreadyPooledError(guildId);
      throw err;
    }
    // No row back means the conflict hit a row `setWhere` declined to touch,
    // which can only be a live membership in THIS pool.
    if (revived.length === 0) throw new GuildAlreadyPooledError(guildId, true);
  }

  /**
   * Marks a membership removed. Returns whether a live row actually matched,
   * so a caller can refuse rather than proceed on a guild that is not in this
   * pool. See {@link GuildNotInPoolError} for why that matters.
   */
  async remove(poolId: string, guildId: string, at = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(memberPoolGuilds)
      .set({ removedAt: at })
      .where(
        and(
          eq(memberPoolGuilds.poolId, poolId),
          eq(memberPoolGuilds.guildId, guildId),
          isNull(memberPoolGuilds.removedAt),
        ),
      )
      .returning({ guildId: memberPoolGuilds.guildId });
    return rows.length > 0;
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
    const removed = await new MemberPoolGuildRepository(tx).remove(poolId, guildId, at);
    /**
     * Refuse INSIDE the transaction, before the pointer write.
     *
     * This is the load-bearing half of `plans/refunds.md` §2.2, and it is also
     * what closes the race a caller-side check cannot. The `UPDATE` above
     * locks the membership row when it matches, so a concurrent add or remove
     * of the same guild serializes behind it; and if the guild has since moved
     * to another pool, nothing matches, this throws, and the rollback means
     * `setPoolId` never nulls the OTHER pool's pointer. A check made before
     * the transaction is read-then-write and cannot promise either.
     */
    if (!removed) throw new GuildNotInPoolError(guildId, poolId);
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
