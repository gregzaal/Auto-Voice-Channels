import { desc } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { opsAudit } from '../db/schema.js';

export interface OpsAuditEntry {
  actor: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
}

/** Append-only log of operational actions (flag changes, forced reconciles, blocks). */
export class OpsAuditRepository {
  constructor(private readonly db: Database) {}

  async record(entry: OpsAuditEntry): Promise<void> {
    await this.db.insert(opsAudit).values({
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? null,
      details: (entry.details ?? {}) as never,
    });
  }

  /** Returns the most recent audit entries (newest first). */
  async recent(limit = 50): Promise<(typeof opsAudit.$inferSelect)[]> {
    return this.db.select().from(opsAudit).orderBy(desc(opsAudit.createdAt)).limit(limit);
  }
}
