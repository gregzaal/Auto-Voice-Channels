import {
  RUNTIME_FLAGS,
  type AutoChannelRepository,
  type Logger,
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
  flags: RuntimeFlagsRepository;
  logger: Logger;
  /** Periodic safety-net sweep interval (ms). Defaults to 5 minutes. */
  sweepIntervalMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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

  constructor(private readonly deps: ReconcilerDeps) {
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Reconcile one guild through its per-guild queue (ordered + isolated). */
  reconcileGuild(guildId: string, opts: ReconcileOptions = {}): Promise<GuildDrift> {
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
    const results = await Promise.allSettled(
      [...guildIds].map((id) => this.reconcileGuild(id, opts)),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.deps.logger.error({ err: r.reason }, 'guild reconcile failed (isolated)');
      }
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

  /** Distinct guilds with at least one primary or tracked secondary. */
  private async scopedGuildIds(): Promise<string[]> {
    const [withSecondaries, withPrimaries] = await Promise.all([
      this.deps.secondaries.listGuildIds(),
      this.deps.autoChannels.listGuildIds(),
    ]);
    return [...new Set([...withSecondaries, ...withPrimaries])];
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
