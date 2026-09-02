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
  /**
   * When this instance last successfully claimed, which is proof of ownership in
   * its own right until the first heartbeat lands. Without it a machine that has
   * claimed but not yet beaten looks unproven and refuses to serve for its first
   * heartbeat interval.
   */
  private claimedAt: number | null = null;
  /** So the stand-aside is reported once per episode, not once per beat. */
  private standingAside = false;

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
    if (!this.leasesProven()) return false;
    const shardId = Number((BigInt(guildId) >> 22n) % BigInt(this.totalShards));
    return this.owned.has(shardId);
  }

  /**
   * Whether this instance can still PROVE it owns the shards it is serving.
   *
   * **This is `plans/scaling.md` §6.1, and it is the difference between an alert
   * and the process stepping aside.** A heartbeat that fails or hangs used to
   * increment a counter and log. The lease row then ages past its 30s TTL, a
   * booting peer legitimately claims the same shard, and this instance keeps its
   * gateway session and keeps serving it. Two instances then act on one guild:
   * duplicate rooms, duplicate renames, and the only trace is a log line on a
   * fleet running at info.
   *
   * Ownership is a claim with an expiry, so once the claim is older than the TTL
   * this instance has to stop asserting it. Everything scoped by
   * {@link ownsGuild} then declines on its own, `/health` reports leases down,
   * and it all comes back on the next successful beat.
   *
   * **Deliberately NOT an exit.** The most likely cause of a failing heartbeat is
   * the database being unreachable, and that hits every instance at once. Exiting
   * would restart the whole fleet into a boot that needs the database for
   * migrations, burn Fly's ten restart retries, and leave nothing running when
   * the database came back. Standing aside is recoverable, and during a database
   * outage there is nothing to serve anyway.
   */
  leasesProven(now = Date.now()): boolean {
    if (this.owned.size === 0) return false;
    // Never heartbeated since the claim: the claim itself is the proof, and it
    // is only as old as this process.
    const since = this.lastHeartbeatOkAt ?? this.claimedAt;
    return since !== null && now - since <= this.leaseTtlMs;
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
    // Proof of ownership until the first heartbeat lands.
    if (claimed.length > 0) this.claimedAt = Date.now();
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

  /**
   * Starts the periodic heartbeat keeping owned leases alive.
   *
   * **Fires one beat immediately**, which is not a nicety. `leasesProven` accepts
   * the claim itself as proof for one TTL, so with a bare `setInterval` the first
   * refresh landed a full interval after this was called, and this used to be
   * called after `client.login()` resolved. A boot whose gateway connect took
   * longer than the 30s TTL therefore spent the rest of its boot unable to prove
   * ownership it genuinely held: `/health` reporting down at the moment Fly's
   * grace period ends, and every ownership-scoped path declining.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    void this.heartbeatOnce();
    this.heartbeatTimer = this.setIntervalFn(() => {
      /**
       * The age test runs on every tick, whatever the last beat did.
       *
       * A beat that REJECTS reaches the catch below. A beat that never settles
       * at all (a pool client that never checks out, a socket the network
       * blackholed) rejects nothing, so before this the stand-aside happened
       * silently: `ownsGuild` went false and `/health` reported leases down with
       * no alert from the component that detected it. `watchChecks.ts` documents
       * the same split at `HEARTBEAT_STALE_MS`, and the hung case is the one this
       * deployment has actually had, 28 times in 4.5 hours.
       */
      if (!this.leasesProven()) this.noticeStandAside('the heartbeat has not completed');
      void this.heartbeatOnce();
    }, this.heartbeatIntervalMs);
    // Don't keep the event loop alive solely for the heartbeat.
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  async heartbeatOnce(): Promise<void> {
    /**
     * Stamped from BEFORE the query, not after it.
     *
     * The database row's own expiry is computed when the statement executes, so
     * measuring our proof from when the answer got back here makes this instance
     * assert ownership for longer than any peer considers the lease alive. The
     * error is however long the round trip took, which is exactly the quantity
     * that grows in the incident this guard exists for.
     */
    const startedAt = Date.now();
    try {
      // Filtered to what we currently believe we own — see the repo method's
      // own doc for why an unfiltered heartbeat would let a stale claim on a
      // shard we no longer serve refresh itself forever.
      const owned = await this.repo.heartbeat(this.instanceId, [...this.owned]);
      /**
       * Monotonic. `startedAt` is deliberately taken BEFORE the query (see
       * above), so two beats in flight together can land out of order and a
       * slow one returning late would otherwise REWIND the proof clock — the
       * one direction that turns a healthy instance into an unproven one and
       * stops it serving. Keep the newest proof we have.
       */
      this.lastHeartbeatOkAt = Math.max(this.lastHeartbeatOkAt ?? startedAt, startedAt);
      this.consecutiveHeartbeatFailures = 0;
      if (this.standingAside) {
        this.standingAside = false;
        this.logger.info({ owned: [...this.owned] }, 'shard ownership proven again, serving');
        this.report?.('shard.lease_recovered', 'Shard lease refreshed, instance is serving again', {
          owned: [...this.owned].join(', '),
          instanceId: this.instanceId,
        });
      }
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
      /**
       * Reported, which it never was.
       *
       * The class doc above says a failing heartbeat was "a `logger.error` and
       * nothing else", and the `report` hook was added for it and then not
       * called from here. So the one condition that leads to two instances
       * serving one shard produced no alert from the component that detects it.
       */
      this.noticeStandAside('heartbeat failed');
    }
  }

  /**
   * Says once, per episode, that this instance has stopped asserting ownership.
   *
   * Once per episode rather than once per beat: at a 10s interval a database
   * blip would otherwise post six times a minute to the alert channel, which is
   * how an alert channel stops being read.
   */
  private noticeStandAside(reason: string): void {
    if (this.leasesProven() || this.standingAside) return;
    this.standingAside = true;
    this.logger.error(
      { reason, owned: [...this.owned], instanceId: this.instanceId },
      'cannot prove shard ownership, standing aside until the heartbeat recovers',
    );
    this.report?.(
      'shard.lease_unproven',
      'Shard lease could not be refreshed, instance has stopped serving its shards',
      {
        reason,
        owned: [...this.owned].join(', '),
        instanceId: this.instanceId,
      },
    );
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
