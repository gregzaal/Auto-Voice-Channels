import { describe, expect, it } from 'vitest';
import {
  subscriptionEarnsRecognition,
  subscriptionInGoodStanding,
  SUBSCRIPTION_OK_STATUSES,
} from './subscriptions.js';

/**
 * A refund does NOT cancel a Paddle subscription: the status stays `active`
 * for the rest of the paid term. So without this, the hourly reconcile job
 * would see a healthy subscription and reactivate a guild that was gated for
 * being refunded, quietly undoing the refund an hour later.
 */
describe('subscriptionInGoodStanding', () => {
  it('accepts the paying statuses', () => {
    for (const status of SUBSCRIPTION_OK_STATUSES) {
      expect(subscriptionInGoodStanding({ status }), status).toBe(true);
    }
  });

  it('rejects dunning and ended statuses', () => {
    for (const status of ['past_due', 'paused', 'canceled']) {
      expect(subscriptionInGoodStanding({ status }), status).toBe(false);
    }
  });

  it('revokes standing for a GRANTED refund even while Paddle says active', () => {
    expect(subscriptionInGoodStanding({ status: 'active', refundStatus: 'approved' })).toBe(false);
  });

  it('leaves standing intact while a refund is only requested or was rejected', () => {
    expect(subscriptionInGoodStanding({ status: 'active', refundStatus: 'pending_approval' })).toBe(
      true,
    );
    expect(subscriptionInGoodStanding({ status: 'active', refundStatus: 'rejected' })).toBe(true);
    expect(subscriptionInGoodStanding({ status: 'active', refundStatus: null })).toBe(true);
  });
});

/**
 * The looser sibling, used only to decide who gets a supporter role. The two
 * live in one file so the one place they differ stays visible: entitlement is
 * strict, recognition forgives a card that just failed.
 */
describe('subscriptionEarnsRecognition', () => {
  it('accepts everything good standing accepts', () => {
    for (const status of SUBSCRIPTION_OK_STATUSES) {
      expect(subscriptionEarnsRecognition({ status }), status).toBe(true);
    }
  });

  /**
   * The whole point of the split. The leniency ladder keeps a `past_due`
   * customer's servers running for 60 more days, so stripping a public role on
   * day one would announce a failed card to their whole server before the
   * retries have even finished.
   */
  it('keeps recognition through dunning, which good standing does not', () => {
    expect(subscriptionInGoodStanding({ status: 'past_due' })).toBe(false);
    expect(subscriptionEarnsRecognition({ status: 'past_due' })).toBe(true);
  });

  it('still rejects the ended statuses', () => {
    for (const status of ['paused', 'canceled']) {
      expect(subscriptionEarnsRecognition({ status }), status).toBe(false);
    }
  });

  /** Leniency is for a failed charge, not for money already given back. */
  it('revokes recognition for a granted refund, in every status', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(subscriptionEarnsRecognition({ status, refundStatus: 'approved' }), status).toBe(
        false,
      );
    }
  });

  it('leaves recognition intact while a refund is only requested', () => {
    expect(
      subscriptionEarnsRecognition({ status: 'past_due', refundStatus: 'pending_approval' }),
    ).toBe(true);
  });
});
