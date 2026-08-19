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

  constructor(options: DispatcherOptions) {
    this.logger = options.logger;
    this.circuit = options.circuit;
    this.onTaskFailure = options.onTaskFailure;
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

  /** Snapshot of every active queue, for the diagnostics endpoint. */
  snapshot(): { guildId: string; depth: number; circuitState: string }[] {
    return [...this.queues.values()].map((q) => ({
      guildId: q.guildId,
      depth: q.depth,
      circuitState: q.circuitState,
    }));
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
