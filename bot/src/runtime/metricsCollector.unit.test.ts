import { beforeEach, describe, expect, it, vi } from 'vitest';
import { METRICS, RUNTIME_FLAGS, hourBucket, type MetricWrite } from '@avc/core';
import { MetricsCollector, type MetricsCollectorDeps } from './metricsCollector.js';
import { fakeLogger } from './testUtils.js';

const NOW = new Date('2026-08-19T13:20:00Z');

interface Harness {
  collector: MetricsCollector;
  writes: MetricWrite[][];
  flags: Record<string, unknown>;
  gauges: number;
  rollups: number;
  reserved: boolean;
  setNow: (at: Date) => void;
  instanceRows: { metric: string; key: string; value: number }[];
}

function harness(overrides: Partial<MetricsCollectorDeps> = {}): Harness {
  const state = {
    writes: [] as MetricWrite[][],
    flags: {} as Record<string, unknown>,
    gauges: 0,
    rollups: 0,
    reserved: true,
    now: NOW,
    instanceRows: [] as { metric: string; key: string; value: number }[],
    queueDepth: 0,
    trippedCircuits: 0,
  };

  const collector = new MetricsCollector({
    metrics: {
      writePoints: async (points: readonly MetricWrite[]) => {
        state.writes.push([...points]);
      },
      readInstanceBucket: async () => state.instanceRows,
      collectGauges: async () => {
        state.gauges += 1;
        return {};
      },
      rollupDaily: async () => {
        state.rollups += 1;
        return 0;
      },
      rollupWindow: async () => ({
        from: new Date('2026-08-18T00:00:00Z'),
        to: new Date('2026-08-20T00:00:00Z'),
      }),
      pruneHourly: async () => 0,
      freshness: async () => ({
        lastHourlyBucket: hourBucket(state.now),
        lastDailyBucket: null,
        hourlyRows: 1,
        dailyRows: 0,
      }),
    } as unknown as MetricsCollectorDeps['metrics'],
    runs: {
      reserveRun: async () => ({ ok: state.reserved, waitMs: 0 }),
    } as unknown as MetricsCollectorDeps['runs'],
    flags: {
      getAll: async () => state.flags,
    } as unknown as MetricsCollectorDeps['flags'],
    fleet: 'beta',
    instanceId: 'i-1',
    logger: fakeLogger(),
    sample: () => ({
      queueDepth: state.queueDepth,
      trippedCircuits: state.trippedCircuits,
    }),
    now: () => state.now,
    ...overrides,
  });

  return {
    collector,
    get writes() {
      return state.writes;
    },
    flags: state.flags,
    get gauges() {
      return state.gauges;
    },
    get rollups() {
      return state.rollups;
    },
    get reserved() {
      return state.reserved;
    },
    set reserved(value: boolean) {
      state.reserved = value;
    },
    setNow: (at: Date) => {
      state.now = at;
    },
    instanceRows: state.instanceRows,
  } as unknown as Harness;
}

/** The single flushed row for a metric+key, across every write in the run. */
function lastValue(writes: MetricWrite[][], metric: string, key = ''): number | undefined {
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    const found = writes[i]!.find((p) => p.metric === metric && (p.key ?? '') === key);
    if (found) return found.value;
  }
  return undefined;
}

describe('MetricsCollector', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  /**
   * The flush writes the bucket's running total, not a delta, which is what makes
   * a retried write idempotent at the other end.
   */
  it('accumulates in memory and flushes a running total', async () => {
    h.collector.increment(METRICS.ROOMS_CREATED);
    h.collector.increment(METRICS.ROOMS_CREATED);
    h.collector.increment(METRICS.ROOMS_CREATED);
    expect(h.writes).toHaveLength(0);

    await h.collector.tick();
    expect(lastValue(h.writes, METRICS.ROOMS_CREATED)).toBe(3);

    h.collector.increment(METRICS.ROOMS_CREATED);
    await h.collector.tick();
    expect(lastValue(h.writes, METRICS.ROOMS_CREATED)).toBe(4);
  });

  it('keeps a keyed metric separate per key', async () => {
    h.collector.increment(METRICS.COMMANDS_INVOKED, 'limit');
    h.collector.increment(METRICS.COMMANDS_INVOKED, 'limit');
    h.collector.increment(METRICS.COMMANDS_INVOKED, 'name');
    await h.collector.tick();

    expect(lastValue(h.writes, METRICS.COMMANDS_INVOKED, 'limit')).toBe(2);
    expect(lastValue(h.writes, METRICS.COMMANDS_INVOKED, 'name')).toBe(1);
  });

  /** A dimension with a space or a colon in it must not merge two series. */
  it('round-trips a dimension containing separators', async () => {
    h.collector.increment(METRICS.ERRORS, 'weird key: with spaces');
    h.collector.increment(METRICS.ERRORS, 'weird');
    await h.collector.tick();

    expect(lastValue(h.writes, METRICS.ERRORS, 'weird key: with spaces')).toBe(1);
    expect(lastValue(h.writes, METRICS.ERRORS, 'weird')).toBe(1);
  });

  /**
   * Every tick used to rewrite every entry, so each hourly row was upserted a dozen
   * times an hour to store the value it already held - and a quiet self-host wrote
   * as often as a busy fleet.
   */
  it('writes nothing when nothing has changed since the last flush', async () => {
    h.collector.increment(METRICS.ROOMS_CREATED);
    await h.collector.tick();
    expect(h.writes).toHaveLength(1);

    await h.collector.tick();
    await h.collector.tick();
    expect(h.writes).toHaveLength(1);

    h.collector.increment(METRICS.ROOMS_CREATED);
    await h.collector.tick();
    expect(h.writes).toHaveLength(2);
  });

  /** A peak that does not beat its own maximum is not a change either. */
  it('does not re-flush for a sample that cannot move a peak', async () => {
    h.collector.observePeak(METRICS.QUEUE_DEPTH_PEAK, 5);
    await h.collector.tick();
    expect(h.writes).toHaveLength(1);

    h.collector.observePeak(METRICS.QUEUE_DEPTH_PEAK, 3);
    await h.collector.tick();
    expect(h.writes).toHaveLength(1);
  });

  it('keeps a failed flush pending and retries it on the next tick', async () => {
    let fail = true;
    const flaky = harness({
      metrics: {
        writePoints: async () => {
          if (fail) throw new Error('transient');
        },
        readInstanceBucket: async () => [],
        collectGauges: async () => ({}),
        rollupDaily: async () => 0,
        rollupWindow: async () => ({ from: new Date(0), to: new Date(0) }),
        pruneHourly: async () => 0,
        freshness: async () => ({
          lastHourlyBucket: null,
          lastDailyBucket: null,
          hourlyRows: 0,
          dailyRows: 0,
        }),
      } as unknown as MetricsCollectorDeps['metrics'],
    });
    flaky.collector.increment(METRICS.ROOMS_CREATED, '', 4);
    await flaky.collector.tick();
    expect(flaky.collector.stats.pending).toBe(1);

    fail = false;
    await flaky.collector.tick();
    expect(flaky.collector.stats.lastFlushError).toBeNull();
    expect(flaky.collector.stats.lastFlushAt).not.toBeNull();
  });

  it('records peaks as a maximum, not a sum', async () => {
    h.collector.observePeak(METRICS.QUEUE_DEPTH_PEAK, 4);
    h.collector.observePeak(METRICS.QUEUE_DEPTH_PEAK, 19);
    h.collector.observePeak(METRICS.QUEUE_DEPTH_PEAK, 7);
    await h.collector.tick();

    expect(lastValue(h.writes, METRICS.QUEUE_DEPTH_PEAK)).toBe(19);
  });

  /**
   * Telemetry must not be able to throw into a voice event or a command handler,
   * so a bad metric name is logged and dropped rather than raised.
   */
  it('never throws into the hot path', () => {
    expect(() => h.collector.increment('rooms.creatd' as never)).not.toThrow();
    // A counter recorded as a peak (or vice versa) is a coding error, not a value.
    expect(() => h.collector.observePeak(METRICS.ROOMS_CREATED, 5)).not.toThrow();
    expect(() => h.collector.increment(METRICS.QUEUE_DEPTH_PEAK)).not.toThrow();
  });

  it('drops nothing when the flush fails, so a retry recovers the counts', async () => {
    const failing = harness({
      metrics: {
        writePoints: async () => {
          throw new Error('pool exhausted');
        },
        readInstanceBucket: async () => [],
        collectGauges: async () => ({}),
        rollupDaily: async () => 0,
        rollupWindow: async () => ({ from: new Date(0), to: new Date(0) }),
        pruneHourly: async () => 0,
        freshness: async () => ({
          lastHourlyBucket: null,
          lastDailyBucket: null,
          hourlyRows: 0,
          dailyRows: 0,
        }),
      } as unknown as MetricsCollectorDeps['metrics'],
    });
    failing.collector.increment(METRICS.ROOMS_CREATED);
    await failing.collector.tick();

    expect(failing.collector.stats.pending).toBe(1);
    expect(failing.collector.stats.lastFlushError).toMatch(/pool exhausted/);
    expect(failing.collector.stats.lastFlushAt).toBeNull();
    /**
     * And the rollup's success on the same tick must not speak for the flush.
     * These were one field, and on the instance that wins the rollup a flush
     * failing for hours reported no error at all.
     */
    expect(failing.collector.stats.lastRollupError).toBeNull();
    expect(failing.collector.stats.lastRollupAt).not.toBeNull();
  });

  describe('the step 5 gauges', () => {
    /**
     * Keyed by instance, and that is the whole point. Both the daily rollup and
     * readSeries sum across instances before summarising, so an unkeyed
     * per-machine number comes back as a fleet total, which is exactly not the
     * number the memory-headroom alert wants.
     */
    it('records rss keyed by instance so it survives both aggregations', async () => {
      const h = harness({ readRss: () => 900 });
      h.collector.sampleTick();
      await h.collector.tick();
      const row = h.writes
        .flat()
        .find((w: { metric: string }) => w.metric === METRICS.PROCESS_RSS_PEAK);
      expect(row).toBeDefined();
      expect(row?.key).toBe('i-1');
      expect(row?.value).toBe(900);
    });

    it('keeps the highest rss in the bucket, not the latest', async () => {
      let rss = 500;
      const h = harness({ readRss: () => rss });
      h.collector.sampleTick();
      rss = 1200;
      h.collector.sampleTick();
      rss = 700;
      h.collector.sampleTick();
      await h.collector.tick();
      expect(lastValue(h.writes, METRICS.PROCESS_RSS_PEAK, 'i-1')).toBe(1200);
    });

    /**
     * One row per fleet per bucket. Every instance polls the identical answer,
     * so stamping each machine's instance id would have readSeries sum them
     * into N times the real max_concurrency.
     */
    it('writes the gateway gauges with an empty instance', async () => {
      const h = harness({
        pollGateway: async () => ({
          recommendedShards: 2,
          maxConcurrency: 16,
          sessionUsed: 40,
          sessionTotal: 1000,
        }),
      });
      await h.collector.tick();
      const rows = h.writes
        .flat()
        .filter((w: { metric: string }) => w.metric.startsWith('gateway.'));
      expect(rows).toHaveLength(4);
      expect(rows.every((r: { instance: string }) => r.instance === '')).toBe(true);
      expect(
        rows.find((r: { metric: string }) => r.metric === METRICS.GATEWAY_SESSION_USED)?.value,
      ).toBe(40);
    });

    /**
     * Boot falls back to max_concurrency 1 when this call fails. Writing that
     * would read as Discord genuinely cutting the identify budget to one.
     * Absence is how this store says "unknown".
     */
    it('writes nothing at all when the poll fails', async () => {
      const h = harness({ pollGateway: async () => undefined });
      await h.collector.tick();
      expect(
        h.writes.flat().filter((w: { metric: string }) => w.metric.startsWith('gateway.')),
      ).toHaveLength(0);
    });

    it('a throwing poll does not stop the counter flush', async () => {
      const h = harness({
        pollGateway: async () => {
          throw new Error('discord said no');
        },
      });
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();
      expect(lastValue(h.writes, METRICS.ROOMS_CREATED)).toBe(1);
    });

    it('does not poll at all when no poller is configured', async () => {
      const h = harness();
      await h.collector.tick();
      expect(
        h.writes.flat().filter((w: { metric: string }) => w.metric.startsWith('gateway.')),
      ).toHaveLength(0);
    });
  });

  describe('the rollup half', () => {
    it('runs the derived gauges and the daily rollup when it wins the reservation', async () => {
      await h.collector.tick();
      expect(h.gauges).toBe(1);
      expect(h.rollups).toBe(1);
      expect(h.collector.stats.lastRollupAt).toBe(NOW.toISOString());
    });

    /**
     * Losing the reservation is the normal case for every instance but one, and it
     * must not stop that instance flushing its own counters.
     */
    it('still flushes its own counters when another instance holds the rollup', async () => {
      h.reserved = false;
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();

      expect(h.gauges).toBe(0);
      expect(lastValue(h.writes, METRICS.ROOMS_CREATED)).toBe(1);
    });
  });

  describe('flags', () => {
    it('writes nothing while metrics.disabled is set', async () => {
      h.flags[RUNTIME_FLAGS.METRICS_DISABLED] = true;
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();

      expect(h.writes).toHaveLength(0);
      expect(h.gauges).toBe(0);
    });

    it('writes nothing under global.pause', async () => {
      h.flags[RUNTIME_FLAGS.GLOBAL_PAUSE] = true;
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();

      expect(h.writes).toHaveLength(0);
      expect(h.gauges).toBe(0);
    });

    /**
     * Disabled means "stop writing", not "stop bounding memory": a collector left
     * off for a week must not be holding a bucket per hour of that week. Asserted
     * for BOTH switches - it used to hold for `metrics.disabled` only, and
     * `global.pause` returned before the prune.
     */
    it.each([RUNTIME_FLAGS.METRICS_DISABLED, RUNTIME_FLAGS.GLOBAL_PAUSE])(
      'still prunes old buckets while %s is set',
      async (flag) => {
        h.flags[flag] = true;
        h.collector.increment(METRICS.ROOMS_CREATED);
        expect(h.collector.stats.pending).toBe(1);

        h.setNow(new Date('2026-08-19T16:20:00Z'));
        await h.collector.tick();
        expect(h.collector.stats.pending).toBe(0);
      },
    );

    it('reports which switch is suppressing it, not just that timers run', async () => {
      h.flags[RUNTIME_FLAGS.METRICS_DISABLED] = true;
      h.collector.start();
      await h.collector.tick();

      expect(h.collector.stats.running).toBe(true);
      expect(h.collector.stats.disabled).toBe(true);
      expect(h.collector.stats.paused).toBe(false);
    });

    it('writes nothing on stop while a switch is set', async () => {
      h.flags[RUNTIME_FLAGS.GLOBAL_PAUSE] = true;
      h.collector.start();
      h.collector.increment(METRICS.ROOMS_CREATED, '', 6);
      await h.collector.stop();

      expect(h.writes).toHaveLength(0);
    });
  });

  describe('bucket rollover', () => {
    it('keeps the finished hour flushable after the clock rolls over', async () => {
      h.collector.increment(METRICS.ROOMS_CREATED, '', 5);
      h.setNow(new Date('2026-08-19T14:01:00Z'));
      h.collector.increment(METRICS.ROOMS_CREATED, '', 2);
      await h.collector.tick();

      const flushed = h.writes.at(-1)!;
      expect(flushed).toHaveLength(2);
      const buckets = flushed.map((p) => p.bucket.toISOString()).sort();
      expect(buckets).toEqual(['2026-08-19T13:00:00.000Z', '2026-08-19T14:00:00.000Z']);
      expect(flushed.find((p) => p.bucket.getUTCHours() === 13)?.value).toBe(5);
      expect(flushed.find((p) => p.bucket.getUTCHours() === 14)?.value).toBe(2);
    });

    /**
     * The accumulator is bounded by two buckets, so a long-running instance
     * cannot grow one entry per hour it has been up. A stale bucket may be
     * written once more on the tick that discovers it - re-writing a running
     * total is idempotent, and dropping it before the flush would discard counts
     * whose earlier flush had failed.
     */
    it('forgets a bucket that is two hours stale', async () => {
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();
      h.setNow(new Date('2026-08-19T15:05:00Z'));
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();
      expect(h.collector.stats.pending).toBe(1);

      // The stale bucket is gone, so the next write carries only the current one.
      h.collector.increment(METRICS.ROOMS_CREATED);
      await h.collector.tick();
      const flushed = h.writes.at(-1)!;
      expect(flushed).toHaveLength(1);
      expect(flushed[0]!.bucket.toISOString()).toBe('2026-08-19T15:00:00.000Z');
    });
  });

  /**
   * `greatest` on write stops a restart walking a counter backwards; hydrating is
   * what stops it stalling for the rest of the hour instead.
   */
  it('resumes its accumulators from the store on boot', async () => {
    const resumed = harness();
    resumed.instanceRows.push(
      { metric: METRICS.ROOMS_CREATED, key: '', value: 40 },
      { metric: METRICS.COMMANDS_INVOKED, key: 'limit', value: 3 },
      // A metric this build no longer knows about must not crash the resume.
      { metric: 'rooms.retired', key: '', value: 9 },
    );
    // Before anything is counted, which is the contract index.ts honours.
    await resumed.collector.hydrate();
    resumed.collector.increment(METRICS.ROOMS_CREATED);
    await resumed.collector.tick();

    expect(lastValue(resumed.writes, METRICS.ROOMS_CREATED)).toBe(41);
    expect(lastValue(resumed.writes, METRICS.COMMANDS_INVOKED, 'limit')).toBe(3);
    expect(lastValue(resumed.writes, 'rooms.retired')).toBeUndefined();
  });

  /**
   * A rolling deploy replaces every instance. Without a final flush each one
   * discards up to a flush interval of counts on every release, which biases
   * exactly the metrics nothing else can recover.
   */
  it('flushes what is in memory on stop', async () => {
    const stopping = harness();
    stopping.collector.start();
    stopping.collector.increment(METRICS.ROOMS_CREATED, '', 6);
    await stopping.collector.stop();

    expect(lastValue(stopping.writes, METRICS.ROOMS_CREATED)).toBe(6);
  });

  it('samples the live gauges on its own timer, without touching the database', async () => {
    vi.useFakeTimers();
    try {
      const sampled = harness({ sampleIntervalMs: 1_000, flushIntervalMs: 10_000 });
      sampled.collector.start();
      vi.advanceTimersByTime(3_000);
      expect(sampled.writes).toHaveLength(0);
      expect(sampled.collector.stats.pending).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * §8: a collector that dies quietly leaves every chart downstream reading zero,
   * and a zero looks exactly like an answer.
   */
  it('reports staleness once the newest bucket falls behind', async () => {
    await h.collector.tick();
    expect(h.collector.stats.stale).toBe(false);

    h.setNow(new Date('2026-08-19T18:00:00Z'));
    expect(h.collector.stats.stale).toBe(true);
  });
});
