import { describe, expect, it } from 'vitest';
import {
  expiredInteractionMessage,
  gatedCreatorChannelNotice,
  notificationMessage,
  onboardingMessage,
  SITE_URL,
} from './messages.js';

describe('onboardingMessage (§6 size bands)', () => {
  it('free-forever band celebrates, no upsell', () => {
    const msg = onboardingMessage('dormant', 50);
    expect(msg).toContain('free forever');
    expect(msg).not.toContain('$');
  });

  it('1-year trial band names the price and the why', () => {
    const msg = onboardingMessage('year', 500);
    expect(msg).toContain('1-year free trial');
    expect(msg).toContain('$19/yr');
    expect(msg).toContain(SITE_URL);
  });

  it('14-day band explains the short taste and the cost model', () => {
    const msg = onboardingMessage('short', 20_000);
    expect(msg).toContain('14-day free trial');
    expect(msg).toContain('$399/yr');
  });

  it('hard-gate band asks to talk first', () => {
    const msg = onboardingMessage('hard_gate', 2_000_000);
    expect(msg).toContain('dedicated infrastructure');
    expect(msg).toContain(SITE_URL);
  });
});

describe('notificationMessage (the §4 ladder)', () => {
  it('trial warning carries days left and price', () => {
    const msg = notificationMessage(
      { key: 'trial_warning:7:x', kind: 'trial_warning', daysLeft: 7, requiredTier: 's' },
      500,
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
    );
    expect(msg).toContain('nothing broke');
  });

  it('hard gate stays non-destructive in tone and fact', () => {
    const msg = notificationMessage({ key: 'hard_gate:x', kind: 'hard_gate' }, 500);
    expect(msg).toContain('nothing was deleted');
    expect(msg).toContain(SITE_URL);
  });

  it('nudge, reactivation and XXL messages render', () => {
    expect(
      notificationMessage({ key: 'grace_nudge', kind: 'grace_nudge', daysLeft: 12 }, 500),
    ).toContain('12 days');
    expect(notificationMessage({ key: 'r', kind: 'reactivated' }, 500)).toContain('back on');
    expect(notificationMessage({ key: 'x', kind: 'grew_into_xxl' }, 1_500_000)).toContain(
      'million',
    );
  });
});

describe('expired surfaces', () => {
  it('interaction reply and creator-channel notice both point at the site', () => {
    expect(expiredInteractionMessage()).toContain(SITE_URL);
    expect(gatedCreatorChannelNotice()).toContain(SITE_URL);
  });
});
