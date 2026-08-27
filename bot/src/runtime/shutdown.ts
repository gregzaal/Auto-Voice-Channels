import type { Config, Logger, PgNotifier, SettingsCache } from '@avc/core';
import type { Client } from 'discord.js';
import type { GuildDispatcher } from './dispatcher.js';
import type { ShardLeaseManager } from './shardLeaseManager.js';
import type { HealthServer } from '../ops/health.js';
import type { Reconciler } from '../features/voice/index.js';
import type { BillingReconciler, EntitlementGate } from '../features/billing/index.js';
import type { AlertScheduler } from './alertScheduler.js';
import type { TopggScheduler } from './topggScheduler.js';
import type { BackupScheduler } from './backupScheduler.js';
import type { MetricsCollector } from './metricsCollector.js';
import type { SupporterRoles } from '../features/support/supporterRoles.js';

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
  /** Undefined unless the supporter-role group is configured (hosted only). */
  supporterRoles: SupporterRoles | undefined;
  /** Unsubscribes the supporter NOTIFY listener. Undefined when unconfigured. */
  disposeSupporterSync: (() => void) | undefined;
  /** Always present: the watcher runs on self-host too. */
  alertScheduler: AlertScheduler;
  /** Absent without a `TOPGG_TOKEN`. */
  topggScheduler: TopggScheduler | undefined;
  /** Always present: the collector runs on self-host too. */
  metricsCollector: MetricsCollector;
  entitlementGate: EntitlementGate;
  closeDb: () => Promise<void>;
}

/**
 * The graceful-drain sequence, ordered so in-flight work finishes before the
 * resources it depends on go away: stop new work (timers/sweep/listeners) →
 * finish in-flight per-guild queues → destroy the gateway → release shard
 * leases → tear down settings cache/notifier, health server, and finally the
 * DB pool.
 *
 * Pure (no `process.exit`) so the ordering is unit-testable; {@link installShutdown}
 * wraps it with the exit.
 */
export async function gracefulDrain(deps: ShutdownDeps): Promise<void> {
  /**
   * The watcher stops FIRST, before anything is torn down.
   *
   * Everything below this line makes the instance look unhealthy on purpose:
   * the gateway goes away, leases are released, the pool closes. A watcher
   * still evaluating during that would confirm `gateway.down`, post a critical
   * to the admin channel and withhold the watchdog ping, so every routine
   * deploy would page someone about a machine that is shutting down exactly as
   * designed.
   */
  await deps.alertScheduler.stop();
  // Stopped alongside the watcher, and for the same reason: it talks to a third
  // party, and a machine on its way out should stop doing that first.
  await deps.topggScheduler?.stop();
  clearInterval(deps.dbPingTimer);
  deps.reconciler.stopSweep();
  // Awaited: an in-flight billing pass must finish (or bail at its next
  // per-guild checkpoint) before the DB pool goes away.
  await deps.billingReconciler?.stop();
  // Awaited, not aborted: a half-uploaded object with no manifest is worse than
  // a slower deploy, and the next boot could not tell it from a good one.
  await deps.backupScheduler?.stop();
  /**
   * Awaited for the same reason as the two above: a reconcile is a sequence of
   * independent role writes, so stopping between two of them is consistent and
   * abandoning one mid-write is not.
   */
  await deps.supporterRoles?.stop();
  deps.disposeInteractions();
  deps.disposeJoinRequests();
  deps.disposeVoiceGateway();
  deps.disposeOnboarding();
  deps.disposeGuildIdentity();
  deps.disposeSupporterSync?.();
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
  /**
   * The gateway is destroyed BEFORE leases are released, not after.
   *
   * Releasing first frees the shard ids in the database while this process
   * still holds their live WebSocket sessions, and a booting peer retries its
   * claim every 2s (`plans/scaling.md` §6.2) — a window where a replacement
   * could legitimately claim a shard this instance is still actively serving.
   * Destroying first closes those sessions before the rows go free, so
   * nothing is ever claimable while still live here. Confirmed safe to
   * reorder: nothing between here and `releaseAll` reads from Discord, and
   * `client.destroy()` doesn't touch shard leases.
   */
  await deps.client.destroy();
  await deps.leaseManager.releaseAll();
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
