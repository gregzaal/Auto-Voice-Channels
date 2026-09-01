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
    gatewaySupervisor: { stop: () => order.push('gatewaySupervisor.stop') },
    leaseManager: { releaseAll: step('releaseAll') } as unknown as ShutdownDeps['leaseManager'],
    settingsCache: { stop: step('settingsCache.stop') } as unknown as ShutdownDeps['settingsCache'],
    notifier: { close: step('notifier.close') } as unknown as ShutdownDeps['notifier'],
    health: { stop: step('health.stop') } as unknown as ShutdownDeps['health'],
    closeDb: step('closeDb'),
  };
}

describe('gracefulDrain', () => {
  it('tears down in dependency order: stop work → drain → gateway → release → caches → db', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));

    expect(order).toEqual([
      'alertScheduler.stop',
      'gatewaySupervisor.stop',
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
      'client.destroy',
      'releaseAll',
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

  /**
   * `plans/scaling.md` §6.2. The old order released a shard's lease row while
   * this process still held its live WebSocket session, so a booting peer's
   * 2s-interval claim retry could poach it while both were momentarily "live"
   * for the same shard. Destroying the gateway first closes those sessions
   * before the rows go free, so nothing is ever claimable while still served
   * here.
   */
  it('destroys the gateway before releasing shard leases', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));
    expect(order.indexOf('client.destroy')).toBeLessThan(order.indexOf('releaseAll'));
  });

  it('clears the db-ping timer (no leak after shutdown)', async () => {
    const order: string[] = [];
    const deps = depsRecording(order);
    const spy = vi.spyOn(globalThis, 'clearInterval');
    await gracefulDrain(deps);
    expect(spy).toHaveBeenCalledWith(deps.dbPingTimer);
    spy.mockRestore();
  });
  /**
   * **`client.destroy()` below makes the gateway genuinely down.**
   *
   * A supervisor still ticking through a slow drain therefore confirms it, posts
   * "instance is restarting" about a machine already shutting down on purpose,
   * and writes an `instance.self_restart` row that spends the real hourly
   * allowance the next boot has to respect. Same reasoning as stopping the
   * watcher first, with a durable side effect on top.
   */
  it('stops the gateway supervisor before destroying the gateway', async () => {
    const order: string[] = [];
    await gracefulDrain(depsRecording(order));
    expect(order.indexOf('gatewaySupervisor.stop')).toBeLessThan(order.indexOf('client.destroy'));
    expect(order.indexOf('gatewaySupervisor.stop')).toBeLessThan(order.indexOf('drainAll'));
  });

  /** Absent on a self-host build that never constructed one. */
  it('does not require a supervisor', async () => {
    const order: string[] = [];
    const deps = depsRecording(order);
    await expect(gracefulDrain({ ...deps, gatewaySupervisor: undefined })).resolves.toBeUndefined();
  });
});
