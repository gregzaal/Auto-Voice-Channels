import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { fleetAdvisoryKey, type Fleet } from '../domain/fleets.js';

/**
 * Leader election and the "is a backup due" decision (`plans/backups.md` §5).
 *
 * Pure-ish and in `core` rather than the bot, so it can be tested against a
 * real Postgres without booting a gateway. The bot supplies the timer; this
 * supplies the two questions that actually matter: am I the one to run it, and
 * should it run at all.
 *
 * Fleet-scoped, like every other coordination primitive here: beta taking a
 * backup must not mark production's schedule satisfied.
 */

/**
 * Advisory-lock namespace for backups.
 *
 * `0x5a7c_0002` is taken by the billing reconcile job, despite `backups.md` §5
 * naming it for this. Next free base, rather than a collision that would make
 * the billing advance and a backup mutually exclusive at random.
 */
export const BACKUP_ADVISORY_LOCK = 0x5a7c_0003;

/**
 * Whether a backup is due.
 *
 * Two rules, in order: at least `intervalHours` since the last success, and
 * only at or after `preferredHourUtc` on the day it becomes due. The second is
 * what keeps a daily backup off peak instead of drifting an hour later every
 * day, which a naive "last + 24h" schedule does.
 *
 * A missed window does not wait another day: once the interval has elapsed and
 * the preferred hour has passed, it runs. Skipping a backup to keep a tidy
 * schedule is the wrong trade.
 */
export function isBackupDue(opts: {
  now: Date;
  lastCompletedAt: Date | null;
  intervalHours: number;
  preferredHourUtc: number;
}): boolean {
  const { now, lastCompletedAt, intervalHours, preferredHourUtc } = opts;
  if (!lastCompletedAt) return true;

  const elapsedHours = (now.getTime() - lastCompletedAt.getTime()) / 3_600_000;
  if (elapsedHours < intervalHours) return false;

  // Sub-daily schedules have no meaningful "preferred hour" to align to.
  if (intervalHours < 24) return true;

  // Overdue by half an interval: stop waiting for the preferred hour and run.
  //
  // 1.5x deliberately matches the staleness threshold in section 8, so the
  // scheduler starts trying hard at exactly the moment /health would start
  // calling the backup stale. Any tidiness the preferred hour buys is worth
  // less than the backup existing.
  if (elapsedHours >= intervalHours * 1.5) return true;

  return now.getUTCHours() >= preferredHourUtc;
}

/** When the next run becomes eligible, for `/diagnostics`. */
export function nextDueAt(opts: {
  lastCompletedAt: Date | null;
  intervalHours: number;
  preferredHourUtc: number;
}): Date | null {
  if (!opts.lastCompletedAt) return null;
  const due = new Date(opts.lastCompletedAt.getTime() + opts.intervalHours * 3_600_000);
  if (opts.intervalHours < 24) return due;
  if (due.getUTCHours() < opts.preferredHourUtc) {
    due.setUTCHours(opts.preferredHourUtc, 0, 0, 0);
  }
  return due;
}

/**
 * Runs `fn` only if this instance wins a non-blocking advisory lock.
 *
 * `pg_try_advisory_lock` rather than the blocking form: a second instance
 * should decline and move on, not queue up behind a dump that may take minutes.
 * At one instance the lock is always free, which is why self-host needs no
 * special case.
 *
 * The lock is session-scoped, so it is released in a `finally` on the same
 * connection that took it. A crashed process drops its session, and with it the
 * lock, which is the behaviour we want: a dead leader must not block the fleet.
 */
export async function withBackupLock<T>(
  db: Database,
  fleet: Fleet,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  const key = fleetAdvisoryKey(BACKUP_ADVISORY_LOCK, fleet);
  const acquired = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${key}) AS locked`,
  );
  if (!acquired.rows[0]?.locked) return { ran: false };

  try {
    return { ran: true, result: await fn() };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${key})`);
  }
}
