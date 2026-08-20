import { and, count, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
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

/** A row the retry loop has claimed and now owns for the length of its lease. */
export interface ClaimedAlert {
  id: number;
  key: string;
  target: string;
  severity: AlertSeverity;
  message: string;
  occurrences: number;
  attempts: number;
  openedAt: Date;
}

/** How long a claim is held before another instance may take the row. */
const CLAIM_LEASE_MS = 5 * 60_000;

/**
 * How old an undelivered alert must be before the retry loop touches it.
 *
 * The fast path posts to Discord immediately and stamps the outcome
 * afterwards, so a row raised seconds ago is very likely already sent and
 * simply not yet marked. Waiting one watcher tick means the loop only ever
 * sees rows where the immediate path provably did not finish -- which also
 * covers the case where the stamp itself failed slowly, something correlating
 * on ids could not.
 */
const DELIVERY_GRACE_MS = 2 * 60_000;

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

  /**
   * Claims undelivered alerts for one fleet, for the retry loop.
   *
   * Structurally the same protocol as `BillingNotificationRepository.claimForFleet`,
   * with three deliberate differences:
   *
   * - **No `guild_fleet_presence` join.** The recipient is a single admin
   *   channel, not a customer guild, so "can this fleet reach the guild" is not
   *   the question being asked.
   * - **No instance predicate.** Reconciliation is instance-scoped because only
   *   the raising instance knows whether its own condition cleared; delivery is
   *   not, and must not be, because the whole value of the loop on a multi-machine
   *   fleet is a HEALTHY peer delivering the alert of an instance whose Discord
   *   client is the thing that broke.
   * - **`resolved_at IS NULL`.** `resolveOthers` and `expireStale` clear
   *   conditions without touching `delivered_at`, so without this the loop would
   *   post a backlog of things that stopped being true -- an alert storm
   *   triggered by recovery.
   *
   * The severity ordering is an explicit CASE rather than `severity DESC`.
   * `severity` is a text column, so DESC sorts it alphabetically and puts
   * `warn` above `critical` -- the precise opposite of the intent, and
   * invisible until a batch is bigger than the per-tick cap.
   */
  async claimUndelivered(
    limit: number,
    at = new Date(),
    leaseMs = CLAIM_LEASE_MS,
    graceMs = DELIVERY_GRACE_MS,
  ): Promise<ClaimedAlert[]> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{
        id: number;
        key: string;
        target: string;
        severity: AlertSeverity;
        message: string;
        occurrences: number;
        attempts: number;
        opened_at: string | Date;
      }>(sql`
        WITH claimed AS (
          SELECT a.id
            FROM ${alerts} a
           WHERE a.fleet = ${this.fleet}
             AND a.delivered_at IS NULL
             AND a.resolved_at IS NULL
             AND a.opened_at <= ${new Date(at.getTime() - graceMs)}
             AND (a.claimed_until IS NULL OR a.claimed_until <= ${at})
           ORDER BY CASE a.severity
                      WHEN 'critical' THEN 0
                      WHEN 'warn' THEN 1
                      ELSE 2
                    END,
                    a.opened_at ASC
           LIMIT ${limit}
             FOR UPDATE OF a SKIP LOCKED
        )
        UPDATE ${alerts} a
           SET attempts = a.attempts + 1,
               last_attempt_at = ${at},
               claimed_until = ${new Date(at.getTime() + leaseMs)}
          FROM claimed
         WHERE a.id = claimed.id
        RETURNING a.id, a.key, a.target, a.severity, a.message, a.occurrences,
                  a.attempts, a.opened_at
      `);

      return claimed.rows.map((r) => ({
        id: Number(r.id),
        key: r.key,
        target: r.target,
        severity: r.severity,
        message: r.message,
        occurrences: Number(r.occurrences),
        attempts: Number(r.attempts),
        openedAt: new Date(r.opened_at),
      }));
    });
  }

  /**
   * Records a failed delivery and backs the row off, leaving it undelivered.
   *
   * The back-off is the lease, shortened, rather than a release. Releasing
   * looks kinder and turns a permanently broken admin channel into one failing
   * REST call per instance per tick, during what is by definition an incident.
   * The `::timestamptz` cast is load-bearing: without it Postgres reads the
   * whole expression as an interval.
   */
  async markDeliveryFailed(id: number, error: string, at = new Date()): Promise<void> {
    await this.db
      .update(alerts)
      .set({
        attempts: sql`${alerts.attempts} + 1`,
        lastError: error.slice(0, 500),
        lastAttemptAt: at,
        /**
         * Cleared, and this is not redundant.
         *
         * `raise()` upserts onto the partial unique index, so restating a
         * condition that is still open returns the id of the SAME row -- which
         * may already carry `delivered_at` from an earlier successful post. A
         * failed post on that row would otherwise leave it reading delivered,
         * and `claimUndelivered` filters on `delivered_at IS NULL`, so the
         * retry loop would never see it. The column means "the current state of
         * this open condition has reached someone", not "some earlier
         * occurrence did".
         */
        deliveredAt: null,
        claimedUntil: sql`${at}::timestamptz + make_interval(secs => least(${alerts.attempts}, 6) * 60)`,
      })
      .where(eq(alerts.id, id));
  }

  /** How many alerts are waiting to be delivered. For `/diagnostics`. */
  async undeliveredDepth(at = new Date()): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(alerts)
      .where(
        and(
          eq(alerts.fleet, this.fleet),
          isNull(alerts.deliveredAt),
          isNull(alerts.resolvedAt),
          lt(alerts.openedAt, at),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Stops a resolved-but-undelivered row from sitting in the claimable index
   * forever.
   *
   * A condition that cleared before anyone was told is not a delivery failure
   * and must not be retried, but it also must not stay claimable. Stamped
   * rather than deleted so the history still records that it was never sent.
   */
  async closeResolvedUndelivered(at = new Date()): Promise<number> {
    const rows = await this.db
      .update(alerts)
      .set({ deliveredAt: at, lastError: 'resolved before delivery' })
      .where(
        and(
          eq(alerts.fleet, this.fleet),
          isNull(alerts.deliveredAt),
          sql`${alerts.resolvedAt} IS NOT NULL`,
        ),
      )
      .returning({ id: alerts.id });
    return rows.length;
  }

  /**
   * Deletes resolved alerts older than `before`.
   *
   * `billing_notifications` has both an expiry and a prune; this table shipped
   * with neither, so it and its indexes grew without bound. History is worth
   * keeping for a while and not forever.
   */
  async pruneResolved(before: Date): Promise<number> {
    const rows = await this.db
      .delete(alerts)
      .where(
        and(
          eq(alerts.fleet, this.fleet),
          sql`${alerts.resolvedAt} IS NOT NULL`,
          lt(alerts.resolvedAt, before),
        ),
      )
      .returning({ id: alerts.id });
    return rows.length;
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
