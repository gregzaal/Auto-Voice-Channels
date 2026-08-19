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
  /**
   * Stop THIS fleet advancing the leniency ladder, without stopping it
   * sampling or delivering (`plans/fleets.md` §4).
   *
   * Advancing is fleet-wide work on shared rows and must happen on exactly one
   * fleet; the shared `BILLING_ADVISORY_LOCK` already guarantees that by
   * construction, so this is the *config* half §4 asks for rather than the
   * only defence. It exists because `billing.reconcile_disabled` is
   * all-or-nothing: setting that on prod to keep the ladder on beta would also
   * stop prod delivering its own guilds' notifications, which is the failure
   * the ladder/delivery split was built to prevent.
   */
  BILLING_ADVANCE_DISABLED: 'billing.advance_disabled',
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

  // -- AI-assisted templates (plans/assisted_templates.md §5) ----------------
  // NOT plan features. The per-guild cap is uniform on every tier and is never
  // raised by paying; it exists so a stuck client loop cannot run up a bill.
  /** Per-guild monthly `/templateassistant` build cap (number; default 200, <=0 = unlimited). */
  AI_BUILDS_PER_MONTH: 'ai.builds_per_month',
  /** Builds used before the remaining count is surfaced at all (number; default 100). */
  AI_BUILDS_NOTICE_THRESHOLD: 'ai.builds_notice_threshold',
  /** Fleet-wide monthly provider spend ceiling in USD (number; default 0 = unlimited). */
  AI_MONTHLY_BUDGET_USD: 'ai.monthly_budget_usd',
  /** Fraction of the budget that trips the alert (number; default 0.8). */
  AI_BUDGET_ALERT_FRACTION: 'ai.budget_alert_fraction',
  /** Kill-switch for the assistant, independent of whether a key is configured. */
  AI_DISABLED: 'ai.disabled',

  // -- Backups (plans/backups.md section 8) ----------------------------------
  /** Kill-switch for scheduled backups. Sibling of `sweep.disabled`. */
  BACKUP_DISABLED: 'backup.disabled',
  /**
   * ISO timestamp of the last successful backup, written by the scheduler.
   *
   * Lives in the shared DB rather than in a process, which is what makes the
   * schedule survive a leader change: a new leader neither double-runs nor
   * skips, because "when did this last happen" is fleet state, not local state.
   */
  BACKUP_LAST_COMPLETED_AT: 'backup.last_completed_at',
  /** Summary of the last successful run (object key, size, duration). */
  BACKUP_LAST_RESULT: 'backup.last_result',
  /** Message from the last failure, cleared on the next success. */
  BACKUP_LAST_ERROR: 'backup.last_error',
  /**
   * Kill-switch for the weekly restore drill, separate from `backup.disabled`.
   *
   * Separate on purpose: the drill re-downloads the newest object, so it costs
   * egress, and an operator watching a bill must be able to stop the check
   * without also stopping the thing being checked.
   */
  BACKUP_DRILL_DISABLED: 'backup.drill_disabled',
  /** ISO timestamp of the last drill that ran, pass or fail. */
  BACKUP_LAST_DRILL_AT: 'backup.last_drill_at',
  /** Summary of the last drill: what was checked, and anything wrong with it. */
  BACKUP_LAST_DRILL_RESULT: 'backup.last_drill_result',
} as const;

/** Defaults for the AI levers, kept next to the keys so bot + tooling agree. */
export const AI_FLAG_DEFAULTS = {
  buildsPerMonth: 200,
  noticeThreshold: 100,
  monthlyBudgetUsd: 0,
  budgetAlertFraction: 0.8,
} as const;

export type RuntimeFlagKey = (typeof RUNTIME_FLAGS)[keyof typeof RUNTIME_FLAGS];
