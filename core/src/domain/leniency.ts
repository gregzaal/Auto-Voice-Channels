import { ENTITLED_STATUSES, type AuthStatus } from './auth.js';
import type { MemberCountSample } from './billing.js';
import {
  compareTiers,
  tierById,
  tierFor,
  TIERS,
  trialDurationMs,
  trialPolicyFor,
  type TierId,
} from './tiers.js';

/**
 * The standardized leniency model — a single, pure state
 * machine governing every "you need to pay / pay more" situation:
 *
 * 1. trial expiry (the applicable trial window is up),
 * 2. tier over-limit (member count outgrew the current paid tier),
 * 3. payment failure (Paddle dunning; the webhook moves the guild to `grace`,
 *    this machine only advances/ends the window).
 *
 * The ladder: advance warnings (T−30/7/1) → `grace` (fully working, ~60 days,
 * weekly nudges) → `expired` (hard gate, non-destructive) → reactivation at any
 * time. `evaluateLeniency` is pure: it inspects a guild's billing state at
 * `now` and returns at most one transition plus the notifications due — the
 * reconcile job applies them after reserving a run (with member-count validation
 * first) and records notification keys for dedupe.
 */

export interface LeniencyConfig {
  /** Grace window length in days (runtime-flags tunable; default 60). */
  graceDays: number;
  /**
   * Grace window for a MONTHLY subscription (default 14).
   *
   * 60 days is sized for an annual subscription. On a monthly one it is two
   * free months after a single paid month, which is the whole reason this
   * exists. Read only through {@link graceDaysFor}, never directly, so the two
   * drivers of the ladder cannot pick different windows for the same lapse.
   */
  graceDaysMonthly: number;
  /** Consecutive daily over-limit samples before the grace clock starts (default 7). */
  upgradeBreachSamples: number;
  /** Consecutive daily under-limit samples before a downgrade is offered (default 30). */
  downgradeDropSamples: number;
  /** Advance-warning offsets in days before the window ends, descending. */
  warnDaysBefore: readonly number[];
  /** Compressed warning offsets for short (14-day) trials. */
  shortWarnDaysBefore: readonly number[];
  /** Days between grace-period nudges (default 7 — weekly). */
  graceNudgeDays: number;
  /**
   * Hold ordinary grace-to-expired advancement while continuing notices.
   * Refund-floor transitions are independent of this hold.
   */
  hardGateDisabled: boolean;
}

export const DEFAULT_LENIENCY_CONFIG: LeniencyConfig = {
  graceDays: 60,
  graceDaysMonthly: 14,
  upgradeBreachSamples: 7,
  downgradeDropSamples: 30,
  warnDaysBefore: [30, 7, 1],
  /**
   * `[14, 7, 1]`, not `[7, 2, 1]`, because the short trial is now 30 days.
   *
   * The selector below picks these for any window of 30 days or less, so the
   * old offsets would leave a 30-day trial silent for 23 days and then warn at
   * T-7, under a pricing page that promises T-30. Only the most imminent unsent offset ever
   * fires, so widening the first one bursts nothing.
   */
  shortWarnDaysBefore: [14, 7, 1],
  graceNudgeDays: 7,
  hardGateDisabled: false,
};

/** A guild's billing-relevant state, as read from `guilds` + its metadata. */
export interface LeniencyState {
  authStatus: AuthStatus;
  authExpiresAt: Date | null;
  graceUntil: Date | null;
  /** Billed tier (what the subscription covers); null = no subscription. */
  billedTier: TierId | null;
  /**
   * Whether a Paddle subscription row exists for the guild at all. Distinct
   * from {@link subscriptionOk}: a bespoke XXL arrangement is entitled with no
   * subscription row, and must not be mistaken for a failed payment.
   */
  hasSubscription: boolean;
  /** Whether the Paddle subscription is in good standing (false during dunning). */
  subscriptionOk: boolean;
  /**
   * Whether that subscription has never taken a payment, from the absence of
   * every charge marker on the row (`charged_total`, `charged_at`,
   * `first_charged_at`).
   *
   * Read only by the trial-resume branch in {@link evaluateActive}. Optional,
   * and its absence means "assume it charged": callers without this field
   * keep the ordinary grace behaviour, which
   * is the safe direction, since the alternative default hands free months to
   * anybody whose renewal fails inside their own trial window.
   */
  subscriptionNeverCharged?: boolean | undefined;
  /**
   * The subscription's billing interval, from `subscriptions.billing_interval`
   * (Paddle's own `billing_cycle.interval`).
   *
   * Deliberately a loose `string` rather than a union: it arrives from a `text`
   * column and from a third-party payload, and the one thing this must never do
   * is throw or narrow wrongly on a value neither side anticipated.
   * {@link graceDaysFor} recognises exactly `'month'` and treats everything
   * else, absent included, as annual.
   */
  billingInterval?: string | null | undefined;
  /** Latest member-count sample (a hint — transitions re-validate via REST). */
  memberCount: number | null;
  /**
   * The pooled member-count sum, when this state represents a member pool
   * rather than a single guild. Takes
   * priority over {@link memberCount} in {@link requiredTierOf} when present.
   * Every other field on this interface keeps meaning exactly what it already
   * means: a pool's own `authStatus`/`graceUntil`/`samples`/`notifications`,
   * not any one member guild's. `evaluateLeniency` itself is unaware pools
   * exist — this is the one seam through which the pool pass drives the same
   * pure machine that already runs the per-guild ladder.
   */
  pooledMemberCount?: number | null;
  /** Rolling daily samples, oldest → newest. */
  samples: readonly MemberCountSample[];
  /** When the guild row was created (≈ when the bot was first added). */
  guildCreatedAt: Date | null;
  /** Notification dedupe map: key → ISO timestamp of last delivery. */
  notifications: Readonly<Record<string, string>>;
}

export type LeniencyNotificationKind =
  | 'trial_warning'
  | 'grace_started'
  | 'grace_nudge'
  | 'hard_gate'
  | 'reactivated'
  | 'grew_into_xxl';

export interface LeniencyNotification {
  /** Dedupe key, recorded in guild metadata once delivered. */
  key: string;
  kind: LeniencyNotificationKind;
  /** Days until the relevant window ends (warnings/nudges). */
  daysLeft?: number;
  /** The tier the guild's size now requires (over-limit / warnings). */
  requiredTier?: TierId;
  /** Why the notification fired (e.g. 'trial_expired', 'over_limit'). */
  reason?: string;
}

export interface LeniencyTransition {
  toStatus: AuthStatus;
  reason: string;
  /** New grace window end (null clears it). Omitted = leave unchanged. */
  graceUntil?: Date | null;
  /**
   * Billing-affecting transitions whose premise rests on the member count must
   * be confirmed with a fresh authoritative REST read first.
   */
  requiresCountValidation: boolean;
}

export interface LeniencyDecision {
  transition?: LeniencyTransition;
  notifications: LeniencyNotification[];
}

const DAY_MS = 86_400_000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysLeft(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY_MS));
}

/**
 * True when the last `n` daily samples all sit at/above `ceiling` (the
 * sustained-breach anti-flap rule — a raid or one-off spike never triggers
 * billing changes). Requires at least `n` samples.
 */
export function sustainedBreach(
  samples: readonly MemberCountSample[],
  ceiling: number,
  n: number,
): boolean {
  if (samples.length < n) return false;
  return samples.slice(-n).every((s) => s.count >= ceiling);
}

/**
 * True when the last `n` daily samples all sit strictly below `ceiling` (the
 * longer sustained-drop hysteresis for downgrade offers).
 */
export function sustainedDrop(
  samples: readonly MemberCountSample[],
  ceiling: number,
  n: number,
): boolean {
  if (samples.length < n) return false;
  return samples.slice(-n).every((s) => s.count < ceiling);
}

/**
 * Evaluates the leniency ladder for one guild. Pure — no clock, no I/O; the
 * caller supplies `now` and applies the returned transition/notifications.
 * `blocked` guilds are never touched (the kill-switch outranks billing).
 */
export function evaluateLeniency(
  state: LeniencyState,
  now: Date,
  config: LeniencyConfig = DEFAULT_LENIENCY_CONFIG,
): LeniencyDecision {
  switch (state.authStatus) {
    case 'blocked':
      return { notifications: [] };
    case 'active':
      return evaluateActive(state, now, config);
    case 'trial':
      return evaluateTrial(state, now, config);
    case 'grace':
      return evaluateGrace(state, now, config);
    case 'expired':
      return evaluateExpired(state);
  }
}

function requiredTierOf(state: LeniencyState) {
  return tierFor(state.pooledMemberCount ?? state.memberCount ?? 0);
}

function alreadySent(state: LeniencyState, key: string): boolean {
  return state.notifications[key] !== undefined;
}

/**
 * Whether a lapsed subscription should hand a server back to its own trial
 * instead of opening a grace window.
 *
 * **TWO facts, and needing both is the whole correctness of it.** An earlier
 * version asked only whether `auth_expires_at` was still in the future, on the
 * reasoning that a renewal is by definition a year past the trial deadline so
 * the branch could never fire for one. **That reasoning was wrong**, and an
 * adversarial review found it: Rare is the one tier with a one-YEAR trial and a
 * MONTHLY price, so a customer who subscribes monthly on day 10 of a 365-day
 * trial, pays one month, and then has month two decline is an ordinary dunning
 * case sitting 325 days inside its own trial window. The date test alone sent
 * them back to `trial` for those 325 days, silently (this branch sends no
 * notification, by design) and with the dashboard reading "free trial" rather
 * than "payment failed". One $3 charge for eleven free months.
 *
 * So the money fact is required too: this only ever applies to a subscription
 * that has NEVER charged, which is exactly the case it was written for, a
 * checkout completed during a trial and cancelled before the first charge.
 * `subscriptionNeverCharged` is opt-in and its absence means "assume it
 * charged", so any caller that has not been taught about it keeps the ordinary
 * grace behaviour rather than silently handing out free time.
 *
 * Shared by the two drivers of the ladder ({@link evaluateActive} here, and
 * `transitionFor` in the web app's `paddle/sync.ts`) so they cannot reach
 * different answers about the same server, and shared as ONE predicate over
 * both facts rather than a date test each site combines with its own money
 * test, which is how they would drift. Which driver sees a lapse first is a
 * race: the hourly tick and the Paddle webhook both act on it.
 */
/**
 * How long a grace window should be for THIS subscription.
 *
 * **Absent or unrecognised means ANNUAL, and that direction is the whole safety
 * of it.** Reading an unknown interval as monthly would gate a customer who
 * paid for a year 46 days early, which is service they have already bought.
 * Reading it as annual costs at most two months of a $3-to-$32 subscription,
 * and Paddle's dunning usually resolves or cancels inside two weeks anyway. So
 * the fallback is the generous one.
 *
 * That is the opposite polarity from `subscriptionNeverCharged`, whose absence
 * means "assume it charged", and the two only look inconsistent until the
 * shared rule is stated: **a default must never take service away from someone
 * who might have paid for it.** For the charge markers that means assuming
 * money moved. Here it means assuming the longer window.
 *
 * Exported because both drivers of the ladder need the same answer.
 * {@link evaluateActive} and `transitionFor` in the web app's `paddle/sync.ts`
 * both open grace windows, and whichever sees a lapse first decides, so a
 * per-caller copy of this arithmetic is a race with two outcomes rather than
 * one rule.
 */
export function graceDaysFor(
  state: { billingInterval?: string | null | undefined },
  config: { graceDays: number; graceDaysMonthly: number },
): number {
  return state.billingInterval === 'month' ? config.graceDaysMonthly : config.graceDays;
}

export function resumesUnconsumedTrial(
  input: {
    authExpiresAt?: Date | null | undefined;
    /** Whether NO `transaction.completed` has ever landed for this subscription. */
    subscriptionNeverCharged?: boolean | undefined;
  },
  now: Date,
): boolean {
  // Explicitly `!== true`, not a bare falsy test: absent must mean "assume it
  // charged", which is the direction that costs nothing if a caller forgets.
  if (input.subscriptionNeverCharged !== true) return false;
  return Boolean(input.authExpiresAt && input.authExpiresAt.getTime() > now.getTime());
}

function evaluateActive(state: LeniencyState, now: Date, config: LeniencyConfig): LeniencyDecision {
  const required = requiredTierOf(state);

  // Dunning backstop. The Paddle webhook normally moves a failing subscription
  // into grace the moment it hears about it; this converges the same way when
  // that delivery was missed or arrived while we were down, so a guild can
  // never sit `active` forever behind a subscription that stopped paying.
  // Guarded on a subscription actually existing — a manually arranged guild
  // (no Paddle row) is entitled by agreement, not by a payment we can see.
  if (state.hasSubscription && !state.subscriptionOk) {
    /**
     * An unconsumed trial resumes on its ORIGINAL date instead of being
     * replaced by a grace window, which is the same rule `guildFloor`'s
     * `floor_trial` rung already applies to refunds and pool exits: a server
     * must never be left worse off than if it had never subscribed.
     *
     * The case that made this urgent is "subscribe during your trial, then
     * cancel". Nothing has been charged, so
     * the counterfactual is plainly the trial they still hold, and a 60-day
     * grace window in its place silently eats up to a year of it. The defect
     * predates trial-subscribe (a charge-now subscribe followed by a cancel
     * does the same thing), but that release is what invites the whole trialing
     * base onto the path, so it ships with the fix.
     *
     * **No notification**, deliberately. Nothing about the server's service
     * changed, the trial ladder's own T-30/7/1 warnings resume by themselves,
     * and the subscription ending is something Paddle emails about directly. A
     * notification here would say "nothing happened to you". That silence is
     * also why {@link resumesUnconsumedTrial} has to require the money fact:
     * applied to a customer whose card had failed, this branch would hide a
     * real dunning state behind "free trial" and tell them nothing.
     *
     * There is no exploit in the generous direction: a subscription that never
     * charged leaves the server exactly the free time it already had and not a
     * day more. A subscription that DID charge is excluded by the predicate,
     * which is the half this branch originally got wrong.
     */
    if (resumesUnconsumedTrial(state, now)) {
      return {
        transition: {
          toStatus: 'trial',
          reason: 'subscription_lapsed_trial_resumes',
          graceUntil: null,
          requiresCountValidation: false,
        },
        notifications: [],
      };
    }
    // Sized to what they actually bought. The notification quotes the
    // same number, so the message and the deadline cannot disagree.
    const lapsedGraceDays = graceDaysFor(state, config);
    return {
      transition: {
        toStatus: 'grace',
        reason: 'subscription_lapsed',
        graceUntil: addDays(now, lapsedGraceDays),
        requiresCountValidation: false,
      },
      notifications: [
        {
          key: 'grace_started:subscription_lapsed',
          kind: 'grace_started',
          reason: 'subscription_lapsed',
          requiredTier: required.id,
          daysLeft: lapsedGraceDays,
        },
      ],
    };
  }

  // Over-limit: the guild outgrew what it pays for, sustained across the
  // breach window → start the grace clock. (Never the other way: a guild may
  // hold any tier at or above its required tier — voluntary over-provisioning
  // is simply not prevented.)
  if (
    state.billedTier &&
    compareTiers(required.id, state.billedTier) > 0 &&
    sustainedBreach(
      state.samples,
      tierById(state.billedTier).maxExclusive,
      config.upgradeBreachSamples,
    )
  ) {
    /**
     * **Flat `graceDays`, and NOT interval-aware. Do not "finish the job" by
     * routing this through {@link graceDaysFor}.**
     *
     * It was written that way and an adversarial review caught it. The
     * commercial argument is real (60 days of over-limit grace on a monthly
     * subscription is two months of serving a tier the customer is not paying
     * for) and it loses to a promise already in force: Terms §5 and
     * `/docs/billing` both say that if servers grow past a tier's ceiling
     * "nothing changes for 60 days", with no carve-out for how often you are
     * billed. Interval-aware grace applies only to payment failure.
     *
     * Shortening this needs the Terms sentence changed first, which is a change
     * to a live agreement rather than a code decision.
     */
    const graceUntil = addDays(now, config.graceDays);
    return {
      transition: {
        toStatus: 'grace',
        reason: 'over_limit',
        graceUntil,
        requiresCountValidation: true,
      },
      notifications: [
        {
          key: `grace_started:over_limit:${required.id}`,
          kind: 'grace_started',
          reason: 'over_limit',
          requiredTier: required.id,
          daysLeft: config.graceDays,
        },
      ],
    };
  }
  return { notifications: [] };
}

function evaluateTrial(state: LeniencyState, now: Date, config: LeniencyConfig): LeniencyDecision {
  const required = requiredTierOf(state);
  const notifications: LeniencyNotification[] = [];

  // Free forever (<100 members): the trial clock keeps running but is dormant —
  // nothing expires, nothing warns, even if the window date has passed.
  if (required.id === 'free') return { notifications };

  /**
   * Growing into the top, hard-gated tier during a trial: a leniency-model
   * tier transition, so we reach out to arrange it and the trial window itself
   * is untouched. One-time heads-up once the breach is sustained.
   *
   * **The floor is derived from the table, never named by id.** Naming the
   * second tier (`tierById('mythic')`) is how this branch would go silently
   * dead at the next repricing: `tierById` of an id `TIERS` no longer prices
   * answers with the TOP tier, whose ceiling is `Infinity`, and no breach can
   * ever exceed that. The same trap already cost this branch once, when the
   * rarity ladder retired `xl`.
   *
   * **The dedupe key keeps its `_xxl` name deliberately.** It is stored text
   * in `metadata.billing.notified` and `billing_notifications.key`, so
   * renaming it would strand queued rows during a rolling deploy. The copy
   * follows the current top tier while the persisted key stays compatible.
   */
  const topTier = TIERS[TIERS.length - 1]!;
  const topTierFloor = TIERS[TIERS.length - 2]?.maxExclusive ?? Number.POSITIVE_INFINITY;
  if (
    required.id === topTier.id &&
    sustainedBreach(state.samples, topTierFloor, config.upgradeBreachSamples) &&
    !alreadySent(state, 'grew_into_xxl')
  ) {
    notifications.push({ key: 'grew_into_xxl', kind: 'grew_into_xxl', requiredTier: topTier.id });
  }

  const expiresAt = state.authExpiresAt;
  // No window yet — the reconcile job backfills it before evaluating; nothing
  // time-based can run without one.
  if (!expiresAt) return { notifications };

  if (now.getTime() >= expiresAt.getTime()) {
    // Window over → grace. The grace clock starts at detection (not at the
    // window end), which is identical in steady state — the job runs hourly —
    // and strictly more lenient after downtime or a late free→paid crossing.
    const graceUntil = addDays(now, config.graceDays);
    notifications.push({
      key: `grace_started:trial_expired:${expiresAt.toISOString()}`,
      kind: 'grace_started',
      reason: 'trial_expired',
      requiredTier: required.id,
      daysLeft: config.graceDays,
    });
    return {
      transition: {
        toStatus: 'grace',
        reason: 'trial_expired',
        graceUntil,
        requiresCountValidation: true,
      },
      notifications,
    };
  }

  // Advance warnings. Pick the compressed set for short (≤30-day) windows.
  // Only the most imminent unsent offset fires, so a guild that slept through
  // T−30 gets one warning at T−7, not a burst of three.
  const windowDays = trialWindowDays(state, expiresAt);
  const offsets =
    windowDays !== null && windowDays <= 30 ? config.shortWarnDaysBefore : config.warnDaysBefore;
  const eligible = [...offsets]
    .sort((a, b) => a - b)
    .find((offset) => now.getTime() >= expiresAt.getTime() - offset * DAY_MS);
  if (eligible !== undefined) {
    const key = `trial_warning:${eligible}:${expiresAt.toISOString()}`;
    if (!alreadySent(state, key)) {
      notifications.push({
        key,
        kind: 'trial_warning',
        daysLeft: daysLeft(expiresAt, now),
        requiredTier: required.id,
      });
    }
  }
  return { notifications };
}

/** Approximate trial window length in days, to pick the warning cadence. */
function trialWindowDays(state: LeniencyState, expiresAt: Date): number | null {
  // The window is set relative to the guild row's creation (bot-add time), so
  // `expiresAt − createdAt` recovers its length; fall back to "long" if unknown.
  if (!state.guildCreatedAt) return null;
  return Math.round((expiresAt.getTime() - state.guildCreatedAt.getTime()) / DAY_MS);
}

/**
 * Sustained-under check for leaving grace on a member-count premise.
 * Billing-affecting transitions require validation in both directions. Uses
 * the long downgrade window, relaxed to the available history but never below
 * the upgrade window — so a one-day dip can never reset the grace clock,
 * while a guild whose entire (≥7-day) history sits under the ceiling (e.g.
 * after a subscription upgrade) exits promptly.
 */
function sustainedUnder(state: LeniencyState, ceiling: number, config: LeniencyConfig): boolean {
  const n = Math.min(
    config.downgradeDropSamples,
    Math.max(config.upgradeBreachSamples, state.samples.length),
  );
  return sustainedDrop(state.samples, ceiling, n);
}

/**
 * Reconstructs the grace_started dedupe key for a guild already in grace, so
 * an undelivered grace-entry notice keeps re-emitting until it lands (keys
 * are recorded only on successful delivery — a transition fires once, but
 * its notice must not be lost to one failed send).
 */
function expectedGraceStarted(
  state: LeniencyState,
  now: Date,
): { key: string; reason: string } | undefined {
  const required = requiredTierOf(state);
  if (state.billedTier && compareTiers(required.id, state.billedTier) > 0) {
    return { key: `grace_started:over_limit:${required.id}`, reason: 'over_limit' };
  }
  // Dunning, whether the Paddle webhook put the guild here or the backstop in
  // `evaluateActive` did. The webhook only moves the row; the admin-facing
  // notice is always this machine's job, so it belongs here rather than being
  // lost between the two paths.
  if (state.hasSubscription && !state.subscriptionOk) {
    return { key: 'grace_started:subscription_lapsed', reason: 'subscription_lapsed' };
  }
  if (state.authExpiresAt && state.authExpiresAt.getTime() <= now.getTime()) {
    return {
      key: `grace_started:trial_expired:${state.authExpiresAt.toISOString()}`,
      reason: 'trial_expired',
    };
  }
  return undefined;
}

function evaluateGrace(state: LeniencyState, now: Date, config: LeniencyConfig): LeniencyDecision {
  const required = requiredTierOf(state);

  // Reactivation paths. In grace, service was never interrupted — the only
  // effect of leaving is clearing the deadline — so member-count-premised
  // exits need sustained-drop hysteresis: a one-day dip below the
  // ceiling must never reset the grace clock (else a guild could dodge the
  // ladder forever by shedding members for a day each cycle).
  if (required.id === 'free' && sustainedUnder(state, tierById('free').maxExclusive, config)) {
    return {
      transition: {
        toStatus: 'trial',
        reason: 'shrunk_to_free',
        graceUntil: null,
        requiresCountValidation: true,
      },
      notifications: [
        { key: `reactivated:free:${utcDay(now)}`, kind: 'reactivated', reason: 'shrunk_to_free' },
      ],
    };
  }
  if (
    state.billedTier &&
    state.subscriptionOk &&
    compareTiers(required.id, state.billedTier) <= 0 &&
    sustainedUnder(state, tierById(state.billedTier).maxExclusive, config)
  ) {
    return {
      transition: {
        toStatus: 'active',
        reason: 'within_billed_tier',
        graceUntil: null,
        requiresCountValidation: true,
      },
      notifications: [
        {
          key: `reactivated:active:${utcDay(now)}`,
          kind: 'reactivated',
          reason: 'within_billed_tier',
        },
      ],
    };
  }

  // Defensive: a grace guild with no recorded window gets one from now.
  if (!state.graceUntil) {
    return {
      transition: {
        toStatus: 'grace',
        reason: 'grace_backfill',
        graceUntil: addDays(now, graceDaysFor(state, config)),
        requiresCountValidation: false,
      },
      notifications: [],
    };
  }

  if (now.getTime() >= state.graceUntil.getTime()) {
    if (config.hardGateDisabled) return { notifications: [] };
    return {
      transition: {
        toStatus: 'expired',
        reason: 'grace_elapsed',
        graceUntil: null,
        requiresCountValidation: true,
      },
      notifications: [{ key: 'hard_gate', kind: 'hard_gate', requiredTier: required.id }],
    };
  }

  // The grace-entry notice retries until delivered (its key is only recorded
  // on a successful send); nudges start once it has landed.
  const graceStarted = expectedGraceStarted(state, now);
  if (graceStarted && !alreadySent(state, graceStarted.key)) {
    return {
      notifications: [
        {
          key: graceStarted.key,
          kind: 'grace_started',
          reason: graceStarted.reason,
          requiredTier: required.id,
          daysLeft: daysLeft(state.graceUntil, now),
        },
      ],
    };
  }

  // Weekly nudge while in grace. The key is stable; the job refreshes its
  // timestamp on every delivery, so "already sent" here means "sent recently".
  const lastNudge = state.notifications['grace_nudge'];
  /**
   * The window this guild actually got, not the annual one. Reading
   * `config.graceDays` here put `graceStart` 46 days in the PAST for a guild on
   * a 14-day window, so `lastTouch` was already older than the nudge interval
   * and the first weekly nudge fired on the very next hourly tick. Found by an
   * adversarial review, three lines after the docstring that says this field is
   * only ever read through {@link graceDaysFor}.
   */
  const graceStart = addDays(state.graceUntil, -graceDaysFor(state, config));
  const lastTouch = lastNudge ? Date.parse(lastNudge) : graceStart.getTime();
  if (!Number.isNaN(lastTouch) && now.getTime() - lastTouch >= config.graceNudgeDays * DAY_MS) {
    return {
      notifications: [
        {
          key: 'grace_nudge',
          kind: 'grace_nudge',
          daysLeft: daysLeft(state.graceUntil, now),
          requiredTier: required.id,
        },
      ],
    };
  }
  return { notifications: [] };
}

function evaluateExpired(state: LeniencyState): LeniencyDecision {
  const required = requiredTierOf(state);
  // Shrinking back under the free line restores service (dormant trial).
  if (required.id === 'free') {
    /**
     * ...but a POOL with nothing billable left is not a free server, and must
     * not reactivate itself off a dead subscription.
     *
     * `requiredTierOf` reads `pooledMemberCount` first, so a pool whose
     * billable set empties for one tick, by shrinkage or because the customer
     * removed their servers, lands here. `advancePool` maps `trial` to
     * `active` for pools, so the pool promoted itself back to entitling and
     * fanned a reactivation notice to every member, on a subscription that had
     * been refunded. One tick was enough, since this branch has no hysteresis.
     *
     * Scoped to the pool axis deliberately. On the guild axis this branch IS
     * the free-forever promise (`/docs/billing`: "free forever whether or not
     * it shares a subscription"), so it must keep firing for a server that
     * genuinely shrank, whatever its subscription is doing. `pooledMemberCount`
     * is the documented seam between the two, and a pool always sets it.
     *
     * Adding `sustainedUnder` hysteresis here as well was considered and NOT
     * done: on the guild axis it would delay restoring a promise we advertise
     * as immediate, which is worse for the customer than today.
     */
    const isPool = state.pooledMemberCount !== undefined;
    if (isPool && state.hasSubscription && !state.subscriptionOk) {
      return { notifications: [] };
    }
    return {
      transition: {
        toStatus: 'trial',
        reason: 'shrunk_to_free',
        graceUntil: null,
        requiresCountValidation: true,
      },
      notifications: [
        { key: 'reactivated:free:expired', kind: 'reactivated', reason: 'shrunk_to_free' },
      ],
    };
  }
  // A subscription covering the required tier reactivates (the Paddle webhook
  // normally does this directly; this is the convergent backstop).
  if (
    state.billedTier &&
    state.subscriptionOk &&
    compareTiers(required.id, state.billedTier) <= 0
  ) {
    return {
      transition: {
        toStatus: 'active',
        reason: 'resubscribed',
        graceUntil: null,
        requiresCountValidation: false,
      },
      notifications: [
        { key: 'reactivated:active:expired', kind: 'reactivated', reason: 'resubscribed' },
      ],
    };
  }
  // The hard gate promises a ONE-TIME admin notification — re-emit it until
  // a delivery succeeds. Only for guilds that actually walked the ladder
  // (grace evidence in the dedupe map): a guild hard-gated at join time (XXL)
  // was already messaged by onboarding and must not get a "grace ended" notice.
  const keys = Object.keys(state.notifications);
  const walkedLadder = keys.some((k) => k.startsWith('grace_'));
  const hardGateSent = keys.some((k) => k.startsWith('hard_gate'));
  if (walkedLadder && !hardGateSent) {
    return {
      notifications: [{ key: 'hard_gate', kind: 'hard_gate', requiredTier: required.id }],
    };
  }
  return { notifications: [] };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * What state a server would have been in **if the payment had never happened**.
 *
 * The question every caller here used to ask was "what
 * state does this event produce", which is why a refund could leave a server
 * worse off than never having paid: `applyRefund` wrote `expired` while
 * `auth_expires_at` still held an unconsumed trial deadline, because that column
 * is never rewritten when a trial converts.
 *
 * **The comparison lives inside this function on purpose.** The first design
 * returned a floor and left "apply it only where the computed transition would
 * be worse" as prose at four call sites. That is not a definable order: `grace`
 * against `trial` inverts depending on `hard_gate_disabled`, two callers needed
 * opposite answers from that same pair, and `blocked` was not representable in
 * the signature at all, so each caller had to remember it separately. One of
 * them already forgot. Returning null for "do nothing" makes the whole rule
 * testable in one place.
 *
 * Two rules keep it convergent, and they are why the return shape is what it is:
 *
 * - **Never a clock-derived deadline.** `now + duration` differs from the row it
 *   just wrote on every tick, so it would write forever.
 * - **Never a bare `expiresAt`.** The set-if-null form is one-shot by
 *   construction, because the update becomes empty once the column is non-null
 *   and `transitionAuth`'s skip test reads exactly that emptiness. An earlier
 *   version of this rule forbade both, which would have forbidden the backfill
 *   rung below.
 */
export function guildFloor(
  guild: {
    authStatus: AuthStatus;
    memberCount: number | null;
    authExpiresAt: Date | null;
    /** When the bot was first added, the only honest basis for a missing deadline. */
    createdAt: Date | null;
  },
  now: Date,
): { toStatus: AuthStatus; reason: string; expiresAtIfNull?: Date } | null {
  // `blocked` outranks billing everywhere, guarded once here instead of four
  // times at the call sites.
  if (guild.authStatus === 'blocked') return null;

  const floor = floorRung(guild, now);
  const currentlyEntitled = ENTITLED_STATUSES.has(guild.authStatus);
  const floorEntitled = ENTITLED_STATUSES.has(floor.toStatus);

  /**
   * Both entitled: refuse to choose, and this is the resolution of the
   * ambiguity rather than a dodge. No harm is being done, so there is nothing
   * for a floor to fix, and the server's own ladder is the right authority for
   * what happens next. It also deletes the first design's "a member keeps its
   * grace window" deviation, which was the same defect seen from the other side.
   */
  if (currentlyEntitled && floorEntitled) return null;

  // Entitled, floor is not: revoke. The row the first design got wrong, because
  // its branch fired only for a server reading `active`, and a pooled server
  // almost never is.
  if (currentlyEntitled && !floorEntitled) return floor;

  // Not entitled, floor is: lift. Repairs rows already wrong in the database,
  // which is what makes a rollback of this recoverable in both directions.
  if (!currentlyEntitled && floorEntitled) return floor;

  return null;
}

/** The floor status itself, before any comparison with where the server is now. */
function floorRung(
  guild: { memberCount: number | null; authExpiresAt: Date | null; createdAt: Date | null },
  now: Date,
): { toStatus: AuthStatus; reason: string; expiresAtIfNull?: Date } {
  // Free-forever, whatever anybody paid. `/docs/billing` promises this
  // regardless of whether the server shares a subscription.
  if (tierFor(guild.memberCount ?? 0).id === 'free') {
    return { toStatus: 'trial', reason: 'floor_free' };
  }

  // An unconsumed trial resumes on its ORIGINAL date. No expiry is passed, so
  // the column is left exactly as it is: that is the entire mechanism.
  if (guild.authExpiresAt && guild.authExpiresAt.getTime() > now.getTime()) {
    return { toStatus: 'trial', reason: 'floor_trial' };
  }

  /**
   * A null deadline is NOT a spent trial, and reading it as one was a defect.
   *
   * `advanceGuild`'s own backfill is gated on the server already being `trial`,
   * so an `expired` server never got the window it was owed and there was no
   * edge out. `{active, null}` is also the STABLE state for any server pooled
   * before that hourly backfill first ran, so this is a population rather than
   * an edge case. Note the asymmetry it removes: an unknown member count already
   * took the most generous rung, while an unknown deadline took the harshest.
   */
  if (!guild.authExpiresAt && guild.createdAt) {
    const duration = trialDurationMs(trialPolicyFor(guild.memberCount ?? 0));
    if (duration !== null) {
      return {
        toStatus: 'trial',
        reason: 'floor_trial_backfill',
        expiresAtIfNull: new Date(guild.createdAt.getTime() + duration),
      };
    }
  }

  return { toStatus: 'expired', reason: 'floor_expired' };
}

/**
 * Whether leaving a pool should grant the exiting guild an entitled window at
 * all. Shared by every caller, because they had already diverged once.
 *
 * `poolExitTransition` reads only the member count, so
 * it hands out `grace` plus a fresh 60 days regardless of whether anything is
 * still paying. If `billing.hard_gate_disabled` is set, that window never
 * closes through ordinary ladder advancement. Two ways that was exploitable, and a third the first
 * fix created:
 *
 *  - **Refunded and emptied.** Buy a multi-server subscription, refund it, then
 *    remove each server: every one lands entitled indefinitely.
 *  - **Kicked and re-invited.** The `guildDelete` path does the same thing with
 *    no site login at all, which made it the cheaper route.
 *  - **Farmed.** Once a removed membership could be re-added, add and
 *    remove the same server every 59 days to renew its window forever.
 *
 * So: no grant while the pool cannot entitle anything, and never an extension of
 * a window that is already open, which is the same rule the Paddle-side
 * `transitionFor` follows for dunning.
 *
 * **Refuse the grant, never the removal.** An earlier pass refused the whole
 * removal on a dead pool, which stranded the server: nothing else can move a
 * guild off a pool, and `createPool` refuses any guild with a live membership
 * whatever the pool's status, so a refunded customer could not remove, re-add or
 * re-buy. Removing without granting leaves the guild exactly as it was, which
 * for a gated member is gated, and frees it to buy its own subscription.
 */
export function shouldGrantPoolExit(
  guild: { authStatus: AuthStatus; graceUntil: Date | null },
  pool: { status: string } | null | undefined,
  now: Date,
): boolean {
  // `blocked` outranks billing everywhere, and neither caller's own guard is a
  // substitute for this one being right.
  if (guild.authStatus === 'blocked') return false;
  if (pool?.status === 'expired') return false;
  const graceOpen =
    guild.authStatus === 'grace' && guild.graceUntil !== null && guild.graceUntil > now;
  return !graceOpen;
}

/**
 * What a guild's own state should become on leaving a pool: never a silent `expired`, and never
 * merely an absence of a transition. `evaluateExpired`'s machine has no
 * `expired -> trial`/`grace` edge except `shrunk_to_free`, so a guild removed
 * from a lapsed (or simply left) pool with no explicit handling is stranded
 * hard-gated forever.
 *
 * Free forever reactivates exactly like shrinking under the line
 * always has. Everyone else lands on `grace` with a FRESH window — "where
 * that is not derivable, it lands on grace", and under-charging (a longer
 * runway than the guild might strictly be owed) is the acceptable failure
 * direction, never the reverse.
 */
export function poolExitTransition(
  memberCount: number | null,
  now: Date,
  config: LeniencyConfig = DEFAULT_LENIENCY_CONFIG,
): { toStatus: AuthStatus; graceUntil: Date | null; reason: string } {
  const required = tierFor(memberCount ?? 0);
  if (required.id === 'free') {
    return { toStatus: 'trial', graceUntil: null, reason: 'left_pool_free' };
  }
  return { toStatus: 'grace', graceUntil: addDays(now, config.graceDays), reason: 'left_pool' };
}
