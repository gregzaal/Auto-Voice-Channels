import {
  AiUsageRepository,
  AutoChannelRepository,
  BillingNotificationRepository,
  BillingRunRepository,
  createDatabase,
  createLogger,
  GuildFleetPresenceRepository,
  GuildRepository,
  AlertRepository,
  isEntitled,
  JoinChannelRepository,
  loadConfig,
  ManagedChannelRepository,
  MemberPoolGuildRepository,
  MemberPoolRepository,
  METRICS,
  MetricsRepository,
  OpsAuditRepository,
  DEFAULT_FLEET,
  poolExitTransition,
  probeForManifest,
  removeGuildFromAnyPoolAtomically,
  resolveDiscordUserId,
  PgNotifier,
  runMigrations,
  RUNTIME_FLAGS,
  RuntimeFlagsRepository,
  SecondaryChannelRepository,
  SettingsCache,
  shardCapFor,
  ShardLeaseRepository,
  SubscriptionRepository,
  SUPPORTER_SYNC_CHANNEL,
  type Logger,
} from '@avc/core';
import { REST, Routes, type Client } from 'discord.js';
import { GuildDispatcher } from './runtime/dispatcher.js';
import { RuntimeCreationGate } from './runtime/creationGate.js';
import { ShardLeaseManager } from './runtime/shardLeaseManager.js';
import { runIdle } from './runtime/idle.js';
import { PgIdentifyThrottler } from './runtime/identifyThrottler.js';
import { installShutdown } from './runtime/shutdown.js';
import { AlertScheduler } from './runtime/alertScheduler.js';
import { BackupScheduler } from './runtime/backupScheduler.js';
import { TopggScheduler } from './runtime/topggScheduler.js';
import { SupporterRoles } from './features/support/supporterRoles.js';
import { buildWatchChecks } from './runtime/watchChecks.js';
import { MetricsCollector, type GatewayLimits } from './runtime/metricsCollector.js';
import { categorizeError } from './ops/describeError.js';
import { TopggClient } from './ops/topgg.js';
import { HealthServer, type HealthReport, type SubsystemStatus } from './ops/health.js';
import {
  AdminChannelReporter,
  NullErrorReporter,
  PersistentErrorReporter,
  RecordingErrorReporter,
  type ErrorReporter,
} from './ops/errorReporter.js';
import { ServerLogger } from './ops/serverLog.js';
import { PermissionProblemNotifier } from './ops/permissionProblemNotifier.js';
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
import { buildCommandDefinitions, registerCommands } from './commands/definitions.js';
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

  const {
    db,
    pool,
    close: closeDb,
  } = createDatabase({
    connectionString: config.databaseUrl,
    applicationName: `avc-bot-${config.fleet}`,
    onPoolError: (err) => logger.warn({ err }, 'idle database client errored, pool discarded it'),
  });

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
  /**
   * The lease manager's alert sink, filled in once the Discord client exists:
   * the reporter needs a client to post with, and the client needs the lease
   * manager to know which shards to connect. A condition raised before the
   * reporter is built is logged and not reported, which only covers the
   * boot-time claim.
   */
  const opsReport: {
    report?: (kind: string, message: string, context: Record<string, unknown>) => void;
  } = {};
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
    report: (kind, message, context) => opsReport.report?.(kind, message, context),
  });

  /**
   * The dispatcher's error sink, filled in once the metrics collector exists.
   * Late-bound rather than reordered because the two point at each other: the
   * dispatcher reports failures to the collector, which samples the
   * dispatcher's queue depth. A failure raised before the collector is built
   * is simply not counted, not a crash.
   */
  const countError: { record?: (err: unknown) => void } = {};
  const dispatcher = new GuildDispatcher({
    logger,
    // The per-guild boundary is the only place that sees every isolated failure.
    onTaskFailure: (err) => countError.record?.(err),
  });

  // Boot-time claim retries across the lease-expiry window so a replacement
  // instance reliably picks up a dead peer's orphaned shards.
  const claimed = await leaseManager.claimWithRetry();

  /**
   * An over-provisioned fleet (`EXPECTED_INSTANCES` ahead of the real machine
   * count) or Step B's own deliberate window - a spare machine created ahead
   * of a config flip, `plans/scaling.md` §9.3 - ends boot-time claiming with
   * zero owned shards. discord.js cannot represent that: `buildGatewayClient`
   * would pass `shards: []`, which `Client._validateOptions` rejects outright
   * (`ClientInvalidProvidedShards`), crash-looping the process forever. Every
   * subsystem below this point is built around a live gateway client, so
   * there is no cheap partial bring-up - idle instead, without building one.
   */
  if (claimed.length === 0) {
    await runIdle({ config, logger, leaseManager, pool, closeDb });
    return;
  }

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
  const memberPoolGuildsRepo = new MemberPoolGuildRepository(db);
  const memberPoolsRepo = new MemberPoolRepository(db);
  const flags = new RuntimeFlagsRepository(db, config.fleet);
  const actions = new DiscordVoiceActions(client, logger);
  const voice = new DiscordVoiceView(client);
  // Significant errors are reported to the admin channel when configured; a seam
  // for a Sentry-style sink later. No admin channel (self-host default) → no-op.
  /**
   * Hosted gets both: a persisted row AND a Discord message. Neither replaces
   * the other, a row nobody sees wakes nobody, and a Discord message is not
   * queryable next month. Self-host gets the channel alone: the `alerts`
   * table exists there too (one set of migrations) and just stays empty,
   * same as the billing tables, since persisting for no reader is pointless.
   */
  const adminChannel = config.adminChannelId
    ? new AdminChannelReporter({
        client,
        channelId: config.adminChannelId,
        logger,
        fleet: config.fleet,
        instanceId: config.instanceId,
      })
    : undefined;
  const channelReporter: ErrorReporter = adminChannel ?? new NullErrorReporter();
  /** One repository, shared with the watcher below. Undefined (unused) on self-host. */
  const alertRepo = config.selfHosted ? undefined : new AlertRepository(db, config.fleet);
  /**
   * Hosted posts AND records, correlated, so the row knows what happened to
   * the post (`plans/agentic_management.md` step 4b) instead of every row
   * reading permanently undelivered. A plain `Tee` (fire both, no
   * correlation) is still right when there's no channel to correlate with: a
   * persisted row alone beats nothing.
   */
  const errorReporter: ErrorReporter = !alertRepo
    ? channelReporter
    : adminChannel
      ? new RecordingErrorReporter({
          alerts: alertRepo,
          channel: adminChannel,
          logger,
          instanceId: config.instanceId,
        })
      : new PersistentErrorReporter({ alerts: alertRepo, logger });
  opsReport.report = (kind, message, context) => errorReporter.report(kind, message, context);
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
  /**
   * ...and pushed to the guild. `/setup` and `/logging` together reach almost
   * nobody, since the log channel is opt-in and rarely configured, so this is
   * the surface that actually reaches an admin. Runs on self-host too (the
   * same 50013 happens there), degrading to "post in the system channel",
   * which needs nothing configured. Gated per fleet by `problems.notify_disabled`.
   */
  const problemNotifier = new PermissionProblemNotifier({
    client,
    guilds: settingsCache,
    store: guildsRepo,
    problems: permissionProblems,
    autoChannels,
    flags,
    selfHosted: config.selfHosted,
    report: (kind, message, context) => errorReporter.report(kind, message, context),
    logger: logger.child({ component: 'problem-notifier' }),
  });
  // Late-bound both ways: the notifier renders from the tracker, so one of the
  // two has to be wired after the other exists.
  permissionProblems.onRecord = (guildId) => problemNotifier.record(guildId);
  permissionProblems.onResolved = (guildId) => problemNotifier.resolved(guildId);
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
    countRoom: (event) =>
      metricsCollector.increment(
        event === 'created' ? METRICS.ROOMS_CREATED : METRICS.ROOMS_DELETED,
      ),
    // Defense in depth against a direct reconcile call for a guild this
    // instance's shards don't cover — see the deps doc in handler.ts.
    ownsGuild: (guildId) => leaseManager.ownsGuild(guildId),
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
        // One kind for both assistant alerts: they fire at most a few times a
        // day, so they cannot throttle each other in practice.
        reportAlert: (message, context) => errorReporter.report('ai.alert', message, context),
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
    // Its own kind: interaction failures are the one of these that can storm.
    reportError: (message, context) => errorReporter.report('interaction.failed', message, context),
    countCommand: (commandName) =>
      metricsCollector.increment(METRICS.COMMANDS_INVOKED, commandName),
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
    report: (kind, message, context) => errorReporter.report(kind, message, context),
    // Skip hard-gated guilds: the gate is non-destructive, so reconcile must
    // never clean up a gated guild's now-unmanaged channels. Authoritative
    // (cache-backed) read rather than the sync gate — reconcile isn't hot.
    entitled: async (guildId) => {
      const row = await settingsCache.ensure(guildId);
      return isEntitled({ status: row.authStatus, selfHosted: config.selfHosted });
    },
    // Scopes the sweep to this instance's own shards — see the deps doc in
    // reconciler.ts. A no-op at one instance, where every shard is owned.
    ownsGuild: (guildId) => leaseManager.ownsGuild(guildId),
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
        /**
         * The four backup conditions keep distinct kinds. AGENTS.md states the
         * invariant directly: "A failed drill is never reported as a failed
         * backup." Collapsing them onto one key would also make each occurrence
         * overwrite the previous message on the same alert row.
         */
        report: (kind, message, context) => errorReporter.report(kind, message, context),
        probe: () => probeForManifest(db),
      })
    : undefined;
  /**
   * The metric store's collector (`plans/admin-dashboard.md` §3.4).
   * Unconditional, like the backup scheduler and unlike the billing job: what
   * it counts is deleted-with-the-row or leaves no trace at all, so an
   * uncounted event is unrecoverable, on self-host too. `metrics.disabled` is
   * the off switch.
   *
   * `countRoom`/`countCommand` close over this binding safely because they're
   * only called after `client.login`, well after this exists. `countError`
   * can fire earlier (the dispatcher exists long before this line), which is
   * why it alone goes through a holder instead.
   */
  const metricsCollector = new MetricsCollector({
    metrics: new MetricsRepository(db),
    runs: new BillingRunRepository(db),
    flags,
    fleet: config.fleet ?? DEFAULT_FLEET,
    instanceId: config.instanceId,
    logger: logger.child({ component: 'metrics' }),
    sample: () => ({
      queueDepth: dispatcher.totalDepth(),
      trippedCircuits: dispatcher.trippedCount(),
    }),
    report: (kind, message, context) => errorReporter.report(kind, message, context),
    /**
     * Polled on the flush tick (5 minutes), not the sample tick (30 seconds):
     * these numbers change on the order of hours, so more frequent polling
     * would be waste. Uses the client's own REST handler (existing token,
     * existing rate-limit bucket), so no second credential anywhere.
     */
    pollGateway: () => fetchGatewayLimits(client, logger),
  });
  countError.record = (err) => metricsCollector.increment(METRICS.ERRORS, categorizeError(err));
  /**
   * Called here, before the gateway connects, and that ordering is the whole
   * correctness argument: `hydrate` reloads this instance's already-flushed
   * counters, and the accumulator holds running totals, not deltas. A room
   * created between `client.login` and this resolving would leave the stored
   * total and the live count as disjoint numbers with no way to combine them.
   * Awaiting it before login keeps the accumulator provably empty. Timers
   * still start later, once the drain handler is installed.
   */
  await metricsCollector.hydrate();

  const billingReconciler = config.selfHosted
    ? undefined
    : new BillingReconciler({
        guilds: guildsRepo,
        store: settingsCache,
        subscriptions: subscriptionsRepo,
        runs: new BillingRunRepository(db),
        notifications: new BillingNotificationRepository(db),
        flags,
        memberPools: memberPoolsRepo,
        memberPoolGuilds: memberPoolGuildsRepo,
        resolveDiscordUserId: (userId) => resolveDiscordUserId(db, userId),
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
        report: (kind, message, context) => errorReporter.report(kind, message, context),
      });

  /**
   * Supporter roles in the support guild.
   *
   * Hosted-only by configuration, not by a `selfHosted` branch: the group is
   * undefined unless somebody set `SUPPORT_GUILD_ID`, and a self-hoster never
   * does. Also fleet-scoped by the same means -- both bots are in the support
   * guild, so exactly one fleet is given the env and the other never writes.
   */
  const supporterRoles = config.supporterRoles
    ? new SupporterRoles({
        client,
        guildId: config.supporterRoles.guildId,
        byTier: config.supporterRoles.byTier,
        writeSpacingMs: config.supporterRoles.writeSpacingMs,
        reconcileIntervalHours: config.supporterRoles.reconcileIntervalHours,
        lookup: (ids) => subscriptionsRepo.listSupporterTiersFor(ids),
        flags,
        logger,
        report: (kind, message, context) => errorReporter.report(kind, message, context),
      })
    : undefined;

  /**
   * The live path: one Paddle webhook, one snowflake, one role write. The
   * reconcile below exists for the deliveries this misses, not for this.
   */
  const disposeSupporterSync = supporterRoles
    ? await notifier.listen(SUPPORTER_SYNC_CHANNEL, (discordUserId) => {
        if (!discordUserId) return;
        void supporterRoles.syncMember(discordUserId).catch((err: unknown) => {
          supporterRoles.noteFailure(err, 'supporter role sync failed', { discordUserId });
        });
      })
    : undefined;

  /**
   * The safety net that matches the live path's actual failure mode.
   *
   * `PgNotifier.notify` drops a publish outright while disconnected, and this
   * connection reconnects often enough to matter (28 cycles in 4.5 hours on
   * beta). Neither `clientReady` (bound with `once`) nor `guildCreate`
   * (discord.js emits `guildAvailable` for an already-cached guild) fires again
   * on a reconnect, so without this the daily timer was the only thing that
   * would ever notice. Floored internally so a flapping connection cannot turn
   * the net into the load.
   */
  if (supporterRoles) {
    notifier.onReconnect(() => {
      void supporterRoles.reconcileAfterReconnect().catch((err: unknown) => {
        supporterRoles.noteFailure(err, 'supporter role reconcile-on-reconnect failed');
      });
    });
  }

  /**
   * The in-process watcher (`plans/agentic_management.md` step 4).
   * Unconditional, like the metrics collector: its conditions are as true on
   * self-host as here, and the watchdog ping is the only down-detection a
   * self-hoster has. `alerts.disabled` is the off switch, `global.pause`
   * stops it too.
   *
   * Notifies through the CHANNEL reporter, not the tee'd one: it writes its
   * own rows with a real severity and audience, so routing through the tee
   * would persist the same condition twice per tick, once mislabelled `warn`.
   */
  const alertScheduler = new AlertScheduler({
    alerts: alertRepo,
    flags,
    logger: logger.child({ component: 'watcher' }),
    notify: (kind, message, context) => channelReporter.report(kind, message, context),
    /**
     * Absent without an admin channel, which switches the retry loop off
     * entirely. There is nowhere to deliver to, so claiming rows would only
     * burn attempts against a destination that does not exist.
     */
    ...(adminChannel ? { deliver: (content: string) => adminChannel.sendDirect(content) } : {}),
    instanceId: config.instanceId,
    checks: buildWatchChecks({
      client,
      snapshot: () => dispatcher.snapshot(),
      dbStatus: () => dbStatus,
      heartbeat: () => leaseManager.heartbeatHealth,
      selfHosted: config.selfHosted,
      /**
       * Read by the self-host check only. Passed unconditionally because the
       * gating lives in `buildWatchChecks`, where the reason for it can be
       * written down next to the check it gates.
       */
      permissionProblems: (sinceMs) => permissionProblems.activeGuilds(sinceMs),
    }),
    watchdogPingUrl: config.watchdogPingUrl,
  });

  /**
   * The top.gg listing publisher. Absent unless a token is configured, which is
   * every self-host and any fleet not given the secret.
   */
  const topggScheduler = config.topggToken
    ? new TopggScheduler({
        client: new TopggClient({ token: config.topggToken }),
        flags,
        presence: presenceRepo,
        logger: logger.child({ component: 'topgg' }),
        totalShards: config.totalShards,
        /**
         * Shard 0's instance owns every outward-facing publication, the same
         * gate global command registration uses. Read at publish time rather
         * than captured, because shard ownership changes while the process runs.
         */
        ownsListing: () => leaseManager.ownedShards.includes(0),
        /**
         * The GLOBAL command set, so the listing shows what a real server gets.
         * `includeDebug` is deliberately absent: `/debug` exists only in a dev
         * guild and is not part of the product.
         */
        commands: () => buildCommandDefinitions({ includeAssistant: Boolean(assistant) }),
        /**
         * Only for a failure that will not fix itself. A stale listing is not
         * worth a message; a rejected token retries forever and changes
         * nothing, so it has to reach a human.
         */
        report: (kind, message, context) => errorReporter.report(kind, message, context),
      })
    : undefined;

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
    /**
     * The bot being ADDED to the support guild. Not the reconnect case, despite
     * the name: discord.js emits `guildAvailable`, not `guildCreate`, for a
     * guild already in cache, which a re-IDENTIFY always leaves it. The
     * notifier's `onReconnect` covers that.
     */
    if (guild.id === config.supporterRoles?.guildId) {
      void supporterRoles?.reconcile().catch((err: unknown) => {
        supporterRoles.noteFailure(err, 'supporter role reconcile-on-guildCreate failed');
      });
    }
  });
  /**
   * The bot was removed from a guild (kicked, banned, or the guild deleted).
   * Record it, delete NOTHING: a removed guild can still have a live paid
   * subscription, and dropping the row would hide the cancel button from
   * someone still being charged. `guildDelete` also fires on an
   * outage-driven unavailability, so ignore those - `guild.available ===
   * false` means Discord lost the guild, not that we were removed.
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
    /**
     * A pooled guild the bot is kicked from must not silently keep consuming
     * the purchaser's budget forever, and it must never be left stranded
     * (`plans/member-based-pricing.md` §5.6). Marks the membership removed
     * from wherever it is (the dashboard's own remove action does this
     * synchronously too; this is the path for a kick nobody clicked a button
     * for), clears the denormalized pointer, and recomputes the guild's own
     * entitlement as if it had never pooled — landing on `grace` with a fresh
     * window rather than the `expired` the machine would otherwise strand it
     * on, because under-charging is the acceptable failure direction here.
     */
    void (async () => {
      try {
        const row = await guildsRepo.get(guild.id);
        const poolId = await removeGuildFromAnyPoolAtomically(db, guild.id, removedAt);
        if (!poolId) return;
        // Reset, not reinterpret (§5.2a): the pool's sample history was
        // recorded under a membership this guild is no longer part of, and
        // must not be allowed to decide a breach/drop verdict for the new
        // one. The dashboard's own removeGuildFromPool does this too; this is
        // the parallel path for a kick nobody clicked a button for (§5.6).
        await memberPoolsRepo.resetSamples(poolId);
        const exit = poolExitTransition(row?.memberCount ?? null, removedAt);
        await settingsCache.transitionAuth({
          guildId: guild.id,
          toStatus: exit.toStatus,
          reason: exit.reason,
          actor: 'system',
          graceUntil: exit.graceUntil,
        });
      } catch (err) {
        logger.warn({ err, guildId: guild.id }, 'failed to exit pool on bot removal');
      }
    })();
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
     * The supporter-role safety net, on the same trigger as every other
     * reconcile here: whatever a NOTIFY missed while this process was down or
     * mid-reconnect converges now. A no-op on every instance except the one
     * whose shard owns the support guild.
     */
    void supporterRoles
      ?.reconcile()
      .catch((err: unknown) => supporterRoles.noteFailure(err, 'supporter role reconcile failed'));
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
       * `guildCreate` clears it, but that's guarded on `isReady()` and never
       * fires for the initial batch, so a guild re-added while this fleet was
       * down would keep the marker forever and the dashboard would wrongly
       * tell a paying owner they're paying for a server the bot isn't in.
       * Clearing only, never setting: removal stays with `guildDelete`.
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
    // Billing job only makes sense once the guild cache is populated. Hourly
    // ticks + one immediate pass.
    if (billingReconciler) {
      /**
       * The timer starts now; only the FIRST pass waits on the presence
       * write. The deliver phase claims by joining `guild_fleet_presence`, so
       * a first pass that raced it would find no rows for guilds joined since
       * the 0017 backfill and quietly deliver nothing (harmless, since the
       * queue is durable and the next tick catches up, but it makes the
       * first hour after every deploy look broken). Making `start()` itself
       * wait would risk a hung presence write silently leaving the job with
       * no timer at all, forever, so only the first pass is gated, not the
       * timer.
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
    errorReporter.report('gateway.error', 'Gateway error', { error: String(err) });
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
        // Without these, `claimedShards: [0]` is byte-identical whether this
        // is a healthy single-shard fleet or one machine of a misconfigured
        // multi-instance one silently serving half the guilds
        // (`plans/scaling.md` §9.1 finding 3).
        totalShards: config.totalShards,
        expectedInstances: config.expectedInstances,
        /**
         * Heartbeat round trip to the gateway node actually serving us: the
         * one latency number that can't be measured from outside the
         * process, and the one that decides whether this app belongs in its
         * current region. Discord's REST and gateway edges are both
         * Cloudflare anycast and answer equally fast from anywhere, so they
         * say nothing about where Discord itself is. `-1` means no shard is
         * connected yet.
         */
        gatewayPingMs: Math.round(client.ws.ping),
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
        problems: problemNotifier.snapshot(),
        metrics: { ...metricsCollector.stats },
        alerts: { ...alertScheduler.stats },
        topgg: topggScheduler ? { ...topggScheduler.stats } : { configured: false },
        supporterRoles: supporterRoles ? { ...supporterRoles.stats } : { enabled: false },
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
        /**
         * The database going away takes everything with it, because the
         * entitlement gate reads it before any voice event or interaction is
         * handled, so this failure must reach the admin channel, not just a
         * log line nobody is tailing.
         */
        errorReporter.report('db.ping', 'Database health ping failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }, 15_000);
  dbPingTimer.unref();

  // Self-register the global slash commands (idempotent upsert). A failure here
  // shouldn't take the bot down — log and continue; the next boot retries.
  //
  // Gated to the instance holding shard 0 (always claimed first, low->high
  // packing — `ShardLeaseRepository.claimAvailable`'s doc). This is a full
  // `PUT` replacement of the global command set on every boot, so with two
  // instances an old-image machine restarting mid-rolling-deploy would
  // otherwise re-register the OLD command body over the new one the other
  // instance just registered (`plans/scaling.md` §9.1). At one instance,
  // shard 0 is always in `ownedShards`, so this is a no-op restriction.
  if (leaseManager.ownedShards.includes(0)) {
    try {
      await registerCommands(config.discordToken, config.clientId, logger, config.devGuildId, {
        includeAssistant: Boolean(assistant),
      });
    } catch (err) {
      logger.error({ err }, 'slash-command registration failed');
    }
  } else {
    logger.info('skipping slash-command registration: this instance does not hold shard 0');
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
    supporterRoles,
    disposeSupporterSync,
    metricsCollector,
    alertScheduler,
    topggScheduler,
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
  /**
   * Arms the daily timer and the `guildMemberAdd` listener. The boot reconcile
   * on `clientReady` is deliberately NOT gated on this: it has to run whether
   * or not the guild is already available, and it is short enough that the
   * drain awaiting it is not a risk worth reordering boot for.
   */
  supporterRoles?.start();
  /**
   * Started after the drain handler for the same reason as the backup scheduler:
   * the drain performs a final flush, and a collector ticking before that handler
   * exists could be killed mid-flush with nothing to write its accumulators.
   * (`hydrate` already ran, much earlier, before the gateway connected.)
   */
  metricsCollector.start();
  /**
   * Started here for the opposite reason to the others: the drain STOPS it
   * first, before anything is torn down, so a deploy never pages about a
   * machine that is shutting down on purpose. Starting it before the drain
   * handler existed would leave a window where that guarantee does not hold.
   */
  alertScheduler.start();
  /**
   * Started with the others, after the drain handler. Nothing here is
   * latency-critical and the first tick is deliberate: a deploy that changed the
   * command list publishes it now rather than up to a quarter of an hour later.
   */
  topggScheduler?.start();
  leaseManager.startHeartbeat();
}

/**
 * This application's gateway limits, for the metric store.
 *
 * Separate from {@link fetchIdentifyConcurrency} rather than a widening of it,
 * because the two want opposite things on failure. Boot needs a number and
 * falls back to the safe floor of 1; this needs to write nothing, since a 1 in
 * the store is indistinguishable from Discord genuinely cutting the identify
 * budget to one.
 */
async function fetchGatewayLimits(
  client: Client,
  logger: Logger,
): Promise<GatewayLimits | undefined> {
  try {
    const info = (await client.rest.get(Routes.gatewayBot())) as {
      shards?: number;
      session_start_limit?: { max_concurrency?: number; remaining?: number; total?: number };
    };
    const limit = info.session_start_limit;
    if (!limit || typeof limit.total !== 'number' || typeof limit.remaining !== 'number') {
      return undefined;
    }
    return {
      recommendedShards: info.shards ?? 0,
      maxConcurrency: limit.max_concurrency ?? 1,
      // Recorded as USED so the daily peak is the worst moment of the day. A
      // remaining-style gauge would summarise to its last hourly sample, which
      // lands after the reset has restored the budget and hides the whole
      // restart loop.
      sessionUsed: Math.max(0, limit.total - limit.remaining),
      sessionTotal: limit.total,
    };
  } catch (err) {
    logger.debug({ err }, 'gateway limits poll failed');
    return undefined;
  }
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
