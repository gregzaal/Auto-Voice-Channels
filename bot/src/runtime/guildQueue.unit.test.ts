import { describe, expect, it } from 'vitest';
import { GuildQueue } from './guildQueue.js';
import { fakeLogger } from './testUtils.js';

const makeQueue = (circuit?: { failureThreshold?: number; cooldownMs?: number }) =>
  new GuildQueue({ guildId: 'g1', logger: fakeLogger(), ...(circuit ? { circuit } : {}) });

describe('GuildQueue', () => {
  it('runs tasks in FIFO order', async () => {
    const q = makeQueue();
    const order: number[] = [];
    const p1 = q.enqueue('t1', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = q.enqueue('t2', async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('resolves with the task result', async () => {
    const q = makeQueue();
    await expect(q.enqueue('t', async () => 42)).resolves.toBe(42);
  });

  it('isolates failures: a rejected task does not block the next', async () => {
    const q = makeQueue({ failureThreshold: 100 });
    const failing = q.enqueue('bad', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(q.enqueue('good', async () => 'ok')).resolves.toBe('ok');
  });

  it('trips the circuit breaker after repeated failures and fails fast', async () => {
    const q = makeQueue({ failureThreshold: 2, cooldownMs: 10_000 });
    await expect(q.enqueue('f1', async () => Promise.reject(new Error('x')))).rejects.toThrow();
    await expect(q.enqueue('f2', async () => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(q.circuitState).toBe('open');
    // Next task is rejected by the breaker without running.
    let ran = false;
    await expect(
      q.enqueue('f3', async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ name: 'CircuitOpenError' });
    expect(ran).toBe(false);
  });

  it('reports depth and idleness', async () => {
    const q = makeQueue();
    expect(q.isIdle).toBe(true);
    const p = q.enqueue('t', async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q.depth).toBeGreaterThanOrEqual(1);
    await p;
    expect(q.isIdle).toBe(true);
  });

  it('drain waits for in-flight tasks and rejects new work', async () => {
    const q = makeQueue();
    const p = q.enqueue('t', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'done';
    });
    const drainPromise = q.drain();
    await expect(q.enqueue('late', async () => 'nope')).rejects.toThrow('draining');
    await drainPromise;
    await expect(p).resolves.toBe('done');
    expect(q.isIdle).toBe(true);
  });
});

/**
 * The 2026-09-16 failure, as a test. Three guilds had a head task stop settling
 * and every later task for that guild piled up behind it for hours, with no
 * error, no log line and no recovery short of restarting the machine.
 */
describe('GuildQueue task timeout', () => {
  const stuckQueue = (opts: {
    onTaskTimeout?: (task: string, ranForMs: number) => void;
    now?: () => number;
  }) =>
    new GuildQueue({
      guildId: 'g1',
      logger: fakeLogger(),
      taskTimeoutMs: 20,
      ...opts,
    });

  it('abandons a task that never settles, and keeps the queue moving', async () => {
    const q = stuckQueue({});
    const hung = q.enqueue('rerenderChannel', () => new Promise<void>(() => {}));
    const after = q.enqueue('reconcile', async () => 'ran');

    await expect(hung).rejects.toThrow(/exceeded 20ms and was abandoned/);
    // The whole point: the task behind the hung one still runs.
    await expect(after).resolves.toBe('ran');
    expect(q.isIdle).toBe(true);
  });

  /** Nothing else knows a task was abandoned, so this hook is the only evidence. */
  it('reports the abandoned task by name and age', async () => {
    const seen: { task: string; ranForMs: number }[] = [];
    const q = stuckQueue({ onTaskTimeout: (task, ranForMs) => seen.push({ task, ranForMs }) });
    await expect(
      q.enqueue('voiceStateUpdate', () => new Promise<void>(() => {})),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.task).toBe('voiceStateUpdate');
    expect(seen[0]?.ranForMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * Counted as a failure, so a guild whose every task hangs trips its own
   * breaker instead of burning a timeout per task forever.
   */
  it('counts a timeout against the circuit breaker', async () => {
    const q = new GuildQueue({
      guildId: 'g1',
      logger: fakeLogger(),
      taskTimeoutMs: 10,
      circuit: { failureThreshold: 2, cooldownMs: 10_000 },
    });
    await expect(q.enqueue('a', () => new Promise<void>(() => {}))).rejects.toThrow();
    await expect(q.enqueue('b', () => new Promise<void>(() => {}))).rejects.toThrow();
    expect(q.circuitState).not.toBe('closed');
  });

  it('leaves a task that finishes in time completely alone', async () => {
    const q = stuckQueue({});
    await expect(q.enqueue('quick', async () => 'done')).resolves.toBe('done');
  });

  /**
   * Depth alone cannot separate a busy guild from a stuck one; this is what
   * turns the alert from a symptom into a cause.
   */
  it('exposes what is running and for how long', async () => {
    let clock = 1_000;
    const q = new GuildQueue({
      guildId: 'g1',
      logger: fakeLogger(),
      taskTimeoutMs: 10_000,
      now: () => clock,
    });
    expect(q.inFlightTask).toBeNull();
    let release: (() => void) | undefined;
    const running = q.enqueue('reconcile', () => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    clock = 4_000;
    expect(q.inFlightTask).toEqual({ name: 'reconcile', ranForMs: 3_000 });
    release?.();
    await running;
    expect(q.inFlightTask).toBeNull();
  });
});
