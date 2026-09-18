import {
  RUNTIME_FLAGS,
  type AutoChannelRepository,
  type Logger,
  type ManagedChannelRepository,
  type RuntimeFlagsRepository,
  type SecondaryChannelRepository,
} from '@avc/core';
import { isPermissionError } from './discordAdapter.js';
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
   * guild's now-unmanaged channels. Omitted → all guilds
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
   * actively serving. Omitted → every
   * guild is in scope (tests, self-host, a single-instance fleet).
   */
  ownsGuild?: (guildId: string) => boolean;
  /**
   * The fleet-wide companion-orphan sweep, run once per tick outside the
   * per-guild loop.
   *
   * It has to live here rather than inside `reconcileGuild` because every
   * per-guild path is unable to reach the case that actually leaks: `scopedGuildIds`
   * filters by `ownsGuild`, and `reconcileGuild` bails on a guild the gateway has
   * not hydrated, which a guild the bot has been REMOVED from never is. Its
   * predicate is a single SQL existence check, so it needs neither.
   */
  sweepCompanionOrphans?: () => Promise<{ removed: number }>;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Guilds refusing reconcile on permissions before the operator hears about it,
 * and the share of the sweep they have to be.
 *
 * **One guild's 403 is that guild's own decision, not an incident.** An admin
 * changing an overwrite, moving a room out of reach or dropping the bot's role
 * makes every sweep fail for that guild until the bot gives up managing the
 * channel, and on 2026-09-17 one such guild produced a couple of hours of
 * `reconcile.failed` on beta - an alert about a server only its own admin can
 * fix, who had already been sent a DM by `PermissionProblemNotifier`. Paging
 * the operator for it is the noise this whole file's summary exists to avoid,
 * one level up.
 *
 * Half the fleet refusing at once is the opposite: that is the bot's own role
 * or a Discord-side change, and it is the only version an operator can act on.
 * The same shape and the same numbers as `reportIfFleetwide`, deliberately:
 * two different definitions of "fleet-wide" is how two alerts end up
 * disagreeing about one outage.
 */
const DENIED_MIN_GUILDS = 10;
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
     * A sweep over the whole install base can fail for every guild at once
     * when the cause is shared (the database being unreachable, say), and one
     * alert per guild would be a thousand messages describing one fault. The
     * summary below reports the shape instead: how many failed out of how
     * many, with a sample.
     */
    const failures: string[] = [];
    /**
     * Permission refusals, counted apart from faults.
     *
     * Kept out of `failures` rather than filtered at the report, because the
     * two are different claims: a fault is something wrong with us, and a 403
     * is a guild telling us we may no longer touch a channel. The bot acts on
     * the latter already - it stops managing the channel and the guild's own
     * contact is notified - so the operator alert below would be a report about
     * work that is already correctly handled.
     */
    const denied: string[] = [];
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          await this.reconcileGuild(id, opts);
        } catch (err) {
          if (isPermissionError(err)) {
            // Logged, never counted: the guild-facing path owns this one.
            this.deps.logger.info({ err, guildId: id }, 'guild reconcile refused on permissions');
            denied.push(id);
            continue;
          }
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
        // Reported alongside so a sweep that is failing AND being refused reads
        // as one event rather than two unrelated numbers.
        ...(denied.length > 0 ? { deniedOnPermissions: denied.length } : {}),
      });
    }

    /**
     * The fleet-wide refusal, which IS ours. See {@link DENIED_MIN_GUILDS}.
     */
    if (denied.length >= DENIED_MIN_GUILDS && denied.length * 2 >= ids.length) {
      this.deps.report?.(
        'reconcile.denied',
        'Most guilds are refusing reconciliation with a permission error',
        { denied: denied.length, of: ids.length, sample: denied.slice(0, 5) },
      );
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
    /**
     * Before the per-guild pass, and never inside a dispatch.
     *
     * Its own try/catch because it is unrelated work sharing a timer: a failure
     * here must not cost the guild sweep, which is the one with customers
     * waiting on it. Skipped on a dry run, which reports drift rather than
     * acting.
     */
    if (!opts.dryRun && this.deps.sweepCompanionOrphans) {
      try {
        await this.deps.sweepCompanionOrphans();
      } catch (err) {
        this.deps.logger.error({ err }, 'companion orphan sweep failed');
      }
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
