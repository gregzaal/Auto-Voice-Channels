import type { Logger, ShardLeaseRepository } from '@avc/core';

export interface ShardLeaseManagerOptions {
  repo: ShardLeaseRepository;
  logger: Logger;
  instanceId: string;
  totalShards: number;
  /** A lease is considered expired after this long without a heartbeat. */
  leaseTtlMs?: number;
  /** How often to heartbeat owned leases. Must be well below the TTL. */
  heartbeatIntervalMs?: number;
  /** Injectable interval scheduler for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * Owns this instance's shard leases: claims available shards, heartbeats them,
 * and releases on shutdown. At a single instance it simply claims all shards,
 * so the self-hosted profile pays no behavioural cost.
 *
 * Re-claiming of a dead instance's shards happens naturally: when its heartbeat
 * lapses past the TTL, another instance's claim loop takes over the lease.
 */
export class ShardLeaseManager {
  private readonly repo: ShardLeaseRepository;
  private readonly logger: Logger;
  private readonly instanceId: string;
  private readonly totalShards: number;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private owned = new Set<number>();

  constructor(options: ShardLeaseManagerOptions) {
    this.repo = options.repo;
    this.logger = options.logger.child({ component: 'shard-lease-manager' });
    this.instanceId = options.instanceId;
    this.totalShards = options.totalShards;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
  }

  get ownedShards(): number[] {
    return [...this.owned].sort((a, b) => a - b);
  }

  /** Claims all currently-available shards. Safe to call repeatedly. */
  async claim(): Promise<number[]> {
    const claimed = await this.repo.claimAvailable(
      this.instanceId,
      this.totalShards,
      this.leaseTtlMs,
    );
    this.owned = new Set(claimed);
    this.logger.info({ claimed }, 'claimed shard leases');
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
      const count = await this.repo.heartbeat(this.instanceId);
      this.logger.debug({ count }, 'heartbeat refreshed leases');
    } catch (err) {
      this.logger.error({ err }, 'heartbeat failed');
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
