import { describe, expect, it, vi } from 'vitest';
import type { ShardLeaseRepository } from '@avc/core';
import { ShardLeaseManager } from './shardLeaseManager.js';
import { fakeLogger } from './testUtils.js';

const noop = async (): Promise<void> => {};

function fakeRepo(overrides: Partial<ShardLeaseRepository> = {}): ShardLeaseRepository {
  const repo = {
    claimAvailable: vi.fn(async () => [0, 1, 2]),
    heartbeat: vi.fn(async () => [0, 1, 2]),
    releaseAll: vi.fn(async () => 3),
    ...overrides,
  };
  return repo as unknown as ShardLeaseRepository;
}

describe('ShardLeaseManager', () => {
  it('claims available shards and tracks ownership', async () => {
    const repo = fakeRepo();
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 3,
    });
    const claimed = await mgr.claim();
    expect(claimed).toEqual([0, 1, 2]);
    expect(mgr.ownedShards).toEqual([0, 1, 2]);
  });

  it('passes its per-instance cap to the repo (fleet distribution)', async () => {
    const repo = fakeRepo({ claimAvailable: vi.fn(async () => [0, 1]) });
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 6,
      maxShards: 2,
    });
    await mgr.claim();
    expect(repo.claimAvailable).toHaveBeenCalledWith('i1', 6, expect.any(Number), 2);
  });

  it('claimWithRetry retries while making progress until it reaches the cap', async () => {
    let call = 0;
    const repo = fakeRepo({
      claimAvailable: vi.fn(async () => {
        call += 1;
        return call === 1 ? [] : call === 2 ? [0] : [0, 1];
      }),
    });
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 2,
      maxShards: 2,
      sleep: noop,
    });
    const claimed = await mgr.claimWithRetry();
    expect(claimed).toEqual([0, 1]);
    expect(repo.claimAvailable).toHaveBeenCalledTimes(3);
  });

  it('claimWithRetry stops early once a pass frees nothing more (has its share)', async () => {
    const repo = fakeRepo({ claimAvailable: vi.fn(async () => [0]) });
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 2,
      maxShards: 2,
      sleep: noop,
    });
    const claimed = await mgr.claimWithRetry();
    expect(claimed).toEqual([0]);
    // initial claim + one no-progress retry, then break.
    expect(repo.claimAvailable).toHaveBeenCalledTimes(2);
  });

  it('heartbeatOnce reacts to a lost lease (orchestrator-driven failover)', async () => {
    const onLeaseLost = vi.fn();
    const repo = fakeRepo({
      claimAvailable: vi.fn(async () => [0, 1, 2]),
      heartbeat: vi.fn(async () => [0, 2]), // shard 1 was stolen
    });
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 3,
      onLeaseLost,
    });
    await mgr.claim();
    await mgr.heartbeatOnce();
    expect(onLeaseLost).toHaveBeenCalledWith([1]);
    expect(mgr.ownedShards).toEqual([0, 2]);
  });

  /**
   * `plans/scaling.md` §9.1 finding 2: an unfiltered heartbeat re-adopts every
   * row bearing this instance id, including a shard it no longer serves after
   * a config change between restarts. Filtering by the currently-owned set is
   * what lets that stale row age out and become reclaimable by the peer that's
   * actually supposed to hold it.
   */
  it('heartbeatOnce passes only the currently-owned shard ids to the repo', async () => {
    const repo = fakeRepo({
      claimAvailable: vi.fn(async () => [0, 2]),
      heartbeat: vi.fn(async () => [0, 2]),
    });
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 3,
    });
    await mgr.claim();
    await mgr.heartbeatOnce();
    expect(repo.heartbeat).toHaveBeenCalledWith('i1', [0, 2]);
  });

  it('ownsGuild resolves the Discord shard formula against currently owned shards', async () => {
    const repo = fakeRepo({ claimAvailable: vi.fn(async () => [1]) });
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 2,
    });
    await mgr.claim(); // owns [1]
    // (462606582367125509n >> 22n) % 2n === 1n — a real guild id, verified
    // against the live beta database (plans/scaling.md §9.4).
    expect(mgr.ownsGuild('462606582367125509')).toBe(true);
    // (332246283601313794n >> 22n) % 2n === 0n
    expect(mgr.ownsGuild('332246283601313794')).toBe(false);
  });

  it('heartbeatOnce does not fire the loss handler when nothing was lost', async () => {
    const onLeaseLost = vi.fn();
    const repo = fakeRepo();
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 3,
      onLeaseLost,
    });
    await mgr.claim();
    await mgr.heartbeatOnce();
    expect(onLeaseLost).not.toHaveBeenCalled();
    expect(mgr.ownedShards).toEqual([0, 1, 2]);
  });

  it('heartbeatOnce swallows repo errors', async () => {
    const failing = fakeRepo({
      heartbeat: vi.fn(async () => Promise.reject(new Error('db down'))),
    });
    const mgr = new ShardLeaseManager({
      repo: failing,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 1,
    });
    await expect(mgr.heartbeatOnce()).resolves.toBeUndefined();
  });

  it('releaseAll clears ownership and stops the heartbeat timer', async () => {
    const repo = fakeRepo();
    const cleared: unknown[] = [];
    const mgr = new ShardLeaseManager({
      repo,
      logger: fakeLogger(),
      instanceId: 'i1',
      totalShards: 3,
      setInterval: ((fn: () => void) => {
        void fn;
        return 123 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: ((handle: unknown) => {
        cleared.push(handle);
      }) as typeof clearInterval,
    });
    await mgr.claim();
    mgr.startHeartbeat();
    await mgr.releaseAll();
    expect(mgr.ownedShards).toEqual([]);
    expect(repo.releaseAll).toHaveBeenCalledWith('i1');
    expect(cleared).toContain(123);
  });
  /**
   * `plans/scaling.md` §6.1, which the roadmap called "visible, unfixed" and
   * summarised as: an alert is a human being told, not the process stepping
   * aside.
   *
   * A heartbeat that fails leaves the lease row ageing past its 30s TTL while
   * this instance keeps its gateway session. A booting peer then legitimately
   * claims the same shard and TWO instances serve one guild: duplicate rooms,
   * duplicate renames, and the only trace a log line on a fleet running at info.
   */
  describe('standing aside when ownership cannot be proven', () => {
    const managerWithClock = (repo: ShardLeaseRepository, report = vi.fn()) =>
      new ShardLeaseManager({
        repo,
        logger: fakeLogger(),
        instanceId: 'i1',
        totalShards: 4,
        leaseTtlMs: 30_000,
        report,
      });

    it('serves immediately after a claim, before any heartbeat has landed', async () => {
      const mgr = managerWithClock(fakeRepo({ claimAvailable: vi.fn(async () => [0]) }));
      await mgr.claim();
      // The claim is itself proof, or a fresh machine would refuse to serve for
      // its whole first heartbeat interval.
      expect(mgr.leasesProven()).toBe(true);
      expect(mgr.ownsGuild('0')).toBe(true);
    });

    it('stops claiming ownership once the lease is older than its TTL', async () => {
      const mgr = managerWithClock(fakeRepo({ claimAvailable: vi.fn(async () => [0]) }));
      await mgr.claim();
      const past = Date.now() + 31_000;
      expect(mgr.leasesProven(past)).toBe(false);
    });

    /**
     * The whole point: everything scoped by shard ownership declines on its own
     * rather than each caller needing to know about heartbeats.
     */
    it('makes ownsGuild false while unproven, so scoped work stops', async () => {
      const repo = fakeRepo({
        claimAvailable: vi.fn(async () => [0]),
        heartbeat: vi.fn(async () => {
          throw new Error('connection terminated unexpectedly');
        }),
      });
      const mgr = managerWithClock(repo);
      await mgr.claim();
      // Age the claim past the TTL, then let a beat fail.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await mgr.heartbeatOnce();
        expect(mgr.leasesProven()).toBe(false);
        expect(mgr.ownsGuild('0')).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    });

    /**
     * The `report` hook was added for exactly this condition and then never
     * called from the catch, so the one failure that leads to two instances
     * serving one shard produced no alert from the component that detects it.
     */
    it('reports standing aside, once per episode rather than once per beat', async () => {
      const report = vi.fn();
      const repo = fakeRepo({
        claimAvailable: vi.fn(async () => [0]),
        heartbeat: vi.fn(async () => {
          throw new Error('pool exhausted');
        }),
      });
      const mgr = managerWithClock(repo, report);
      await mgr.claim();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await mgr.heartbeatOnce();
        await mgr.heartbeatOnce();
        await mgr.heartbeatOnce();
        const standAside = report.mock.calls.filter((c) => c[0] === 'shard.lease_unproven');
        expect(standAside).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('serves again, and says so, once a heartbeat lands', async () => {
      const report = vi.fn();
      let fail = true;
      const repo = fakeRepo({
        claimAvailable: vi.fn(async () => [0]),
        heartbeat: vi.fn(async () => {
          if (fail) throw new Error('down');
          return [0];
        }),
      });
      const mgr = managerWithClock(repo, report);
      await mgr.claim();
      const base = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(base + 31_000);
      try {
        await mgr.heartbeatOnce();
        expect(mgr.ownsGuild('0')).toBe(false);

        fail = false;
        await mgr.heartbeatOnce();
        expect(mgr.leasesProven(base + 31_000)).toBe(true);
        expect(mgr.ownsGuild('0')).toBe(true);
        expect(report.mock.calls.some((c) => c[0] === 'shard.lease_recovered')).toBe(true);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('is unproven when it owns nothing at all', () => {
      const mgr = managerWithClock(fakeRepo());
      expect(mgr.leasesProven()).toBe(false);
    });
  });
});
