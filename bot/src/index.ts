import {
  AiUsageRepository,
  AutoChannelRepository,
  BillingNotificationRepository,
  BillingRunRepository,
  createDatabase,
  createLogger,
  GuildFleetPresenceRepository,
  GuildRepository,
  isEntitled,
  JoinChannelRepository,
  loadConfig,
  ManagedChannelRepository,
  OpsAuditRepository,
  DEFAULT_FLEET,
  probeForManifest,
  PgNotifier,
  runMigrations,
  RUNTIME_FLAGS,
  RuntimeFlagsRepository,
  SecondaryChannelRepository,
  SettingsCache,
  shardCapFor,
  ShardLeaseRepository,
  SubscriptionRepository,
  type Logger,
} from '@avc/core';
import { REST, Routes } from 'discord.js';
import { GuildDispatcher } from './runtime/dispatcher.js';
import { RuntimeCreationGate } from './runtime/creationGate.js';
import { ShardLeaseManager } from './runtime/shardLeaseManager.js';
import { PgIdentifyThrottler } from './runtime/identifyThrottler.js';
import { installShutdown } from './runtime/shutdown.js';
import { BackupScheduler } from './runtime/backupScheduler.js';
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
import { OpenAiCompatClient, TemplateAssistant } from './features/templateAssistant/index.js';
import {
  BillingReconciler,
  DiscordBillingNotifier,
  EntitlementGate,
  ExpiredJoinNotifier,
  registerGuildOnboarding,
} from './features/billing/index.js';
import { backfillGuildIdentities, registerGuildIdentity } from './features/guildIdentity.js';
import { COMMIT, VERSION } from './version.js';

/**
 * How often each instance re-derives its fleet's guild presence.
 *
 * Cheap (one bulk upsert plus one narrowing update) and only has to be
 * faster than the notification TTL, since its job is to stop a queued
 * notification being handed to a fleet that has been kicked out.
 */
const PRESENCE_SYNC_INTERVAL_MS = 60 * 60 * 1000;

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

  const leaseRepo = new ShardLeaseRepository(db, config.fleet);
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
  const autoChannels = new AutoChannelRepository(db, config.fleet);
  const secondaries = new SecondaryChannelRepository(db, config.fleet);
  const managed = new ManagedChannelRepository(db, config.fleet);
  const joinChannelsRepo = new JoinChannelRepository(db, config.fleet);
  const guildsRepo = new GuildRepository(db);
  const presenceRepo = new GuildFleetPresenceRepository(db, config.fleet ?? DEFAULT_FLEET);
  const flags = new RuntimeFlagsRepository(db, config.fleet);
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
  // Sync entitlement answers for the hot paths (presence/voice intake): the
  // monetization hard gate's short-circuit. Serves cached booleans, refreshes
  // in the background, and evicts on the same NOTIFY channel as the settings
  // cache so auth transitions apply promptly cluster-wide.
  const entitlementGate = new EntitlementGate({
    guilds: settingsCache,
    notifier,
    selfHosted: config.selfHosted,
    logger,
  });
  await entitlementGate.start();
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
  // The one carve-out from the hard-gate short-circuit: joining a creator
  // channel in a gated guild posts a throttled "AVC is paused here" notice.
  const expiredJoinNotifier = new ExpiredJoinNotifier({
    autoChannels,
    guilds: settingsCache,
    client,
    logger,
  });
  const disposeVoiceGateway = registerVoiceGateway({
    client,
    dispatcher,
    feature: voiceFeature,
    logger,
    entitled: (guildId) => entitlementGate.check(guildId),
    onGatedJoin: (guildId, channelId) => expiredJoinNotifier.handleGatedJoin(guildId, channelId),
    // Gated guilds still get their emptied temp channels tidied away, through
    // the per-guild dispatcher so it stays ordered and fault-isolated like
    // every other write. Failures are contained: a gated guild must never be
    // able to make noise in the logs on every leave.
    onGatedLeave: (guildId, channelId) => {
      void dispatcher
        .dispatch(guildId, 'gatedCleanup', () =>
          voiceFeature.cleanupEmptySecondary(guildId, channelId),
        )
        .catch((err: unknown) => {
          logger.debug({ err, guildId, channelId }, 'gated cleanup failed');
        });
    },
  });
  const disposeJoinRequests = registerJoinRequests({
    client,
    privacy,
    logger,
    entitled: (guildId) => entitlementGate.check(guildId),
  });

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
  // The natural-language template assistant. One OpenAI-compatible endpoint,
  // enabled iff a key is configured — the self-host default is off, and in that
  // case `/templateassistant` is never even registered (see registerCommands).
  // Deliberately NOT entitlement-gated: free on every tier, including
  // free-forever guilds (plans/assisted_templates.md §5).
  const assistant = config.aiApiKey
    ? new TemplateAssistant({
        client: new OpenAiCompatClient({
          baseUrl: config.aiBaseUrl,
          apiKey: config.aiApiKey,
          model: config.aiModel,
          timeoutMs: config.aiTimeoutMs,
        }),
        usage: new AiUsageRepository(db),
        flags,
        selfHosted: config.selfHosted,
        prices: {
          inputPerMTok: config.aiPriceInputPerMTok,
          outputPerMTok: config.aiPriceOutputPerMTok,
        },
        reportAlert: (message, context) => errorReporter.report(message, context),
        logger,
      })
    : undefined;
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
    ...(assistant ? { assistant } : {}),
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
    // Skip hard-gated guilds: the gate is non-destructive, so reconcile must
    // never clean up a gated guild's now-unmanaged channels. Authoritative
    // (cache-backed) read rather than the sync gate — reconcile isn't hot.
    entitled: async (guildId) => {
      const row = await settingsCache.ensure(guildId);
      return isEntitled({ status: row.authStatus, selfHosted: config.selfHosted });
    },
  });

  // Monetization (dormant when SELF_HOSTED): new-guild onboarding + the
  // advisory-locked trial/billing reconcile job (samples member counts,
  // advances the leniency ladder, sends the §6 notifications).
  const subscriptionsRepo = new SubscriptionRepository(db);
  const billingNotifier = new DiscordBillingNotifier({ client, logger });
  const disposeOnboarding = config.selfHosted
    ? (): void => undefined
    : registerGuildOnboarding({
        client,
        dispatcher,
        guilds: guildsRepo,
        store: settingsCache,
        notifier: billingNotifier,
        logger,
      });
  /**
   * Denormalize guild name/icon/owner so the service can be operated. Runs on
   * self-host too: it costs one conditional UPDATE per guild edit and it is what
   * makes a self-hoster's own `/diagnostics` output readable.
   */
  const disposeGuildIdentity = registerGuildIdentity({ client, guilds: guildsRepo, logger });

  /**
   * Scheduled Postgres backups (`plans/backups.md`). Absent unless the operator
   * configured storage, which is the whole enablement switch: `config.backup`
   * is undefined until every required BACKUP_S3_* var is set. Runs on self-host
   * too, deliberately, so a self-hoster gets backups from the same image.
   */
  const backupScheduler = config.backup
    ? new BackupScheduler({
        // The pool, so leader election can pin one client (`withBackupLock`).
        pool,
        fleet: config.fleet ?? DEFAULT_FLEET,
        flags,
        opsAudit: new OpsAuditRepository(db, config.fleet),
        logger: logger.child({ component: 'backup' }),
        config: {
          databaseUrl: config.databaseUrl,
          instanceId: config.instanceId,
          nodeEnv: config.nodeEnv,
          backup: config.backup,
        },
        appVersion: VERSION,
        commit: COMMIT,
        report: (message, context) => errorReporter.report(message, context),
        probe: () => probeForManifest(db),
      })
    : undefined;
  const billingReconciler = config.selfHosted
    ? undefined
    : new BillingReconciler({
        guilds: guildsRepo,
        store: settingsCache,
        subscriptions: subscriptionsRepo,
        runs: new BillingRunRepository(db),
        notifications: new BillingNotificationRepository(db),
        flags,
        opsAudit: new OpsAuditRepository(db, config.fleet),
        notifier: billingNotifier,
        listCachedGuildCounts: () =>
          [...client.guilds.cache.values()].map((g) => ({
            guildId: g.id,
            memberCount: g.memberCount ?? 0,
          })),
        // §5 step 3: the authoritative tie-breaker before any billing-affecting
        // transition. REST works for any guild the bot is in, on any shard.
        fetchAuthoritativeCount: async (guildId) => {
          try {
            const guild = (await client.rest.get(Routes.guild(guildId), {
              query: new URLSearchParams({ with_counts: 'true' }),
            })) as { approximate_member_count?: number };
            return guild.approximate_member_count ?? null;
          } catch {
            return null;
          }
        },
        logger,
        instanceId: config.instanceId,
        // Decides which queued notifications this instance may deliver.
        fleet: config.fleet ?? DEFAULT_FLEET,
      });

  let gatewayStatus: SubsystemStatus = 'unknown';
  // After READY, a `guildCreate` means either a brand-new guild join or a guild
  // re-delivered on reconnect — reconcile it to catch up on missed events. The
  // *initial* batch (cold cache before READY) is handled once by the READY
  // handler below, so we skip those here to avoid double work.
  client.on('guildCreate', (guild) => {
    if (!client.isReady()) return;
    // Clear any removal marker: the bot is demonstrably back in this guild.
    // Both the shared column and this fleet's presence row, while the former
    // still exists (expand/contract — the dashboard and admin console read it).
    void guildsRepo.setBotPresence(guild.id, null).catch((err: unknown) => {
      logger.warn({ err, guildId: guild.id }, 'failed to clear bot-removed marker');
    });
    void presenceRepo.markPresent(guild.id).catch((err: unknown) => {
      logger.warn({ err, guildId: guild.id }, 'failed to record fleet presence');
    });
    void reconciler.reconcileGuild(guild.id).catch((err: unknown) => {
      logger.error({ err, guildId: guild.id }, 'reconcile-on-guildCreate failed');
    });
  });
  /**
   * The bot was removed from a guild (kicked, banned, or the guild was deleted).
   *
   * We record it and delete NOTHING. A removed guild can still have a live paid
   * subscription, and the row is what the dashboard resolves a plan from, so
   * dropping it would hide the cancel button from someone who is still being
   * charged. Marking instead lets the dashboard say "AVC is not in this server,
   * and you are still paying for it".
   *
   * `guildDelete` also fires on an outage-driven unavailability, so ignore
   * those: `guild.available === false` means Discord lost the guild, not that
   * we were removed.
   */
  client.on('guildDelete', (guild) => {
    if (guild.available === false) return;
    const removedAt = new Date();
    void guildsRepo.setBotPresence(guild.id, removedAt).catch((err: unknown) => {
      logger.warn({ err, guildId: guild.id }, 'failed to record bot removal');
    });
    void presenceRepo.markRemoved(guild.id, removedAt).catch((err: unknown) => {
      logger.warn({ err, guildId: guild.id }, 'failed to record fleet removal');
    });
    logger.info({ guildId: guild.id }, 'removed from guild');
  });
  client.once('clientReady', () => {
    gatewayStatus = 'up';
    logger.info({ shards: leaseManager.ownedShards }, 'gateway ready');
    // Reconcile everything already in cache at ready, then start the sweep.
    void reconciler
      .reconcileGuilds(client.guilds.cache.keys())
      .catch((err: unknown) => logger.error({ err }, 'initial reconcile failed'));
    reconciler.startSweep();
    /**
     * Presence, from the guild list rather than from the event stream
     * (`plans/fleets.md` §6.1).
     *
     * `guildCreate`/`guildDelete` are missable: a kick while the process is
     * down is never replayed, so the periodic truth has to be what the bot can
     * actually see. Narrowing (marking guilds removed) is only correct when
     * this instance holds every shard, because a partial-shard instance sees a
     * partial guild list and "not in my cache" would read as "not in the
     * guild". Widening is always safe, so a sharded fleet still self-heals on
     * the add side and relies on `guildDelete` for removals.
     */
    /**
     * Presence, from the guild list rather than from the event stream
     * (`plans/fleets.md` §6.1).
     *
     * `guildCreate`/`guildDelete` are missable: a kick while the process is
     * down is never replayed, and neither is one that lands during a gateway
     * outage, because a re-IDENTIFY does not diff the new guild list against
     * the old cache. So this repeats on a timer rather than running once at
     * boot. Narrowing (marking guilds removed) is only correct when this
     * instance holds every shard, because a partial-shard instance sees a
     * partial guild list and "not in my cache" would read as "not in the
     * guild". Widening is always safe, so a sharded fleet still self-heals on
     * the add side and relies on `guildDelete` for removals.
     */
    const syncPresence = async (): Promise<void> => {
      const guildIds = [...client.guilds.cache.keys()];
      const holdsEveryShard = leaseManager.ownedShards.length >= config.totalShards;
      const result = holdsEveryShard
        ? await presenceRepo.reconcilePresence(guildIds)
        : await presenceRepo.markManyPresent(guildIds);
      if (result.removed > 0 || result.added > 0) {
        logger.info(
          { ...result, narrowed: holdsEveryShard, fleet: config.fleet ?? DEFAULT_FLEET },
          'fleet presence reconciled',
        );
      }

      /**
       * The shared column too, while it still exists (expand/contract).
       *
       * `guildCreate` clears it, but that event is guarded on `isReady()` and
       * discord.js never fires it for the initial batch, so a guild re-added
       * while this fleet was down would keep the marker forever and the
       * dashboard would tell a paying owner they are paying for a server the
       * bot is not in. Clearing only, never setting: removal stays with
       * `guildDelete`, which is unambiguous per guild.
       */
      const cleared = await guildsRepo.clearBotRemovedFor(guildIds);
      if (cleared > 0) logger.info({ cleared }, 'cleared stale bot-removed markers');
    };
    const presenceReady = syncPresence().catch((err: unknown) =>
      logger.error({ err }, 'fleet presence reconcile failed'),
    );
    const presenceTimer = setInterval(() => {
      void syncPresence().catch((err: unknown) =>
        logger.error({ err }, 'fleet presence reconcile failed'),
      );
    }, PRESENCE_SYNC_INTERVAL_MS);
    presenceTimer.unref();
    // The identity listeners only see *changes*; the guilds already in cache at
    // READY have never fired one. Catch them up once.
    void backfillGuildIdentities({ client, guilds: guildsRepo, logger })
      .then((recorded) => {
        if (recorded > 0) logger.info({ recorded }, 'guild identities backfilled');
      })
      .catch((err: unknown) => logger.error({ err }, 'guild identity backfill failed'));
    /**
     * Billing job only makes sense once the guild cache is populated (its
     * sampling phase reads it). Hourly ticks + one immediate pass.
     *
     * Sequenced after the presence write, not merely after READY. The deliver
     * phase claims by joining `guild_fleet_presence`, so a first pass that
     * raced it would find no rows for any guild joined since the 0017 backfill
     * and quietly deliver nothing. Harmless (the queue is durable and the next
     * tick catches up) but it would make the first hour after every deploy
     * look broken, which is worse than an ordering nobody has to explain.
     */
    if (billingReconciler) {
      /**
       * The timer starts now; only the FIRST pass waits on presence.
       *
       * The deliver phase claims by joining `guild_fleet_presence`, so a first
       * pass that raced the presence write would find no rows for any guild
       * joined since the 0017 backfill and quietly deliver nothing. But making
       * `start()` itself wait would mean a presence write that hangs (a slow
       * pool, a stuck connection) silently leaves the billing job with no timer
       * at all, forever, with nothing but a null `lastRunAt` to say so. That is
       * this codebase's signature failure mode, so the ordering is applied
       * where it is needed and nowhere else.
       */
      billingReconciler.start();
      void presenceReady.then(() =>
        billingReconciler.runOnce().catch((err: unknown) => {
          logger.error({ err }, 'initial billing reconcile failed');
        }),
      );
    }
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
    // Undefined only on a self-host: the config schema refuses to boot a
    // hosted instance without one, so the fleet cannot fail open.
    diagnosticsToken: config.diagnosticsToken,
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
        billing: billingReconciler ? { ...billingReconciler.stats } : null,
        ai: assistant ? { ...assistant.stats } : null,
        backup: backupScheduler ? { ...backupScheduler.stats } : { enabled: false },
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
    await registerCommands(config.discordToken, config.clientId, logger, config.devGuildId, {
      includeAssistant: Boolean(assistant),
    });
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
    disposeOnboarding,
    disposeGuildIdentity,
    billingReconciler,
    backupScheduler,
    entitlementGate,
    closeDb,
  });

  // Both start only now that the graceful-drain handler is installed: a
  // lease-loss reaction must always drain cleanly, and a backup must never
  // begin during a drain it cannot be part of.
  if (backupScheduler) {
    await backupScheduler.hydrate();
    backupScheduler.start();
  }
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
