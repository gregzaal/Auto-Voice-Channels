import { describe, expect, it } from 'vitest';
import { GuildDispatcher } from './dispatcher.js';
import { fakeLogger } from './testUtils.js';

describe('GuildDispatcher', () => {
  it('processes guilds in parallel but orders within a guild', async () => {
    const d = new GuildDispatcher({ logger: fakeLogger() });
    const order: string[] = [];
    const a1 = d.dispatch('A', 'a1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('A1');
    });
    const a2 = d.dispatch('A', 'a2', async () => {
      order.push('A2');
    });
    const b1 = d.dispatch('B', 'b1', async () => {
      order.push('B1');
    });
    await Promise.all([a1, a2, b1]);
    // Within A, ordering holds.
    expect(order.indexOf('A1')).toBeLessThan(order.indexOf('A2'));
    // B's quick task finishes before A's slow first task.
    expect(order.indexOf('B1')).toBeLessThan(order.indexOf('A1'));
  });

  it('reports a snapshot and tripped counts', async () => {
    const d = new GuildDispatcher({ logger: fakeLogger(), circuit: { failureThreshold: 1 } });
    await expect(
      d.dispatch('X', 'bad', async () => Promise.reject(new Error('e'))),
    ).rejects.toThrow();
    expect(d.trippedCount()).toBe(1);
    const snap = d.snapshot();
    expect(snap.find((s) => s.guildId === 'X')?.circuitState).not.toBe('closed');
  });

  it('an error in one guild does not affect another', async () => {
    const d = new GuildDispatcher({ logger: fakeLogger(), circuit: { failureThreshold: 1 } });
    await expect(
      d.dispatch('bad', 'x', async () => Promise.reject(new Error('e'))),
    ).rejects.toThrow();
    await expect(d.dispatch('good', 'y', async () => 'ok')).resolves.toBe('ok');
  });
});
