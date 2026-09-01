import {
  RUNTIME_FLAGS,
  type AlertAudience,
  type AlertRepository,
  type AlertSeverity,
  type Logger,
  type RuntimeFlagsRepository,
} from '@avc/core';

/**
 * The in-process watcher (`plans/agentic_management.md` step 4). The
 * companion to `/api/watch`, deliberately not a duplicate: `/api/watch` runs
 * in `avc-web`, reads Postgres, and survives this process being dead, which
 * makes it blind to anything that never reaches a table (a tripped breaker,
 * a queue depth, whether this instance's gateway is actually connected).
 * This runs here, sees all of that, and cannot report its own death.
 *
 * Hence the third leg: a dead-man's switch. Every healthy tick POSTs
 * `WATCHDOG_PING_URL`, and something outside notices when the POSTs stop.
 * That is also the **only** down-detection available to a self-hoster, who
 * has no `avc-web` and no second machine, which is why it is a plain
 * optional URL rather than anything of ours.
 *
 * **Raising is the easy half. Resolving is the half that makes it usable.**
 * An alerting system whose conditions never come back down is a system
 * everyone learns to ignore, so every polled condition here is reconciled
 * against reality on each tick, and event-driven ones age out.
 */

export interface WatchProblem {
  /** Narrows the condition: a guild id, a shard id. Omit when fleet-wide. */
  target?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface WatchCheck {
  /** Stable slug for the CONDITION, and the alert key it raises. */
  key: string;
  /**
   * `critical` means "this instance is not doing its job", and it does more
   * than colour a row: a confirmed critical suppresses the watchdog ping, so
   * the external heartbeat monitor fires. Reserve it for conditions where the
   * bot being up is not the same as the bot working.
   */
  severity: AlertSeverity;
  audience: AlertAudience;
  /**
   * Consecutive ticks a problem must be seen before it opens. Anything that
   * blips during a reconnect or a deploy wants at least 2, for the same reason
   * the uptime monitors are configured with a confirmation threshold.
   */
  confirmations?: number;
  /** Returns every currently-true instance of the condition. Empty = healthy. */
  run: () => WatchProblem[] | Promise<WatchProblem[]>;
}

export interface AlertSchedulerDeps {
  /**
   * The durable record. Absent on self-host, where the table exists but stays
   * empty (there is no console to read it), and the in-memory gate below is
   * what keeps a Discord channel from being told the same thing every minute.
   */
  alerts?: AlertRepository | undefined;
  flags: RuntimeFlagsRepository;
  logger: Logger;
  /**
   * The notification transport, and deliberately the CHANNEL reporter rather
   * than the tee'd one every other caller gets.
   *
   * This class does its own `raise()` with a real severity and audience, so
   * routing notifications through a reporter that also persists would write the
   * same row twice per tick, with the wrong severity on one of them.
   */
  notify: (kind: string, message: string, context: Record<string, unknown>) => void;
  /**
   * Posts one message bypassing the per-kind throttle, for the retry loop.
   *
   * Separate from `notify` because a retry is by definition about a condition
   * posted recently, so the throttle would swallow it -- and `notify` is void,
   * so the loop would then mark the row delivered on a message nobody sent.
   * Absent means no retry loop, which is the self-host case.
   */
  deliver?: (content: string) => Promise<boolean>;
  checks: readonly WatchCheck[];
  /**
   * Who is doing the watching, stamped into every alert it raises.
   *
   * Load-bearing rather than informational: reconciliation resolves what this
   * instance itself raised and nothing else. Without it, the first instance to
   * tick healthy would close every other instance's open conditions.
   */
  instanceId: string;
  watchdogPingUrl?: string | undefined;
  intervalMs?: number;
  /** How long an unseen alert stays open before it is aged out. */
  staleAfterMs?: number;
  fetchFn?: typeof fetch;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface AlertSchedulerStats {
  running: boolean;
  paused: boolean;
  disabled: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  openConditions: { key: string; target: string }[];
  /**
   * Alerts raised but not yet delivered. Mirrors `billing.notificationQueueDepth`.
   *
   * A depth that does not fall means rows nobody can deliver, which is silent
   * by construction: the alerter believes it alerted someone.
   */
  undelivered: number;
  watchdog: {
    configured: boolean;
    lastPingAt: string | null;
    lastError: string | null;
    /** True when the last tick withheld the ping because of a critical. */
    suppressed: boolean;
  };
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_AFTER_MS = 24 * 3_600_000;
/**
 * How recently a critical must have been re-confirmed to withhold the ping.
 *
 * Polled conditions re-stamp every tick, so anything older belongs to an
 * instance that vanished without resolving it. Matches `/api/watch`.
 */
const FLEET_CRITICAL_WINDOW_MS = 15 * 60_000;

const PING_TIMEOUT_MS = 10_000;

/**
 * The most targets one check will raise rows for in a single tick.
 *
 * Targets outside the cap are resolved rather than left stale-stamped: at most
 * this many rows exist per key, and the log line says how many were dropped.
 * Leaving them open but un-refreshed would let `expireStale` close them at 24h
 * while they were still true, which is the one outcome worse than not
 * reporting them.
 */
const MAX_TARGETS_PER_CHECK = 25;

/**
 * Alerts the retry loop delivers per tick.
 *
 * Its own cap, independent of the per-check one, for the same reason: each row
 * is a round trip on a shared pool during what is by definition an incident.
 * It does NOT bound the message length -- one `permissions.blocked` line runs to
 * several hundred characters on its own, so {@link CHUNK_CHARS} does that.
 */
const MAX_DELIVER_PER_TICK = 10;

/**
 * Character budget for one retry message.
 *
 * Under Discord's 2000 and under the 1900 `send` truncates at, so a chunk can
 * never be cut. The margin covers the header line and the markdown.
 */
const CHUNK_CHARS = 1700;

/** Resolved alerts older than this are deleted. History, not an archive. */
const PRUNE_RESOLVED_AFTER_MS = 30 * 24 * 3_600_000;

/**
 * Separator for the `key`+`target` gate ids, written as an escape.
 *
 * NUL because it cannot occur in an alert key or a snowflake, and as `\u0000`
 * rather than a literal because a raw NUL byte in a source file makes git
 * treat the whole file as binary, which silently costs every future diff and
 * review of it.
 */
const SEP = '\u0000';
const idOf = (key: string, target: string): string => `${key}${SEP}${target}`;

/**
 * Splits rows into groups whose rendered lines fit one message.
 *
 * A single row longer than the budget still gets its own chunk rather than
 * being dropped: it will be truncated by Discord, but it is then the only row
 * marked against that message, so at most one alert is affected instead of
 * every row that happened to share the batch.
 */
function chunkByLength<T extends { key: string; target: string; message: string }>(
  rows: readonly T[],
  budget: number,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let length = 0;
  for (const row of rows) {
    const size = row.key.length + row.target.length + row.message.length + 12;
    if (current.length > 0 && length + size > budget) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(row);
    length += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class AlertScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopping = false;
  private inFlight: Promise<void> | undefined;

  /** Consecutive observations per condition instance, for `confirmations`. */
  private readonly streaks = new Map<string, number>();
  /**
   * What this process currently believes is open, and the gate deciding whether
   * to notify.
   *
   * In memory rather than read back from the table, so the behaviour is
   * identical on a self-host that has no table at all. A restart re-notifies a
   * condition that is still true, which is the right call: a fresh process
   * restating a live problem is information, not noise.
   */
  private readonly openLocally = new Set<string>();

  private lastTickAt: Date | null = null;
  private lastError: string | null = null;
  private lastPingAt: Date | null = null;
  private lastPingError: string | null = null;
  private pingSuppressed = false;
  private undelivered = 0;
  /** Last readable flag snapshot, so a DB blip cannot un-set a kill switch. */
  private cachedFlags: Record<string, unknown> | null = null;

  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(private readonly deps: AlertSchedulerDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    // `!== undefined`, not truthiness: an injected scheduler may legitimately
    // hand back 0 as a handle, and a falsy check would then start twice.
    if (this.timer !== undefined) return;
    // Cleared here, not only set in `stop()`. Leaving it set made a restarted
    // scheduler one whose every tick was a silent no-op.
    this.stopping = false;
    this.timer = this.setIntervalFn(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    /**
     * One tick immediately, so the watchdog gets its first ping at boot rather
     * than a full interval later. A deploy already spends a grace window's
     * worth of time not pinging, and adding another minute to it on the far
     * side is how a correctly-configured heartbeat monitor ends up firing on
     * every routine deploy.
     */
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = undefined;
    /**
     * No final ping, and no bulk resolve on the way out. Draining means going
     * away: the conditions may well still be true, and the replacement instance
     * will say so within a tick.
     */
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  get stats(): AlertSchedulerStats {
    const flags = this.cachedFlags ?? {};
    return {
      running: this.timer !== undefined,
      paused: flags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true,
      disabled: flags[RUNTIME_FLAGS.ALERTS_DISABLED] === true,
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastError: this.lastError,
      openConditions: [...this.openLocally].map((id) => {
        const [key = '', target = ''] = id.split(SEP);
        return { key, target };
      }),
      undelivered: this.undelivered,
      watchdog: {
        configured: Boolean(this.deps.watchdogPingUrl),
        lastPingAt: this.lastPingAt?.toISOString() ?? null,
        lastError: this.lastPingError,
        suppressed: this.pingSuppressed,
      },
    };
  }

  async tick(): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    this.inFlight = this.runTick().finally(() => {
      this.ticking = false;
      this.inFlight = undefined;
      this.lastTickAt = new Date();
    });
    await this.inFlight;
  }

  private async runTick(): Promise<void> {
    /**
     * Kill switches are honoured from the last readable snapshot when the
     * database is unreachable. A switch someone deliberately set must not
     * un-set itself the moment the database blips, and a first tick that has
     * never read one falls through to running, which is the safe direction for
     * a watcher.
     */
    const flags = await this.deps.flags
      .getAll()
      .then((f) => {
        this.cachedFlags = f;
        return f;
      })
      .catch(() => this.cachedFlags);

    if (flags?.[RUNTIME_FLAGS.GLOBAL_PAUSE] === true) return;
    if (flags?.[RUNTIME_FLAGS.ALERTS_DISABLED] === true) return;

    let criticalOpen = false;
    for (const check of this.deps.checks) {
      if (this.stopping) return;
      const failing = await this.evaluate(check);
      if (failing && check.severity === 'critical') criticalOpen = true;
    }

    await this.deps.alerts
      ?.expireStale(new Date(Date.now() - this.staleAfterMs))
      .then((n) => {
        if (n > 0) this.deps.logger.info({ expired: n }, 'aged out alerts nobody has seen');
      })
      .catch((err: unknown) => {
        this.lastError = (err as Error).message;
        this.deps.logger.warn({ err }, 'alert expiry failed');
      });

    await this.deliverPending();
    await this.prune();

    /**
     * Withheld for a critical anywhere in this FLEET, not only on this machine.
     *
     * **This is why the 2026-09-01 outage lasted 3 hours 37 minutes.** Shard 0's
     * gateway was dead and the instance holding it correctly confirmed a
     * critical and correctly withheld its own ping. The other three instances
     * were healthy, kept pinging every minute, and the heartbeat monitor stayed
     * green throughout. The switch is documented as making "a bot that is
     * running and not working read as down", and that was only ever true of a
     * single-instance fleet: on four machines, one dead shard is invisible.
     *
     * Reading the shared table is what makes a partial-fleet failure visible,
     * and it keeps the redundancy that matters: every instance still pings, so
     * one machine dying does not blind the monitor by itself.
     */
    const suppress = criticalOpen || (await this.fleetCriticalOpen());
    this.pingSuppressed = suppress;
    if (!suppress) await this.ping();
  }

  /**
   * Delivers alerts the immediate path did not.
   *
   * The backstop half of step 4b. The fast path posts to Discord and stamps the
   * row itself; anything still unstamped two minutes later is something that
   * provably did not get sent -- the throttle withheld it, Discord refused it,
   * or the process died between the post and the stamp.
   *
   * On a multi-instance fleet this is also the only way some alerts get out at
   * all: a `gateway.down` is structurally undeliverable by the very instance
   * that raised it, because the client it would post through is the thing that
   * broke. The claim is therefore fleet-scoped but deliberately NOT
   * instance-scoped, so a healthy peer can pick it up.
   */
  private async deliverPending(): Promise<void> {
    const deliver = this.deps.deliver;
    const alerts = this.deps.alerts;
    if (!deliver || !alerts) return;

    try {
      // Resolved-but-unsent rows are not delivery failures and must not be
      // retried, but they must also stop sitting in the claimable index.
      await alerts.closeResolvedUndelivered();

      const claimed = await alerts.claimUndelivered(MAX_DELIVER_PER_TICK);
      this.undelivered = await alerts.undeliveredDepth();
      if (claimed.length === 0) return;

      /**
       * Chunked, and each row marked only against the message that carried it.
       *
       * `AdminChannelReporter.send` truncates to Discord's limit and still
       * returns true, so one batched message plus a blanket `markDelivered`
       * would stamp rows whose text was cut off as delivered -- a silent drop,
       * which is the one outcome this whole layer exists to remove. The
       * per-tick row cap is not a length bound: one `permissions.blocked`
       * line alone can run to several hundred characters.
       */
      for (const chunk of chunkByLength(claimed, CHUNK_CHARS)) {
        const lines = chunk.map((a) => {
          const where = a.target ? ` (${a.target})` : '';
          const seen = a.occurrences > 1 ? ` x${a.occurrences}` : '';
          return `- **${a.key}**${where}${seen}: ${a.message}`;
        });
        const sent = await deliver(['Undelivered alerts:', ...lines].join('\n')).catch(() => false);
        for (const a of chunk) {
          if (sent) await alerts.markDelivered(a.id);
          else await alerts.markDeliveryFailed(a.id, 'retry post failed');
        }
      }
      this.undelivered = await alerts.undeliveredDepth();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.logger.warn({ err }, 'alert delivery retry failed');
    }
  }

  /** Drops resolved history, which nothing else ever deletes. */
  private async prune(): Promise<void> {
    await this.deps.alerts
      ?.pruneResolved(new Date(Date.now() - PRUNE_RESOLVED_AFTER_MS))
      .then((n) => {
        if (n > 0) this.deps.logger.info({ pruned: n }, 'pruned resolved alerts');
      })
      .catch((err: unknown) => {
        this.lastError = (err as Error).message;
        this.deps.logger.warn({ err }, 'alert prune failed');
      });
  }

  /** Runs one check and reconciles its alerts. Returns whether it is failing. */
  private async evaluate(check: WatchCheck): Promise<boolean> {
    let problems: WatchProblem[];
    try {
      problems = await check.run();
    } catch (err) {
      /**
       * A check that throws is UNKNOWN: neither healthy nor failing. It opens
       * no alert and suppresses no ping, because a bug in one condition must
       * not be able to declare the whole instance dead to an external monitor.
       */
      this.lastError = (err as Error).message;
      this.deps.logger.warn({ err, key: check.key }, 'watch check could not run');
      /**
       * Keyed by the check, not a shared `watch.check`. The notifier throttles
       * per kind, so one shared key means the first broken check silences every
       * other broken check for the length of the window -- the exact failure
       * the per-kind throttle was introduced to fix.
       */
      this.deps.notify(`watch.check.${check.key}`, `Health check ${check.key} could not run`, {
        check: check.key,
        error: (err as Error).message,
      });
      return false;
    }

    const required = Math.max(1, check.confirmations ?? 1);
    const seen = new Set<string>();
    const confirmed: { target: string; problem: WatchProblem }[] = [];

    for (const problem of problems) {
      const target = problem.target ?? '';
      const id = idOf(check.key, target);
      seen.add(id);
      const streak = (this.streaks.get(id) ?? 0) + 1;
      this.streaks.set(id, streak);
      if (streak >= required) confirmed.push({ target, problem });
    }

    /**
     * A streak that missed a tick is deleted outright rather than decremented.
     * `confirmations` means CONSECUTIVE: a decaying counter would let a
     * condition that flickers once an hour eventually cross a threshold it
     * never actually sustained, which is precisely the false positive the
     * threshold exists to prevent.
     */
    for (const id of [...this.streaks.keys()]) {
      if (id.startsWith(`${check.key}${SEP}`) && !seen.has(id)) this.streaks.delete(id);
    }

    /**
     * Capped, and the drop is logged rather than silent.
     *
     * Each target costs a sequential round trip on the shared pool, every
     * minute, and the scenario that produces a large N is a database or Discord
     * incident, which is exactly when that is least affordable. A tick that
     * outruns its own interval is then silently swallowed by the `ticking`
     * guard, so an unbounded fan-out does not merely cost time, it stops the
     * watcher watching.
     *
     * Twenty-five named guilds is already past the point where the list is the
     * useful part of the alert. Beyond that the count is the finding.
     */
    if (confirmed.length > MAX_TARGETS_PER_CHECK) {
      /**
       * Sorted before truncating, so the SAME targets survive every tick.
       * Without it the kept set follows whatever order the check happened to
       * produce, and rows would resolve and re-open as membership shuffled --
       * turning a cap into a flap generator.
       */
      confirmed.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
      this.deps.logger.warn(
        { key: check.key, total: confirmed.length, reported: MAX_TARGETS_PER_CHECK },
        'watch check matched more targets than it will report',
      );
      confirmed.length = MAX_TARGETS_PER_CHECK;
    }

    for (const { target, problem } of confirmed) {
      const id = idOf(check.key, target);
      const isNew = !this.openLocally.has(id);
      this.openLocally.add(id);

      await this.deps.alerts
        ?.raise({
          key: check.key,
          target,
          message: problem.message,
          severity: check.severity,
          audience: check.audience,
          details: { ...(problem.details ?? {}), instance: this.deps.instanceId },
        })
        .catch((err: unknown) => {
          this.lastError = (err as Error).message;
          this.deps.logger.warn({ err, key: check.key }, 'could not persist a watch alert');
        });

      if (isNew) {
        this.deps.logger.warn({ key: check.key, target }, problem.message);
        this.deps.notify(check.key, problem.message, {
          ...(target ? { target } : {}),
          ...(problem.details ?? {}),
        });
      }
    }

    const activeTargets = confirmed.map((c) => c.target);
    const activeIds = new Set(activeTargets.map((t) => idOf(check.key, t)));
    for (const id of [...this.openLocally]) {
      if (!id.startsWith(`${check.key}${SEP}`) || activeIds.has(id)) continue;
      this.openLocally.delete(id);
      /**
       * Recovery is announced for criticals only. Knowing an outage ended
       * matters; knowing that one of a thousand guilds' breakers closed again
       * is the kind of message that teaches people to mute the channel.
       */
      if (check.severity === 'critical') {
        const [, target = ''] = id.split(SEP);
        this.deps.notify(`${check.key}.resolved`, `Recovered: ${check.key}`, {
          ...(target ? { target } : {}),
        });
      }
    }

    await this.deps.alerts
      ?.resolveOthers(check.key, activeTargets, { instance: this.deps.instanceId })
      .catch((err: unknown) => {
        this.lastError = (err as Error).message;
        this.deps.logger.warn({ err, key: check.key }, 'could not resolve stale watch alerts');
      });

    return confirmed.length > 0;
  }

  /**
   * Whether any instance of this fleet is currently confirming a critical.
   *
   * **Anti-latched on `last_seen_at`, which is not optional.** A polled
   * condition is re-stamped every tick and resolves itself when it clears, so a
   * row nobody has touched belongs to an instance that went away without
   * cleaning up. Without the window, one such row would withhold the ping
   * forever and the monitor would be permanently red, which this file's own
   * header calls alert fatigue with a URL and worse than no monitor. The window
   * matches the one `/api/watch` uses for the same reason.
   *
   * Fails OPEN. If this read throws, the database is in trouble, and that is
   * itself a locally-evaluated critical which has already set `criticalOpen`.
   * Suppressing again on the error would mean a database blip silently reads as
   * a fleet-wide outage on the one signal that is supposed to be trustworthy.
   */
  private async fleetCriticalOpen(): Promise<boolean> {
    if (!this.deps.alerts) return false;
    try {
      const cutoff = Date.now() - FLEET_CRITICAL_WINDOW_MS;
      const open = await this.deps.alerts.open(50);
      return open.some((row) => row.severity === 'critical' && row.lastSeenAt.getTime() > cutoff);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.deps.logger.warn({ err }, 'could not read fleet alerts for the watchdog');
      return false;
    }
  }

  private async ping(): Promise<void> {
    const url = this.deps.watchdogPingUrl;
    if (!url) return;
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastPingAt = new Date();
      this.lastPingError = null;
    } catch (err) {
      /**
       * Logged, never reported to the admin channel.
       *
       * A failing ping is already about to page someone through the very
       * monitor it feeds, so alerting on it separately is a duplicate at best.
       * At worst the endpoint is flapping, and then this would be a message
       * every minute about a monitor that is working exactly as designed.
       */
      this.lastPingError = (err as Error).message;
      this.deps.logger.warn({ err }, 'watchdog ping failed');
    }
  }
}
