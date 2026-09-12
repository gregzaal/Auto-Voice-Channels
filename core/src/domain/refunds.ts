/**
 * Pure policy for how a Paddle adjustment affects a subscription.
 *
 * Approved, complete refunds and chargebacks can revoke paid entitlement.
 * Credits and chargeback warnings only update the record; qualifying reversals
 * restore entitlement. Callers apply the verdict through `guildFloor` so free
 * access and an unconsumed trial survive the loss of paid service.
 *
 * Determine completeness from Paddle's top-level and item labels, never amount
 * comparisons: amounts may refer to different transactions, currencies or tax
 * totals, and stored numeric text does not have numeric ordering.
 *
 * A complete adjustment for a known older transaction must not revoke the
 * current paid period. When transaction identity or completeness is unknown,
 * the classifier deliberately errs toward revoking paid service; the branches
 * below document those fallbacks.
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
  /**
   * Paddle's top-level `full` / `partial` label is not sufficient alone.
   * An item-scoped adjustment can be labelled `partial` while returning the
   * whole charge. See {@link adjustmentIsComplete}.
   */
  type: string | null;
  /** Per-line-item labels, which are what actually say how much was refunded. */
  itemTypes: readonly string[];
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

/**
 * Refunds and chargebacks both remove payment, so both can revoke paid service.
 * `guildFloor` preserves free access and any unconsumed trial; a qualifying
 * reversal restores the entitlement that the adjustment removed.
 */
const REVOKING_ACTIONS: ReadonlySet<string> = new Set(['refund', 'chargeback']);

/**
 * Actions that give the money back to us, and so restore what they revoked.
 *
 * `chargeback_warning` is deliberately absent from both sets: the issuer has
 * signalled a dispute may be coming and no money has moved, so gating on it
 * would punish a customer over a bank's advance notice about something that may
 * never happen. Credits are absent too, being money applied to a future invoice
 * rather than money taken from us.
 */
const RESTORING_ACTIONS: ReadonlySet<string> = new Set(['chargeback_reverse']);

/**
 * Whether an adjustment returns the whole charge.
 *
 * A top-level `full` label is complete. An item-scoped adjustment may say
 * `partial` at the top level while every named item says `full`, so those
 * item labels must also be checked. Missing labels default to complete.
 *
 * **The item-label rule assumes one line item per transaction.** A subscription
 * currently carries one tier and one price. With multiple items, refunding one
 * in full would not imply refunding the transaction. If that model changes,
 * compare the covered items with the transaction's items; do not substitute
 * amount comparisons, which can mix transactions, currencies and tax totals.
 */
export function adjustmentIsComplete(adjustment: {
  type: string | null;
  itemTypes: readonly string[];
}): boolean {
  if (adjustment.type === 'full') return true;
  if (adjustment.itemTypes.length === 0) return adjustment.type !== 'partial';
  return adjustment.itemTypes.every((t) => t === 'full');
}

/** Adjustment statuses that undo a previously granted refund. */
const UNDOING_STATUSES: ReadonlySet<string> = new Set(['rejected', 'reversed']);

export function classifyAdjustment(
  adjustment: AdjustmentRecord,
  current: {
    /** The transaction that bought the current period, if we know it. */
    chargedTransactionId: string | null | undefined;
    /** Which adjustment last revoked access, if any. */
    refundAdjustmentId: string | null | undefined;
    /** What that adjustment WAS, which decides how it can be undone. */
    refundAction: string | null | undefined;
  },
): RefundVerdict {
  /**
   * A chargeback reversal restores, and it CANNOT be matched on the adjustment
   * id the way a refund's own reversal is.
   *
   * A refund goes `approved` then `reversed` as ONE adjustment, so the id test
   * below is what stops a second, rejected request clearing the first one's
   * marker. A chargeback reversal is a SEPARATE adjustment with its own id, so
   * that same test would refuse every legitimate one and leave a customer gated
   * after we had already been paid back. Matching on the stored action instead
   * is both sufficient and safe: only a chargeback can be chargeback-reversed.
   */
  if (RESTORING_ACTIONS.has(adjustment.action)) {
    if (current.refundAction === 'chargeback') {
      return { kind: 'clear', reason: `undone:${adjustment.action}` };
    }
    return { kind: 'record_only', reason: `undone_nothing:${adjustment.action}` };
  }

  if (!REVOKING_ACTIONS.has(adjustment.action)) {
    // A credit is money applied to a future invoice, and a chargeback warning is
    // a bank's notice that no money has acted on. Recorded and attributed so an
    // operator can see them, and never reaching entitlement.
    return { kind: 'record_only', reason: `action:${adjustment.action}` };
  }

  if (UNDOING_STATUSES.has(adjustment.status)) {
    /**
     * Only the adjustment that revoked access may restore it.
     *
     * Without the id test, another request could clear the marker: a
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
   * A NULL type with no items is treated as complete, deliberately. It means we
   * could not read the labels, and the two failure directions are not
   * symmetric: treating an unknown refund as partial leaves a customer whose
   * money we returned still being served, while treating it as complete gates
   * someone an operator can put back in one action. Err toward gating.
   */
  if (!adjustmentIsComplete(adjustment)) {
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
