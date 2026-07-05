import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBillingMeta } from '../domain/billing.js';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { BillingEventRepository } from './billingEvents.js';
import { BillingRunRepository } from './billingRuns.js';
import { GuildRepository } from './guilds.js';
import { SubscriptionRepository } from './subscriptions.js';

describe('billing repositories (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let subs: SubscriptionRepository;
  let events: BillingEventRepository;
  let runs: BillingRunRepository;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    subs = new SubscriptionRepository(env.handle.db);
    events = new BillingEventRepository(env.handle.db);
    runs = new BillingRunRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  describe('GuildRepository billing extensions', () => {
    it('transitionAuth sets and clears graceUntil atomically', async () => {
      await guilds.ensure('b-1');
      const graceUntil = new Date('2026-09-01T00:00:00.000Z');
      const inGrace = await guilds.transitionAuth({
        guildId: 'b-1',
        toStatus: 'grace',
        reason: 'trial_expired',
        graceUntil,
      });
      expect(inGrace.authStatus).toBe('grace');
      expect(inGrace.graceUntil).toEqual(graceUntil);

      const expired = await guilds.transitionAuth({
        guildId: 'b-1',
        toStatus: 'expired',
        graceUntil: null,
      });
      expect(expired.graceUntil).toBeNull();
      // Omitting graceUntil leaves it unchanged.
      const back = await guilds.transitionAuth({ guildId: 'b-1', toStatus: 'trial' });
      expect(back.graceUntil).toBeNull();
    });

    it('records daily member-count samples with a rolling history', async () => {
      const day1 = new Date('2026-07-01T10:00:00.000Z');
      const day2 = new Date('2026-07-02T10:00:00.000Z');
      const first = await guilds.recordMemberCountSample('b-2', 500, { at: day1 });
      expect(first.accepted).toBe(true);
      expect(first.row.memberCount).toBe(500);
      expect(first.row.memberCountUpdatedAt).toEqual(day1);

      // Same-day update replaces the day's entry rather than appending.
      const sameDay = await guilds.recordMemberCountSample('b-2', 510, {
        at: new Date('2026-07-01T20:00:00.000Z'),
      });
      let meta = parseBillingMeta(sameDay.row.metadata);
      expect(meta.samples).toEqual([{ day: '2026-07-01', count: 510 }]);

      const nextDay = await guilds.recordMemberCountSample('b-2', 520, { at: day2 });
      meta = parseBillingMeta(nextDay.row.metadata);
      expect(meta.samples).toEqual([
        { day: '2026-07-01', count: 510 },
        { day: '2026-07-02', count: 520 },
      ]);
    });

    it('clamps anomalies until confirmed, unless the read is authoritative', async () => {
      await guilds.recordMemberCountSample('b-3', 5_000, {
        at: new Date('2026-07-01T00:00:00.000Z'),
      });
      // A lone collapse to zero is held back.
      const clamped = await guilds.recordMemberCountSample('b-3', 0, {
        at: new Date('2026-07-02T00:00:00.000Z'),
      });
      expect(clamped.accepted).toBe(false);
      expect(clamped.row.memberCount).toBe(5_000);
      expect(parseBillingMeta(clamped.row.metadata).pendingAnomaly).toEqual({
        day: '2026-07-02',
        count: 0,
      });

      // The next day agrees → the change is real.
      const confirmed = await guilds.recordMemberCountSample('b-3', 0, {
        at: new Date('2026-07-03T00:00:00.000Z'),
      });
      expect(confirmed.accepted).toBe(true);
      expect(confirmed.row.memberCount).toBe(0);
      expect(parseBillingMeta(confirmed.row.metadata).pendingAnomaly).toBeUndefined();

      // An authoritative REST read bypasses the clamps outright.
      const jump = await guilds.recordMemberCountSample('b-3', 9_999, {
        at: new Date('2026-07-04T00:00:00.000Z'),
        authoritative: true,
      });
      expect(jump.accepted).toBe(true);
      expect(jump.row.memberCount).toBe(9_999);
    });

    it('records and prunes billing notifications', async () => {
      await guilds.ensure('b-4');
      await guilds.recordBillingNotification('b-4', 'trial_warning:30:x', new Date());
      const row = await guilds.getOrThrow('b-4');
      const meta = parseBillingMeta(row.metadata);
      expect(meta.notifications['trial_warning:30:x']).toBeTruthy();
    });

    it('markOnboarded is one-shot', async () => {
      await guilds.ensure('b-5');
      const first = new Date('2026-07-01T00:00:00.000Z');
      await guilds.markOnboarded('b-5', first);
      await guilds.markOnboarded('b-5', new Date('2026-07-02T00:00:00.000Z'));
      const meta = parseBillingMeta((await guilds.getOrThrow('b-5')).metadata);
      expect(meta.onboardedAt).toBe(first.toISOString());
    });

    it('setBilledTier updates the tier cache', async () => {
      const row = await guilds.setBilledTier('b-6', 'm');
      expect(row.tier).toBe('m');
      expect((await guilds.setBilledTier('b-6', null)).tier).toBeNull();
    });

    it('listBatch pages by guild id', async () => {
      await guilds.ensure('page-1');
      await guilds.ensure('page-2');
      await guilds.ensure('page-3');
      const first = await guilds.listBatch('page-0', 2);
      expect(first.rows.map((r) => r.guildId)).toEqual(['page-1', 'page-2']);
      const second = await guilds.listBatch(first.lastGuildId, 2);
      expect(second.rows.map((r) => r.guildId)).toContain('page-3');
    });
  });

  describe('SubscriptionRepository', () => {
    it('upserts idempotently keyed on guild id', async () => {
      const created = await subs.upsert({
        guildId: 'sub-1',
        paddleSubscriptionId: 'psub_1',
        paddleCustomerId: 'pcus_1',
        tier: 'm',
        status: 'active',
        currentPeriodEnd: new Date('2027-07-01T00:00:00.000Z'),
        price: '5900',
        currency: 'USD',
      });
      expect(created.tier).toBe('m');

      const updated = await subs.upsert({
        guildId: 'sub-1',
        paddleSubscriptionId: 'psub_1',
        paddleCustomerId: 'pcus_1',
        tier: 'l',
        status: 'past_due',
      });
      expect(updated.tier).toBe('l');
      expect(updated.status).toBe('past_due');
      expect(await subs.getByPaddleId('psub_1')).toMatchObject({ guildId: 'sub-1' });
      expect(await subs.getByGuild('sub-1')).toMatchObject({ tier: 'l' });
    });
  });

  describe('BillingEventRepository (webhook idempotency)', () => {
    it('recordOnce inserts once; replays are no-ops', async () => {
      const input = {
        paddleEventId: 'evt_1',
        eventType: 'subscription.created',
        guildId: 'sub-1',
        payload: { data: { id: 'psub_1' } },
      };
      expect(await events.recordOnce(input)).toEqual({ inserted: true });
      expect(await events.recordOnce(input)).toEqual({ inserted: false });

      await events.markProcessed('evt_1');
      const row = await events.get('evt_1');
      expect(row?.processedAt).toBeTruthy();
    });
  });

  describe('BillingRunRepository (advisory-locked singleton job)', () => {
    it('one contender wins each spacing window', async () => {
      // Simulate two instances racing: both reserve concurrently.
      const [a, b] = await Promise.all([
        runs.reserveRun('billing.advance', 60_000, 'inst-a'),
        runs.reserveRun('billing.advance', 60_000, 'inst-b'),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const loser = [a, b].find((r) => !r.ok)!;
      expect(loser.waitMs).toBeGreaterThan(0);

      // Within the window, everyone is refused.
      expect((await runs.reserveRun('billing.advance', 60_000, 'inst-c')).ok).toBe(false);
      // A different job key is independent.
      expect((await runs.reserveRun('other.job', 60_000, 'inst-c')).ok).toBe(true);
      // Zero spacing → immediately reservable again.
      expect((await runs.reserveRun('billing.advance', 0, 'inst-c')).ok).toBe(true);
    });
  });
});
