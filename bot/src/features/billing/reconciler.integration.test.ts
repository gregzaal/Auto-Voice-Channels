import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BillingRunRepository,
  GuildRepository,
  OpsAuditRepository,
  parseBillingMeta,
  RuntimeFlagsRepository,
  SubscriptionRepository,
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
}

describe('BillingReconciler (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let flags: RuntimeFlagsRepository;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    flags = new RuntimeFlagsRepository(env.handle.db);
    // Migration 0007 seeds the job disabled (rolling-deploy safety for the
    // `grace` enum expansion); these tests exercise the enabled behavior.
    await flags.set('billing.reconcile_disabled', false, { actor: 'test' });
  });

  afterAll(async () => {
    await env?.stop();
  });

  function makeReconciler(opts: {
    now: () => Date;
    counts?: Map<string, number>;
    cached?: { guildId: string; memberCount: number }[];
    notifier?: RecordingNotifier;
  }) {
    const notifier = opts.notifier ?? new RecordingNotifier();
    const reconciler = new BillingReconciler({
      guilds,
      store: guilds, // raw repo satisfies GuildSettingsStore structurally
      subscriptions: new SubscriptionRepository(env.handle.db),
      runs: new BillingRunRepository(env.handle.db),
      flags,
      opsAudit: new OpsAuditRepository(env.handle.db),
      notifier,
      listCachedGuildCounts: () => opts.cached ?? [],
      fetchAuthoritativeCount: async (guildId) => opts.counts?.get(guildId) ?? null,
      logger: fakeLogger(),
      instanceId: 'test-instance',
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
    await guilds.ensure(guildId);
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

    await guilds.ensure(guildId);
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
    const now = new Date('2026-07-04T12:00:00.000Z');
    const counts = new Map([[guildId, 500]]);
    const notifier = new RecordingNotifier();
    notifier.deliver = false;
    const { reconciler } = makeReconciler({ now: () => now, counts, notifier });

    await guilds.ensure(guildId);
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

    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(1);
    // Not recorded → retried on the next pass.
    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(2);

    notifier.deliver = true;
    await reconciler.runOnce();
    expect(notifier.ofKind('trial_warning')).toHaveLength(3);
    // Now recorded → no more repeats.
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

    await guilds.ensure(guildId);
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

    await guilds.ensure(guildId);
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
});
