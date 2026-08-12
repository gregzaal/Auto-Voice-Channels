import { describe, expect, it } from 'vitest';
import type { LeniencyNotification } from '@avc/core';
import {
  expiredInteractionMessage,
  gatedCreatorChannelNotice,
  notificationMessage,
  onboardingMessage,
  SITE_URL,
  subscribeUrl,
} from './messages.js';

const GUILD = '462606582367125509';
const LINK = `${SITE_URL}/dashboard?guild=${GUILD}`;

describe('onboardingMessage (§6 size bands)', () => {
  it('free-forever band celebrates, no upsell', () => {
    const msg = onboardingMessage('dormant', 50, GUILD);
    expect(msg).toContain('free forever');
    expect(msg).not.toContain('$');
  });

  it('1-year trial band names the price and the why', () => {
    const msg = onboardingMessage('year', 500, GUILD);
    expect(msg).toContain('1-year free trial');
    expect(msg).toContain('$19/yr');
    expect(msg).toContain(LINK);
  });

  it('14-day band explains the short taste and the cost model', () => {
    const msg = onboardingMessage('short', 20_000, GUILD);
    expect(msg).toContain('14-day free trial');
    expect(msg).toContain('$399/yr');
    expect(msg).toContain(LINK);
  });

  it('hard-gate band asks to talk first', () => {
    const msg = onboardingMessage('hard_gate', 2_000_000, GUILD);
    expect(msg).toContain('dedicated infrastructure');
    expect(msg).toContain(SITE_URL);
  });
});

describe('notificationMessage (the §4 ladder)', () => {
  it('trial warning carries days left and price', () => {
    const msg = notificationMessage(
      { key: 'trial_warning:7:x', kind: 'trial_warning', daysLeft: 7, requiredTier: 's' },
      500,
      GUILD,
    );
    expect(msg).toContain('7 days');
    expect(msg).toContain('$19/yr');
  });

  it('over-limit grace celebrates growth, never threatens', () => {
    const msg = notificationMessage(
      {
        key: 'grace_started:over_limit:l',
        kind: 'grace_started',
        reason: 'over_limit',
        requiredTier: 'l',
        daysLeft: 60,
      },
      12_000,
      GUILD,
    );
    expect(msg).toContain('grown');
    expect(msg).toContain('60 days');
    expect(msg).toContain('$399/yr');
  });

  it('trial-expiry grace reassures nothing broke', () => {
    const msg = notificationMessage(
      {
        key: 'grace_started:trial_expired:x',
        kind: 'grace_started',
        reason: 'trial_expired',
        daysLeft: 60,
        requiredTier: 'm',
      },
      5_000,
      GUILD,
    );
    expect(msg).toContain('nothing broke');
  });

  it('hard gate stays non-destructive in tone and fact', () => {
    const msg = notificationMessage({ key: 'hard_gate:x', kind: 'hard_gate' }, 500, GUILD);
    // Case-insensitive: the promise is what matters, and removing an em dash
    // can legitimately turn the clause into its own sentence.
    expect(msg).toMatch(/nothing was deleted/i);
    expect(msg).toContain(LINK);
  });

  it('nudge, reactivation and XXL messages render', () => {
    expect(
      notificationMessage({ key: 'grace_nudge', kind: 'grace_nudge', daysLeft: 12 }, 500, GUILD),
    ).toContain('12 days');
    expect(notificationMessage({ key: 'r', kind: 'reactivated' }, 500, GUILD)).toContain('back on');
    expect(notificationMessage({ key: 'x', kind: 'grew_into_xxl' }, 1_500_000, GUILD)).toContain(
      'million',
    );
  });
});

describe('expired surfaces', () => {
  it('interaction reply and creator-channel notice deep-link to the guild', () => {
    expect(expiredInteractionMessage(GUILD)).toContain(LINK);
    expect(gatedCreatorChannelNotice(GUILD)).toContain(LINK);
  });
});

/**
 * Every message that asks for money must land the admin on the page that takes
 * it, for THIS guild. A bare `auto-voice.io` means finding the right server in
 * a list before they can pay, which is exactly the click we are removing.
 */
describe('payment prompts deep-link to the guild', () => {
  const PROMPTS: LeniencyNotification[] = [
    { key: 'a', kind: 'trial_warning', daysLeft: 7, requiredTier: 's' },
    { key: 'b', kind: 'grace_started', reason: 'trial_expired', daysLeft: 60, requiredTier: 'm' },
    { key: 'c', kind: 'grace_started', reason: 'subscription_lapsed', daysLeft: 60 },
    { key: 'd', kind: 'grace_started', reason: 'over_limit', requiredTier: 'l', daysLeft: 60 },
    { key: 'e', kind: 'grace_nudge', daysLeft: 12 },
    { key: 'f', kind: 'hard_gate' },
  ];

  it.each(PROMPTS)('$kind links straight to the guild dashboard', (n) => {
    const msg = notificationMessage(n, 5_000, GUILD);
    expect(msg).toContain(LINK);
    // The bare root would technically match `toContain(LINK)`'s prefix, so
    // assert the site URL never appears WITHOUT the deep-link suffix.
    expect(msg.replaceAll(LINK, '')).not.toContain(SITE_URL);
  });

  it('subscribeUrl is a dashboard link carrying the guild id', () => {
    expect(subscribeUrl(GUILD)).toBe(`${SITE_URL}/dashboard?guild=${GUILD}`);
  });
});

/**
 * Mechanical guard for the user-facing copy rules (AGENTS.md). A hand-kept list
 * of "strings that must stay clean" rots; rendering every message and checking
 * the characters does not.
 */
describe('copy rules', () => {
  const everyMessage = (): string[] => {
    const out: string[] = [
      onboardingMessage('dormant', 50, GUILD),
      onboardingMessage('year', 500, GUILD),
      onboardingMessage('short', 20_000, GUILD),
      onboardingMessage('hard_gate', 2_000_000, GUILD),
      expiredInteractionMessage(GUILD),
      gatedCreatorChannelNotice(GUILD),
    ];
    const notifications: LeniencyNotification[] = [
      { key: 'a', kind: 'trial_warning', daysLeft: 1, requiredTier: 's' },
      { key: 'b', kind: 'grace_started', reason: 'trial_expired', daysLeft: 60, requiredTier: 'm' },
      { key: 'c', kind: 'grace_started', reason: 'subscription_lapsed', daysLeft: 60 },
      { key: 'd', kind: 'grace_started', reason: 'over_limit', requiredTier: 'l', daysLeft: 60 },
      { key: 'e', kind: 'grace_nudge', daysLeft: 7 },
      { key: 'f', kind: 'hard_gate' },
      { key: 'g', kind: 'reactivated' },
      { key: 'h', kind: 'grew_into_xxl' },
    ];
    for (const n of notifications) out.push(notificationMessage(n, 5_000, GUILD));
    return out;
  };

  it('uses no em or en dashes', () => {
    for (const msg of everyMessage()) expect(msg).not.toMatch(/[—–]/);
  });

  it('uses no curly quotes or apostrophes', () => {
    for (const msg of everyMessage()) expect(msg).not.toMatch(/[‘’“”]/);
  });

  it('uses no prose semicolons', () => {
    for (const msg of everyMessage()) expect(msg).not.toContain(';');
  });
});
