import { describe, expect, it, vi } from 'vitest';
import type { OpsAuditRepository } from '@avc/core';
import { GatewaySupervisor, SELF_RESTART_ACTION } from './gatewaySupervisor.js';
import { fakeLogger } from './testUtils.js';

/**
 * The 2026-09-01 incident and, more importantly, the ways an automatic fix for
 * it could be worse than the bug.
 *
 * Shard 0 wedged for 3h37m and nothing was ever going to take it: peers do not
 * poach a live lease. A restart cured it in 14 seconds. But a fleet that
 * restarts itself whenever the gateway looks down will cycle through the daily
 * identify budget during a Discord outage and be unable to come back, so every
 * guard here is load-bearing and each has its own case.
 */

const HOUR = 60 * 60_000;

function auditRepo(rows: { action: string; target: string; createdAt: Date }[] = []) {
  return {
    record: vi.fn(async () => undefined),
    recent: vi.fn(async () => rows),
  } as unknown as OpsAuditRepository & { record: ReturnType<typeof vi.fn> };
}

function build(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const deps = makeDeps(over);
  return { deps, supervisor: new GatewaySupervisor(deps) };
}

/**
 * Observes the outage, then lets the confirm window elapse.
 *
 * The first tick is what starts the clock, so a single tick can never be past
 * the window however far in the future the clock is set. Worth a helper rather
 * than repeating: getting it wrong makes a test pass for the wrong reason.
 */
async function confirmOutage(
  supervisor: GatewaySupervisor,
  setClock: (ms: number) => void,
  start = 0,
): Promise<void> {
  setClock(start);
  await supervisor.tick();
  setClock(start + 5 * 60_000);
  await supervisor.tick();
}

function makeDeps(
  over: {
    status?: 'up' | 'down' | 'unknown';
    leasesProven?: boolean;
    budget?: { used: number; total: number } | undefined;
    audit?: ReturnType<typeof auditRepo>;
    now?: () => number;
  } = {},
) {
  const audit = over.audit ?? auditRepo();
  return {
    gatewayStatus: () => over.status ?? 'down',
    leasesProven: () => over.leasesProven ?? true,
    sessionBudget: () => (over.budget === undefined ? { used: 2, total: 1000 } : over.budget),
    opsAudit: audit,
    instanceId: 'i1',
    requestRestart: vi.fn(),
    report: vi.fn(),
    logger: fakeLogger(),
    now: over.now ?? (() => 0),
    confirmForMs: 5 * 60_000,
  };
}

describe('GatewaySupervisor', () => {
  it('does nothing while the gateway is up', async () => {
    let clock = 0;
    const { deps, supervisor } = build({ status: 'up', now: () => clock });
    clock = 10 * HOUR;
    await supervisor.tick();
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  /** A blip is not an outage, and five minutes is past anything that recovers. */
  it('waits for the condition to hold before acting', async () => {
    let clock = 0;
    const { deps, supervisor } = build({ now: () => clock });

    await supervisor.tick();
    clock = 4 * 60_000;
    await supervisor.tick();
    expect(deps.requestRestart).not.toHaveBeenCalled();

    clock = 5 * 60_000;
    await supervisor.tick();
    expect(deps.requestRestart).toHaveBeenCalledWith('gateway-down');
  });

  it('forgets the clock if the gateway comes back on its own', async () => {
    let clock = 0;
    let status: 'up' | 'down' = 'down';
    const deps = makeDeps({ now: () => clock });
    deps.gatewayStatus = () => status;
    const supervisor = new GatewaySupervisor(deps);

    await supervisor.tick();
    clock = 4 * 60_000;
    status = 'up';
    await supervisor.tick();
    status = 'down';
    clock = 6 * 60_000;
    await supervisor.tick();
    // The five minutes restarts from the recovery, not from the first sighting.
    expect(deps.requestRestart).not.toHaveBeenCalled();
  });

  it('records the restart before exiting, so the rate limit can see it', async () => {
    let clock = 0;
    const audit = auditRepo();
    const { deps, supervisor } = build({ now: () => clock, audit });
    await confirmOutage(supervisor, (ms) => (clock = ms));

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: SELF_RESTART_ACTION, target: 'i1' }),
    );
    expect(deps.requestRestart).toHaveBeenCalled();
  });

  describe('the guards, each of which makes it worse if missing', () => {
    /**
     * The database being unreachable is the likeliest cause of a bad lease, and
     * a restart then cannot apply migrations, so the machine would cycle until
     * Fly gave up and the fleet would be gone when the database returned.
     */
    it('declines when the lease cannot be proven', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ leasesProven: false, now: () => clock });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
      expect(deps.report).toHaveBeenCalledWith(
        'gateway.stuck',
        expect.any(String),
        expect.objectContaining({ refusal: expect.stringContaining('database') }),
      );
    });

    /**
     * Reaching the identify budget at all means something is already cycling,
     * and spending the rest is how a recoverable incident becomes a day-long one.
     */
    it('declines when the identify budget is nearly spent', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ budget: { used: 900, total: 1000 }, now: () => clock });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    it('goes ahead when the budget is healthy', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ budget: { used: 5, total: 1000 }, now: () => clock });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).toHaveBeenCalled();
    });

    /**
     * The rate limit has to survive the restart it is limiting, which is why it
     * is read out of `ops_audit` rather than held in memory.
     */
    it('declines a second restart within the hour, across process lifetimes', async () => {
      let clock = 10 * HOUR;
      const audit = auditRepo([
        { action: SELF_RESTART_ACTION, target: 'i1', createdAt: new Date(10 * HOUR - 60_000) },
      ]);
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms), 10 * HOUR);
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    it('allows one again after the hour is up', async () => {
      let clock = 10 * HOUR;
      const audit = auditRepo([
        { action: SELF_RESTART_ACTION, target: 'i1', createdAt: new Date(8 * HOUR) },
      ]);
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms), 10 * HOUR);
      expect(deps.requestRestart).toHaveBeenCalled();
    });

    it('ignores another instance restarting itself', async () => {
      let clock = 10 * HOUR;
      const audit = auditRepo([
        { action: SELF_RESTART_ACTION, target: 'i2', createdAt: new Date(10 * HOUR - 60_000) },
      ]);
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms), 10 * HOUR);
      expect(deps.requestRestart).toHaveBeenCalled();
    });

    /**
     * Cannot prove this is not a loop, so do not start one. The cost of not
     * restarting is an outage a human can still fix.
     */
    it('declines when it cannot read the record at all', async () => {
      const audit = {
        record: vi.fn(async () => undefined),
        recent: vi.fn(async () => {
          throw new Error('database unreachable');
        }),
      } as unknown as ReturnType<typeof auditRepo>;
      let clock = 0;
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });
  });

  it('decides once per process, however long it stays down', async () => {
    let clock = 0;
    const { deps, supervisor } = build({ now: () => clock });
    await confirmOutage(supervisor, (ms) => (clock = ms));
    clock = 10 * HOUR;
    await supervisor.tick();
    await supervisor.tick();
    expect(deps.requestRestart).toHaveBeenCalledTimes(1);
  });

  it('reports how long it has been down, for diagnostics', async () => {
    let clock = 0;
    const { supervisor } = build({ now: () => clock });
    await supervisor.tick();
    clock = 90_000;
    expect(supervisor.stats.downForMs).toBe(90_000);
  });
});
