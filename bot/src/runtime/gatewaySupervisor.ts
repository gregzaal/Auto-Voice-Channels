import type { Logger, OpsAuditRepository } from '@avc/core';
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
  /** Identify budget, so a restart cannot be spent when there is none to spare. */
  sessionBudget: () => { used: number; total: number } | undefined;
  /** Append-only record, which is also how the rate limit survives the restart. */
  opsAudit: OpsAuditRepository;
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
 * Five minutes, which is far past anything discord.js recovers from and far
 * short of the 3h37m it cost to find this by hand. `/health` already reports
 * down after two, so an operator watching Fly sees it first either way.
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

export const SELF_RESTART_ACTION = 'instance.self_restart';

export class GatewaySupervisor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private downSince: number | null = null;
  private acted = false;
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
  get stats(): { downForMs: number | null; acted: boolean } {
    return {
      downForMs: this.downSince === null ? null : this.now() - this.downSince,
      acted: this.acted,
    };
  }

  async tick(): Promise<void> {
    if (this.deps.gatewayStatus() !== 'down') {
      this.downSince = null;
      return;
    }

    this.downSince ??= this.now();
    if (this.now() - this.downSince < this.confirmForMs) return;
    // One decision per process. Whatever happens next, evaluating again adds
    // nothing and could post repeatedly.
    if (this.acted) return;

    const refusal = await this.refusalReason();
    if (refusal) {
      this.acted = true;
      this.deps.logger.error({ refusal }, 'gateway is down and a self-restart was declined');
      this.deps.report(
        'gateway.stuck',
        'Gateway is down and this instance did not restart itself',
        { refusal, instanceId: this.deps.instanceId },
      );
      return;
    }

    this.acted = true;
    const downForMs = this.now() - this.downSince;
    this.deps.logger.error({ downForMs }, 'gateway confirmed down, restarting this instance');
    this.deps.report('gateway.self_restart', 'Gateway confirmed down, instance is restarting', {
      downForSeconds: Math.round(downForMs / 1000),
      instanceId: this.deps.instanceId,
    });
    // Recorded BEFORE the exit, or the rate limit it feeds never sees it.
    await this.deps.opsAudit
      .record({
        actor: this.deps.instanceId,
        action: SELF_RESTART_ACTION,
        target: this.deps.instanceId,
        details: { reason: 'gateway.down', downForSeconds: Math.round(downForMs / 1000) },
      })
      .catch((err: unknown) => {
        this.deps.logger.error({ err }, 'could not record the self-restart');
      });

    this.deps.requestRestart('gateway-down');
  }

  /** Why not to restart, or null to go ahead. */
  private async refusalReason(): Promise<string | null> {
    if (!this.deps.leasesProven()) {
      return 'the shard lease cannot be refreshed, which usually means the database is unreachable, and a restart could not apply migrations';
    }

    const budget = this.deps.sessionBudget();
    if (budget && budget.total > 0) {
      const remaining = (budget.total - budget.used) / budget.total;
      if (remaining < MIN_SESSION_HEADROOM) {
        return `only ${Math.round(remaining * 100)}% of the daily identify budget is left`;
      }
    }

    const recent = await this.recentSelfRestart();
    if (recent) return 'this instance already restarted itself within the last hour';

    return null;
  }

  private async recentSelfRestart(): Promise<boolean> {
    try {
      const rows = await this.deps.opsAudit.recent(50);
      const cutoff = this.now() - MIN_RESTART_INTERVAL_MS;
      return rows.some(
        (row) =>
          row.action === SELF_RESTART_ACTION &&
          row.target === this.deps.instanceId &&
          row.createdAt.getTime() > cutoff,
      );
    } catch (err) {
      /**
       * Cannot read the record, so cannot prove this is not a loop.
       *
       * Refusing is the safe direction: the cost of not restarting is an
       * outage a human can still fix, and the cost of looping is a fleet that
       * cannot come back.
       */
      this.deps.logger.warn({ err }, 'could not check for a recent self-restart, declining');
      return true;
    }
  }
}
