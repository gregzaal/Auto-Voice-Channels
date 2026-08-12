import { describe, expect, it } from 'vitest';
import type { GuildRow } from '@avc/core';
import { decideOnboarding } from './onboarding.js';

const NOW = new Date('2026-07-04T12:00:00.000Z');
const DAY_MS = 86_400_000;

function row(overrides: Partial<GuildRow> = {}): GuildRow {
  return {
    guildId: 'g-1',
    authStatus: 'trial',
    authExpiresAt: null,
    graceUntil: null,
    memberCount: null,
    memberCountUpdatedAt: null,
    tier: null,
    settings: {},
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('decideOnboarding (§3/§6)', () => {
  it('under 100 members: dormant policy, 1-year clock still starts', () => {
    const d = decideOnboarding(row(), 50, NOW);
    expect(d.policy).toBe('dormant');
    expect(d.setExpiresAt).toEqual(new Date(NOW.getTime() + 365 * DAY_MS));
    expect(d.hardGate).toBe(false);
    expect(d.welcome).toBe(true);
  });

  it('100–9,999: the 1-year trial', () => {
    const d = decideOnboarding(row(), 5_000, NOW);
    expect(d.policy).toBe('year');
    expect(d.setExpiresAt).toEqual(new Date(NOW.getTime() + 365 * DAY_MS));
  });

  it('10k–1M: the 14-day trial', () => {
    const d = decideOnboarding(row(), 20_000, NOW);
    expect(d.policy).toBe('short');
    expect(d.setExpiresAt).toEqual(new Date(NOW.getTime() + 14 * DAY_MS));
  });

  it('≥1M joining fresh: hard gate, no trial window', () => {
    const d = decideOnboarding(row(), 1_500_000, NOW);
    expect(d.policy).toBe('hard_gate');
    expect(d.hardGate).toBe(true);
    expect(d.setExpiresAt).toBeUndefined();
  });

  it('a re-added guild keeps its original trial clock (first-add semantics)', () => {
    const existing = new Date('2026-01-01T00:00:00.000Z');
    const d = decideOnboarding(row({ authExpiresAt: existing }), 5_000, NOW);
    expect(d.setExpiresAt).toBeUndefined();
    expect(d.hardGate).toBe(false);
  });

  it('a guild with prior auth history is never re-gated or re-clocked', () => {
    const active = decideOnboarding(row({ authStatus: 'active' }), 1_500_000, NOW);
    expect(active.hardGate).toBe(false);
    expect(active.setExpiresAt).toBeUndefined();
    const expired = decideOnboarding(row({ authStatus: 'expired' }), 5_000, NOW);
    expect(expired.setExpiresAt).toBeUndefined();
  });

  it('welcome is one-shot and never for stale (boot-flood) rows', () => {
    const onboarded = decideOnboarding(
      row({ metadata: { billing: { onboardedAt: '2026-06-01T00:00:00.000Z' } } }),
      500,
      NOW,
    );
    expect(onboarded.welcome).toBe(false);

    const stale = decideOnboarding(
      row({ createdAt: new Date(NOW.getTime() - 30 * DAY_MS) }),
      500,
      NOW,
    );
    expect(stale.welcome).toBe(false);
  });
  /**
   * Regression: re-adding the bot to a PAYING server DM'd the owner "your
   * 1-year free trial just started".
   *
   * Every welcome announces a trial, but the message was chosen from member
   * count alone. The one-shot flag did not help (it is only written once a
   * welcome has actually been delivered, and this guild had never been
   * welcomed) and neither did the staleness window (it keys off the ROW's age,
   * which is recent for any guild first seen recently, however long it has
   * been a customer). Only the auth status distinguishes them.
   */
  it('never welcomes a guild that is not on a trial', () => {
    for (const authStatus of ['active', 'grace', 'expired', 'blocked'] as const) {
      const d = decideOnboarding(row({ authStatus }), 6_605, NOW);
      expect(d.welcome, authStatus).toBe(false);
    }
  });

  it('still welcomes a genuine fresh add', () => {
    expect(decideOnboarding(row({ authStatus: 'trial' }), 6_605, NOW).welcome).toBe(true);
  });

  it('welcomes a small free-forever server, which is still a trial row', () => {
    expect(decideOnboarding(row({ authStatus: 'trial' }), 50, NOW).welcome).toBe(true);
  });
});
