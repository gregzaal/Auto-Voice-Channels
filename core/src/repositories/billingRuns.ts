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
  ): Promise<{ ok: boolean; waitMs: number }> {
    return this.db.transaction(async (tx) => {
      // Serialize cluster-wide per job. Lock key: (namespace, job-hash 0) — a
      // single billing job today; released automatically at commit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BILLING_ADVISORY_LOCK}, 0)`);

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
