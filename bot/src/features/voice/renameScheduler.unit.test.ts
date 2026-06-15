import { describe, expect, it, vi } from 'vitest';
import { RenameScheduler } from './renameScheduler.js';

describe('RenameScheduler', () => {
  it('debounces multiple schedules for one channel into a single run', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new RenameScheduler({
      delayMs: 100,
      run: (_g, c) => {
        runs.push(c);
        return Promise.resolve();
      },
    });
    scheduler.schedule('g', 'c');
    scheduler.schedule('g', 'c');
    scheduler.schedule('g', 'c');
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual(['c']);
    vi.useRealTimers();
  });

  it('runs distinct channels independently', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new RenameScheduler({
      delayMs: 100,
      run: (_g, c) => {
        runs.push(c);
        return Promise.resolve();
      },
    });
    scheduler.schedule('g', 'a');
    scheduler.schedule('g', 'b');
    await vi.advanceTimersByTimeAsync(100);
    expect(runs.sort()).toEqual(['a', 'b']);
    vi.useRealTimers();
  });

  it('clear() cancels pending runs', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const scheduler = new RenameScheduler({
      delayMs: 100,
      run: (_g, c) => {
        runs.push(c);
        return Promise.resolve();
      },
    });
    scheduler.schedule('g', 'c');
    scheduler.clear();
    await vi.advanceTimersByTimeAsync(200);
    expect(runs).toEqual([]);
    vi.useRealTimers();
  });

  it('reports errors via onError', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const scheduler = new RenameScheduler({
      delayMs: 50,
      run: () => Promise.reject(new Error('boom')),
      onError: (err) => errors.push(err),
    });
    scheduler.schedule('g', 'c');
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toHaveLength(1);
    vi.useRealTimers();
  });
});
