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
