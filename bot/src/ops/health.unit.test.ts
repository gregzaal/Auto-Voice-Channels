import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer, type HealthReport, type DiagnosticsReport } from './health.js';
import { fakeLogger } from '../runtime/testUtils.js';

const upReport = (): HealthReport => ({
  status: 'up',
  subsystems: { gateway: 'up', leases: 'up', db: 'up' },
  version: '1.2.3',
  commit: 'abc123',
  instanceId: 'i1',
});

const diagnostics = (): DiagnosticsReport => ({
  instanceId: 'i1',
  version: '1.2.3',
  commit: 'abc123',
  claimedShards: [0, 1],
  queueDepth: 0,
  trippedCircuits: 0,
  queues: [],
  recentErrors: [],
  paused: false,
  runtimeFlags: {},
  sweepEnabled: true,
});

describe('HealthServer (HTTP glue)', () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function startWith(health: () => HealthReport): Promise<string> {
    server = new HealthServer({ port: 0, logger: fakeLogger(), health, diagnostics });
    await server.start();
    return `http://127.0.0.1:${server.boundPort}`;
  }

  it('serves /health 200 when up, with the per-subsystem report', async () => {
    const base = await startWith(upReport);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body.status).toBe('up');
    expect(body.subsystems).toEqual({ gateway: 'up', leases: 'up', db: 'up' });
    expect(body.commit).toBe('abc123');
  });

  it('serves /health 503 when a subsystem is down (gates the deploy)', async () => {
    const base = await startWith(() => ({
      ...upReport(),
      status: 'down',
      subsystems: { gateway: 'up', leases: 'up', db: 'down' },
    }));
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
  });

  it('treats /healthz as an alias of /health', async () => {
    const base = await startWith(upReport);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('serves /diagnostics with the live-state shape', async () => {
    const base = await startWith(upReport);
    const res = await fetch(`${base}/diagnostics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiagnosticsReport;
    expect(body.claimedShards).toEqual([0, 1]);
    expect(body.sweepEnabled).toBe(true);
    expect(body).toHaveProperty('runtimeFlags');
  });

  it('404s an unknown path', async () => {
    const base = await startWith(upReport);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

/**
 * `/diagnostics` discloses shard topology, every runtime flag, billing counters
 * and month-to-date AI spend. It shipped unauthenticated and publicly reachable
 * on the beta fleet, so the gate is tested from the outside, over real HTTP.
 */
describe('diagnostics token gate', () => {
  const TOKEN = 'a'.repeat(32);
  const report = {
    instanceId: 'i',
    version: '0',
    commit: 'c',
    claimedShards: [0],
    queueDepth: 0,
    trippedCircuits: 0,
    queues: [],
    recentErrors: [],
    paused: false,
    runtimeFlags: {},
    sweepEnabled: true,
    billing: null,
    ai: null,
  };
  const health = {
    status: 'up' as const,
    subsystems: { gateway: 'up' as const, leases: 'up' as const, db: 'up' as const },
    version: '0',
    commit: 'c',
    instanceId: 'i',
  };
  async function withServer(
    token: string | undefined,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const server = new HealthServer({
      port: 0,
      logger: fakeLogger(),
      health: () => health,
      diagnostics: () => report,
      ...(token !== undefined ? { diagnosticsToken: token } : {}),
    });
    await server.start();
    try {
      await fn(`http://127.0.0.1:${String(server.boundPort)}`);
    } finally {
      await server.stop();
    }
  }

  it('serves diagnostics openly when no token is configured (self-host)', async () => {
    await withServer(undefined, async (base) => {
      const res = await fetch(`${base}/diagnostics`);
      expect(res.status).toBe(200);
    });
  });

  it('answers 404, not 401, without a token', async () => {
    await withServer(TOKEN, async (base) => {
      const res = await fetch(`${base}/diagnostics`);
      // 401 would confirm the route exists and invite guessing.
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('claimedShards');
    });
  });

  it('answers 404 for a wrong token, and for a near-miss of the right length', async () => {
    await withServer(TOKEN, async (base) => {
      for (const bad of ['nope', 'b'.repeat(32), `${TOKEN}x`, TOKEN.slice(0, 31)]) {
        const res = await fetch(`${base}/diagnostics`, {
          headers: { authorization: `Bearer ${bad}` },
        });
        expect(res.status, bad).toBe(404);
      }
    });
  });

  it('serves the report for the correct bearer token', async () => {
    await withServer(TOKEN, async (base) => {
      const res = await fetch(`${base}/diagnostics`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ claimedShards: [0] });
    });
  });

  it('never gates /health, which the deploy check calls unauthenticated', async () => {
    await withServer(TOKEN, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
    });
  });
});
