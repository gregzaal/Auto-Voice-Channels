/**
 * Per-guild authorization / entitlement state.
 *
 * - `trial`   — within the free trial window.
 * - `active`  — paid / entitled.
 * - `grace`   — the trial/subscription window ended (or the tier was outgrown /
 *               a payment failed), but the guild keeps working at 100% during a
 *               generous buffer while admins are nudged to act (the leniency
 *               model, `plans/monetization.md` §4).
 * - `expired` — trial or subscription lapsed and the grace window ran out;
 *               features gated off (non-destructive: nothing is deleted).
 * - `blocked` — abuse/isolation kill-switch; never entitled, regardless of config.
 *
 * The enum is intentionally extensible. `blocked` doubles as the per-guild
 * kill-switch and is enforced even when `SELF_HOSTED` is set.
 */
export const AUTH_STATUSES = ['trial', 'active', 'grace', 'expired', 'blocked'] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];

export function isAuthStatus(value: unknown): value is AuthStatus {
  return typeof value === 'string' && (AUTH_STATUSES as readonly string[]).includes(value);
}

/** The auth states that grant feature access (before the SELF_HOSTED bypass). */
/**
 * The statuses under which the bot serves a guild.
 *
 * Exported so `guildFloor` can compare two statuses for "is this entitled"
 * without going through {@link isEntitled}, whose `selfHosted` argument has no
 * meaning when the question is about a status rather than a deployment.
 */
export const ENTITLED_STATUSES: ReadonlySet<AuthStatus> = new Set(['trial', 'active', 'grace']);

export interface EntitlementInput {
  status: AuthStatus;
  /** When true, the gate always allows — except for `blocked` guilds. */
  selfHosted: boolean;
}

/**
 * Fast entitlement gate. A `blocked` guild is never entitled (the kill-switch
 * takes precedence over `SELF_HOSTED`). When `selfHosted` is true and the guild
 * is not blocked, the gate always allows. Otherwise `trial`/`active`/`grace` pass.
 */
export function isEntitled({ status, selfHosted }: EntitlementInput): boolean {
  if (status === 'blocked') return false;
  if (selfHosted) return true;
  return ENTITLED_STATUSES.has(status);
}
