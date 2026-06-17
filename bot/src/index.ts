import {
  AutoChannelRepository,
  createDatabase,
  createLogger,
  GuildRepository,
  JoinChannelRepository,
  loadConfig,
  ManagedChannelRepository,
  PgNotifier,
  runMigrations,
  RUNTIME_FLAGS,
  RuntimeFlagsRepository,
  SecondaryChannelRepository,
  SettingsCache,
  shardCapFor,
  ShardLeaseRepository,
  type Logger,
} from '@avc/core';
import { REST, Routes } from 'discord.js';
import { GuildDispatcher } from './runtime/dispatcher.js';
import { RuntimeCreationGate } from './runtime/creationGate.js';
import { ShardLeaseManager } from './runtime/shardLeaseManager.js';
import { PgIdentifyThrottler } from './runtime/identifyThrottler.js';
import { installShutdown } from './runtime/shutdown.js';
import { HealthServer, type HealthReport, type SubsystemStatus } from './ops/health.js';
import {
  AdminChannelReporter,
  NullErrorReporter,
  type ErrorReporter,
} from './ops/errorReporter.js';
import { ServerLogger } from './ops/serverLog.js';
import { buildGatewayClient } from './gateway/client.js';
import {
  DiscordVoiceActions,
  DiscordVoiceView,
  GuildSettingsService,
  PermissionProblemTracker,
  PrivacyService,
  Reconciler,
  registerJoinRequests,
  registerVoiceGateway,
  VoiceCommands,
  VoiceFeature,
  VoteKickManager,
} from './features/voice/index.js';
import { registerCommands } from './commands/definitions.js';
import { registerInteractionHandler } from './commands/interactions.js';
import { COMMIT, VERSION } from './version.js';

/**
 * Composition root. Wires config → logging → DB (+ migrations) → shard leases →
 * dispatcher → health server, and installs a graceful-drain shutdown.
 *
 * The same binary serves the scaled hosted service and a self-hosted instance;
 * only config differs. At a single instance the lease manager claims all shards.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
    base: { instanceId: config.instanceId, version: VERSION, commit: COMMIT },
  });

  logger.info({ selfHosted: config.selfHosted, totalShards: config.totalShards }, 'starting bot');
  installProcessGuards(logger);

  const { db, pool, close: closeDb } = createDatabase({ connectionString: config.databaseUrl });

  let dbStatus: SubsystemStatus = 'unknown';
  try {
    await runMigrations(db);
    dbStatus = 'up';
    logger.info('migrations applied');
  } catch (err) {
    dbStatus = 'down';
    logger.error({ err }, 'migrations failed');
    throw err;
  }

  const leaseRepo = new ShardLeaseRepository(db);
  // Populated once the shutdown handler is installed; lets the lease-loss reaction
  // reuse the graceful-drain path. Until then a lease-loss falls back to exit(1).
  const shutdown: { request?: (reason: string, exitCode: number) => void } = {};
  // Distribute shards across the fleet: each instance claims up to its cap. At one
  // instance (self-host) the cap is the full shard count, so it claims everything.
  const maxShards = shardCapFor(config.totalShards, config.expectedInstances);
  const leaseManager = new ShardLeaseManager({
    repo: leaseRepo,
    logger,
    instanceId: config.instanceId,
    totalShards: config.totalShards,
    maxShards,
    // Orchestrator-driven failover: if a lease is stolen out from under us, drain
    // and exit *non-zero* so the orchestrator restarts us into a clean re-claim
    // (a clean exit could read as "completed" and not restart). The drain still
    // releases our remaining leases and finishes in-flight work first.
    onLeaseLost: (lost) => {
      logger.error({ lost }, 'shard lease lost — draining for clean re-claim on restart');
      (shutdown.request ?? ((_r, code) => process.exit(code)))('lease-loss', 1);
    },
  });

  const dispatcher = new GuildDispatcher({ logger });

  // Boot-time claim retries across the lease-expiry window so a replacement
  // instance reliably picks up a dead peer's orphaned shards.
  const claimed = await leaseManager.claimWithRetry();

  // Serialize identifies cluster-wide so a multi-instance deploy can't exceed
  // Discord's max_concurrency. We read the live concurrency from the gateway and
  // back the throttler with the Postgres-coordinated per-bucket spacing.
  const maxConcurrency = await fetchIdentifyConcurrency(config.discordToken, logger);
  const identifyThrottler = new PgIdentifyThrottler({ repo: leaseRepo, maxConcurrency, logger });

  // Gateway + voice feature. The lease manager decides which shards this
  // instance owns; the gateway client connects only those.
  const client = buildGatewayClient({
    totalShards: config.totalShards,
    shardIds: leaseManager.ownedShards,
    buildIdentifyThrottler: () => identifyThrottler,
  });
  const autoChannels = new AutoChannelRepository(db);
  const secondaries = new SecondaryChannelRepository(db);
  const managed = new ManagedChannelRepository(db);
  const joinChannelsRepo = new JoinChannelRepository(db);
  const guildsRepo = new GuildRepository(db);
  const flags = new RuntimeFlagsRepository(db);
  const actions = new DiscordVoiceActions(client, logger);
  const voice = new DiscordVoiceView(client);
  // Significant errors are reported to the admin channel when configured; a seam
  // for a Sentry-style sink later. No admin channel (self-host default) → no-op.
  const errorReporter: ErrorReporter = config.adminChannelId
    ? new AdminChannelReporter({ client, channelId: config.adminChannelId, logger })
    : new NullErrorReporter();
  const creationGate = new RuntimeCreationGate({ flags, logger });
  // Guild settings cache: avoids a Postgres read/write on every voice event, with
  // cross-instance invalidation over LISTEN/NOTIFY (the DB stays source of truth).
  // Reads on the hot path go through it; writes (settings/auth) route through it so
  // every instance evicts. A TTL + reconnect-resync bound staleness if a NOTIFY is
  // missed. Self-host (one instance) just talks to its own cache + DB.
  const notifier = new PgNotifier(config.databaseUrl, logger);
  await notifier.connect();
  const settingsCache = new SettingsCache(guildsRepo, notifier);
  await settingsCache.start();
  const serverLogger = new ServerLogger({ client, guilds: settingsCache, logger });
  // Tracks "I lost access to this channel" incidents, surfaced in /setup + /logging.
  const permissionProblems = new PermissionProblemTracker();
  // Private-channel "⇩ Join" mechanism. Wired into the feature's cleanup hook so
  // a private channel's companion is deleted whenever the channel goes away.
  const privacy = new PrivacyService({
    secondaries,
    joinChannels: joinChannelsRepo,
    actions,
    voice,
    logger,
  });
  const voiceFeature = new VoiceFeature({
    autoChannels,
    secondaries,
    managed,
    guilds: settingsCache,
    actions,
    voice,
    selfHosted: config.selfHosted,
    gate: creationGate,
    onSecondaryRemoved: (gid, cid) => privacy.cleanupForSecondary(gid, cid),
    onOwnerChanged: (gid, cid, ownerId, ownerName) =>
      privacy.handleOwnerChanged(gid, cid, ownerId, ownerName),
    joinCompanionFor: async (cid) =>
      (await joinChannelsRepo.getBySecondary(cid))?.channelId ?? undefined,
    makePrivateOnCreate: (gid, cid, ownerId, ownerName) =>
      privacy.makePrivateForCreation(gid, cid, ownerId, ownerName),
    serverLog: (gid, level, message) => serverLogger.log(gid, level, message),
    permissionProblems,
    logger,
  });
  const disposeVoiceGateway = registerVoiceGateway({
    client,
    dispatcher,
    feature: voiceFeature,
    logger,
  });
  const disposeJoinRequests = registerJoinRequests({ client, privacy, logger });

  // Command / interaction surface (slash commands + /settings panel).
  const voiceCommands = new VoiceCommands({
    secondaries,
    actions,
    voice,
    feature: voiceFeature,
    logger,
  });
  const settingsService = new GuildSettingsService({
    guilds: settingsCache,
    autoChannels,
    secondaries,
    actions,
    logger,
  });
  const votekick = new VoteKickManager({ secondaries, voice, actions, logger });
  const disposeInteractions = registerInteractionHandler({
    client,
    dispatcher,
    voiceCommands,
    settings: settingsService,
    votekick,
    privacy,
    feature: voiceFeature,
    guilds: guildsRepo,
    managed,
    permissionProblems,
    selfHosted: config.selfHosted,
    clientId: config.clientId,
    reportError: (message, context) => errorReporter.report(message, context),
    logger,
  });

  // Reconciler: converge each owned guild on (re)connect, then run a thin
  // periodic safety-net sweep scoped to guilds with managed channels.
  const reconciler = new Reconciler({
    feature: voiceFeature,
    dispatcher,
    secondaries,
    autoChannels,
    managed,
    flags,
    logger,
  });

  let gatewayStatus: SubsystemStatus = 'unknown';
  // After READY, a `guildCreate` means either a brand-new guild join or a guild
  // re-delivered on reconnect — reconcile it to catch up on missed events. The
  // *initial* batch (cold cache before READY) is handled once by the READY
  // handler below, so we skip those here to avoid double work.
  client.on('guildCreate', (guild) => {
    if (!client.isReady()) return;
    void reconciler.reconcileGuild(guild.id).catch((err: unknown) => {
      logger.error({ err, guildId: guild.id }, 'reconcile-on-guildCreate failed');
    });
  });
  client.once('clientReady', () => {
    gatewayStatus = 'up';
    logger.info({ shards: leaseManager.ownedShards }, 'gateway ready');
    // Reconcile everything already in cache at ready, then start the sweep.
    void reconciler
      .reconcileGuilds(client.guilds.cache.keys())
      .catch((err: unknown) => logger.error({ err }, 'initial reconcile failed'));
    reconciler.startSweep();
  });
  client.on('error', (err) => {
    gatewayStatus = 'down';
    logger.error({ err }, 'gateway error');
    errorReporter.report('Gateway error', { error: String(err) });
  });
  client.on('shardDisconnect', (_e, shardId) => {
    logger.warn({ shardId }, 'shard disconnected');
  });

  const health = new HealthServer({
    port: config.httpPort,
    logger,
    health: (): HealthReport => ({
      status:
        dbStatus === 'up' && leaseManager.ownedShards.length > 0 && gatewayStatus !== 'down'
          ? 'up'
          : 'down',
      subsystems: {
        gateway: gatewayStatus,
        leases: leaseManager.ownedShards.length > 0 ? 'up' : 'down',
        db: dbStatus,
      },
      version: VERSION,
      commit: COMMIT,
      instanceId: config.instanceId,
    }),
    diagnostics: async () => {
      // Surface the live control-plane state so the agent can debug by query.
      const runtimeFlags = await flags.getAll().catch((): Record<string, unknown> => ({}));
      return {
        instanceId: config.instanceId,
        version: VERSION,
        commit: COMMIT,
        claimedShards: leaseManager.ownedShards,
        queueDepth: dispatcher.totalDepth(),
        trippedCircuits: dispatcher.trippedCount(),
        queues: dispatcher.snapshot(),
        recentErrors: [],
        paused: runtimeFlags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true,
        sweepEnabled: runtimeFlags[RUNTIME_FLAGS.SWEEP_DISABLED] !== true,
        runtimeFlags,
      };
    },
  });
  await health.start();

  // Keep the DB subsystem status live (it was only set at boot, so a post-boot
  // outage would otherwise still read "up"). A cheap periodic ping gates deploys
  // and readiness on the *current* DB state.
  const dbPingTimer = setInterval(() => {
    pool.query('SELECT 1').then(
      () => {
        dbStatus = 'up';
      },
      (err: unknown) => {
        dbStatus = 'down';
        logger.warn({ err }, 'db health ping failed');
      },
    );
  }, 15_000);
  dbPingTimer.unref();

  // Self-register the global slash commands (idempotent upsert). A failure here
  // shouldn't take the bot down — log and continue; the next boot retries.
  try {
    await registerCommands(config.discordToken, config.clientId, logger, config.devGuildId);
  } catch (err) {
    logger.error({ err }, 'slash-command registration failed');
  }

  await client.login(config.discordToken);

  logger.info({ claimedShards: claimed }, 'bot ready');

  shutdown.request = installShutdown({
    logger,
    config,
    leaseManager,
    dispatcher,
    reconciler,
    health,
    client,
    settingsCache,
    notifier,
    dbPingTimer,
    disposeVoiceGateway,
    disposeJoinRequests,
    disposeInteractions,
    closeDb,
  });

  // Start heartbeating only now that the graceful-drain handler is installed, so a
  // lease-loss reaction always drains cleanly before exiting for a restart.
  leaseManager.startHeartbeat();
}

/**
 * Reads Discord's identify `max_concurrency` (how many shards may identify in
 * parallel per 5s window) from `GET /gateway/bot`. Falls back to 1 — the safe,
 * universal floor — if the call fails, so the throttler still serializes.
 */
async function fetchIdentifyConcurrency(token: string, logger: Logger): Promise<number> {
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    const info = (await rest.get(Routes.gatewayBot())) as {
      session_start_limit?: { max_concurrency?: number };
    };
    const maxConcurrency = Math.max(1, info.session_start_limit?.max_concurrency ?? 1);
    logger.info({ maxConcurrency }, 'fetched gateway identify concurrency');
    return maxConcurrency;
  } catch (err) {
    logger.warn({ err }, 'failed to fetch gateway bot info; defaulting max_concurrency=1');
    return 1;
  }
}

/**
 * Last-resort process guards: per-handler code already `.catch`es its own work,
 * so these only fire on a genuinely-missed rejection or a synchronous throw
 * outside any handler. A stray rejection is logged (the bot stays up); an
 * uncaught exception leaves the process in an undefined state, so we log and exit
 * non-zero for the orchestrator to restart cleanly.
 */
function installProcessGuards(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
