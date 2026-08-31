import { describe, expect, it } from 'vitest';
import {
  classifyAdjustment,
  isChargebackRecord,
  isRefundRecord,
  refundWindow,
  REFUND_WINDOW_DAYS,
  type AdjustmentRecord,
} from './refunds.js';

/**
 * `plans/refunds.md` §7.1 and §7.2. Each case here is a rule that was wrong at
 * some point, so the test names say what goes wrong rather than what the
 * function returns.
 */
const NOW = new Date('2026-08-31T12:00:00.000Z');

function adjustment(over: Partial<AdjustmentRecord> = {}): AdjustmentRecord {
  return {
    adjustmentId: 'adj_1',
    paddleSubscriptionId: 'sub_1',
    transactionId: 'txn_current',
    action: 'refund',
    status: 'approved',
    type: 'full',
    total: '3900',
    currency: 'USD',
    updatedAt: NOW,
    ...over,
  };
}

const CURRENT = {
  chargedTransactionId: 'txn_current',
  refundAdjustmentId: null,
  refundAction: null,
};

describe('classifyAdjustment', () => {
  it('revokes access for a full, approved refund of the current period', () => {
    expect(classifyAdjustment(adjustment(), CURRENT).kind).toBe('settle');
  });

  it('leaves access alone while a refund is only requested', () => {
    // Cutting someone off while Paddle judges their request would punish them
    // for asking.
    expect(classifyAdjustment(adjustment({ status: 'pending_approval' }), CURRENT).kind).toBe(
      'record_only',
    );
  });

  it('leaves access alone for a partial refund, which is goodwill only', () => {
    expect(classifyAdjustment(adjustment({ type: 'partial' }), CURRENT).kind).toBe('record_only');
  });

  it('leaves access alone for a full refund of some OTHER period', () => {
    /**
     * The defect this exists for: `type: 'full'` describes a TRANSACTION, not
     * the paid term. Refunding month one of an annual subscription as goodwill
     * would otherwise gate a customer who is eight months paid up.
     */
    const verdict = classifyAdjustment(adjustment({ transactionId: 'txn_month_one' }), CURRENT);
    expect(verdict.kind).toBe('record_only');
    expect(verdict.reason).toBe('other_period');
  });

  it('treats an unknown charging transaction as a match, erring toward gating', () => {
    // Rows predating the column cannot be tested, and refusing to settle would
    // leave a customer whose money we returned still being served.
    expect(classifyAdjustment(adjustment(), { ...CURRENT, chargedTransactionId: null }).kind).toBe(
      'settle',
    );
  });

  it('treats an unreadable type as full, for the same reason', () => {
    expect(classifyAdjustment(adjustment({ type: null }), CURRENT).kind).toBe('settle');
  });

  describe('actions other than refund never reach entitlement', () => {
    it('GATES a chargeback, exactly like a refund', () => {
      /**
       * Decision, 2026-08-31. The money and Paddle's dispute fee are both gone,
       * so paid service stops or the invariant is broken in the direction that
       * costs us. It goes through the floor, so nobody loses anything they would
       * have had without paying, and a reversal restores it.
       */
      const verdict = classifyAdjustment(adjustment({ action: 'chargeback' }), CURRENT);
      expect(verdict.kind).toBe('settle');
    });

    it('does NOT gate a chargeback warning, where no money has moved', () => {
      // Gating on a bank's advance notice would punish a customer over something
      // that may never happen.
      for (const action of ['chargeback_warning', 'chargeback_warning_reverse']) {
        expect(classifyAdjustment(adjustment({ action }), CURRENT).kind).toBe('record_only');
      }
    });

    it('restores on a chargeback reversal, matching the stored ACTION not the id', () => {
      /**
       * The bug this caught: a refund goes approved then reversed as ONE
       * adjustment, so the id test is what stops a second request clearing the
       * first one's marker. A chargeback reversal is a SEPARATE adjustment with
       * its own id, so that same test would have refused every legitimate one and
       * left a customer gated after we had already been paid back.
       */
      const verdict = classifyAdjustment(
        adjustment({ adjustmentId: 'adj_different', action: 'chargeback_reverse' }),
        {
          chargedTransactionId: 'txn_current',
          refundAdjustmentId: 'adj_1',
          refundAction: 'chargeback',
        },
      );
      expect(verdict.kind).toBe('clear');
    });

    it('does not let a chargeback reversal clear a REFUND', () => {
      const verdict = classifyAdjustment(adjustment({ action: 'chargeback_reverse' }), {
        chargedTransactionId: 'txn_current',
        refundAdjustmentId: 'adj_1',
        refundAction: 'refund',
      });
      expect(verdict.kind).toBe('record_only');
    });

    it('records a credit without gating', () => {
      expect(classifyAdjustment(adjustment({ action: 'credit' }), CURRENT).kind).toBe(
        'record_only',
      );
    });

    it('records a credit reversal without restoring anything', () => {
      expect(classifyAdjustment(adjustment({ action: 'credit_reverse' }), CURRENT).kind).toBe(
        'record_only',
      );
    });
  });

  describe('undoing a refund', () => {
    it('restores access when the adjustment that revoked it is reversed', () => {
      const verdict = classifyAdjustment(adjustment({ status: 'reversed' }), {
        chargedTransactionId: 'txn_current',
        refundAdjustmentId: 'adj_1',
        refundAction: 'refund',
      });
      expect(verdict.kind).toBe('clear');
    });

    it('restores access when that adjustment is rejected', () => {
      const verdict = classifyAdjustment(adjustment({ status: 'rejected' }), {
        chargedTransactionId: 'txn_current',
        refundAdjustmentId: 'adj_1',
        refundAction: 'refund',
      });
      expect(verdict.kind).toBe('clear');
    });

    it('does NOT let a DIFFERENT adjustment clear the marker', () => {
      /**
       * This is §2.6 from the other direction. A customer files a second refund
       * request, it is rejected, and without the id test that rejection would
       * clear the marker set by the first, approved one, putting a guild whose
       * money we already returned straight back into service.
       */
      const verdict = classifyAdjustment(
        adjustment({ adjustmentId: 'adj_2', status: 'rejected' }),
        {
          chargedTransactionId: 'txn_current',
          refundAdjustmentId: 'adj_1',
          refundAction: 'refund',
        },
      );
      expect(verdict.kind).toBe('record_only');
      expect(verdict.reason).toBe('undone_other:rejected');
    });

    it('does nothing when nothing had revoked access', () => {
      expect(classifyAdjustment(adjustment({ status: 'rejected' }), CURRENT).kind).toBe(
        'record_only',
      );
    });
  });
});

describe('refundWindow', () => {
  const DAY = 86_400_000;

  it('is open for the published 14 days after the charge', () => {
    const charged = new Date(NOW.getTime() - 3 * DAY);
    const out = refundWindow(charged, NOW);
    expect(out).not.toBeNull();
    expect(out?.daysLeft).toBe(REFUND_WINDOW_DAYS - 3);
    expect(out?.closesAt).toEqual(new Date(charged.getTime() + REFUND_WINDOW_DAYS * DAY));
  });

  it('returns NULL once closed, so there is nothing to render', () => {
    /**
     * Owner decision, 2026-08-28: after the window there is to be no refund UI
     * at all, not a disabled control and not a "you missed it" notice. Returning
     * null rather than `{ open: false }` is what makes that the only possible
     * rendering.
     */
    expect(refundWindow(new Date(NOW.getTime() - REFUND_WINDOW_DAYS * DAY), NOW)).toBeNull();
    expect(refundWindow(new Date(NOW.getTime() - 365 * DAY), NOW)).toBeNull();
  });

  it('returns null when the charge date is unknown', () => {
    // Every row until the backfill runs. Quoting a window we cannot compute
    // would be worse than quoting none.
    expect(refundWindow(null, NOW)).toBeNull();
    expect(refundWindow(undefined, NOW)).toBeNull();
  });

  it('never reports zero days left while it is still open', () => {
    // A customer told "0 days left" would reasonably conclude it had closed.
    const out = refundWindow(new Date(NOW.getTime() - REFUND_WINDOW_DAYS * DAY + 1000), NOW);
    expect(out?.daysLeft).toBe(1);
  });
});

describe('isRefundRecord / isChargebackRecord', () => {
  it('reads a null action as a refund, because every old row was one', () => {
    expect(isRefundRecord(null)).toBe(true);
    expect(isRefundRecord(undefined)).toBe(true);
    expect(isRefundRecord('refund')).toBe(true);
  });

  it('refuses to call a chargeback or a credit a refund', () => {
    for (const action of ['chargeback', 'credit', 'chargeback_warning']) {
      expect(isRefundRecord(action)).toBe(false);
    }
    expect(isChargebackRecord('chargeback')).toBe(true);
    expect(isChargebackRecord('refund')).toBe(false);
    expect(isChargebackRecord(null)).toBe(false);
  });
});
