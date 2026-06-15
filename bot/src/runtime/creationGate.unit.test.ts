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
});
