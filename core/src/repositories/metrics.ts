import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  dayBucket,
  hourBucket,
  METRIC_SHARED_SCOPE,
  METRICS,
  METRICS_HOURLY_RETENTION_DAYS,
  metricDefinition,
  metricFleet,
  metricResolution,
  rollupAggregate,
  writeOperator,
  type MetricFleet,
  type MetricName,
} from '../domain/metrics.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { SUBSCRIPTION_OK_STATUSES } from './subscriptions.js';

/**
 * Advisory-lock namespace for the metrics rollup, a sibling of
 * `BILLING_ADVISORY_LOCK` (0x5a7c_0002).
 *
 * Its own key rather than sharing the billing one, because the billing advance
 * pass walks the entire install base and holds its lock for the duration: a
 * shared key would make every metrics tick queue behind it and miss its bucket.
 *
 * **Deliberately not fleet-scoped**, for the same reason the billing advance is
 * not: it computes shared facts from shared tables, so it must run once across
 * the whole cluster no matter how many fleets are up. Two fleets each writing
 * `guilds.installed` would be two rows a reader could sum into nonsense - which
 * is also why the fleet column carries `'shared'` for those rows and cannot be
 * summed by accident.
 */
export const METRICS_ADVISORY_SLOT = 1;

/** The `billing_runs` job key for the rollup's durable spacing. */
export const METRICS_JOB_KEY = 'metrics.rollup';

/**
 * The metrics {@link MetricsRepository.collectGauges} derives in SQL, as opposed
 * to the ones an instance accumulates on the hot path.
 *
 * Listed once so the sweep and the inserts cannot disagree about which rows the
 * rollup owns. Everything here is written with `instance = ''`.
 */
const DERIVED_METRICS: MetricName[] = [
  METRICS.GUILDS_INSTALLED,
  METRICS.GUILDS_STATUS,
  METRICS.GUILDS_MEMBER_REACH,
  METRICS.SUBSCRIPTIONS_ACTIVE,
  METRICS.GUILDS_PRESENT,
  METRICS.ROOMS_TRACKED,
  METRICS.CHANNELS_CREATOR,
];

/** One point to write. */
export interface MetricWrite {
  metric: MetricName;
  /** The metric's own dimension (command name, auth status, tier). */
  key?: string;
  value: number;
  /** UTC hour (or day, for a daily-only metric). Truncated defensively. */
  bucket: Date;
  /** Which instance is reporting. `''` for a shared fact nobody owns. */
  instance?: string;
}

export interface MetricSeriesPoint {
  bucket: Date;
  key: string;
  value: number;
}

export interface ReadSeriesOptions {
  metric: MetricName;
  from: Date;
  to: Date;
  resolution?: 'hourly' | 'daily';
  /**
   * Restrict to one fleet. Omit to aggregate every fleet, which is what almost
   * every operator question wants ("how many rooms did we create") and is
   * always correct: a shared-scope metric has exactly one fleet value, so there
   * is nothing to double.
   */
  fleet?: MetricFleet;
}

export interface MetricsFreshness {
  /** Newest hourly bucket written by anyone, or null if the store is empty. */
  lastHourlyBucket: Date | null;
  /** Newest daily bucket, or null. */
  lastDailyBucket: Date | null;
  hourlyRows: number;
  dailyRows: number;
}

/**
 * The metric store (`plans/admin-dashboard.md` §3.4).
 *
 * Everything here is written by the bot and only read by the web app - the bot
 * is the only process that sees the events, and §3.3 is explicit that the web
 * app never caches diagnostics into this store.
 *
 * **Every aggregation happens server-side**, as `INSERT ... SELECT` and grouped
 * reads. That is a cost decision as much as a tidiness one: the alternative
 * (pull rows out, reduce in TS, write them back) would move tens of thousands of
 * rows across the wire every hour to produce a few dozen, and per-read pricing is
 * one of the constraints that actually bites on this service.
 */
export class MetricsRepository {
  constructor(private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* Writing                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Upserts points, applying each metric's own write operator.
   *
   * Grouped by operator rather than written one statement per point: a flush is
   * a few dozen rows and one round trip per operator is the difference between a
   * cheap background job and a chatty one.
   */
  async writePoints(points: readonly MetricWrite[], writer: Fleet = DEFAULT_FLEET): Promise<void> {
    if (points.length === 0) return;

    const groups = new Map<
      string,
      { resolution: 'hourly' | 'daily'; operator: 'overwrite' | 'greatest'; rows: SQL[] }
    >();
    for (const point of points) {
      const resolution = metricResolution(point.metric);
      const operator = writeOperator(metricDefinition(point.metric).kind);
      const groupKey = `${resolution}:${operator}`;
      const bucket = resolution === 'daily' ? dayBucket(point.bucket) : hourBucket(point.bucket);
      const row = sql`(${bucket}, ${point.metric}, ${metricFleet(point.metric, writer)}, ${
        point.instance ?? ''
      }, ${point.key ?? ''}, ${Math.trunc(point.value)})`;
      const group = groups.get(groupKey);
      if (group) group.rows.push(row);
      else groups.set(groupKey, { resolution, operator, rows: [row] });
    }

    for (const group of groups.values()) {
      const table = group.resolution === 'daily' ? sql`metrics_daily` : sql`metrics_hourly`;
      const value =
        group.operator === 'greatest'
          ? sql`greatest(${table}.value, excluded.value)`
          : sql`excluded.value`;
      await this.db.execute(sql`
        INSERT INTO ${table} (bucket, metric, fleet, instance, key, value)
        VALUES ${sql.join(group.rows, sql`, `)}
        ON CONFLICT (bucket, metric, fleet, instance, key) DO UPDATE
          SET value = ${value}, updated_at = now()
      `);
    }
  }

  /**
   * This instance's own counter/peak rows for a bucket, so a restart resumes its
   * accumulators instead of starting from zero.
   *
   * `greatest` on write already makes a restart unable to walk a counter
   * backwards, but on its own it would leave the counter stalled until the fresh
   * accumulator overtook the pre-restart total - which for a busy hour is most of
   * the hour. Reading the row back costs one query per boot.
   */
  async readInstanceBucket(
    bucket: Date,
    instance: string,
    writer: Fleet = DEFAULT_FLEET,
  ): Promise<{ metric: string; key: string; value: number }[]> {
    const result = await this.db.execute<{
      metric: string;
      key: string;
      value: string | number;
    }>(sql`
      SELECT metric, key, value FROM metrics_hourly
       WHERE bucket = ${hourBucket(bucket)}
         AND instance = ${instance}
         AND fleet = ${writer}
    `);
    return result.rows.map((row) => ({
      metric: row.metric,
      key: row.key,
      value: Number(row.value),
    }));
  }

  /* ---------------------------------------------------------------------- */
  /* Gauges derived from the domain tables                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Computes every derivable gauge for one hour bucket, in SQL.
   *
   * Called by the cluster singleton only. Splits into shared-scope rows (facts
   * about the customer base, from tables with no fleet column) and per-fleet rows
   * (facts about each bot, read from each table's OWN fleet column - so one
   * writer produces correct rows for every fleet, including a fleet that is
   * currently down, and no instance has to guess on another's behalf).
   *
   * **Gauges sweep and replace, in one transaction; peaks do not.** A gauge's
   * existing rows for the bucket are deleted before the inserts run, because an
   * `INSERT ... SELECT` whose `GROUP BY` produces no row for a group cannot clear
   * a row that group left behind on an earlier pass in the same hour: the last
   * `grace` guild leaving grace would keep `guilds.status/grace = 1` for the rest
   * of the hour, and a store whose whole purpose is honest history would be
   * quietly holding a number that was true twenty minutes ago. Absence is how this
   * store says zero, so a group that empties has to actually disappear.
   *
   * A **peak** is the opposite: its row is the highest value seen in the bucket, so
   * a later sample must never replace a higher earlier one, and a group that
   * empties should keep the peak it reached. Two rollups land in the same clock
   * hour routinely (the reservation spacing is 55 minutes and the tick is 5), so
   * sweeping and overwriting `rooms.tracked` published whichever sample happened to
   * be last instead of the largest - understating the exact number
   * `marketing.md` wants for peak concurrency, in the exact direction that flatters
   * nothing. Peaks therefore skip the delete and upsert with `greatest`, which is
   * the same operator {@link writeOperator} already gives them on the flush path.
   *
   * The delete is scoped to `instance = ''` - the singleton's own rows - so it
   * can never touch an instance's flushed counters, and MVCC means a concurrent
   * reader sees either the old set or the new one and never the gap between them.
   *
   * @returns how many rows each statement wrote, for the log line.
   */
  async collectGauges(at: Date): Promise<Record<string, number>> {
    const bucket = hourBucket(at);
    const written: Record<string, number> = {};

    /**
     * Only the gauges are swept, and the list is derived from the definitions
     * rather than hardcoded so a metric that changes kind cannot be left in the
     * wrong half of this behaviour.
     */
    const sweepable = DERIVED_METRICS.filter((metric) => metricDefinition(metric).kind === 'gauge');

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM metrics_hourly
         WHERE bucket = ${bucket}
           AND instance = ''
           AND metric IN (${sql.join(
             sweepable.map((metric) => sql`${metric}`),
             sql`, `,
           )})
      `);

      const run = async (metric: MetricName, select: SQL): Promise<void> => {
        const value =
          writeOperator(metricDefinition(metric).kind) === 'greatest'
            ? sql`greatest(metrics_hourly.value, excluded.value)`
            : sql`excluded.value`;
        const result = await tx.execute(sql`
          INSERT INTO metrics_hourly (bucket, metric, fleet, instance, key, value)
          ${select}
          ON CONFLICT (bucket, metric, fleet, instance, key) DO UPDATE
            SET value = ${value}, updated_at = now()
        `);
        written[metric] = result.rowCount ?? 0;
      };

      const shared = METRIC_SHARED_SCOPE;

      // -- Shared: the customer base -----------------------------------------
      await run(
        METRICS.GUILDS_INSTALLED,
        sql`SELECT ${bucket}, ${METRICS.GUILDS_INSTALLED}, ${shared}, '', '', count(*)
              FROM guilds WHERE bot_removed_at IS NULL`,
      );
      await run(
        METRICS.GUILDS_STATUS,
        sql`SELECT ${bucket}, ${METRICS.GUILDS_STATUS}, ${shared}, '', auth_status, count(*)
              FROM guilds WHERE bot_removed_at IS NULL GROUP BY auth_status`,
      );
      /**
       * `member_count` is a nullable hint, so a guild with no sample yet
       * contributes zero rather than making the whole sum null.
       */
      await run(
        METRICS.GUILDS_MEMBER_REACH,
        sql`SELECT ${bucket}, ${METRICS.GUILDS_MEMBER_REACH}, ${shared}, '', '',
                   coalesce(sum(coalesce(member_count, 0)), 0)
              FROM guilds WHERE bot_removed_at IS NULL`,
      );
      /**
       * "Good standing" is duplicated from `subscriptionInGoodStanding` into SQL,
       * so the status list is interpolated from the exported set rather than
       * retyped: an added status flows through here instead of silently
       * disagreeing with the bot's ladder. The refund clause is the other half of
       * that function - an approved refund revokes standing while Paddle still
       * reports `active`.
       *
       * **This is the hand-written twin of `subscriptionInGoodStanding` and
       * `tsc` cannot see it.** The predicate's required-property trick makes
       * every TypeScript caller fail to compile when the rule changes; this one
       * is a string, so it has to be changed in the same commit by hand. Both
       * clauses mirror the predicate exactly: the settled marker is the
       * authority, and the status check applies ONLY to rows the derived writer
       * has never touched (`refund_updated_at IS NULL`). Without that scoping a
       * partial refund, whose status is also `approved`, would drop a paying
       * subscription out of the count.
       */
      await run(
        METRICS.SUBSCRIPTIONS_ACTIVE,
        sql`SELECT ${bucket}, ${METRICS.SUBSCRIPTIONS_ACTIVE}, ${shared}, '', tier, count(*)
              FROM subscriptions
             WHERE status IN (${sql.join(
               [...SUBSCRIPTION_OK_STATUSES].map((status) => sql`${status}`),
               sql`, `,
             )})
               AND refund_settled_at IS NULL
               AND (
                     refund_updated_at IS NOT NULL
                  OR refund_status IS NULL
                  OR refund_status <> 'approved'
                   )
             GROUP BY tier`,
      );

      // -- Per fleet: each bot's own operation --------------------------------
      await run(
        METRICS.GUILDS_PRESENT,
        sql`SELECT ${bucket}, ${METRICS.GUILDS_PRESENT}, fleet, '', '', count(*)
              FROM guild_fleet_presence WHERE removed_at IS NULL GROUP BY fleet`,
      );
      await run(
        METRICS.ROOMS_TRACKED,
        sql`SELECT ${bucket}, ${METRICS.ROOMS_TRACKED}, fleet, '', '', count(*)
              FROM secondary_channels GROUP BY fleet`,
      );
      await run(
        METRICS.CHANNELS_CREATOR,
        sql`SELECT ${bucket}, ${METRICS.CHANNELS_CREATOR}, fleet, '', '', count(*)
              FROM auto_channels GROUP BY fleet`,
      );

      return written;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Hourly -> daily                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Recomputes the daily rows covering `[from, to)` from the hourly table.
   *
   * **Recompute-and-overwrite, not accumulate**, which is what makes re-running
   * it idempotent: the daily row is a pure function of the hourly rows under it,
   * so running it twice, or running it while the day is still filling up,
   * converges rather than doubling.
   *
   * Two aggregation levels, and the inner one is the interesting half. Rows are
   * first summed across instances **within** a bucket, because a per-instance row
   * is one machine's share of a fleet-wide number; only then does the metric's
   * own operator collapse the buckets into a day. For a peak that means "the
   * highest the whole fleet reached", not "the highest any one machine reached",
   * which understates a fleet of several.
   *
   * The approximation in that is worth naming: two machines' peaks inside the
   * same hour need not have happened at the same minute, so a summed peak is an
   * upper bound on the fleet's true instantaneous maximum. The alternative
   * (`max`) is a lower bound and a worse one - it would report a two-machine
   * fleet's busiest hour as one machine's.
   */
  async rollupDaily(from: Date, to: Date): Promise<number> {
    const start = dayBucket(from);
    const end = dayBucket(to);
    const byAggregate = new Map<'sum' | 'max' | 'last', MetricName[]>();
    for (const metric of Object.values(METRICS)) {
      // Daily-only metrics are written straight to the daily table (cardinality
      // discipline: per-guild series never get 24 rows a day), so there is
      // nothing under them to roll up.
      if (metricResolution(metric) === 'daily') continue;
      const aggregate = rollupAggregate(metricDefinition(metric).kind);
      const list = byAggregate.get(aggregate);
      if (list) list.push(metric);
      else byAggregate.set(aggregate, [metric]);
    }

    let rows = 0;
    for (const [aggregate, metrics] of byAggregate) {
      const outer = aggregateExpression(aggregate);
      const result = await this.db.execute(sql`
        WITH per_bucket AS (
          SELECT bucket, metric, fleet, key, sum(value) AS value
            FROM metrics_hourly
           WHERE bucket >= ${start}
             AND bucket < ${end}
             AND metric IN (${sql.join(
               metrics.map((metric) => sql`${metric}`),
               sql`, `,
             )})
           GROUP BY bucket, metric, fleet, key
        )
        INSERT INTO metrics_daily (bucket, metric, fleet, instance, key, value)
        SELECT date_trunc('day', bucket AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
               metric, fleet, '', key, ${outer}
          FROM per_bucket
         GROUP BY date_trunc('day', bucket AT TIME ZONE 'UTC'), metric, fleet, key
        ON CONFLICT (bucket, metric, fleet, instance, key) DO UPDATE
          SET value = excluded.value, updated_at = now()
      `);
      rows += result.rowCount ?? 0;
    }
    return rows;
  }

  /**
   * The day range the daily rollup should recompute now.
   *
   * "Yesterday and today" is the steady-state answer and was the whole answer
   * until a failure mode made it wrong. `rollupDaily` is the only writer of the
   * forever-table, so a day it never covers has hourly rows and no daily row -
   * permanently, because nothing revisits it. A rollup that fails for three days
   * while the counter flushes keep succeeding leaves exactly that: a complete
   * hourly table, a fresh-looking store, and two silent holes in every chart that
   * reads daily rows.
   *
   * So the window starts at the newest day already rolled up, not at yesterday,
   * which makes recovery automatic and bounded: the cost scales with the length of
   * the outage and is clamped to the hourly retention window, past which the source
   * rows are gone and the gap is unrecoverable by anyone.
   *
   * Re-covering the newest rolled-up day rather than the one after it is
   * deliberate: it may have been rolled up while it was still filling.
   */
  async rollupWindow(
    now: Date,
    retentionDays = METRICS_HOURLY_RETENTION_DAYS,
  ): Promise<{ from: Date; to: Date }> {
    const today = dayBucket(now);
    const yesterday = new Date(today.getTime() - 86_400_000);
    // Exclusive, so "to" is the start of tomorrow and today is always included.
    const to = new Date(today.getTime() + 86_400_000);
    const floor = new Date(today.getTime() - retentionDays * 86_400_000);

    const latest = await this.latestBucket();
    // An empty daily table means either a fresh store or a rollup that has never
    // run; start from the oldest hour anyone has written.
    const anchor = latest.daily ?? (await this.oldestHourlyBucket());
    if (!anchor) return { from: yesterday, to };

    const from = new Date(Math.min(dayBucket(anchor).getTime(), yesterday.getTime()));
    return { from: from < floor ? floor : from, to };
  }

  /** The oldest hourly bucket still present, for {@link rollupWindow}. */
  private async oldestHourlyBucket(): Promise<Date | null> {
    const result = await this.db.execute<{ oldest: string | null }>(
      sql`SELECT min(bucket) AS oldest FROM metrics_hourly`,
    );
    const oldest = result.rows[0]?.oldest;
    return oldest ? new Date(oldest) : null;
  }

  /**
   * Drops hourly rows past their retention window. Daily rows are kept forever.
   *
   * A day that ages out of the hourly table can no longer be recomputed, which is
   * why {@link rollupWindow} clamps to this same retention window: past it there is
   * nothing left to recompute from, so a gap that old is permanent whatever anyone
   * does about it.
   */
  async pruneHourly(now: Date, retentionDays = METRICS_HOURLY_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(hourBucket(now).getTime() - retentionDays * 86_400_000);
    const result = await this.db.execute(sql`DELETE FROM metrics_hourly WHERE bucket < ${cutoff}`);
    return result.rowCount ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Reading                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * One metric over time: one point per bucket per key.
   *
   * Rows are summed across instances **and fleets** within a bucket, which is the
   * same inner half {@link rollupDaily} does and is correct for every kind: a
   * per-instance row is one machine's share of a fleet-wide number. There is no
   * second aggregation level here, because the bucket granularity of the answer is
   * the granularity of the table being read - collapsing buckets is what
   * `rollupDaily` is for.
   *
   * **Two consequences of summing across fleets are worth knowing**, both dormant
   * while one fleet runs and both live at the cutover. For a `peak`, summing two
   * fleets' daily maxima is a looser upper bound than the within-bucket
   * approximation `rollupDaily` documents, since the two fleets' peaks need not
   * fall in the same hour. And `guilds.present` counts a guild running both bots
   * twice, by construction. Pass `fleet` to ask about one bot instead.
   */
  async readSeries(options: ReadSeriesOptions): Promise<MetricSeriesPoint[]> {
    const resolution = options.resolution ?? metricResolution(options.metric);
    const table = resolution === 'daily' ? sql`metrics_daily` : sql`metrics_hourly`;
    const fleetFilter = options.fleet ? sql`AND fleet = ${options.fleet}` : sql``;

    const result = await this.db.execute<{
      bucket: string;
      key: string;
      value: string | number;
    }>(sql`
      SELECT bucket, key, sum(value) AS value
        FROM ${table}
       WHERE metric = ${options.metric}
         AND bucket >= ${options.from}
         AND bucket < ${options.to}
         ${fleetFilter}
       GROUP BY bucket, key
       ORDER BY bucket ASC
    `);
    return result.rows.map((row) => ({
      bucket: new Date(row.bucket),
      key: row.key,
      value: Number(row.value),
    }));
  }

  /**
   * How current the store is, per metric or across all of them.
   *
   * The reason this exists at all is §8's risk row: a collector that dies quietly
   * makes every chart downstream read zero, and a zero is indistinguishable from
   * an answer. Anything rendering a series is expected to show staleness in place
   * of a shape, so it needs a number to decide that from.
   *
   * **Ask per metric wherever you can.** The store-wide answer is the newest
   * bucket written by anyone for anything, so it reports "fresh" while the series
   * actually on screen has stopped: the derived gauges come from the cluster
   * singleton and the counters come from each instance's flush, and either half
   * can fail while the other keeps the store looking healthy. `rooms.created` going
   * silent while `rooms.tracked` keeps arriving is a flush failure, and a
   * store-wide check cannot see it.
   *
   * Deliberately no row counts: only a log line ever wanted them, and `count(*)`
   * over a table that holds ~100k rows at steady state is a sequential scan on
   * every caller. `max(bucket)` is a backward index scan on the primary key.
   */
  async latestBucket(metric?: MetricName): Promise<{ hourly: Date | null; daily: Date | null }> {
    const filter = metric ? sql`WHERE metric = ${metric}` : sql``;
    const result = await this.db.execute<{ last_hourly: string | null; last_daily: string | null }>(
      sql`
        SELECT (SELECT max(bucket) FROM metrics_hourly ${filter}) AS last_hourly,
               (SELECT max(bucket) FROM metrics_daily  ${filter}) AS last_daily
      `,
    );
    const row = result.rows[0];
    return {
      hourly: row?.last_hourly ? new Date(row.last_hourly) : null,
      daily: row?.last_daily ? new Date(row.last_daily) : null,
    };
  }

  /**
   * {@link latestBucket} plus the table sizes.
   *
   * The counts are two sequential scans, so this is for the hourly rollup's log
   * line and for an operator asking how big the store has got - never for a page
   * render.
   */
  async freshness(): Promise<MetricsFreshness> {
    const result = await this.db.execute<{
      last_hourly: string | null;
      last_daily: string | null;
      hourly_rows: string | number;
      daily_rows: string | number;
    }>(sql`
      SELECT (SELECT max(bucket) FROM metrics_hourly)  AS last_hourly,
             (SELECT max(bucket) FROM metrics_daily)   AS last_daily,
             (SELECT count(*)    FROM metrics_hourly)  AS hourly_rows,
             (SELECT count(*)    FROM metrics_daily)   AS daily_rows
    `);
    const row = result.rows[0];
    return {
      lastHourlyBucket: row?.last_hourly ? new Date(row.last_hourly) : null,
      lastDailyBucket: row?.last_daily ? new Date(row.last_daily) : null,
      hourlyRows: Number(row?.hourly_rows ?? 0),
      dailyRows: Number(row?.daily_rows ?? 0),
    };
  }
}

/** The SQL for a rollup aggregate. `last` needs the bucket, hence array_agg. */
function aggregateExpression(aggregate: 'sum' | 'max' | 'last'): SQL {
  switch (aggregate) {
    case 'sum':
      return sql`sum(value)`;
    case 'max':
      return sql`max(value)`;
    case 'last':
      return sql`(array_agg(value ORDER BY bucket DESC))[1]`;
  }
}
