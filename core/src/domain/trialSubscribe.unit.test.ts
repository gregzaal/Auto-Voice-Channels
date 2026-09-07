import { describe, expect, it } from 'vitest';
import { MAX_TRIAL_SUBSCRIBE_DAYS, trialSubscribeWindow } from './trialSubscribe.js';
import type { AuthStatus } from './auth.js';

const NOW = new Date('2026-09-07T12:00:00Z');
const DAY_MS = 86_400_000;

function inDays(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

describe('trialSubscribeWindow', () => {
  it('offers the remaining trial to a guild on one', () => {
    const window = trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: inDays(30) }, NOW);
    expect(window).toEqual({ trialDays: 30, firstChargeAt: inDays(30) });
  });

  it('rounds part-days UP, so the charge never lands inside the free period', () => {
    // 6 days and 5 hours left. Rounding down would bill 5 hours early.
    const expiresAt = new Date(NOW.getTime() + 6 * DAY_MS + 5 * 3_600_000);
    const window = trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: expiresAt }, NOW);
    expect(window?.trialDays).toBe(7);
    expect(window!.firstChargeAt.getTime()).toBeGreaterThan(expiresAt.getTime());
  });

  it('covers the imported cohort, whose year plus start jitter runs past 400 days', () => {
    // The longest real trial the product issues: one year from a start jittered
    // 60 to 90 days forward by the importer.
    const window = trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: inDays(436) }, NOW);
    expect(window?.trialDays).toBe(436);
  });

  it('withholds the offer past the cap rather than truncating the trial', () => {
    // Truncating is the tempting alternative and is the one thing this path
    // exists to avoid: it charges before the promised free time has run out.
    const beyond = trialSubscribeWindow(
      { authStatus: 'trial', authExpiresAt: inDays(MAX_TRIAL_SUBSCRIBE_DAYS + 1) },
      NOW,
    );
    expect(beyond).toBeNull();
    const atCap = trialSubscribeWindow(
      { authStatus: 'trial', authExpiresAt: inDays(MAX_TRIAL_SUBSCRIBE_DAYS) },
      NOW,
    );
    expect(atCap?.trialDays).toBe(MAX_TRIAL_SUBSCRIBE_DAYS);
  });

  it('refuses a trial with under a day left', () => {
    expect(
      trialSubscribeWindow(
        { authStatus: 'trial', authExpiresAt: new Date(NOW.getTime() + 23 * 3_600_000) },
        NOW,
      ),
    ).toBeNull();
    // Exactly a day is still offered: a whole-day Paddle trial fits it.
    expect(
      trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: inDays(1) }, NOW)?.trialDays,
    ).toBe(1);
  });

  it('refuses a spent trial', () => {
    expect(
      trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: inDays(-3) }, NOW),
    ).toBeNull();
  });

  it('refuses a guild whose clock never started', () => {
    expect(trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: null }, NOW)).toBeNull();
    expect(trialSubscribeWindow({ authStatus: 'trial', authExpiresAt: undefined }, NOW)).toBeNull();
  });

  it('refuses every status other than trial, however much time is on the clock', () => {
    // `grace` is the one §6.5 names, and the others matter for the same reason:
    // a guild that is not on a trial has no free period left to preserve, so
    // a trial on its checkout would be free service we never promised.
    const others: AuthStatus[] = ['active', 'grace', 'expired', 'blocked'];
    for (const authStatus of others) {
      expect(trialSubscribeWindow({ authStatus, authExpiresAt: inDays(300) }, NOW)).toBeNull();
    }
  });
});
