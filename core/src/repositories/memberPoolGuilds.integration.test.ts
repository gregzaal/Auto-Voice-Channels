import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuildRepository } from './guilds.js';
import {
  GuildAlreadyPooledError,
  GuildNotInPoolError,
  MemberPoolGuildRepository,
  promoteSubscriptionToPool,
  removeGuildFromPoolAtomically,
} from './memberPoolGuilds.js';
import { MemberPoolRepository } from './memberPools.js';
import { SubscriptionRepository } from './subscriptions.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

/**
 * `promoteSubscriptionToPool` (`plans/member-based-pricing.md` §7.4
 * addendum): converting an ordinary guild subscription into a pool the first
 * time a second server is added to it. Real Postgres, because the whole
 * point is the `subscriptions_guild_xor_pool` check constraint and the
 * partial unique index backing pool membership, neither of which a mock
 * would exercise.
 */
describe('promoteSubscriptionToPool (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let subscriptions: SubscriptionRepository;
  let pools: MemberPoolRepository;
  let poolGuilds: MemberPoolGuildRepository;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    subscriptions = new SubscriptionRepository(env.handle.db);
    pools = new MemberPoolRepository(env.handle.db);
    poolGuilds = new MemberPoolGuildRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('re-keys the subscription onto a new pool and adds both guilds as live members', async () => {
    const originalGuild = 'promote-g1';
    const newGuild = 'promote-g2';
    await guilds.ensure(originalGuild);
    await guilds.ensure(newGuild);

    const sub = await subscriptions.upsert({
      guildId: originalGuild,
      paddleSubscriptionId: 'sub_promote_1',
      paddleCustomerId: 'ctm_promote_1',
      purchaserUserId: 'user-promote-1',
      tier: 'm',
      status: 'active',
    });

    const poolId = await promoteSubscriptionToPool(env.handle.db, {
      subscriptionId: sub.id,
      ownerUserId: 'user-promote-1',
      existingGuildId: originalGuild,
      newGuildId: newGuild,
      tier: 'm',
      poolName: 'Test promoted pool',
    });

    // The subscription now bills the pool, not the original guild, and the
    // xor constraint held: it never existed as both at once.
    const poolSub = await subscriptions.getByPoolId(poolId);
    expect(poolSub?.id).toBe(sub.id);
    expect(poolSub?.paddleSubscriptionId).toBe('sub_promote_1');
    expect(await subscriptions.getByGuild(originalGuild)).toBeUndefined();

    // Both guilds are live pool members, and both point back at the pool.
    const members = await poolGuilds.listLive(poolId);
    expect(members.map((m) => m.guildId).sort()).toEqual([newGuild, originalGuild].sort());

    const originalRow = await guilds.getOrThrow(originalGuild);
    const newRow = await guilds.getOrThrow(newGuild);
    expect(originalRow.poolId).toBe(poolId);
    expect(originalRow.tier).toBe('m');
    expect(newRow.poolId).toBe(poolId);
    expect(newRow.tier).toBe('m');

    const pool = await pools.getOrThrow(poolId);
    expect(pool.ownerUserId).toBe('user-promote-1');
    expect(pool.billedTier).toBe('m');
    expect(pool.status).toBe('active');
  });

  it('refuses to add a guild that is already live in a different pool', async () => {
    const originalGuild = 'promote-g3';
    const alreadyPooledGuild = 'promote-g4';
    await guilds.ensure(originalGuild);
    await guilds.ensure(alreadyPooledGuild);

    const otherPoolId = 'promote-other-pool';
    await pools.create({
      id: otherPoolId,
      ownerUserId: 'user-promote-2',
      name: 'Other pool',
      billedTier: 's',
    });
    await poolGuilds.add(otherPoolId, alreadyPooledGuild);

    const sub = await subscriptions.upsert({
      guildId: originalGuild,
      paddleSubscriptionId: 'sub_promote_2',
      paddleCustomerId: 'ctm_promote_2',
      purchaserUserId: 'user-promote-2',
      tier: 's',
      status: 'active',
    });

    await expect(
      promoteSubscriptionToPool(env.handle.db, {
        subscriptionId: sub.id,
        ownerUserId: 'user-promote-2',
        existingGuildId: originalGuild,
        newGuildId: alreadyPooledGuild,
        tier: 's',
        poolName: 'Should not exist',
      }),
    ).rejects.toThrow();

    // The whole transaction rolled back: the subscription is still guild-keyed.
    expect(await subscriptions.getByGuild(originalGuild)).toMatchObject({ id: sub.id });
  });
});

/**
 * The containment half of `plans/refunds.md` §2.2 and §2.10, both of which are
 * about what the repository does when the ids it is handed do not describe a
 * real membership. Integration rather than unit, because the behaviour IS the
 * primary key, the partial unique index and the transaction boundary.
 */
describe('pool membership guards (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let pools: MemberPoolRepository;
  let poolGuilds: MemberPoolGuildRepository;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    pools = new MemberPoolRepository(env.handle.db);
    poolGuilds = new MemberPoolGuildRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  async function makePool(id: string): Promise<string> {
    await pools.create({ id, ownerUserId: `owner-${id}`, name: id, billedTier: 'm' });
    return id;
  }

  it('refuses to remove a guild that is not in the pool, and leaves its pointer alone', async () => {
    const poolId = await makePool('guard-pool-1');
    const victimPoolId = await makePool('guard-pool-2');
    const victim = 'guard-victim-1';
    await guilds.ensure(victim);
    await poolGuilds.add(victimPoolId, victim);
    await guilds.setPoolId(victim, victimPoolId, 'm');

    // The attack in §2.2: authorized on one pool, naming a guild in another.
    await expect(removeGuildFromPoolAtomically(env.handle.db, poolId, victim)).rejects.toThrow(
      GuildNotInPoolError,
    );

    // The transaction rolled back BEFORE setPoolId, so the victim is untouched:
    // still live in its own pool, still pointing at it, tier intact.
    const row = await guilds.getOrThrow(victim);
    expect(row.poolId).toBe(victimPoolId);
    expect(row.tier).toBe('m');
    expect(await poolGuilds.livePoolFor(victim)).toBe(victimPoolId);
  });

  it('refuses to remove a guild that has never been seen at all, and creates no row for it', async () => {
    const poolId = await makePool('guard-pool-3');
    const stranger = 'guard-stranger-1';

    await expect(removeGuildFromPoolAtomically(env.handle.db, poolId, stranger)).rejects.toThrow(
      GuildNotInPoolError,
    );

    // `setPoolId` called `ensure`, so the old code INSERTED a guilds row for an
    // arbitrary snowflake as a side effect of a failed removal.
    expect(await guilds.get(stranger)).toBeUndefined();
  });

  it('reports a live removal, and stops reporting one after it happens', async () => {
    const poolId = await makePool('guard-pool-4');
    const guildId = 'guard-member-1';
    await guilds.ensure(guildId);
    await poolGuilds.add(poolId, guildId);

    expect(await poolGuilds.remove(poolId, guildId)).toBe(true);
    expect(await poolGuilds.remove(poolId, guildId)).toBe(false);
  });

  it('lets a removed server be added back to the same subscription', async () => {
    const poolId = await makePool('guard-pool-5');
    const guildId = 'guard-member-2';
    await guilds.ensure(guildId);
    await poolGuilds.add(poolId, guildId);
    await removeGuildFromPoolAtomically(env.handle.db, poolId, guildId);
    expect(await poolGuilds.livePoolFor(guildId)).toBeNull();

    // §2.10: the primary key made this a permanent refusal.
    await poolGuilds.add(poolId, guildId);
    expect(await poolGuilds.livePoolFor(guildId)).toBe(poolId);
    expect((await poolGuilds.listLive(poolId)).map((m) => m.guildId)).toEqual([guildId]);
  });

  it('still refuses a guild already live in this pool, and says which cause it was', async () => {
    const poolId = await makePool('guard-pool-6');
    const guildId = 'guard-member-3';
    await guilds.ensure(guildId);
    await poolGuilds.add(poolId, guildId);

    await expect(poolGuilds.add(poolId, guildId)).rejects.toMatchObject({ samePool: true });
  });

  it('still refuses a guild live in a DIFFERENT pool, even one it previously left', async () => {
    const first = await makePool('guard-pool-7');
    const second = await makePool('guard-pool-8');
    const guildId = 'guard-member-4';
    await guilds.ensure(guildId);

    // Membership history in `first`, currently live in `second`.
    await poolGuilds.add(first, guildId);
    await removeGuildFromPoolAtomically(env.handle.db, first, guildId);
    await poolGuilds.add(second, guildId);

    // Reviving the historical row must still trip the live-guild index, and
    // report the cause that actually means "already on a subscription".
    await expect(poolGuilds.add(first, guildId)).rejects.toBeInstanceOf(GuildAlreadyPooledError);
    await expect(poolGuilds.add(first, guildId)).rejects.toMatchObject({ samePool: false });
    expect(await poolGuilds.livePoolFor(guildId)).toBe(second);
  });
});
