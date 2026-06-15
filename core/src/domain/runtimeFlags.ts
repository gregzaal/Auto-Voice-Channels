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
} as const;

export type RuntimeFlagKey = (typeof RUNTIME_FLAGS)[keyof typeof RUNTIME_FLAGS];
