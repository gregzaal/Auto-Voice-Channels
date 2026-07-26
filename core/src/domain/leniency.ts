import type { AuthStatus } from './auth.js';
import type { MemberCountSample } from './billing.js';
import { compareTiers, tierById, tierFor, type TierId } from './tiers.js';

/**
 * The standardized leniency model (monetization.md §4) — a single, pure state
 * machine governing every "you need to pay / pay more" situation:
 *
 * 1. trial expiry (the year — or 14 days — is up),
 * 2. tier over-limit (member count outgrew the current paid tier),
 * 3. payment failure (Paddle dunning; the webhook moves the guild to `grace`,
 *    this machine only advances/ends the window).
 *
 * The ladder: advance warnings (T−30/7/1) → `grace` (fully working, ~60 days,
 * weekly nudges) → `expired` (hard gate, non-destructive) → reactivation at any
 * time. `evaluateLeniency` is pure: it inspects a guild's billing state at
 * `now` and returns at most one transition plus the notifications due — the
 * advisory-locked reconcile job applies them (with member-count validation
 * first, §5) and records notification keys for dedupe.
 */

export interface LeniencyConfig {
  /** Grace window length in days (runtime-flags tunable; default 60). */
  graceDays: number;
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
   * Beta lever (`billing.hard_gate_disabled`): when true, guilds enter and sit
   * in `grace` but are never advanced to `expired` — for running the messaging
   * ladder against real guilds before checkout exists (§0 Phase 2).
   */
  hardGateDisabled: boolean;
}

export const DEFAULT_LENIENCY_CONFIG: LeniencyConfig = {
  graceDays: 60,
  upgradeBreachSamples: 7,
  downgradeDropSamples: 30,
  warnDaysBefore: [30, 7, 1],
  shortWarnDaysBefore: [7, 2, 1],
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
  /** Latest member-count sample (a hint — transitions re-validate via REST). */
  memberCount: number | null;
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
   * be confirmed with a fresh authoritative REST read first (§5 steps 3–5).
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
 * sustained-breach anti-flap rule, §4 — a raid or one-off spike never triggers
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
 * longer sustained-drop hysteresis for downgrade offers, §4).
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
  return tierFor(state.memberCount ?? 0);
}

function alreadySent(state: LeniencyState, key: string): boolean {
  return state.notifications[key] !== undefined;
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
    return {
      transition: {
        toStatus: 'grace',
        reason: 'subscription_lapsed',
        graceUntil: addDays(now, config.graceDays),
        requiresCountValidation: false,
      },
      notifications: [
        {
          key: 'grace_started:subscription_lapsed',
          kind: 'grace_started',
          reason: 'subscription_lapsed',
          requiredTier: required.id,
          daysLeft: config.graceDays,
        },
      ],
    };
  }

  // Over-limit: the guild outgrew what it pays for, sustained across the
  // breach window → start the grace clock. (Never the other way: a guild may
  // hold any tier at or above its required tier — voluntary over-provisioning
  // is simply not prevented, §5.)
  if (
    state.billedTier &&
    compareTiers(required.id, state.billedTier) > 0 &&
    sustainedBreach(
      state.samples,
      tierById(state.billedTier).maxExclusive,
      config.upgradeBreachSamples,
    )
  ) {
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

  // Growing into XXL during a trial: a leniency-model tier transition — we
  // reach out to arrange the dedicated-infra deal; the trial window itself is
  // untouched (§3). One-time heads-up once the breach is sustained.
  if (
    required.id === 'xxl' &&
    sustainedBreach(state.samples, tierById('xl').maxExclusive, config.upgradeBreachSamples) &&
    !alreadySent(state, 'grew_into_xxl')
  ) {
    notifications.push({ key: 'grew_into_xxl', kind: 'grew_into_xxl', requiredTier: 'xxl' });
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
 * Sustained-under check for LEAVING grace on a member-count premise (§4/§5:
 * validation applies to billing-affecting transitions "up *or* down"). Uses
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
  // exits need the §4 sustained-drop hysteresis: a one-day dip below the
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
        graceUntil: addDays(now, config.graceDays),
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
  const graceStart = addDays(state.graceUntil, -config.graceDays);
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
  // The §4 hard gate promises a ONE-TIME admin notification — re-emit it until
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
