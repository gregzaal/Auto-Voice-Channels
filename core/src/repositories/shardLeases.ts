import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { shardLeases } from '../db/schema.js';

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
 */
export class ShardLeaseRepository {
  constructor(private readonly db: Database) {}

  /** Ensures lease rows exist for shards `0..totalShards-1` (idempotent). */
  async ensureRows(totalShards: number): Promise<void> {
    if (totalShards <= 0) return;
    const values = Array.from({ length: totalShards }, (_, shardId) => ({
      shardId,
      totalShards,
    }));
    await this.db.insert(shardLeases).values(values).onConflictDoNothing({
      target: shardLeases.shardId,
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
    // Take over only if unowned, owned by us, or the lease has expired.
    const takeover = or(
      isNull(shardLeases.instanceId),
      eq(shardLeases.instanceId, instanceId),
      lt(shardLeases.heartbeatAt, cutoff),
    );
    if (!takeover) throw new Error('failed to build takeover condition');
    const [row] = await this.db
      .insert(shardLeases)
      .values({
        shardId,
        totalShards,
        instanceId,
        heartbeatAt: now,
        claimedAt: now,
      })
      .onConflictDoUpdate({
        target: shardLeases.shardId,
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
   * Refreshes the heartbeat for all shards currently owned by `instanceId` and
   * returns the shard ids still owned. A returned set smaller than what the caller
   * believed it owned means a lease was lost (expired under a stall, or stolen) —
   * the caller must stop serving those shards.
   */
  async heartbeat(instanceId: string): Promise<number[]> {
    const now = new Date();
    const updated = await this.db
      .update(shardLeases)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(eq(shardLeases.instanceId, instanceId))
      .returning({ shardId: shardLeases.shardId });
    return updated.map((r) => r.shardId).sort((a, b) => a - b);
  }

  /** Releases a shard if (and only if) this instance still owns it. */
  async release(shardId: number, instanceId: string): Promise<boolean> {
    const now = new Date();
    const released = await this.db
      .update(shardLeases)
      .set({ instanceId: null, heartbeatAt: null, claimedAt: null, updatedAt: now })
      .where(and(eq(shardLeases.shardId, shardId), eq(shardLeases.instanceId, instanceId)))
      .returning({ shardId: shardLeases.shardId });
    return released.length > 0;
  }

  /** Releases all shards owned by this instance (graceful drain). */
  async releaseAll(instanceId: string): Promise<number> {
    const now = new Date();
    const released = await this.db
      .update(shardLeases)
      .set({ instanceId: null, heartbeatAt: null, claimedAt: null, updatedAt: now })
      .where(eq(shardLeases.instanceId, instanceId))
      .returning({ shardId: shardLeases.shardId });
    return released.length;
  }

  async list(): Promise<ShardLease[]> {
    return this.db.select().from(shardLeases).orderBy(shardLeases.shardId);
  }

  /**
   * Runs `fn` while holding the identify advisory lock, serializing shard
   * identifies cluster-wide. Uses a transaction-scoped lock (auto-released).
   */
  async withIdentifyLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${IDENTIFY_ADVISORY_LOCK})`);
      return fn();
    });
  }
}
