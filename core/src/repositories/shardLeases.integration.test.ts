import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ShardLeaseRepository } from './shardLeases.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { identifyBuckets, shardLeases } from '../db/schema.js';

describe('ShardLeaseRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: ShardLeaseRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new ShardLeaseRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(shardLeases);
    await env.handle.db.delete(identifyBuckets);
  });

  it('a single instance claims all shards', async () => {
    const claimed = await repo.claimAvailable('inst-A', 4, 30_000);
    expect(claimed).toEqual([0, 1, 2, 3]);
  });

  it('distributes shards across the fleet via the per-instance cap', async () => {
    // 4 shards, cap 2 → the first instance packs 0,1; the next packs 2,3.
    expect(await repo.claimAvailable('inst-A', 4, 30_000, 2)).toEqual([0, 1]);
    expect(await repo.claimAvailable('inst-B', 4, 30_000, 2)).toEqual([2, 3]);
    // A third instance gets nothing — the fleet is full (no overlap, none over cap).
    expect(await repo.claimAvailable('inst-C', 4, 30_000, 2)).toEqual([]);
  });

  it('a second instance cannot steal a freshly-held lease', async () => {
    await repo.claimAvailable('inst-A', 2, 30_000);
    const stolen = await repo.claimAvailable('inst-B', 2, 30_000);
    expect(stolen).toEqual([]); // A's leases are fresh
  });

  /**
   * `plans/fleets.md` §2: two live bots shard independently against one
   * database, so shard 0 exists once per fleet. Before the fleet column this was
   * impossible by construction, and getting it wrong in either direction is
   * severe: shared, and beta starves prod of shards; unscoped reads, and an
   * instance drops shards it still owns because a peer's rows are invisible.
   */
  describe('fleet isolation', () => {
    it('lets each fleet hold the same shard id at once', async () => {
      const beta = new ShardLeaseRepository(env.handle.db, 'beta');
      expect(await repo.claimAvailable('prod-A', 2, 30_000)).toEqual([0, 1]);
      // The same shard ids, from a fleet that cannot see prod's leases at all.
      expect(await beta.claimAvailable('beta-A', 2, 30_000)).toEqual([0, 1]);
    });

    it('never returns another fleet’s leases', async () => {
      const beta = new ShardLeaseRepository(env.handle.db, 'beta');
      await repo.claimAvailable('prod-A', 2, 30_000);
      await beta.claimAvailable('beta-A', 2, 30_000);

      expect((await repo.list()).every((l) => l.fleet === 'prod')).toBe(true);
      expect((await beta.list()).every((l) => l.fleet === 'beta')).toBe(true);
      expect(await repo.heartbeat('beta-A', [0, 1])).toEqual([]);
      expect(await beta.heartbeat('prod-A', [0, 1])).toEqual([]);
    });

    it('releases only within its own fleet', async () => {
      const beta = new ShardLeaseRepository(env.handle.db, 'beta');
      await repo.claimAvailable('shared-name', 2, 30_000);
      await beta.claimAvailable('shared-name', 2, 30_000);

      // Same instance id in both fleets: a cross-fleet release would strand the
      // other fleet's shards with no running owner and no lease-loss signal.
      expect(await beta.releaseAll('shared-name')).toBe(2);
      expect(await repo.heartbeat('shared-name', [0, 1])).toEqual([0, 1]);
    });

    it('throttles identifies per fleet, since max_concurrency is per application', async () => {
      const beta = new ShardLeaseRepository(env.handle.db, 'beta');
      expect((await repo.reserveIdentify(0, 5_000)).ok).toBe(true);
      // Prod just identified on bucket 0; beta is a different application and
      // must not be made to wait for it.
      expect((await beta.reserveIdentify(0, 5_000)).ok).toBe(true);
      // ...but prod is still spaced against its own previous identify.
      expect((await repo.reserveIdentify(0, 5_000)).ok).toBe(false);
    });
  });

  it('an expired lease is re-claimable by another instance', async () => {
    // A claims shard 0 normally.
    const a = await repo.claim(0, 'inst-A', 1, 30_000);
    expect(a?.instanceId).toBe('inst-A');
    // Age A's heartbeat past any reasonable TTL (simulate a dead instance).
    await env.handle.db
      .update(shardLeases)
      .set({ heartbeatAt: new Date(Date.now() - 60_000) })
      .where(eq(shardLeases.shardId, 0));
    // B claims with a 30s TTL; A's heartbeat is now older than the cutoff.
    const lease = await repo.claim(0, 'inst-B', 1, 30_000);
    expect(lease?.instanceId).toBe('inst-B');
  });

  it("heartbeat refreshes only the owner's leases and returns the owned shard ids", async () => {
    await repo.claimAvailable('inst-A', 3, 30_000);
    const before = await repo.list();
    await new Promise((r) => setTimeout(r, 20));
    const owned = await repo.heartbeat('inst-A', [0, 1, 2]);
    expect(owned).toEqual([0, 1, 2]);
    const after = await repo.list();
    for (let i = 0; i < 3; i++) {
      expect(after[i]!.heartbeatAt!.getTime()).toBeGreaterThan(before[i]!.heartbeatAt!.getTime());
    }
  });

  it('heartbeat omits a shard stolen by another instance (lease-loss signal)', async () => {
    await repo.claimAvailable('inst-A', 3, 30_000);
    // Age A's heartbeat so the lease is expired, then let B steal shard 1.
    await env.handle.db.update(shardLeases).set({ heartbeatAt: new Date(Date.now() - 60_000) });
    expect((await repo.claim(1, 'inst-B', 3, 30_000))?.instanceId).toBe('inst-B');
    // A's heartbeat, still passing its stale pre-heartbeat belief ([0,1,2] —
    // it doesn't yet know shard 1 was stolen), now refreshes only the shards
    // it still owns (0 and 2). That gap between belief and reality is exactly
    // how a caller learns a lease was lost.
    expect(await repo.heartbeat('inst-A', [0, 1, 2])).toEqual([0, 2]);
  });

  /**
   * `plans/scaling.md` §9.1 finding 2. Simulates an instance whose own belief
   * of what it owns has shrunk (e.g. a restart under a smaller cap between
   * Step A and Step B) while the database still carries its stale claim on a
   * shard it no longer serves. Before this fix, an unfiltered heartbeat would
   * refresh that row forever — this is what stops that: the row is left
   * alone, ages past the TTL, and becomes reclaimable by whoever the shard
   * actually belongs to now.
   */
  it('does not refresh a shard outside the given ids, even though still claimed', async () => {
    await repo.claimAvailable('inst-A', 2, 30_000); // claims [0, 1]
    const before = await repo.list();
    await new Promise((r) => setTimeout(r, 20));

    const owned = await repo.heartbeat('inst-A', [0]); // now believes it owns only [0]

    expect(owned).toEqual([0]);
    const after = await repo.list();
    expect(after[0]!.heartbeatAt!.getTime()).toBeGreaterThan(before[0]!.heartbeatAt!.getTime());
    // Shard 1: still claimed by inst-A in the DB, but NOT refreshed.
    expect(after[1]!.instanceId).toBe('inst-A');
    expect(after[1]!.heartbeatAt!.getTime()).toBe(before[1]!.heartbeatAt!.getTime());
  });

  it('release frees a lease only for its owner', async () => {
    await repo.claim(0, 'inst-A', 1, 30_000);
    expect(await repo.release(0, 'inst-B')).toBe(false); // wrong owner
    expect(await repo.release(0, 'inst-A')).toBe(true);
    const [lease] = await repo.list();
    expect(lease?.instanceId).toBeNull();
  });

  it('releaseAll releases every lease owned by the instance', async () => {
    await repo.claimAvailable('inst-A', 3, 30_000);
    const released = await repo.releaseAll('inst-A');
    expect(released).toBe(3);
    const leases = await repo.list();
    expect(leases.every((l) => l.instanceId === null)).toBe(true);
  });

  it('reserveIdentify enforces per-bucket spacing across the fleet', async () => {
    // First identify in a bucket is granted immediately.
    expect((await repo.reserveIdentify(0, 10_000)).ok).toBe(true);
    // A second, within the spacing window, is refused with the remaining wait.
    const again = await repo.reserveIdentify(0, 10_000);
    expect(again.ok).toBe(false);
    expect(again.waitMs).toBeGreaterThan(0);
    expect(again.waitMs).toBeLessThanOrEqual(10_000);
    // A different bucket is independent (parallel identify under max_concurrency).
    expect((await repo.reserveIdentify(1, 10_000)).ok).toBe(true);
    // Once the spacing elapses, the bucket frees again.
    await repo.reserveIdentify(2, 50);
    await new Promise((r) => setTimeout(r, 70));
    expect((await repo.reserveIdentify(2, 50)).ok).toBe(true);
  });

  it('reserveIdentify serializes concurrent reservations on the same bucket', async () => {
    // Two simultaneous reservations on one bucket: the advisory lock serializes the
    // check, so exactly one wins and the other is refused.
    const [a, b] = await Promise.all([
      repo.reserveIdentify(0, 10_000),
      repo.reserveIdentify(0, 10_000),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });
});
