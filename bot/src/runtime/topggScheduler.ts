import {
  RUNTIME_FLAGS,
  type GuildFleetPresenceRepository,
  type Logger,
  type RuntimeFlagsRepository,
} from '@avc/core';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';
import { TopggApiError, toTopggCommands, type TopggClient } from '../ops/topgg.js';

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
 * names exactly one instance, needs no round trip, and lets a failure retry on
 * the next tick. It is also the same gate global command registration already
 * uses, so one instance owns every outward-facing publication.
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
   * "0 servers" with a plausible-looking number that is wrong by a factor of
   * four, which is worse than the zero it replaced. The presence table is the
   * fleet-wide truth and is what `/api/watch` and the metric store already use.
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
 * How stale the published count is allowed to get.
 *
 * Under an hour so the count moves visibly on the listing, and nowhere near any
 * documented limit: top.gg allows 100 requests a second, and this is 24 calls a
 * day from one instance.
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
     * One tick immediately, so a deploy that changed the command list publishes
     * it now rather than up to a quarter of an hour later. Safe to do on every
     * boot: the post interval is in-process, so the first tick after a restart
     * does post, and four posts on a four-machine rolling deploy is still one
     * post, because only shard 0's instance publishes.
     */
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = undefined;
    // No final publish on the way out. Draining means going away, and the count
    // this instance would send is the same one its replacement will.
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  get stats(): TopggSchedulerStats {
    const flags = this.cachedFlags ?? {};
    return {
      configured: true,
      running: this.timer !== undefined,
      paused: flags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true,
      disabled: flags[RUNTIME_FLAGS.TOPGG_DISABLED] === true,
      marketingPaused: flags[RUNTIME_FLAGS.MARKETING_PAUSED] === true,
      ownsListing: this.deps.ownsListing(),
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastPostAt: this.lastPostAt?.toISOString() ?? null,
      lastServerCount: this.lastServerCount,
      lastError: this.lastError,
      blockedUntil: this.blockedUntil?.toISOString() ?? null,
      commandsSyncedAt: this.commandsSyncedAt?.toISOString() ?? null,
      commandCount: this.commandCount,
      lastCommandError: this.lastCommandError,
    };
  }

  async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    this.inFlight = this.runTick().finally(() => {
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
      this.lastError = null;
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
      this.deps.logger.info({ count: body.length }, 'top.gg: published command list');
    } catch (err) {
      this.lastCommandError = (err as Error).message;
      this.recordBlock(err);
      this.deps.logger.warn({ err }, 'top.gg: could not publish command list');
    }
  }

  /**
   * Records a failed call. Never reported to the admin channel: a listing that
   * is a few hours stale is not worth a notification, and this is visible on
   * `/diagnostics` where somebody looking at the listing would check.
   */
  private record(err: unknown, what: string): void {
    this.lastError = (err as Error).message;
    this.recordBlock(err);
    this.deps.logger.warn({ err, what }, 'top.gg: publish failed');
  }

  /**
   * Honours a 429 by standing down for as long as it asked.
   *
   * top.gg answers a breach by blocking the token for an hour, so retrying on
   * the normal interval would keep the block alive rather than wait it out.
   */
  private recordBlock(err: unknown): void {
    if (err instanceof TopggApiError && err.retryAfterMs !== null) {
      this.blockedUntil = new Date(this.now() + err.retryAfterMs);
      this.deps.logger.warn(
        { until: this.blockedUntil.toISOString() },
        'top.gg: rate limited, standing down',
      );
    }
  }
}
