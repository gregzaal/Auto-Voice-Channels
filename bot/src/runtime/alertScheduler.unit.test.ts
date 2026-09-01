import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_FLAGS } from '@avc/core';
import { AlertScheduler, type WatchCheck } from './alertScheduler.js';

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: () => logger,
} as never;

/** Records what was raised and resolved, standing in for the repository. */
interface FakeOpenAlert {
  severity: string;
  lastSeenAt: Date;
}

function fakeAlerts() {
  let openRows: FakeOpenAlert[] = [];
  let openFails = false;
  const raised: { key: string; target: string; severity: string; instance: unknown }[] = [];
  const resolved: { key: string; keep: string[]; instance?: string }[] = [];
  const claimable: {
    id: number;
    key: string;
    target: string;
    message: string;
    occurrences: number;
  }[] = [];
  const delivered: number[] = [];
  const failed: { id: number; err: string }[] = [];
  let expiredBefore: Date | null = null;
  let prunedBefore: Date | null = null;
  return {
    raised,
    resolved,
    claimable,
    delivered,
    failed,
    get expiredBefore() {
      return expiredBefore;
    },
    get prunedBefore() {
      return prunedBefore;
    },
    setOpen(rows: FakeOpenAlert[]) {
      openRows = rows;
    },
    failOpenRead() {
      openFails = true;
    },
    repo: {
      /**
       * The fleet-wide critical read. Absent from this fake at first, which
       * meant the read threw into its own fail-open catch and the tests below
       * passed while exercising none of it.
       */
      open: async () => {
        if (openFails) throw new Error('database unreachable');
        return openRows;
      },
      raise: async (input: {
        key: string;
        target?: string;
        severity?: string;
        details?: Record<string, unknown>;
      }) => {
        raised.push({
          key: input.key,
          target: input.target ?? '',
          severity: input.severity ?? 'warn',
          instance: input.details?.instance,
        });
        return { opened: true, id: raised.length };
      },
      resolveOthers: async (key: string, keep: readonly string[], opts?: { instance?: string }) => {
        resolved.push({
          key,
          keep: [...keep],
          ...(opts?.instance ? { instance: opts.instance } : {}),
        });
        return 0;
      },
      expireStale: async (before: Date) => {
        expiredBefore = before;
        return 0;
      },
      closeResolvedUndelivered: async () => 0,
      claimUndelivered: async () => claimable.splice(0, claimable.length),
      markDelivered: async (id: number) => void delivered.push(id),
      markDeliveryFailed: async (id: number, err: string) => void failed.push({ id, err }),
      undeliveredDepth: async () => claimable.length,
      pruneResolved: async (before: Date) => {
        prunedBefore = before;
        return 0;
      },
    } as never,
  };
}

function build(
  checks: WatchCheck[],
  opts: {
    flags?: Record<string, unknown>;
    flagsThrow?: boolean;
    url?: string;
    fetchFn?: typeof fetch;
    deliver?: (content: string) => Promise<boolean>;
  } = {},
) {
  const notified: { kind: string; message: string }[] = [];
  const alerts = fakeAlerts();
  const flagState = { value: opts.flags ?? {}, fail: opts.flagsThrow ?? false };
  const scheduler = new AlertScheduler({
    alerts: alerts.repo,
    flags: {
      getAll: async () => {
        if (flagState.fail) throw new Error('db down');
        return flagState.value;
      },
    } as never,
    logger,
    notify: (kind, message) => notified.push({ kind, message }),
    checks,
    instanceId: 'inst-a',
    ...(opts.deliver ? { deliver: opts.deliver } : {}),
    ...(opts.url !== undefined ? { watchdogPingUrl: opts.url } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    // Never fires: every test drives `tick()` directly.
    setIntervalFn: (() => 0 as unknown as NodeJS.Timeout) as never,
    clearIntervalFn: (() => {}) as never,
  });
  return { scheduler, notified, alerts, flagState };
}

/** A check whose problems the test can change between ticks. */
function togglable(key: string, severity: WatchCheck['severity'] = 'warn') {
  const state: { targets: string[] } = { targets: [] };
  const check: WatchCheck = {
    key,
    severity,
    audience: 'both',
    run: () => state.targets.map((t) => ({ target: t, message: `${key} on ${t}` })),
  };
  return { state, check };
}

describe('AlertScheduler', () => {
  it('notifies once when a condition opens, not on every tick', async () => {
    const { state, check } = togglable('circuit.tripped');
    const { scheduler, notified, alerts } = build([check]);
    state.targets = ['g1'];

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    expect(notified.filter((n) => n.kind === 'circuit.tripped')).toHaveLength(1);
    // The row is still bumped every tick: that is what `occurrences` is for.
    expect(alerts.raised).toHaveLength(3);
  });

  /**
   * The whole point of the class. A condition that never comes back down
   * latches every downstream consumer red forever.
   */
  it('resolves a condition that stops being true, and re-notifies if it returns', async () => {
    const { state, check } = togglable('circuit.tripped');
    const { scheduler, notified, alerts } = build([check]);

    state.targets = ['g1'];
    await scheduler.tick();
    state.targets = [];
    await scheduler.tick();
    expect(alerts.resolved.at(-1)).toEqual({
      key: 'circuit.tripped',
      keep: [],
      instance: 'inst-a',
    });

    state.targets = ['g1'];
    await scheduler.tick();
    expect(notified.filter((n) => n.kind === 'circuit.tripped')).toHaveLength(2);
  });

  it('keeps one target open while resolving another', async () => {
    const { state, check } = togglable('circuit.tripped');
    const { scheduler, notified, alerts } = build([check]);

    state.targets = ['g1', 'g2'];
    await scheduler.tick();
    expect(notified).toHaveLength(2);

    state.targets = ['g2'];
    await scheduler.tick();
    expect(alerts.resolved.at(-1)).toEqual({
      key: 'circuit.tripped',
      keep: ['g2'],
      instance: 'inst-a',
    });
    // g2 was already open, so nothing new was announced.
    expect(notified).toHaveLength(2);
  });

  it('requires consecutive observations when confirmations is set', async () => {
    const { state, check } = togglable('gateway.down', 'critical');
    check.confirmations = 2;
    const { scheduler, notified } = build([check]);

    state.targets = [''];
    await scheduler.tick();
    expect(notified).toHaveLength(0);
    await scheduler.tick();
    expect(notified).toHaveLength(1);
  });

  /**
   * A decaying counter would let something that blips once an hour eventually
   * cross a threshold it never sustained, which is the false positive the
   * threshold exists to prevent.
   */
  it('resets a streak that misses a tick rather than decaying it', async () => {
    const { state, check } = togglable('gateway.down', 'critical');
    check.confirmations = 3;
    const { scheduler, notified } = build([check]);

    state.targets = [''];
    await scheduler.tick();
    await scheduler.tick();
    state.targets = [];
    await scheduler.tick();
    state.targets = [''];
    await scheduler.tick();
    await scheduler.tick();
    expect(notified).toHaveLength(0);
    await scheduler.tick();
    expect(notified).toHaveLength(1);
  });

  it('announces recovery for criticals and stays quiet for warnings', async () => {
    const crit = togglable('gateway.down', 'critical');
    const warn = togglable('circuit.tripped', 'warn');
    const { scheduler, notified } = build([crit.check, warn.check]);

    crit.state.targets = [''];
    warn.state.targets = ['g1'];
    await scheduler.tick();
    crit.state.targets = [];
    warn.state.targets = [];
    await scheduler.tick();

    const kinds = notified.map((n) => n.kind);
    expect(kinds).toContain('gateway.down.resolved');
    expect(kinds).not.toContain('circuit.tripped.resolved');
  });

  describe('the watchdog ping', () => {
    const okFetch = () => Promise.resolve(new Response(null, { status: 200 }));

    it('pings on a healthy tick', async () => {
      const fetchFn = vi.fn(okFetch);
      const { scheduler } = build([], { url: 'https://hb.test/x', fetchFn: fetchFn as never });
      await scheduler.tick();
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(scheduler.stats.watchdog.lastPingAt).not.toBeNull();
    });

    /** A confirmed critical means the process is alive and not working. */
    it('withholds the ping when a critical is confirmed', async () => {
      const { state, check } = togglable('gateway.down', 'critical');
      const fetchFn = vi.fn(okFetch);
      const { scheduler } = build([check], { url: 'https://hb.test/x', fetchFn: fetchFn as never });

      await scheduler.tick();
      expect(fetchFn).toHaveBeenCalledTimes(1);

      state.targets = [''];
      await scheduler.tick();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(scheduler.stats.watchdog.suppressed).toBe(true);
    });

    /** One guild in trouble is what per-guild isolation exists to contain. */
    it('still pings when only a warning is open', async () => {
      const { state, check } = togglable('circuit.tripped', 'warn');
      const fetchFn = vi.fn(okFetch);
      const { scheduler } = build([check], { url: 'https://hb.test/x', fetchFn: fetchFn as never });
      state.targets = ['g1'];
      await scheduler.tick();
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('does not report a failed ping to the alert channel', async () => {
      const fetchFn = vi.fn(() => Promise.reject(new Error('unreachable')));
      const { scheduler, notified } = build([], {
        url: 'https://hb.test/x',
        fetchFn: fetchFn as never,
      });
      await scheduler.tick();
      expect(notified).toHaveLength(0);
      expect(scheduler.stats.watchdog.lastError).toBe('unreachable');
    });

    it('treats a non-2xx as a failed ping', async () => {
      const fetchFn = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })));
      const { scheduler } = build([], { url: 'https://hb.test/x', fetchFn: fetchFn as never });
      await scheduler.tick();
      expect(scheduler.stats.watchdog.lastPingAt).toBeNull();
      expect(scheduler.stats.watchdog.lastError).toBe('HTTP 500');
    });

    it('does nothing at all when no url is configured', async () => {
      const { scheduler } = build([]);
      await scheduler.tick();
      expect(scheduler.stats.watchdog.configured).toBe(false);
    });
  });

  describe('kill switches', () => {
    it('does nothing under global.pause or alerts.disabled', async () => {
      for (const flag of [RUNTIME_FLAGS.GLOBAL_PAUSE, RUNTIME_FLAGS.ALERTS_DISABLED]) {
        const { state, check } = togglable('circuit.tripped');
        const fetchFn = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
        const { scheduler, notified } = build([check], {
          flags: { [flag]: true },
          url: 'https://hb.test/x',
          fetchFn: fetchFn as never,
        });
        state.targets = ['g1'];
        await scheduler.tick();
        expect(notified).toHaveLength(0);
        // The ping stops too, so the heartbeat monitor reflects the silence.
        expect(fetchFn).not.toHaveBeenCalled();
      }
    });

    /**
     * A switch someone deliberately set must not un-set itself the moment the
     * database blips, which is exactly when the watcher gets busiest.
     */
    it('honours the last readable flags when the flag read fails', async () => {
      const { state, check } = togglable('circuit.tripped');
      const { scheduler, notified, flagState } = build([check], {
        flags: { [RUNTIME_FLAGS.ALERTS_DISABLED]: true },
      });
      state.targets = ['g1'];
      await scheduler.tick();
      flagState.fail = true;
      await scheduler.tick();
      expect(notified).toHaveLength(0);
    });

    it('runs when the very first flag read fails, having no switch to honour', async () => {
      const { state, check } = togglable('circuit.tripped');
      const { scheduler, notified } = build([check], { flagsThrow: true });
      state.targets = ['g1'];
      await scheduler.tick();
      expect(notified).toHaveLength(1);
    });
  });

  /**
   * A bug in one condition must not be able to declare the whole instance dead
   * to an external monitor.
   */
  it('treats a throwing check as unknown: no alert, and the ping still goes', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const { scheduler, notified, alerts } = build(
      [
        {
          key: 'gateway.down',
          severity: 'critical',
          audience: 'both',
          run: () => {
            throw new Error('reader exploded');
          },
        },
      ],
      { url: 'https://hb.test/x', fetchFn: fetchFn as never },
    );

    await scheduler.tick();
    expect(alerts.raised).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(notified.map((n) => n.kind)).toEqual(['watch.check.gateway.down']);
  });

  /**
   * Reconciliation must only ever close what THIS instance raised. Without the
   * stamp, the first instance in a fleet to tick healthy would resolve every
   * other instance's open conditions.
   */
  it('stamps its own instance on what it raises and resolves', async () => {
    const { state, check } = togglable('circuit.tripped');
    const { scheduler, alerts } = build([check]);
    state.targets = ['g1'];
    await scheduler.tick();
    expect(alerts.raised[0]?.instance).toBe('inst-a');
    expect(alerts.resolved[0]?.instance).toBe('inst-a');
  });

  /**
   * Each target is a sequential round trip on the shared pool, every minute,
   * and the scenario producing a large N is the incident itself. An unbounded
   * fan-out does not merely cost time: a tick that outruns its interval is
   * silently dropped by the reentrancy guard, so the watcher stops watching.
   */
  it('caps how many targets one check reports, and says so', async () => {
    const { state, check } = togglable('circuit.tripped');
    const { scheduler, notified, alerts } = build([check]);
    state.targets = Array.from({ length: 40 }, (_, i) => `g${String(i).padStart(2, '0')}`);

    await scheduler.tick();
    expect(alerts.raised).toHaveLength(25);
    expect(notified).toHaveLength(25);
    // Sorted before truncating, so the same 25 survive each tick rather than
    // resolving and re-opening as membership shuffles.
    expect(alerts.raised[0]?.target).toBe('g00');
    expect(alerts.raised.at(-1)?.target).toBe('g24');

    await scheduler.tick();
    expect(notified).toHaveLength(25);
  });

  /** Leaving `stopping` set made a restarted scheduler tick silently forever. */
  it('can be started again after being stopped', async () => {
    const { state, check } = togglable('circuit.tripped');
    const { scheduler, notified } = build([check]);
    await scheduler.stop();
    state.targets = ['g1'];
    await scheduler.tick();
    expect(notified).toHaveLength(0);

    // `start()` ticks immediately, so drain that rather than racing a second
    // tick against the reentrancy guard.
    scheduler.start();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(notified).toHaveLength(1);
  });

  it('ages out alerts nobody has seen', async () => {
    const { scheduler, alerts } = build([], {});
    await scheduler.tick();
    expect(alerts.expiredBefore).toBeInstanceOf(Date);
    expect(Date.now() - (alerts.expiredBefore as Date).getTime()).toBeGreaterThan(23 * 3_600_000);
  });

  describe('the delivery retry loop', () => {
    const claim = (id: number, key: string, target = '') => ({
      id,
      key,
      target,
      message: `${key} is unhappy`,
      occurrences: 1,
    });

    it('posts one batched message and marks every row delivered', async () => {
      const posts: string[] = [];
      const { scheduler, alerts } = build([], {
        deliver: async (c) => {
          posts.push(c);
          return true;
        },
      });
      alerts.claimable.push(claim(1, 'db.ping'), claim(2, 'circuit.tripped', 'g7'));

      await scheduler.tick();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain('db.ping');
      expect(posts[0]).toContain('g7');
      expect(alerts.delivered).toEqual([1, 2]);
    });

    /**
     * A failed retry must back the row off, not mark it done. Marking on a post
     * that never landed is the silent-drop this whole layer exists to remove.
     */
    it('records a failure instead of a delivery when the post fails', async () => {
      const { scheduler, alerts } = build([], { deliver: async () => false });
      alerts.claimable.push(claim(1, 'db.ping'));
      await scheduler.tick();
      expect(alerts.delivered).toEqual([]);
      expect(alerts.failed.map((f: { id: number }) => f.id)).toEqual([1]);
    });

    /**
     * `send` truncates at 1900 characters and still returns true, so one
     * message plus a blanket markDelivered would stamp rows whose text was cut
     * off as delivered. That is the silent drop this layer exists to remove.
     */
    it('splits a long batch across messages and marks each against its own', async () => {
      const posts: string[] = [];
      const { scheduler, alerts } = build([], {
        deliver: async (c) => {
          posts.push(c);
          return true;
        },
      });
      for (let i = 1; i <= 6; i += 1) {
        alerts.claimable.push({
          id: i,
          key: 'permissions.blocked',
          target: `g${i}`,
          message: 'x'.repeat(500),
          occurrences: 1,
        });
      }

      await scheduler.tick();
      expect(posts.length).toBeGreaterThan(1);
      for (const post of posts) expect(post.length).toBeLessThan(1900);
      expect(alerts.delivered).toHaveLength(6);
    });

    it('marks only the rows in a chunk that failed', async () => {
      let call = 0;
      const { scheduler, alerts } = build([], {
        deliver: async () => {
          call += 1;
          return call === 1;
        },
      });
      for (let i = 1; i <= 6; i += 1) {
        alerts.claimable.push({
          id: i,
          key: 'permissions.blocked',
          target: `g${i}`,
          message: 'x'.repeat(500),
          occurrences: 1,
        });
      }

      await scheduler.tick();
      expect(alerts.delivered.length).toBeGreaterThan(0);
      expect(alerts.failed.length).toBeGreaterThan(0);
      expect(alerts.delivered.length + alerts.failed.length).toBe(6);
    });

    it('survives a deliver that throws', async () => {
      const { scheduler, alerts } = build([], {
        deliver: async () => {
          throw new Error('discord is down');
        },
      });
      alerts.claimable.push(claim(1, 'db.ping'));
      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(alerts.failed).toHaveLength(1);
    });

    it('posts nothing when there is nothing to deliver', async () => {
      const posts: string[] = [];
      const { scheduler } = build([], {
        deliver: async (c) => {
          posts.push(c);
          return true;
        },
      });
      await scheduler.tick();
      expect(posts).toEqual([]);
    });

    /** No admin channel means nowhere to deliver, so claiming would only burn attempts. */
    it('does not claim at all when no deliver is configured', async () => {
      const { scheduler, alerts } = build([]);
      alerts.claimable.push(claim(1, 'db.ping'));
      await scheduler.tick();
      expect(alerts.delivered).toEqual([]);
      expect(alerts.claimable).toHaveLength(1);
    });

    it('reports the undelivered depth for /diagnostics', async () => {
      const { scheduler, alerts } = build([], { deliver: async () => true });
      alerts.claimable.push(claim(1, 'db.ping'));
      await scheduler.tick();
      expect(scheduler.stats.undelivered).toBe(0);
    });

    it('prunes resolved history', async () => {
      const { scheduler, alerts } = build([], { deliver: async () => true });
      await scheduler.tick();
      expect(alerts.prunedBefore).toBeInstanceOf(Date);
      expect(Date.now() - (alerts.prunedBefore as Date).getTime()).toBeGreaterThan(
        29 * 24 * 3_600_000,
      );
    });
  });

  it('works with no repository at all, which is the self-host case', async () => {
    const { state, check } = togglable('circuit.tripped');
    const notified: string[] = [];
    const scheduler = new AlertScheduler({
      flags: { getAll: async () => ({}) } as never,
      logger,
      notify: (kind) => notified.push(kind),
      checks: [check],
      instanceId: 'inst-a',
      setIntervalFn: (() => 0 as unknown as NodeJS.Timeout) as never,
      clearIntervalFn: (() => {}) as never,
    });
    state.targets = ['g1'];
    await scheduler.tick();
    await scheduler.tick();
    expect(notified).toEqual(['circuit.tripped']);
  });

  it('does not overlap ticks', async () => {
    let running = 0;
    let overlapped = false;
    const scheduler = new AlertScheduler({
      flags: { getAll: async () => ({}) } as never,
      logger,
      notify: () => {},
      instanceId: 'inst-a',
      checks: [
        {
          key: 'slow',
          severity: 'warn',
          audience: 'both',
          run: async () => {
            running += 1;
            if (running > 1) overlapped = true;
            await new Promise((r) => setTimeout(r, 5));
            running -= 1;
            return [];
          },
        },
      ],
      setIntervalFn: (() => 0 as unknown as NodeJS.Timeout) as never,
      clearIntervalFn: (() => {}) as never,
    });

    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    expect(overlapped).toBe(false);
  });
  /**
   * The 2026-09-01 outage lasted 3 hours 37 minutes because of this.
   *
   * Shard 0's gateway was dead. The instance holding it correctly confirmed a
   * critical and correctly withheld its own ping. The other three were healthy,
   * kept pinging every minute, and the heartbeat monitor stayed green all night.
   * The switch is documented as making "a bot that is running and not working
   * read as down", which was only ever true of a single-instance fleet.
   */
  describe('the watchdog sees the whole fleet, not just this machine', () => {
    const healthy: WatchCheck[] = [
      { key: 'fine', severity: 'critical', audience: 'both', run: () => [] },
    ];

    it('withholds the ping for a critical raised by another instance', async () => {
      const pinged: string[] = [];
      const { scheduler, alerts } = build(healthy, {
        url: 'https://hb.example/ping',
        fetchFn: (async (url: string) => {
          pinged.push(url);
          return { ok: true } as Response;
        }) as never,
      });
      alerts.setOpen([{ severity: 'critical', lastSeenAt: new Date() }]);

      await scheduler.tick();

      expect(pinged).toEqual([]);
      expect(scheduler.stats.watchdog.suppressed).toBe(true);
    });

    /**
     * The anti-latch, which is not optional: a polled condition re-stamps every
     * tick, so an untouched row belongs to an instance that vanished. Without
     * the window one such row withholds the ping forever and the monitor is
     * permanently red, which is worse than no monitor.
     */
    it('ignores a critical nobody has re-confirmed', async () => {
      const pinged: string[] = [];
      const { scheduler, alerts } = build(healthy, {
        url: 'https://hb.example/ping',
        fetchFn: (async (url: string) => {
          pinged.push(url);
          return { ok: true } as Response;
        }) as never,
      });
      alerts.setOpen([{ severity: 'critical', lastSeenAt: new Date(Date.now() - 20 * 60_000) }]);

      await scheduler.tick();

      expect(pinged).toHaveLength(1);
      expect(scheduler.stats.watchdog.suppressed).toBe(false);
    });

    /** A warn is a guild in trouble, not a fleet down. It must never suppress. */
    it('ignores a warning from anywhere', async () => {
      const pinged: string[] = [];
      const { scheduler, alerts } = build(healthy, {
        url: 'https://hb.example/ping',
        fetchFn: (async (url: string) => {
          pinged.push(url);
          return { ok: true } as Response;
        }) as never,
      });
      alerts.setOpen([{ severity: 'warn', lastSeenAt: new Date() }]);

      await scheduler.tick();

      expect(pinged).toHaveLength(1);
    });

    /**
     * Fails OPEN. A failed read means the database is in trouble, which is
     * itself a locally-evaluated critical that has already suppressed. Treating
     * the error as a suppression would make a database blip read as a fleet-wide
     * outage on the one signal that has to stay trustworthy.
     */
    it('still pings when the fleet read fails', async () => {
      const pinged: string[] = [];
      const { scheduler, alerts } = build(healthy, {
        url: 'https://hb.example/ping',
        fetchFn: (async (url: string) => {
          pinged.push(url);
          return { ok: true } as Response;
        }) as never,
      });
      alerts.failOpenRead();

      await scheduler.tick();

      expect(pinged).toHaveLength(1);
    });

    it('pings normally when the whole fleet is healthy', async () => {
      const pinged: string[] = [];
      const { scheduler } = build(healthy, {
        url: 'https://hb.example/ping',
        fetchFn: (async (url: string) => {
          pinged.push(url);
          return { ok: true } as Response;
        }) as never,
      });

      await scheduler.tick();

      expect(pinged).toHaveLength(1);
      expect(scheduler.stats.watchdog.suppressed).toBe(false);
    });
  });
});
