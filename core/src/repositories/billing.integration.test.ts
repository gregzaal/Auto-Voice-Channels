import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBillingMeta } from '../domain/billing.js';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { BillingEventRepository } from './billingEvents.js';
import { BillingRunRepository } from './billingRuns.js';
import { GuildRepository } from './guilds.js';
import { classifyAdjustment } from '../domain/refunds.js';
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

    /**
     * The billing origin, and specifically the asymmetry in how it is written.
     *
     * The country costs a second Paddle API call that is deliberately allowed
     * to fail without failing the webhook, so a later transaction can arrive
     * with totals and no country. Overwriting on every transaction would let
     * one API blip erase a good value at a renewal, silently, and the row would
     * then read as "this customer has no country" rather than "we did not ask
     * successfully". Hence: totals always overwrite, origin only fills in.
     */
    it('records the billing origin and never nulls it on a later blank', async () => {
      await subs.upsert({
        guildId: 'sub-origin',
        paddleSubscriptionId: 'psub_origin',
        paddleCustomerId: 'pcus_origin',
        tier: 'm',
        status: 'active',
        price: '5900',
        currency: 'USD',
      });

      await subs.recordChargedTotals('psub_origin', {
        total: '3900',
        tax: '509',
        currency: 'USD',
        countryCode: 'ZA',
        priceId: 'pri_standard_m',
      });
      expect(await subs.getByGuild('sub-origin')).toMatchObject({
        chargedTotal: '3900',
        billingCountryCode: 'ZA',
        billedPriceId: 'pri_standard_m',
      });

      // A renewal whose address lookup failed: totals move, origin holds. The
      // country is written by its own method, so the failed case is simply not
      // calling it, which is what this asserts.
      await subs.recordChargedTotals('psub_origin', {
        total: '4100',
        tax: '535',
        currency: 'USD',
        priceId: null,
      });
      expect(await subs.getByGuild('sub-origin')).toMatchObject({
        chargedTotal: '4100',
        billingCountryCode: 'ZA',
        billedPriceId: 'pri_standard_m',
      });

      // A customer who actually moved does get updated.
      await subs.recordBillingCountry('psub_origin', 'DE');
      expect(await subs.getByGuild('sub-origin')).toMatchObject({
        chargedTotal: '4100',
        billingCountryCode: 'DE',
      });

      /**
       * Lowercase is normalised on write, and it is not cosmetic:
       * `bandForCountry` matches uppercase ISO literals and returns band A for
       * anything it does not recognise, so a stray lowercase code would be
       * reported as full-price revenue rather than as unattributed.
       */
      await subs.recordBillingCountry('psub_origin', 'za');
      expect(await subs.getByGuild('sub-origin')).toMatchObject({
        billingCountryCode: 'ZA',
      });
    });
  });

  describe('applyAdjustment (the ordering guard)', () => {
    /**
     * `plans/refunds.md` §2.6. `recordRefund` is last-write-wins, so a second
     * refund request arriving `pending_approval` overwrote `'approved'`,
     * standing flipped back true and the ladder reactivated a guild whose money
     * we had already returned. The guard is in the WHERE clause rather than
     * read-then-written, so two concurrent deliveries cannot both win.
     */
    const adj = (over: Record<string, unknown> = {}) => ({
      adjustmentId: 'adj_1',
      paddleSubscriptionId: 'sub_guard',
      transactionId: 'txn_current',
      action: 'refund',
      status: 'approved',
      type: 'full',
      total: '3900',
      currency: 'USD',
      updatedAt: new Date('2026-08-31T12:00:00.000Z'),
      ...over,
    });

    async function seed() {
      await guilds.ensure('guard-guild');
      return subs.upsert({
        guildId: 'guard-guild',
        paddleSubscriptionId: 'sub_guard',
        paddleCustomerId: 'ctm_guard',
        tier: 'm',
        status: 'active',
      });
    }

    it('applies a newer adjustment and refuses an older one', async () => {
      await seed();
      await subs.recordChargedTotals('sub_guard', {
        total: '3900',
        transactionId: 'txn_current',
      });

      const approved = adj();
      const applied = await subs.applyAdjustment(
        approved,
        classifyAdjustment(approved, {
          chargedTransactionId: 'txn_current',
          refundAdjustmentId: null,
        }),
      );
      expect(applied).toBe(true);

      let row = await subs.getByGuild('guard-guild');
      expect(row?.refundSettledAt).not.toBeNull();
      expect(row?.refundAdjustmentId).toBe('adj_1');

      // The §2.6 attack: a SECOND request, stamped earlier, arriving after.
      const stale = adj({
        adjustmentId: 'adj_2',
        status: 'pending_approval',
        updatedAt: new Date('2026-08-30T12:00:00.000Z'),
      });
      const staleApplied = await subs.applyAdjustment(
        stale,
        classifyAdjustment(stale, {
          chargedTransactionId: 'txn_current',
          refundAdjustmentId: 'adj_1',
        }),
      );
      expect(staleApplied).toBe(false);

      row = await subs.getByGuild('guard-guild');
      expect(row?.refundStatus).toBe('approved');
      expect(row?.refundSettledAt).not.toBeNull();
    });

    it('lets the same adjustment progress, since Paddle can stamp two events alike', async () => {
      await guilds.ensure('guard-guild-2');
      await subs.upsert({
        guildId: 'guard-guild-2',
        paddleSubscriptionId: 'sub_guard_2',
        paddleCustomerId: 'ctm_guard_2',
        tier: 'm',
        status: 'active',
      });
      const at = new Date('2026-08-31T12:00:00.000Z');
      const created = adj({
        paddleSubscriptionId: 'sub_guard_2',
        status: 'pending_approval',
        updatedAt: at,
      });
      await subs.applyAdjustment(
        created,
        classifyAdjustment(created, { chargedTransactionId: null, refundAdjustmentId: null }),
      );
      // Same timestamp, now approved. `<=` rather than `<` is what admits this.
      const approved = adj({ paddleSubscriptionId: 'sub_guard_2', updatedAt: at });
      expect(
        await subs.applyAdjustment(
          approved,
          classifyAdjustment(approved, { chargedTransactionId: null, refundAdjustmentId: null }),
        ),
      ).toBe(true);
      const row = await subs.getByGuild('guard-guild-2');
      expect(row?.refundSettledAt).not.toBeNull();
    });

    it('clears the marker on a reversal of the adjustment that set it', async () => {
      await guilds.ensure('guard-guild-3');
      await subs.upsert({
        guildId: 'guard-guild-3',
        paddleSubscriptionId: 'sub_guard_3',
        paddleCustomerId: 'ctm_guard_3',
        tier: 'm',
        status: 'active',
      });
      const approved = adj({ paddleSubscriptionId: 'sub_guard_3' });
      await subs.applyAdjustment(
        approved,
        classifyAdjustment(approved, { chargedTransactionId: null, refundAdjustmentId: null }),
      );
      const reversed = adj({
        paddleSubscriptionId: 'sub_guard_3',
        status: 'reversed',
        updatedAt: new Date('2026-09-01T12:00:00.000Z'),
      });
      await subs.applyAdjustment(
        reversed,
        classifyAdjustment(reversed, {
          chargedTransactionId: null,
          refundAdjustmentId: 'adj_1',
        }),
      );
      const row = await subs.getByGuild('guard-guild-3');
      expect(row?.refundSettledAt).toBeNull();
      expect(row?.refundAdjustmentId).toBeNull();
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
