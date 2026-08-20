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
    disposeOnboarding: () => order.push('disposeOnboarding'),
    disposeGuildIdentity: () => order.push('disposeGuildIdentity'),
    billingReconciler: {
      stop: () => order.push('billingReconciler.stop'),
    } as unknown as ShutdownDeps['billingReconciler'],
    entitlementGate: {
      stop: () => order.push('entitlementGate.stop'),
    } as unknown as ShutdownDeps['entitlementGate'],
    client: {
      removeAllListeners: () => order.push('removeAllListeners'),
      destroy: step('client.destroy'),
    } as unknown as ShutdownDeps['client'],
    dispatcher: { drainAll: step('drainAll') } as unknown as ShutdownDeps['dispatcher'],
    metricsCollector: {
      stop: step('metricsCollector.stop'),
    } as unknown as ShutdownDeps['metricsCollector'],
    alertScheduler: {
      stop: step('alertScheduler.stop'),
    } as unknown as ShutdownDeps['alertScheduler'],
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
      'alertScheduler.stop',
      'stopSweep',
      'billingReconciler.stop',
      'disposeInteractions',
      'disposeJoinRequests',
      'disposeVoiceGateway',
      'disposeOnboarding',
      'disposeGuildIdentity',
      'removeAllListeners',
      'drainAll',
      'metricsCollector.stop',
      'releaseAll',
      'client.destroy',
      'settingsCache.stop',
      'entitlementGate.stop',
      'notifier.close',
      'health.stop',
      'closeDb',
    ]);
  });

  /**
   * Everything after this line makes the instance look unhealthy on purpose, so
   * a watcher still evaluating would post a critical and withhold the watchdog
   * ping on every routine deploy.
   */
  it('stops the watcher before anything starts tearing down', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));
    expect(order[0]).toBe('alertScheduler.stop');
  });

  it('drains in-flight work before releasing leases (no stranded work)', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));
    expect(order.indexOf('drainAll')).toBeLessThan(order.indexOf('releaseAll'));
    /**
     * The final metrics flush sits between the drain and the pool teardown: work
     * finished during the drain still gets counted, and the flush still has a
     * database to write to.
     */
    expect(order.indexOf('drainAll')).toBeLessThan(order.indexOf('metricsCollector.stop'));
    expect(order.indexOf('metricsCollector.stop')).toBeLessThan(order.indexOf('closeDb'));
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
