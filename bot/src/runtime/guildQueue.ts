import type { Logger } from '@avc/core';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuitBreaker.js';

export type Task<T> = () => Promise<T>;

interface QueuedTask {
  readonly name: string;
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export interface GuildQueueOptions {
  guildId: string;
  logger: Logger;
  circuit?: CircuitBreakerOptions;
}

/**
 * A serial, ordered, fault-isolated work queue for a single guild (actor-style).
 *
 * Guarantees:
 * - **Ordering:** tasks run one at a time, FIFO, per guild.
 * - **Fault isolation:** a thrown task error rejects only that task's promise,
 *   is logged with guild context, and never crashes the process or blocks the
 *   next task.
 * - **Circuit-breaking:** repeated failures trip a per-guild breaker; while open,
 *   newly processed tasks fail fast until cooldown.
 */
export class GuildQueue {
  readonly guildId: string;
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker;
  private readonly tasks: QueuedTask[] = [];
  private running = false;
  private inFlight = 0;
  private draining = false;

  constructor(options: GuildQueueOptions) {
    this.guildId = options.guildId;
    this.logger = options.logger.child({ guildId: options.guildId });
    this.breaker = new CircuitBreaker(options.circuit);
  }

  get depth(): number {
    return this.tasks.length + this.inFlight;
  }

  get circuitState() {
    return this.breaker.getState();
  }

  get isIdle(): boolean {
    return this.inFlight === 0 && this.tasks.length === 0;
  }

  /**
   * Enqueues a task and returns a promise for its result. Rejections are
   * isolated to the returned promise.
   */
  enqueue<T>(name: string, run: Task<T>): Promise<T> {
    if (this.draining) {
      return Promise.reject(new Error(`Queue for guild ${this.guildId} is draining`));
    }
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({
        name,
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  /** Stops accepting new work and resolves once the in-flight queue empties. */
  async drain(): Promise<void> {
    this.draining = true;
    while (!this.isIdle) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let task: QueuedTask | undefined;
      while ((task = this.tasks.shift())) {
        await this.runTask(task);
      }
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: QueuedTask): Promise<void> {
    this.inFlight = 1;
    try {
      this.breaker.assertCanProceed();
    } catch (err) {
      this.inFlight = 0;
      this.logger.warn({ task: task.name, err }, 'task rejected by circuit breaker');
      task.reject(err);
      return;
    }

    try {
      const result = await task.run();
      this.breaker.onSuccess();
      // Clear in-flight before settling so awaiters observe an idle queue.
      this.inFlight = 0;
      task.resolve(result);
    } catch (err) {
      this.breaker.onFailure();
      this.inFlight = 0;
      this.logger.error(
        { task: task.name, err, circuit: this.breaker.getState() },
        'task failed (isolated)',
      );
      task.reject(err);
    }
  }
}
