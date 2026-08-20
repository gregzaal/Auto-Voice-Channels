import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { alerts } from '../db/schema.js';

export type AlertAudience = 'hosted' | 'self_host' | 'both';
export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface RaiseAlertInput {
  key: string;
  message: string;
  target?: string;
  audience?: AlertAudience;
  severity?: AlertSeverity;
  details?: Record<string, unknown>;
}

export interface AlertRow {
  id: number;
  fleet: string;
  key: string;
  target: string;
  audience: AlertAudience;
  severity: AlertSeverity;
  message: string;
  details: unknown;
  openedAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  resolvedAt: Date | null;
  deliveredAt: Date | null;
  attempts: number;
  lastError: string | null;
}

/**
 * Operational alerts as rows, so a missed delivery is a retry rather than a
 * lost signal (`plans/agentic_management.md`).
 *
 * Fleet-scoped through the constructor, like every other repository here.
 * Pass the fleet explicitly at every call site: the default exists so tests and
 * self-host paths need not care, and a missing argument silently writing to
 * `prod` is exactly how `/admin/ops` spent weeks setting flags nobody read.
 */
export class AlertRepository {
  constructor(
    private readonly db: Database,
    private readonly fleet: string = 'prod',
  ) {}

  /**
   * Opens an alert, or records another occurrence of one already open.
   *
   * The upsert targets the PARTIAL unique index, so "already open" means
   * exactly that: a condition that was resolved and recurs opens a fresh row
   * rather than resurrecting the old one, which is what keeps "this flapped
   * nine times" distinguishable from "this has been broken for nine days".
   *
   * Returns whether this call OPENED the alert. Callers use that to decide
   * whether to notify: an alert seen for the thousandth time should bump the
   * counter silently, not send a thousandth message.
   */
  async raise(input: RaiseAlertInput, at = new Date()): Promise<{ opened: boolean; id: number }> {
    const target = input.target ?? '';
    const [row] = await this.db
      .insert(alerts)
      .values({
        fleet: this.fleet,
        key: input.key,
        target,
        audience: input.audience ?? 'hosted',
        severity: input.severity ?? 'warn',
        message: input.message,
        details: input.details ?? {},
        openedAt: at,
        lastSeenAt: at,
      })
      .onConflictDoUpdate({
        target: [alerts.fleet, alerts.key, alerts.target],
        targetWhere: isNull(alerts.resolvedAt),
        set: {
          lastSeenAt: at,
          occurrences: sql`${alerts.occurrences} + 1`,
          // The newest observation wins: a condition's details change as it
          // develops, and the stale first sighting is the less useful one.
          message: input.message,
          details: input.details ?? {},
        },
      })
      .returning({ id: alerts.id, occurrences: alerts.occurrences });

    return { opened: (row?.occurrences ?? 1) === 1, id: row?.id ?? 0 };
  }

  /**
   * Marks a condition no longer true. Idempotent, and a no-op when nothing is
   * open, so a checker can call it unconditionally on every healthy pass
   * without first asking whether it had complained.
   */
  async resolve(key: string, target = '', at = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(alerts)
      .set({ resolvedAt: at })
      .where(
        and(
          eq(alerts.fleet, this.fleet),
          eq(alerts.key, key),
          eq(alerts.target, target),
          isNull(alerts.resolvedAt),
        ),
      )
      .returning({ id: alerts.id });
    return rows.length > 0;
  }

  /** Alerts opened but never delivered, oldest first. The retry queue. */
  async undelivered(limit = 20): Promise<AlertRow[]> {
    return (await this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.fleet, this.fleet), isNull(alerts.deliveredAt)))
      .orderBy(alerts.openedAt)
      .limit(limit)) as AlertRow[];
  }

  async markDelivered(id: number, at = new Date()): Promise<void> {
    await this.db.update(alerts).set({ deliveredAt: at }).where(eq(alerts.id, id));
  }

  async markAttempted(id: number, error: string): Promise<void> {
    await this.db
      .update(alerts)
      .set({ attempts: sql`${alerts.attempts} + 1`, lastError: error.slice(0, 500) })
      .where(eq(alerts.id, id));
  }

  /** Everything still open, for the console and the digest. */
  async open(limit = 50): Promise<AlertRow[]> {
    return (await this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.fleet, this.fleet), isNull(alerts.resolvedAt)))
      .orderBy(desc(alerts.lastSeenAt))
      .limit(limit)) as AlertRow[];
  }

  /** Recent history regardless of state. "What fired last month", as a query. */
  async since(from: Date, limit = 200): Promise<AlertRow[]> {
    return (await this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.fleet, this.fleet), gte(alerts.openedAt, from)))
      .orderBy(desc(alerts.openedAt))
      .limit(limit)) as AlertRow[];
  }
}
