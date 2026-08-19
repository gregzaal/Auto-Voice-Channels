/**
 * The metric store's vocabulary (`plans/admin-dashboard.md` §3.4).
 *
 * Two narrow tables (`metrics_hourly`, `metrics_daily`) hold every operational
 * time series, and this module is the only place that says what a metric *means*.
 * Narrow and generic beats wide and typed: a new metric is a new string here, not
 * a migration.
 *
 * That is not the same as "any string works". Every write resolves its
 * definition, because two properties of a series cannot be inferred from a row:
 * how concurrent writers combine (`writeOperator`) and how 24 hourly rows become
 * one daily row (`rollupOperator`). A typo'd name with no definition would
 * silently become a parallel series nobody charts and the rollup could not
 * summarise, so an unknown name is an error rather than a new metric.
 */

import { DEFAULT_FLEET, type Fleet } from './fleets.js';

/**
 * How a metric aggregates. Declared per metric because these differ and getting
 * one wrong produces a chart that is confidently wrong rather than obviously
 * broken.
 *
 * | kind | within one bucket | hourly -> daily |
 * | --- | --- | --- |
 * | `gauge` | last value wins | last value in the day |
 * | `counter` | running total (monotonic) | sum |
 * | `peak` | max | max |
 * | `cumulative` | monotonic total | last value |
 */
export const METRIC_KINDS = ['gauge', 'counter', 'peak', 'cumulative'] as const;

export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * Who a metric row is about.
 *
 * - `fleet` — a fact about one bot's own operation. Beta created 40 rooms, prod
 *   created 900. Summing across fleets is meaningful, and so is filtering.
 * - `shared` — a fact about the customer base, derived from tables that have no
 *   fleet column at all (`guilds`, `subscriptions`). One entitlement per guild
 *   whichever bot it is running, so these are written **once** cluster-wide.
 *
 * The distinction has to be in the row, not in a convention, because the failure
 * mode is silent: two fleets each writing `guilds.installed = 1004` and a reader
 * summing them reports 2008 installs. Shared rows carry
 * {@link METRIC_SHARED_SCOPE} in the fleet column so that sum is impossible by
 * construction.
 */
export type MetricScope = 'fleet' | 'shared';

/**
 * The fleet-column value for a shared-scope row.
 *
 * `ops_audit.fleet` solves the same problem by being nullable - a web-console
 * action originates outside any fleet, and recording one would be a lie. This
 * column cannot be: it is part of the primary key, and Postgres primary keys are
 * NOT NULL. (A unique index over a nullable column is not a substitute: NULLs
 * compare distinct by default, so the idempotent upsert would insert a second
 * row instead of updating the first, and `NULLS NOT DISTINCT` needs Postgres 15+
 * which is not something a self-hoster's database is guaranteed to be.)
 *
 * So the column is plain `text` holding a {@link Fleet} or this sentinel, and
 * deliberately **not** the `FLEETS` enum. Widening `Fleet` itself to carry
 * `'shared'` would leak a non-fleet into `shard_leases`, `runtime_flags` and
 * `fleetOrdinal`, whose ordinals are baked into live advisory-lock keys.
 */
export const METRIC_SHARED_SCOPE = 'shared';

/** What a metric row's fleet column may hold. */
export type MetricFleet = Fleet | typeof METRIC_SHARED_SCOPE;

/**
 * Which table a metric lives in.
 *
 * **Cardinality discipline** (§3.4): fleet-wide metrics are hourly, per-guild
 * metrics are **daily only**. At 10k guilds an hourly per-guild metric is 240k
 * rows a day and the table stops being cheap. A metric whose `key` is a guild id
 * must declare `daily`, and {@link metricDefinition} is what makes that a
 * checkable property rather than a note in a document.
 */
export type MetricResolution = 'hourly' | 'daily';

export interface MetricDefinition {
  kind: MetricKind;
  scope: MetricScope;
  /** Defaults to `hourly`. `daily` skips the hourly table entirely. */
  resolution?: MetricResolution;
  /** What the `key` dimension holds, or null when the metric has no dimension. */
  dimension: string | null;
  /** One line, for the operator console's own tooltips and for humans here. */
  describe: string;
}

/**
 * Every metric the collector writes.
 *
 * Adding one is a code change and not a migration, which is the point of the
 * narrow schema. Removing one needs no migration either: old rows keep their
 * name and simply stop being written, so history survives a rename as two
 * series rather than as a gap.
 */
export const METRICS = {
  // -- Shared: the customer base, written once cluster-wide -------------------
  /** Guilds the bot is in, by the shared removal marker. */
  GUILDS_INSTALLED: 'guilds.installed',
  /** Guilds per auth status: the entitlement distribution. */
  GUILDS_STATUS: 'guilds.status',
  /** Sum of the latest member-count sample across installed guilds. */
  GUILDS_MEMBER_REACH: 'guilds.member_reach',
  /** Subscriptions in good standing, per tier. */
  SUBSCRIPTIONS_ACTIVE: 'subscriptions.active',

  // -- Per fleet, derived centrally from the fleet-scoped tables --------------
  /** Guilds this fleet's bot is actually in (`guild_fleet_presence`). */
  GUILDS_PRESENT: 'guilds.present',
  /** Live secondary channels. A peak, not a gauge - see below. */
  ROOMS_TRACKED: 'rooms.tracked',
  /** Creator/primary channels configured. */
  CHANNELS_CREATOR: 'channels.creator',

  // -- Per fleet, accumulated in memory on the hot path and flushed ----------
  /** Secondary channels created. */
  ROOMS_CREATED: 'rooms.created',
  /** Secondary channels cleaned up. */
  ROOMS_DELETED: 'rooms.deleted',
  /** Slash commands invoked, keyed by command name. */
  COMMANDS_INVOKED: 'commands.invoked',
  /** Handled errors, keyed by coarse category. */
  ERRORS: 'errors',
  /** Deepest total dispatcher queue depth seen in the bucket. */
  QUEUE_DEPTH_PEAK: 'queue.depth.peak',
  /** Most guilds with a tripped circuit-breaker seen in the bucket. */
  CIRCUITS_TRIPPED_PEAK: 'circuits.tripped.peak',
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

const DEFINITIONS: Record<MetricName, MetricDefinition> = {
  [METRICS.GUILDS_INSTALLED]: {
    kind: 'gauge',
    scope: 'shared',
    dimension: null,
    describe: 'Guilds with no removal marker on the shared row.',
  },
  [METRICS.GUILDS_STATUS]: {
    kind: 'gauge',
    scope: 'shared',
    dimension: 'auth status',
    describe: 'Installed guilds per auth status.',
  },
  [METRICS.GUILDS_MEMBER_REACH]: {
    kind: 'gauge',
    scope: 'shared',
    dimension: null,
    describe: 'Sum of the latest member-count sample across installed guilds.',
  },
  [METRICS.SUBSCRIPTIONS_ACTIVE]: {
    kind: 'gauge',
    scope: 'shared',
    dimension: 'tier',
    describe: 'Subscriptions in good standing, per tier.',
  },
  [METRICS.GUILDS_PRESENT]: {
    kind: 'gauge',
    scope: 'fleet',
    dimension: null,
    describe: "Guilds this fleet's bot is present in.",
  },
  /**
   * `peak`, not `gauge`, and the reason is the daily rollup.
   *
   * A gauge's day is its last hourly sample, which for rooms is the value at
   * midnight UTC - the daily trough almost everywhere people play games. "Most
   * rooms live at once today" is both the more useful operator number and the
   * honest one to publish, and it is what `marketing.md` wants for peak
   * concurrency. The hourly row is still an instantaneous sample; only the
   * summary differs.
   */
  [METRICS.ROOMS_TRACKED]: {
    kind: 'peak',
    scope: 'fleet',
    dimension: null,
    describe: 'Live secondary channels, sampled hourly. Daily value is the peak sample.',
  },
  [METRICS.CHANNELS_CREATOR]: {
    kind: 'gauge',
    scope: 'fleet',
    dimension: null,
    describe: 'Creator channels configured.',
  },
  [METRICS.ROOMS_CREATED]: {
    kind: 'counter',
    scope: 'fleet',
    dimension: null,
    describe: 'Secondary channels created.',
  },
  [METRICS.ROOMS_DELETED]: {
    kind: 'counter',
    scope: 'fleet',
    dimension: null,
    describe: 'Secondary channels cleaned up.',
  },
  [METRICS.COMMANDS_INVOKED]: {
    kind: 'counter',
    scope: 'fleet',
    dimension: 'command name',
    describe: 'Slash commands invoked. The one product metric nothing else can recover.',
  },
  [METRICS.ERRORS]: {
    kind: 'counter',
    scope: 'fleet',
    dimension: 'error category',
    describe: 'Handled errors by coarse category.',
  },
  [METRICS.QUEUE_DEPTH_PEAK]: {
    kind: 'peak',
    scope: 'fleet',
    dimension: null,
    describe: 'Deepest total dispatcher queue depth in the bucket.',
  },
  [METRICS.CIRCUITS_TRIPPED_PEAK]: {
    kind: 'peak',
    scope: 'fleet',
    dimension: null,
    describe: 'Most guilds with a tripped circuit-breaker in the bucket.',
  },
};

/** Every defined metric name, for tooling that enumerates them. */
export const METRIC_NAMES = Object.keys(DEFINITIONS) as MetricName[];

/**
 * The definition for a metric name, or a throw.
 *
 * Throwing rather than defaulting is deliberate: a default kind would make a
 * typo look like a working metric right up to the point where its daily rollup
 * summarises it with the wrong operator, months later, in a chart.
 */
export function metricDefinition(name: string): MetricDefinition {
  const definition = DEFINITIONS[name as MetricName];
  if (!definition) throw new Error(`unknown metric: ${name}`);
  return definition;
}

/** Where a metric's rows live. */
export function metricResolution(name: string): MetricResolution {
  return metricDefinition(name).resolution ?? 'hourly';
}

/**
 * The fleet-column value a metric's rows carry.
 *
 * Shared metrics ignore the writing fleet entirely, which is what stops the
 * cluster singleton stamping `prod` on a fact it computed while running as beta.
 */
export function metricFleet(name: string, writer: Fleet = DEFAULT_FLEET): MetricFleet {
  return metricDefinition(name).scope === 'shared' ? METRIC_SHARED_SCOPE : writer;
}

/**
 * How two writes to the *same* row combine.
 *
 * Every write is an upsert on the full primary key, and the key includes the
 * writing instance precisely so this can be idempotent (golden rule 1 applied to
 * telemetry): each instance owns its own row per bucket and rewrites its own
 * running total, so a retried flush lands on the same number instead of doubling
 * it. Readers sum across instances.
 *
 * `greatest` for counters is the second half of that: an instance restarting
 * mid-bucket loses its in-memory accumulator, and a bare overwrite would replace
 * the pre-restart total with a smaller post-restart one, erasing counts that had
 * already been flushed. `greatest` makes a restart able to stall a counter but
 * never to walk it backwards. The collector also re-reads its own row on boot,
 * so in practice it resumes rather than stalls.
 */
export function writeOperator(kind: MetricKind): 'overwrite' | 'greatest' {
  return kind === 'gauge' ? 'overwrite' : 'greatest';
}

/**
 * The SQL aggregate that collapses a metric's hourly rows into its daily value.
 *
 * The kind decides it, and getting it wrong is how a chart becomes confidently
 * wrong rather than obviously broken: summing a gauge inflates it 24x, and taking
 * the last value of a counter reports one hour as a day. There is deliberately no
 * TypeScript twin of this reduction - one existed briefly, called by nothing but
 * its own test, which is a second implementation free to drift from the SQL that
 * actually runs. `metrics.integration.test.ts` pins each kind against real
 * Postgres instead.
 */
export function rollupAggregate(kind: MetricKind): 'sum' | 'max' | 'last' {
  switch (kind) {
    case 'counter':
      return 'sum';
    case 'peak':
      return 'max';
    case 'gauge':
    case 'cumulative':
      return 'last';
  }
}

/** UTC hour bucket for a moment. */
export function hourBucket(at: Date): Date {
  const bucket = new Date(at.getTime());
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/** UTC day bucket for a moment. */
export function dayBucket(at: Date): Date {
  const bucket = new Date(at.getTime());
  bucket.setUTCHours(0, 0, 0, 0);
  return bucket;
}

/**
 * How long hourly rows are kept. Daily rows are kept forever, which is honest at
 * daily-per-fleet cardinality and is what cohort charts need.
 *
 * 90 days is the figure `plans/admin-dashboard.md` §7 decision 4 *proposes*, and
 * that decision is still recorded as the owner's to make. This constant is the
 * default it ships with, not a ruling: longer is cheap now and expensive later at
 * per-guild cardinality, which is the trade the decision is about.
 */
export const METRICS_HOURLY_RETENTION_DAYS = 90;

/**
 * How stale the newest hourly bucket may be before the collector counts as
 * broken.
 *
 * §8's risk table is explicit that a collector dying quietly is the failure mode
 * worth engineering against, because every chart downstream reads zero and looks
 * like a real answer. Two buckets of slack absorbs a deploy and a missed tick;
 * past that, the reader must render staleness instead of a shape.
 */
export const METRICS_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
