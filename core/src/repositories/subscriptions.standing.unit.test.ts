import { describe, expect, it } from 'vitest';
import { subscriptionInGoodStanding, SUBSCRIPTION_OK_STATUSES } from './subscriptions.js';

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
