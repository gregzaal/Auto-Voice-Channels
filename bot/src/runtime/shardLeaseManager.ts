import type { Logger, ShardLeaseRepository } from '@avc/core';

export interface ShardLeaseManagerOptions {
  repo: ShardLeaseRepository;
  logger: Logger;
  instanceId: string;
  totalShards: number;
  /**
   * The most shards this instance will claim (fleet distribution). Defaults to
   * `totalShards` — the self-host case, where one instance claims everything.
   */
  maxShards?: number;
  /** A lease is considered expired after this long without a heartbeat. */
  leaseTtlMs?: number;
  /** How often to heartbeat owned leases. Must be well below the TTL. */
  heartbeatIntervalMs?: number;
  /** How often a boot-time claim retries while it is below its cap. */
  claimRetryIntervalMs?: number;
  /**
   * How long boot-time claiming keeps retrying for free shards before giving up
   * with whatever it has. Sized to outlast a fast-restarted peer's lease expiry,
   * so a replacement machine reliably picks up the orphaned shards.
   */
  claimRetryWindowMs?: number;
  /**
   * Called when a heartbeat reveals this instance no longer owns shards it was
   * running (a lease was stolen). Orchestrator-driven failover: the instance
   * should drain and exit so it re-claims cleanly on restart. Never called for a
   * lease that merely expired but is still ours (heartbeat re-affirms those).
   */
  onLeaseLost?: (lostShardIds: number[]) => void;
  /**
   * Reports a significant condition to the operational alert channel.
   *
   * Added because a failing heartbeat was a `logger.error` and nothing else
   * (`plans/scaling.md` §6.1): the instance keeps its gateway sessions and
   * keeps serving while its row ages past the TTL and a booting peer
   * legitimately claims the same shard. Two instances then serve it, and the
   * only trace is one log line on a fleet running at info.
   */
  report?: (kind: string, message: string, context: Record<string, unknown>) => void;
  /** Injectable interval scheduler for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Injectable sleep for tests (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Owns this instance's shard leases: claims its share of available shards (up to
 * its cap), heartbeats them, and releases on shutdown. At a single instance the
 * cap is the full shard count, so it simply claims everything.
 *
 * Failover is **orchestrator-driven**: surviving instances do NOT grab a dead
 * peer's shards mid-life (they are already at their cap). When an instance dies,
 * its leases expire and its replacement machine claims them at boot — boot-time
 * claiming retries across the lease-expiry window to make that reliable even on a
 * fast restart. If a live instance *loses* a lease (stolen under a >TTL stall), it
 * reacts via {@link ShardLeaseManagerOptions.onLeaseLost} (drain + restart).
 */
export class ShardLeaseManager {
  private readonly repo: ShardLeaseRepository;
  private readonly logger: Logger;
  private readonly instanceId: string;
  private readonly totalShards: number;
  private readonly maxShards: number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly claimRetryIntervalMs: number;
  private readonly claimRetryWindowMs: number;
  private readonly onLeaseLost: ((lostShardIds: number[]) => void) | undefined;
  private readonly report:
    | ((kind: string, message: string, context: Record<string, unknown>) => void)
    | undefined;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private owned = new Set<number>();
  private lastHeartbeatOkAt: number | null = null;
  private consecutiveHeartbeatFailures = 0;

  constructor(options: ShardLeaseManagerOptions) {
    this.repo = options.repo;
    this.logger = options.logger.child({ component: 'shard-lease-manager' });
    this.instanceId = options.instanceId;
    this.totalShards = options.totalShards;
    this.maxShards = options.maxShards ?? options.totalShards;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.claimRetryIntervalMs = options.claimRetryIntervalMs ?? 2_000;
    this.claimRetryWindowMs = options.claimRetryWindowMs ?? this.leaseTtlMs * 1.5;
    this.onLeaseLost = options.onLeaseLost;
    this.report = options.report;
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get ownedShards(): number[] {
    return [...this.owned].sort((a, b) => a - b);
  }

  /**
   * Whether this instance owns the shard `guildId` hashes to, per Discord's
   * `(guild_id >> 22) % total_shards` formula.
   *
   * Nothing in the tree computed a guild-to-shard mapping before this
   * (`plans/scaling.md` §9.1 finding 1) — every fleet-wide Postgres read (the
   * sweep, chiefly) had no way to scope itself to this instance's shards, and
   * fell back to deciding what to act on by reading the local discord.js
   * cache instead, which is wrong the moment an instance holds only some of
   * the shards. This is the primitive that lets a fleet-wide read scope
   * itself correctly.
   */
  ownsGuild(guildId: string): boolean {
    const shardId = Number((BigInt(guildId) >> 22n) % BigInt(this.totalShards));
    return this.owned.has(shardId);
  }

  /**
   * Heartbeat liveness, for the in-process watcher to poll.
   *
   * Exposed rather than alerted on from in here alone, because the two answer
   * different questions: this class knows when a single beat failed, and only
   * something evaluating on a schedule can say the condition is still true and
   * resolve it when it stops being.
   */
  get heartbeatHealth(): { lastOkAt: number | null; consecutiveFailures: number } {
    return {
      lastOkAt: this.lastHeartbeatOkAt,
      consecutiveFailures: this.consecutiveHeartbeatFailures,
    };
  }

  /** Claims this instance's share (up to its cap) in a single pass. */
  async claim(): Promise<number[]> {
    const claimed = await this.repo.claimAvailable(
      this.instanceId,
      this.totalShards,
      this.leaseTtlMs,
      this.maxShards,
    );
    this.owned = new Set(claimed);
    this.logger.info({ claimed, cap: this.maxShards }, 'claimed shard leases');
    return claimed;
  }

  /**
   * Boot-time claim: claims its share, then retries while below cap until the
   * retry window elapses — so a replacement instance rides out a dead peer's
   * lease expiry and picks up its shards. Stops early once at cap, or once it
   * holds some shards and a pass frees nothing more (the rest are held by live
   * peers, i.e. this is just our fair share).
   */
  async claimWithRetry(): Promise<number[]> {
    const deadline = Date.now() + this.claimRetryWindowMs;
    let claimed = await this.claim();
    while (claimed.length < this.maxShards && Date.now() < deadline) {
      await this.sleepFn(this.claimRetryIntervalMs);
      const before = claimed.length;
      claimed = await this.claim();
      if (claimed.length === before && claimed.length > 0) break;
    }
    if (claimed.length === 0) {
      this.logger.warn(
        { cap: this.maxShards, totalShards: this.totalShards },
        'claimed no shards — fleet may be over-provisioned (more instances than EXPECTED_INSTANCES)',
      );
    }
    return claimed;
  }

  /** Starts the periodic heartbeat keeping owned leases alive. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = this.setIntervalFn(() => {
      void this.heartbeatOnce();
    }, this.heartbeatIntervalMs);
    // Don't keep the event loop alive solely for the heartbeat.
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  async heartbeatOnce(): Promise<void> {
    try {
      // Filtered to what we currently believe we own — see the repo method's
      // own doc for why an unfiltered heartbeat would let a stale claim on a
      // shard we no longer serve refresh itself forever.
      const owned = await this.repo.heartbeat(this.instanceId, [...this.owned]);
      this.lastHeartbeatOkAt = Date.now();
      this.consecutiveHeartbeatFailures = 0;
      const ownedSet = new Set(owned);
      const lost = [...this.owned].filter((shardId) => !ownedSet.has(shardId));
      this.owned = ownedSet;
      if (lost.length > 0) {
        this.logger.error({ lost, stillOwned: owned }, 'lost shard lease(s) — reacting');
        // Terminal for this instance: it drains and exits so the replacement
        // re-claims cleanly. Nothing later in this process will report it.
        this.report?.('shard.lease_lost', 'Shard lease lost, instance is draining', {
          lost: lost.join(', '),
          stillOwned: owned.length,
          instanceId: this.instanceId,
        });
        this.onLeaseLost?.(lost);
        return;
      }
      this.logger.debug({ count: owned.length }, 'heartbeat refreshed leases');
    } catch (err) {
      this.consecutiveHeartbeatFailures += 1;
      this.logger.error(
        { err, consecutiveFailures: this.consecutiveHeartbeatFailures },
        'heartbeat failed',
      );
    }
  }

  /** Stops heartbeating and releases all owned leases (graceful drain). */
  async releaseAll(): Promise<void> {
    if (this.heartbeatTimer) {
      this.clearIntervalFn(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const released = await this.repo.releaseAll(this.instanceId);
    this.owned.clear();
    this.logger.info({ released }, 'released all shard leases');
  }
}
