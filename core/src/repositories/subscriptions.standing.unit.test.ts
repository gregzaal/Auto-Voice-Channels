import { describe, expect, it } from 'vitest';
import {
  subscriptionEarnsRecognition,
  subscriptionInGoodStanding,
  subscriptionIsSettled,
  subscriptionWillChargeAgain,
  SUBSCRIPTION_OK_STATUSES,
} from './subscriptions.js';

/**
 * Builds the shape the predicates require.
 *
 * The inputs are REQUIRED properties on purpose, so a narrow projection that
 * omits one fails to compile rather than silently reading `undefined`. That
 * caught two real sites when it landed: `listSupporterTiersFor`'s select and
 * the `RevenueSubscription` Pick that decides the ARR figure.
 *
 * **Worth knowing: it does not cover this file.** `core/tsconfig.json` excludes
 * `*.test.ts`, so test sources are typechecked by nothing, and the largest
 * single set of narrow calls in the repo was invisible to the gate the trick
 * exists to be. Hence the builder: it keeps the calls honest by construction
 * instead of relying on a compiler that never looks here.
 */
function sub(over: Partial<Parameters<typeof subscriptionIsSettled>[0]> = {}) {
  return {
    status: 'active',
    refundStatus: null,
    refundSettledAt: null,
    refundUpdatedAt: null,
    scheduledChangeAction: null,
    ...over,
  };
}

/**
 * A refund does NOT cancel a Paddle subscription: the status stays `active`
 * for the rest of the paid term. So without this, the hourly reconcile job
 * would see a healthy subscription and reactivate a guild that was gated for
 * being refunded, quietly undoing the refund an hour later.
 */
describe('subscriptionInGoodStanding', () => {
  it('accepts the paying statuses', () => {
    for (const status of SUBSCRIPTION_OK_STATUSES) {
      expect(subscriptionInGoodStanding(sub({ status })), status).toBe(true);
    }
  });

  it('rejects dunning and ended statuses', () => {
    for (const status of ['past_due', 'paused', 'canceled']) {
      expect(subscriptionInGoodStanding(sub({ status })), status).toBe(false);
    }
  });

  it('revokes standing for a GRANTED refund even while Paddle says active', () => {
    expect(subscriptionInGoodStanding(sub({ status: 'active', refundStatus: 'approved' }))).toBe(
      false,
    );
  });

  it('leaves standing intact while a refund is only requested or was rejected', () => {
    expect(
      subscriptionInGoodStanding(sub({ status: 'active', refundStatus: 'pending_approval' })),
    ).toBe(true);
    expect(subscriptionInGoodStanding(sub({ status: 'active', refundStatus: 'rejected' }))).toBe(
      true,
    );
    expect(subscriptionInGoodStanding(sub({ status: 'active', refundStatus: null }))).toBe(true);
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
      expect(subscriptionEarnsRecognition(sub({ status })), status).toBe(true);
    }
  });

  /**
   * The whole point of the split. The leniency ladder keeps a `past_due`
   * customer's servers running for 60 more days, so stripping a public role on
   * day one would announce a failed card to their whole server before the
   * retries have even finished.
   */
  it('keeps recognition through dunning, which good standing does not', () => {
    expect(subscriptionInGoodStanding(sub({ status: 'past_due' }))).toBe(false);
    expect(subscriptionEarnsRecognition(sub({ status: 'past_due' }))).toBe(true);
  });

  it('still rejects the ended statuses', () => {
    for (const status of ['paused', 'canceled']) {
      expect(subscriptionEarnsRecognition(sub({ status })), status).toBe(false);
    }
  });

  /** Leniency is for a failed charge, not for money already given back. */
  it('revokes recognition for a granted refund, in every status', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      expect(subscriptionEarnsRecognition(sub({ status, refundStatus: 'approved' })), status).toBe(
        false,
      );
    }
  });

  it('leaves recognition intact while a refund is only requested', () => {
    expect(
      subscriptionEarnsRecognition(sub({ status: 'past_due', refundStatus: 'pending_approval' })),
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
    expect(subscriptionWillChargeAgain(sub({ status: 'active' }))).toBe(true);
  });

  it('is false once it is cancelled, however that was spelled', () => {
    expect(subscriptionWillChargeAgain(sub({ status: 'canceled' }))).toBe(false);
    expect(subscriptionWillChargeAgain(sub({ status: 'cancelled' }))).toBe(false);
    expect(
      subscriptionWillChargeAgain(sub({ status: 'active', scheduledChangeAction: 'cancel' })),
    ).toBe(false);
  });

  /** A pause is not an ending: it resumes and bills again. */
  it('treats a scheduled pause as still live', () => {
    expect(
      subscriptionWillChargeAgain(sub({ status: 'active', scheduledChangeAction: 'pause' })),
    ).toBe(true);
  });
});

describe('subscriptionIsSettled', () => {
  it('is true only when it delivers nothing AND bills nothing again', () => {
    expect(subscriptionIsSettled(sub({ status: 'canceled' }))).toBe(true);
    expect(
      subscriptionIsSettled(
        sub({
          status: 'active',
          refundStatus: 'approved',
          scheduledChangeAction: 'cancel',
        }),
      ),
    ).toBe(true);
  });

  it('is false while either half is still live', () => {
    // Refunded but never cancelled: nothing delivered, and it charges again.
    expect(subscriptionIsSettled(sub({ status: 'active', refundStatus: 'approved' }))).toBe(false);
    // Cancelled but still inside the paid term: no more charges, still serving.
    expect(subscriptionIsSettled(sub({ status: 'active', scheduledChangeAction: 'cancel' }))).toBe(
      false,
    );
    expect(subscriptionIsSettled(sub({ status: 'active' }))).toBe(false);
  });
});

describe('refundSettledAt is the authority, refundStatus is the compat path', () => {
  it('revokes standing on the settled marker alone', () => {
    // The status says paying and no refund status is recorded, which is exactly
    // the shape a derived row has once the writer ships.
    expect(subscriptionInGoodStanding(sub({ refundSettledAt: new Date() }))).toBe(false);
  });

  it('still revokes on the old status alone, for rows nothing has derived yet', () => {
    expect(subscriptionInGoodStanding(sub({ refundStatus: 'approved' }))).toBe(false);
  });

  it('revokes recognition on the settled marker too, so a badge cannot outlive a refund', () => {
    expect(subscriptionEarnsRecognition(sub({ refundSettledAt: new Date() }))).toBe(false);
  });

  it('makes a refunded subscription that still renews NOT settled', () => {
    // Standing and future billing are independent axes. This is the state the
    // whole rework exists for: gated immediately, still going to charge.
    const refunded = sub({ refundSettledAt: new Date() });
    expect(subscriptionInGoodStanding(refunded)).toBe(false);
    expect(subscriptionWillChargeAgain(refunded)).toBe(true);
    expect(subscriptionIsSettled(refunded)).toBe(false);
  });

  it('makes a refunded AND cancelled subscription settled', () => {
    const done = sub({ refundSettledAt: new Date(), scheduledChangeAction: 'cancel' });
    expect(subscriptionIsSettled(done)).toBe(true);
  });
});

describe('the compat branch is scoped to rows the derived writer never touched', () => {
  it('gates a legacy approved refund, where the marker cannot exist yet', () => {
    expect(subscriptionInGoodStanding(sub({ refundStatus: 'approved' }))).toBe(false);
  });

  it('does NOT gate a partial refund the derived writer recorded', () => {
    /**
     * The defect this scoping exists for. A partial refund's status is also
     * `approved`, so an unconditional compat branch would gate a customer who
     * was handed goodwill money and is still fully paid up. Partial refunds are
     * goodwill only and change nothing but the record (owner, 2026-08-28).
     */
    expect(
      subscriptionInGoodStanding(
        sub({ refundStatus: 'approved', refundUpdatedAt: new Date(), refundSettledAt: null }),
      ),
    ).toBe(true);
  });

  it('does NOT gate a full refund of some other period, recorded the same way', () => {
    // Same shape: the writer looked at it, decided it does not revoke access,
    // and the absence of the marker is that decision rather than a gap.
    expect(
      subscriptionInGoodStanding(
        sub({ refundStatus: 'approved', refundUpdatedAt: new Date(), refundSettledAt: null }),
      ),
    ).toBe(true);
  });

  it('still gates once the writer sets the marker', () => {
    expect(
      subscriptionInGoodStanding(
        sub({ refundStatus: 'approved', refundUpdatedAt: new Date(), refundSettledAt: new Date() }),
      ),
    ).toBe(false);
  });
});
