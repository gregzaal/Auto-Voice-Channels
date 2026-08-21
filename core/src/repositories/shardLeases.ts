import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, fleetAdvisoryKey, type Fleet } from '../domain/fleets.js';
import { identifyBuckets, shardLeases } from '../db/schema.js';

export type ShardLease = typeof shardLeases.$inferSelect;

/** A stable advisory-lock key namespace for serializing shard identifies. */
export const IDENTIFY_ADVISORY_LOCK = 0x5a7c_0001;

/**
 * Repository for shard ownership leases. A lease is a heartbeated row; an
 * expired heartbeat (dead instance) is re-claimable by another instance.
 *
 * Coordination uses native Postgres primitives — advisory locks (to serialize
 * identifies and respect Discord `max_concurrency`) and atomic conditional
 * UPDATEs (so two instances never both claim the same shard).
 *
 * **Everything here is fleet-scoped** (`plans/fleets.md` §2). Two live bots
 * shard independently, so shard 0 exists once per fleet and the two must never
 * contend for it. The identify throttle is scoped for a sharper reason:
 * Discord's `max_concurrency` is per APPLICATION, so a shared throttle would
 * make one fleet delay the other's identifies while computing the wrong spacing
 * for both.
 *
 * `fleet` defaults to `prod`, so self-host and every existing caller are
 * unchanged — a self-host is the only fleet in its own database.
 */
export class ShardLeaseRepository {
  constructor(
    private readonly db: Database,
    private readonly fleet: Fleet = DEFAULT_FLEET,
  ) {}

  /** Ensures lease rows exist for shards `0..totalShards-1` (idempotent). */
  async ensureRows(totalShards: number): Promise<void> {
    if (totalShards <= 0) return;
    const values = Array.from({ length: totalShards }, (_, shardId) => ({
      fleet: this.fleet,
      shardId,
      totalShards,
    }));
    await this.db
      .insert(shardLeases)
      .values(values)
      .onConflictDoNothing({
        // Composite: shard 0 is a different row per fleet.
        target: [shardLeases.fleet, shardLeases.shardId],
      });
  }

  /**
   * Attempts to claim a single shard for `instanceId`. Succeeds if the shard is
   * unclaimed, already owned by this instance, or its lease has expired (older
   * than `leaseTtlMs`). Returns the lease if claimed, else `undefined`.
   */
  async claim(
    shardId: number,
    instanceId: string,
    totalShards: number,
    leaseTtlMs: number,
  ): Promise<ShardLease | undefined> {
    const cutoff = new Date(Date.now() - leaseTtlMs);
    const now = new Date();
    /**
     * Take over only if unowned, owned by us, or the lease has expired.
     *
     * Deliberately NOT scoped by fleet: the conflict target is
     * `(fleet, shard_id)`, so the row this condition guards is already this
     * fleet's row. Adding a fleet predicate here would make the disjunction
     * always true and let any instance steal a live lease from a healthy peer.
     */
    const takeover = or(
      isNull(shardLeases.instanceId),
      eq(shardLeases.instanceId, instanceId),
      lt(shardLeases.heartbeatAt, cutoff),
    );
    if (!takeover) throw new Error('failed to build takeover condition');
    const [row] = await this.db
      .insert(shardLeases)
      .values({
        fleet: this.fleet,
        shardId,
        totalShards,
        instanceId,
        heartbeatAt: now,
        claimedAt: now,
      })
      .onConflictDoUpdate({
        target: [shardLeases.fleet, shardLeases.shardId],
        set: {
          instanceId,
          totalShards,
          heartbeatAt: now,
          claimedAt: now,
          updatedAt: now,
        },
        setWhere: takeover,
      })
      .returning();
    // A returning() row means our values won (we now own it).
    return row && row.instanceId === instanceId ? row : undefined;
  }

  /**
   * Claims shards available to this instance (unowned/expired/already-ours), up to
   * `maxShards`, and returns the set now owned. Iterates low→high so the fleet packs
   * deterministically: the first instance takes `0..cap-1`, the next `cap..2cap-1`,
   * and so on. With the default cap (`totalShards`) a single instance claims all
   * shards — the self-host behaviour.
   */
  async claimAvailable(
    instanceId: string,
    totalShards: number,
    leaseTtlMs: number,
    maxShards: number = totalShards,
  ): Promise<number[]> {
    await this.ensureRows(totalShards);
    const claimed: number[] = [];
    for (let shardId = 0; shardId < totalShards && claimed.length < maxShards; shardId++) {
      const lease = await this.claim(shardId, instanceId, totalShards, leaseTtlMs);
      if (lease) claimed.push(shardId);
    }
    return claimed;
  }

  /**
   * Refreshes the heartbeat for `shardIds` currently owned by `instanceId` and
   * returns the shard ids still owned. A returned set smaller than what the caller
   * believed it owned means a lease was lost (expired under a stall, or stolen) —
   * the caller must stop serving those shards.
   *
   * `shardIds` is required, deliberately — not "defaults to every row this
   * instance owns". An instance that shrank its claim (a config change between
   * restarts, e.g. Step A's `[0,1]` down to a Step B `[0]`) can still hold a
   * stale row for a shard it no longer serves if its own drain wasn't clean; an
   * unfiltered heartbeat would refresh that row forever, so the peer that is
   * supposed to own that shard can never claim it (`plans/scaling.md` §9.1
   * finding 2). Filtering by the caller's own believed-owned set is what makes
   * that row age out and become reclaimable instead.
   */
  async heartbeat(instanceId: string, shardIds: number[]): Promise<number[]> {
    const now = new Date();
    const updated = await this.db
      .update(shardLeases)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(
        and(
          eq(shardLeases.fleet, this.fleet),
          eq(shardLeases.instanceId, instanceId),
          inArray(shardLeases.shardId, shardIds),
        ),
      )
      .returning({ shardId: shardLeases.shardId });
    return updated.map((r) => r.shardId).sort((a, b) => a - b);
  }

  /** Releases a shard if (and only if) this instance still owns it. */
  async release(shardId: number, instanceId: string): Promise<boolean> {
    const now = new Date();
    const released = await this.db
      .update(shardLeases)
      .set({ instanceId: null, heartbeatAt: null, claimedAt: null, updatedAt: now })
      .where(
        and(
          eq(shardLeases.fleet, this.fleet),
          eq(shardLeases.shardId, shardId),
          eq(shardLeases.instanceId, instanceId),
        ),
      )
      .returning({ shardId: shardLeases.shardId });
    return released.length > 0;
  }

  /** Releases all shards owned by this instance (graceful drain). */
  async releaseAll(instanceId: string): Promise<number> {
    const now = new Date();
    const released = await this.db
      .update(shardLeases)
      .set({ instanceId: null, heartbeatAt: null, claimedAt: null, updatedAt: now })
      .where(and(eq(shardLeases.fleet, this.fleet), eq(shardLeases.instanceId, instanceId)))
      .returning({ shardId: shardLeases.shardId });
    return released.length;
  }

  async list(): Promise<ShardLease[]> {
    return this.db
      .select()
      .from(shardLeases)
      .where(eq(shardLeases.fleet, this.fleet))
      .orderBy(shardLeases.shardId);
  }

  /**
   * Reserves an identify slot for `bucket`, enforcing ≥`spacingMs` between
   * identifies in the same `max_concurrency` bucket across the whole fleet.
   * Serialized via the identify advisory lock (keyed per bucket, held only for
   * this short check then released at commit). Returns `{ ok: true }` when the
   * caller may identify now, or `{ ok: false, waitMs }` with how long until the
   * bucket frees. The durable timestamp enforces spacing for same-instance *and*
   * cross-instance identifies alike (a held lock would not — advisory locks are
   * re-entrant within a session).
   */
  async reserveIdentify(
    bucket: number,
    spacingMs: number,
  ): Promise<{ ok: boolean; waitMs: number }> {
    return this.db.transaction(async (tx) => {
      /**
       * Fleet-namespaced. An advisory lock key is a bare integer scoped only by
       * database, so without this the two fleets would serialize each other's
       * identifies — which is not merely wasteful, it is wrong: `max_concurrency`
       * is per application, so the spacing computed under a shared lock is
       * incorrect for both. The single 64-bit form is used because the two-int
       * form's second slot is already spent on the bucket.
       */
      const lockKey = fleetAdvisoryKey(IDENTIFY_ADVISORY_LOCK, this.fleet, bucket);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
      const [row] = await tx
        .select({ lastIdentifyAt: identifyBuckets.lastIdentifyAt })
        .from(identifyBuckets)
        .where(and(eq(identifyBuckets.fleet, this.fleet), eq(identifyBuckets.bucket, bucket)));
      const last = row?.lastIdentifyAt?.getTime() ?? 0;
      const elapsed = Date.now() - last;
      if (last !== 0 && elapsed < spacingMs) {
        return { ok: false, waitMs: spacingMs - elapsed };
      }
      const at = new Date();
      await tx
        .insert(identifyBuckets)
        .values({ fleet: this.fleet, bucket, lastIdentifyAt: at, updatedAt: at })
        .onConflictDoUpdate({
          target: [identifyBuckets.fleet, identifyBuckets.bucket],
          set: { lastIdentifyAt: at, updatedAt: at },
        });
      return { ok: true, waitMs: 0 };
    });
  }
}
