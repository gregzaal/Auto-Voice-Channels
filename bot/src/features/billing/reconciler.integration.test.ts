import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingNotificationRepository,
  BillingRunRepository,
  GuildFleetPresenceRepository,
  GuildRepository,
  OpsAuditRepository,
  parseBillingMeta,
  RuntimeFlagsRepository,
  SubscriptionRepository,
  type Fleet,
  type LeniencyNotification,
  type TrialPolicy,
} from '@avc/core';
import { startPostgres, type PgTestEnv } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { BillingReconciler } from './reconciler.js';
import type { BillingNotifier } from './notifier.js';

const DAY_MS = 86_400_000;

/** Records every delivery; configurable to simulate delivery failure. */
class RecordingNotifier implements BillingNotifier {
  readonly notifications: { guildId: string; notification: LeniencyNotification }[] = [];
  deliver = true;
  async notifyGuild(guildId: string, notification: LeniencyNotification): Promise<boolean> {
    this.notifications.push({ guildId, notification });
    return this.deliver;
  }
  async welcomeGuild(
    _guildId: string,
    _policy: TrialPolicy,
    _memberCount: number,
  ): Promise<boolean> {
    return this.deliver;
  }
  ofKind(kind: string): { guildId: string; notification: LeniencyNotification }[] {
    return this.notifications.filter((n) => n.notification.kind === kind);
  }
  /**
   * Scoped to one guild.
   *
   * The deliver phase drains everything this fleet can reach, so a bare
   * `ofKind` in a shared-database test file also counts notifications another
   * test left pending. That is correct behaviour and a misleading assertion.
   */
  forGuild(guildId: string, kind: string): { notification: LeniencyNotification }[] {
    return this.notifications.filter((n) => n.guildId === guildId && n.notification.kind === kind);
  }
}

/** Accepts every delivery without recording it as one the test cares about. */
function silentNotifier(): RecordingNotifier {
  const n = new RecordingNotifier();
  n.deliver = false; // queued, never delivered, dedupe left unstamped
  return n;
}

describe('BillingReconciler (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let flags: RuntimeFlagsRepository;
  let notifications: BillingNotificationRepository;
  let presence: GuildFleetPresenceRepository;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    flags = new RuntimeFlagsRepository(env.handle.db);
    notifications = new BillingNotificationRepository(env.handle.db);
    presence = new GuildFleetPresenceRepository(env.handle.db, 'prod');
    // Migration 0007 seeds the job disabled (rolling-deploy safety for the
    // `grace` enum expansion); these tests exercise the enabled behavior.
    await flags.set('billing.reconcile_disabled', false, { actor: 'test' });
  });

  afterAll(async () => {
    await env?.stop();
  });

  /**
   * A guild this fleet is actually in.
   *
   * Delivery claims by joining `guild_fleet_presence`, so a guild with no
   * presence row is one no fleet can be handed work for — correct behaviour,
   * and its own test below, but the wrong default for every other case here.
   */
  async function ensureGuild(guildId: string): Promise<void> {
    await guilds.ensure(guildId);
    await presence.markPresent(guildId);
  }

  /** Undelivered rows for one guild. Scoped, because the DB is shared. */
  async function pendingFor(guildId: string): Promise<number> {
    const result = await env.handle.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM billing_notifications WHERE guild_id = $1 AND delivered_at IS NULL',
      [guildId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  function makeReconciler(opts: {
    now: () => Date;
    counts?: Map<string, number>;
    cached?: { guildId: string; memberCount: number }[];
    notifier?: RecordingNotifier;
    fleet?: Fleet;
  }) {
    const notifier = opts.notifier ?? new RecordingNotifier();
    const reconciler = new BillingReconciler({
      guilds,
      store: guilds, // raw repo satisfies GuildSettingsStore structurally
      subscriptions: new SubscriptionRepository(env.handle.db),
      runs: new BillingRunRepository(env.handle.db),
      notifications,
      flags,
      opsAudit: new OpsAuditRepository(env.handle.db),
      notifier,
      listCachedGuildCounts: () => opts.cached ?? [],
      fetchAuthoritativeCount: async (guildId) => opts.counts?.get(guildId) ?? null,
      logger: fakeLogger(),
      instanceId: 'test-instance',
      fleet: opts.fleet ?? 'prod',
      advanceSpacingMs: 0, // every runOnce advances (tests drive time explicitly)
      now: opts.now,
    });
    return { reconciler, notifier };
  }

  it('walks the full ladder: backfill → warning → grace → expired → reactivation', async () => {
    const guildId = 'ladder-1';
    let now = new Date('2026-07-04T12:00:00.000Z');
    const counts = new Map([[guildId, 500]]);
    const { reconciler, notifier } = makeReconciler({ now: () => now, counts });

    // Bot was added ~1 year ago (row created then); 500 members.
    await ensureGuild(guildId);
    await env.handle.pool.query('UPDATE guilds SET created_at = $1 WHERE guild_id = $2', [
      new Date(now.getTime() - 340 * DAY_MS),
      guildId,
    ]);
    await guilds.recordMemberCountSample(guildId, 500, { at: now });

    // Run 1: backfills the 1-year window from the row's createdAt (~25d left)
    // and fires the T−30 advance warning.
    await reconciler.runOnce();
    let row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('trial');
    expect(row.authExpiresAt).toEqual(new Date(row.createdAt.getTime() + 365 * DAY_MS));
    expect(notifier.ofKind('trial_warning')).toHaveLength(1);

    // Re-running the same day does not repeat the warning (dedupe key recorded).
    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(1);

    // Run 2: 30 days later the window has lapsed → grace (validated count).
    now = new Date(now.getTime() + 30 * DAY_MS);
    await reconciler.runOnce();
    row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('grace');
    expect(row.graceUntil).toEqual(new Date(now.getTime() + 60 * DAY_MS));
    expect(notifier.ofKind('grace_started')).toHaveLength(1);

    // Run 3: a week in → weekly nudge.
    now = new Date(now.getTime() + 8 * DAY_MS);
    await reconciler.runOnce();
    expect(notifier.ofKind('grace_nudge')).toHaveLength(1);

    // Run 4: grace elapses → hard gate (expired), one-time notice.
    now = new Date(now.getTime() + 60 * DAY_MS);
    await reconciler.runOnce();
    row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('expired');
    expect(row.graceUntil).toBeNull();
    expect(notifier.ofKind('hard_gate')).toHaveLength(1);

    // Run 5: the guild shrinks under 100 members → instant reactivation.
    counts.set(guildId, 80);
    await guilds.recordMemberCountSample(guildId, 80, { at: now, authoritative: true });
    await reconciler.runOnce();
    row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('trial');
    expect(notifier.ofKind('reactivated')).toHaveLength(1);

    // The audit trail recorded every transition atomically.
    const events = await env.handle.pool.query<{
      from_status: string;
      to_status: string;
      reason: string | null;
    }>('SELECT from_status, to_status, reason FROM guild_auth_events WHERE guild_id = $1', [
      guildId,
    ]);
    const transitions = events.rows.map((e) => `${e.from_status}->${e.to_status}:${e.reason}`);
    expect(transitions).toContain('trial->grace:trial_expired');
    expect(transitions).toContain('grace->expired:grace_elapsed');
  });

  it('defers a validated transition when the authoritative read is unavailable, and corrects discrepancies', async () => {
    const guildId = 'validate-1';
    const now = new Date('2026-07-04T12:00:00.000Z');
    const counts = new Map<string, number>();
    const { reconciler, notifier } = makeReconciler({ now: () => now, counts });

    await ensureGuild(guildId);
    await guilds.recordMemberCountSample(guildId, 500, { at: now });
    await guilds.transitionAuth({
      guildId,
      toStatus: 'trial',
      expiresAt: new Date(now.getTime() - DAY_MS), // already lapsed
    });

    // No authoritative count available → the transition waits.
    await reconciler.runOnce();
    expect((await guilds.getOrThrow(guildId)).authStatus).toBe('trial');
    expect(notifier.ofKind('grace_started')).toHaveLength(0);

    // Authoritative says the guild is actually tiny → discrepancy logged,
    // corrected sample recorded, and the guild goes dormant instead of grace.
    counts.set(guildId, 60);
    await reconciler.runOnce();
    const row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('trial');
    expect(row.memberCount).toBe(60);
    const audit = await env.handle.pool.query<{ target: string | null }>(
      "SELECT target FROM ops_audit WHERE action = 'member_count.discrepancy' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0]?.target).toBe(guildId);
  });

  it('a failed delivery leaves the dedupe unrecorded so the next run retries', async () => {
    const guildId = 'retry-1';
    // Advanced between runs, because a failed delivery now backs the queue row
    // off rather than freeing it: the drain runs on every instance of the
    // fleet, so an instantly-reclaimable row is N retries an hour at Discord.
    let now = new Date('2026-07-04T12:00:00.000Z');
    const counts = new Map([[guildId, 500]]);
    const notifier = new RecordingNotifier();
    notifier.deliver = false;
    const { reconciler } = makeReconciler({ now: () => now, counts, notifier });

    await ensureGuild(guildId);
    // Backdate creation so the window reads as a year-long trial (long cadence).
    await env.handle.pool.query('UPDATE guilds SET created_at = $1 WHERE guild_id = $2', [
      new Date(now.getTime() - 345 * DAY_MS),
      guildId,
    ]);
    await guilds.recordMemberCountSample(guildId, 500, { at: now });
    await guilds.transitionAuth({
      guildId,
      toStatus: 'trial',
      expiresAt: new Date(now.getTime() + 20 * DAY_MS), // inside T−30
    });

    const hour = (): void => {
      now = new Date(now.getTime() + 60 * 60 * 1000);
    };

    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(1);
    // Not recorded → retried on the next pass.
    hour();
    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(2);

    notifier.deliver = true;
    hour();
    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(3);
    // Now recorded → no more repeats.
    hour();
    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(3);
    const meta = parseBillingMeta((await guilds.getOrThrow(guildId)).metadata);
    expect(Object.keys(meta.notifications).some((k) => k.startsWith('trial_warning:30'))).toBe(
      true,
    );
  });

  it('backfills a grown guild with the YEAR window, never the 14-day clock (§3)', async () => {
    const guildId = 'backfill-grown-1';
    const now = new Date('2026-07-04T12:00:00.000Z');
    const { reconciler } = makeReconciler({ now: () => now, counts: new Map() });

    await ensureGuild(guildId);
    // Added ~6 months ago at an unknown size; now sampled at 12k members.
    await env.handle.pool.query('UPDATE guilds SET created_at = $1 WHERE guild_id = $2', [
      new Date(now.getTime() - 180 * DAY_MS),
      guildId,
    ]);
    await guilds.recordMemberCountSample(guildId, 12_000, { at: now });

    await reconciler.runOnce();
    const row = await guilds.getOrThrow(guildId);
    expect(row.authStatus).toBe('trial'); // NOT dropped into grace
    expect(row.authExpiresAt).toEqual(new Date(row.createdAt.getTime() + 365 * DAY_MS));
  });

  it('retries an undelivered hard-gate notice on later runs (one-time, but never zero-time)', async () => {
    const guildId = 'hardgate-retry-1';
    let now = new Date('2026-07-04T12:00:00.000Z');
    const counts = new Map([[guildId, 500]]);
    const notifier = new RecordingNotifier();
    const { reconciler } = makeReconciler({ now: () => now, counts, notifier });

    await ensureGuild(guildId);
    await guilds.recordMemberCountSample(guildId, 500, { at: now });
    await guilds.transitionAuth({
      guildId,
      toStatus: 'grace',
      graceUntil: new Date(now.getTime() - DAY_MS), // grace already elapsed
    });
    // Evidence the guild walked the ladder (so the re-emit path applies).
    await guilds.recordBillingNotification(guildId, 'grace_nudge', now);

    notifier.deliver = false;
    await reconciler.runOnce();
    expect((await guilds.getOrThrow(guildId)).authStatus).toBe('expired');
    expect(notifier.ofKind('hard_gate')).toHaveLength(1); // attempted, failed

    // Next run: still undelivered → re-emitted; then delivery succeeds → once.
    now = new Date(now.getTime() + 60 * 60 * 1000);
    await reconciler.runOnce();
    expect(notifier.ofKind('hard_gate')).toHaveLength(2);
    notifier.deliver = true;
    now = new Date(now.getTime() + 60 * 60 * 1000);
    await reconciler.runOnce();
    expect(notifier.ofKind('hard_gate')).toHaveLength(3);
    now = new Date(now.getTime() + 60 * 60 * 1000);
    await reconciler.runOnce();
    expect(notifier.ofKind('hard_gate')).toHaveLength(3); // recorded → done
  });

  it('samples cached guild counts once per day and respects the kill switches', async () => {
    const guildId = 'sample-1';
    const now = new Date('2026-07-04T12:00:00.000Z');
    const { reconciler } = makeReconciler({
      now: () => now,
      cached: [{ guildId, memberCount: 250 }],
    });

    await flags.set('billing.reconcile_disabled', true, { actor: 'test' });
    await reconciler.runOnce();
    expect((await guilds.get(guildId))?.memberCount ?? null).toBeNull();

    await flags.set('billing.reconcile_disabled', false, { actor: 'test' });
    await reconciler.runOnce();
    expect((await guilds.getOrThrow(guildId)).memberCount).toBe(250);
    expect(reconciler.stats.sampled).toBe(1);
    // Second tick the same day skips re-sampling.
    await reconciler.runOnce();
    expect(reconciler.stats.sampled).toBe(1);
  });
  /**
   * The ladder/delivery split (`plans/fleets.md` §4).
   *
   * The advance pass is a cluster singleton across BOTH fleets, so the fleet
   * that transitions a guild may not be in it. Before the split, delivery ran
   * inside that singleton walk, which meant a guild advanced by the wrong fleet
   * was never told anything: no error, no retry, no trace.
   */
  describe('the ladder advances once, and each fleet delivers only its own', () => {
    /** A guild about to lapse, ready for one warning. */
    async function warnableGuild(guildId: string, now: Date): Promise<void> {
      await guilds.ensure(guildId);
      await env.handle.pool.query('UPDATE guilds SET created_at = $1 WHERE guild_id = $2', [
        new Date(now.getTime() - 345 * DAY_MS),
        guildId,
      ]);
      await guilds.recordMemberCountSample(guildId, 500, { at: now });
      await guilds.transitionAuth({
        guildId,
        toStatus: 'trial',
        expiresAt: new Date(now.getTime() + 20 * DAY_MS), // inside T-30
      });
    }

    it('queues on the advancing fleet and delivers on the one that is present', async () => {
      const guildId = 'split-beta-only';
      const now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      // Only beta is in this guild. Prod advances the ladder anyway.
      await new GuildFleetPresenceRepository(env.handle.db, 'beta').markPresent(guildId);

      const prod = makeReconciler({ now: () => now, counts, fleet: 'prod' });
      await prod.reconciler.runOnce();

      // Prod queued the warning and sent nothing. Scoped to this guild: the
      // advance pass walks every guild in the shared test database, so a
      // fleet-wide counter here would be coupled to every test above it.
      expect(prod.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(0);
      expect(prod.reconciler.stats.notificationsSent).toBe(0);
      expect(await pendingFor(guildId)).toBe(1);

      // Beta, which is in the guild, picks it up on its own tick.
      const beta = makeReconciler({ now: () => now, counts, fleet: 'beta' });
      await beta.reconciler.runOnce();
      expect(beta.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(1);
      expect(beta.reconciler.stats.notificationsSent).toBe(1);

      // And the dedupe stamp landed, so nobody sends it twice.
      const meta = parseBillingMeta((await guilds.getOrThrow(guildId)).metadata);
      expect(Object.keys(meta.notifications).some((k) => k.startsWith('trial_warning:30'))).toBe(
        true,
      );
      await prod.reconciler.runOnce();
      await beta.reconciler.runOnce();
      expect(beta.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(1);
    });

    /**
     * The regression that motivated all of this. Same setup, but with delivery
     * riding along inside the advance pass the guild hears nothing at all,
     * because prod cannot message a guild it is not in.
     */
    it('does not lose a notification when the advancing fleet is absent', async () => {
      const guildId = 'split-not-lost';
      const now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      await new GuildFleetPresenceRepository(env.handle.db, 'beta').markPresent(guildId);

      const prod = makeReconciler({ now: () => now, counts, fleet: 'prod' });
      await prod.reconciler.runOnce();
      await prod.reconciler.runOnce();
      await prod.reconciler.runOnce();
      expect(prod.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(0);

      // Still queued after three passes that could not deliver it, not dropped.
      const beta = makeReconciler({ now: () => now, counts, fleet: 'beta' });
      await beta.reconciler.runOnce();
      expect(beta.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(1);
    });

    /**
     * Two instances of one fleet, ticking one after the other.
     *
     * Deliberately NOT the concurrency test: this runs them sequentially, so
     * what it proves is that a delivered row plus its dedupe stamp keep the
     * second instance from re-sending. The genuinely concurrent case, and the
     * claim lease that covers a second claim moments later, are both in
     * `billingNotifications.integration.test.ts` where they can be driven
     * against the queue directly.
     */
    it('does not re-send once another instance has delivered', async () => {
      const guildId = 'split-concurrent';
      const now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      await presence.markPresent(guildId);

      const a = makeReconciler({ now: () => now, counts });
      await a.reconciler.runOnce();
      expect(a.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(1);

      // A second instance now finds nothing left to send.
      const b = makeReconciler({ now: () => now, counts });
      await b.reconciler.runOnce();
      expect(b.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(0);
    });

    /**
     * A guild no fleet is in. The notice cannot be delivered by anyone, so it
     * expires rather than accumulating, and the giving-up is audited: a guild
     * that silently never heard it was about to be gated is the failure the
     * whole queue exists to prevent.
     */
    it('expires an undeliverable notice and records that it gave up', async () => {
      const guildId = 'split-nobody-home';
      let now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      // No presence row for any fleet.

      const prod = makeReconciler({ now: () => now, counts, fleet: 'prod' });
      await prod.reconciler.runOnce();
      expect(await pendingFor(guildId)).toBe(1);
      expect(prod.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(0);

      now = new Date(now.getTime() + 5 * DAY_MS);
      await prod.reconciler.runOnce();
      expect(await pendingFor(guildId)).toBe(0);

      /**
       * No audit row, on purpose.
       *
       * Nobody ever claimed it, so this is a presence fact rather than a
       * delivery failure, and it repeats every TTL for as long as the guild
       * stays unreachable. Auditing it would fill `v_recent_ops` and the admin
       * activity feed with one row per unreachable guild, permanently. The
       * warn log and the `notificationsExpired` counter carry it instead.
       */
      const audit = await env.handle.pool.query<{ target: string | null }>(
        "SELECT target FROM ops_audit WHERE action = 'billing.notification.expired' AND target = $1",
        [guildId],
      );
      expect(audit.rows).toHaveLength(0);
      expect(prod.reconciler.stats.notificationsExpired).toBeGreaterThan(0);
    });

    /**
     * The other half of the same rule: an expiry that WAS attempted is a real
     * delivery failure and must still be audited.
     */
    it('audits an expiry that a fleet actually tried and failed to deliver', async () => {
      const guildId = 'split-tried-and-failed';
      let now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      await presence.markPresent(guildId);

      const notifier = new RecordingNotifier();
      notifier.deliver = false; // in the guild, but cannot post
      const prod = makeReconciler({ now: () => now, counts, notifier });
      await prod.reconciler.runOnce();
      expect(notifier.forGuild(guildId, 'trial_warning')).toHaveLength(1);

      now = new Date(now.getTime() + 5 * DAY_MS);
      await prod.reconciler.runOnce();

      const audit = await env.handle.pool.query<{ details: { attempts?: number } }>(
        "SELECT details FROM ops_audit WHERE action = 'billing.notification.expired' AND target = $1",
        [guildId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.details.attempts).toBeGreaterThan(0);
    });

    /**
     * A guild whose notification was delivered by something outside the queue,
     * which is what a fleet on a pre-split build does: it sends inline and
     * stamps the dedupe key, knowing nothing about this table. The row it did
     * not enqueue must not then be sent a second time.
     */
    it('does not re-send a notification an older build already delivered', async () => {
      const guildId = 'split-stamped-elsewhere';
      let now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      await presence.markPresent(guildId);

      // Queue it, then stamp the key as though another build had sent it.
      const first = makeReconciler({ now: () => now, counts, notifier: silentNotifier() });
      await first.reconciler.runOnce();
      const key = (
        await env.handle.pool.query<{ key: string }>(
          'SELECT key FROM billing_notifications WHERE guild_id = $1 LIMIT 1',
          [guildId],
        )
      ).rows[0]?.key;
      expect(key).toBeDefined();
      await guilds.recordBillingNotification(guildId, key!, now);

      // Past the failed-delivery back-off, so the row is claimable again.
      now = new Date(now.getTime() + 60 * 60 * 1000);
      const second = makeReconciler({ now: () => now, counts });
      await second.reconciler.runOnce();
      expect(second.notifier.forGuild(guildId, 'trial_warning')).toHaveLength(0);
      expect(await pendingFor(guildId)).toBe(0);
    });

    /** The fleet-level opt-out: no advancing, but still delivering. */
    it('stops advancing on a fleet with billing.advance_disabled, and still delivers', async () => {
      const guildId = 'split-advance-disabled';
      const now = new Date('2026-07-04T12:00:00.000Z');
      const counts = new Map([[guildId, 500]]);
      await warnableGuild(guildId, now);
      await presence.markPresent(guildId);

      await flags.set('billing.advance_disabled', true, { actor: 'test' });
      try {
        const off = makeReconciler({ now: () => now, counts });
        await off.reconciler.runOnce();
        // Nothing advanced, so nothing queued.
        expect(await pendingFor(guildId)).toBe(0);

        // A row queued by the other fleet is still delivered by this one.
        await notifications.enqueue(
          guildId,
          { key: 'hard_gate', kind: 'hard_gate' } as LeniencyNotification,
          500,
          { at: now },
        );
        const deliverer = makeReconciler({ now: () => now, counts });
        await deliverer.reconciler.runOnce();
        expect(deliverer.notifier.forGuild(guildId, 'hard_gate')).toHaveLength(1);
      } finally {
        await flags.set('billing.advance_disabled', false, { actor: 'test' });
      }
    });
  });
});
