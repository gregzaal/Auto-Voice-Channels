import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { billingNotifications, guildFleetPresence } from '../db/schema.js';
import type { Fleet } from '../domain/fleets.js';
import type { LeniencyNotification } from '../domain/leniency.js';

/**
 * The billing-notification queue (`plans/fleets.md` §4).
 *
 * Sits between the cluster-singleton advance pass, which decides a guild is
 * owed a message, and whichever fleet is actually in that guild, which is the
 * only one that can send it. See the table comment in `schema.ts` for why
 * those cannot be the same loop.
 */

/** How long a queued notification stays worth sending. */
export const NOTIFICATION_TTL_MS = 3 * 86_400_000;

/**
 * Floor under the capped TTL.
 *
 * `daysLeft` reaches 0 for a window that has just closed, and a zero TTL means
 * the row expires before any drain can see it. A message worth queueing is
 * worth attempting for at least a few ticks.
 */
export const MIN_TTL_MS = 6 * 3_600_000;

/**
 * How long a claim holds a row before another instance may retry it.
 *
 * Long enough that a slow Discord call is not raced, short enough that a
 * deliverer killed mid-send does not strand the notification for a whole tick.
 */
export const CLAIM_LEASE_MS = 5 * 60_000;

export interface PendingNotification {
  id: number;
  guildId: string;
  key: string;
  notification: LeniencyNotification;
  memberCount: number;
  attempts: number;
  /** When the advance pass queued it. The dedupe re-check compares against it. */
  enqueuedAt: Date;
  /**
   * Set when this guild-scoped row is one copy of a pool's fan-out notice
   * (`plans/member-based-pricing.md` §6.6). Lets the deliverer stamp the
   * POOL's own dedupe key once any one copy is confirmed delivered, rather
   * than at enqueue time — a fan-out notice must keep re-emitting if every
   * copy fails, exactly like a single guild's own notice does.
   */
  poolId: string | null;
}

/** The pool-axis sibling of {@link PendingNotification} — a purchaser-targeted row. */
export interface PendingPoolNotification {
  id: number;
  poolId: string;
  key: string;
  notification: LeniencyNotification;
  memberCount: number;
  attempts: number;
  enqueuedAt: Date;
}

/**
 * Capped at the horizon the message itself quotes.
 *
 * A `trial_warning` carries `daysLeft`, computed here and rendered verbatim
 * at delivery. Delivered late it does not read as stale, it reads as wrong:
 * "1 day left" about a trial that ended yesterday, arriving after the
 * hard-gate notice. The flat TTL alone does not prevent that, because a
 * fleet re-added to a guild makes three days of backlog claimable at once.
 */
function ttlFor(notification: LeniencyNotification, options: { ttlMs?: number }): number {
  const horizonMs =
    typeof notification.daysLeft === 'number' && notification.daysLeft >= 0
      ? // Floored, because `daysLeft` reaches 0 for a window that has just
        // closed and a zero TTL expires the row before any drain sees it.
        Math.max(MIN_TTL_MS, notification.daysLeft * 86_400_000)
      : Number.POSITIVE_INFINITY;
  // The floor applies to the derived horizon, never to an explicit `ttlMs`:
  // that one is the caller being deliberate, and silently widening it would
  // make the option a suggestion.
  return Math.min(options.ttlMs ?? NOTIFICATION_TTL_MS, horizonMs);
}

export class BillingNotificationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Queues a notification, or does nothing if the same one is already pending.
   *
   * Returns whether a new row was created, which is what the advance pass
   * counts. Re-enqueue is the normal case, not an edge case: the ladder keeps
   * deciding a notification is due until delivery stamps the dedupe key in
   * guild metadata, so every hourly pass re-derives everything still in flight.
   */
  async enqueue(
    guildId: string,
    notification: LeniencyNotification,
    memberCount: number,
    options: { at?: Date; ttlMs?: number; sourcePoolId?: string } = {},
  ): Promise<boolean> {
    const at = options.at ?? new Date();
    const ttl = ttlFor(notification, options);
    const inserted = await this.db
      .insert(billingNotifications)
      .values({
        guildId,
        // Traceability only (`plans/member-based-pricing.md` §6.6): this row
        // is still keyed and delivered exactly like any other guild-scoped
        // notification (`billing_notifications_pending_key` is on
        // `(guild_id, key)`, unaffected by `pool_id`). The deliverer reads it
        // back to know which pool's dedupe key to stamp on success.
        poolId: options.sourcePoolId ?? null,
        key: notification.key,
        kind: notification.kind,
        notification,
        memberCount,
        enqueuedAt: at,
        expiresAt: new Date(at.getTime() + ttl),
      })
      .onConflictDoNothing()
      .returning({ id: billingNotifications.id });
    return inserted.length > 0;
  }

  /**
   * The pool-axis sibling of {@link enqueue}, for a purchaser-targeted
   * billing notification (`plans/member-based-pricing.md` §6.6). Idempotent
   * against `billing_notifications_pool_pending_key`, same reasoning as the
   * guild form: the pool pass re-derives the same pending notification every
   * tick until delivery stamps the pool's own dedupe map.
   */
  async enqueueForPool(
    poolId: string,
    notification: LeniencyNotification,
    memberCount: number,
    options: { at?: Date; ttlMs?: number } = {},
  ): Promise<boolean> {
    const at = options.at ?? new Date();
    const ttl = ttlFor(notification, options);
    const inserted = await this.db
      .insert(billingNotifications)
      .values({
        poolId,
        key: notification.key,
        kind: notification.kind,
        notification,
        memberCount,
        enqueuedAt: at,
        expiresAt: new Date(at.getTime() + ttl),
      })
      .onConflictDoNothing()
      .returning({ id: billingNotifications.id });
    return inserted.length > 0;
  }

  /**
   * Claims up to `limit` deliverable notifications for one fleet.
   *
   * Deliverable means: not delivered, not expired, not currently claimed by
   * somebody else, and **this fleet is in the guild**. That last clause is the
   * whole point of the split, and it is a join rather than a filter applied
   * afterwards so a fleet never even sees work it could not do.
   *
   * Two mechanisms, doing different jobs. `FOR UPDATE ... SKIP LOCKED` keeps
   * two *simultaneous* claims from reading the same rows. `claimed_until`
   * keeps a *later* claim from re-taking a row whose delivery is still in
   * flight, which the row lock cannot do because it dies with the transaction
   * and delivery deliberately happens after the commit. Only the second one
   * stops two instances ticking a second apart from double-sending, so
   * removing it because "SKIP LOCKED already handles that" reintroduces the
   * bug that the concurrency test in this repo was written for.
   *
   * A lease that runs out is a lease that gets retried: a deliverer that
   * crashed mid-send leaves the row claimed for at most `leaseMs`.
   */
  async claimForFleet(
    fleet: Fleet,
    limit: number,
    at = new Date(),
    leaseMs = CLAIM_LEASE_MS,
  ): Promise<PendingNotification[]> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{
        id: number;
        guild_id: string;
        pool_id: string | null;
        key: string;
        notification: unknown;
        member_count: number;
        attempts: number;
        enqueued_at: string | Date;
      }>(sql`
        WITH claimed AS (
          SELECT n.id
          FROM ${billingNotifications} n
          JOIN ${guildFleetPresence} p
            ON p.guild_id = n.guild_id
           AND p.fleet = ${fleet}
           AND p.removed_at IS NULL
          WHERE n.delivered_at IS NULL
            AND n.expires_at > ${at}
            AND (n.claimed_until IS NULL OR n.claimed_until <= ${at})
          ORDER BY n.enqueued_at ASC
          LIMIT ${limit}
          FOR UPDATE OF n SKIP LOCKED
        )
        UPDATE ${billingNotifications} n
           SET attempts = n.attempts + 1,
               last_attempt_at = ${at},
               claimed_until = ${new Date(at.getTime() + leaseMs)}
          FROM claimed
         WHERE n.id = claimed.id
        RETURNING n.id, n.guild_id, n.pool_id, n.key, n.notification, n.member_count, n.attempts,
                  n.enqueued_at
      `);

      return claimed.rows.map((row) => ({
        id: Number(row.id),
        guildId: row.guild_id,
        poolId: row.pool_id,
        key: row.key,
        notification: row.notification as LeniencyNotification,
        memberCount: Number(row.member_count),
        attempts: Number(row.attempts),
        enqueuedAt: new Date(row.enqueued_at),
      }));
    });
  }

  /**
   * The pool-axis sibling of {@link claimForFleet}: deliverable means this
   * fleet is present in at least one of the pool's LIVE member guilds — the
   * bot must share a server with the purchaser to DM them at all, and under
   * the single-fleet-only enforcement on adding a guild to a pool (§6.1 q4),
   * every live member shares the same fleet, so any one of them suffices.
   */
  async claimPoolForFleet(
    fleet: Fleet,
    limit: number,
    at = new Date(),
    leaseMs = CLAIM_LEASE_MS,
  ): Promise<PendingPoolNotification[]> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{
        id: number;
        pool_id: string;
        key: string;
        notification: unknown;
        member_count: number;
        attempts: number;
        enqueued_at: string | Date;
      }>(sql`
        WITH claimed AS (
          SELECT n.id
          FROM ${billingNotifications} n
          WHERE n.pool_id IS NOT NULL
            AND n.delivered_at IS NULL
            AND n.expires_at > ${at}
            AND (n.claimed_until IS NULL OR n.claimed_until <= ${at})
            AND EXISTS (
              SELECT 1 FROM member_pool_guilds mpg
              JOIN ${guildFleetPresence} p
                ON p.guild_id = mpg.guild_id
               AND p.fleet = ${fleet}
               AND p.removed_at IS NULL
              WHERE mpg.pool_id = n.pool_id
                AND mpg.removed_at IS NULL
            )
          ORDER BY n.enqueued_at ASC
          LIMIT ${limit}
          FOR UPDATE OF n SKIP LOCKED
        )
        UPDATE ${billingNotifications} n
           SET attempts = n.attempts + 1,
               last_attempt_at = ${at},
               claimed_until = ${new Date(at.getTime() + leaseMs)}
          FROM claimed
         WHERE n.id = claimed.id
        RETURNING n.id, n.pool_id, n.key, n.notification, n.member_count, n.attempts,
                  n.enqueued_at
      `);

      return claimed.rows.map((row) => ({
        id: Number(row.id),
        poolId: row.pool_id,
        key: row.key,
        notification: row.notification as LeniencyNotification,
        memberCount: Number(row.member_count),
        attempts: Number(row.attempts),
        enqueuedAt: new Date(row.enqueued_at),
      }));
    });
  }

  /** Marks a claimed row delivered by `fleet`. */
  async markDelivered(id: number, fleet: Fleet, at = new Date()): Promise<void> {
    await this.db
      .update(billingNotifications)
      .set({ deliveredAt: at, deliveredByFleet: fleet, lastError: null })
      .where(and(eq(billingNotifications.id, id), isNull(billingNotifications.deliveredAt)));
  }

  /**
   * Records a failed attempt and backs the row off, leaving it pending.
   *
   * The back-off is the lease, shortened. Releasing the claim outright looks
   * kinder (the usual cause is a missing Send Messages permission, which an
   * admin fixes in seconds) but the deliver phase runs on **every instance of
   * the fleet**, and the lease is the only thing spacing retries. Freeing it
   * immediately turns a permanently-failing guild into N attempts an hour for
   * three days, every one of them a `guilds.fetch` + `channels.fetch` + `send`
   * + `fetchOwner` + `owner.send` against Discord. Before the split such a
   * notification was retried once per 55-minute advance window, cluster-wide.
   *
   * Expiry is still what eventually stops it. This only decides how often it
   * is tried on the way there.
   */
  async markFailed(id: number, error: string, at = new Date()): Promise<void> {
    await this.db
      .update(billingNotifications)
      .set({
        lastError: error.slice(0, 500),
        // `${at}` alone binds as an untyped parameter and Postgres reads the
        // whole expression as an interval. The cast is what makes it a time.
        claimedUntil: sql`${at}::timestamptz + make_interval(secs => least(${billingNotifications.attempts}, 6) * 60)`,
      })
      .where(eq(billingNotifications.id, id));
  }

  /**
   * Drops notifications nobody delivered in time.
   *
   * Returns them rather than just a count, so the caller can audit what went
   * undelivered. A guild silently missing its trial-ending warning is exactly
   * the failure this whole table exists to prevent, so the expiry path has to
   * be loud even though it is the giving-up path.
   */
  async expire(
    at = new Date(),
    limit = 500,
  ): Promise<{ guildId: string | null; poolId: string | null; key: string; attempts: number }[]> {
    /**
     * One statement, not select-then-delete.
     *
     * Every instance of every fleet runs this on every tick, so two of them
     * expiring concurrently is the normal case. A `SELECT` followed by a
     * `DELETE` lets both read the same rows and both audit them, which turns
     * one guild's missed notice into two ops_audit entries claiming it
     * happened twice. `DELETE ... RETURNING` hands each row to exactly one
     * caller.
     */
    const deleted = await this.db.execute<{
      guild_id: string | null;
      pool_id: string | null;
      key: string;
      attempts: number;
    }>(sql`
      DELETE FROM ${billingNotifications}
       WHERE id IN (
         SELECT id FROM ${billingNotifications}
          WHERE delivered_at IS NULL
            AND expires_at <= ${at}
            -- Never expire a row somebody is mid-delivery on. Without this a
            -- slow send (system channel refuses, fall back to an owner DM)
            -- can outlive the TTL by seconds and get expired underneath the
            -- deliverer, firing the loudest "we failed a customer" signal in
            -- the system for a message that did arrive.
            AND (claimed_until IS NULL OR claimed_until <= ${at})
          ORDER BY enqueued_at ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING guild_id, pool_id, key, attempts
    `);
    return deleted.rows.map((row) => ({
      guildId: row.guild_id,
      poolId: row.pool_id,
      key: row.key,
      attempts: Number(row.attempts),
    }));
  }

  /**
   * Deletes delivered rows older than `before`.
   *
   * Delivered rows are kept briefly because "did that guild actually get the
   * warning" is the first question asked when a customer disputes a hard gate,
   * and `metadata.billing.notifications` records only that a key was stamped,
   * not which fleet sent it or how many attempts it took.
   */
  async pruneDelivered(before: Date, limit = 1000): Promise<number> {
    const deleted = await this.db.execute<{ id: number }>(sql`
      DELETE FROM ${billingNotifications}
       WHERE id IN (
         SELECT id FROM ${billingNotifications}
          WHERE delivered_at IS NOT NULL
            AND delivered_at <= ${before}
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id
    `);
    return deleted.rows.length;
  }

  /** Queue depth, for `/diagnostics`. */
  async pending(at = new Date()): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)::text` })
      .from(billingNotifications)
      .where(and(isNull(billingNotifications.deliveredAt), gt(billingNotifications.expiresAt, at)));
    return Number(row?.n ?? 0);
  }
}
