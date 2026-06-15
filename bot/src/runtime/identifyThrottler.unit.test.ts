import { describe, expect, it, vi } from 'vitest';
import type { ShardLeaseRepository } from '@avc/core';
import { PgIdentifyThrottler } from './identifyThrottler.js';
import { fakeLogger } from './testUtils.js';

interface BuildOpts {
  maxConcurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  pollCapMs?: number;
}

function build(
  reserve: ShardLeaseRepository['reserveIdentify'],
  opts: BuildOpts = {},
): PgIdentifyThrottler {
  const repo = { reserveIdentify: reserve } as unknown as ShardLeaseRepository;
  return new PgIdentifyThrottler({
    repo,
    maxConcurrency: opts.maxConcurrency ?? 1,
    logger: fakeLogger(),
    spacingMs: opts.spacingMs ?? 5_000,
    pollCapMs: opts.pollCapMs ?? 1_000,
    sleep: opts.sleep ?? (async () => {}),
  });
}

const liveSignal = (): AbortSignal => new AbortController().signal;

describe('PgIdentifyThrottler', () => {
  it('resolves immediately when the bucket is free', async () => {
    const reserve = vi.fn(async () => ({ ok: true, waitMs: 0 }));
    await expect(build(reserve).waitForIdentify(0, liveSignal())).resolves.toBeUndefined();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(0, 5_000);
  });

  it('polls until the bucket frees, then resolves', async () => {
    let n = 0;
    const reserve = vi.fn(async () =>
      n++ < 2 ? { ok: false, waitMs: 50 } : { ok: true, waitMs: 0 },
    );
    const sleeps: number[] = [];
    await build(reserve, { sleep: async (ms) => void sleeps.push(ms) }).waitForIdentify(
      0,
      liveSignal(),
    );
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 50]);
  });

  it('maps a shard to its max_concurrency bucket', async () => {
    const reserve = vi.fn(async () => ({ ok: true, waitMs: 0 }));
    await build(reserve, { maxConcurrency: 4 }).waitForIdentify(6, liveSignal());
    expect(reserve).toHaveBeenCalledWith(2, 5_000); // 6 % 4
  });

  it('caps a single poll wait at pollCapMs', async () => {
    let n = 0;
    const reserve = vi.fn(async () =>
      n++ === 0 ? { ok: false, waitMs: 99_999 } : { ok: true, waitMs: 0 },
    );
    const sleeps: number[] = [];
    await build(reserve, {
      sleep: async (ms) => void sleeps.push(ms),
      pollCapMs: 1_000,
    }).waitForIdentify(0, liveSignal());
    expect(sleeps).toEqual([1_000]);
  });

  it('rejects without reserving when already aborted', async () => {
    const reserve = vi.fn(async () => ({ ok: true, waitMs: 0 }));
    const ac = new AbortController();
    ac.abort();
    await expect(build(reserve).waitForIdentify(0, ac.signal)).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled();
  });
});
