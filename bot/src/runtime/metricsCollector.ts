import {
  dayBucket,
  hourBucket,
  METRICS,
  METRICS_JOB_KEY,
  METRICS_ADVISORY_SLOT,
  METRICS_STALE_AFTER_MS,
  RUNTIME_FLAGS,
  metricDefinition,
  metricResolution,
  type BillingRunRepository,
  type Fleet,
  type Logger,
  type MetricName,
  type MetricWrite,
  type MetricsRepository,
  type RuntimeFlagsRepository,
} from '@avc/core';

/**
 * The metrics collector. Two jobs in one
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
  /**
   * The audit log, whose retention runs alongside the metrics prune.
   *
   * Optional so a self-host and every existing test stay valid without it, and
   * because nothing else here needs it.
   */
  opsAudit?: { prune: (now: Date) => Promise<number> };
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
   * A collector that dies quietly leaves every chart
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

/**
 * The bucket a metric accumulates into: its OWN resolution, never the hour.
 *
 * A daily metric accumulated hourly is broken twice over, and both failures are
 * silent until they are total. `writePoints` day-truncates a daily point, so
 * twenty-four hour buckets collapse onto one primary key and land in a single
 * INSERT - which Postgres rejects outright ("ON CONFLICT DO UPDATE command
 * cannot affect row a second time"), failing the whole flush, and a failed
 * flush is retained, so it then fails on every tick after. Survive that and the
 * counter is still wrong: `greatest` would keep the single busiest hour rather
 * than the day's total, because each hour starts its running total from zero.
 */
function bucketFor(metric: MetricName, at: Date): Date {
  return metricResolution(metric) === 'daily' ? dayBucket(at) : hourBucket(at);
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
   * re-flush idempotent: the same numbers land on the same rows. Pruned every
   * tick whether or not the flush succeeded, so a long outage cannot turn it
   * into a leak.
   *
   * Bounded by metric cardinality times two buckets, which was a couple of
   * dozen keys until `rooms.created.by_guild` made it one entry per guild that
   * created a room today. That is the term to watch: it scales with the active
   * install base rather than with the metric list, and it is why `writePoints`
   * chunks its INSERT rather than trusting a flush to fit in one statement.
   */
  private readonly accumulator = new Map<string, number>();

  /**
   * Which accumulator entries have changed since the last successful flush.
   *
   * A SET of keys, not one flag. Without it every tick rewrote every entry, so
   * each hourly row was upserted a dozen times an hour to store the value it
   * already held - and a quiet self-host with nothing happening wrote just as
   * often as a busy fleet. A single flag fixed the quiet case and not the busy
   * one: any metric changing marked all of them, and the RSS peak changes on
   * nearly every sample. That was tolerable at two dozen keys and is not at one
   * key per active guild.
   *
   * Populated only when a value actually changes (a peak that does not beat its
   * own maximum is not a change) and cleared only on a *successful* write, so a
   * failed flush stays pending. Bounded by the accumulator it indexes.
   */
  private readonly changed = new Set<string>();

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
      const composite = accumulatorKey(bucketFor(metric, this.now()).getTime(), metric, key);
      const current = this.accumulator.get(composite);
      const next = expected === 'peak' ? Math.max(current ?? 0, value) : (current ?? 0) + value;
      if (next === current) return;
      this.accumulator.set(composite, next);
      this.changed.add(composite);
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
   *
   * **Both tables**, because a daily metric's bucket is a day: skipping the
   * daily read would leave `rooms.created.by_guild` stalled from the restart
   * until midnight rather than for the rest of an hour, and the stall lands on
   * whichever guilds were busiest before the deploy.
   */
  async hydrate(): Promise<void> {
    try {
      const at = this.now();
      const reads = await Promise.all(
        (['hourly', 'daily'] as const).map(async (resolution) => ({
          resolution,
          rows: await this.deps.metrics.readInstanceBucket(
            at,
            this.deps.instanceId,
            this.deps.fleet,
            resolution,
          ),
        })),
      );

      let resumed = 0;
      for (const read of reads) {
        for (const row of read.rows) {
          if (!(row.metric in METRIC_BY_NAME)) continue;
          const metric = row.metric as MetricName;
          /**
           * Only rows belonging to the table's own resolution.
           *
           * `metrics_daily` holds two different things: the daily-only metrics
           * written straight to it, and the rollup's summary of every hourly
           * metric. Resuming an hourly counter from the latter would seed the
           * current HOUR with a whole day's total, and `greatest` would then
           * hold it there for the rest of the hour. The rollup stamps `instance
           * = ''` so today's read misses those anyway, but that is a property of
           * another method and this must not depend on it.
           */
          if (metricResolution(metric) !== read.resolution) continue;
          // The metric's own bucket, so a daily row resumes the daily entry the
          // hot path will add to rather than seeding a phantom hourly one.
          const key = accumulatorKey(bucketFor(metric, at).getTime(), metric, row.key);
          // Merged rather than assigned: see the ordering note above.
          const merged = Math.max(this.accumulator.get(key) ?? 0, row.value);
          if (merged !== this.accumulator.get(key)) this.changed.add(key);
          this.accumulator.set(key, merged);
          resumed += 1;
        }
      }
      if (resumed > 0) {
        this.deps.logger.info({ resumed }, 'metrics accumulators resumed');
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
   * `/diagnostics` can say *why* nothing is being written.
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
    /**
     * Polled BEFORE the kill-switch check, and that ordering is load-bearing for
     * something outside this class.
     *
     * `index.ts` caches this reading, and `GatewaySupervisor` reads the cache to
     * decide whether it may spend an identify on restarting the machine. While
     * the poll sat after the early return below, `metrics.disabled` or
     * `global.pause` left that cache permanently empty, which silently disarmed
     * the one guard that speaks to fleet-wide identify exhaustion. `global.pause`
     * is exactly the lever an operator sets while load-shedding during an
     * incident, which is precisely when the guard matters.
     *
     * A poll is a REST read, not a metric write, so neither flag is about it.
     * One call per flush interval is negligible even under a deliberate
     * load-shed, and what the flags still suppress is the four points it feeds.
     */
    const gatewayLimits = await this.pollGatewayLimits();
    if (await this.writesDisabled()) {
      /**
       * Disabled means "stop writing", not "stop bounding memory".
       *
       * The hot-path counters and the sample timer read no flags, so entries keep
       * arriving while the collector is switched off. Pruning here, on **both**
       * kill-switch paths rather than only the `metrics.disabled` one, is what
       * bounds the accumulator at two buckets: a fortnight of `global.pause` used
       * to accumulate a bucket per hour of it, and the flush that eventually ran
       * would have been one INSERT of thousands of rows. `writePoints` chunks
       * its statements now, so that can no longer overrun the bind-parameter
       * limit - but bounding the memory is why this call is here, and a
       * guild-keyed entry per active guild makes each retained bucket much
       * larger than the couple of dozen keys it used to hold.
       */
      this.pruneAccumulator();
      return;
    }

    await this.flush();
    await this.writeGatewayLimits(gatewayLimits);

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
   * would never be written at all. If polling is ever elected, scope that
   * reservation to the fleet that can observe the application's limits.
   *
   * **Nothing written on failure.** Boot falls back to `max_concurrency: 1`
   * when this call fails, which is right for throttling and wrong to record: a
   * 1 in the store reads as a real collapse of the identify budget rather than
   * as an unanswered question. Absence is how this store says "unknown".
   */
  private async pollGatewayLimits(): Promise<GatewayLimits | undefined> {
    const poll = this.deps.pollGateway;
    if (!poll) return undefined;
    try {
      return await poll();
    } catch (err) {
      // Never fatal to the tick: the counters that follow matter more than
      // these do, and an unwritten gauge is a gap rather than a wrong number.
      this.deps.logger.warn({ err }, 'gateway limits poll failed');
      return undefined;
    }
  }

  private async writeGatewayLimits(limits: GatewayLimits | undefined): Promise<void> {
    if (!limits) return;
    try {
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
      // Never fatal to the tick, same as the poll above: an unwritten gauge is a
      // gap rather than a wrong number.
      this.deps.logger.warn({ err }, 'gateway limits write failed');
    }
  }

  /**
   * Writes the entries that have CHANGED, then drops the ones that can no longer
   * change.
   *
   * Per entry rather than "everything, whenever anything changed", which is what
   * this did while the accumulator held two dozen keys and one flag could stand
   * in for all of them. It cannot stand in for a guild-keyed metric: `dirty` is
   * set on essentially every tick by the RSS peak alone, so every entry was
   * re-upserted 288 times a day, and `pruneAccumulator` keeps the previous
   * period too - so an entry was still being rewritten long after the day it
   * describes had ended and its value was frozen. At a few thousand active
   * guilds that is hundreds of thousands of writes a day to store numbers
   * nothing changed, on a table nothing prunes.
   *
   * The idempotency argument is untouched: each write is still the bucket's
   * running total, so a retry lands on the same number, and an entry whose write
   * failed stays marked and is retried next tick.
   */
  private async flush(): Promise<void> {
    if (this.changed.size === 0) {
      this.pruneAccumulator();
      return;
    }
    const points: MetricWrite[] = [];
    for (const composite of this.changed) {
      const value = this.accumulator.get(composite);
      // Pruned between being marked and being flushed. Nothing to write: the
      // prune only drops periods that have already been written or lost.
      if (value === undefined) continue;
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
     * is a change this write does not carry. Clearing afterwards would wipe the mark
     * that increment just set and strand it until the next unrelated change;
     * clearing first means it survives and the next tick sends it. Restored on
     * failure below, so a failed flush stays pending.
     */
    const sent = [...this.changed];
    this.changed.clear();
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
      for (const composite of sent) this.changed.add(composite);
      this.lastFlushError = (err as Error).message;
      this.deps.logger.warn({ err, pending: this.accumulator.size }, 'metrics flush failed');
      this.deps.report?.('metrics.flush', 'Metrics flush failed', {
        error: this.lastFlushError,
        pending: this.accumulator.size,
      });
    }
  }

  /**
   * Forgets buckets older than the previous one, at each metric's OWN
   * resolution.
   *
   * The previous bucket is kept because a flush can land after the period rolls
   * over and must still carry the finished period's final total; anything older
   * than that has been written or lost already, and keeping it would only grow.
   *
   * Resolution-aware for the same reason {@link bucketFor} is, and the failure
   * is quieter than that one: a daily entry's bucket is today's midnight, which
   * is more than an hour old from 01:00 UTC onwards, so a flat hourly cutoff
   * dropped every daily running total on the first tick after 1am and started
   * the day again from zero. `greatest` then pins the stored value to whichever
   * fragment was largest - a day's count reported as one hour of it, with
   * nothing failing.
   */
  private pruneAccumulator(): void {
    const now = this.now();
    const hourly = hourBucket(now).getTime() - 3_600_000;
    /**
     * A day bucket is kept for one HOUR past midnight, not for a whole day.
     *
     * The rule being served is "a flush landing after the period rolls over must
     * still carry the finished period's final total", and a flush interval is
     * five minutes, so an hour of slack serves it just as well at either
     * resolution. A symmetric full-day window would instead re-upsert yesterday's
     * entire per-guild set on every one of the day's 288 ticks, on every
     * instance: unchanged rows, written thousands of times, growing with the
     * install base. The asymmetry is the point.
     */
    const today = dayBucket(now).getTime();
    const daily = now.getTime() - today < 3_600_000 ? today - 86_400_000 : today;
    for (const composite of this.accumulator.keys()) {
      const { bucketMs, metric } = parseAccumulatorKey(composite);
      const cutoff = metricResolution(metric) === 'daily' ? daily : hourly;
      if (bucketMs < cutoff) {
        this.accumulator.delete(composite);
        // Or the set outlives the map and grows without bound.
        this.changed.delete(composite);
      }
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

    /**
     * The audit log's retention rides along here.
     *
     * Same reason it is not its own scheduler: this job is already the cluster
     * singleton for "tidy the tables once an hour", it already holds the
     * reservation, and a second timer for one DELETE would be a second thing to
     * forget. Its own try, so a failure here cannot cost the metrics prune, and
     * counted separately so the log does not conflate the two.
     */
    let auditPruned = 0;
    if (this.deps.opsAudit) {
      try {
        auditPruned = await this.deps.opsAudit.prune(at);
      } catch (err) {
        fail('audit-prune', err);
      }
    }

    try {
      const freshness = await this.deps.metrics.freshness();
      this.lastBucket = freshness.lastHourlyBucket;
      this.deps.logger.info(
        { gauges, rolled, pruned, auditPruned, hourlyRows: freshness.hourlyRows, failures },
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
