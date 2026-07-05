/**
 * Canonical keys for the DB-backed runtime control plane (`runtime_flags`).
 *
 * These are the no-deploy levers an operator (agent or human) can toggle live;
 * every change is recorded in `ops_audit` by {@link RuntimeFlagsRepository.set}.
 * Defined in `core` so the bot, future dashboard, and ops tooling agree on names.
 */
export const RUNTIME_FLAGS = {
  /** Master kill-switch: when true, no channel automation or reconcile acts. */
  GLOBAL_PAUSE: 'global.pause',
  /** Disable only the periodic safety-net sweep (reconcile-on-READY still runs). */
  SWEEP_DISABLED: 'sweep.disabled',
  /** Throttle: max secondary creations per guild per minute (number; 0 = unlimited). */
  CREATE_RATE_LIMIT: 'create.rate_limit_per_min',
  /** Disable the billing/trial reconcile job entirely (sampling + ladder + notifications). */
  BILLING_RECONCILE_DISABLED: 'billing.reconcile_disabled',
  /** Leniency grace-window length in days (number; default 60 — monetization.md §4). */
  BILLING_GRACE_DAYS: 'billing.grace_days',
  /** Consecutive daily over-limit samples before the grace clock starts (number; default 7). */
  BILLING_UPGRADE_BREACH_SAMPLES: 'billing.upgrade_breach_samples',
  /** Consecutive daily under-limit samples before a downgrade is offered (number; default 30). */
  BILLING_DOWNGRADE_DROP_SAMPLES: 'billing.downgrade_drop_samples',
  /**
   * Beta lever: when true, guilds enter/sit in `grace` but never advance to
   * `expired` — run the messaging ladder before checkout exists (§0 Phase 2).
   */
  BILLING_HARD_GATE_DISABLED: 'billing.hard_gate_disabled',
} as const;

export type RuntimeFlagKey = (typeof RUNTIME_FLAGS)[keyof typeof RUNTIME_FLAGS];
