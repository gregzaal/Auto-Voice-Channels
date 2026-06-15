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
