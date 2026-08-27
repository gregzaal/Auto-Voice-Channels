import { RUNTIME_FLAGS, type GuildFleetPresenceRepository, type Logger } from '@avc/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TopggApiError, type TopggClient } from '../ops/topgg.js';
import { TopggScheduler, type TopggSchedulerDeps } from './topggScheduler.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

interface Harness {
  scheduler: TopggScheduler;
  postMetrics: ReturnType<typeof vi.fn>;
  putCommands: ReturnType<typeof vi.fn>;
  countPresent: ReturnType<typeof vi.fn>;
  report: ReturnType<typeof vi.fn>;
  flags: Record<string, unknown>;
  clock: { now: number };
  owns: { value: boolean };
  timers: { handler: () => void; ms: number }[];
  cleared: unknown[];
}

function harness(overrides: Partial<TopggSchedulerDeps> = {}): Harness {
  const flags: Record<string, unknown> = {};
  const clock = { now: 1_700_000_000_000 };
  const owns = { value: true };
  const postMetrics = vi.fn(() => Promise.resolve());
  const putCommands = vi.fn(() => Promise.resolve());
  const countPresent = vi.fn(() => Promise.resolve(5556));
  const report = vi.fn();
  // Records what `start()` actually scheduled, so the timer wiring is testable
  // rather than merely stubbed out.
  const timers: { handler: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];

  const scheduler = new TopggScheduler({
    client: { postMetrics, putCommands } as unknown as TopggClient,
    flags: { getAll: () => Promise.resolve(flags) } as never,
    presence: { countPresent } as unknown as GuildFleetPresenceRepository,
    logger,
    totalShards: 4,
    ownsListing: () => owns.value,
    commands: () => [{ name: 'ping', description: 'Pong.', type: 1 } as never],
    report,
    setIntervalFn: ((handler: () => void, ms: number) => {
      timers.push({ handler, ms });
      // A deliberate 0, which is a legal handle and the one a truthiness check
      // on `this.timer` would mistake for "not started".
      return 0;
    }) as unknown as typeof setInterval,
    clearIntervalFn: ((handle: unknown) => {
      cleared.push(handle);
    }) as unknown as typeof clearInterval,
    now: () => clock.now,
    ...overrides,
  });

  return {
    scheduler,
    postMetrics,
    putCommands,
    countPresent,
    report,
    flags,
    clock,
    owns,
    timers,
    cleared,
  };
}

describe('TopggScheduler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes the count from the presence table and the fleet shard total', async () => {
    const h = harness();
    await h.scheduler.tick();
    expect(h.postMetrics).toHaveBeenCalledWith({ serverCount: 5556, shardCount: 4 });
    expect(h.scheduler.stats.lastServerCount).toBe(5556);
    expect(h.scheduler.stats.lastError).toBeNull();
  });

  it('publishes the command list once per process, not once per tick', async () => {
    const h = harness();
    await h.scheduler.tick();
    h.clock.now += 60 * 60_000;
    await h.scheduler.tick();
    expect(h.putCommands).toHaveBeenCalledTimes(1);
    expect(h.postMetrics).toHaveBeenCalledTimes(2);
    expect(h.scheduler.stats.commandCount).toBe(1);
  });

  it('maps the commands to top.gg names before publishing them', async () => {
    const h = harness();
    await h.scheduler.tick();
    expect(h.putCommands).toHaveBeenCalledWith([
      { type: 'chat_input', name: 'ping', description: 'Pong.' },
    ]);
  });

  it('does not re-publish the count inside the post interval', async () => {
    const h = harness();
    await h.scheduler.tick();
    h.clock.now += 10 * 60_000;
    await h.scheduler.tick();
    expect(h.postMetrics).toHaveBeenCalledTimes(1);
  });

  /**
   * The guard that matters most. A zero here would blank the listing, which is
   * the exact state this job exists to fix, and it would look like success.
   */
  it('refuses to publish a server count of zero', async () => {
    const h = harness();
    h.countPresent.mockResolvedValue(0);
    await h.scheduler.tick();
    expect(h.postMetrics).not.toHaveBeenCalled();
    expect(h.scheduler.stats.lastError).toMatch(/refused/);
    expect(h.scheduler.stats.lastPostAt).toBeNull();
  });

  it('publishes nothing from an instance that does not hold shard 0', async () => {
    const h = harness();
    h.owns.value = false;
    await h.scheduler.tick();
    expect(h.postMetrics).not.toHaveBeenCalled();
    expect(h.putCommands).not.toHaveBeenCalled();
    expect(h.scheduler.stats.ownsListing).toBe(false);
  });

  it('starts publishing when this instance later takes shard 0', async () => {
    const h = harness();
    h.owns.value = false;
    await h.scheduler.tick();
    h.owns.value = true;
    await h.scheduler.tick();
    expect(h.postMetrics).toHaveBeenCalledTimes(1);
  });

  describe('the kill switches, each reported separately', () => {
    for (const [label, key] of [
      ['global.pause', RUNTIME_FLAGS.GLOBAL_PAUSE],
      ['topgg.disabled', RUNTIME_FLAGS.TOPGG_DISABLED],
      ['marketing.paused', RUNTIME_FLAGS.MARKETING_PAUSED],
    ] as const) {
      it(`${label} stops publishing`, async () => {
        const h = harness();
        h.flags[key] = true;
        await h.scheduler.tick();
        expect(h.postMetrics).not.toHaveBeenCalled();
        expect(h.putCommands).not.toHaveBeenCalled();
      });
    }

    /**
     * Not cosmetic. A forgotten flag freezing the listing for months is the real
     * failure mode, so "why is the count stale" has to be answerable from
     * `/diagnostics` without guessing which switch is set.
     */
    it('names which switch is set', async () => {
      const h = harness();
      h.flags[RUNTIME_FLAGS.MARKETING_PAUSED] = true;
      await h.scheduler.tick();
      const stats = h.scheduler.stats;
      expect(stats.marketingPaused).toBe(true);
      expect(stats.paused).toBe(false);
      expect(stats.disabled).toBe(false);
    });
  });

  it('honours a flag from the last readable snapshot when the database is down', async () => {
    const flags: Record<string, unknown> = { [RUNTIME_FLAGS.TOPGG_DISABLED]: true };
    let fail = false;
    const h = harness({
      flags: {
        getAll: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(flags)),
      } as never,
    });
    await h.scheduler.tick();
    fail = true;
    await h.scheduler.tick();
    expect(h.postMetrics).not.toHaveBeenCalled();
  });

  it('retries on the next tick after a failed post, and does not record it as sent', async () => {
    const h = harness();
    h.postMetrics.mockRejectedValueOnce(new TopggApiError(502, 'PATCH: HTTP 502'));
    await h.scheduler.tick();
    expect(h.scheduler.stats.lastPostAt).toBeNull();
    expect(h.scheduler.stats.lastError).toMatch(/502/);

    h.clock.now += 60_000;
    await h.scheduler.tick();
    expect(h.postMetrics).toHaveBeenCalledTimes(2);
    expect(h.scheduler.stats.lastPostAt).not.toBeNull();
    expect(h.scheduler.stats.lastError).toBeNull();
  });

  it('retries the command list on the next tick after a failure', async () => {
    const h = harness();
    h.putCommands.mockRejectedValueOnce(new TopggApiError(502, 'PUT: HTTP 502'));
    await h.scheduler.tick();
    expect(h.scheduler.stats.lastCommandError).toMatch(/502/);
    h.clock.now += 60_000;
    await h.scheduler.tick();
    expect(h.putCommands).toHaveBeenCalledTimes(2);
    expect(h.scheduler.stats.lastCommandError).toBeNull();
  });

  describe('a 429', () => {
    it('stands down for as long as it asked, then resumes', async () => {
      const h = harness();
      h.postMetrics.mockRejectedValueOnce(new TopggApiError(429, 'rate limited', 3_600_000));
      await h.scheduler.tick();
      expect(h.scheduler.stats.blockedUntil).not.toBeNull();

      h.clock.now += 15 * 60_000;
      await h.scheduler.tick();
      expect(h.postMetrics).toHaveBeenCalledTimes(1);
      expect(h.putCommands).toHaveBeenCalledTimes(0);

      h.clock.now += 60 * 60_000;
      await h.scheduler.tick();
      expect(h.postMetrics).toHaveBeenCalledTimes(2);
      expect(h.putCommands).toHaveBeenCalledTimes(1);
    });

    /**
     * The block is on the TOKEN, so the second call in the same tick is already
     * doomed. Sending it anyway is how a throttle is kept alive.
     */
    it('does not attempt the command list in the same tick that was rate limited', async () => {
      const h = harness();
      h.postMetrics.mockRejectedValueOnce(new TopggApiError(429, 'rate limited', 3_600_000));
      await h.scheduler.tick();
      expect(h.putCommands).not.toHaveBeenCalled();
    });
  });

  it('does not publish when the count query fails', async () => {
    const h = harness();
    h.countPresent.mockRejectedValueOnce(new Error('db down'));
    await h.scheduler.tick();
    expect(h.postMetrics).not.toHaveBeenCalled();
    expect(h.scheduler.stats.lastError).toMatch(/count failed/);
  });

  /**
   * A mapping failure is our bug and fails identically every tick, so it is
   * recorded once instead of retried forever. CI maps the real command set,
   * which is where this should actually be caught.
   */
  it('records an unmappable command list without retrying it', async () => {
    const h = harness({
      commands: () => [{ name: 'x', description: 'y', type: 1, options: [{ type: 99 }] } as never],
    });
    await h.scheduler.tick();
    h.clock.now += 60 * 60_000;
    await h.scheduler.tick();
    expect(h.putCommands).not.toHaveBeenCalled();
    expect(h.scheduler.stats.lastCommandError).toMatch(/could not map/);
  });

  it('does not overlap ticks', async () => {
    let release: (count: number) => void = () => {};
    const h = harness();
    h.countPresent.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const first = h.scheduler.tick();
    // Wait for the first tick to actually be mid-flight. Its flag read is
    // several microtasks deep, so releasing straight away would release nothing.
    await vi.waitFor(() => expect(h.countPresent).toHaveBeenCalledTimes(1));
    await h.scheduler.tick();
    release(10);
    await first;
    expect(h.countPresent).toHaveBeenCalledTimes(1);
  });

  describe('start and stop', () => {
    /**
     * The behaviour finding 2 of the review turned on, so it gets a test rather
     * than a comment. An immediate tick would read the presence table before
     * this boot's `clientReady` had written it.
     */
    it('does not publish on start, only on the interval', async () => {
      const h = harness();
      h.scheduler.start();
      expect(h.postMetrics).not.toHaveBeenCalled();
      expect(h.countPresent).not.toHaveBeenCalled();
      expect(h.timers).toHaveLength(1);
      expect(h.timers[0]?.ms).toBe(15 * 60_000);
      expect(h.scheduler.stats.running).toBe(true);

      h.timers[0]?.handler();
      await vi.waitFor(() => expect(h.postMetrics).toHaveBeenCalledTimes(1));
    });

    it('does not start twice, even though the handle is a falsy 0', () => {
      const h = harness();
      h.scheduler.start();
      h.scheduler.start();
      expect(h.timers).toHaveLength(1);
    });

    it('clears the timer on stop and reports itself stopped', async () => {
      const h = harness();
      h.scheduler.start();
      await h.scheduler.stop();
      expect(h.cleared).toEqual([0]);
      expect(h.scheduler.stats.running).toBe(false);
    });

    it('can be restarted, rather than every later tick being a silent no-op', async () => {
      const h = harness();
      h.scheduler.start();
      await h.scheduler.stop();
      h.scheduler.start();
      await h.scheduler.tick();
      expect(h.postMetrics).toHaveBeenCalledTimes(1);
    });

    /**
     * Stop must NOT wait for the network. It sits ahead of the gateway teardown
     * and the shard-lease release in the drain, and Fly's kill timeout is not
     * generous.
     */
    it('abandons an in-flight publish instead of awaiting it', async () => {
      const h = harness();
      let release: (count: number) => void = () => {};
      h.countPresent.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      );
      const tick = h.scheduler.tick();
      await vi.waitFor(() => expect(h.countPresent).toHaveBeenCalledTimes(1));

      let stopped = false;
      await h.scheduler.stop().then(() => {
        stopped = true;
      });
      expect(stopped).toBe(true);
      expect(h.postMetrics).not.toHaveBeenCalled();

      release(10);
      await tick;
    });

    it('stays quiet after stop', async () => {
      const h = harness();
      await h.scheduler.stop();
      await h.scheduler.tick();
      expect(h.postMetrics).not.toHaveBeenCalled();
    });
  });

  describe('a failure that will not fix itself', () => {
    for (const status of [401, 403, 404]) {
      it(`reports HTTP ${status} to a human, once`, async () => {
        const h = harness();
        h.postMetrics.mockRejectedValue(new TopggApiError(status, `HTTP ${status}`));
        await h.scheduler.tick();
        h.clock.now += 20 * 60_000;
        await h.scheduler.tick();

        expect(h.postMetrics).toHaveBeenCalledTimes(2);
        expect(h.report).toHaveBeenCalledTimes(1);
        expect(String(h.report.mock.calls[0]?.[1])).toMatch(/TOPGG_TOKEN/);
        expect(h.scheduler.stats.permanentFailure).toBe(true);
      });
    }

    it('does not report an ordinary server error', async () => {
      const h = harness();
      h.postMetrics.mockRejectedValue(new TopggApiError(502, 'HTTP 502'));
      await h.scheduler.tick();
      expect(h.report).not.toHaveBeenCalled();
      expect(h.scheduler.stats.permanentFailure).toBe(false);
    });

    it('clears the flag once a call succeeds', async () => {
      const h = harness();
      h.postMetrics.mockRejectedValueOnce(new TopggApiError(403, 'HTTP 403'));
      await h.scheduler.tick();
      expect(h.scheduler.stats.permanentFailure).toBe(true);
      h.clock.now += 20 * 60_000;
      await h.scheduler.tick();
      expect(h.scheduler.stats.permanentFailure).toBe(false);
    });

    it('works with no reporter wired, which is the self-host shape', async () => {
      const h = harness({ report: undefined });
      h.postMetrics.mockRejectedValue(new TopggApiError(401, 'HTTP 401'));
      await expect(h.scheduler.tick()).resolves.toBeUndefined();
      expect(h.scheduler.stats.permanentFailure).toBe(true);
    });
  });

  it('clears a stale rate-limit stand-down once a call succeeds', async () => {
    const h = harness();
    h.postMetrics.mockRejectedValueOnce(new TopggApiError(429, 'rate limited', 60_000));
    await h.scheduler.tick();
    expect(h.scheduler.stats.blockedUntil).not.toBeNull();
    h.clock.now += 2 * 60_000;
    await h.scheduler.tick();
    expect(h.scheduler.stats.blockedUntil).toBeNull();
  });

  /**
   * `tick()` is called as `void this.tick()`, so it must never reject. And
   * `stats` must never throw either: `/diagnostics` builds its whole report
   * from these getters, so one throwing would take out every other subsystem's
   * report along with this one.
   */
  it('neither tick nor stats throws when a dependency does', async () => {
    const h = harness({
      ownsListing: () => {
        throw new Error('lease manager exploded');
      },
    });
    await expect(h.scheduler.tick()).resolves.toBeUndefined();
    expect(() => h.scheduler.stats).not.toThrow();
    expect(h.scheduler.stats.ownsListing).toBe(false);
    expect(h.scheduler.stats.lastError).toMatch(/exploded/);
  });

  it('reports itself as configured, since existing is the configuration', () => {
    expect(harness().scheduler.stats.configured).toBe(true);
  });
});
