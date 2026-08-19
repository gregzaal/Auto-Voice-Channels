import type { DbPool } from '../db/client.js';
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
 * Advisory-lock namespace for the restore drill.
 *
 * Its own key rather than sharing the backup lock: a drill downloads and
 * verifies, a backup dumps and uploads, and neither has any reason to exclude
 * the other. Sharing would mean a long dump silently eating a drill window, and
 * the resulting "the drill sometimes does not run" is exactly the class of bug
 * `0x5a7c_0002` already caused once here.
 */
export const BACKUP_DRILL_ADVISORY_LOCK = 0x5a7c_0004;

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
 * **Takes a pool, and pins one client for the whole call. This is not a style
 * choice, and reverting it silently disables backups.** A session-scoped
 * advisory lock belongs to the *connection* that took it, and `db.execute()`
 * checks out an arbitrary client per statement, so acquiring through the pool
 * and releasing through the pool are two different sessions whenever the pool
 * is busy, which for the bot is always. The release then fails, Postgres logs a
 * warning nobody reads, `pg_advisory_unlock` returns false rather than
 * throwing, and the lock stays held on an idle pooled connection for as long as
 * the process lives. Every later attempt hits `{ ran: false }` and returns
 * quietly, because declining the lock is the normal path for a non-leader.
 *
 * The result is a fleet that stops backing up, reports no error, alerts nobody,
 * and shows a healthy `/diagnostics`. Measured against a real Postgres rather
 * than reasoned about: with six concurrent queries in flight the unlock
 * returned `false` and the lock survived.
 *
 * Pinning the client also makes the next sentence true. A crashed process drops
 * its connection and Postgres releases the lock with it, so a dead leader never
 * blocks the fleet.
 */
export async function withBackupLock<T>(
  pool: DbPool,
  fleet: Fleet,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  return withLock(pool, fleetAdvisoryKey(BACKUP_ADVISORY_LOCK, fleet), fn);
}

/** The same election, for the weekly restore drill. */
export async function withDrillLock<T>(
  pool: DbPool,
  fleet: Fleet,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  return withLock(pool, fleetAdvisoryKey(BACKUP_DRILL_ADVISORY_LOCK, fleet), fn);
}

async function withLock<T>(
  pool: DbPool,
  key: bigint,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  const client = await pool.connect();
  try {
    // Passed as text: node-postgres has no binary encoding for bigint, and
    // Postgres resolves the parameter from the function signature.
    const acquired = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key.toString()],
    );
    if (!acquired.rows[0]?.locked) return { ran: false };

    try {
      return { ran: true, result: await fn() };
    } finally {
      // A failed release must not mask the result of the work. It is also
      // survivable on its own: the client is released below either way, and a
      // dropped connection frees the lock.
      await client.query('SELECT pg_advisory_unlock($1)', [key.toString()]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
