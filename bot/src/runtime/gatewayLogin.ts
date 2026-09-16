import type { Logger } from '@avc/core';

/**
 * Connects the gateway without letting it hold boot hostage.
 *
 * **Why this exists.** `client.login()` does not resolve until every shard
 * reaches ready, and boot used to `await` it directly. Two different Discord
 * failures on 2026-09-15 turned that single await into an outage each:
 *
 * - On `beta` the promise never settled at all. A shard wedged on its first
 *   connect, the websocket layer reconnected on its own afterwards, and the
 *   gateway was genuinely healthy -- but `login()` stayed pending forever, so
 *   the drain handler, the metrics collector, the backup scheduler and the
 *   watchdog ping were never started. The bot worked and was invisible: no
 *   heartbeat for seventeen hours, and a machine that could not drain cleanly.
 * - On `prod` the promise rejected. `main()` rejected with it, the process
 *   exited 1, and Fly restarted it ten times in two minutes -- the whole
 *   `max_retries` budget spent inside the outage window. The machine then sat
 *   stopped for seventeen hours, long after Discord recovered, because nothing
 *   retries once that budget is gone. A quarter of the fleet served nobody.
 *
 * Both are the same design error: an unbounded, unretried dependency on an
 * upstream that is allowed to be down. The fix is to make boot independent of
 * it. Connecting is supervised here instead -- retried in-process forever, with
 * boot continuing either way -- because a live process that keeps trying is
 * strictly better than a dead machine with a spent restart budget.
 *
 * **Nothing later in boot needs a connected gateway.** The schedulers read
 * Postgres (the top.gg publisher counts presence rows and refuses a zero, the
 * metrics gauges are computed in SQL), and the ones that do touch Discord are
 * event-driven. A gateway that never connects is then reported by the paths
 * built for it: `gatewayHealth` turns `/health` red past its boot deadline, the
 * `gateway.down` watch condition withholds the watchdog ping, and
 * `GatewaySupervisor` restarts the machine once it is confirmed dead -- all of
 * which need the boot this used to block to have finished.
 *
 * **"Retries forever" is bounded by that supervisor, deliberately.** A process
 * that never reaches ready is restarted about fifteen minutes in (a ten-minute
 * boot deadline plus a five-minute confirmation), and at most once an hour
 * after that, which still spends Fly's restart budget -- an hour per attempt
 * instead of ten attempts in two minutes. The point of retrying here is that
 * the common case never gets that far: Discord comes back, an attempt lands,
 * and no restart is spent at all.
 */

export interface GatewayLoginDeps {
  /** `() => client.login(token)`. Called afresh for each attempt. */
  login: () => Promise<unknown>;
  logger: Logger;
  /** Admin-channel reporter. Called once per episode, not once per attempt. */
  report: (kind: string, message: string, context: Record<string, unknown>) => void;
  /**
   * Whether the client is connected and not torn down (`client.isReady()`).
   *
   * The precondition for "do not log in again": once the websocket layer owns a
   * live connection, re-entering `login()` tears every shard down and
   * re-identifies them. Checked before each attempt rather than trusted once,
   * so any path that reconnects underneath this loop ends it.
   *
   * Latched-ready is the right reading rather than currently-ready: a later
   * disconnect is the websocket layer's own reconnect and a condition for
   * `gateway.down`, never a reason to log in again.
   */
  hasConnected?: () => boolean;
  /**
   * Run immediately before each attempt, to undo discord.js's teardown.
   *
   * **`Client.login()` destroys the client when it rejects** (`await
   * this.destroy(); throw error;`), and `WebSocketManager.destroyed` is set
   * there and reset only in the constructor. `Client.isReady()` is
   * `!ws.destroyed && ws.status === Status.Ready`, so without this a single
   * rejected login leaves `isReady()` false for the life of the process even
   * after a retry reconnects and the bot is genuinely serving.
   *
   * That was unreachable while a rejected login exited the process. Making boot
   * survive one is what exposes it, and every consequence lands on the paths
   * this change exists to protect: `gateway.down` would raise a critical that
   * can never resolve (so the watchdog ping is withheld and the admin channel
   * nagged forever, while `/health` stays green), `guildCreate` would no-op so
   * new guilds are never reconciled, and the drain's `client.destroy()` would
   * early-return at the websocket layer and release shard leases while this
   * process still holds live sessions.
   *
   * Clearing the flag is narrow and exact: those three readers are its only
   * uses in discord.js, and "this manager was destroyed, do not reconnect" is
   * precisely the statement being retracted. What it cannot undo is
   * `Sweepers.destroy()` and the REST hash/handler sweepers, which stay
   * stopped; with `MessageManager`/`ReactionManager`/`UserManager`/
   * `ThreadManager` caches capped at 0 that costs a slowly growing REST bucket
   * cache, which is a far better outcome than a dead machine.
   */
  beforeAttempt?: () => void;
  /** How long boot waits for the first connect before continuing without it. */
  bootWaitMs?: number;
  /** First retry delay. Doubles up to {@link MAX_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /**
   * Ends the retry loop, for the drain.
   *
   * Without it a retry can fire in the middle of a shutdown: `client.destroy()`
   * has run and the leases are being released, and `login()` would spawn and
   * identify every shard again on a client with no listeners left attached.
   */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * What boot learned before it stopped waiting.
 *
 * - `connected`: login resolved, every shard is ready, the normal case.
 * - `pending`: still connecting after {@link BOOT_WAIT_MS}. Boot goes on; the
 *   attempt is still running and may well succeed a second later.
 * - `retrying`: login rejected. Boot goes on; retries continue in background.
 */
export type GatewayLoginOutcome = 'connected' | 'pending' | 'retrying';

/**
 * How long boot waits for the first connect.
 *
 * A fleet-wide cold start is measured at 50-100 seconds fully dark, so three
 * minutes is well past a healthy boot and well inside both the gateway health
 * boot deadline (10 minutes) and the supervisor's confirmation window. The cost
 * of waiting too long is the failure this file exists to prevent; the cost of
 * not waiting long enough is a few schedulers starting while shards are still
 * identifying, which is harmless.
 */
export const BOOT_WAIT_MS = 3 * 60_000;

const RETRY_DELAY_MS = 5_000;
/**
 * Retry ceiling, and it is sized by the IDENTIFY budget rather than by latency.
 *
 * An attempt is not free. `client.login()` reaches `@discordjs/ws`'s
 * `connect()`, which calls `updateShardCount()` -- destroy, respawn, and
 * identify EVERY shard this instance holds. So a four-shard instance retrying
 * every minute would spend 240 identifies an hour against a daily budget of
 * 1000, and `GatewaySupervisor` refuses to self-heal below 20% headroom: the
 * loop would exhaust the budget that the recovery needs.
 *
 * Five minutes keeps a multi-hour outage inside a few dozen identifies and
 * still reconnects well inside the supervisor's own confirmation window, so
 * nothing waits on it that was not already waiting. `@discordjs/ws` refuses
 * outright when `session_start_limit.remaining` is below the shard count, which
 * is a floor under this rather than a substitute for it.
 */
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/**
 * Login failures that retrying cannot fix.
 *
 * A bad token must stay fatal. Retrying it forever would turn a config mistake
 * into a machine that looks alive, never serves anything and never says why,
 * which is the same invisible-failure shape this file exists to remove, just
 * with a different cause. Anything not matched here is treated as transient,
 * which is the safe direction: the cost of retrying a permanent failure is a
 * log line a minute, the cost of exiting on a transient one is a spent restart
 * budget.
 */
function isFatal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return message.includes('invalid token') || message.includes('disallowed intent');
}

/**
 * Starts (and keeps trying) the gateway connection.
 *
 * Resolves as soon as the first attempt settles, or after `bootWaitMs`,
 * whichever comes first -- so boot continues in bounded time no matter what
 * Discord is doing. Rejects only for {@link isFatal} failures, which boot
 * treats exactly as it always did: log and exit for the orchestrator.
 */
export function connectGateway(deps: GatewayLoginDeps): Promise<GatewayLoginOutcome> {
  const bootWaitMs = deps.bootWaitMs ?? BOOT_WAIT_MS;
  const maxRetryDelayMs = deps.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const signal = deps.signal;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  let delay = deps.retryDelayMs ?? RETRY_DELAY_MS;

  let settle: (outcome: GatewayLoginOutcome) => void = () => {};
  let fail: (err: unknown) => void = () => {};
  const bootGate = new Promise<GatewayLoginOutcome>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const timer = setTimeoutFn(() => {
    deps.logger.error(
      { waitedMs: bootWaitMs },
      'gateway has not finished connecting; continuing boot without it',
    );
    /**
     * Reported, because this is the state that hid for seventeen hours. A boot
     * that continues is healthy for everything except the gateway, so nothing
     * else about the process looks wrong -- the message is the only thing that
     * distinguishes it from a normal start until `gateway.down` confirms.
     */
    deps.report(
      'gateway.boot_slow',
      'Gateway did not finish connecting within the boot window; starting the rest of the bot anyway',
      { waitedMs: bootWaitMs },
    );
    settle('pending');
  }, bootWaitMs);
  (timer as { unref?: () => void }).unref?.();

  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      if (deps.hasConnected?.()) {
        clearTimeoutFn(timer);
        settle('connected');
        return;
      }
      if (signal?.aborted) return;
      try {
        // Before the readiness check would see it, never after: see the dep.
        deps.beforeAttempt?.();
        await deps.login();
        clearTimeoutFn(timer);
        if (attempt > 1) {
          deps.logger.info({ attempt }, 'gateway connected after retrying');
          deps.report('gateway.connected', 'Gateway connected after retrying', { attempt });
        }
        settle('connected');
        return;
      } catch (err) {
        if (isFatal(err)) {
          clearTimeoutFn(timer);
          /**
           * Said out loud before it stops, because `fail` is usually a no-op:
           * the boot gate has already settled by the time a later attempt turns
           * fatal (a rotated token, an intent switched off mid-outage), so
           * rejecting reaches nobody. Without this the retry loop would go
           * silent and the only remaining signal would be `gateway.down` ten
           * minutes later, saying nothing about the cause.
           */
          deps.logger.error({ err, attempt }, 'gateway login failed fatally; not retrying');
          deps.report(
            'gateway.login_fatal',
            'Gateway login was refused for a reason retrying cannot fix; the gateway will stay down',
            { error: err instanceof Error ? err.message : String(err), attempt },
          );
          fail(err);
          return;
        }
        deps.logger.error({ err, attempt, retryInMs: delay }, 'gateway login failed; retrying');
        /**
         * Reported once, on the first failure, and never again by this loop.
         * The condition it starts is owned from here on by `gateway.down`,
         * which is evaluated on a schedule, withholds the watchdog ping and
         * resolves itself -- all of which a retry counter posting every minute
         * would only drown out.
         */
        if (attempt === 1) {
          deps.report('gateway.login_failed', 'Gateway login failed; retrying in the background', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        /**
         * Boot stops waiting on the first hard failure: the answer ("Discord is
         * not available right now") will not improve by holding the rest of the
         * process hostage to it.
         *
         * The boot window is cancelled with it. Left armed it would fire three
         * minutes later and report a slow boot about a boot that already
         * continued, which is a false statement in the admin channel during an
         * incident that is already reported.
         */
        clearTimeoutFn(timer);
        settle('retrying');
        await sleep(delay);
        delay = Math.min(delay * 2, maxRetryDelayMs);
        if (signal?.aborted) return;
      }
    }
  })();

  return bootGate;
}
