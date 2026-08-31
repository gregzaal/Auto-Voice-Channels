import { describe, expect, it } from 'vitest';
import {
  subscriptionEarnsRecognition,
  subscriptionInGoodStanding,
  subscriptionIsSettled,
  subscriptionWillChargeAgain,
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

/**
 * The third predicate, and the one the other two cannot answer: **a refund does
 * not cancel a subscription.** Standing and future billing are independent, so
 * a refunded subscription can be delivering nothing while Paddle still has a
 * renewal date for it.
 *
 * Two decisions ride on this. A server whose existing subscription will charge
 * again must not be sold a second one, or the customer pays twice. And a
 * subscription that will never charge again is finished, so the server it used
 * to cover can be sold a fresh one instead of being stuck behind a dead row
 * until Paddle's own cancellation date lands, up to a year out.
 */
describe('subscriptionWillChargeAgain', () => {
  it('is true for every status Paddle still bills, refunded or not', () => {
    for (const status of ['active', 'trialing', 'past_due', 'paused']) {
      expect(subscriptionWillChargeAgain({ status }), status).toBe(true);
      expect(subscriptionWillChargeAgain({ status, scheduledChangeAction: null }), status).toBe(
        true,
      );
    }
    // The case that costs money: gated by the refund, still on the billing run.
    expect(subscriptionWillChargeAgain({ status: 'active' })).toBe(true);
  });

  it('is false once it is cancelled, however that was spelled', () => {
    expect(subscriptionWillChargeAgain({ status: 'canceled' })).toBe(false);
    expect(subscriptionWillChargeAgain({ status: 'cancelled' })).toBe(false);
    expect(subscriptionWillChargeAgain({ status: 'active', scheduledChangeAction: 'cancel' })).toBe(
      false,
    );
  });

  /** A pause is not an ending: it resumes and bills again. */
  it('treats a scheduled pause as still live', () => {
    expect(subscriptionWillChargeAgain({ status: 'active', scheduledChangeAction: 'pause' })).toBe(
      true,
    );
  });
});

describe('subscriptionIsSettled', () => {
  it('is true only when it delivers nothing AND bills nothing again', () => {
    expect(subscriptionIsSettled({ status: 'canceled' })).toBe(true);
    expect(
      subscriptionIsSettled({
        status: 'active',
        refundStatus: 'approved',
        scheduledChangeAction: 'cancel',
      }),
    ).toBe(true);
  });

  it('is false while either half is still live', () => {
    // Refunded but never cancelled: nothing delivered, and it charges again.
    expect(subscriptionIsSettled({ status: 'active', refundStatus: 'approved' })).toBe(false);
    // Cancelled but still inside the paid term: no more charges, still serving.
    expect(subscriptionIsSettled({ status: 'active', scheduledChangeAction: 'cancel' })).toBe(
      false,
    );
    expect(subscriptionIsSettled({ status: 'active' })).toBe(false);
  });
});
