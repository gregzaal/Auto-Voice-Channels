import { RUNTIME_FLAGS, type RuntimeFlagsRepository } from '@avc/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from './testUtils.js';
import { RuntimeCreationGate } from './creationGate.js';

/** Minimal in-memory stand-in for the flags repo (only getAll is used). */
function fakeFlags(values: Record<string, unknown> = {}): RuntimeFlagsRepository {
  return {
    getAll: () => Promise.resolve(values),
  } as unknown as RuntimeFlagsRepository;
}

describe('RuntimeCreationGate', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('allows creation when no flags are set', async () => {
    const gate = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
  });

  it('denies creation under global pause', async () => {
    const gate = new RuntimeCreationGate({
      flags: fakeFlags({ [RUNTIME_FLAGS.GLOBAL_PAUSE]: true }),
      logger: fakeLogger(),
    });
    const decision = await gate.allowCreate('g1');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/pause/);
  });

  it('throttles per guild once the rate limit is hit, isolating other guilds', async () => {
    const gate = new RuntimeCreationGate({
      flags: fakeFlags({ [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 2 }),
      logger: fakeLogger(),
      flagCacheMs: 0,
    });
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
    expect((await gate.allowCreate('g1')).allowed).toBe(false); // 3rd within window

    // A different guild is unaffected.
    expect((await gate.allowCreate('g2')).allowed).toBe(true);
  });

  it('lets the window slide so creation resumes after it passes', async () => {
    vi.useFakeTimers();
    const gate = new RuntimeCreationGate({
      flags: fakeFlags({ [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1 }),
      logger: fakeLogger(),
      flagCacheMs: 0,
      windowMs: 1000,
    });
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
    expect((await gate.allowCreate('g1')).allowed).toBe(false);
    vi.advanceTimersByTime(1100);
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
  });

  it('caches the flag snapshot to avoid a read per create', async () => {
    const getAll = vi.fn().mockResolvedValue({});
    const gate = new RuntimeCreationGate({
      flags: { getAll } as unknown as RuntimeFlagsRepository,
      logger: fakeLogger(),
      flagCacheMs: 10_000,
    });
    await gate.allowCreate('g1');
    await gate.allowCreate('g1');
    expect(getAll).toHaveBeenCalledTimes(1);
  });
  /**
   * `plans/scaling.md` §6.1's live half, which `ownsGuild` does not cover.
   *
   * `ownsGuild` is consulted by the reconcile sweep and by nothing on the join
   * path, so an instance whose lease had aged out stopped pruning rows and
   * carried on creating them. Discord delivers the same VOICE_STATE_UPDATE to
   * every open session for a shard, so once a peer claims the same shard both
   * instances create a room on the same join.
   */
  describe('the shard lease', () => {
    it('declines creation when the lease cannot be proven', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({}),
        logger: fakeLogger(),
        leasesProven: () => false,
      });
      const decision = await gate.allowCreate('g1');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('lease');
    });

    it('allows creation once the lease is provable again', async () => {
      let proven = false;
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({}),
        logger: fakeLogger(),
        leasesProven: () => proven,
      });
      expect((await gate.allowCreate('g1')).allowed).toBe(false);
      proven = true;
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /** Absent means one instance holding every shard, where it is never in doubt. */
    it('is unaffected when no lease check is supplied', async () => {
      const gate = new RuntimeCreationGate({ flags: fakeFlags({}), logger: fakeLogger() });
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /**
     * Checked before the flag read, so an unprovable lease needs no database
     * round trip to decline. That matters because the likeliest reason the lease
     * cannot be refreshed is the database being unreachable.
     */
    it('declines without reading the flags at all', async () => {
      const flags = fakeFlags({});
      const spy = vi.spyOn(flags, 'getAll');
      const gate = new RuntimeCreationGate({
        flags,
        logger: fakeLogger(),
        leasesProven: () => false,
      });
      await gate.allowCreate('g1');
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
