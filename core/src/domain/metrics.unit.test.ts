import { describe, expect, it } from 'vitest';
import { FLEETS } from './fleets.js';
import {
  dayBucket,
  hourBucket,
  METRIC_NAMES,
  METRIC_SHARED_SCOPE,
  METRICS,
  metricDefinition,
  metricFleet,
  metricResolution,
  rollupAggregate,
  writeOperator,
  type MetricKind,
} from './metrics.js';

describe('metric definitions', () => {
  it('defines every name in METRICS', () => {
    for (const name of Object.values(METRICS)) {
      expect(() => metricDefinition(name)).not.toThrow();
    }
    expect(METRIC_NAMES.sort()).toEqual([...Object.values(METRICS)].sort());
  });

  /**
   * A default kind would let a typo look like a working metric until its daily
   * rollup summarised it with the wrong operator, months later, in a chart.
   */
  it('refuses an unknown metric rather than inventing a default', () => {
    expect(() => metricDefinition('guilds.instaled')).toThrow(/unknown metric/);
    expect(() => metricDefinition(METRICS.GUILDS_INSTALLED)).not.toThrow();
  });

  it('describes the dimension of every keyed metric', () => {
    expect(metricDefinition(METRICS.COMMANDS_INVOKED).dimension).toBe('command name');
    expect(metricDefinition(METRICS.GUILDS_STATUS).dimension).toBe('auth status');
    expect(metricDefinition(METRICS.ROOMS_CREATED).dimension).toBeNull();
  });
});

/**
 * The scope split is the whole reason the fleet column exists, and the failure it
 * prevents is silent: two fleets each writing `guilds.installed = 1004` and a
 * reader summing them reports 2008 installs.
 */
describe('metric scope', () => {
  it('stamps shared facts with the shared sentinel, whichever fleet computed them', () => {
    for (const fleet of FLEETS) {
      expect(metricFleet(METRICS.GUILDS_INSTALLED, fleet)).toBe(METRIC_SHARED_SCOPE);
      expect(metricFleet(METRICS.SUBSCRIPTIONS_ACTIVE, fleet)).toBe(METRIC_SHARED_SCOPE);
    }
  });

  it("stamps a fleet's own operational facts with that fleet", () => {
    expect(metricFleet(METRICS.ROOMS_CREATED, 'beta')).toBe('beta');
    expect(metricFleet(METRICS.ROOMS_CREATED, 'prod')).toBe('prod');
    expect(metricFleet(METRICS.COMMANDS_INVOKED, 'beta')).toBe('beta');
  });

  /** The sentinel must never be a real fleet, or the enum columns would take it. */
  it('keeps the shared sentinel out of the fleet enum', () => {
    expect(FLEETS).not.toContain(METRIC_SHARED_SCOPE);
  });
});

describe('write operator', () => {
  /**
   * `greatest` is what makes an instance restart unable to walk a counter
   * backwards: the fresh accumulator starts at zero, and a bare overwrite would
   * replace an already-flushed total with it.
   */
  it('never lets a counter or peak decrease within a bucket', () => {
    expect(writeOperator('counter')).toBe('greatest');
    expect(writeOperator('peak')).toBe('greatest');
    expect(writeOperator('cumulative')).toBe('greatest');
  });

  it('lets a gauge fall, because a gauge is a level and levels fall', () => {
    expect(writeOperator('gauge')).toBe('overwrite');
  });
});

/**
 * The per-kind reduction itself is pinned against real Postgres in
 * `metrics.integration.test.ts`, not here. A TypeScript reimplementation of it
 * used to live in the domain module so it could be unit tested, and that is
 * exactly the trap: a second implementation nothing calls is free to agree with
 * this test forever while the SQL that actually runs drifts away from both. What
 * is worth pinning purely is the mapping from kind to operator, because that is
 * the decision, and the two failure modes it prevents are summing a gauge (24x too
 * high) and taking the last value of a counter (one hour reported as a day).
 */
describe('rollup operator per kind', () => {
  it('maps every kind to the aggregate that cannot misreport it', () => {
    const expected: Record<MetricKind, 'sum' | 'max' | 'last'> = {
      counter: 'sum',
      peak: 'max',
      gauge: 'last',
      cumulative: 'last',
    };
    for (const [kind, aggregate] of Object.entries(expected)) {
      expect(rollupAggregate(kind as MetricKind)).toBe(aggregate);
    }
  });

  /**
   * `rooms.tracked` is the one the choice is visible on: as a gauge its day would
   * be the value at midnight UTC, the daily trough almost everywhere people play
   * games, and it is the number marketing publishes as peak concurrency.
   */
  it('summarises live rooms by their peak, not by the last sample of the day', () => {
    expect(metricDefinition(METRICS.ROOMS_TRACKED).kind).toBe('peak');
    expect(rollupAggregate(metricDefinition(METRICS.ROOMS_TRACKED).kind)).toBe('max');
  });
});

describe('bucket truncation', () => {
  it('truncates to the UTC hour', () => {
    expect(hourBucket(new Date('2026-08-19T13:47:31.123Z')).toISOString()).toBe(
      '2026-08-19T13:00:00.000Z',
    );
  });

  /**
   * UTC, not local. A day bucket derived in the host's timezone would put two
   * different days' rows in one bucket for half the fleet.
   */
  it('truncates to the UTC day', () => {
    expect(dayBucket(new Date('2026-08-19T23:59:59.999Z')).toISOString()).toBe(
      '2026-08-19T00:00:00.000Z',
    );
    expect(dayBucket(new Date('2026-08-20T00:00:00.000Z')).toISOString()).toBe(
      '2026-08-20T00:00:00.000Z',
    );
  });

  it('leaves an already-truncated bucket alone', () => {
    const bucket = new Date('2026-08-19T13:00:00.000Z');
    expect(hourBucket(bucket).getTime()).toBe(bucket.getTime());
  });
});

/**
 * Cardinality discipline (§3.4): fleet-wide metrics are hourly, per-guild
 * metrics are daily only. Nothing ships a per-guild metric yet, so this pins the
 * default rather than the exception.
 */
describe('resolution', () => {
  it('defaults every current metric to hourly', () => {
    for (const name of METRIC_NAMES) {
      expect(metricResolution(name)).toBe('hourly');
    }
  });
});
