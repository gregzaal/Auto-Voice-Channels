import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { billingRuns } from '../db/schema.js';

/**
 * Advisory-lock namespace for cluster-singleton background jobs (the billing
 * reconcile job). Sibling of `IDENTIFY_ADVISORY_LOCK` (0x5a7c_0001); the second
 * lock key is a per-job discriminator (0 = billing advance).
 */
export const BILLING_ADVISORY_LOCK = 0x5a7c_0002;

/**
 * Reservation gate for cluster-singleton jobs, copied from the identify
 * throttler's pattern (`ShardLeaseRepository.reserveIdentify`): a
 * transaction-scoped advisory lock serializes contenders cluster-wide, and a
 * durable last-run timestamp (`billing_runs`) enforces the spacing — the lock
 * alone can't (advisory locks are re-entrant within a session, and release at
 * commit). Exactly one instance wins each spacing window; everyone else skips.
 *
 * **Deliberately NOT fleet-scoped**, unlike the identify lock it was copied
 * from, and the difference is the point. Identifies are per-application work, so
 * two fleets sharing that lock would compute the wrong spacing for both. The
 * leniency ladder is the opposite: fleet-wide work on *shared* rows — one guild,
 * one entitlement, one set of transitions — so it must run once across the whole
 * cluster no matter how many fleets are up. Sharing this key is what guarantees
 * that, and it is a second line of defence behind the config that is supposed to
 * enable the job on exactly one fleet (`plans/fleets.md` §4).
 *
 * Note the consequence, which is real: the fleet that *advances* the ladder may
 * not be in the guild it just transitioned, so notification delivery cannot ride
 * along with it. Delivery is per fleet, for its own guilds only.
 */
export class BillingRunRepository {
  constructor(private readonly db: Database) {}

  /**
   * Tries to reserve a run of `job`. Returns `{ ok: true }` when this caller
   * should run it now (the durable timestamp was advanced), or `{ ok: false,
   * waitMs }` when a run happened within `spacingMs` already.
   */
  async reserveRun(
    job: string,
    spacingMs: number,
    instanceId: string,
    /**
     * Which sub-key of the namespace to serialize on. Default 0 is the billing
     * advance.
     *
     * The lock is held only for the length of THIS reservation, not for the
     * length of the work: `pg_advisory_xact_lock` is taken inside the
     * transaction below, which commits before `reserveRun` returns, and callers
     * then do the work unlocked. So two jobs sharing a slot serialize only
     * while reserving, and the thing actually preventing two concurrent passes
     * of the same job is the durable spacing in `billing_runs`, which is per
     * `job`. A pass that outlives its own spacing window overlaps the next one.
     * Distinct jobs still take distinct slots so a slow reservation cannot
     * delay an unrelated job's.
     */
    lockSlot = 0,
  ): Promise<{ ok: boolean; waitMs: number }> {
    return this.db.transaction(async (tx) => {
      // Serialize cluster-wide per job. Lock key: (namespace, slot); released
      // automatically at commit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BILLING_ADVISORY_LOCK}, ${lockSlot})`);

      const result = await tx.execute(sql`SELECT last_run_at FROM billing_runs WHERE job = ${job}`);
      const lastRaw = (result.rows[0] as { last_run_at?: string | Date } | undefined)?.last_run_at;
      const last = lastRaw ? new Date(lastRaw).getTime() : 0;
      const now = Date.now();
      if (last !== 0 && now - last < spacingMs) {
        return { ok: false, waitMs: spacingMs - (now - last) };
      }

      await tx
        .insert(billingRuns)
        .values({ job, lastRunAt: new Date(now), lastRunBy: instanceId })
        .onConflictDoUpdate({
          target: billingRuns.job,
          set: { lastRunAt: new Date(now), lastRunBy: instanceId, updatedAt: new Date() },
        });
      return { ok: true, waitMs: 0 };
    });
  }
}
