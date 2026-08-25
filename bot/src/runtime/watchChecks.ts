import { Status, type Client } from 'discord.js';
import type { SubsystemStatus } from '../ops/health.js';
import {
  permissionProblemSummary,
  type PermissionProblemSummary,
} from '../features/voice/permissionProblems.js';
import type { WatchCheck, WatchProblem } from './alertScheduler.js';

/**
 * The conditions the in-process watcher evaluates
 * (`plans/agentic_management.md` step 4).
 *
 * Built here rather than inline in `index.ts` so each one is a small pure-ish
 * function over injected readers, and so the list of things we actually watch
 * is readable in one place.
 *
 * **Everything here is invisible to `/api/watch` by construction.** These read
 * in-process state -- gateway status, dispatcher queues, breaker states -- none
 * of which reaches a table. That is the whole reason this half exists, and it
 * is also the rule for adding to this list: if Postgres already knows it, put
 * it in `/api/watch`, where it keeps working when this process does not.
 */

export interface WatchCheckDeps {
  client: Client;
  /** Live queue and breaker state, per guild. */
  snapshot: () => { guildId: string; depth: number; circuitState: string }[];
  /** The `/health` view of the database, refreshed by the 15s ping. */
  dbStatus: () => SubsystemStatus;
  /** Lease heartbeat health, from `ShardLeaseManager`. */
  heartbeat: () => { lastOkAt: number | null; consecutiveFailures: number };
  selfHosted: boolean;
  /** Guilds with a live permission incident. Self-host only, see below. */
  permissionProblems?: (sinceMs: number) => PermissionProblemSummary[];
  /** Injectable clock, for the trip hold-down and the heartbeat age test. */
  now?: () => number;
}

/**
 * Consecutive lease heartbeat failures before this is worth waking someone.
 *
 * The heartbeat runs every 10s against a 30s TTL, so two failures means 20s
 * since the row was last touched and one more failure loses the lease to a
 * booting peer. Alerting at two is the last moment the warning is still ahead
 * of the event rather than a description of it.
 */
const HEARTBEAT_FAILURE_THRESHOLD = 2;

/**
 * How long since the last SUCCESSFUL beat before the heartbeat is presumed hung.
 *
 * Three and a half intervals, against a 30s lease TTL. A beat that never
 * settles is invisible to the failure counter, so this is the only test that
 * catches it.
 */
const HEARTBEAT_STALE_MS = 35_000;

/**
 * Per-guild queue depth that means work is not draining.
 *
 * Generous on purpose. A reconcile-on-READY legitimately enqueues a burst, and
 * this fires only after it has stayed high for three consecutive minutes, so a
 * busy guild catching up never trips it.
 */
const QUEUE_DEPTH_THRESHOLD = 100;

/**
 * How long a guild stays reported as tripped after its breaker was last
 * actually seen `open`.
 *
 * A hold-down rather than a straight state read, because the breaker's state is
 * a poor polling target and reading it naively is wrong in both directions.
 *
 * `CircuitBreaker.peekState()` returns `half-open` for as long as the cooldown
 * has elapsed, and only a dispatched task ever promotes or closes it, while
 * `GuildDispatcher.maybeEvict` refuses to drop a queue whose breaker is not
 * closed. So a guild that trips once at 02:00 and then goes quiet reports
 * `half-open` **forever**. Alerting on "not closed" would open a row that can
 * never resolve, whose `last_seen_at` is re-stamped every tick so it never ages
 * out either, on a fleet where tripped breakers are common. One permanent alert
 * per guild that ever had a bad night.
 *
 * Alerting on `open` alone has the opposite problem: a guild that is genuinely
 * broken oscillates open, half-open, open as each trial fails, so a 60s poll
 * samples it either way and the alert flaps.
 *
 * Holding a sighting of `open` for five minutes fixes both. It cannot latch,
 * because nothing re-arms it once the guild stops tripping, and it cannot flap,
 * because the hold outlasts the 30s cooldown cycle.
 */
const TRIP_HOLD_MS = 5 * 60_000;

/**
 * How recently a permission incident must have been seen to count as live.
 *
 * Six hours, the same window the guild-facing notifier's first backoff step
 * uses. Deliberately reusing that number rather than inventing a second one:
 * two different definitions of "still broken" in one codebase is how the panel
 * and the alert end up disagreeing about the same guild.
 */
const PERMISSION_FRESH_MS = 6 * 3_600_000;

export function buildWatchChecks(deps: WatchCheckDeps): WatchCheck[] {
  const now = deps.now ?? Date.now;
  /** Guilds seen `open` recently, and when. Bounded by {@link TRIP_HOLD_MS}. */
  const trippedAt = new Map<string, { at: number; depth: number }>();
  /**
   * Whether the gateway has ever finished connecting in this process.
   *
   * `AlertScheduler.start()` fires its first tick immediately after
   * `client.login`, and on a fleet of 1004 guilds READY lands tens of seconds
   * later. Without this, the boot itself is an observation of "gateway not
   * connected", and two in a row posts a critical and withholds the watchdog
   * ping on a routine deploy.
   */
  let hasBeenReady = false;

  const checks: WatchCheck[] = [
    {
      /**
       * A DIFFERENT key from the 15s health ping's `db.ping`, and the
       * separation is not cosmetic.
       *
       * Sharing one key looked tidy and was broken three ways. Both writers hit
       * the same partial unique index, so there is one row: the timer's raise
       * overwrote `details` without an `instance` stamp, which made the row
       * permanently unresolvable by this check; it overwrote `severity` back to
       * `warn` fifteen seconds after every escalation, so the column
       * `/api/watch` filters on flickered on a 15s cycle; and the two
       * observations were genuinely different claims sharing one message.
       *
       * They are different claims: `db.ping` means one query failed just now,
       * `db.unreachable` means the condition was still true a minute later.
       */
      key: 'db.unreachable',
      severity: 'critical',
      audience: 'both',
      confirmations: 2,
      run: () => {
        // `unknown` is not `down`. At boot, and after a reader throws, we have
        // no evidence either way, and guessing "broken" would page on startup.
        if (deps.dbStatus() !== 'down') return [];
        return [{ message: 'Database is unreachable from this instance' }];
      },
    },
    {
      /**
       * Read from the gateway rather than from the latched `gatewayStatus` the
       * health server keeps, which goes `down` on any `client.error` and is
       * only ever cleared by a fresh READY.
       *
       * **`client.ws.status` is latched too**, and the per-shard loop is what
       * makes this correct rather than the manager's aggregate: discord.js
       * writes `ws.status` exactly twice, `Idle` at construction and `Ready` in
       * `checkShardsReady`, and never resets it on a disconnect. A stuck-true
       * `isReady()` therefore always falls through to the shard loop, which
       * does track `Disconnected` and `Resuming`. Do not simplify this to trust
       * `ws.status`.
       */
      key: 'gateway.down',
      severity: 'critical',
      audience: 'both',
      confirmations: 2,
      run: () => {
        if (deps.client.readyAt !== null) hasBeenReady = true;
        // Not connected YET is not the same as disconnected, and only one of
        // the two is worth waking someone for.
        if (!hasBeenReady) return [];
        if (!deps.client.isReady()) {
          return [
            {
              message: 'Gateway is not connected',
              details: { status: Status[deps.client.ws.status] ?? deps.client.ws.status },
            },
          ];
        }
        return [...deps.client.ws.shards.entries()]
          .filter(([, shard]) => shard.status !== Status.Ready)
          .map(([shardId, shard]) => ({
            target: String(shardId),
            message: `Shard ${shardId} is not ready`,
            details: { status: Status[shard.status] ?? shard.status },
          }));
      },
    },
    {
      /**
       * Names the guild, which is the gap the plan's own table calls out: a
       * tripped breaker was previously a number on `/diagnostics` and an alert
       * that "probably fires but cannot say where".
       *
       * `warn`, so it never suppresses the watchdog ping. One guild in trouble
       * is exactly the case per-guild isolation exists to contain, and
       * declaring the whole instance dead over it would invert that.
       *
       * See {@link TRIP_HOLD_MS} for why this watches for sightings of `open`
       * rather than reading the current state.
       */
      key: 'circuit.tripped',
      severity: 'warn',
      audience: 'both',
      run: () => {
        const at = now();
        for (const q of deps.snapshot()) {
          if (q.circuitState === 'open') trippedAt.set(q.guildId, { at, depth: q.depth });
        }
        const problems: WatchProblem[] = [];
        for (const [guildId, seen] of trippedAt) {
          if (at - seen.at > TRIP_HOLD_MS) {
            // Deleted, not kept: this map must stay bounded by guilds that
            // tripped recently, never by guilds that ever tripped.
            trippedAt.delete(guildId);
            continue;
          }
          problems.push({
            target: guildId,
            message: `Circuit breaker tripped for guild ${guildId}`,
            details: { depth: seen.depth, lastTrippedAt: new Date(seen.at).toISOString() },
          });
        }
        return problems;
      },
    },
    {
      key: 'queue.backlog',
      severity: 'warn',
      audience: 'both',
      confirmations: 3,
      run: () =>
        deps
          .snapshot()
          .filter((q) => q.depth >= QUEUE_DEPTH_THRESHOLD)
          .map((q) => ({
            target: q.guildId,
            message: `Guild ${q.guildId} has ${q.depth} tasks queued and not draining`,
            details: { depth: q.depth, circuitState: q.circuitState },
          })),
    },
  ];

  /**
   * The self-host half of step 4's "done when", and registered ONLY there.
   *
   * This closes a real blind spot rather than duplicating an existing check. A
   * permission-caused create failure is caught and returned, not rethrown, so it
   * is a queue SUCCESS: it never reaches the `errors` counter and never advances
   * the circuit breaker, which means `circuit.tripped` cannot see it and no
   * amount of tuning would make it. The tracker is the only thing that knows.
   *
   * **Not registered on the hosted fleet, and that is a deliberate audience
   * call, not an oversight.** A thousand customers' own misconfigured servers
   * are not an operator incident: they are already told directly by
   * `PermissionProblemNotifier`, and the operator already gets
   * `reportIfFleetwide` when enough of them break at once to mean the problem
   * is ours. On a self-host the operator and the guild admin are the same
   * person, so that separation collapses and the alert is exactly right.
   *
   * Gated by registration rather than by `audience`, because `audience` is a
   * label on the row and does not gate the Discord post.
   */
  if (deps.selfHosted && deps.permissionProblems) {
    const read = deps.permissionProblems;
    checks.push({
      key: 'permissions.blocked',
      // Never critical: a confirmed critical withholds the watchdog ping
      // fleet-wide, so one misconfigured server would read as "the bot is down".
      severity: 'warn',
      audience: 'self_host',
      confirmations: 2,
      run: () =>
        read(PERMISSION_FRESH_MS).map((g) => ({
          target: g.guildId,
          // The same renderer the /setup panel and the guild notice use, so the
          // three cannot disagree about what the fix is. It returns one line
          // per distinct failure mode; joined here because an alert message is
          // a single string and the operator wants all of them.
          message: permissionProblemSummary(g.problems).join(' '),
          details: {
            channels: g.problems.length,
            lastAt: new Date(g.lastAt).toISOString(),
            operations: [...new Set(g.problems.map((p) => p.operation))].join(', '),
          },
        })),
    });
  }

  /**
   * Lease health is meaningless to a self-hoster: one instance, one claim, and
   * nothing to lose a shard to. Adding it there would be a permanently
   * irrelevant alert in the only channel they have.
   */
  if (!deps.selfHosted) {
    checks.push({
      key: 'shard.heartbeat',
      severity: 'critical',
      audience: 'hosted',
      /**
       * Two ticks, because two failed beats is a 20s transient. The 30s TTL is
       * already gone by the time a 60s watcher sees anything, so confirming
       * costs nothing you still had, and without it a blip costs a critical, a
       * withheld watchdog ping and a recovery message.
       */
      confirmations: 2,
      run: () => {
        const { lastOkAt, consecutiveFailures } = deps.heartbeat();
        /**
         * Two different failures, and only one of them throws.
         *
         * `consecutiveFailures` counts beats that REJECTED. A beat that never
         * settles at all (pool exhaustion, or a socket the network
         * blackholed) increments nothing, so the counter sits at zero while
         * the lease quietly expires. Age is the only thing that sees that.
         */
        const staleMs = lastOkAt === null ? 0 : now() - lastOkAt;
        const hung = staleMs > HEARTBEAT_STALE_MS;
        if (consecutiveFailures < HEARTBEAT_FAILURE_THRESHOLD && !hung) return [];
        return [
          {
            message: hung
              ? `Shard lease heartbeat has not completed for ${Math.round(staleMs / 1000)}s`
              : `Shard lease heartbeat has failed ${consecutiveFailures} times in a row`,
            details: {
              consecutiveFailures,
              lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
              hung,
            },
          },
        ];
      },
    });
  }

  return checks;
}
