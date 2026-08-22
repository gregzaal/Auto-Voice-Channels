import type { Config, Logger } from '@avc/core';
import { HealthServer, type HealthReport, type SubsystemStatus } from '../ops/health.js';
import { COMMIT, VERSION } from '../version.js';
import type { ShardLeaseManager } from './shardLeaseManager.js';

/**
 * Idle bring-up for an instance holding zero shards (`plans/scaling.md`
 * §9.1). An over-provisioned fleet (`EXPECTED_INSTANCES` ahead of the real
 * machine count), or Step B's own deliberate window - a spare machine
 * created ahead of a config flip - ends boot-time claiming with zero owned
 * shards. discord.js cannot represent that: `buildGatewayClient` would pass
 * `shards: []`, which `Client._validateOptions` rejects outright
 * (`ClientInvalidProvidedShards`), crash-looping the process forever.
 *
 * Deliberately thin: no gateway client, so none of voice/billing/
 * interactions/admin-notifications exist either, and none of them are
 * needed here - they all assume a live gateway. Diagnostics, the lease
 * heartbeat and the DB ping keep running so the instance is observably idle
 * rather than invisible.
 *
 * There is deliberately no background re-claim loop. `heartbeatOnce` only
 * refreshes shards already in `owned` (`inArray(shardId, [])` matches
 * nothing) - it never acquires new ones - so an idle instance would never
 * pick up a freed shard without restarting anyway, matching the existing
 * boot-time-only claim design. The next restart (the deploy that gives this
 * instance real shards, or whatever fixes an over-provisioned fleet)
 * re-enters `claimWithRetry` fresh.
 *
 * Lives in its own module, not inline in `index.ts`, purely so it can be
 * imported by a test - `index.ts` itself runs `main()` unconditionally at
 * the bottom of the file (the real entrypoint), so importing it anywhere
 * triggers a real boot attempt.
 */
export async function runIdle(deps: {
  config: Config;
  logger: Logger;
  leaseManager: ShardLeaseManager;
  pool: { query: (text: string) => Promise<unknown> };
  closeDb: () => Promise<void>;
}): Promise<{ health: HealthServer; dbPingTimer: ReturnType<typeof setInterval> }> {
  const { config, logger, leaseManager, pool, closeDb } = deps;
  logger.warn(
    { totalShards: config.totalShards, expectedInstances: config.expectedInstances },
    'holding zero shards after boot-time claim retry — idling with no gateway connection until the next restart',
  );

  let dbStatus: SubsystemStatus = 'up';
  const health = new HealthServer({
    port: config.httpPort,
    logger,
    diagnosticsToken: config.diagnosticsToken,
    health: (): HealthReport => ({
      // 'up', deliberately, even though `leases`/`gateway` read 'down' below
      // — this instance is idling exactly as designed, and reporting 'down'
      // here would fail Fly's health check forever, which could stall a
      // rolling deploy waiting on a machine that was never going to pass it
      // (see the `idle` field's doc on `HealthReport`).
      status: 'up',
      idle: true,
      subsystems: { gateway: 'down', leases: 'down', db: dbStatus },
      version: VERSION,
      commit: COMMIT,
      instanceId: config.instanceId,
    }),
    diagnostics: async () => ({
      instanceId: config.instanceId,
      version: VERSION,
      commit: COMMIT,
      claimedShards: [],
      totalShards: config.totalShards,
      expectedInstances: config.expectedInstances,
      idle: true,
      queueDepth: 0,
      trippedCircuits: 0,
      queues: [],
      recentErrors: [],
      paused: false,
      runtimeFlags: {},
      sweepEnabled: false,
      billing: null,
      ai: null,
      backup: { enabled: false },
      problems: {},
      metrics: null,
      alerts: null,
    }),
  });
  await health.start();

  const dbPingTimer = setInterval(() => {
    pool.query('SELECT 1').then(
      () => {
        dbStatus = 'up';
      },
      (err: unknown) => {
        dbStatus = 'down';
        logger.warn({ err }, 'db health ping failed (idle instance)');
      },
    );
  }, 15_000);
  dbPingTimer.unref();

  leaseManager.startHeartbeat();

  let shuttingDown = false;
  const handler = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down (idle instance)');
    void idleDrain({ leaseManager, health, dbPingTimer, closeDb }).then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'error during idle shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));

  return { health, dbPingTimer };
}

/**
 * The idle instance's drain sequence, pulled out of {@link runIdle} so it's
 * directly testable without touching `process` signals or `process.exit` —
 * the same split `gracefulDrain`/`installShutdown` use in `runtime/shutdown.ts`.
 * Nothing here is time-ordered by anything other than "release before close":
 * there's no gateway to destroy first (§6.2 doesn't apply — this instance
 * never had one) and no in-flight per-guild work to drain (there's no
 * dispatcher either, for the same reason).
 */
export async function idleDrain(deps: {
  leaseManager: ShardLeaseManager;
  health: HealthServer;
  dbPingTimer: ReturnType<typeof setInterval>;
  closeDb: () => Promise<void>;
}): Promise<void> {
  clearInterval(deps.dbPingTimer);
  await deps.leaseManager.releaseAll();
  await deps.health.stop();
  await deps.closeDb();
}
