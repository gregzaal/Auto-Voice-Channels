/**
 * Per-guild authorization / entitlement state.
 *
 * - `trial`   — within the free trial window.
 * - `active`  — paid / entitled.
 * - `expired` — trial or subscription lapsed; features gated off.
 * - `blocked` — abuse/isolation kill-switch; never entitled, regardless of config.
 *
 * The enum is intentionally extensible. `blocked` doubles as the per-guild
 * kill-switch and is enforced even when `SELF_HOSTED` is set.
 */
export const AUTH_STATUSES = ['trial', 'active', 'expired', 'blocked'] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];

export function isAuthStatus(value: unknown): value is AuthStatus {
  return typeof value === 'string' && (AUTH_STATUSES as readonly string[]).includes(value);
}

/** The auth states that grant feature access (before the SELF_HOSTED bypass). */
const ENTITLED_STATUSES: ReadonlySet<AuthStatus> = new Set(['trial', 'active']);

export interface EntitlementInput {
  status: AuthStatus;
  /** When true, the gate always allows — except for `blocked` guilds. */
  selfHosted: boolean;
}

/**
 * Fast entitlement gate. A `blocked` guild is never entitled (the kill-switch
 * takes precedence over `SELF_HOSTED`). When `selfHosted` is true and the guild
 * is not blocked, the gate always allows. Otherwise only `trial`/`active` pass.
 */
export function isEntitled({ status, selfHosted }: EntitlementInput): boolean {
  if (status === 'blocked') return false;
  if (selfHosted) return true;
  return ENTITLED_STATUSES.has(status);
}
