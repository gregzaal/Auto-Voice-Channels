import { RUNTIME_FLAGS, type Logger, type RuntimeFlagsRepository } from '@avc/core';
import type { CreateGateDecision, CreationGate } from '../features/voice/index.js';

export interface RuntimeCreationGateOptions {
  flags: RuntimeFlagsRepository;
  logger: Logger;
  /**
   * Whether this instance can still prove it holds the shard lease.
   *
   * **This is the half of `plans/scaling.md` §6.1 that `ownsGuild` does not
   * cover, and without it the fix does not do what it says.** `ownsGuild` is
   * consulted by the reconcile sweep and by nothing on the live join path, so an
   * instance whose lease had aged out would stop pruning rows and carry on
   * creating rooms. Discord delivers the same VOICE_STATE_UPDATE to every open
   * session for a shard, so once a peer has claimed the same shard both
   * instances create a room on the same join: the exact harm §6.1 describes.
   *
   * Optional, so a self-host and every existing test are unchanged: absent means
   * ownership is never in doubt, which for one instance holding every shard is
   * true.
   */
  leasesProven?: () => boolean;
  /** Sliding throttle window (ms). Defaults to 60s (limit is "per minute"). */
  windowMs?: number;
  /** How long to cache the flag snapshot to avoid a DB read per create (ms). */
  flagCacheMs?: number;
}

/**
 * The live creation gate backing the runtime control plane. Denies creation when
 * `global.pause` is set, and enforces `create.rate_limit_per_min` as a per-guild
 * sliding window. Flag reads are cached briefly so a join storm doesn't hammer
 * Postgres; the throttle window is kept in memory per guild.
 *
 * Per-guild isolation: one guild hitting its throttle never affects another.
 */
export class RuntimeCreationGate implements CreationGate {
  private readonly windowMs: number;
  private readonly flagCacheMs: number;
  private readonly events = new Map<string, number[]>();
  private flagCache: { at: number; paused: boolean; limit: number } | undefined;

  constructor(private readonly opts: RuntimeCreationGateOptions) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.flagCacheMs = opts.flagCacheMs ?? 2_000;
  }

  async allowCreate(guildId: string): Promise<CreateGateDecision> {
    /**
     * Checked FIRST, and before the flag read, because it needs no I/O and
     * because creating a room this instance may not own is the worst of the
     * outcomes this gate exists to prevent.
     *
     * Costs nothing real when it fires: the create path needs
     * `autoChannels.get` per join, so if the lease cannot be refreshed the
     * database is almost certainly unreachable and the create would fail a
     * moment later anyway. The difference is that it fails here, once, with a
     * reason, instead of racing a peer.
     */
    if (this.opts.leasesProven && !this.opts.leasesProven()) {
      return { allowed: false, reason: 'shard lease could not be refreshed' };
    }

    const { paused, limit } = await this.readFlags();
    if (paused) return { allowed: false, reason: 'global pause' };
    if (limit <= 0) return { allowed: true };

    const now = Date.now();
    const recent = (this.events.get(guildId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= limit) {
      this.events.set(guildId, recent);
      return { allowed: false, reason: `throttled (${limit}/min)` };
    }
    recent.push(now);
    this.events.set(guildId, recent);
    return { allowed: true };
  }

  private async readFlags(): Promise<{ paused: boolean; limit: number }> {
    const now = Date.now();
    if (this.flagCache && now - this.flagCache.at < this.flagCacheMs) {
      return { paused: this.flagCache.paused, limit: this.flagCache.limit };
    }
    const all = await this.opts.flags.getAll();
    const paused = all[RUNTIME_FLAGS.GLOBAL_PAUSE] === true;
    const rawLimit = all[RUNTIME_FLAGS.CREATE_RATE_LIMIT];
    const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : 0;
    this.flagCache = { at: now, paused, limit };
    return { paused, limit };
  }
}
