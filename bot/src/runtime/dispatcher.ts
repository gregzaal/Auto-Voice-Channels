import type { Logger } from '@avc/core';
import { GuildQueue, type Task } from './guildQueue.js';
import type { CircuitBreakerOptions } from './circuitBreaker.js';

export interface DispatcherOptions {
  logger: Logger;
  circuit?: CircuitBreakerOptions;
  /**
   * Called with every error that reaches a per-guild boundary, for telemetry.
   *
   * Passed through to each queue rather than counted here, because the boundary
   * is inside the queue: by the time a rejection surfaces to a caller it has
   * already been handled, and several callers do not look at it at all.
   */
  onTaskFailure?: (err: unknown) => void;
  /**
   * How long one task may hold a guild's queue. See `DEFAULT_TASK_TIMEOUT_MS`.
   *
   * A function when it should follow the `queue.task_timeout_ms` runtime flag
   * without a restart; 0 disables the timeout.
   */
  taskTimeoutMs?: number | (() => number);
  /**
   * Called when a guild's task is abandoned for running too long.
   *
   * Reported from here rather than logged and forgotten inside the queue: an
   * abandoned task is the only evidence of the failure that used to be silent,
   * and it names the guild and the task an operator has to look at.
   */
  onTaskTimeout?: (guildId: string, task: string, ranForMs: number) => void;
}

/**
 * Routes work to per-guild queues: ordered within a guild, parallel across
 * guilds, each guild fault-isolated with its own circuit breaker. This is the
 * concurrency + isolation boundary for the whole bot.
 */
export class GuildDispatcher {
  private readonly queues = new Map<string, GuildQueue>();
  private readonly logger: Logger;
  private readonly circuit: CircuitBreakerOptions | undefined;
  private readonly onTaskFailure: ((err: unknown) => void) | undefined;
  private readonly taskTimeoutMs: number | (() => number) | undefined;
  private readonly onTaskTimeout:
    | ((guildId: string, task: string, ranForMs: number) => void)
    | undefined;

  constructor(options: DispatcherOptions) {
    this.logger = options.logger;
    this.circuit = options.circuit;
    this.onTaskFailure = options.onTaskFailure;
    this.taskTimeoutMs = options.taskTimeoutMs;
    this.onTaskTimeout = options.onTaskTimeout;
  }

  private queueFor(guildId: string): GuildQueue {
    let queue = this.queues.get(guildId);
    if (!queue) {
      queue = new GuildQueue({
        guildId,
        logger: this.logger,
        onIdle: () => this.maybeEvict(guildId),
        ...(this.onTaskFailure ? { onTaskFailure: this.onTaskFailure } : {}),
        ...(this.circuit ? { circuit: this.circuit } : {}),
        ...(this.taskTimeoutMs !== undefined ? { taskTimeoutMs: this.taskTimeoutMs } : {}),
        ...(this.onTaskTimeout
          ? {
              onTaskTimeout: (task: string, ranForMs: number) =>
                this.onTaskTimeout?.(guildId, task, ranForMs),
            }
          : {}),
      });
      this.queues.set(guildId, queue);
    }
    return queue;
  }

  /**
   * Drops an idle queue whose breaker is closed, so the map doesn't grow without
   * bound across every guild the shard ever touches. A tripped breaker is kept —
   * its state (open/half-open) must survive until cooldown.
   */
  private maybeEvict(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (queue && queue.isIdle && queue.circuitState === 'closed') {
      this.queues.delete(guildId);
    }
  }

  /** Enqueues `task` onto `guildId`'s queue and returns its result promise. */
  dispatch<T>(guildId: string, name: string, task: Task<T>): Promise<T> {
    return this.queueFor(guildId).enqueue(name, task);
  }

  /**
   * Snapshot of every active queue, for the diagnostics endpoint.
   *
   * Carries the in-flight task and its age, not just the depth. Depth alone
   * cannot separate a busy guild from a stuck one, which is what made the
   * 2026-09-16 stall un-diagnosable from outside the process: three queues
   * thousands deep, and no way to ask what any of them was waiting on.
   */
  snapshot(): {
    guildId: string;
    depth: number;
    circuitState: string;
    task?: string;
    taskRanForMs?: number;
  }[] {
    return [...this.queues.values()].map((q) => {
      const inFlight = q.inFlightTask;
      return {
        guildId: q.guildId,
        depth: q.depth,
        circuitState: q.circuitState,
        ...(inFlight ? { task: inFlight.name, taskRanForMs: inFlight.ranForMs } : {}),
      };
    });
  }

  /** Number of guilds whose breaker is currently tripped. */
  trippedCount(): number {
    let count = 0;
    for (const q of this.queues.values()) {
      if (q.circuitState !== 'closed') count += 1;
    }
    return count;
  }

  totalDepth(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.depth;
    return total;
  }

  /** Drains every queue (graceful shutdown). */
  async drainAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.drain()));
  }
}
