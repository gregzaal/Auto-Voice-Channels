import { describe, expect, it, vi } from 'vitest';
import type { OpsAuditRepository, RuntimeFlagsRepository } from '@avc/core';
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
 *
 * The second block is the one an adversarial review earned: three of the
 * original guards were wrong in a way no test caught, two failing open and one
 * failing so hard it reintroduced the outage.
 */

const HOUR = 60 * 60_000;

function auditRepo(over: { hasRecent?: boolean; failRead?: boolean; failWrite?: boolean } = {}) {
  const hasActionSince = vi.fn(async () => {
    if (over.failRead) throw new Error('database unreachable');
    return over.hasRecent ?? false;
  });
  const record = vi.fn(async () => {
    if (over.failWrite) throw new Error('insert failed');
    return undefined;
  });
  return { record, hasActionSince } as unknown as OpsAuditRepository & {
    record: ReturnType<typeof vi.fn>;
    hasActionSince: ReturnType<typeof vi.fn>;
  };
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
    budget?: { used: number; total: number; observedAt: number };
    /** Distinct from an omitted `budget`, which means "use a fresh default". */
    noBudget?: boolean;
    audit?: ReturnType<typeof auditRepo>;
    disabled?: boolean;
    flagReadFails?: boolean;
    now?: () => number;
  } = {},
) {
  const audit = over.audit ?? auditRepo();
  const flags = {
    getBool: vi.fn(async () => {
      if (over.flagReadFails) throw new Error('database unreachable');
      return over.disabled ?? false;
    }),
  } as unknown as RuntimeFlagsRepository & { getBool: ReturnType<typeof vi.fn> };
  const now = over.now ?? ((): number => 0);
  return {
    gatewayStatus: () => over.status ?? 'down',
    leasesProven: () => over.leasesProven ?? true,
    /**
     * The default reading follows the clock, or every test that moves time
     * forward would trip the staleness guard instead of the one it is about.
     */
    sessionBudget: () =>
      over.noBudget ? undefined : (over.budget ?? { used: 2, total: 1000, observedAt: now() }),
    opsAudit: audit,
    flags,
    instanceId: 'i1',
    requestRestart: vi.fn(),
    report: vi.fn(),
    logger: fakeLogger(),
    now,
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
      const { deps, supervisor } = build({
        budget: { used: 900, total: 1000, observedAt: 0 },
        now: () => clock,
      });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    it('goes ahead when the budget is healthy', async () => {
      let clock = 0;
      const { deps, supervisor } = build({
        budget: { used: 5, total: 1000, observedAt: 0 },
        now: () => clock,
      });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).toHaveBeenCalled();
    });

    /**
     * The rate limit has to survive the restart it is limiting, which is why it
     * is read out of `ops_audit` rather than held in memory.
     */
    it('declines a second restart within the hour, across process lifetimes', async () => {
      let clock = 10 * HOUR;
      const audit = auditRepo({ hasRecent: true });
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms), 10 * HOUR);
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    it('allows one again after the hour is up', async () => {
      let clock = 10 * HOUR;
      const audit = auditRepo({ hasRecent: false });
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms), 10 * HOUR);
      expect(deps.requestRestart).toHaveBeenCalled();
    });

    /**
     * **The rate limit asks the database a question, it does not page through
     * rows and filter them here.**
     *
     * It used to read `recent(50)` and look for its own row in the result. Those
     * 50 slots are shared with every other writer of `ops_audit`, including one
     * row per guild that the billing pass moves, so a busy hour pushed the
     * restart record off the page and the only durable brake on a restart loop
     * silently stopped working. This asserts the shape, because the shape is the
     * fix: bound by action, by this instance, and by an hour.
     */
    it('asks for its own row in the last hour, rather than paging the table', async () => {
      let clock = 10 * HOUR;
      const audit = auditRepo();
      const { supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms), 10 * HOUR);

      expect(audit.hasActionSince).toHaveBeenCalledWith(
        SELF_RESTART_ACTION,
        'i1',
        new Date(10 * HOUR + 5 * 60_000 - HOUR),
      );
      expect((audit as unknown as { recent?: unknown }).recent).toBeUndefined();
    });

    /**
     * Cannot prove this is not a loop, so do not start one. The cost of not
     * restarting is an outage a human can still fix.
     */
    it('declines when it cannot read the record at all', async () => {
      let clock = 0;
      const audit = auditRepo({ failRead: true });
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });
  });

  /**
   * Every one of these was a real defect in the first version of this file, and
   * every one of them was green under the block above.
   */
  describe('the guards that were wrong, and the direction each failed in', () => {
    /**
     * **The worst of them: a refusal used to latch for the life of the process.**
     *
     * All three refusal reasons are transient. A machine that blips during the
     * confirm window, gets refused, then runs healthy for three weeks and wedges
     * would sit wedged forever, which is the 2026-09-01 outage reached through
     * its own fix.
     */
    it('re-evaluates after a refusal, so a blip does not disarm it forever', async () => {
      let clock = 0;
      let proven = false;
      const deps = makeDeps({ now: () => clock });
      deps.leasesProven = () => proven;
      const supervisor = new GatewaySupervisor(deps);

      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();

      // The database comes back. The gateway is still dead.
      proven = true;
      clock = 6 * 60_000;
      await supervisor.tick();
      expect(deps.requestRestart).toHaveBeenCalledWith('gateway-down');
    });

    /** Deciding every tick must not mean posting every tick. */
    it('says a refusal once per episode, not once every 30 seconds', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ leasesProven: false, now: () => clock });

      await confirmOutage(supervisor, (ms) => (clock = ms));
      clock = 5 * 60_000 + 30_000;
      await supervisor.tick();
      clock = 5 * 60_000 + 60_000;
      await supervisor.tick();
      expect(deps.report).toHaveBeenCalledTimes(1);

      // Past the pacing interval it speaks again, so a long refusal is not silent.
      clock = 30 * 60_000;
      await supervisor.tick();
      expect(deps.report).toHaveBeenCalledTimes(2);
    });

    /**
     * An unknown budget used to be treated as "no objection", and the only
     * writer of that value was a five-minute metrics tick that a kill switch
     * could stop forever. So `global.pause`, the lever an operator sets while
     * load-shedding during an incident, silently disarmed the guard that exists
     * for fleet-wide identify exhaustion.
     */
    it('declines when the identify budget is unknown', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ noBudget: true, now: () => clock });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
      expect(deps.report).toHaveBeenCalledWith(
        'gateway.stuck',
        expect.any(String),
        expect.objectContaining({ refusal: expect.stringContaining('unknown') }),
      );
    });

    /**
     * A frozen reading is worse than an absent one: `GET /gateway/bot` fails
     * during exactly the Discord incident this guard is for, so a stale number
     * understates consumption precisely while a fleet is cycling.
     */
    it('declines on a budget reading old enough to mean the API is unreachable', async () => {
      let clock = 5 * HOUR;
      const { deps, supervisor } = build({
        budget: { used: 5, total: 1000, observedAt: 0 },
        now: () => clock,
      });
      await confirmOutage(supervisor, (ms) => (clock = ms), 5 * HOUR);
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    /**
     * The hourly limit's integrity rests entirely on this row landing. Logging
     * the failure and restarting anyway leaves the next boot's guard blind,
     * which is one restart per boot with nothing recording any of them.
     */
    it('declines when the audit row cannot be written', async () => {
      let clock = 0;
      const audit = auditRepo({ failWrite: true });
      const { deps, supervisor } = build({ now: () => clock, audit });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
      expect(deps.report).toHaveBeenCalledWith(
        'gateway.stuck',
        expect.any(String),
        expect.objectContaining({ refusal: expect.stringContaining('recorded') }),
      );
    });

    /**
     * The one autonomous behaviour that restarts a production machine had no
     * no-deploy lever, and a deploy into a fleet that is cycling itself is the
     * worst moment to discover that.
     */
    it('declines when the kill switch is set', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ disabled: true, now: () => clock });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    /** Cannot read the switch, so cannot know whether a human has forbidden it. */
    it('declines when the kill switch cannot be read', async () => {
      let clock = 0;
      const { deps, supervisor } = build({ flagReadFails: true, now: () => clock });
      await confirmOutage(supervisor, (ms) => (clock = ms));
      expect(deps.requestRestart).not.toHaveBeenCalled();
    });

    /**
     * Two ticks either side of the same await both read "no recent restart",
     * both post, and both write an audit row.
     */
    it('does not let a slow tick overlap the next one', async () => {
      let clock = 0;
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const audit = auditRepo();
      (audit.hasActionSince as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await gate;
        return false;
      });
      const { deps, supervisor } = build({ now: () => clock, audit });

      clock = 0;
      await supervisor.tick();
      clock = 5 * 60_000;
      const first = supervisor.tick();
      const second = supervisor.tick();
      release();
      await Promise.all([first, second]);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(deps.requestRestart).toHaveBeenCalledTimes(1);
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

  it('reports how long it has been down, and why it declined, for diagnostics', async () => {
    let clock = 0;
    const { supervisor } = build({ leasesProven: false, now: () => clock });
    await supervisor.tick();
    clock = 90_000;
    expect(supervisor.stats.downForMs).toBe(90_000);

    clock = 5 * 60_000;
    await supervisor.tick();
    expect(supervisor.stats.lastRefusal).toContain('database');
    expect(supervisor.stats.restarted).toBe(false);
  });
});
