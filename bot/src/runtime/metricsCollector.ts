import {
  hourBucket,
  METRICS,
  METRICS_JOB_KEY,
  METRICS_ADVISORY_SLOT,
  METRICS_STALE_AFTER_MS,
  RUNTIME_FLAGS,
  metricDefinition,
  type BillingRunRepository,
  type Fleet,
  type Logger,
  type MetricName,
  type MetricWrite,
  type MetricsRepository,
  type RuntimeFlagsRepository,
} from '@avc/core';

/**
 * The metrics collector (`plans/admin-dashboard.md` §3.4). Two jobs in one
 * timer, split by the nature of what they measure:
 *
 * 1. **Flush** (every instance): counters and peaks accumulated in memory on
 *    the hot path, written under this instance's own key. Nothing here is
 *    derivable from SQL after the fact (a room's row is deleted with the
 *    room, a command invocation leaves no trace at all), so an uncounted
 *    event is unanswerable forever.
 * 2. **Rollup** (cluster singleton): every gauge that *is* derivable,
 *    computed in SQL, plus the hourly-to-daily rollup and retention prune.
 *    Reserved through `billing_runs` with its own advisory slot, like the
 *    billing advance, so it runs once across the whole cluster.
 *
 * **Runs on self-host too**, like the backup scheduler and unlike the
 * billing job: counting your own rooms costs a few dozen rows an hour, and a
 * self-hoster asking "when did rooms stop being created here" deserves an
 * answer. `metrics.disabled` is the off switch.
 *
 * The hot path never touches the database and never awaits: {@link increment}
 * and {@link observePeak} mutate a Map and return. Telemetry that can block a
 * voice event, or throw into one, is worse than no telemetry.
 */

/**
 * What `GET /gateway/bot` tells us about this application's identify budget.
 *
 * `sessionUsed` rather than `remaining`, computed at the poll, because a
 * remaining-style gauge summarises to its last hourly sample and the daily
 * reset would erase the very restart loop it exists to catch.
 */
export interface GatewayLimits {
  recommendedShards: number;
  maxConcurrency: number;
  sessionUsed: number;
  sessionTotal: number;
}

export interface MetricsCollectorDeps {
  metrics: MetricsRepository;
  /** Durable spacing + the cluster-singleton lock for the rollup half. */
  runs: BillingRunRepository;
  flags: RuntimeFlagsRepository;
  fleet: Fleet;
  instanceId: string;
  logger: Logger;
  /**
   * Live values this instance can read for free, sampled between flushes.
   *
   * Sampled rather than pushed because a peak is a property of a moment nobody
   * else is watching: the dispatcher has no reason to announce every queue-depth
   * change, and polling it costs a map walk.
   */
  sample: () => { queueDepth: number; trippedCircuits: number };
  /** Injectable RSS reader, for tests. Defaults to `process.memoryUsage.rss`. */
  readRss?: () => number;
  /**
   * Polls Discord for this application's gateway limits, or undefined to skip.
   *
   * Returns undefined on failure rather than a fallback, and the distinction
   * matters: boot falls back to `max_concurrency: 1` when the call fails, and
   * writing that as a gauge would look like a real collapse of the identify
   * budget rather than an unanswered question. Absence is how this store says
   * "unknown".
   */
  pollGateway?: () => Promise<GatewayLimits | undefined>;
  /**
   * Reports a significant condition to the operational alert channel.
   *
   * Both failure paths below were `/diagnostics` fields and a log line, which
   * means they were only ever found by someone who already suspected something
   * and went looking. Telemetry going dark is not itself an outage, so these
   * are reported and never allowed to gate anything.
   */
  report?: (kind: string, message: string, context: Record<string, unknown>) => void;
  now?: () => Date;
  /** How often accumulators are written. Default 5 minutes. */
  flushIntervalMs?: number;
  /** How often live gauges are sampled into the accumulator. Default 30s. */
  sampleIntervalMs?: number;
  /** Min spacing between cluster-wide rollups. Default 55 min. */
  rollupSpacingMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface MetricsCollectorStats {
  /** Timers are ticking. Says nothing about whether work is being done. */
  running: boolean;
  /** `global.pause` was set at the last tick. */
  paused: boolean;
  /** `metrics.disabled` was set at the last tick. */
  disabled: boolean;
  lastFlushAt: string | null;
  lastRollupAt: string | null;
  /** Accumulator entries waiting to be written. */
  pending: number;
  /** Newest hourly bucket in the store, from the last rollup's freshness read. */
  lastBucket: string | null;
  /**
   * Whether the store looks abandoned.
   *
   * §8's risk row in the plan: a collector that dies quietly leaves every chart
   * downstream reading zero, and a zero looks exactly like an answer. This is the
   * signal that makes that visible, and it is reported, never returned as
   * unhealthy - a gap in telemetry must not roll back a deploy.
   */
  stale: boolean;
  /**
   * The two halves fail independently and are reported independently.
   *
   * They were one field, and the rollup cleared it on success - so on the one
   * instance that also wins the rollup, a flush that had been failing for hours
   * reported no error at all. Same rule the backup scheduler already follows for
   * its drill: one job's success must never speak for another job's health.
   */
  lastFlushError: string | null;
  lastRollupError: string | null;
}

/** Name -> true, so a hydrated row written by another build's metric is skipped. */
const METRIC_BY_NAME: Record<string, true> = Object.fromEntries(
  Object.values(METRICS).map((name) => [name, true]),
);

/**
 * Separator for the composite accumulator key.
 *
 * A NUL rather than a space or a colon, because half the key is a metric's own
 * dimension and those are not all identifiers: an error category or a future
 * dimension could contain either, and a key that splits wrong silently merges
 * two series into one.
 */
const KEY_SEP = '\u0000';

/** A metric plus its dimension, as one accumulator key. */
function accumulatorKey(bucketMs: number, metric: MetricName, key: string): string {
  return `${bucketMs}${KEY_SEP}${metric}${KEY_SEP}${key}`;
}

function parseAccumulatorKey(composite: string): {
  bucketMs: number;
  metric: MetricName;
  key: string;
} {
  // `slice(2).join`, not a third destructured element: a dimension that itself
  // contained the separator would otherwise be truncated at the split, and two
  // different keys collapsing to the same string would put two rows with the same
  // primary key in one INSERT, which Postgres rejects outright ("ON CONFLICT DO
  // UPDATE command cannot affect row a second time"). That fails the whole flush,
  // and the accumulator is retained on failure, so it would fail every tick after.
  const [bucket, metric, ...rest] = composite.split(KEY_SEP);
  return { bucketMs: Number(bucket), metric: metric as MetricName, key: rest.join(KEY_SEP) };
}

export class MetricsCollector {
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private sampleTimer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private flushing: Promise<void> | undefined;

  /**
   * `bucket|metric|key` -> value, for the current bucket and (briefly) the one
   * before it.
   *
   * Holds the bucket's **running total**, not a delta, which is what makes a
   * re-flush idempotent: the same numbers land on the same rows. Bounded by
   * metric cardinality (a couple of dozen keys) times two buckets, and pruned
   * every tick whether or not the flush succeeded, so a long outage cannot turn
   * it into a leak.
   */
  private readonly accumulator = new Map<string, number>();

  /**
   * Whether anything in the accumulator has changed since the last successful
   * flush.
   *
   * Without it every tick rewrote every entry, so each hourly row was upserted a
   * dozen times an hour to store the value it already held - and a quiet self-host
   * with nothing happening wrote just as often as a busy fleet. Set only when a
   * value actually changes (a peak that does not beat its own maximum is not a
   * change) and cleared only on a *successful* write, so a failed flush stays
   * pending.
   */
  private dirty = false;

  /** Last-seen kill-switch state, so `/diagnostics` can say why it is idle. */
  private paused = false;
  private disabled = false;
  /** When the timers started, so "nothing has ever been written" can go stale. */
  private startedAt: Date | null = null;
  private lastFlushAt: Date | null = null;
  private lastRollupAt: Date | null = null;
  private lastBucket: Date | null = null;
  private lastFlushError: string | null = null;
  private lastRollupError: string | null = null;

  private readonly now: () => Date;
  private readonly flushIntervalMs: number;
  private readonly sampleIntervalMs: number;
  private readonly rollupSpacingMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(private readonly deps: MetricsCollectorDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.flushIntervalMs = deps.flushIntervalMs ?? 5 * 60_000;
    this.sampleIntervalMs = deps.sampleIntervalMs ?? 30_000;
    /**
     * Under an hour on purpose, and for the same reason the billing advance is:
     * at exactly 60 minutes, drift lets two consecutive runs land either side of
     * an hour boundary and skip a bucket entirely. At 55 no gap between runs can
     * be long enough to miss one.
     */
    this.rollupSpacingMs = deps.rollupSpacingMs ?? 55 * 60_000;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  /* ---------------------------------------------------------------------- */
  /* The hot path                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Counts one occurrence. Synchronous, in-memory, and cannot throw into a
   * caller: an unknown metric name is a programming error and is logged rather
   * than raised, because the alternative is telemetry taking down a voice event.
   */
  increment(metric: MetricName, key = '', by = 1): void {
    this.accumulate(metric, key, by, 'counter');
  }

  /**
   * Records the highest value seen in this bucket.
   *
   * `key` is optional and defaults to the undimensioned form. It exists for
   * `process.rss_peak`, which must be keyed by instance: both the daily rollup
   * and `readSeries` sum across instances before summarising, so a per-machine
   * number recorded without a key comes back as a fleet total. `key` survives
   * both aggregations; the `instance` column does not.
   */
  observePeak(metric: MetricName, value: number, key = ''): void {
    this.accumulate(metric, key, value, 'peak');
  }

  private accumulate(metric: MetricName, key: string, value: number, expected: string): void {
    try {
      const kind = metricDefinition(metric).kind;
      if (kind !== expected) {
        this.deps.logger.warn({ metric, kind, expected }, 'metric recorded with the wrong verb');
        return;
      }
      const composite = accumulatorKey(hourBucket(this.now()).getTime(), metric, key);
      const current = this.accumulator.get(composite);
      const next = expected === 'peak' ? Math.max(current ?? 0, value) : (current ?? 0) + value;
      if (next === current) return;
      this.accumulator.set(composite, next);
      this.dirty = true;
    } catch (err) {
      this.deps.logger.warn({ err, metric }, 'metric not recorded');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Reloads this instance's already-written counters for the current bucket.
   * Must be called before the gateway connects (`index.ts` does). The
   * accumulator holds running totals, not deltas, so the stored value and a
   * live in-memory count are disjoint numbers with no safe way to combine:
   * adding double-counts what's already flushed, and taking the larger
   * silently drops whichever side is smaller. Starting from an empty
   * accumulator is what makes the resume exact rather than a guess; the
   * `max` below is a belt-and-braces no-op in that ordering, guarding only
   * against a stray second call.
   */
  async hydrate(): Promise<void> {
    try {
      const bucket = hourBucket(this.now());
      const rows = await this.deps.metrics.readInstanceBucket(
        bucket,
        this.deps.instanceId,
        this.deps.fleet,
      );
      for (const row of rows) {
        if (!(row.metric in METRIC_BY_NAME)) continue;
        const key = accumulatorKey(bucket.getTime(), row.metric as MetricName, row.key);
        // Merged rather than assigned: see the ordering note above.
        const merged = Math.max(this.accumulator.get(key) ?? 0, row.value);
        if (merged !== this.accumulator.get(key)) this.dirty = true;
        this.accumulator.set(key, merged);
      }
      if (rows.length > 0) {
        this.deps.logger.info({ resumed: rows.length }, 'metrics accumulators resumed');
      }
    } catch (err) {
      // A failed resume costs at most the current hour's already-flushed counts
      // for this instance, and only until the next bucket. Not worth refusing to
      // start over.
      this.deps.logger.warn({ err }, 'metrics hydrate failed');
    }
  }

  start(): void {
    if (this.flushTimer) return;
    this.startedAt = this.now();
    this.sampleTimer = this.setIntervalFn(() => this.sampleNow(), this.sampleIntervalMs);
    (this.sampleTimer as { unref?: () => void }).unref?.();
    this.flushTimer = this.setIntervalFn(() => {
      void this.tick().catch((err: unknown) => {
        this.deps.logger.error({ err }, 'metrics tick failed');
      });
    }, this.flushIntervalMs);
    (this.flushTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Stops the timers and writes what is in memory.
   *
   * The final flush is the point. A rolling deploy replaces every instance, and
   * without it each one would silently discard up to a flush interval of counts
   * on every release - which is a systematic downward bias on exactly the metrics
   * nothing else can recover, not a random one.
   *
   * It still asks the flags first. `metrics.disabled` is documented on
   * `/admin/ops` as "no counter flushes" and `global.pause` is documented as
   * stopping the collector, and a drain that wrote anyway made both statements
   * false in the one situation an operator is most likely to be watching: with the
   * master kill-switch set, every rolling deploy would have written out whatever
   * had accumulated behind it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sampleTimer) this.clearIntervalFn(this.sampleTimer);
    if (this.flushTimer) this.clearIntervalFn(this.flushTimer);
    this.sampleTimer = undefined;
    this.flushTimer = undefined;
    await this.flushing?.catch(() => {});
    if (await this.writesDisabled()) return;
    this.sampleNow();
    await this.flush().catch((err: unknown) => {
      this.deps.logger.warn({ err }, 'final metrics flush failed');
    });
  }

  /**
   * Whether either kill switch forbids writing right now.
   *
   * A flag read that throws is treated as "not disabled": the collector's job is to
   * record, and losing telemetry because the flags table was briefly unreachable is
   * the worse of the two failures. It also caches the answer for `stats`, so
   * `/diagnostics` can say *why* nothing is being written - which is exactly what
   * AGENTS.md sends an operator to that block to find out.
   */
  private async writesDisabled(): Promise<boolean> {
    const flags = await this.deps.flags.getAll().catch(() => ({}) as Record<string, unknown>);
    this.paused = flags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true;
    this.disabled = flags[RUNTIME_FLAGS.METRICS_DISABLED] === true;
    return this.paused || this.disabled;
  }

  get stats(): MetricsCollectorStats {
    /**
     * Measured from the last successful write, or from boot when there has never
     * been one. Without the fallback a collector whose every flush has failed since
     * it started reported `stale: false`, which is the one reading this field
     * exists to prevent.
     */
    const last = this.lastBucket ?? this.lastFlushAt ?? this.startedAt;
    return {
      running: this.flushTimer !== undefined,
      // Not the same question as `running`, and the difference is what an operator
      // is looking for: the timers tick happily while both switches suppress work.
      paused: this.paused,
      disabled: this.disabled,
      lastFlushAt: this.lastFlushAt?.toISOString() ?? null,
      lastRollupAt: this.lastRollupAt?.toISOString() ?? null,
      pending: this.accumulator.size,
      lastBucket: this.lastBucket?.toISOString() ?? null,
      stale: last !== null && this.now().getTime() - last.getTime() > METRICS_STALE_AFTER_MS,
      lastFlushError: this.lastFlushError,
      lastRollupError: this.lastRollupError,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* The work                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Takes one sample now. Exposed like `BackupScheduler.runOnce`, so a test can
   * exercise the wiring rather than the verb underneath it, and so an operator
   * can force a sample without waiting for the tick.
   */
  sampleTick(): void {
    this.sampleNow();
  }

  /** Reads the live gauges into the accumulator. Memory only. */
  private sampleNow(): void {
    try {
      const { queueDepth, trippedCircuits } = this.deps.sample();
      this.observePeak(METRICS.QUEUE_DEPTH_PEAK, queueDepth);
      this.observePeak(METRICS.CIRCUITS_TRIPPED_PEAK, trippedCircuits);
      /**
       * Keyed by instance, unlike the peaks above. Until this existed, memory
       * alerts could only *project* from `guilds.member_reach` times the
       * measured 1.28 KB per cached member - a model of expected use that by
       * construction cannot see a leak or a discord.js regression. This is
       * the actual measurement.
       */
      this.observePeak(METRICS.PROCESS_RSS_PEAK, this.readRss(), this.deps.instanceId);
    } catch (err) {
      this.deps.logger.debug({ err }, 'metrics sample failed');
    }
  }

  /**
   * RSS in bytes. `process.memoryUsage.rss()` rather than `process.memoryUsage()`
   * because the former reads only the one number and skips the heap statistics
   * walk, which is what makes it cheap enough for a 30s tick.
   */
  private readRss(): number {
    return this.deps.readRss?.() ?? process.memoryUsage.rss();
  }

  /** One tick: flush this instance's accumulators, then try to win the rollup. */
  async tick(): Promise<void> {
    if (this.stopping || this.flushing) return;
    this.flushing = this.runTick();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private async runTick(): Promise<void> {
    if (await this.writesDisabled()) {
      /**
       * Disabled means "stop writing", not "stop bounding memory".
       *
       * The hot-path counters and the sample timer read no flags, so entries keep
       * arriving while the collector is switched off. Pruning here, on **both**
       * kill-switch paths rather than only the `metrics.disabled` one, is what
       * bounds the accumulator at two buckets: a fortnight of `global.pause` used
       * to accumulate a bucket per hour of it, and the flush that eventually ran
       * would have been one INSERT of thousands of rows - past about 10,900 entries,
       * more bind parameters than Postgres accepts, which fails the statement, and
       * a failed flush is retained, so it would then fail on every tick.
       */
      this.pruneAccumulator();
      return;
    }

    await this.flush();
    await this.flushGatewayLimits();

    const reserved = await this.deps.runs
      .reserveRun(
        METRICS_JOB_KEY,
        this.rollupSpacingMs,
        this.deps.instanceId,
        METRICS_ADVISORY_SLOT,
      )
      .catch((err: unknown) => {
        this.deps.logger.warn({ err }, 'metrics rollup reservation failed');
        return { ok: false, waitMs: 0 };
      });
    if (reserved.ok) await this.rollup();
  }

  /**
   * Polls this application's gateway limits and writes them straight through,
   * bypassing the accumulator entirely.
   *
   * Three deliberate departures from every other metric here, each load-bearing:
   *
   * **`instance: ''`.** These are facts about the Discord application, not
   * about a machine. Every instance of a fleet polls and gets the identical
   * answer, so stamping each machine's own instance id would give N rows that
   * `readSeries` sums into N times the real `max_concurrency`. One empty
   * instance means one row per fleet per bucket.
   *
   * **No leader election.** The `gauge` write operator is `overwrite`, so
   * concurrent writers landing the same value on the same primary key are
   * idempotent by construction. Putting this behind the cluster-singleton
   * rollup lock would be actively wrong: that lock is not fleet-namespaced, so
   * one fleet would win it cluster-wide and the other fleet's gateway numbers
   * would never be written at all. That is the same shape as the ladder and
   * delivery bug `plans/fleets.md` section 4 exists to fix.
   *
   * **Nothing written on failure.** Boot falls back to `max_concurrency: 1`
   * when this call fails, which is right for throttling and wrong to record: a
   * 1 in the store reads as a real collapse of the identify budget rather than
   * as an unanswered question. Absence is how this store says "unknown".
   */
  private async flushGatewayLimits(): Promise<void> {
    const poll = this.deps.pollGateway;
    if (!poll) return;
    try {
      const limits = await poll();
      if (!limits) return;
      const bucket = hourBucket(this.now());
      await this.deps.metrics.writePoints(
        [
          { metric: METRICS.GATEWAY_RECOMMENDED_SHARDS, value: limits.recommendedShards },
          { metric: METRICS.GATEWAY_MAX_CONCURRENCY, value: limits.maxConcurrency },
          { metric: METRICS.GATEWAY_SESSION_USED, value: limits.sessionUsed },
          { metric: METRICS.GATEWAY_SESSION_TOTAL, value: limits.sessionTotal },
        ].map((m) => ({ ...m, key: '', bucket, instance: '' })),
        this.deps.fleet,
      );
    } catch (err) {
      // Never fatal to the tick: the counters that follow matter more than
      // these do, and an unwritten gauge is a gap rather than a wrong number.
      this.deps.logger.warn({ err }, 'gateway limits poll failed');
    }
  }

  /** Writes every accumulator entry, then drops the ones that can no longer change. */
  private async flush(): Promise<void> {
    if (this.accumulator.size === 0 || !this.dirty) {
      this.pruneAccumulator();
      return;
    }
    const points: MetricWrite[] = [];
    for (const [composite, value] of this.accumulator) {
      const { bucketMs, metric, key } = parseAccumulatorKey(composite);
      points.push({
        metric,
        key,
        value,
        bucket: new Date(bucketMs),
        instance: this.deps.instanceId,
      });
    }

    /**
     * Cleared BEFORE the await, not after.
     *
     * `points` is a snapshot, so a counter incremented while the write is in flight
     * is a change this write does not carry. Clearing afterwards would wipe the flag
     * that increment just set and strand it until the next unrelated change;
     * clearing first means it survives and the next tick sends it. Restored on
     * failure below, so a failed flush stays pending.
     */
    this.dirty = false;
    try {
      await this.deps.metrics.writePoints(points, this.deps.fleet);
      this.lastFlushAt = this.now();
      this.lastFlushError = null;
      this.pruneAccumulator();
    } catch (err) {
      /**
       * Entries are kept on failure, deliberately. Every write is an idempotent
       * upsert of a running total, so retrying the same numbers next tick is
       * free, and dropping them would lose counts nothing can recover.
       */
      this.dirty = true;
      this.lastFlushError = (err as Error).message;
      this.deps.logger.warn({ err, pending: this.accumulator.size }, 'metrics flush failed');
      this.deps.report?.('metrics.flush', 'Metrics flush failed', {
        error: this.lastFlushError,
        pending: this.accumulator.size,
      });
    }
  }

  /**
   * Forgets buckets that are two or more hours old.
   *
   * The previous bucket is kept because a flush can land after the hour rolls
   * over and must still carry the finished hour's final total; anything older
   * than that has been written or lost already, and keeping it would only grow.
   */
  private pruneAccumulator(): void {
    const cutoff = hourBucket(this.now()).getTime() - 3_600_000;
    for (const composite of this.accumulator.keys()) {
      if (parseAccumulatorKey(composite).bucketMs < cutoff) this.accumulator.delete(composite);
    }
  }

  /**
   * The cluster-singleton half: derived gauges, the daily rollup, the prune.
   *
   * **Three separate try blocks, not one.** Merged into one, a `collectGauges`
   * failure (a lock timeout, a permissions change) would also skip
   * `rollupDaily` - and the daily table is the only thing the charts read, so
   * that outage leaves permanent holes rather than a recoverable gap. Each
   * fails for unrelated reasons and each is independently useful, so each
   * gets to run.
   */
  private async rollup(): Promise<void> {
    const at = this.now();
    let failures = 0;
    const fail = (stage: string, err: unknown): void => {
      failures += 1;
      this.lastRollupError = `${stage}: ${(err as Error).message}`;
      this.deps.logger.error({ err, stage }, 'metrics rollup stage failed');
      /**
       * Keyed by stage, so a broken rollup and a broken prune are separate
       * conditions rather than one overwriting the other's message.
       */
      this.deps.report?.(`metrics.rollup.${stage}`, `Metrics rollup stage ${stage} failed`, {
        stage,
        error: (err as Error).message,
      });
    };

    let gauges: Record<string, number> = {};
    try {
      gauges = await this.deps.metrics.collectGauges(at);
    } catch (err) {
      fail('gauges', err);
    }

    let rolled = 0;
    try {
      /**
       * The window comes from the store, not from the calendar: it starts at the
       * newest day already rolled up, so an outage backfills itself instead of
       * leaving holes nothing revisits. Steady state is still yesterday and today.
       */
      const window = await this.deps.metrics.rollupWindow(at);
      rolled = await this.deps.metrics.rollupDaily(window.from, window.to);
    } catch (err) {
      fail('daily', err);
    }

    let pruned = 0;
    try {
      pruned = await this.deps.metrics.pruneHourly(at);
    } catch (err) {
      fail('prune', err);
    }

    try {
      const freshness = await this.deps.metrics.freshness();
      this.lastBucket = freshness.lastHourlyBucket;
      this.deps.logger.info(
        { gauges, rolled, pruned, hourlyRows: freshness.hourlyRows, failures },
        'metrics rollup complete',
      );
    } catch (err) {
      fail('freshness', err);
    }

    // Only a clean pass clears the error and stamps the run: a partial one is a
    // problem an operator should still see on /diagnostics next time they look.
    if (failures === 0) {
      this.lastRollupAt = at;
      this.lastRollupError = null;
    }
  }
}
