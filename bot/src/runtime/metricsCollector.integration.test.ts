import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BillingRunRepository,
  db,
  METRICS,
  MetricsRepository,
  RUNTIME_FLAGS,
  RuntimeFlagsRepository,
} from '@avc/core';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { MetricsCollector } from './metricsCollector.js';
import { fakeLogger } from './testUtils.js';

/**
 * The collector against a real Postgres.
 *
 * What this covers and the unit tests cannot: the rollup is a cluster singleton
 * enforced by a Postgres advisory lock plus durable spacing in `billing_runs`, and
 * a fake reservation proves nothing about either. Two live collectors sharing one
 * database is the only way to see that exactly one of them derives the gauges
 * while both still flush their own counters.
 */

const NOW = new Date('2026-08-19T13:20:00Z');

describe('MetricsCollector (integration)', () => {
  let env: PgTestEnv;

  const build = (instanceId: string, fleet: 'beta' | 'prod' = 'beta'): MetricsCollector =>
    new MetricsCollector({
      metrics: new MetricsRepository(env.handle.db),
      runs: new BillingRunRepository(env.handle.db),
      flags: new RuntimeFlagsRepository(env.handle.db, fleet),
      fleet,
      instanceId,
      logger: fakeLogger(),
      sample: () => ({ queueDepth: 0, trippedCircuits: 0 }),
      now: () => NOW,
    });

  beforeAll(async () => {
    env = await startPostgres();
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.metricsHourly);
    await env.handle.db.delete(db.schema.metricsDaily);
    await env.handle.db.delete(db.schema.billingRuns);
    await env.handle.db.delete(db.schema.runtimeFlags);
    await env.handle.db.delete(db.schema.opsAudit);
    await env.handle.db.delete(db.schema.guilds);
  });

  /**
   * Read through the pool rather than through Drizzle's `sql` template: that
   * lives in `drizzle-orm`, which is a dependency of `core` and deliberately not
   * of `bot`, so importing it here would fail to resolve.
   */
  const query = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
    (await env.handle.pool.query(text, params)).rows as T[];

  const countRows = async (metric: string): Promise<number> => {
    const rows = await query<{ n: string }>(
      'SELECT count(*) AS n FROM metrics_hourly WHERE metric = $1',
      [metric],
    );
    return Number(rows[0]?.n ?? 0);
  };

  const sumOf = async (metric: string): Promise<number> => {
    const rows = await query<{ total: string | null }>(
      'SELECT sum(value) AS total FROM metrics_hourly WHERE metric = $1',
      [metric],
    );
    return Number(rows[0]?.total ?? 0);
  };

  it('writes what it counted, in one tick', async () => {
    const collector = build('i-1');
    collector.increment(METRICS.ROOMS_CREATED);
    collector.increment(METRICS.ROOMS_CREATED);
    collector.increment(METRICS.COMMANDS_INVOKED, 'setup');

    await collector.tick();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(2);
    expect(await sumOf(METRICS.COMMANDS_INVOKED)).toBe(1);
    // And the derived gauges came from the domain tables in the same tick.
    expect(await countRows(METRICS.GUILDS_INSTALLED)).toBe(1);
  });

  /**
   * The property the whole rollup design rests on. Both instances flush; only one
   * derives the shared gauges, because two would be two rows a reader could sum
   * into nonsense.
   */
  it('derives the gauges on exactly one instance, while both flush their own counters', async () => {
    await env.handle.db.insert(db.schema.guilds).values([{ guildId: 'g-1' }, { guildId: 'g-2' }]);

    const one = build('i-1');
    const two = build('i-2');
    one.increment(METRICS.ROOMS_CREATED, '', 4);
    two.increment(METRICS.ROOMS_CREATED, '', 6);

    await Promise.all([one.tick(), two.tick()]);

    // One row per instance, summing to the fleet's total.
    expect(await countRows(METRICS.ROOMS_CREATED)).toBe(2);
    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(10);

    // A single shared-scope row for the bucket, not one per instance.
    const installed = await query<{ fleet: string; value: string }>(
      'SELECT fleet, value FROM metrics_hourly WHERE metric = $1',
      [METRICS.GUILDS_INSTALLED],
    );
    expect(installed).toHaveLength(1);
    expect(installed[0]!.fleet).toBe('shared');
    expect(Number(installed[0]!.value)).toBe(2);

    /**
     * The row count above cannot prove the singleton on its own: both collectors
     * running the rollup would write the *same* row, since `metricFleet` forces
     * `fleet='shared'`, `instance=''` and `key=''`, and the primary key collapses
     * them. `lastRollupAt` is only stamped by a collector that actually ran, and
     * `billing_runs.last_run_by` names it, so those are what observe the lock.
     */
    const ran = [one, two].filter((collector) => collector.stats.lastRollupAt !== null);
    expect(ran).toHaveLength(1);

    const runs = await query<{ job: string; last_run_by: string }>(
      "SELECT job, last_run_by FROM billing_runs WHERE job = 'metrics.rollup'",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.last_run_by).toBe(ran[0] === one ? 'i-1' : 'i-2');
  });

  /**
   * The other half of the reservation: durable spacing. A second tick inside the
   * window must skip, or every tick would recompute the gauges.
   */
  it('skips the rollup on a second tick inside the spacing window', async () => {
    const collector = build('i-1');
    await collector.tick();
    const first = collector.stats.lastRollupAt;

    const other = build('i-2');
    await other.tick();

    expect(other.stats.lastRollupAt).toBeNull();
    expect(collector.stats.lastRollupAt).toBe(first);
  });

  /**
   * Two fleets sharing one database must not contend for the rollup either: it
   * computes shared facts, so it is deliberately once per CLUSTER rather than once
   * per fleet, and the lock is not fleet-namespaced.
   */
  it('runs the rollup once across two fleets, not once per fleet', async () => {
    await env.handle.db.insert(db.schema.guilds).values([{ guildId: 'g-1' }]);

    const beta = build('i-beta', 'beta');
    const prod = build('i-prod', 'prod');
    await Promise.all([beta.tick(), prod.tick()]);

    // Again, the row count cannot fail on its own - the stamp is what observes it.
    expect(await countRows(METRICS.GUILDS_INSTALLED)).toBe(1);
    expect([beta, prod].filter((collector) => collector.stats.lastRollupAt !== null)).toHaveLength(
      1,
    );
  });

  it('resumes its own counters across a restart, without double counting', async () => {
    const before = build('i-1');
    before.increment(METRICS.ROOMS_CREATED, '', 40);
    await before.tick();

    const after = build('i-1');
    await after.hydrate();
    after.increment(METRICS.ROOMS_CREATED);
    await after.tick();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(41);
    expect(await countRows(METRICS.ROOMS_CREATED)).toBe(1);
  });

  /**
   * A restart that never hydrated must not be able to erase counts that were
   * already written - `greatest` on write is what guarantees it.
   */
  it('never lowers a counter when a restart forgets to resume', async () => {
    const before = build('i-1');
    before.increment(METRICS.ROOMS_CREATED, '', 40);
    await before.tick();

    const amnesiac = build('i-1');
    amnesiac.increment(METRICS.ROOMS_CREATED);
    await amnesiac.tick();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(40);
  });

  it('writes nothing once the kill switch is set', async () => {
    const flags = new RuntimeFlagsRepository(env.handle.db, 'beta');
    await flags.set(RUNTIME_FLAGS.METRICS_DISABLED, true, { actor: 'test' });

    const collector = build('i-1');
    collector.increment(METRICS.ROOMS_CREATED);
    await collector.tick();

    expect(await countRows(METRICS.ROOMS_CREATED)).toBe(0);
    expect(await countRows(METRICS.GUILDS_INSTALLED)).toBe(0);
  });

  /**
   * The flag is per fleet, and that is the useful shape: switching beta's
   * collector off must not stop prod reporting its own counters.
   */
  it('honours the kill switch per fleet', async () => {
    const flags = new RuntimeFlagsRepository(env.handle.db, 'beta');
    await flags.set(RUNTIME_FLAGS.METRICS_DISABLED, true, { actor: 'test' });

    const beta = build('i-beta', 'beta');
    const prod = build('i-prod', 'prod');
    beta.increment(METRICS.ROOMS_CREATED, '', 5);
    prod.increment(METRICS.ROOMS_CREATED, '', 7);
    await beta.tick();
    await prod.tick();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(7);
  });

  it('rolls the hourly rows up into a daily row it can re-run safely', async () => {
    const collector = build('i-1');
    collector.increment(METRICS.ROOMS_CREATED, '', 3);
    await collector.tick();

    const daily = await query<{ value: string; instance: string }>(
      'SELECT value, instance FROM metrics_daily WHERE metric = $1',
      [METRICS.ROOMS_CREATED],
    );
    expect(daily).toHaveLength(1);
    expect(Number(daily[0]!.value)).toBe(3);
    // The daily table collapses the instance: machine ids churn and nothing asks.
    expect(daily[0]!.instance).toBe('');
  });

  it('reports freshness from the store, not from its own optimism', async () => {
    const collector = build('i-1');
    expect(collector.stats.lastBucket).toBeNull();

    await collector.tick();
    expect(collector.stats.lastBucket).toBe('2026-08-19T13:00:00.000Z');
    expect(collector.stats.stale).toBe(false);
    expect(collector.stats.lastFlushError).toBeNull();
    expect(collector.stats.lastRollupError).toBeNull();
  });

  /**
   * `hydrate` is contracted to run before the gateway connects, so the accumulator
   * is empty and the resume is exact. This pins the defensive half of that: if it
   * ever does race live counts, it must not walk the stored total backwards.
   *
   * (It cannot *add* them either, which is why the ordering is the real fix: the
   * stored value and a live count are disjoint, and no merge recovers both.)
   */
  it('never lowers the stored total if it races live counts', async () => {
    const before = build('i-1');
    before.increment(METRICS.ROOMS_CREATED, '', 40);
    await before.tick();

    const after = build('i-1');
    after.increment(METRICS.ROOMS_CREATED, '', 3);
    await after.hydrate();
    await after.tick();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(40);
  });

  /** And the contracted ordering, which is what `index.ts` actually does. */
  it('resumes exactly when it runs before anything is counted', async () => {
    const before = build('i-1');
    before.increment(METRICS.ROOMS_CREATED, '', 40);
    await before.tick();

    const after = build('i-1');
    await after.hydrate();
    after.increment(METRICS.ROOMS_CREATED, '', 3);
    await after.tick();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(43);
  });

  /**
   * `metrics.disabled` is documented on /admin/ops as "no counter flushes" and
   * `global.pause` as stopping the collector. A drain that wrote anyway made both
   * false on every rolling deploy, which is when an operator is most likely to be
   * watching.
   */
  it('writes nothing on shutdown while a kill switch is set', async () => {
    const flags = new RuntimeFlagsRepository(env.handle.db, 'beta');
    await flags.set(RUNTIME_FLAGS.GLOBAL_PAUSE, true, { actor: 'test' });

    const collector = build('i-1');
    collector.start();
    collector.increment(METRICS.ROOMS_CREATED, '', 6);
    await collector.stop();

    expect(await countRows(METRICS.ROOMS_CREATED)).toBe(0);
  });

  it('still writes on shutdown when nothing forbids it', async () => {
    const collector = build('i-1');
    collector.start();
    collector.increment(METRICS.ROOMS_CREATED, '', 6);
    await collector.stop();

    expect(await sumOf(METRICS.ROOMS_CREATED)).toBe(6);
  });
});
