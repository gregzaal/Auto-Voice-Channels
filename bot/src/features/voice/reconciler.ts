import {
  RUNTIME_FLAGS,
  type AutoChannelRepository,
  type Logger,
  type ManagedChannelRepository,
  type RuntimeFlagsRepository,
  type SecondaryChannelRepository,
} from '@avc/core';
import type { GuildDispatcher } from '../../runtime/dispatcher.js';
import type { GuildDrift, ReconcileOptions, VoiceFeature } from './handler.js';

export interface ReconcilerDeps {
  feature: VoiceFeature;
  dispatcher: GuildDispatcher;
  secondaries: SecondaryChannelRepository;
  autoChannels: AutoChannelRepository;
  /** Adopted standalone channels, so the sweep also covers guilds that only have those. */
  managed?: ManagedChannelRepository;
  flags: RuntimeFlagsRepository;
  logger: Logger;
  /** Periodic safety-net sweep interval (ms). Defaults to 5 minutes. */
  sweepIntervalMs?: number;
  /** Max guilds reconciled concurrently (bounds the DB/CPU burst). Default 10. */
  reconcileConcurrency?: number;
  /**
   * Operational alerting. Optional so tests and self-host paths that construct
   * this directly need not supply one, matching every other optional dep here.
   */
  report?: (kind: string, message: string, context?: Record<string, unknown>) => void;
  /**
   * Entitlement gate: non-entitled (hard-gated) guilds are skipped — the gate
   * is non-destructive, so reconcile must never "clean up" (delete) a gated
   * guild's now-unmanaged channels (monetization.md §4). Omitted → all guilds
   * reconcile (tests, self-host).
   */
  entitled?: (guildId: string) => boolean | Promise<boolean>;
  /**
   * Scopes the sweep to guilds this instance actually owns a shard for.
   *
   * `scopedGuildIds()` selects fleet-wide from Postgres with no shard
   * predicate; on a single instance that's the whole fleet and this is a
   * no-op, but on a partial-shard instance the guilds it does NOT own would
   * otherwise be reconciled anyway, and `channelExists` reading the local
   * discord.js cache would read every one of them as gone — deleting live
   * `secondary_channels`/`managed_channels` rows the other instance is
   * actively serving (`plans/scaling.md` §9.1 finding 1). Omitted → every
   * guild is in scope (tests, self-host, a single-instance fleet).
   */
  ownsGuild?: (guildId: string) => boolean;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RECONCILE_CONCURRENCY = 10;

/**
 * Orchestrates reconciliation: which guilds to converge and when. The actual
 * per-guild diff/converge lives in {@link VoiceFeature.reconcileGuild}; this
 * class decides scope (a shard's guilds on READY, or only guilds with managed
 * channels for the sweep), routes each through the per-guild dispatcher (so
 * reconcile is ordered against live events and fault-isolated), and respects the
 * runtime control-plane flags (global pause, sweep disable).
 */
export class Reconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly sweepIntervalMs: number;
  private readonly reconcileConcurrency: number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.reconcileConcurrency = Math.max(
      1,
      deps.reconcileConcurrency ?? DEFAULT_RECONCILE_CONCURRENCY,
    );
  }

  /** Reconcile one guild through its per-guild queue (ordered + isolated). */
  async reconcileGuild(guildId: string, opts: ReconcileOptions = {}): Promise<GuildDrift> {
    // A dry run only reports drift (ops tooling), so it's allowed even for a
    // gated guild; anything that would act is skipped while non-entitled.
    if (!opts.dryRun && this.deps.entitled && !(await this.deps.entitled(guildId))) {
      return {
        guildId,
        dryRun: false,
        orphanedRecords: [],
        deletedEmpty: [],
        created: [],
        renamed: [],
      };
    }
    return this.deps.dispatcher.dispatch(guildId, 'reconcile', () =>
      this.deps.feature.reconcileGuild(guildId, opts),
    );
  }

  /**
   * Reconcile-on-READY: converge every guild this shard owns after a (re)connect,
   * catching up on events missed while disconnected. Each guild is fault-isolated
   * — one guild's failure never blocks the others.
   */
  async reconcileGuilds(guildIds: Iterable<string>, opts: ReconcileOptions = {}): Promise<void> {
    if (await this.isPaused()) {
      this.deps.logger.warn('reconcile skipped: global pause is set');
      return;
    }
    // Bounded worker pool: reconcile at most `reconcileConcurrency` guilds at once.
    // Each guild still runs through its own ordered/isolated queue; the cap keeps a
    // fleet-wide sweep (or a deploy's READY reconcile) from firing thousands of
    // per-guild query storms simultaneously against the single-primary Postgres.
    const ids = [...guildIds];
    let next = 0;
    /**
     * Collected rather than reported per guild.
     *
     * A sweep over the whole install base can fail for every guild at once when
     * the cause is shared -- the database being unreachable, say -- and one
     * alert per guild would be a thousand messages describing one fault. The
     * summary below reports the shape instead: how many failed out of how many,
     * with a sample. On 2026-08-20 this path failed silently for hours.
     */
    const failures: string[] = [];
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          await this.reconcileGuild(id, opts);
        } catch (err) {
          this.deps.logger.error({ err, guildId: id }, 'guild reconcile failed (isolated)');
          failures.push(id);
        }
      }
    };
    const poolSize = Math.min(this.reconcileConcurrency, ids.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    if (failures.length > 0) {
      this.deps.report?.('reconcile.failed', 'Guild reconciliation is failing', {
        failed: failures.length,
        of: ids.length,
        sample: failures.slice(0, 5),
      });
    }
  }

  /**
   * The thin periodic safety net: reconcile only guilds that currently have
   * managed channels (primaries or tracked secondaries). Disable-able via the
   * `sweep.disabled` runtime flag; skipped entirely under global pause.
   */
  async sweep(opts: ReconcileOptions = {}): Promise<void> {
    if (await this.isPaused()) return;
    if (await this.deps.flags.getBool(RUNTIME_FLAGS.SWEEP_DISABLED)) {
      this.deps.logger.debug('sweep skipped: disabled by runtime flag');
      return;
    }
    const guildIds = await this.scopedGuildIds();
    if (guildIds.length === 0) return;
    this.deps.logger.debug({ count: guildIds.length }, 'running safety-net sweep');
    await this.reconcileGuilds(guildIds, opts);
  }

  /**
   * Distinct guilds with at least one primary, tracked secondary, or adopted
   * channel, narrowed to the shards this instance owns (see `ownsGuild`'s doc).
   */
  private async scopedGuildIds(): Promise<string[]> {
    const [withSecondaries, withPrimaries, withManaged] = await Promise.all([
      this.deps.secondaries.listGuildIds(),
      this.deps.autoChannels.listGuildIds(),
      this.deps.managed?.listGuildIds() ?? Promise.resolve([]),
    ]);
    const all = [...new Set([...withSecondaries, ...withPrimaries, ...withManaged])];
    return this.deps.ownsGuild ? all.filter((guildId) => this.deps.ownsGuild!(guildId)) : all;
  }

  private isPaused(): Promise<boolean> {
    return this.deps.flags.getBool(RUNTIME_FLAGS.GLOBAL_PAUSE);
  }

  /** Starts the periodic sweep timer. Idempotent. */
  startSweep(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        this.deps.logger.error({ err }, 'safety-net sweep failed');
      });
    }, this.sweepIntervalMs);
    // Don't keep the process alive solely for the sweep.
    this.timer.unref?.();
  }

  stopSweep(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
