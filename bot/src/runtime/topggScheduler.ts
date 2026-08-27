import {
  RUNTIME_FLAGS,
  type GuildFleetPresenceRepository,
  type Logger,
  type RuntimeFlagsRepository,
} from '@avc/core';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import {
  TopggApiError,
  isPermanentTopggFailure,
  toTopggCommands,
  type TopggClient,
} from '../ops/topgg.js';

/**
 * Keeps the top.gg listing's server count and command list current
 * (`plans/marketing.md` beat 6).
 *
 * Exists entirely because both numbers rot in the direction that looks like
 * abandonment. The listing has been showing a server count of zero and no
 * commands, which is the impression a prospective admin forms before reading a
 * word of the description.
 *
 * **Owned by the instance holding shard 0, not by a cluster lock.** The
 * alternative was `BillingRunRepository.reserveRun` with a new lock slot, which
 * is the right tool for the leniency ladder and the wrong one here: the
 * reservation advances its durable timestamp when it is GRANTED, so a failed
 * post consumes the window and cannot be retried until the next one. Shard 0 is
 * claimed first by construction (`ShardLeaseRepository.claimAvailable`), so it
 * needs no round trip and lets a failure retry on the next tick. It is also the
 * same gate global command registration already uses, so one instance owns
 * every outward-facing publication.
 *
 * It is **one instance in the steady state, not exactly one always.** Shard 0
 * moves between machines across a deploy, and an instance whose lease heartbeat
 * is failing keeps its `ownedShards` while a booting peer legitimately claims
 * the same shard (`plans/scaling.md` §6.1). So two machines can publish in the
 * same window. That is harmless here and is why this gate is enough: both calls
 * are idempotent, both read the same number from the same database, and two
 * requests is nothing against a 100-per-second limit. Do not read the gate as a
 * mutual exclusion guarantee for anything where it would matter.
 *
 * Enabled purely by `TOPGG_TOKEN` being configured, so self-host and any fleet
 * without the secret never post. That matters more than it looks: `@me`
 * resolves the project FROM THE TOKEN, and the count comes from this fleet's
 * `guild_fleet_presence` rows, so the same secret on beta would publish beta's
 * guild count to the production listing.
 */

export interface TopggSchedulerDeps {
  client: TopggClient;
  flags: RuntimeFlagsRepository;
  /**
   * Where the server count comes from, and it must not be
   * `client.guilds.cache.size`.
   *
   * Prod is four shards over four machines, so this instance's gateway cache
   * holds roughly a quarter of the install base. Publishing that would replace
   * "0 servers" with a plausible-looking number wrong by a factor of four,
   * which is worse than the zero it replaced. This table is fleet-wide, and it
   * is the same source the `guilds.present` metric is derived from
   * (`MetricsRepository`'s derived-gauge sweep). It is NOT what `/api/watch`
   * reads, and `guilds.installed` is a different number off the shared
   * `guilds.bot_removed_at` column, which nothing new should read.
   *
   * **Known to over-count slightly, and there is no better source.** On a
   * sharded fleet the hourly presence sync can only ever widen: narrowing needs
   * an instance that holds every shard, because for a partial-shard instance
   * "not in my cache" does not mean "not in the guild" (`syncPresence` in
   * `index.ts`, and `reconcilePresence`'s own doc). So removals rely on the
   * live `guildDelete`, and one missed while a process was down is never
   * corrected. The error is small and one-directional. Every alternative is
   * worse, so this publishes the best number available and does not pretend it
   * is exact.
   */
  presence: GuildFleetPresenceRepository;
  logger: Logger;
  /** Published as `shard_count`. The fleet's total, not this instance's share. */
  totalShards: number;
  /**
   * Does this instance hold shard 0? A thunk rather than a boolean, because
   * shard ownership changes while the process runs (a peer dies, this instance
   * re-claims on the next boot-time sweep).
   */
  ownsListing: () => boolean;
  /**
   * The command set to publish, matching what is registered GLOBALLY.
   *
   * A thunk so it is evaluated at publish time and so tests can vary it. Note
   * what the caller must pass: the global set, without `/debug`, since the
   * listing should show what a real server gets rather than what a dev guild
   * gets.
   */
  commands: () => readonly RESTPostAPIApplicationCommandsJSONBody[];
  /**
   * Reports a failure that will not fix itself, ONCE.
   *
   * Everything else here is deliberately log-only: a listing a few hours stale
   * is not worth a notification. A rejected token is a different thing wearing
   * the same shape. It retries forever, changes nothing, has no alert condition
   * and no `/api/watch` check, so the end state is exactly the abandoned-looking
   * listing this exists to remove, discoverable only by someone opening
   * `/diagnostics` for a feature nobody is watching.
   */
  report?: ((kind: string, message: string, context: Record<string, unknown>) => void) | undefined;
  intervalMs?: number;
  postIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => number;
}

export interface TopggSchedulerStats {
  /** Always true when this object exists. False is reported by the caller. */
  configured: boolean;
  running: boolean;
  /** `global.pause`. Distinguished from the two below so a stale count is explicable. */
  paused: boolean;
  /** `topgg.disabled`. */
  disabled: boolean;
  /** `marketing.paused`. */
  marketingPaused: boolean;
  /** Is this the instance that publishes? False on every machine but one. */
  ownsListing: boolean;
  lastTickAt: string | null;
  lastPostAt: string | null;
  lastServerCount: number | null;
  lastError: string | null;
  /** Set by a 429. Nothing is attempted until it passes. */
  blockedUntil: string | null;
  /**
   * True once a status that will not fix itself has been seen (401/403/404).
   * Read this before anything else when the listing is not updating: it means
   * the token or the project is wrong, not that the job is unhealthy.
   */
  permanentFailure: boolean;
  commandsSyncedAt: string | null;
  commandCount: number | null;
  lastCommandError: string | null;
}

/**
 * How often to *consider* publishing. The post interval below decides whether
 * to act, so a failure retries within this rather than within an hour.
 */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

/**
 * The minimum gap between two published counts.
 *
 * Slightly under an hour so that it lands on the hourly tick rather than
 * skipping to the next one, which makes the real cadence about 60 minutes, and
 * 75 if a tick is missed. Nowhere near any documented limit: top.gg allows 100
 * requests a second, and this is roughly 24 calls a day from one instance.
 */
const DEFAULT_POST_INTERVAL_MS = 55 * 60_000;

export class TopggScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private ticking = false;
  private stopping = false;

  private cachedFlags: Record<string, unknown> | undefined;
  private lastTickAt: Date | null = null;
  private lastPostAt: Date | null = null;
  private lastServerCount: number | null = null;
  private lastError: string | null = null;
  private blockedUntil: Date | null = null;
  private commandsSyncedAt: Date | null = null;
  private commandCount: number | null = null;
  private lastCommandError: string | null = null;
  private permanentFailure = false;
  /** So a token nobody has fixed is reported once, not every quarter of an hour. */
  private reportedPermanentFailure = false;

  private readonly intervalMs: number;
  private readonly postIntervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly now: () => number;

  constructor(private readonly deps: TopggSchedulerDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.postIntervalMs = deps.postIntervalMs ?? DEFAULT_POST_INTERVAL_MS;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    // `!== undefined`, not truthiness: an injected scheduler may hand back 0 as
    // a handle, and a falsy check would then start twice.
    if (this.timer !== undefined) return;
    this.stopping = false;
    this.timer = this.setIntervalFn(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    /**
     * **Deliberately no immediate tick**, unlike `AlertScheduler`.
     *
     * `start()` runs after `client.login()` but the fleet's presence rows are
     * written from the `clientReady` handler, which takes seconds on a
     * thousand-guild shard while a tick takes one flag read and one count. So
     * an immediate tick reads the presence table BEFORE this boot has touched
     * it. On an established fleet that is harmless (the previous run's rows are
     * complete and durable), but on a fleet whose rows are incomplete -- a
     * first-ever boot, a new fleet, a machine crash-looping faster than the
     * post interval it keeps in memory -- it would publish a fraction of the
     * install base. A fraction is non-zero, so the zero-guard does not catch
     * it, and it sits on a public listing for an hour.
     *
     * Waiting one interval costs a deploy's command-list change appearing up to
     * a quarter of an hour late, on a page measured in days.
     */
  }

  /**
   * Synchronous in effect: the timer stops and an in-flight publish is
   * ABANDONED rather than awaited.
   *
   * This sits near the front of the drain, ahead of the per-guild queues, the
   * gateway teardown and `leaseManager.releaseAll()`. Awaiting would put up to
   * two ten-second network waits there, and exactly when the timeout matters
   * (top.gg hanging) the machine would be SIGKILLed before it released its
   * leases, leaving its replacement to wait out the 30s lease TTL.
   *
   * Nothing is lost by abandoning it. Both calls are idempotent, the count is
   * the same one the replacement will send, and no local state depends on the
   * result. The rejection handler is attached, not awaited, so an abandoned
   * request cannot surface as an unhandled rejection.
   */
  stop(): Promise<void> {
    this.stopping = true;
    // `!== undefined` for the same reason `start()` uses it: a handle can
    // legitimately be 0, and a truthiness check would then never clear it.
    if (this.timer !== undefined) this.clearIntervalFn(this.timer);
    this.timer = undefined;
    this.inFlight?.catch(() => {});
    return Promise.resolve();
  }

  get stats(): TopggSchedulerStats {
    const flags = this.cachedFlags ?? {};
    /**
     * Nothing in here may throw. `/diagnostics` builds its whole report from
     * these getters, so one throwing turns a stale listing counter into a dead
     * diagnostics endpoint for every other subsystem too, which is the
     * escalation the per-feature isolation exists to prevent.
     */
    let owns = false;
    try {
      owns = this.deps.ownsListing();
    } catch {
      // Reported as not publishing, which is the truthful answer when we cannot
      // find out. The tick logs the real error.
    }
    return {
      configured: true,
      running: this.timer !== undefined,
      paused: flags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true,
      disabled: flags[RUNTIME_FLAGS.TOPGG_DISABLED] === true,
      marketingPaused: flags[RUNTIME_FLAGS.MARKETING_PAUSED] === true,
      ownsListing: owns,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastPostAt: this.lastPostAt?.toISOString() ?? null,
      lastServerCount: this.lastServerCount,
      lastError: this.lastError,
      blockedUntil: this.blockedUntil?.toISOString() ?? null,
      permanentFailure: this.permanentFailure,
      commandsSyncedAt: this.commandsSyncedAt?.toISOString() ?? null,
      commandCount: this.commandCount,
      lastCommandError: this.lastCommandError,
    };
  }

  async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    this.inFlight = this.runTick()
      /**
       * Swallowed here, not by the caller. The timer calls this as
       * `void this.tick()`, and `stop()` no longer awaits, so anything escaping
       * `runTick` would become an unhandled rejection. Both publish paths catch
       * their own failures, which makes this the backstop for the parts that
       * are not supposed to throw at all.
       */
      .catch((err: unknown) => {
        this.lastError = (err as Error).message;
        this.deps.logger.error({ err }, 'top.gg: tick failed unexpectedly');
      })
      .finally(() => {
        this.ticking = false;
        this.inFlight = undefined;
        this.lastTickAt = new Date(this.now());
      });
    await this.inFlight;
  }

  private async runTick(): Promise<void> {
    /**
     * Kill switches are honoured from the last readable snapshot when the
     * database is unreachable, matching `AlertScheduler`. A switch someone
     * deliberately set must not un-set itself because the database blipped.
     */
    const flags = await this.deps.flags
      .getAll()
      .then((f) => {
        this.cachedFlags = f;
        return f;
      })
      .catch(() => this.cachedFlags);

    if (flags?.[RUNTIME_FLAGS.GLOBAL_PAUSE] === true) return;
    if (flags?.[RUNTIME_FLAGS.TOPGG_DISABLED] === true) return;
    /**
     * `marketing.paused` applies here, and the flag's own documentation is why:
     * it exists so the first automated poster built could not step on a manual
     * announcement. A silent counter is a weaker case than an announcement
     * would be, and honouring it is what keeps the lever meaning what its name
     * says.
     *
     * The cost of being wrong about that is a forgotten flag freezing the
     * listing for months, so `stats` reports each switch separately rather than
     * one "not running" — "why is the count stale" has to be answerable from
     * `/diagnostics` in one look.
     */
    if (flags?.[RUNTIME_FLAGS.MARKETING_PAUSED] === true) return;

    if (!this.deps.ownsListing()) return;

    await this.publishMetrics();
    await this.publishCommands();
  }

  /**
   * Is a rate-limit stand-down still in force?
   *
   * Checked by each publisher rather than once per tick, and that is the point:
   * top.gg blocks the TOKEN, not the route, so a 429 on the metrics call means
   * the command call in the same tick is already doomed. Asking once at the top
   * of the tick would let the second request go out microseconds after the
   * refusal that caused the block.
   */
  private blocked(): boolean {
    return this.blockedUntil !== null && this.now() < this.blockedUntil.getTime();
  }

  private async publishMetrics(): Promise<void> {
    if (this.blocked()) return;
    if (this.lastPostAt && this.now() - this.lastPostAt.getTime() < this.postIntervalMs) return;

    let serverCount: number;
    try {
      serverCount = await this.deps.presence.countPresent();
    } catch (err) {
      this.lastError = `count failed: ${(err as Error).message}`;
      this.deps.logger.warn({ err }, 'top.gg: could not count present guilds');
      return;
    }

    /**
     * A zero is refused rather than published.
     *
     * The same reasoning as `reconcilePresence`'s empty-set guard: "this fleet
     * is in no guilds" and "the presence table has not been populated yet" are
     * indistinguishable from here, and one of them is overwhelmingly more
     * likely. Publishing it would blank the listing, which is the exact state
     * this job exists to fix, so the failure mode would be invisible in the
     * shape of success.
     */
    if (serverCount <= 0) {
      this.lastError = 'refused to publish a server count of 0';
      this.deps.logger.warn(
        { serverCount },
        'top.gg: refusing to publish a zero server count, presence table may be empty',
      );
      return;
    }

    try {
      await this.deps.client.postMetrics({ serverCount, shardCount: this.deps.totalShards });
      this.lastPostAt = new Date(this.now());
      this.lastServerCount = serverCount;
      this.succeeded();
      this.deps.logger.info(
        { serverCount, shardCount: this.deps.totalShards },
        'top.gg: published metrics',
      );
    } catch (err) {
      this.record(err, 'metrics');
    }
  }

  private async publishCommands(): Promise<void> {
    if (this.blocked()) return;
    // Once per process. The command set only changes with a deploy, and a
    // deploy restarts the process.
    if (this.commandsSyncedAt) return;

    let body;
    try {
      body = toTopggCommands(this.deps.commands());
    } catch (err) {
      /**
       * A mapping failure is our bug, not top.gg's, so it is recorded and not
       * retried on a timer: every tick would fail identically. CI maps the real
       * command set for this reason.
       */
      this.commandsSyncedAt = new Date(this.now());
      this.lastCommandError = `could not map commands: ${(err as Error).message}`;
      this.deps.logger.error({ err }, 'top.gg: command list could not be mapped');
      return;
    }

    try {
      await this.deps.client.putCommands(body);
      this.commandsSyncedAt = new Date(this.now());
      this.commandCount = body.length;
      this.lastCommandError = null;
      this.blockedUntil = null;
      this.deps.logger.info({ count: body.length }, 'top.gg: published command list');
    } catch (err) {
      this.lastCommandError = (err as Error).message;
      this.recordBlock(err);
      this.deps.logger.warn({ err }, 'top.gg: could not publish command list');
    }
  }

  /**
   * A call went through. Clears the stand-down as well as the error.
   *
   * Without clearing `blockedUntil`, a rate limit that has since expired stays
   * on `/diagnostics` looking like the current state forever.
   */
  private succeeded(): void {
    this.lastError = null;
    this.blockedUntil = null;
    this.permanentFailure = false;
  }

  /**
   * Records a failed call. A transient failure is log-only: a listing a few
   * hours stale is not worth a notification, and it is on `/diagnostics` where
   * anyone asking about the listing would look.
   */
  private record(err: unknown, what: string): void {
    this.lastError = (err as Error).message;
    this.recordBlock(err);
    this.deps.logger.warn({ err, what }, 'top.gg: publish failed');
  }

  /**
   * Honours a 429 by standing down for as long as it asked, and escalates a
   * failure that will not fix itself.
   *
   * top.gg answers a rate-limit breach by blocking the token for an hour, so
   * retrying on the normal interval would keep the block alive rather than wait
   * it out. A 401/403/404 is the opposite problem: retrying is free and
   * pointless, and the only thing that helps is somebody being told.
   */
  private recordBlock(err: unknown): void {
    if (!(err instanceof TopggApiError)) return;
    if (err.retryAfterMs !== null) {
      this.blockedUntil = new Date(this.now() + err.retryAfterMs);
      this.deps.logger.warn(
        { until: this.blockedUntil.toISOString() },
        'top.gg: rate limited, standing down',
      );
    }
    if (!isPermanentTopggFailure(err.status)) return;
    this.permanentFailure = true;
    if (this.reportedPermanentFailure) return;
    this.reportedPermanentFailure = true;
    this.deps.report?.(
      'topgg.rejected',
      `top.gg rejected the listing update with HTTP ${err.status}. The listing will stop updating ` +
        'until TOPGG_TOKEN is fixed or cleared. Nothing else is affected.',
      { status: err.status },
    );
  }
}
