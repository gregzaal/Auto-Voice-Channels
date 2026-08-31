import { describe, expect, it } from 'vitest';
import { classifyAdjustment, type AdjustmentRecord } from './refunds.js';

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

const CURRENT = { chargedTransactionId: 'txn_current', refundAdjustmentId: null };

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
    it('records a chargeback without gating', () => {
      /**
       * Worth stating plainly: this means a chargeback currently takes the money
       * AND leaves service running, which is better value to an abuser than
       * asking for a refund. Whether it should gate is a policy decision, not a
       * code one. Recording it is what lets an operator see it at all.
       */
      const verdict = classifyAdjustment(adjustment({ action: 'chargeback' }), CURRENT);
      expect(verdict.kind).toBe('record_only');
      expect(verdict.reason).toBe('action:chargeback');
    });

    it('records a credit without gating', () => {
      expect(classifyAdjustment(adjustment({ action: 'credit' }), CURRENT).kind).toBe(
        'record_only',
      );
    });

    it('records a chargeback reversal without restoring anything', () => {
      // `chargeback_reverse` is an undoing STATUS on a non-refund action. The
      // action test comes first, so it cannot clear a refund's marker.
      const verdict = classifyAdjustment(
        adjustment({ action: 'chargeback_reverse', status: 'reversed' }),
        { chargedTransactionId: 'txn_current', refundAdjustmentId: 'adj_1' },
      );
      expect(verdict.kind).toBe('record_only');
    });
  });

  describe('undoing a refund', () => {
    it('restores access when the adjustment that revoked it is reversed', () => {
      const verdict = classifyAdjustment(adjustment({ status: 'reversed' }), {
        chargedTransactionId: 'txn_current',
        refundAdjustmentId: 'adj_1',
      });
      expect(verdict.kind).toBe('clear');
    });

    it('restores access when that adjustment is rejected', () => {
      const verdict = classifyAdjustment(adjustment({ status: 'rejected' }), {
        chargedTransactionId: 'txn_current',
        refundAdjustmentId: 'adj_1',
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
        { chargedTransactionId: 'txn_current', refundAdjustmentId: 'adj_1' },
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
