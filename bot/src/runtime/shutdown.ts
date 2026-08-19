import type { Config, Logger, PgNotifier, SettingsCache } from '@avc/core';
import type { Client } from 'discord.js';
import type { GuildDispatcher } from './dispatcher.js';
import type { ShardLeaseManager } from './shardLeaseManager.js';
import type { HealthServer } from '../ops/health.js';
import type { Reconciler } from '../features/voice/index.js';
import type { BillingReconciler, EntitlementGate } from '../features/billing/index.js';
import type { BackupScheduler } from './backupScheduler.js';
import type { MetricsCollector } from './metricsCollector.js';

export interface ShutdownDeps {
  logger: Logger;
  config: Config;
  leaseManager: ShardLeaseManager;
  dispatcher: GuildDispatcher;
  reconciler: Reconciler;
  health: HealthServer;
  client: Client;
  settingsCache: SettingsCache;
  notifier: PgNotifier;
  dbPingTimer: ReturnType<typeof setInterval>;
  disposeVoiceGateway: () => void;
  disposeJoinRequests: () => void;
  disposeInteractions: () => void;
  disposeOnboarding: () => void;
  disposeGuildIdentity: () => void;
  /** Undefined when SELF_HOSTED (the job never exists there). */
  billingReconciler: BillingReconciler | undefined;
  backupScheduler: BackupScheduler | undefined;
  /** Always present: the collector runs on self-host too. */
  metricsCollector: MetricsCollector;
  entitlementGate: EntitlementGate;
  closeDb: () => Promise<void>;
}

/**
 * The graceful-drain sequence, ordered so in-flight work finishes before the
 * resources it depends on go away: stop new work (timers/sweep/listeners) →
 * finish in-flight per-guild queues → release shard leases → tear down the
 * gateway, settings cache/notifier, health server, and finally the DB pool.
 *
 * Pure (no `process.exit`) so the ordering is unit-testable; {@link installShutdown}
 * wraps it with the exit.
 */
export async function gracefulDrain(deps: ShutdownDeps): Promise<void> {
  clearInterval(deps.dbPingTimer);
  deps.reconciler.stopSweep();
  // Awaited: an in-flight billing pass must finish (or bail at its next
  // per-guild checkpoint) before the DB pool goes away.
  await deps.billingReconciler?.stop();
  // Awaited, not aborted: a half-uploaded object with no manifest is worse than
  // a slower deploy, and the next boot could not tell it from a good one.
  await deps.backupScheduler?.stop();
  deps.disposeInteractions();
  deps.disposeJoinRequests();
  deps.disposeVoiceGateway();
  deps.disposeOnboarding();
  deps.disposeGuildIdentity();
  deps.client.removeAllListeners();
  await deps.dispatcher.drainAll();
  /**
   * After the queues drain, so rooms cleaned up during the drain are counted, and
   * well before the pool closes. Without this final flush every instance would
   * silently discard up to a flush interval of counters on every release, which
   * is a systematic downward bias on exactly the metrics nothing can recover, not
   * a random one.
   */
  await deps.metricsCollector.stop();
  await deps.leaseManager.releaseAll();
  await deps.client.destroy();
  await deps.settingsCache.stop();
  deps.entitlementGate.stop();
  await deps.notifier.close();
  await deps.health.stop();
  await deps.closeDb();
}

/**
 * Installs the graceful-drain handler on SIGINT/SIGTERM (rolling deploys → exit 0)
 * and returns it so callers can trigger a drain programmatically — e.g. a
 * lease-loss reaction drains then exits non-zero so the orchestrator restarts us
 * into a clean re-claim. Re-entrant calls are ignored.
 */
export function installShutdown(deps: ShutdownDeps): (reason: string, exitCode: number) => void {
  let shuttingDown = false;
  const handler = (reason: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ reason, exitCode }, 'shutting down (graceful drain)');
    void gracefulDrain(deps).then(
      () => {
        deps.logger.info('shutdown complete');
        process.exit(exitCode);
      },
      (err: unknown) => {
        deps.logger.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => handler('SIGINT', 0));
  process.once('SIGTERM', () => handler('SIGTERM', 0));
  return handler;
}
