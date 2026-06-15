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
});
