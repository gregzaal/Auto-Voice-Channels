import { describe, expect, it, vi } from 'vitest';
import { gracefulDrain, type ShutdownDeps } from './shutdown.js';
import { fakeLogger } from './testUtils.js';

/** Builds ShutdownDeps whose every teardown step records its label in `order`. */
function depsRecording(order: string[]): ShutdownDeps {
  const step = (label: string) => async () => void order.push(label);
  const dbPingTimer = setInterval(() => {}, 1_000);
  dbPingTimer.unref();
  return {
    logger: fakeLogger(),
    config: {} as ShutdownDeps['config'],
    dbPingTimer,
    reconciler: {
      stopSweep: () => order.push('stopSweep'),
    } as unknown as ShutdownDeps['reconciler'],
    disposeInteractions: () => order.push('disposeInteractions'),
    disposeJoinRequests: () => order.push('disposeJoinRequests'),
    disposeVoiceGateway: () => order.push('disposeVoiceGateway'),
    client: {
      removeAllListeners: () => order.push('removeAllListeners'),
      destroy: step('client.destroy'),
    } as unknown as ShutdownDeps['client'],
    dispatcher: { drainAll: step('drainAll') } as unknown as ShutdownDeps['dispatcher'],
    leaseManager: { releaseAll: step('releaseAll') } as unknown as ShutdownDeps['leaseManager'],
    settingsCache: { stop: step('settingsCache.stop') } as unknown as ShutdownDeps['settingsCache'],
    notifier: { close: step('notifier.close') } as unknown as ShutdownDeps['notifier'],
    health: { stop: step('health.stop') } as unknown as ShutdownDeps['health'],
    closeDb: step('closeDb'),
  };
}

describe('gracefulDrain', () => {
  it('tears down in dependency order: stop work → drain → release → gateway → caches → db', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));

    expect(order).toEqual([
      'stopSweep',
      'disposeInteractions',
      'disposeJoinRequests',
      'disposeVoiceGateway',
      'removeAllListeners',
      'drainAll',
      'releaseAll',
      'client.destroy',
      'settingsCache.stop',
      'notifier.close',
      'health.stop',
      'closeDb',
    ]);
  });

  it('drains in-flight work before releasing leases (no stranded work)', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));
    expect(order.indexOf('drainAll')).toBeLessThan(order.indexOf('releaseAll'));
    // And the DB pool closes last (everything that might query it is gone first).
    expect(order.indexOf('closeDb')).toBe(order.length - 1);
  });

  it('clears the db-ping timer (no leak after shutdown)', async () => {
    const order: string[] = [];
    const deps = depsRecording(order);
    const spy = vi.spyOn(globalThis, 'clearInterval');
    await gracefulDrain(deps);
    expect(spy).toHaveBeenCalledWith(deps.dbPingTimer);
    spy.mockRestore();
  });
});
