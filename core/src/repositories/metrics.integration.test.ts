import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { METRIC_SHARED_SCOPE, METRICS, hourBucket } from '../domain/metrics.js';
import { MetricsRepository } from './metrics.js';

const HOUR = new Date('2026-08-19T13:00:00Z');
const NEXT_HOUR = new Date('2026-08-19T14:00:00Z');
const DAY = new Date('2026-08-19T00:00:00Z');
const NEXT_DAY = new Date('2026-08-20T00:00:00Z');

describe('MetricsRepository (integration)', () => {
  let env: PgTestEnv;
  let metrics: MetricsRepository;

  beforeAll(async () => {
    env = await startPostgres();
    metrics = new MetricsRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(schema.metricsHourly);
    await env.handle.db.delete(schema.metricsDaily);
    await env.handle.db.delete(schema.secondaryChannels);
    await env.handle.db.delete(schema.autoChannels);
    await env.handle.db.delete(schema.guildFleetPresence);
    await env.handle.db.delete(schema.subscriptions);
    await env.handle.db.delete(schema.guilds);
  });

  const readHourly = async (
    metric: string,
  ): Promise<{ fleet: string; instance: string; key: string; value: number }[]> => {
    const result = await env.handle.db.execute<{
      fleet: string;
      instance: string;
      key: string;
      value: string;
    }>(sql`SELECT fleet, instance, key, value FROM metrics_hourly
             WHERE metric = ${metric} ORDER BY fleet, instance, key`);
    return result.rows.map((r) => ({ ...r, value: Number(r.value) }));
  };

  /* ---------------------------------------------------------------------- */

  describe('writePoints', () => {
    /**
     * Golden rule 1 applied to telemetry. The instance is in the primary key so
     * each writer owns its own row and rewrites its own running total; a retried
     * flush must land on the same number rather than doubling it.
     */
    it('is idempotent: replaying a flush does not double a counter', async () => {
      const flush = [
        { metric: METRICS.ROOMS_CREATED, value: 7, bucket: HOUR, instance: 'i-1' },
      ] as const;
      await metrics.writePoints(flush, 'beta');
      await metrics.writePoints(flush, 'beta');
      await metrics.writePoints(flush, 'beta');

      expect(await readHourly(METRICS.ROOMS_CREATED)).toEqual([
        { fleet: 'beta', instance: 'i-1', key: '', value: 7 },
      ]);
    });

    it('keeps each instance in its own row, for the reader to sum', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.ROOMS_CREATED, value: 4, bucket: HOUR, instance: 'i-1' },
          { metric: METRICS.ROOMS_CREATED, value: 9, bucket: HOUR, instance: 'i-2' },
        ],
        'beta',
      );

      const rows = await readHourly(METRICS.ROOMS_CREATED);
      expect(rows).toHaveLength(2);
      expect(rows.reduce((total, r) => total + r.value, 0)).toBe(13);
    });

    /**
     * An instance restarting mid-bucket starts its accumulator at zero. A bare
     * overwrite would replace the already-flushed total with that zero and erase
     * counts that had been recorded; `greatest` makes a restart able to stall a
     * counter but never to walk it backwards.
     */
    it('never lets a restarted accumulator walk a counter backwards', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 40, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 3, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );

      expect((await readHourly(METRICS.ROOMS_CREATED))[0]?.value).toBe(40);
    });

    /** A gauge is a level, and levels fall. */
    it('lets a gauge decrease', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.CHANNELS_CREATOR, value: 100, bucket: HOUR }],
        'beta',
      );
      await metrics.writePoints(
        [{ metric: METRICS.CHANNELS_CREATOR, value: 90, bucket: HOUR }],
        'beta',
      );

      expect((await readHourly(METRICS.CHANNELS_CREATOR))[0]?.value).toBe(90);
    });

    /**
     * The failure the fleet column exists to prevent: two fleets each reporting
     * the same shared fact, and a reader summing them into nonsense.
     */
    it('collapses a shared fact written by both fleets onto one row', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.GUILDS_INSTALLED, value: 1004, bucket: HOUR }],
        'beta',
      );
      await metrics.writePoints(
        [{ metric: METRICS.GUILDS_INSTALLED, value: 1004, bucket: HOUR }],
        'prod',
      );

      expect(await readHourly(METRICS.GUILDS_INSTALLED)).toEqual([
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: '', value: 1004 },
      ]);
    });

    it('keeps the same per-fleet metric apart per fleet', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 40, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 900, bucket: HOUR, instance: 'i-9' }],
        'prod',
      );

      expect(await readHourly(METRICS.ROOMS_CREATED)).toEqual([
        { fleet: 'beta', instance: 'i-1', key: '', value: 40 },
        { fleet: 'prod', instance: 'i-9', key: '', value: 900 },
      ]);
    });

    it('truncates a mid-hour timestamp to its bucket', async () => {
      await metrics.writePoints(
        [
          {
            metric: METRICS.ROOMS_CREATED,
            value: 2,
            bucket: new Date('2026-08-19T13:47:31.123Z'),
            instance: 'i-1',
          },
        ],
        'beta',
      );
      const result = await env.handle.db.execute<{ bucket: string }>(
        sql`SELECT bucket FROM metrics_hourly`,
      );
      expect(new Date(result.rows[0]!.bucket).toISOString()).toBe('2026-08-19T13:00:00.000Z');
    });

    it('refuses an undefined metric', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metrics.writePoints([{ metric: 'rooms.creatd' as any, value: 1, bucket: HOUR }]),
      ).rejects.toThrow(/unknown metric/);
    });

    it('reads an instance bucket back so a restart can resume', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.ROOMS_CREATED, value: 12, bucket: HOUR, instance: 'i-1' },
          {
            metric: METRICS.COMMANDS_INVOKED,
            key: 'limit',
            value: 3,
            bucket: HOUR,
            instance: 'i-1',
          },
          { metric: METRICS.ROOMS_CREATED, value: 99, bucket: HOUR, instance: 'other' },
        ],
        'beta',
      );

      const resumed = await metrics.readInstanceBucket(HOUR, 'i-1', 'beta');
      expect(resumed.sort((a, b) => a.metric.localeCompare(b.metric))).toEqual([
        { metric: METRICS.COMMANDS_INVOKED, key: 'limit', value: 3 },
        { metric: METRICS.ROOMS_CREATED, key: '', value: 12 },
      ]);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('collectGauges', () => {
    beforeEach(async () => {
      await env.handle.db.insert(schema.guilds).values([
        { guildId: 'g-1', authStatus: 'active', memberCount: 1200, tier: 'm' },
        { guildId: 'g-2', authStatus: 'trial', memberCount: 40 },
        { guildId: 'g-3', authStatus: 'grace', memberCount: 500 },
        // Removed: must not count towards installs or reach.
        { guildId: 'g-4', authStatus: 'active', memberCount: 9000, botRemovedAt: HOUR },
        // No sample yet: must contribute zero rather than nulling the sum.
        { guildId: 'g-5', authStatus: 'trial' },
      ]);
      await env.handle.db.insert(schema.guildFleetPresence).values([
        { guildId: 'g-1', fleet: 'beta' },
        { guildId: 'g-2', fleet: 'beta' },
        { guildId: 'g-3', fleet: 'prod' },
        { guildId: 'g-4', fleet: 'beta', removedAt: HOUR },
      ]);
      await env.handle.db.insert(schema.autoChannels).values([
        { channelId: 'c-1', guildId: 'g-1', fleet: 'beta' },
        { channelId: 'c-2', guildId: 'g-2', fleet: 'beta' },
        { channelId: 'c-3', guildId: 'g-3', fleet: 'prod' },
      ]);
      await env.handle.db.insert(schema.secondaryChannels).values([
        { channelId: 's-1', guildId: 'g-1', fleet: 'beta', primaryChannelId: 'c-1' },
        { channelId: 's-2', guildId: 'g-1', fleet: 'beta', primaryChannelId: 'c-1' },
        { channelId: 's-3', guildId: 'g-3', fleet: 'prod', primaryChannelId: 'c-3' },
      ]);
    });

    it('counts installed guilds from the shared table, ignoring removals', async () => {
      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.GUILDS_INSTALLED)).toEqual([
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: '', value: 4 },
      ]);
    });

    it('breaks guilds down by auth status', async () => {
      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.GUILDS_STATUS)).toEqual([
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: 'active', value: 1 },
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: 'grace', value: 1 },
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: 'trial', value: 2 },
      ]);
    });

    it('sums member reach and treats an unsampled guild as zero, not null', async () => {
      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.GUILDS_MEMBER_REACH)).toEqual([
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: '', value: 1740 },
      ]);
    });

    /**
     * One writer produces correct rows for every fleet, by reading each table's
     * own fleet column. A fleet that is currently down still gets its row, and no
     * instance has to guess on another's behalf.
     */
    it('derives per-fleet gauges for every fleet from one pass', async () => {
      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.GUILDS_PRESENT)).toEqual([
        { fleet: 'beta', instance: '', key: '', value: 2 },
        { fleet: 'prod', instance: '', key: '', value: 1 },
      ]);
      expect(await readHourly(METRICS.ROOMS_TRACKED)).toEqual([
        { fleet: 'beta', instance: '', key: '', value: 2 },
        { fleet: 'prod', instance: '', key: '', value: 1 },
      ]);
      expect(await readHourly(METRICS.CHANNELS_CREATOR)).toEqual([
        { fleet: 'beta', instance: '', key: '', value: 2 },
        { fleet: 'prod', instance: '', key: '', value: 1 },
      ]);
    });

    /**
     * Good standing is not status alone: an approved refund revokes it while
     * Paddle still reports `active`. Duplicating that rule into SQL is the risk
     * this test covers.
     */
    it('counts only subscriptions in good standing, per tier', async () => {
      await env.handle.db.insert(schema.subscriptions).values([
        {
          guildId: 'g-1',
          paddleSubscriptionId: 'sub-1',
          paddleCustomerId: 'cus-1',
          tier: 'm',
          status: 'active',
        },
        {
          guildId: 'g-2',
          paddleSubscriptionId: 'sub-2',
          paddleCustomerId: 'cus-2',
          tier: 'm',
          status: 'trialing',
        },
        {
          guildId: 'g-3',
          paddleSubscriptionId: 'sub-3',
          paddleCustomerId: 'cus-3',
          tier: 'l',
          status: 'past_due',
        },
        {
          guildId: 'g-4',
          paddleSubscriptionId: 'sub-4',
          paddleCustomerId: 'cus-4',
          tier: 'l',
          status: 'active',
          refundStatus: 'approved',
        },
        {
          guildId: 'g-5',
          paddleSubscriptionId: 'sub-5',
          paddleCustomerId: 'cus-5',
          tier: 'l',
          status: 'active',
          refundStatus: 'requested',
        },
      ]);

      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.SUBSCRIPTIONS_ACTIVE)).toEqual([
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: 'l', value: 1 },
        { fleet: METRIC_SHARED_SCOPE, instance: '', key: 'm', value: 2 },
      ]);
    });

    /**
     * Two rollups land in the same clock hour routinely: the reservation spacing is
     * 55 minutes and the tick is 5. `rooms.tracked` is a peak, so the bucket must
     * keep the highest sample - sweeping and overwriting published whichever sample
     * happened to be last, understating the exact number marketing quotes as peak
     * concurrency.
     */
    it('keeps the highest sample of a peak within one bucket', async () => {
      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.ROOMS_TRACKED)).toEqual([
        { fleet: 'beta', instance: '', key: '', value: 2 },
        { fleet: 'prod', instance: '', key: '', value: 1 },
      ]);

      // Rooms cleaned up before the second sample in the same hour.
      await env.handle.db.delete(schema.secondaryChannels);
      await metrics.collectGauges(HOUR);

      expect(await readHourly(METRICS.ROOMS_TRACKED)).toEqual([
        { fleet: 'beta', instance: '', key: '', value: 2 },
        { fleet: 'prod', instance: '', key: '', value: 1 },
      ]);
    });

    /** A gauge is the opposite: a group that empties has to actually disappear. */
    it('converges on a second pass for the same bucket', async () => {
      await metrics.collectGauges(HOUR);
      expect(await readHourly(METRICS.CHANNELS_CREATOR)).toHaveLength(2);

      await env.handle.db.delete(schema.autoChannels);
      await metrics.collectGauges(HOUR);

      // Absence is how this store says zero, so the rows must be gone, not zeroed.
      expect(await readHourly(METRICS.CHANNELS_CREATOR)).toEqual([]);
    });

    /** And the sweep must never reach an instance's flushed counters. */
    it('leaves flushed counters alone when it sweeps its own rows', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 9, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );
      await metrics.collectGauges(HOUR);
      await metrics.collectGauges(HOUR);

      expect(await readHourly(METRICS.ROOMS_CREATED)).toEqual([
        { fleet: 'beta', instance: 'i-1', key: '', value: 9 },
      ]);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('rollupDaily', () => {
    it('sums a counter across buckets and instances, collapsing the instance', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.ROOMS_CREATED, value: 4, bucket: HOUR, instance: 'i-1' },
          { metric: METRICS.ROOMS_CREATED, value: 6, bucket: HOUR, instance: 'i-2' },
          { metric: METRICS.ROOMS_CREATED, value: 10, bucket: NEXT_HOUR, instance: 'i-1' },
        ],
        'beta',
      );

      await metrics.rollupDaily(DAY, NEXT_DAY);
      const result = await env.handle.db.execute<{
        fleet: string;
        instance: string;
        value: string;
        bucket: string;
      }>(sql`SELECT fleet, instance, value, bucket FROM metrics_daily
               WHERE metric = ${METRICS.ROOMS_CREATED}`);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ fleet: 'beta', instance: '' });
      expect(Number(result.rows[0]!.value)).toBe(20);
      expect(new Date(result.rows[0]!.bucket).toISOString()).toBe('2026-08-19T00:00:00.000Z');
    });

    /**
     * Recompute-and-overwrite, so running the rollup repeatedly through the day
     * converges instead of accumulating. This is the property that lets it run
     * every hour on an unfinished day.
     */
    it('is idempotent across repeated runs', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 5, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );
      await metrics.rollupDaily(DAY, NEXT_DAY);
      await metrics.rollupDaily(DAY, NEXT_DAY);
      await metrics.rollupDaily(DAY, NEXT_DAY);

      const result = await env.handle.db.execute<{ value: string }>(
        sql`SELECT value FROM metrics_daily WHERE metric = ${METRICS.ROOMS_CREATED}`,
      );
      expect(result.rows.map((r) => Number(r.value))).toEqual([5]);
    });

    /**
     * A gauge summed over 24 buckets would be inflated 24x. The daily value is
     * the latest bucket's, and it must survive a rerun that sees the same rows.
     */
    it('takes the latest bucket for a gauge, not the sum', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.CHANNELS_CREATOR, value: 100, bucket: HOUR },
          { metric: METRICS.CHANNELS_CREATOR, value: 103, bucket: NEXT_HOUR },
        ],
        'beta',
      );
      await metrics.rollupDaily(DAY, NEXT_DAY);

      const result = await env.handle.db.execute<{ value: string }>(
        sql`SELECT value FROM metrics_daily WHERE metric = ${METRICS.CHANNELS_CREATOR}`,
      );
      expect(result.rows.map((r) => Number(r.value))).toEqual([103]);
    });

    /**
     * Peaks sum across the instances inside a bucket first (a per-instance row is
     * one machine's share of a fleet-wide number) and only then take the maximum
     * across buckets. `max` alone would report a two-machine fleet's busiest hour
     * as one machine's.
     */
    it('sums a peak across instances within a bucket, then maxes across buckets', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.QUEUE_DEPTH_PEAK, value: 10, bucket: HOUR, instance: 'i-1' },
          { metric: METRICS.QUEUE_DEPTH_PEAK, value: 12, bucket: HOUR, instance: 'i-2' },
          { metric: METRICS.QUEUE_DEPTH_PEAK, value: 15, bucket: NEXT_HOUR, instance: 'i-1' },
        ],
        'beta',
      );
      await metrics.rollupDaily(DAY, NEXT_DAY);

      const result = await env.handle.db.execute<{ value: string }>(
        sql`SELECT value FROM metrics_daily WHERE metric = ${METRICS.QUEUE_DEPTH_PEAK}`,
      );
      expect(result.rows.map((r) => Number(r.value))).toEqual([22]);
    });

    /**
     * `date_trunc('day', timestamptz)` truncates in the session's TimeZone, so a
     * container running anywhere but UTC would file the last hours of a day under
     * the next one. Pinned by rolling up a 23:00Z bucket.
     */
    /**
     * `date_trunc('day', <timestamptz>)` truncates in the SESSION's TimeZone, so the
     * bare form would file the last hours of a UTC day under the next one for any
     * connection that is not UTC. The rollup writes `AT TIME ZONE 'UTC'` on both
     * sides to pin it.
     *
     * Asserted on a **dedicated client**, not through `db.execute`: that hands out
     * an arbitrary client per statement, so a `SET TIME ZONE` issued through it may
     * not be the connection the assertion runs on - the test would usually pass by
     * luck and could leave a pooled connection stuck on the wrong timezone for
     * every test after it.
     */
    it('truncates days in UTC whatever timezone the session is in', async () => {
      const client = await env.handle.pool.connect();
      try {
        await client.query("SET TIME ZONE 'Pacific/Auckland'");
        const late = '2026-08-19T23:00:00Z';
        const bare = await client.query<{ day: Date }>(
          `SELECT date_trunc('day', $1::timestamptz) AS day`,
          [late],
        );
        const pinned = await client.query<{ day: Date }>(
          `SELECT date_trunc('day', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day`,
          [late],
        );
        // The bare form lands on the 20th in Auckland; the pinned form must not.
        expect(bare.rows[0]!.day.toISOString()).not.toBe('2026-08-19T00:00:00.000Z');
        expect(pinned.rows[0]!.day.toISOString()).toBe('2026-08-19T00:00:00.000Z');
      } finally {
        client.release(true);
      }
    });

    it('files a 23:00Z bucket under that same UTC day', async () => {
      await metrics.writePoints(
        [
          {
            metric: METRICS.ROOMS_CREATED,
            value: 3,
            bucket: new Date('2026-08-19T23:00:00Z'),
            instance: 'i-1',
          },
        ],
        'beta',
      );
      await metrics.rollupDaily(DAY, NEXT_DAY);
      const result = await env.handle.db.execute<{ bucket: string }>(
        sql`SELECT bucket FROM metrics_daily WHERE metric = ${METRICS.ROOMS_CREATED}`,
      );
      expect(result.rows).toHaveLength(1);
      expect(new Date(result.rows[0]!.bucket).toISOString()).toBe('2026-08-19T00:00:00.000Z');
    });

    /**
     * The window used to be "yesterday and today", which meant a rollup that failed
     * for three days left permanent holes: the hourly rows were all there, nothing
     * revisited them, and the daily table is the only thing the charts read.
     */
    describe('rollupWindow', () => {
      it('covers yesterday and today in steady state', async () => {
        await metrics.writePoints(
          [{ metric: METRICS.ROOMS_CREATED, value: 1, bucket: HOUR, instance: 'i-1' }],
          'beta',
        );
        await metrics.rollupDaily(DAY, NEXT_DAY);

        const window = await metrics.rollupWindow(HOUR);
        expect(window.from.toISOString()).toBe('2026-08-18T00:00:00.000Z');
        expect(window.to.toISOString()).toBe('2026-08-20T00:00:00.000Z');
      });

      it('reaches back to the newest rolled-up day after an outage', async () => {
        // Hourly rows exist for four days; only the first was ever rolled up.
        for (let day = 16; day <= 19; day += 1) {
          await metrics.writePoints(
            [
              {
                metric: METRICS.ROOMS_CREATED,
                value: 1,
                bucket: new Date(`2026-08-${day}T05:00:00Z`),
                instance: 'i-1',
              },
            ],
            'beta',
          );
        }
        await metrics.rollupDaily(
          new Date('2026-08-16T00:00:00Z'),
          new Date('2026-08-17T00:00:00Z'),
        );

        const window = await metrics.rollupWindow(HOUR);
        expect(window.from.toISOString()).toBe('2026-08-16T00:00:00.000Z');

        // And recomputing that window fills every hole, not just yesterday's.
        await metrics.rollupDaily(window.from, window.to);
        const days = await env.handle.db.execute<{ bucket: string }>(
          sql`SELECT bucket FROM metrics_daily WHERE metric = ${METRICS.ROOMS_CREATED}
                ORDER BY bucket`,
        );
        expect(days.rows.map((r) => new Date(r.bucket).toISOString().slice(0, 10))).toEqual([
          '2026-08-16',
          '2026-08-17',
          '2026-08-18',
          '2026-08-19',
        ]);
      });

      it('starts at the oldest hourly bucket when nothing has been rolled up', async () => {
        await metrics.writePoints(
          [
            {
              metric: METRICS.ROOMS_CREATED,
              value: 1,
              bucket: new Date('2026-08-14T05:00:00Z'),
              instance: 'i-1',
            },
          ],
          'beta',
        );
        const window = await metrics.rollupWindow(HOUR);
        expect(window.from.toISOString()).toBe('2026-08-14T00:00:00.000Z');
      });

      /** Past the hourly retention there is nothing left to recompute from. */
      it('clamps to the hourly retention window', async () => {
        await metrics.writePoints(
          [
            {
              metric: METRICS.ROOMS_CREATED,
              value: 1,
              bucket: new Date('2025-01-01T05:00:00Z'),
              instance: 'i-1',
            },
          ],
          'beta',
        );
        const window = await metrics.rollupWindow(HOUR, 90);
        expect(window.from.getTime()).toBe(
          new Date('2026-08-19T00:00:00Z').getTime() - 90 * 86_400_000,
        );
      });

      it('handles a completely empty store', async () => {
        const window = await metrics.rollupWindow(HOUR);
        expect(window.from.toISOString()).toBe('2026-08-18T00:00:00.000Z');
      });
    });

    it('leaves buckets outside the window alone', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.ROOMS_CREATED, value: 5, bucket: HOUR, instance: 'i-1' },
          {
            metric: METRICS.ROOMS_CREATED,
            value: 50,
            bucket: new Date('2026-08-21T05:00:00Z'),
            instance: 'i-1',
          },
        ],
        'beta',
      );
      await metrics.rollupDaily(DAY, NEXT_DAY);
      const result = await env.handle.db.execute<{ value: string }>(
        sql`SELECT value FROM metrics_daily WHERE metric = ${METRICS.ROOMS_CREATED}`,
      );
      expect(result.rows.map((r) => Number(r.value))).toEqual([5]);
    });
  });

  /* ---------------------------------------------------------------------- */

  describe('reading and housekeeping', () => {
    it('reads one metric over time, summed across instances and fleets', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.ROOMS_CREATED, value: 4, bucket: HOUR, instance: 'i-1' },
          { metric: METRICS.ROOMS_CREATED, value: 6, bucket: HOUR, instance: 'i-2' },
          { metric: METRICS.ROOMS_CREATED, value: 2, bucket: NEXT_HOUR, instance: 'i-1' },
        ],
        'beta',
      );
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 100, bucket: HOUR, instance: 'p-1' }],
        'prod',
      );

      const series = await metrics.readSeries({
        metric: METRICS.ROOMS_CREATED,
        from: DAY,
        to: NEXT_DAY,
        resolution: 'hourly',
      });
      expect(series.map((p) => p.value)).toEqual([110, 2]);

      const betaOnly = await metrics.readSeries({
        metric: METRICS.ROOMS_CREATED,
        from: DAY,
        to: NEXT_DAY,
        resolution: 'hourly',
        fleet: 'beta',
      });
      expect(betaOnly.map((p) => p.value)).toEqual([10, 2]);
    });

    /**
     * The reason the admin reader falls back to hourly on a young store.
     *
     * A daily series gains one point per UTC day and a chart needs two, so a
     * collector deployed this morning has a daily series that cannot be drawn while
     * the hourly table under it already has several points. This pins that the two
     * resolutions really do differ that way over the same window - it is the fact
     * the fallback depends on.
     */
    it('has a drawable hourly series before it has a drawable daily one', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.ROOMS_TRACKED, value: 12, bucket: HOUR },
          { metric: METRICS.ROOMS_TRACKED, value: 14, bucket: NEXT_HOUR },
        ],
        'beta',
      );
      await metrics.rollupDaily(DAY, NEXT_DAY);

      const daily = await metrics.readSeries({
        metric: METRICS.ROOMS_TRACKED,
        from: DAY,
        to: NEXT_DAY,
        resolution: 'daily',
      });
      const hourly = await metrics.readSeries({
        metric: METRICS.ROOMS_TRACKED,
        from: DAY,
        to: NEXT_DAY,
        resolution: 'hourly',
      });

      expect(daily).toHaveLength(1);
      expect(hourly).toHaveLength(2);
      // And the daily row is the peak of the hours under it, not the last of them.
      expect(daily[0]!.value).toBe(14);
      expect(hourly.map((p) => p.value)).toEqual([12, 14]);
    });

    it('keeps a keyed metric split by key', async () => {
      await metrics.writePoints(
        [
          { metric: METRICS.COMMANDS_INVOKED, key: 'limit', value: 3, bucket: HOUR, instance: 'i' },
          { metric: METRICS.COMMANDS_INVOKED, key: 'name', value: 7, bucket: HOUR, instance: 'i' },
        ],
        'beta',
      );
      const series = await metrics.readSeries({
        metric: METRICS.COMMANDS_INVOKED,
        from: DAY,
        to: NEXT_DAY,
        resolution: 'hourly',
      });
      expect(series.map((p) => [p.key, p.value])).toEqual([
        ['limit', 3],
        ['name', 7],
      ]);
    });

    it('prunes hourly rows past the retention window and keeps the daily ones', async () => {
      const old = new Date('2026-01-01T00:00:00Z');
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 1, bucket: old, instance: 'i-1' }],
        'beta',
      );
      await metrics.rollupDaily(old, new Date('2026-01-02T00:00:00Z'));
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 2, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );

      const pruned = await metrics.pruneHourly(HOUR, 90);
      expect(pruned).toBe(1);
      expect(await readHourly(METRICS.ROOMS_CREATED)).toEqual([
        { fleet: 'beta', instance: 'i-1', key: '', value: 2 },
      ]);
      const daily = await env.handle.db.execute<{ value: string }>(
        sql`SELECT value FROM metrics_daily`,
      );
      expect(daily.rows).toHaveLength(1);
    });

    /**
     * §8: a collector that dies quietly makes every chart downstream read zero,
     * and a zero is indistinguishable from an answer. Freshness is what lets a
     * reader render staleness instead of a shape.
     */
    it('reports freshness, and an empty store as empty rather than as zero', async () => {
      expect(await metrics.freshness()).toEqual({
        lastHourlyBucket: null,
        lastDailyBucket: null,
        hourlyRows: 0,
        dailyRows: 0,
      });

      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 1, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );
      const fresh = await metrics.freshness();
      expect(fresh.lastHourlyBucket?.toISOString()).toBe(hourBucket(HOUR).toISOString());
      expect(fresh.hourlyRows).toBe(1);
      expect(fresh.lastDailyBucket).toBeNull();
    });

    /**
     * The failure a store-wide freshness check cannot see, and the reason the web
     * reader asks per metric: the derived gauges come from the cluster singleton and
     * the counters come from each instance's flush, so one half can keep the store
     * looking healthy while the series actually on screen has stopped.
     */
    it('reports the newest bucket per metric, not just store-wide', async () => {
      await metrics.writePoints(
        [{ metric: METRICS.ROOMS_CREATED, value: 1, bucket: HOUR, instance: 'i-1' }],
        'beta',
      );
      await metrics.writePoints(
        [{ metric: METRICS.CHANNELS_CREATOR, value: 5, bucket: NEXT_HOUR }],
        'beta',
      );

      expect((await metrics.latestBucket()).hourly?.toISOString()).toBe(NEXT_HOUR.toISOString());
      expect((await metrics.latestBucket(METRICS.ROOMS_CREATED)).hourly?.toISOString()).toBe(
        HOUR.toISOString(),
      );
      expect((await metrics.latestBucket(METRICS.COMMANDS_INVOKED)).hourly).toBeNull();
    });
  });
});
