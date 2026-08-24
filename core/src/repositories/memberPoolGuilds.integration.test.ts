import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuildRepository } from './guilds.js';
import { MemberPoolGuildRepository, promoteSubscriptionToPool } from './memberPoolGuilds.js';
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
