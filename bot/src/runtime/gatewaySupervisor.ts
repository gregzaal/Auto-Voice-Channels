import { RUNTIME_FLAGS } from '@avc/core';
import type { Logger, OpsAuditRepository, RuntimeFlagsRepository } from '@avc/core';
import type { SubsystemStatus } from '../ops/health.js';

/**
 * Restarts this instance when its gateway is confirmed dead and nothing else
 * will.
 *
 * **Why this exists.** On 2026-09-01 shard 0 wedged in `Connecting` at 00:50:57
 * UTC and was still there 3 hours 37 minutes later, serving roughly 1,390 guilds
 * nothing. The process was alive, the database was fine, the lease was
 * heartbeated, and discord.js never recovered on its own. Surviving peers do not
 * poach a live lease, by design, so nothing was ever going to take the shard.
 * A human restarted the machine and it was serving 14 seconds later.
 *
 * That is a failure the orchestrator already knows how to handle: a lease loss
 * drains and exits non-zero, and Fly's `on-failure` policy restarts it into a
 * clean re-claim. A dead gateway is the same shape, so it takes the same path.
 *
 * **The guards are the whole design, because an unguarded version is worse than
 * the bug.** If Discord is having an outage, every instance sees a dead gateway
 * at once, and a fleet that restarts itself in a loop burns the daily identify
 * budget and cannot come back when Discord does.
 *
 * **Every guard fails CLOSED, and that is a rule an adversarial review had to
 * teach this file.** Its first version had two guards that failed open (a rate
 * limit that read a page of unrelated rows, and an identify budget skipped
 * whenever it was unknown) and one that failed shut far too hard (a single
 * transient refusal disabled the self-heal for the life of the process, which
 * reintroduced the very outage through the fix). The asymmetry to hold on to:
 * not restarting leaves an outage a human can still fix, and restarting wrongly
 * can take a fleet somewhere a human cannot easily reach.
 */
export interface GatewaySupervisorDeps {
  /** The same derivation `/health` reports, so they cannot disagree. */
  gatewayStatus: () => SubsystemStatus;
  /**
   * Whether this instance can still prove it owns its shards.
   *
   * A false here almost always means the database is unreachable, and a restart
   * then cannot even apply migrations. Standing aside is the right answer to
   * that, not cycling.
   */
  leasesProven: () => boolean;
  /**
   * Identify budget, so a restart cannot be spent when there is none to spare.
   *
   * `observedAt` is required rather than decorative: the reading is a cache fed
   * by a poll that fails during exactly the Discord incident this guard exists
   * for, and a frozen number understates consumption precisely while a fleet is
   * cycling. Unknown and stale are both refusals.
   */
  sessionBudget: () => { used: number; total: number; observedAt: number } | undefined;
  /** Append-only record, which is also how the rate limit survives the restart. */
  opsAudit: OpsAuditRepository;
  /** Read for the no-deploy kill switch. */
  flags: RuntimeFlagsRepository;
  instanceId: string;
  /** Drains and exits non-zero, exactly as a lease loss does. */
  requestRestart: (reason: string) => void;
  report: (kind: string, message: string, context: Record<string, unknown>) => void;
  logger: Logger;
  now?: () => number;
  /** How long the gateway must stay down before this acts. */
  confirmForMs?: number;
  /** How often to evaluate. */
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Five minutes of CONFIRMED down, which is not five minutes of outage.
 *
 * `gatewayStatus` has its own two-minute grace before it reports `down` at all,
 * and the first tick past the threshold can add another 30 seconds, so the real
 * wall-clock from a shard wedging to a restart is about eight minutes. Worth
 * stating plainly rather than leaving as an inference: far past anything
 * discord.js recovers from, far short of the 3h37m it cost to find by hand.
 */
const CONFIRM_FOR_MS = 5 * 60_000;
const INTERVAL_MS = 30_000;

/**
 * A restart every hour at most, per instance.
 *
 * In memory this would reset on every restart, which is precisely the loop being
 * guarded against, so it is read back out of `ops_audit`. That also means the
 * operator gets a durable record of every time a machine cycled itself, which is
 * the first question anyone asks about a self-healing system.
 */
const MIN_RESTART_INTERVAL_MS = 60 * 60_000;

/**
 * Refuse to spend an identify when fewer than this fraction of the daily budget
 * is left.
 *
 * A restart costs one identify per shard. The budget is 1000 a day and a healthy
 * fleet uses single digits, so reaching this at all means something is already
 * cycling, and adding to it is how a recoverable incident becomes a day-long one.
 */
const MIN_SESSION_HEADROOM = 0.2;

/**
 * How old an identify-budget reading may be and still count as an answer.
 *
 * The poll runs every 5 minutes and is seeded before login, so normal operation
 * never approaches this. It is reached when `GET /gateway/bot` has been failing
 * for two hours, which means Discord's API is in trouble, which is the state
 * where restarting is the wrong move anyway.
 */
const MAX_BUDGET_AGE_MS = 2 * 60 * 60_000;

/**
 * How long to wait before saying again that a restart was declined.
 *
 * **A refusal is a statement about one instant, not about the process.** All
 * three reasons are transient by nature: a lease proof recovers on the next good
 * beat, a budget reading recovers on the next poll, and the hourly window
 * expires by definition. Latching a refusal for the life of the process (which
 * the first version did) means a machine that blips, gets refused, runs healthy
 * for three weeks and then wedges sits wedged forever, which is the 2026-09-01
 * outage reached through its own fix.
 *
 * The posting is what needs pacing, not the deciding, so this bounds the
 * admin-channel message while the decision is re-made every tick.
 */
const REFUSAL_REPORT_INTERVAL_MS = 15 * 60_000;

export const SELF_RESTART_ACTION = 'instance.self_restart';

export class GatewaySupervisor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private downSince: number | null = null;
  /** Set only by an actual restart request, so it is one per process. */
  private restarted = false;
  /** Paces the refusal message. Never gates the decision. */
  private refusalReportedAt: number | null = null;
  /** Stops a slow tick overlapping the next interval. */
  private ticking = false;
  private lastRefusal: string | null = null;
  private readonly now: () => number;
  private readonly confirmForMs: number;
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;

  constructor(private readonly deps: GatewaySupervisorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.confirmForMs = deps.confirmForMs ?? CONFIRM_FOR_MS;
    this.intervalMs = deps.intervalMs ?? INTERVAL_MS;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      void this.tick().catch((err: unknown) => {
        // Never let the supervisor's own failure take the process with it: a
        // broken watchdog must be inert, not fatal.
        this.deps.logger.warn({ err }, 'gateway supervisor tick failed');
      });
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }

  /** Exposed for `/diagnostics`, so the guard state is visible before it fires. */
  get stats(): {
    downForMs: number | null;
    restarted: boolean;
    lastRefusal: string | null;
    confirmForMs: number;
  } {
    return {
      downForMs: this.downSince === null ? null : this.now() - this.downSince,
      restarted: this.restarted,
      lastRefusal: this.lastRefusal,
      confirmForMs: this.confirmForMs,
    };
  }

  async tick(): Promise<void> {
    /**
     * An overlapping tick is not merely wasteful here: two passes either side of
     * the same await both read "no recent restart", both post, and both write an
     * audit row. `MetricsCollector.tick` guards the same way.
     */
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.evaluate();
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(): Promise<void> {
    if (this.deps.gatewayStatus() !== 'down') {
      this.downSince = null;
      // A recovered gateway ends the episode, so the next one may speak up
      // rather than inheriting this one's suppression.
      this.refusalReportedAt = null;
      this.lastRefusal = null;
      return;
    }

    this.downSince ??= this.now();
    if (this.now() - this.downSince < this.confirmForMs) return;
    // A restart has been requested, so the process is on its way out. Anything
    // further is noise at best and a second audit row at worst.
    if (this.restarted) return;

    const refusal = await this.refusalReason();
    if (refusal) {
      this.lastRefusal = refusal;
      this.deps.logger.error({ refusal }, 'gateway is down and a self-restart was declined');
      this.reportRefusal(refusal);
      return;
    }

    const downForMs = this.now() - this.downSince;
    /**
     * Recorded BEFORE the exit, or the rate limit it feeds never sees it, and
     * AWAITED so that a failure refuses the restart.
     *
     * The whole integrity of the hourly limit rests on this row landing. Logging
     * the failure and carrying on (which the first version did) leaves the next
     * boot's guard blind, and a blind durable guard plus a per-process one is one
     * restart per boot with nothing recording any of them.
     */
    try {
      await this.deps.opsAudit.record({
        actor: this.deps.instanceId,
        action: SELF_RESTART_ACTION,
        target: this.deps.instanceId,
        details: { reason: 'gateway.down', downForSeconds: Math.round(downForMs / 1000) },
      });
    } catch (err) {
      const refused = 'the self-restart could not be recorded, so the hourly limit would be blind';
      this.lastRefusal = refused;
      this.deps.logger.error({ err }, 'could not record the self-restart, declining');
      this.reportRefusal(refused);
      return;
    }

    this.restarted = true;
    this.deps.logger.error({ downForMs }, 'gateway confirmed down, restarting this instance');
    this.deps.report('gateway.self_restart', 'Gateway confirmed down, instance is restarting', {
      downForSeconds: Math.round(downForMs / 1000),
      instanceId: this.deps.instanceId,
    });
    this.deps.requestRestart('gateway-down');
  }

  private reportRefusal(refusal: string): void {
    const last = this.refusalReportedAt;
    if (last !== null && this.now() - last < REFUSAL_REPORT_INTERVAL_MS) return;
    this.refusalReportedAt = this.now();
    this.deps.report('gateway.stuck', 'Gateway is down and this instance did not restart itself', {
      refusal,
      instanceId: this.deps.instanceId,
    });
  }

  /** Why not to restart, or null to go ahead. */
  private async refusalReason(): Promise<string | null> {
    const disabled = await this.deps.flags
      .getBool(RUNTIME_FLAGS.GATEWAY_SELF_RESTART_DISABLED)
      .catch((err: unknown) => {
        // Cannot read the switch, so cannot know whether a human has forbidden
        // this. Same direction as every other guard here.
        this.deps.logger.warn({ err }, 'could not read the self-restart kill switch, declining');
        return true;
      });
    if (disabled === true) return 'gateway.self_restart_disabled is set on this fleet';

    if (!this.deps.leasesProven()) {
      return 'the shard lease cannot be refreshed, which usually means the database is unreachable, and a restart could not apply migrations';
    }

    const budget = this.deps.sessionBudget();
    if (!budget || budget.total <= 0) {
      /**
       * Unknown is a refusal, not a skip.
       *
       * The reading is seeded before login and refreshed every five minutes, so
       * an absent one means the gateway API could not be reached at boot and has
       * not been reachable since, which is the Discord-side outage in which a
       * restarting fleet cannot come back.
       */
      return 'the identify budget is unknown, so a restart cannot be shown to be affordable';
    }
    const ageMs = this.now() - budget.observedAt;
    if (ageMs > MAX_BUDGET_AGE_MS) {
      return `the identify budget reading is ${Math.round(ageMs / 60_000)} minutes old, so the gateway API has been unreachable`;
    }
    const remaining = (budget.total - budget.used) / budget.total;
    if (remaining < MIN_SESSION_HEADROOM) {
      return `only ${Math.round(remaining * 100)}% of the daily identify budget is left`;
    }

    if (await this.recentSelfRestart()) {
      return 'this instance already restarted itself within the last hour';
    }

    return null;
  }

  private async recentSelfRestart(): Promise<boolean> {
    try {
      /**
       * A targeted read, not a page of the newest rows filtered in JS.
       *
       * `recent(50)` shares those slots with every other writer of `ops_audit`
       * (both bot fleets and the web app, and `transitionAuth` writes one row per
       * guild it moves), so a busy hour pushed the restart record off the page
       * and the only durable brake on a restart loop silently vanished.
       */
      return await this.deps.opsAudit.hasActionSince(
        SELF_RESTART_ACTION,
        this.deps.instanceId,
        new Date(this.now() - MIN_RESTART_INTERVAL_MS),
      );
    } catch (err) {
      /**
       * Cannot read the record, so cannot prove this is not a loop.
       *
       * Refusing is the safe direction: the cost of not restarting is an outage
       * a human can still fix, and the cost of looping is a fleet that cannot
       * come back.
       */
      this.deps.logger.warn({ err }, 'could not check for a recent self-restart, declining');
      return true;
    }
  }
}
