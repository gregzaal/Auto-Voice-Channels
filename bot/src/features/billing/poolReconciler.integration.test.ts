import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingNotificationRepository,
  BillingRunRepository,
  GuildAlreadyPooledError,
  GuildRepository,
  MemberPoolGuildRepository,
  MemberPoolRepository,
  OpsAuditRepository,
  poolExitTransition,
  RuntimeFlagsRepository,
  SubscriptionRepository,
  type LeniencyNotification,
} from '@avc/core';
import { startPostgres, type PgTestEnv } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { BillingReconciler } from './reconciler.js';
import type { BillingNotifier } from './notifier.js';

/**
 * The pool pass's convergence, idempotency-under-concurrency and stranding
 * guarantees (`plans/member-based-pricing.md` §10). Separate file from the
 * per-guild ladder's own integration suite because these scenarios are
 * pool-shaped rather than guild-shaped from the start.
 */

class RecordingNotifier implements BillingNotifier {
  readonly notifications: { guildId: string; notification: LeniencyNotification }[] = [];
  async notifyGuild(guildId: string, notification: LeniencyNotification): Promise<boolean> {
    this.notifications.push({ guildId, notification });
    return false; // dedupe stays unstamped; these tests assert on state, not delivery
  }
  async welcomeGuild(): Promise<boolean> {
    return false;
  }
  async notifyPurchaser(): Promise<boolean> {
    return false;
  }
}

describe('BillingReconciler pool pass (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let pools: MemberPoolRepository;
  let poolGuilds: MemberPoolGuildRepository;
  let subscriptions: SubscriptionRepository;
  let flags: RuntimeFlagsRepository;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    pools = new MemberPoolRepository(env.handle.db);
    poolGuilds = new MemberPoolGuildRepository(env.handle.db);
    subscriptions = new SubscriptionRepository(env.handle.db);
    flags = new RuntimeFlagsRepository(env.handle.db);
    await flags.set('billing.reconcile_disabled', false, { actor: 'test' });
  });

  afterAll(async () => {
    await env?.stop();
  });

  function makeReconciler(now: () => Date, notifier = new RecordingNotifier()) {
    const reconciler = new BillingReconciler({
      guilds,
      store: guilds,
      subscriptions,
      runs: new BillingRunRepository(env.handle.db),
      notifications: new BillingNotificationRepository(env.handle.db),
      flags,
      memberPools: pools,
      memberPoolGuilds: poolGuilds,
      resolveDiscordUserId: async () => null,
      opsAudit: new OpsAuditRepository(env.handle.db),
      notifier,
      listCachedGuildCounts: () => [],
      fetchAuthoritativeCount: async () => null,
      logger: fakeLogger(),
      instanceId: 'test-instance',
      fleet: 'prod',
      advanceSpacingMs: 0,
      now,
    });
    return { reconciler, notifier };
  }

  async function guildAuthEventCount(guildId: string): Promise<number> {
    const result = await env.handle.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM guild_auth_events WHERE guild_id = $1',
      [guildId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  it('converges every live member guild to the pool status and billed tier', async () => {
    const poolId = 'pool-converge-1';
    const g1 = 'pool-converge-g1';
    const g2 = 'pool-converge-g2';
    const now = new Date('2026-08-24T00:00:00.000Z');

    await pools.create({ id: poolId, ownerUserId: 'user-1', name: 'Test pool', billedTier: 'm' });
    await subscriptions.upsertForPool({
      poolId,
      paddleSubscriptionId: `sub_${poolId}`,
      paddleCustomerId: 'ctm_1',
      purchaserUserId: 'user-1',
      tier: 'm',
      status: 'active',
    });
    for (const guildId of [g1, g2]) {
      await guilds.ensure(guildId);
      await guilds.recordMemberCountSample(guildId, 5_000, { at: now, authoritative: true });
      await poolGuilds.add(poolId, guildId);
      await guilds.setPoolId(guildId, poolId, null);
    }

    const { reconciler } = makeReconciler(() => now);
    await reconciler.runOnce();

    for (const guildId of [g1, g2]) {
      const row = await guilds.getOrThrow(guildId);
      expect(row.authStatus).toBe('active');
      expect(row.tier).toBe('m');
    }
  });

  it('is idempotent under two concurrent passes: no duplicate audit rows, no thrash', async () => {
    const poolId = 'pool-concurrent-1';
    const guildId = 'pool-concurrent-g1';
    const now = new Date('2026-08-24T00:00:00.000Z');

    await pools.create({
      id: poolId,
      ownerUserId: 'user-2',
      name: 'Concurrent pool',
      billedTier: 'm',
    });
    await subscriptions.upsertForPool({
      poolId,
      paddleSubscriptionId: `sub_${poolId}`,
      paddleCustomerId: 'ctm_2',
      purchaserUserId: 'user-2',
      tier: 'm',
      status: 'active',
    });
    await guilds.ensure(guildId);
    await guilds.recordMemberCountSample(guildId, 5_000, { at: now, authoritative: true });
    await poolGuilds.add(poolId, guildId);
    await guilds.setPoolId(guildId, poolId, null);

    const before = await guildAuthEventCount(guildId);

    /**
     * Two independent reconciler instances, same tick, run concurrently -
     * exactly the overlap §6.5 warns the 55-minute spacing alone cannot
     * prevent once a pass runs long. Both read the guild's PRE-convergence
     * status and both decide a write is due.
     *
     * **Exactly one row, not "at most two".** This used to accept a bounded
     * one-time duplicate, because the diff was a read followed by a write. The
     * fan-out now passes `skipIfUnchanged`, so the loser blocks on
     * `transitionAuth`'s own `SELECT ... FOR UPDATE`, reads what the winner
     * committed, and returns without writing.
     */
    const { reconciler: a } = makeReconciler(() => now);
    const { reconciler: b } = makeReconciler(() => now);
    await Promise.all([a.runOnce(), b.runOnce()]);
    const afterRace = await guildAuthEventCount(guildId);
    expect(afterRace - before).toBe(1);

    // The steady-state guarantee: once converged, a THIRD pass (sequential,
    // reading the now-converged state) must add nothing further.
    const { reconciler: c } = makeReconciler(() => now);
    await c.runOnce();
    const afterSteadyState = await guildAuthEventCount(guildId);
    expect(afterSteadyState).toBe(afterRace);

    const row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('active');
    expect(row.tier).toBe('m');
  });

  it('refuses a guild already in a different live pool', async () => {
    const poolA = 'pool-refuse-a';
    const poolB = 'pool-refuse-b';
    const guildId = 'pool-refuse-g1';
    await pools.create({ id: poolA, ownerUserId: 'user-3', name: 'A', billedTier: 's' });
    await pools.create({ id: poolB, ownerUserId: 'user-3', name: 'B', billedTier: 's' });
    await poolGuilds.add(poolA, guildId);
    await expect(poolGuilds.add(poolB, guildId)).rejects.toBeInstanceOf(GuildAlreadyPooledError);
  });

  it('leaving a pool lands the guild on grace with a fresh window, never expired', async () => {
    const poolId = 'pool-exit-1';
    const guildId = 'pool-exit-g1';
    const now = new Date('2026-08-24T00:00:00.000Z');

    await pools.create({ id: poolId, ownerUserId: 'user-4', name: 'Exit pool', billedTier: 'm' });
    await guilds.ensure(guildId);
    await guilds.recordMemberCountSample(guildId, 5_000, { at: now, authoritative: true });
    await poolGuilds.add(poolId, guildId);
    await guilds.setPoolId(guildId, poolId, 'm');
    // Simulate the pool having already hard-gated before the guild left.
    await guilds.transitionAuth({
      guildId,
      toStatus: 'expired',
      reason: 'pool:test',
      graceUntil: null,
    });

    // The exact sequence `removeGuildFromPool` and the bot's `guildDelete`
    // path both run: mark removed, clear the pointer, recompute fresh.
    await poolGuilds.remove(poolId, guildId, now);
    const row = await guilds.getOrThrow(guildId);
    await guilds.setPoolId(guildId, null, null);
    const exit = poolExitTransition(row.memberCount, now);
    await guilds.transitionAuth({
      guildId,
      toStatus: exit.toStatus,
      reason: exit.reason,
      graceUntil: exit.graceUntil,
    });

    const after = await guilds.getOrThrow(guildId);
    expect(after.authStatus).toBe('grace');
    expect(after.authStatus).not.toBe('expired');
    expect(after.graceUntil).toEqual(new Date(now.getTime() + 60 * 86_400_000));
    expect(after.poolId).toBeNull();
  });

  it('a guild whose own size is free-forever is untouched by the pool pass', async () => {
    const poolId = 'pool-free-member';
    const freeGuild = 'pool-free-g1';
    const now = new Date('2026-08-24T00:00:00.000Z');

    await pools.create({
      id: poolId,
      ownerUserId: 'user-5',
      name: 'Free member pool',
      billedTier: 'm',
    });
    await subscriptions.upsertForPool({
      poolId,
      paddleSubscriptionId: `sub_${poolId}`,
      paddleCustomerId: 'ctm_5',
      purchaserUserId: 'user-5',
      tier: 'm',
      status: 'active',
    });
    await guilds.ensure(freeGuild);
    await guilds.recordMemberCountSample(freeGuild, 50, { at: now, authoritative: true });
    await poolGuilds.add(poolId, freeGuild);
    await guilds.setPoolId(freeGuild, poolId, null);

    const { reconciler } = makeReconciler(() => now);
    await reconciler.runOnce();

    // Untouched: still whatever a fresh guild row starts as, never fanned the
    // pool's tier onto a server that is free regardless of pooling (§5.3).
    const row = await guilds.getOrThrow(freeGuild);
    expect(row.tier).toBeNull();
    expect(row.authStatus).toBe('trial');
  });
});
