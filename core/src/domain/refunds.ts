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
  /**
   * Paddle's top-level label, 'full' or 'partial'. **Not sufficient on its own,
   * and believing it was is the worst mistake in this file's history.**
   *
   * It describes HOW the adjustment was created, not whether it is economically
   * complete. An adjustment made item-scoped from the Paddle dashboard, which is
   * how the only real refund in production was made, carries `partial` at the
   * top level while refunding the entire charge. See {@link adjustmentIsComplete}.
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
 * Actions that take money we had, and so must stop paid service.
 *
 * **A chargeback gates, exactly like a refund** (decision, 2026-08-31). We are
 * not being paid, so paid service stops, or the invariant in §1 is broken in the
 * direction that costs us. Two things make that fair rather than punitive: it
 * goes through `guildFloor`, so a free-sized server stays free and an unconsumed
 * trial resumes and nobody loses anything they would have had without paying;
 * and a reversal restores it immediately, so a customer whose card was used
 * fraudulently by someone else is not left worse off once the dispute settles.
 *
 * Before this a chargeback reached no branch at all, which meant it left service
 * running while the money and Paddle's dispute fee were both gone.
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
 * Whether an adjustment returns the WHOLE charge, as opposed to part of it.
 *
 * **The top-level `type` cannot answer this alone.** Verified against the one
 * real refund in production (adjustment `adj_01kzvab95th397pt0kjev05169`): top
 * level `partial`, one item of `type: 'full'` for `3900`, against a
 * `charged_total` of `3900`. A complete refund of the entire charge, labelled
 * partial because it was created item-scoped from the Paddle dashboard, which is
 * how an operator makes one and therefore the only route ever used. Reading the
 * top-level label alone classified it as goodwill and gated nothing.
 *
 * So: complete when Paddle says so at the top level, OR when every line item it
 * names is itself `full`.
 *
 * **The assumption that makes the second clause sound is one line item per
 * transaction**, which holds by construction here: one subscription is one tier
 * is one price, and `chargedTotalsOf` already relies on it ("the first line item
 * is the price charged"). A multi-line transaction could name one of several
 * items as `full` and read as complete when it is not. Nothing in this product
 * creates one, and the fix if that changes is to compare the item count against
 * the transaction's, NOT to start comparing amounts, which §7.1 rejects for five
 * separate reasons that all still hold.
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
