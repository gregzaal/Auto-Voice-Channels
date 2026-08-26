import type { AuthStatus } from '../domain/auth.js';

/**
 * What the importer is allowed to change about a guild that already exists
 * (`plans/migration.md` §3.6).
 *
 * The importer was written for one fleet importing one dump into an empty
 * `guilds` table. It is now run once per bot identity into a SHARED table:
 * beta's dump landed 2026-08-19, prod's lands at the cutover, and Gold's a few
 * days after that. A guild that has two of those bots installed appears in two
 * dumps, and `guilds.settings` / `guilds.auth_status` are shared columns
 * (`plans/fleets.md` §2), not fleet-scoped ones.
 *
 * With last-writer-wins, **import order silently decides that guild's
 * configuration**, and the third run can un-block a blocked guild or downgrade
 * a paying one to `trial`. This module is the first-writer-wins policy that
 * makes the outcome independent of order:
 *
 * - **Settings fill gaps, they never overwrite.** Whatever is in the row is
 *   either what a live fleet is serving right now or what a human set through
 *   the new bot. A years-old JSON snapshot beats neither.
 * - **`aliases` and `custom_nicks` are unioned rather than replaced**, entry by
 *   entry, existing wins. These are the two dict-valued settings, and
 *   `updateSettings` merges only at the top level, so treating them as scalars
 *   would silently drop every alias the other dump carried.
 * - **The trial clock is written only for a guild that is in `trial`.** Every
 *   other status means something the importer must not overrule: `active` is
 *   paying, `grace`/`expired` are positions in the leniency ladder, and
 *   `blocked` is the per-guild kill-switch.
 *
 * **Why first-writer-wins, stated correctly:** it is the rule that cannot damage
 * what a live fleet is serving. It is NOT chosen for order-independence -- on a
 * conflicting scalar it is order-*dependent* by construction, and
 * "prod is authoritative" would be the order-independent rule. What survives any
 * order is the union: no key and no alias is ever lost, whichever dump runs
 * first. That is the property `merge.unit.test.ts` asserts.
 *
 * The same policy is what makes the two-phase cutover import safe (§6): the
 * bulk pass runs while the old bot is still live and the other fleets are still
 * serving, so it has to be incapable of changing anything they depend on.
 *
 * **The one deliberate exception is `overwrite`** (§6 step 3's delta pass). The
 * bulk pass becomes its own first writer, so gap-filling would make the delta
 * pass a no-op for exactly the settings it exists to apply. `overwrite` treats
 * the dump as authoritative for the guilds the operator explicitly named. It
 * covers settings ONLY: the auth-status guard is never bypassed, because no
 * dump is authoritative about whether someone is paying.
 */

/** The dict-valued settings keys, which merge entry-by-entry rather than whole. */
const DICT_KEYS = ['aliases', 'custom_nicks'] as const;

export interface ExistingGuild {
  authStatus: AuthStatus;
  settings: Record<string, unknown>;
}

export interface MergePlan {
  /**
   * The settings patch to actually write, reduced to what is safe to change.
   * Empty means there is nothing to write, so the caller skips the statement.
   */
  settingsPatch: Record<string, unknown>;
  /** Whether to write the trial-clock transition at all. */
  writeTrial: boolean;
  /** The status left alone, when `writeTrial` is false. For the report. */
  keptStatus: AuthStatus | null;
  /** Keys the dump carried that the existing row keeps unchanged. For the report. */
  keptSettingKeys: string[];
  /** True when the guild already had a row, i.e. another dump got here first. */
  existed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unions two dicts with the existing entries winning, or null when the union
 * would change nothing.
 *
 * Returning null rather than an equal object is what keeps a re-run from
 * writing: `updateSettings` bumps `updated_at` on every call, and this runs
 * across thousands of guilds several times.
 */
function unionKeepingExisting(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  // `hasOwnProperty`, not `existing[k] === undefined`: an alias key is a
  // user-typed game name, and one called `constructor` or `toString` would
  // otherwise resolve up the prototype chain and be silently discarded.
  const added = Object.keys(incoming).filter(
    (k) => !Object.prototype.hasOwnProperty.call(existing, k),
  );
  if (added.length === 0) return null;
  const merged: Record<string, unknown> = { ...incoming, ...existing };
  return merged;
}

/**
 * Reduces one guild's planned write to what is safe against what is already
 * stored. `existing` is undefined for a guild nobody has imported yet, which is
 * the common case and passes everything straight through.
 */
export function mergeIntoExisting(
  incoming: Record<string, unknown>,
  existing: ExistingGuild | undefined,
  opts: { overwrite?: boolean } = {},
): MergePlan {
  if (!existing) {
    return {
      settingsPatch: { ...incoming },
      writeTrial: true,
      keptStatus: null,
      keptSettingKeys: [],
      existed: false,
    };
  }

  const writeTrialFor = (status: AuthStatus): boolean => status === 'trial';

  /**
   * The delta pass. Settings come from the dump wholesale; the status guard
   * below still applies, because `overwrite` is a statement about configuration
   * and never about entitlement.
   */
  if (opts.overwrite) {
    const writeTrial = writeTrialFor(existing.authStatus);
    return {
      settingsPatch: { ...incoming },
      writeTrial,
      keptStatus: writeTrial ? null : existing.authStatus,
      keptSettingKeys: [],
      existed: true,
    };
  }

  const settingsPatch: Record<string, unknown> = {};
  const keptSettingKeys: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    const current = existing.settings[key];

    if ((DICT_KEYS as readonly string[]).includes(key)) {
      // A corrupt or non-dict stored value is treated as a scalar below, since
      // unioning into it is not defined and overwriting it is not ours to do.
      if (isPlainObject(current) && isPlainObject(value)) {
        const merged = unionKeepingExisting(current, value);
        if (merged) settingsPatch[key] = merged;
        else keptSettingKeys.push(key);
        continue;
      }
    }

    if (current === undefined) settingsPatch[key] = value;
    else keptSettingKeys.push(key);
  }

  const writeTrial = writeTrialFor(existing.authStatus);
  return {
    settingsPatch,
    writeTrial,
    keptStatus: writeTrial ? null : existing.authStatus,
    keptSettingKeys,
    existed: true,
  };
}
