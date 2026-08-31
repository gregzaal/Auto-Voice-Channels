import { describe, expect, it } from 'vitest';
import type { MemberCountSample } from './billing.js';
import {
  DEFAULT_LENIENCY_CONFIG,
  evaluateLeniency,
  shouldGrantPoolExit,
  sustainedBreach,
  sustainedDrop,
  type LeniencyState,
} from './leniency.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-07-04T12:00:00.000Z');

function days(n: number): number {
  return n * DAY_MS;
}

function samplesAt(count: number, n: number, endDay = '2026-07-04'): MemberCountSample[] {
  const end = Date.parse(`${endDay}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    day: new Date(end - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10),
    count,
  }));
}

function state(overrides: Partial<LeniencyState>): LeniencyState {
  return {
    authStatus: 'trial',
    authExpiresAt: new Date(NOW.getTime() + days(200)),
    graceUntil: null,
    billedTier: null,
    hasSubscription: false,
    subscriptionOk: false,
    memberCount: 500,
    samples: samplesAt(500, 10),
    guildCreatedAt: new Date(NOW.getTime() - days(165)),
    notifications: {},
    ...overrides,
  };
}

describe('sustained windows (anti-flap)', () => {
  it('sustainedBreach needs n samples all at/above the ceiling', () => {
    expect(sustainedBreach(samplesAt(1_100, 7), 1_000, 7)).toBe(true);
    expect(sustainedBreach(samplesAt(1_100, 6), 1_000, 7)).toBe(false); // too few
    const dipped = [...samplesAt(1_100, 6), { day: '2026-07-05', count: 999 }];
    expect(sustainedBreach(dipped, 1_000, 7)).toBe(false); // one dip resets
  });

  it('sustainedDrop needs n samples all strictly below the ceiling', () => {
    expect(sustainedDrop(samplesAt(900, 30), 1_000, 30)).toBe(true);
    expect(sustainedDrop(samplesAt(900, 29), 1_000, 30)).toBe(false);
  });
});

describe('evaluateLeniency — trial', () => {
  it('does nothing mid-trial with no warning due', () => {
    const decision = evaluateLeniency(state({}), NOW);
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });

  it('free-forever guilds are dormant even past the window date', () => {
    const decision = evaluateLeniency(
      state({
        memberCount: 50,
        samples: samplesAt(50, 10),
        authExpiresAt: new Date(NOW.getTime() - days(30)),
      }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });

  it('fires the T−30 warning once, keyed to the window', () => {
    const expiresAt = new Date(NOW.getTime() + days(25));
    const fresh = evaluateLeniency(state({ authExpiresAt: expiresAt }), NOW);
    expect(fresh.notifications).toHaveLength(1);
    expect(fresh.notifications[0]).toMatchObject({ kind: 'trial_warning', daysLeft: 25 });
    const key = fresh.notifications[0]!.key;

    const repeat = evaluateLeniency(
      state({ authExpiresAt: expiresAt, notifications: { [key]: NOW.toISOString() } }),
      NOW,
    );
    expect(repeat.notifications).toEqual([]);
  });

  it('sends only the most imminent unsent warning (no burst after downtime)', () => {
    const expiresAt = new Date(NOW.getTime() + days(2)); // inside T−30 AND T−7
    const decision = evaluateLeniency(state({ authExpiresAt: expiresAt }), NOW);
    expect(decision.notifications).toHaveLength(1);
    expect(decision.notifications[0]!.key).toContain('trial_warning:7:');
  });

  it('uses the compressed cadence for 14-day trials', () => {
    const createdAt = new Date(NOW.getTime() - days(8));
    const expiresAt = new Date(createdAt.getTime() + days(14)); // 6 days left
    const decision = evaluateLeniency(
      state({
        guildCreatedAt: createdAt,
        authExpiresAt: expiresAt,
        memberCount: 20_000,
        samples: samplesAt(20_000, 8),
      }),
      NOW,
    );
    expect(decision.notifications).toHaveLength(1);
    // 6 days left → the short set's 7-day offset window.
    expect(decision.notifications[0]!.key).toContain('trial_warning:7:');
  });

  it('expiry → grace with a fresh 60-day window and a grace_started notice', () => {
    const expiresAt = new Date(NOW.getTime() - days(1));
    const decision = evaluateLeniency(state({ authExpiresAt: expiresAt }), NOW);
    expect(decision.transition).toMatchObject({
      toStatus: 'grace',
      reason: 'trial_expired',
      requiresCountValidation: true,
    });
    expect(decision.transition!.graceUntil!.getTime()).toBe(NOW.getTime() + days(60));
    expect(decision.notifications[0]).toMatchObject({ kind: 'grace_started', daysLeft: 60 });
  });

  it('growing into XXL during a trial notifies once but never cuts off', () => {
    const s = state({
      memberCount: 1_200_000,
      samples: samplesAt(1_200_000, 7),
    });
    const first = evaluateLeniency(s, NOW);
    expect(first.transition).toBeUndefined();
    expect(first.notifications[0]).toMatchObject({ kind: 'grew_into_xxl' });

    const repeat = evaluateLeniency(
      { ...s, notifications: { grew_into_xxl: NOW.toISOString() } },
      NOW,
    );
    expect(repeat.notifications).toEqual([]);
  });

  it('does nothing without a trial window (job backfills first)', () => {
    const decision = evaluateLeniency(state({ authExpiresAt: null }), NOW);
    expect(decision.transition).toBeUndefined();
  });
});

describe('evaluateLeniency — active (over-limit)', () => {
  it('starts the grace clock only after a sustained breach', () => {
    const base = state({ authStatus: 'active', billedTier: 'm', subscriptionOk: true });

    // 6 breaching days — not yet.
    const early = evaluateLeniency(
      { ...base, memberCount: 12_000, samples: samplesAt(12_000, 6) },
      NOW,
    );
    expect(early.transition).toBeUndefined();

    // 7 breaching days — grace starts.
    const due = evaluateLeniency(
      { ...base, memberCount: 12_000, samples: samplesAt(12_000, 7) },
      NOW,
    );
    expect(due.transition).toMatchObject({
      toStatus: 'grace',
      reason: 'over_limit',
      requiresCountValidation: true,
    });
    expect(due.notifications[0]).toMatchObject({
      kind: 'grace_started',
      reason: 'over_limit',
      requiredTier: 'l',
    });
  });

  it('a raid spike (one day) never triggers billing changes', () => {
    const spiky = [...samplesAt(9_000, 6), { day: '2026-07-04', count: 12_000 }];
    const decision = evaluateLeniency(
      state({ authStatus: 'active', billedTier: 'm', memberCount: 12_000, samples: spiky }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
  });

  it('voluntary over-provisioning is never corrected', () => {
    // A 50-member guild paying for XL: required < billed → nothing happens.
    const decision = evaluateLeniency(
      state({
        authStatus: 'active',
        billedTier: 'xl',
        subscriptionOk: true,
        memberCount: 50,
        samples: samplesAt(50, 40),
      }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });
});

describe('evaluateLeniency — active (dunning backstop)', () => {
  const paying = {
    authStatus: 'active' as const,
    billedTier: 'm' as const,
    hasSubscription: true,
    subscriptionOk: true,
  };

  it('converges to grace when a subscription stopped paying and the webhook was missed', () => {
    const decision = evaluateLeniency(state({ ...paying, subscriptionOk: false }), NOW);
    expect(decision.transition).toMatchObject({
      toStatus: 'grace',
      reason: 'subscription_lapsed',
      graceUntil: new Date(NOW.getTime() + days(60)),
    });
    expect(decision.notifications[0]).toMatchObject({
      kind: 'grace_started',
      reason: 'subscription_lapsed',
      daysLeft: 60,
    });
  });

  it('leaves a healthy subscription alone', () => {
    expect(evaluateLeniency(state(paying), NOW).transition).toBeUndefined();
  });

  it('never mistakes a manually arranged guild (no Paddle row) for a failed payment', () => {
    // An XXL guild on a bespoke deal is entitled by agreement: a billed tier
    // with no subscription behind it must not trip the backstop.
    const decision = evaluateLeniency(
      state({
        authStatus: 'active',
        billedTier: 'xxl',
        hasSubscription: false,
        subscriptionOk: false,
        memberCount: 2_000_000,
        samples: samplesAt(2_000_000, 40),
      }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });

  it('re-emits the dunning grace notice until it lands', () => {
    const decision = evaluateLeniency(
      state({
        ...paying,
        subscriptionOk: false,
        authStatus: 'grace',
        graceUntil: new Date(NOW.getTime() + days(30)),
        authExpiresAt: new Date(NOW.getTime() + days(200)),
      }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications[0]).toMatchObject({
      kind: 'grace_started',
      key: 'grace_started:subscription_lapsed',
      reason: 'subscription_lapsed',
    });
  });
});

describe('evaluateLeniency — grace', () => {
  const GRACE_EXPIRY = new Date(NOW.getTime() - days(30));
  // The grace-entry notice's dedupe key (recorded once it was delivered).
  const GRACE_STARTED_KEY = `grace_started:trial_expired:${GRACE_EXPIRY.toISOString()}`;
  const delivered = { [GRACE_STARTED_KEY]: NOW.toISOString() };
  const graceState = (overrides: Partial<LeniencyState>) =>
    state({
      authStatus: 'grace',
      graceUntil: new Date(NOW.getTime() + days(30)),
      authExpiresAt: GRACE_EXPIRY,
      notifications: delivered,
      ...overrides,
    });

  it('re-emits the grace-entry notice until it has been delivered', () => {
    const undeliveredEntry = evaluateLeniency(graceState({ notifications: {} }), NOW);
    expect(undeliveredEntry.transition).toBeUndefined();
    expect(undeliveredEntry.notifications[0]).toMatchObject({
      kind: 'grace_started',
      key: GRACE_STARTED_KEY,
      reason: 'trial_expired',
    });
  });

  it('stays fully working mid-grace, nudging weekly', () => {
    const first = evaluateLeniency(graceState({}), NOW);
    expect(first.transition).toBeUndefined();
    expect(first.notifications[0]).toMatchObject({ kind: 'grace_nudge', daysLeft: 30 });

    const nudgedRecently = evaluateLeniency(
      graceState({
        notifications: {
          ...delivered,
          grace_nudge: new Date(NOW.getTime() - days(3)).toISOString(),
        },
      }),
      NOW,
    );
    expect(nudgedRecently.notifications).toEqual([]);

    const nudgeDue = evaluateLeniency(
      graceState({
        notifications: {
          ...delivered,
          grace_nudge: new Date(NOW.getTime() - days(8)).toISOString(),
        },
      }),
      NOW,
    );
    expect(nudgeDue.notifications[0]).toMatchObject({ kind: 'grace_nudge' });
  });

  it('grace elapsed → expired with a one-time hard-gate notice', () => {
    const graceUntil = new Date(NOW.getTime() - days(1));
    const decision = evaluateLeniency(graceState({ graceUntil }), NOW);
    expect(decision.transition).toMatchObject({ toStatus: 'expired', reason: 'grace_elapsed' });
    expect(decision.notifications[0]).toMatchObject({ kind: 'hard_gate' });
  });

  it('hardGateDisabled (beta lever) holds guilds in grace', () => {
    const decision = evaluateLeniency(
      graceState({ graceUntil: new Date(NOW.getTime() - days(1)) }),
      NOW,
      { ...DEFAULT_LENIENCY_CONFIG, hardGateDisabled: true },
    );
    expect(decision.transition).toBeUndefined();
  });

  it('shrinking under 100 members reactivates — after a SUSTAINED drop', () => {
    // A short dip is not enough (§4 hysteresis)…
    const brief = evaluateLeniency(graceState({ memberCount: 80, samples: samplesAt(80, 3) }), NOW);
    expect(brief.transition).toBeUndefined();
    // …a sustained one is.
    const sustained = evaluateLeniency(
      graceState({ memberCount: 80, samples: samplesAt(80, 30) }),
      NOW,
    );
    expect(sustained.transition).toMatchObject({ toStatus: 'trial', reason: 'shrunk_to_free' });
    expect(sustained.notifications[0]).toMatchObject({ kind: 'reactivated' });
  });

  it('a one-day dip below the billed ceiling never resets the grace clock (anti-flap)', () => {
    // In over-limit grace on tier m (ceiling 10k); one day dips under.
    const dipped = [...samplesAt(10_500, 20, '2026-07-03'), { day: '2026-07-04', count: 9_900 }];
    const decision = evaluateLeniency(
      graceState({
        billedTier: 'm',
        subscriptionOk: true,
        memberCount: 9_900,
        samples: dipped,
        authExpiresAt: null,
        notifications: { 'grace_started:over_limit:l': NOW.toISOString() },
      }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
  });

  it('a subscription covering the size reactivates to active', () => {
    const decision = evaluateLeniency(
      graceState({ billedTier: 'l', subscriptionOk: true, memberCount: 12_000 }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'active' });
  });

  it('a dunning subscription does NOT reactivate just because size fits', () => {
    const decision = evaluateLeniency(
      graceState({ billedTier: 'l', subscriptionOk: false, memberCount: 12_000 }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
  });

  it('backfills a missing grace window instead of gating', () => {
    const decision = evaluateLeniency(graceState({ graceUntil: null }), NOW);
    expect(decision.transition).toMatchObject({ toStatus: 'grace', reason: 'grace_backfill' });
    expect(decision.transition!.graceUntil).toEqual(new Date(NOW.getTime() + days(60)));
  });
});

describe('evaluateLeniency — expired (reactivation)', () => {
  it('shrinking under the free line restores service', () => {
    const decision = evaluateLeniency(
      state({ authStatus: 'expired', memberCount: 42, samples: samplesAt(42, 2) }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'trial', reason: 'shrunk_to_free' });
  });

  it('a good-standing subscription reactivates to active', () => {
    const decision = evaluateLeniency(
      state({ authStatus: 'expired', billedTier: 'm', subscriptionOk: true, memberCount: 5_000 }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'active', reason: 'resubscribed' });
  });

  it('re-emits the one-time hard-gate notice until delivered — but only for ladder guilds', () => {
    // Walked the ladder (grace evidence) but the hard-gate notice never landed.
    const undelivered = evaluateLeniency(
      state({
        authStatus: 'expired',
        notifications: { grace_nudge: NOW.toISOString() },
      }),
      NOW,
    );
    expect(undelivered.transition).toBeUndefined();
    expect(undelivered.notifications[0]).toMatchObject({ kind: 'hard_gate', key: 'hard_gate' });

    // Once delivered, never again.
    const deliveredAlready = evaluateLeniency(
      state({
        authStatus: 'expired',
        notifications: { grace_nudge: NOW.toISOString(), hard_gate: NOW.toISOString() },
      }),
      NOW,
    );
    expect(deliveredAlready.notifications).toEqual([]);
  });

  it('otherwise stays expired with no repeat notifications', () => {
    // No grace evidence (e.g. hard-gated at join): no "grace ended" notice.
    const decision = evaluateLeniency(state({ authStatus: 'expired' }), NOW);
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });
});

describe('evaluateLeniency — expired pool does not reactivate itself (refunds.md §2.5)', () => {
  /**
   * A pool always sets `pooledMemberCount`, and `requiredTierOf` reads it
   * first, so an expired pool whose billable set empties for one tick lands in
   * the free-forever branch. `advancePool` maps `trial` to `active` for pools,
   * so it promoted itself back to entitling on a refunded subscription and
   * announced a reactivation to every member.
   */
  const poolState = (overrides: Partial<LeniencyState>): LeniencyState =>
    state({
      authStatus: 'expired',
      authExpiresAt: null,
      memberCount: null,
      pooledMemberCount: 0,
      billedTier: 'm',
      guildCreatedAt: null,
      samples: [],
      ...overrides,
    });

  it('does nothing when the subscription is not in good standing', () => {
    const decision = evaluateLeniency(
      poolState({ hasSubscription: true, subscriptionOk: false }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });

  it('still reactivates when the subscription IS in good standing', () => {
    const decision = evaluateLeniency(
      poolState({ hasSubscription: true, subscriptionOk: true }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'trial', reason: 'shrunk_to_free' });
  });

  it('still reactivates a pool with no subscription row at all', () => {
    // A bespoke arrangement is entitled by agreement with no Paddle row, and
    // must never be read as a failed payment.
    const decision = evaluateLeniency(
      poolState({ hasSubscription: false, subscriptionOk: false }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'trial', reason: 'shrunk_to_free' });
  });

  it('leaves the per-guild free-forever promise alone, whatever the subscription is doing', () => {
    // The guild axis has no `pooledMemberCount`. `/docs/billing` promises a
    // sub-100 server is free forever "whether or not it shares a
    // subscription", so this branch must keep firing for a real shrink.
    const decision = evaluateLeniency(
      state({
        authStatus: 'expired',
        memberCount: 42,
        samples: samplesAt(42, 2),
        billedTier: 'm',
        hasSubscription: true,
        subscriptionOk: false,
      }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'trial', reason: 'shrunk_to_free' });
  });
});

describe('evaluateLeniency — blocked', () => {
  it('the kill-switch outranks billing entirely', () => {
    const decision = evaluateLeniency(
      state({ authStatus: 'blocked', authExpiresAt: new Date(NOW.getTime() - days(400)) }),
      NOW,
    );
    expect(decision.transition).toBeUndefined();
    expect(decision.notifications).toEqual([]);
  });
});

describe('pooledMemberCount (member-based-pricing.md §5.2)', () => {
  it('requiredTierOf prefers pooledMemberCount over memberCount when present', () => {
    // A tiny guild's own count (50, free) would never breach anything on its
    // own — only the pool's aggregate should decide the required tier.
    const decision = evaluateLeniency(
      state({
        authStatus: 'active',
        billedTier: 's',
        memberCount: 50,
        pooledMemberCount: 12_000,
        samples: samplesAt(12_000, 7),
      }),
      NOW,
    );
    expect(decision.transition).toMatchObject({ toStatus: 'grace', reason: 'over_limit' });
    expect(decision.notifications[0]).toMatchObject({ requiredTier: 'l' });
  });

  it('over-limit still fires for a pool that grew, exactly like a guild would', () => {
    // Regression for the first-draft defect (§5.1, §12 #1): if the pool pass
    // ever collapsed required and billed tier onto the same source, this can
    // never be true and a pool could grow unboundedly on its starting tier.
    const decision = evaluateLeniency(
      state({
        authStatus: 'active',
        billedTier: 'm',
        pooledMemberCount: 15_000,
        samples: samplesAt(15_000, 7),
      }),
      NOW,
    );
    expect(decision.transition).toBeDefined();
    expect(decision.transition?.reason).toBe('over_limit');
  });

  it('falls back to memberCount when pooledMemberCount is null or absent (ordinary guilds unaffected)', () => {
    const withNull = evaluateLeniency(
      state({
        authStatus: 'active',
        billedTier: 's',
        memberCount: 1_200,
        pooledMemberCount: null,
        samples: samplesAt(1_200, 7),
      }),
      NOW,
    );
    const withoutField = evaluateLeniency(
      state({
        authStatus: 'active',
        billedTier: 's',
        memberCount: 1_200,
        samples: samplesAt(1_200, 7),
      }),
      NOW,
    );
    expect(withNull.transition).toEqual(withoutField.transition);
    expect(withNull.transition).toMatchObject({ reason: 'over_limit' });
  });

  it('a pool-scoped state can reach grace, expired and reactivate through the same machine', () => {
    // The pool pass builds one virtual LeniencyState per pool (member_pools has
    // no trial, so it only ever visits active/grace/expired) — assert the
    // machine it already trusted for guilds behaves identically for that shape.
    const hardGated = evaluateLeniency(
      {
        authStatus: 'grace',
        authExpiresAt: null,
        graceUntil: new Date(NOW.getTime() - days(1)),
        billedTier: 'm',
        hasSubscription: true,
        subscriptionOk: true,
        memberCount: null,
        pooledMemberCount: 15_000,
        samples: [],
        guildCreatedAt: null,
        notifications: {},
      },
      NOW,
    );
    expect(hardGated.transition).toMatchObject({ toStatus: 'expired', reason: 'grace_elapsed' });
  });
});

describe('shouldGrantPoolExit (refunds.md §2.3)', () => {
  const active = { status: 'active' };
  const expired = { status: 'expired' };

  it('grants on the ordinary path: healthy subscription, guild not already in grace', () => {
    expect(shouldGrantPoolExit({ authStatus: 'active', graceUntil: null }, active, NOW)).toBe(true);
  });

  it('refuses on a subscription that cannot entitle anything', () => {
    // Buy, refund, empty the subscription: every server used to land entitled
    // for a fresh 60 days, and under hard_gate_disabled that never closes.
    expect(shouldGrantPoolExit({ authStatus: 'expired', graceUntil: null }, expired, NOW)).toBe(
      false,
    );
    expect(shouldGrantPoolExit({ authStatus: 'active', graceUntil: null }, expired, NOW)).toBe(
      false,
    );
  });

  it('never extends a grace window that is already open', () => {
    // The farm: add, remove, bank 60 days, re-add, repeat every 59 days.
    const open = { authStatus: 'grace' as const, graceUntil: new Date(NOW.getTime() + days(30)) };
    expect(shouldGrantPoolExit(open, active, NOW)).toBe(false);
  });

  it('does grant when a grace window has already elapsed', () => {
    const spent = { authStatus: 'grace' as const, graceUntil: new Date(NOW.getTime() - days(1)) };
    expect(shouldGrantPoolExit(spent, active, NOW)).toBe(true);
  });

  it('grants to a guild in grace with no recorded deadline, which is a backfill not an extension', () => {
    expect(shouldGrantPoolExit({ authStatus: 'grace', graceUntil: null }, active, NOW)).toBe(true);
  });

  it('never touches a blocked guild', () => {
    expect(shouldGrantPoolExit({ authStatus: 'blocked', graceUntil: null }, active, NOW)).toBe(
      false,
    );
  });

  it('still grants when the pool cannot be read, which is deliberate', () => {
    // A pool we cannot read is not the same as one we know has expired. The
    // guild is losing its subscription either way, and stranding it un-entitled
    // on missing data is the worse failure direction. Asserted rather than
    // left implicit, so the choice is visible if it ever needs revisiting.
    expect(shouldGrantPoolExit({ authStatus: 'active', graceUntil: null }, null, NOW)).toBe(true);
  });
});
