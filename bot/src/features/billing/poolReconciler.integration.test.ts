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

  it('never writes over a blocked member, but still keeps its billed tier in step', async () => {
    /**
     * `plans/refunds.md` §2.7. `advanceGuild` guards `blocked` but deliberately
     * skips pooled non-free guilds, so this pass is their only evaluator and
     * was laundering the abuse kill-switch into the pool's status.
     *
     * The tier write is deliberately still expected: skipping both would let a
     * blocked member's billed tier drift from the subscription's, and
     * `guilds.tier` entitles nothing on its own.
     */
    const poolId = 'pool-blocked-1';
    const blocked = 'pool-blocked-g1';
    const ordinary = 'pool-blocked-g2';
    const now = new Date('2026-08-24T00:00:00.000Z');

    await pools.create({
      id: poolId,
      ownerUserId: 'user-b',
      name: 'Blocked pool',
      billedTier: 'm',
    });
    await subscriptions.upsertForPool({
      poolId,
      paddleSubscriptionId: `sub_${poolId}`,
      paddleCustomerId: 'ctm_b',
      purchaserUserId: 'user-b',
      tier: 'm',
      status: 'active',
    });
    for (const guildId of [blocked, ordinary]) {
      await guilds.ensure(guildId);
      await guilds.recordMemberCountSample(guildId, 5_000, { at: now, authoritative: true });
      await poolGuilds.add(poolId, guildId);
      await guilds.setPoolId(guildId, poolId, null);
    }
    await guilds.transitionAuth({
      guildId: blocked,
      toStatus: 'blocked',
      reason: 'abuse',
      actor: 'test',
    });
    const auditBefore = await guildAuthEventCount(blocked);

    const { reconciler } = makeReconciler(() => now);
    await reconciler.runOnce();

    const blockedRow = await guilds.getOrThrow(blocked);
    expect(blockedRow.authStatus).toBe('blocked');
    expect(blockedRow.tier).toBe('m');
    expect(await guildAuthEventCount(blocked)).toBe(auditBefore);

    // The rest of the pool still converged, so this is a skip and not a stall.
    expect((await guilds.getOrThrow(ordinary)).authStatus).toBe('active');
  });

  it("floors a refunded subscription's members and then writes NOTHING on later ticks", async () => {
    /**
     * `plans/refunds.md` §12's three-tick test. A single tick cannot see thrash:
     * the old fan-out wrote `pool.status` verbatim, so a per-guild floor written
     * by the refund webhook was overwritten within the hour, and re-applying it
     * would have alternated forever at two audit rows and a cache eviction per
     * member per tick.
     *
     * Four members, one per landing state, so the same three ticks also assert
     * the blocked guard and the free-sized exclusion.
     */
    const poolId = 'pool-floor-1';
    const now = new Date('2026-08-24T00:00:00.000Z');
    const spentTrial = 'floor-spent';
    const liveTrial = 'floor-live';
    const freeSized = 'floor-free';
    const blocked = 'floor-blocked';

    await pools.create({ id: poolId, ownerUserId: 'user-f', name: 'Refunded', billedTier: 'm' });
    await subscriptions.upsertForPool({
      poolId,
      paddleSubscriptionId: `sub_${poolId}`,
      paddleCustomerId: 'ctm_f',
      purchaserUserId: 'user-f',
      tier: 'm',
      status: 'active',
    });
    // Refunded: standing is revoked while Paddle still reports `active`.
    await subscriptions.applyAdjustment(
      {
        adjustmentId: 'adj_floor',
        paddleSubscriptionId: `sub_${poolId}`,
        transactionId: null,
        action: 'refund',
        status: 'approved',
        type: 'full',
        total: '3900',
        currency: 'USD',
        updatedAt: now,
      },
      { kind: 'settle', reason: 'full_approved' },
    );
    await pools.transitionStatus({
      poolId,
      toStatus: 'expired',
      reason: 'refunded',
      actor: 'test',
      graceUntil: null,
    });

    for (const [guildId, members] of [
      [spentTrial, 5_000],
      [liveTrial, 5_000],
      [freeSized, 40],
      [blocked, 5_000],
    ] as const) {
      await guilds.ensure(guildId);
      await guilds.recordMemberCountSample(guildId, members, { at: now, authoritative: true });
      await poolGuilds.add(poolId, guildId);
      await guilds.setPoolId(guildId, poolId, null);
    }
    // A spent trial floors to `expired`; an unconsumed one resumes on its date.
    await guilds.transitionAuth({
      guildId: spentTrial,
      toStatus: 'active',
      reason: 'seed',
      actor: 'test',
      expiresAtIfNull: new Date('2026-01-01T00:00:00.000Z'),
    });
    await guilds.transitionAuth({
      guildId: liveTrial,
      toStatus: 'expired',
      reason: 'seed',
      actor: 'test',
      expiresAtIfNull: new Date('2027-06-16T00:00:00.000Z'),
    });
    await guilds.transitionAuth({
      guildId: blocked,
      toStatus: 'blocked',
      reason: 'abuse',
      actor: 'test',
    });

    const { reconciler } = makeReconciler(() => now);
    await reconciler.runOnce();

    // Tick one: each member lands on its own floor, not the pool's status.
    expect((await guilds.getOrThrow(spentTrial)).authStatus).toBe('expired');
    const lifted = await guilds.getOrThrow(liveTrial);
    expect(lifted.authStatus).toBe('trial');
    // Lifted onto its ORIGINAL date, not a fresh window.
    expect(lifted.authExpiresAt?.toISOString()).toBe('2027-06-16T00:00:00.000Z');
    expect((await guilds.getOrThrow(blocked)).authStatus).toBe('blocked');
    // Free-sized members are excluded from the billable set entirely.
    expect((await guilds.getOrThrow(freeSized)).authStatus).toBe('trial');

    const after1 = {
      spent: await guildAuthEventCount(spentTrial),
      live: await guildAuthEventCount(liveTrial),
      blocked: await guildAuthEventCount(blocked),
      free: await guildAuthEventCount(freeSized),
    };

    // Ticks two and three must write nothing at all.
    const later = new Date(now.getTime() + 3_600_000);
    const { reconciler: r2 } = makeReconciler(() => later);
    await r2.runOnce();
    const evenLater = new Date(now.getTime() + 7_200_000);
    const { reconciler: r3 } = makeReconciler(() => evenLater);
    await r3.runOnce();

    expect(await guildAuthEventCount(spentTrial)).toBe(after1.spent);
    expect(await guildAuthEventCount(liveTrial)).toBe(after1.live);
    expect(await guildAuthEventCount(blocked)).toBe(after1.blocked);
    expect(await guildAuthEventCount(freeSized)).toBe(after1.free);
    // And the lifted member still holds its own date.
    expect((await guilds.getOrThrow(liveTrial)).authExpiresAt?.toISOString()).toBe(
      '2027-06-16T00:00:00.000Z',
    );
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
