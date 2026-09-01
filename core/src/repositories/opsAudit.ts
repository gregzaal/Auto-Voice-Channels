import { desc, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import { opsAudit } from '../db/schema.js';

/**
 * How long an operational audit entry is kept.
 *
 * Generous on purpose: the whole argument for an audit log is answering "who did
 * what" long after the fact, and at the observed write rate a year is small. What
 * matters is that it is bounded, which it was not.
 */
export const OPS_AUDIT_RETENTION_DAYS = 365;

export interface OpsAuditEntry {
  actor: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}

/**
 * Append-only log of operational actions (flag changes, forced reconciles, blocks).
 *
 * The fleet is optional and has **no default**, unlike every other fleet-scoped
 * thing in `core`. An action taken from the web console genuinely originates
 * outside any fleet, and stamping those `prod` would be a lie in the one table
 * whose entire purpose is an honest record of who did what. A bot passes its own
 * fleet; the web app passes nothing.
 */
export class OpsAuditRepository {
  constructor(
    private readonly db: Database,
    private readonly fleet?: Fleet,
  ) {}

  async record(entry: OpsAuditEntry): Promise<void> {
    await this.db.insert(opsAudit).values({
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      fleet: this.fleet ?? null,
      details: (entry.details ?? {}) as never,
    });
  }

  /** Returns the most recent audit entries (newest first). */
  async recent(limit = 50): Promise<(typeof opsAudit.$inferSelect)[]> {
    return this.db.select().from(opsAudit).orderBy(desc(opsAudit.createdAt)).limit(limit);
  }

  /**
   * Drops entries past their retention window.
   *
   * **This table had no retention at all**, while `metrics_hourly` has had
   * `pruneHourly` since it existed. That was survivable while every writer was
   * an operator action, and stopped being so when `/import` made it grow with a
   * CUSTOMER action, two rows per import, one carrying up to 64 KiB of jsonb.
   *
   * Three surfaces read this table and none of them wants a year of history:
   * `/admin` shows the newest handful, `v_recent_ops` is documented as "the last
   * hour", and `/api/watch`'s stranded-import check bounds itself to seven days.
   * A year of rows is pure cost to all three, and the operator page renders
   * `details` into a table cell.
   *
   * A year is deliberately generous: this is an audit log, the argument for
   * keeping it is answering "who did what" long after the fact, and at the
   * observed write rate a year is small. The point is that it is bounded at all.
   */
  async prune(now: Date, retentionDays = OPS_AUDIT_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const result = await this.db.execute(sql`DELETE FROM ops_audit WHERE created_at < ${cutoff}`);
    return result.rowCount ?? 0;
  }
}
