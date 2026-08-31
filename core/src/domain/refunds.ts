/**
 * What a Paddle adjustment means for a subscription, decided purely.
 *
 * `plans/refunds.md` §7.1 and §7.2. Three things live here rather than in the
 * webhook, because each of them is a rule that was wrong once and would be
 * invisible if it stayed spread across a handler:
 *
 * 1. **Only a refund touches entitlement.** Chargebacks and credits are
 *    adjustments too, and they are recorded and attributed without ever
 *    reaching the entitlement path.
 * 2. **Read Paddle's own `full` / `partial` label, never amounts.** Comparing
 *    amounts is a trap with five separate failure modes: both stored columns are
 *    `text` so `'900' >= '3900'`, the stored total is the latest charge rather
 *    than the one refunded, there is no refund currency, a refund can target any
 *    completed transaction, and Canada, Thailand and Vietnam add tax on top so a
 *    genuine full refund compares as partial.
 * 3. **But the label describes a TRANSACTION, not the paid term.** An annual
 *    customer in month eight whose month-one charge is refunded as goodwill gets
 *    `type: 'full'`, and gating them would violate the rule that a refund
 *    restores and never punishes. So a full refund only revokes access when it
 *    names the transaction that bought the current period.
 */

/** The adjustment fields any decision here needs, extracted from the webhook. */
export interface AdjustmentRecord {
  /** Paddle's adjustment id. What the clearing rule matches on. */
  adjustmentId: string;
  /** Nullable in the SDK's own types, so never assume it is present. */
  paddleSubscriptionId: string | null;
  /** Which transaction was adjusted. */
  transactionId: string | null;
  /** One of Paddle's seven actions: refund, credit, chargeback, and so on. */
  action: string;
  /** One of four: pending_approval, approved, rejected, reversed. */
  status: string;
  /** Paddle's own label: 'full' | 'partial'. Null when we could not read it. */
  type: string | null;
  total: string | null;
  currency: string | null;
  /** The adjustment's own timestamp, which the ordering guard compares. */
  updatedAt: Date | null;
}

/** What the store should do with an adjustment. */
export type RefundVerdict =
  /** Revoke access: stamp `refund_settled_at`. */
  | { kind: 'settle'; reason: string }
  /** Restore it: clear `refund_settled_at`. */
  | { kind: 'clear'; reason: string }
  /** Record it in the display mirror and change nothing about entitlement. */
  | { kind: 'record_only'; reason: string };

/** Adjustment statuses that undo a previously granted refund. */
const UNDOING_STATUSES: ReadonlySet<string> = new Set(['rejected', 'reversed']);

export function classifyAdjustment(
  adjustment: AdjustmentRecord,
  current: {
    /** The transaction that bought the current period, if we know it. */
    chargedTransactionId: string | null | undefined;
    /** Which adjustment last revoked access, if any. */
    refundAdjustmentId: string | null | undefined;
  },
): RefundVerdict {
  if (adjustment.action !== 'refund') {
    /**
     * A chargeback takes the money AND leaves service running, which is worth
     * more to an abuser than asking for a refund. That is a real gap and it is
     * deliberately not closed here: whether a chargeback should gate is a policy
     * decision, not a code one (`plans/refunds.md` §13). Recording and
     * attributing it is what lets an operator see it at all.
     */
    return { kind: 'record_only', reason: `action:${adjustment.action}` };
  }

  if (UNDOING_STATUSES.has(adjustment.status)) {
    /**
     * Only the adjustment that revoked access may restore it.
     *
     * Without the id test this was the §2.6 defect from the other direction: a
     * SECOND refund request arriving `rejected` would clear the marker set by
     * the FIRST, approved one, and the ladder would reactivate a guild whose
     * money we had already returned.
     */
    if (current.refundAdjustmentId && current.refundAdjustmentId === adjustment.adjustmentId) {
      return { kind: 'clear', reason: `undone:${adjustment.status}` };
    }
    return { kind: 'record_only', reason: `undone_other:${adjustment.status}` };
  }

  if (adjustment.status !== 'approved') {
    // `pending_approval`: Paddle is still judging it, and cutting someone off
    // while their request is reviewed would punish them for asking.
    return { kind: 'record_only', reason: `status:${adjustment.status}` };
  }

  /**
   * A partial refund is goodwill only and changes nothing but the record
   * (owner, 2026-08-28). No customer-facing path creates one.
   *
   * A NULL type is treated as full, deliberately. It means we could not read
   * the label, and the two failure directions are not symmetric: treating an
   * unknown refund as partial leaves a customer whose money we returned still
   * being served, while treating it as full gates someone we can put back with
   * one operator action. Err toward gating.
   */
  if (adjustment.type === 'partial') {
    return { kind: 'record_only', reason: 'partial' };
  }

  /**
   * The current-period test, and the same asymmetry decides the null case.
   *
   * We only know the charging transaction for rows written since that column
   * shipped. Where it is unknown the test cannot be made, and refusing to
   * settle would leave a refunded customer entitled, so an unknown charge is
   * treated as a match. That also keeps behaviour identical to before this
   * function existed for every pre-existing row.
   */
  if (
    adjustment.transactionId &&
    current.chargedTransactionId &&
    adjustment.transactionId !== current.chargedTransactionId
  ) {
    return { kind: 'record_only', reason: 'other_period' };
  }

  return { kind: 'settle', reason: 'full_approved' };
}

/**
 * Whether a row's refund columns describe an actual refund.
 *
 * The columns are shared with every other adjustment action now, so a surface
 * that renders "Refunded" has to ask this first or it will tell a customer their
 * money came back when their bank reversed the charge instead. Null reads as a
 * refund, because every row written before the action column existed was one.
 */
export function isRefundRecord(refundAction: string | null | undefined): boolean {
  return refundAction == null || refundAction === 'refund';
}

/** Whether a row's refund columns describe a chargeback (a disputed charge). */
export function isChargebackRecord(refundAction: string | null | undefined): boolean {
  return refundAction === 'chargeback';
}

/**
 * How long after a payment a full refund can be asked for, per `/refunds` §2.
 * Published, so it is a promise rather than a tunable.
 */
export const REFUND_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The open refund window for a payment, or null when there is none.
 *
 * **Null once it has closed, deliberately, and that is an owner decision rather
 * than an implementation detail** (2026-08-28): after the window there is to be
 * no refund UI at all, not a disabled control and not a "you missed it" notice.
 * A surface that renders something for a closed window is reminding a customer
 * of a thing they cannot have, every time they look at their own dashboard.
 *
 * Null also when the charge date is unknown, which is every row until the
 * backfill runs. Saying nothing is right there too: quoting a window we cannot
 * actually compute would be worse than quoting none.
 */
export function refundWindow(
  chargedAt: Date | null | undefined,
  now: Date,
): { closesAt: Date; daysLeft: number } | null {
  if (!chargedAt) return null;
  const closesAt = new Date(chargedAt.getTime() + REFUND_WINDOW_DAYS * DAY_MS);
  if (closesAt.getTime() <= now.getTime()) return null;
  return {
    closesAt,
    daysLeft: Math.max(1, Math.ceil((closesAt.getTime() - now.getTime()) / DAY_MS)),
  };
}
