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
  /** Called when the queue goes idle (drained empty), so the owner can evict it. */
  onIdle?: () => void;
  /**
   * Called with any error that reached this per-guild boundary, for telemetry.
   *
   * The boundary is the only place that sees every isolated failure, which makes
   * it the only honest place to count them. Must not throw: it is invoked from
   * the failure path, and an error there would replace a contained fault with an
   * uncontained one.
   */
  onTaskFailure?: (err: unknown) => void;
  /**
   * How long one task may run before the queue gives up waiting for it.
   *
   * See {@link DEFAULT_TASK_TIMEOUT_MS}. Injectable so tests need not wait.
   */
  taskTimeoutMs?: number;
  /**
   * Called when a task is abandoned for running too long, with enough to act on:
   * the guild is in {@link GuildQueue.guildId}, the task name and its age are
   * the only evidence of what was stuck.
   */
  onTaskTimeout?: (task: string, ranForMs: number) => void;
  /** Injectable clock, so the age in a snapshot is testable. */
  now?: () => number;
}

/**
 * How long one task may hold the queue before it is abandoned.
 *
 * **A queue with no timeout is a queue one bad task can kill forever**, and on
 * 2026-09-16 three guilds proved it: a head task stopped settling and every
 * later task for that guild piled up behind it, 1,081 deep on one of them,
 * for hours, with no error, no log line and no recovery short of a restart.
 * Per-guild isolation is the point of this class, and an unbounded await is a
 * hole straight through it.
 *
 * Five minutes is far past any real task. The work this queue runs is a
 * reconcile, a voice-state handler or a rename, all of which are seconds; the
 * one operation that can legitimately take minutes (a rate-limited channel
 * rename) already refuses to block, returning `rateLimited` and converging in
 * the background rather than holding the queue.
 *
 * **Abandoning is not cancelling.** The underlying work keeps running and may
 * still complete, so a timeout trades the ordering guarantee for liveness on
 * exactly the tasks that have already broken it. That is the right trade at
 * five minutes and the wrong one at five seconds, which is why this is generous
 * and why it reports rather than passing quietly.
 */
export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;

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
  private readonly onIdle: (() => void) | undefined;
  private readonly onTaskFailure: ((err: unknown) => void) | undefined;
  private running = false;
  private inFlight = 0;
  private draining = false;
  /** What is running right now, and since when. Null while idle. */
  private current: { name: string; startedAt: number } | null = null;
  private readonly taskTimeoutMs: number;
  private readonly onTaskTimeout: ((task: string, ranForMs: number) => void) | undefined;
  private readonly now: () => number;

  constructor(options: GuildQueueOptions) {
    this.guildId = options.guildId;
    this.logger = options.logger.child({ guildId: options.guildId });
    this.breaker = new CircuitBreaker(options.circuit);
    this.onIdle = options.onIdle;
    this.onTaskFailure = options.onTaskFailure;
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.onTaskTimeout = options.onTaskTimeout;
    this.now = options.now ?? Date.now;
  }

  /**
   * The task holding the queue, and how long it has held it.
   *
   * Exposed because depth alone cannot tell a busy guild from a stuck one: both
   * read as a large number, and only one of them is an incident. The 2026-09-16
   * stall was diagnosable from outside the process only down to "some task",
   * because this was in memory and nowhere else.
   */
  get inFlightTask(): { name: string; ranForMs: number } | null {
    if (!this.current) return null;
    return { name: this.current.name, ranForMs: this.now() - this.current.startedAt };
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
      // Drained empty: let the owner evict this queue so the per-guild map doesn't
      // grow without bound across every guild ever seen.
      if (this.isIdle) this.onIdle?.();
    }
  }

  private async runTask(task: QueuedTask): Promise<void> {
    this.inFlight = 1;
    try {
      this.breaker.assertCanProceed();
    } catch (err) {
      this.inFlight = 0;
      this.logger.warn({ task: task.name, err }, 'task rejected by circuit breaker');
      this.reportFailure(err);
      task.reject(err);
      return;
    }

    const startedAt = this.now();
    this.current = { name: task.name, startedAt };
    /**
     * Raced, never awaited bare.
     *
     * `await task.run()` is the whole 2026-09-16 outage in one line: a task that
     * never settles parks this loop, and every later task for the guild waits
     * behind it until the process restarts. The timer is unref'd so a pending
     * race can never be the reason the process stays alive.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('task-timeout');
    const expiry = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), this.taskTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      const result = await Promise.race([task.run(), expiry]);
      if (result === timedOut) {
        const ranForMs = this.now() - startedAt;
        /**
         * Counted as a failure, so a guild whose tasks all hang trips its own
         * breaker rather than timing out once per task forever. The abandoned
         * work may still be running; nothing here can cancel it, which is
         * exactly why this is loud.
         */
        this.breaker.onFailure();
        this.inFlight = 0;
        this.current = null;
        const err = new Error(
          `Task ${task.name} exceeded ${this.taskTimeoutMs}ms and was abandoned`,
        );
        this.logger.error(
          { task: task.name, ranForMs, circuit: this.breaker.getState() },
          'task abandoned after timeout, queue continuing',
        );
        this.reportTimeout(task.name, ranForMs);
        this.reportFailure(err);
        task.reject(err);
        return;
      }
      this.breaker.onSuccess();
      // Clear in-flight before settling so awaiters observe an idle queue.
      this.inFlight = 0;
      this.current = null;
      task.resolve(result);
    } catch (err) {
      this.breaker.onFailure();
      this.inFlight = 0;
      this.current = null;
      this.logger.error(
        { task: task.name, err, circuit: this.breaker.getState() },
        'task failed (isolated)',
      );
      this.reportFailure(err);
      task.reject(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Hands a timeout to its hook, guarded exactly as {@link reportFailure} is. */
  private reportTimeout(task: string, ranForMs: number): void {
    try {
      this.onTaskTimeout?.(task, ranForMs);
    } catch (hookErr) {
      this.logger.debug({ err: hookErr }, 'task-timeout hook threw');
    }
  }

  /**
   * Hands a contained failure to the telemetry hook, guarded.
   *
   * Guarded because this runs inside the fault-isolation boundary: a throw from a
   * metrics counter here would escape the very catch that exists to keep one
   * guild's problem inside that guild.
   */
  private reportFailure(err: unknown): void {
    try {
      this.onTaskFailure?.(err);
    } catch (hookErr) {
      this.logger.debug({ err: hookErr }, 'task-failure hook threw');
    }
  }
}
