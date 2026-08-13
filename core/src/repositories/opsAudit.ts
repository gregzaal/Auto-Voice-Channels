import { desc } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import { opsAudit } from '../db/schema.js';

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
}
