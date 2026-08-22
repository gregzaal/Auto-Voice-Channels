import { describe, expect, it, vi } from 'vitest';
import type { Config, ShardLeaseRepository } from '@avc/core';
import { runIdle, idleDrain } from './idle.js';
import { ShardLeaseManager } from './shardLeaseManager.js';
import type { HealthServer } from '../ops/health.js';
import { fakeLogger } from './testUtils.js';

/**
 * `plans/scaling.md` §9.1: an instance ending boot-time claiming with zero
 * owned shards used to crash-loop (discord.js's `Client` rejects an empty
 * `shards: []`, `ClientInvalidProvidedShards`). `runIdle` is the fix — it is
 * never given a gateway client at all.
 */

function fakeRepo(overrides: Partial<ShardLeaseRepository> = {}): ShardLeaseRepository {
  return {
    claimAvailable: vi.fn(async () => []),
    heartbeat: vi.fn(async () => []),
    releaseAll: vi.fn(async () => 0),
    ...overrides,
  } as unknown as ShardLeaseRepository;
}

/** Only the fields `runIdle` actually reads are real; the rest are cast through. */
function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    instanceId: 'idle-1',
    httpPort: 0,
    diagnosticsToken: undefined,
    totalShards: 2,
    expectedInstances: 2,
    ...overrides,
  } as Config;
}

describe('runIdle', () => {
  it('serves a healthy /health and an idle /diagnostics, with no gateway client', async () => {
    const leaseManager = new ShardLeaseManager({
      repo: fakeRepo(),
      logger: fakeLogger(),
      instanceId: 'idle-1',
      totalShards: 2,
    });
    const pool = { query: vi.fn(async () => ({})) };
    const closeDb = vi.fn(async () => undefined);
    const sigintListenersBefore = process.listenerCount('SIGINT');
    const sigtermListenersBefore = process.listenerCount('SIGTERM');

    const { health: server } = await runIdle({
      config: fakeConfig(),
      logger: fakeLogger(),
      leaseManager,
      pool,
      closeDb,
    });

    try {
      const base = `http://127.0.0.1:${String(server.boundPort)}`;

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200); // 'up', not 503 — must not fail Fly's deploy gate
      const healthBody = (await health.json()) as { status: string; idle?: true };
      expect(healthBody.status).toBe('up');
      expect(healthBody.idle).toBe(true);

      const diag = await fetch(`${base}/diagnostics`);
      expect(diag.status).toBe(200);
      const diagBody = (await diag.json()) as { claimedShards: number[]; idle?: true };
      expect(diagBody.claimedShards).toEqual([]);
      expect(diagBody.idle).toBe(true);
    } finally {
      // Clean up both `once` listeners `runIdle` registered - firing only
      // one would leave the other armed for the rest of the test run,
      // accumulating across every test that calls `runIdle`. The internal
      // `shuttingDown` guard makes the second emit here a safe no-op.
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      process.emit('SIGTERM');
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 0));
      exit.mockRestore();
    }

    // Exactly one listener each was registered by this call, and both were
    // consumed by the cleanup above (`.once` self-removes on fire).
    expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
  });

  it('starts the lease heartbeat, so a stale claim does not linger unrefreshed', async () => {
    const leaseManager = {
      startHeartbeat: vi.fn(),
      releaseAll: vi.fn(async () => undefined),
    } as unknown as ShardLeaseManager;
    const closeDb = vi.fn(async () => undefined);

    await runIdle({
      config: fakeConfig(),
      logger: fakeLogger(),
      leaseManager,
      pool: { query: vi.fn(async () => ({})) },
      closeDb,
    });

    expect(leaseManager.startHeartbeat).toHaveBeenCalledTimes(1);

    // Consume both `once` listeners this call registered (see the note in
    // the previous test) before the next test runs.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    exit.mockRestore();
  });
});

describe('idleDrain', () => {
  it('releases leases, stops the health server, and closes the pool, in that order', async () => {
    const order: string[] = [];
    const leaseManager = {
      releaseAll: vi.fn(async () => {
        order.push('releaseAll');
      }),
    } as unknown as ShardLeaseManager;
    const health = {
      stop: vi.fn(async () => {
        order.push('health.stop');
      }),
    } as unknown as HealthServer;
    const closeDb = vi.fn(async () => {
      order.push('closeDb');
    });
    const dbPingTimer = setInterval(() => {}, 1_000);
    dbPingTimer.unref();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    await idleDrain({ leaseManager, health, dbPingTimer, closeDb });

    expect(order).toEqual(['releaseAll', 'health.stop', 'closeDb']);
    expect(clearSpy).toHaveBeenCalledWith(dbPingTimer);
    clearSpy.mockRestore();
  });

  it('does not throw when releasing an instance that already owns nothing', async () => {
    const leaseManager = new ShardLeaseManager({
      repo: fakeRepo({ releaseAll: vi.fn(async () => 0) }),
      logger: fakeLogger(),
      instanceId: 'idle-1',
      totalShards: 2,
    });
    const health = { stop: vi.fn(async () => undefined) } as unknown as HealthServer;
    const dbPingTimer = setInterval(() => {}, 1_000);
    dbPingTimer.unref();

    await expect(
      idleDrain({ leaseManager, health, dbPingTimer, closeDb: async () => undefined }),
    ).resolves.toBeUndefined();
  });
});
