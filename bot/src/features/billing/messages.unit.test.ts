import { describe, expect, it } from 'vitest';
import type { LeniencyNotification } from '@avc/core';
import {
  coveredWelcomeMessage,
  expiredInteractionMessage,
  gatedCreatorChannelNotice,
  notificationMessage,
  onboardingMessage,
  SITE_URL,
  SUPPORT_URL,
  subscribeUrl,
} from './messages.js';

const GUILD = '462606582367125509';
const LINK = `${SITE_URL}/dashboard?guild=${GUILD}`;

describe('onboardingMessage', () => {
  it('free-forever band celebrates, no upsell', () => {
    const msg = onboardingMessage('dormant', 50, GUILD);
    expect(msg).toContain('free forever');
    expect(msg).not.toContain('$');
  });

  it('1-year trial band names the price and the why', () => {
    const msg = onboardingMessage('year', 500, GUILD);
    expect(msg).toContain('1-year free trial');
    expect(msg).toContain('$1.50 a month, billed yearly ($18)');
    expect(msg).toContain(LINK);
  });

  it('30-day band explains the short taste and the cost model', () => {
    const msg = onboardingMessage('short', 20_000, GUILD);
    expect(msg).toContain('30-day free trial');
    expect(msg).toContain('$7.50 a month, billed yearly ($90)');
    expect(msg).toContain(LINK);
  });

  it('hard-gate band asks to talk first, and promises no infrastructure', () => {
    const msg = onboardingMessage('hard_gate', 2_000_000, GUILD);
    expect(msg).toContain('needs a conversation');
    // Dedicated infrastructure is not an offered guarantee: we do
    // not know yet that we can serve a server that size, and this message goes
    // to the largest server that ever adds the bot. The test asserted the
    // retracted claim, which is what kept it alive here after `/setup` and
    // `/pricing` had both dropped it.
    expect(msg).not.toContain('infrastructure');
    // The support server, not the homepage: a money message deep-links to the
    // thing that answers it, and the homepage names no contact route.
    expect(msg).toContain(SUPPORT_URL);
    expect(msg).not.toContain(`${SITE_URL} `);
  });
});

describe('notificationMessage', () => {
  it('trial warning carries days left and price', () => {
    const msg = notificationMessage(
      { key: 'trial_warning:7:x', kind: 'trial_warning', daysLeft: 7, requiredTier: 's' },
      500,
      GUILD,
    );
    expect(msg).toContain('7 days');
    expect(msg).toContain('$1.50 a month, billed yearly ($18)');
  });

  it('trial warning says deciding early costs nothing', () => {
    /**
     * The message used to offer only "subscribe", which asked the admin to
     * throw away the trial days they had left in order to stop being reminded
     * about them. The rational move was to ignore every warning until the last.
     */
    const msg = notificationMessage(
      { key: 'trial_warning:30:x', kind: 'trial_warning', daysLeft: 30, requiredTier: 'm' },
      5_000,
      GUILD,
    );
    expect(msg).toContain('keep every day of the trial');
    expect(msg).toContain('the day it ends');
    // No date: the first charge is a function of when checkout is opened, not
    // of when this was sent, and the dashboard quotes it precisely.
    expect(msg).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('over-limit grace celebrates growth, never threatens', () => {
    const msg = notificationMessage(
      {
        key: 'grace_started:over_limit:epic',
        kind: 'grace_started',
        reason: 'over_limit',
        requiredTier: 'epic',
        daysLeft: 60,
      },
      12_000,
      GUILD,
    );
    expect(msg).toContain('grown');
    expect(msg).toContain('60 days');
    expect(msg).toContain('$7.50 a month, billed yearly ($90)');
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
    // 300,000, where the ladder ends now. The KEY keeps its old name because it
    // is stored text in `metadata.billing` and `billing_notifications.key`;
    // renaming it would re-send the notice to everyone who already had it.
    const grew = notificationMessage({ key: 'x', kind: 'grew_into_xxl' }, 1_500_000, GUILD);
    expect(grew).toContain('300,000');
    expect(grew).not.toContain('million');
    expect(grew).not.toContain('infrastructure');
    expect(grew).toContain(SUPPORT_URL);
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
    { key: 'd', kind: 'grace_started', reason: 'over_limit', requiredTier: 'epic', daysLeft: 60 },
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
 * Mechanical guard for the user-facing copy rules. A hand-kept list
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
      coveredWelcomeMessage(GUILD),
      expiredInteractionMessage(GUILD),
      expiredInteractionMessage(GUILD, true),
      gatedCreatorChannelNotice(GUILD),
      gatedCreatorChannelNotice(GUILD, true),
    ];
    const notifications: LeniencyNotification[] = [
      { key: 'a', kind: 'trial_warning', daysLeft: 1, requiredTier: 's' },
      { key: 'b', kind: 'grace_started', reason: 'trial_expired', daysLeft: 60, requiredTier: 'm' },
      { key: 'c', kind: 'grace_started', reason: 'subscription_lapsed', daysLeft: 60 },
      { key: 'd', kind: 'grace_started', reason: 'over_limit', requiredTier: 'epic', daysLeft: 60 },
      { key: 'e', kind: 'grace_nudge', daysLeft: 7 },
      { key: 'f', kind: 'hard_gate' },
      { key: 'g', kind: 'reactivated' },
      { key: 'h', kind: 'grew_into_xxl' },
    ];
    // Every audience, not just the default one: the shared-subscription copy is
    // a separate set of strings and is exactly as user-facing.
    for (const n of notifications) {
      for (const audience of ['guild', 'purchaser', 'shared_member'] as const) {
        out.push(notificationMessage(n, 5_000, GUILD, subscribeUrl(GUILD), audience));
      }
    }
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

  /**
   * "pool" is an internal word for the billing unit. The customer-facing word
   * is "subscription", and this is enforced mechanically because it had already
   * leaked into four `/setup` strings and eight server-action error messages
   * before anyone noticed.
   */
  it('never says "pool" to a user', () => {
    for (const msg of everyMessage()) expect(msg).not.toMatch(/pool/i);
  });
});
