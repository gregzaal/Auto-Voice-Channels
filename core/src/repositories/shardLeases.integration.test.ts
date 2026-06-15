import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ShardLeaseRepository } from './shardLeases.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { shardLeases } from '../db/schema.js';

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
  });

  it('a single instance claims all shards', async () => {
    const claimed = await repo.claimAvailable('inst-A', 4, 30_000);
    expect(claimed).toEqual([0, 1, 2, 3]);
  });

  it('a second instance cannot steal a freshly-held lease', async () => {
    await repo.claimAvailable('inst-A', 2, 30_000);
    const stolen = await repo.claimAvailable('inst-B', 2, 30_000);
    expect(stolen).toEqual([]); // A's leases are fresh
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

  it("heartbeat refreshes only the owner's leases", async () => {
    await repo.claimAvailable('inst-A', 3, 30_000);
    const before = await repo.list();
    await new Promise((r) => setTimeout(r, 20));
    const count = await repo.heartbeat('inst-A');
    expect(count).toBe(3);
    const after = await repo.list();
    for (let i = 0; i < 3; i++) {
      expect(after[i]!.heartbeatAt!.getTime()).toBeGreaterThan(before[i]!.heartbeatAt!.getTime());
    }
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

  it('withIdentifyLock serializes concurrent critical sections', async () => {
    const order: string[] = [];
    const run = (label: string) =>
      repo.withIdentifyLock(async () => {
        order.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, 40));
        order.push(`${label}-end`);
      });
    await Promise.all([run('A'), run('B')]);
    // Whichever started first must fully finish before the other starts.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0]!.replace('-start', '-end'));
  });
});
