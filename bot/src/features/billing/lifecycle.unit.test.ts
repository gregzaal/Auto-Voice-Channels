import { describe, expect, it } from 'vitest';
import type { AuthStatus, GuildRow, LeniencyNotification } from '@avc/core';
import { formatPlan } from '../../commands/setupPanel.js';
import { decideOnboarding } from './onboarding.js';
import {
  expiredInteractionMessage,
  gatedCreatorChannelNotice,
  notificationMessage,
  onboardingMessage,
} from './messages.js';

/**
 * Journey tests: one guild walked through its whole life, with EVERY
 * user-facing surface checked at every step.
 *
 * Why this file exists. The same bug has now shipped three times, always in
 * the same shape: a message picked from one dimension while ignoring another.
 *
 *   - A paying server was re-added and DM'd "your 1-year free trial just
 *     started", because the welcome was chosen from member count alone.
 *   - A lapsed subscriber's `/setup` said "your free trial has lapsed",
 *     because `formatPlan` had no `grace` branch and fell through to trial copy.
 *   - A blocked server under 100 members was told "Free forever, enjoy!",
 *     because the tier check ran before the status check.
 *
 * Every one of them passed the per-function unit tests, because each function
 * was correct about the dimension it looked at. They were only wrong in
 * combination, at a transition. So this walks the transitions and asserts a
 * CONTRACT at each stop, rather than exact strings: contracts survive copy
 * edits, exact strings do not, and a test nobody can edit safely gets deleted.
 */

const NOW = new Date('2026-07-04T12:00:00.000Z');
const DAY = 86_400_000;
const GUILD = '462606582367125509';

function row(over: Partial<GuildRow> = {}): GuildRow {
  return {
    guildId: GUILD,
    authStatus: 'trial',
    authExpiresAt: null,
    graceUntil: null,
    botRemovedAt: null,
    memberCount: null,
    memberCountUpdatedAt: null,
    tier: null,
    settings: {},
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** Phrases that are a lie in a given state, whichever surface says them. */
const FORBIDDEN: Record<AuthStatus, RegExp[]> = {
  // A trial guild is the one state where trial wording is honest.
  trial: [/subscription has ended/i, /is paused/i, /blocked/i],
  // Paying. Any suggestion of a trial, or of service having stopped, is false.
  active: [/free trial/i, /trial just started/i, /is paused/i, /has ended/i, /blocked/i],
  // Still working, but winding down. Must not claim a trial is running, and
  // must not claim service has stopped.
  grace: [/trial just started/i, /free trial\b(?!.*(ended|lapsed))/i, /is paused/i],
  // Service has stopped. Must not claim anything is still running.
  expired: [/trial just started/i, /still works/i, /keeps working/i],
  // The abuse kill-switch. Never sell to, never congratulate.
  blocked: [/free trial/i, /free forever/i, /subscribed/i, /thanks for/i],
};

function assertHonest(state: AuthStatus, surface: string, text: string): void {
  for (const pattern of FORBIDDEN[state]) {
    expect(text, `${state} / ${surface} said something false: ${text}`).not.toMatch(pattern);
  }
}

/** The plan line shown by `/setup`, for a guild in a given state. */
function planLine(state: AuthStatus, memberCount: number, over: Partial<GuildRow> = {}): string {
  const r = row({ authStatus: state, ...over });
  return formatPlan({
    guildId: GUILD,
    memberCount,
    status: state,
    expiresAt: r.authExpiresAt,
    graceUntil: r.graceUntil,
    selfHosted: false,
    now: NOW,
  });
}

describe('journey: add, subscribe, cancel, kick, re-add', () => {
  const MEMBERS = 6_605; // M tier, the Poly Haven case that produced two of these bugs.

  it('1. fresh add starts a trial and welcomes exactly once', () => {
    const fresh = row();
    const first = decideOnboarding(fresh, MEMBERS, NOW);
    expect(first.welcome).toBe(true);
    expect(first.policy).toBe('year');

    const msg = onboardingMessage(first.policy, MEMBERS, GUILD);
    expect(msg).toContain('1-year free trial');
    assertHonest('trial', 'onboardingMessage', msg);

    // Redelivered GUILD_CREATE (boot flood, reconnect): no second welcome.
    const again = decideOnboarding(
      row({ metadata: { billing: { onboardedAt: NOW.toISOString() } } }),
      MEMBERS,
      NOW,
    );
    expect(again.welcome).toBe(false);
  });

  it('2. during the trial, the plan line counts down honestly', () => {
    const line = planLine('trial', MEMBERS, { authExpiresAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(line).toContain('Free trial');
    assertHonest('trial', 'formatPlan', line);
  });

  it('3. after subscribing, nothing anywhere mentions a trial', () => {
    const line = planLine('active', MEMBERS);
    expect(line).toContain('Subscribed');
    assertHonest('active', 'formatPlan', line);

    // The regression that shipped: re-adding the bot must not restart the story.
    const readd = decideOnboarding(row({ authStatus: 'active' }), MEMBERS, NOW);
    expect(readd.welcome).toBe(false);
  });

  it('4. a kicked-then-re-added paying server is never welcomed as new', () => {
    const removed = row({ authStatus: 'active', botRemovedAt: new Date(NOW.getTime() - DAY) });
    expect(decideOnboarding(removed, MEMBERS, NOW).welcome).toBe(false);
    assertHonest('active', 'formatPlan', planLine('active', MEMBERS));
  });

  it('5. lapsing into grace never borrows trial-is-running wording', () => {
    const line = planLine('grace', MEMBERS, { graceUntil: new Date(NOW.getTime() + 20 * DAY) });
    expect(line).toContain('Grace period');
    expect(line).toContain('20 days left');
    assertHonest('grace', 'formatPlan', line);

    const notice = notificationMessage(
      { key: 'g', kind: 'grace_started', reason: 'subscription_lapsed', daysLeft: 60 },
      MEMBERS,
      GUILD,
    );
    assertHonest('grace', 'notificationMessage', notice);
  });

  it('6. expiry stops service, and every surface agrees it has stopped', () => {
    const line = planLine('expired', MEMBERS);
    assertHonest('expired', 'formatPlan', line);
    assertHonest('expired', 'expiredInteraction', expiredInteractionMessage(GUILD));
    assertHonest('expired', 'gatedCreatorChannel', gatedCreatorChannelNotice(GUILD));

    const notice = notificationMessage({ key: 'h', kind: 'hard_gate' }, MEMBERS, GUILD);
    assertHonest('expired', 'notificationMessage', notice);
  });

  it('7. reactivating returns to the paid story with no trial wording', () => {
    const line = planLine('active', MEMBERS);
    assertHonest('active', 'formatPlan', line);
    const notice = notificationMessage({ key: 'r', kind: 'reactivated' }, MEMBERS, GUILD);
    assertHonest('active', 'notificationMessage', notice);
  });
});

/**
 * The same contract applied exhaustively rather than along one path, so a new
 * size band or status cannot quietly skip it.
 */
describe('contract: every state, every size', () => {
  const STATES: AuthStatus[] = ['trial', 'active', 'grace', 'expired', 'blocked'];
  const SIZES = [50, 500, 6_605, 50_000, 2_000_000];

  it('the /setup plan line never contradicts the guild state', () => {
    for (const state of STATES) {
      for (const size of SIZES) {
        const line = planLine(state, size, {
          authExpiresAt: new Date(NOW.getTime() + 10 * DAY),
          graceUntil: new Date(NOW.getTime() + 10 * DAY),
        });
        assertHonest(state, `formatPlan(${size})`, line);
      }
    }
  });

  it('onboarding only ever fires, and only ever speaks, for a trial', () => {
    for (const state of STATES) {
      for (const size of SIZES) {
        const decision = decideOnboarding(row({ authStatus: state }), size, NOW);
        if (state !== 'trial') {
          expect(decision.welcome, `${state} @ ${size}`).toBe(false);
          continue;
        }
        expect(decision.welcome).toBe(true);
        assertHonest(
          state,
          `onboardingMessage(${size})`,
          onboardingMessage(decision.policy, size, GUILD),
        );
      }
    }
  });

  /**
   * The ladder's own notifications are emitted by a state machine that already
   * knows the state, so the risk here is not mis-selection but drift in the
   * copy itself. Every one is checked against the state it belongs to.
   */
  it('ladder notifications match the state that emits them', () => {
    const cases: [AuthStatus, LeniencyNotification][] = [
      ['trial', { key: 'a', kind: 'trial_warning', daysLeft: 7, requiredTier: 'm' }],
      ['grace', { key: 'b', kind: 'grace_started', reason: 'trial_expired', daysLeft: 60 }],
      ['grace', { key: 'c', kind: 'grace_started', reason: 'subscription_lapsed', daysLeft: 60 }],
      ['grace', { key: 'd', kind: 'grace_started', reason: 'over_limit', daysLeft: 60 }],
      ['grace', { key: 'e', kind: 'grace_nudge', daysLeft: 7 }],
      ['expired', { key: 'f', kind: 'hard_gate' }],
      ['active', { key: 'g', kind: 'reactivated' }],
    ];
    for (const [state, notification] of cases) {
      assertHonest(
        state,
        `notificationMessage(${notification.kind})`,
        notificationMessage(notification, 6_605, GUILD),
      );
    }
  });
});
