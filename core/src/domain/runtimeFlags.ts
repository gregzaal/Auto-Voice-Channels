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

  /**
   * Stops the outbound Paddle cancellation that follows a settled refund.
   *
   * Read by `avc-web` alone, which is unusual for a flag in this file and is why
   * it says so: the key has to live here because this enum is the single
   * definition site and `/admin/ops` derives its lever list from it, but nothing
   * in the bot reads it. `/admin/ops` takes its fleet from `WEB_FLEET`, so one
   * row is the whole switch.
   *
   * Ships ENABLED (`false`). A refund that does not cancel leaves the customer
   * being billed again for service that already stopped, which is the invariant
   * this design exists to hold, and the cancellation is a SCHEDULED one that a
   * single PATCH reverses. The flag exists for the case where Paddle starts
   * refusing the call, not as a staged rollout.
   */
  BILLING_AUTO_CANCEL_DISABLED: 'billing.auto_cancel_disabled',

  /**
   * Stops the self-serve refund action. The support route is unaffected, and so
   * is `adjustment.*` processing: this switches off the button, never the
   * handling of a refund somebody already got.
   */
  BILLING_REFUND_REQUESTS_DISABLED: 'billing.refund_requests_disabled',

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

  // -- Metric store (plans/admin-dashboard.md §3.4) ---------------------------
  /**
   * Kill-switch for the metrics collector, matching every other collector here.
   *
   * Per fleet, like every flag, and that is the useful shape: the rollup is a
   * cluster singleton but the counter flush is per instance, so disabling one
   * fleet stops it reporting its own counters while the other fleet keeps the
   * shared gauges coming. `global.pause` stops both.
   */
  METRICS_DISABLED: 'metrics.disabled',

  // -- Guild-facing problem notices -----------------------------------------
  /**
   * Kill-switch for pushing permission problems to the guilds they affect.
   *
   * The lever that matters most on this list, because it is the only flag
   * guarding something that talks to customers unprompted: with it set, a
   * problem still lands in `/setup` and in a configured `/logging` channel, and
   * nothing is sent anywhere on its own. `global.pause` stops it too.
   *
   * Reach for it if the notices turn out to be too frequent or to be reaching
   * the wrong person. Neither is visible from inside the fleet, which is what
   * makes a no-deploy switch worth having here rather than a redeploy.
   */
  PROBLEM_NOTICE_DISABLED: 'problems.notify_disabled',

  // -- Alerting (plans/agentic_management.md step 4) -------------------------
  /**
   * Kill-switch for the in-process watcher on THIS fleet: no condition
   * evaluation, no alert rows, no watchdog ping.
   *
   * Note what the last one means. The watchdog ping is a dead-man's switch, so
   * silencing the watcher makes the external heartbeat monitor go red a few
   * minutes later. That is the correct behaviour and not a bug to work around:
   * an operator who has switched off the thing that reports health has, by
   * definition, switched off the report. `global.pause` stops it too.
   */
  ALERTS_DISABLED: 'alerts.disabled',

  /**
   * Kill-switch for `GatewaySupervisor` on THIS fleet: a machine whose gateway
   * is confirmed dead reports it and waits for a human instead of restarting
   * itself.
   *
   * **The only autonomous behaviour here that restarts a production machine, so
   * it is the one that most needs a no-deploy lever.** Every other autonomous
   * subsystem already has one, and a deploy into a fleet that is cycling itself
   * is the worst available moment to discover this one did not: the deploy is
   * competing with the restarts.
   *
   * Setting it does not make anything less safe. Detection is unaffected, so
   * `/health` still reports the gateway down, the `gateway.down` alert still
   * fires, and the watchdog ping is still withheld fleet-wide. What stops is
   * the machine acting on its own, which is the pre-2026-09-01 behaviour plus
   * three working signals.
   */
  GATEWAY_SELF_RESTART_DISABLED: 'gateway.self_restart_disabled',

  // -- Marketing (plans/marketing.md §5.1 item 5) ----------------------------
  /**
   * Suppresses automated marketing posts (release notes, social/top.gg
   * announcements) around a cutover window, so a routine auto-post cannot
   * step on the one message that must not be stepped on: at cutover the
   * install count shows a cliff and uninstall alerts fire continuously, and
   * an auto-posted release note landing in the middle of that reads very
   * differently than it would on an ordinary day.
   *
   * **Live, and read by `TopggScheduler`**, which publishes the listing's
   * server count and command list. Setting this freezes the published count,
   * which is stale rather than wrong, so leaving it set is the failure mode to
   * watch for: `/diagnostics` reports it as its own field for that reason.
   *
   * Any future poster (release notes, a top.gg announcement, anything social)
   * must check it too. A silent counter is the weakest case for honouring it
   * and it honours it anyway, so there is no precedent here for skipping it.
   */
  MARKETING_PAUSED: 'marketing.paused',
  /**
   * Kill-switch for the top.gg listing publisher on THIS fleet: no server
   * count, no command list.
   *
   * Its own lever rather than a redeploy, matching every other outbound
   * integration here. The listing is public and the failure it guards against
   * is publishing something wrong to it -- a count from the wrong fleet, a
   * command list from a bad build -- which is exactly the kind of thing noticed
   * from outside and needing to stop within the minute.
   *
   * `marketing.paused` and `global.pause` also stop it. The publisher reports
   * each of the three separately on `/diagnostics`, because "the count is
   * stale" has to be traceable to whichever switch is doing it.
   */
  TOPGG_DISABLED: 'topgg.disabled',

  // -- Supporter roles (plans/monetization.md section 13) ---------------------
  /**
   * Kill-switch for supporter-role assignment in the support guild, on THIS
   * fleet.
   *
   * Worth having as a flag rather than a redeploy for the same reason
   * `problems.notify_disabled` is: this writes something other people can see,
   * in a server full of customers, and "it is badging the wrong people" is not
   * visible from inside the fleet. Set it and the roles freeze exactly as they
   * are -- nothing is stripped, because a mass unbadging is a louder event than
   * whatever prompted the switch. `global.pause` stops it too.
   */
  SUPPORT_ROLES_DISABLED: 'support.roles_disabled',

  // -- Config import/export (plans/import_command.md section 9) ---------------
  /**
   * Kill-switch for `/import`, checked in BOTH the command and the confirm
   * handler: checking only the first leaves every already-previewed import
   * applying straight through an incident.
   *
   * **Read across ALL fleets, not per fleet, and it is the only lever here that
   * works that way.** `guilds.settings` has no `fleet` column and the
   * invalidation channel is one global name, so an import run through beta
   * rewrites the row prod reads and NOTIFYs every prod instance, `enabled`
   * included. 35 guilds have both bots today. A per-fleet read would give an
   * operator one click that stops one of two paths into the same blob while
   * looking exactly like its neighbours on `/admin/ops`.
   *
   * `/export` is deliberately unaffected: a defect in the write path is no
   * reason to take away the only way out. And `global.pause` does NOT cover
   * this, because it covers no slash command at all.
   */
  IMPORT_DISABLED: 'import.disabled',

  /**
   * Stops `/import`'s system-channel announcement on **this fleet**, leaving the
   * command working.
   *
   * Separate from {@link IMPORT_DISABLED} because they answer different
   * questions. This is the second unsolicited push the bot makes into a guild,
   * and the first (permission problems) has both a per-guild preference and a
   * per-fleet flag, precisely because "too frequent" and "reaching the wrong
   * people" are invisible from inside the fleet. Taking away the whole command
   * is the wrong response to a notice that turns out to be wrong.
   */
  IMPORT_ANNOUNCE_DISABLED: 'import.announce_disabled',
} as const;

/** Defaults for the AI levers, kept next to the keys so bot + tooling agree. */
export const AI_FLAG_DEFAULTS = {
  buildsPerMonth: 200,
  noticeThreshold: 100,
  monthlyBudgetUsd: 0,
  budgetAlertFraction: 0.8,
} as const;

export type RuntimeFlagKey = (typeof RUNTIME_FLAGS)[keyof typeof RUNTIME_FLAGS];
