import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
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
          /**
           * Severity ESCALATES, it does not follow the latest writer, and the
           * difference is load-bearing rather than tidy.
           *
           * The same key is reachable from two writers: an event-driven
           * `report()` from a catch block, which knows only that something
           * failed and never passes a severity at all, and the scheduled
           * watcher, which has confirmed the condition is true right now and
           * raises it `critical`. Last-writer-wins pins the row to whichever
           * fired most recently, and the frequent writer is usually the
           * low-severity one -- so a confirmed outage would sit in the table
           * labelled `warn`, which is precisely the column `/api/watch`
           * filters on.
           *
           * Taking the max means an open row records the worst the condition
           * has been. It comes back down by resolving, which starts a fresh
           * row, not by being quietly downgraded while still true.
           */
          severity: sql`case
            when ${alerts.severity} = 'critical' or ${input.severity ?? 'warn'} = 'critical'
              then 'critical'
            when ${alerts.severity} = 'warn' or ${input.severity ?? 'warn'} = 'warn'
              then 'warn'
            else 'info' end`,
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

  /**
   * Reconciles a POLLED condition against reality: everything still true is
   * named in `activeTargets`, and every open row for that key which is not
   * gets resolved.
   *
   * This is the piece that lets an alert come back down on its own. Without
   * it, one tripped breaker in one guild leaves a row open forever, and any
   * consumer asking "is anything wrong" latches red permanently -- which is
   * alert fatigue with a primary key, and worse than not alerting at all.
   *
   * An empty `activeTargets` means the condition is true nowhere and resolves
   * everything under that key, which is the common healthy case and must not
   * be mistaken for "no filter".
   */
  async resolveOthers(
    key: string,
    activeTargets: readonly string[],
    opts: { instance?: string; at?: Date } = {},
  ): Promise<number> {
    const at = opts.at ?? new Date();
    const where = [eq(alerts.fleet, this.fleet), eq(alerts.key, key), isNull(alerts.resolvedAt)];
    /**
     * Scoped to the instance that raised it, when the caller knows.
     *
     * Without this, reconciliation is actively wrong the moment a fleet has
     * more than one instance: A's healthy tick would resolve B's genuinely open
     * condition, because both write rows under the same (fleet, key) and A has
     * no idea B's guilds exist. Read from `details` rather than a column so it
     * needs no migration, at the cost of two instances sharing one row for a
     * fleet-wide key like `db.ping` -- which is degraded rather than dangerous,
     * since the surviving instance then cannot resolve the broken one's row.
     */
    if (opts.instance !== undefined) {
      where.push(sql`${alerts.details} ->> 'instance' = ${opts.instance}`);
    }
    if (activeTargets.length > 0) {
      /**
       * One placeholder per target rather than a single array parameter.
       * Drizzle binds a JS array as a RECORD, so the array forms of these
       * operators reach Postgres as "op ANY/ALL (array) requires array on
       * right side" -- a runtime error nothing typechecks, and one this
       * codebase has already shipped once.
       */
      where.push(
        sql`${alerts.target} not in (${sql.join(
          activeTargets.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      );
    }
    const rows = await this.db
      .update(alerts)
      .set({ resolvedAt: at })
      .where(and(...where))
      .returning({ id: alerts.id });
    return rows.length;
  }

  /**
   * Ages out alerts nothing has seen for a while.
   *
   * The counterpart to {@link resolveOthers} for EVENT-driven conditions,
   * which have no poll to tell them they stopped. A permission failure that
   * last happened nine days ago is history, not an open incident, and nothing
   * else in the system will ever say so: the catch block that raised it does
   * not run again precisely because the problem went away.
   */
  async expireStale(notSeenSince: Date, at = new Date()): Promise<number> {
    const rows = await this.db
      .update(alerts)
      .set({ resolvedAt: at })
      .where(
        and(
          eq(alerts.fleet, this.fleet),
          isNull(alerts.resolvedAt),
          lt(alerts.lastSeenAt, notSeenSince),
        ),
      )
      .returning({ id: alerts.id });
    return rows.length;
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
