import { DiscordAPIError } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../../runtime/testUtils.js';
import { Reconciler } from './reconciler.js';

/** A `DiscordAPIError` with the code the API actually returns for a refusal. */
function apiError(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, 403, 'PATCH', '', {});
}

/**
 * A reconciler whose per-guild reconcile does whatever `outcome` says, wired to
 * a dispatcher that runs the task inline: this exercises the sweep's own error
 * classification, not the queue underneath it.
 */
function reconcilerWith(outcome: (guildId: string) => Promise<unknown>) {
  const report = vi.fn();
  const reconciler = new Reconciler({
    feature: { reconcileGuild: (guildId: string) => outcome(guildId) } as never,
    dispatcher: {
      dispatch: (_guildId: string, _name: string, task: () => Promise<unknown>) => task(),
    } as never,
    secondaries: {} as never,
    autoChannels: {} as never,
    flags: { getBool: async () => false } as never,
    logger: fakeLogger(),
    report,
  });
  return { reconciler, report };
}

const guilds = (n: number): string[] => Array.from({ length: n }, (_, i) => `g${i}`);

describe('Reconciler sweep failure classification', () => {
  /**
   * 2026-09-17: one guild's admin changed a channel overwrite, every sweep got
   * a 403 renaming it, and the operator was paged for two hours about a server
   * only that guild's admin could fix - who had already been DM'd.
   */
  it('does not raise reconcile.failed for a guild refusing on permissions', async () => {
    const { reconciler, report } = reconcilerWith(async (id) => {
      if (id === 'g3') throw apiError(50013, 'Missing Permissions');
      return {};
    });
    await reconciler.reconcileGuilds(guilds(20));
    expect(report).not.toHaveBeenCalled();
  });

  it('treats missing access the same as missing permissions', async () => {
    const { reconciler, report } = reconcilerWith(async (id) => {
      if (id === 'g3') throw apiError(50001, 'Missing Access');
      return {};
    });
    await reconciler.reconcileGuilds(guilds(20));
    expect(report).not.toHaveBeenCalled();
  });

  /** A real fault still pages, which is the whole point of keeping the split. */
  it('still raises reconcile.failed for anything that is not a refusal', async () => {
    const { reconciler, report } = reconcilerWith(async (id) => {
      if (id === 'g3') throw new Error('connection terminated unexpectedly');
      return {};
    });
    await reconciler.reconcileGuilds(guilds(20));
    expect(report).toHaveBeenCalledWith(
      'reconcile.failed',
      expect.any(String),
      expect.objectContaining({ failed: 1, of: 20, sample: ['g3'] }),
    );
  });

  /**
   * Half the fleet refusing at once is not a hundred guild admins acting
   * together, it is our own role or a Discord-side change.
   */
  it('raises reconcile.denied when the whole fleet is being refused', async () => {
    const { reconciler, report } = reconcilerWith(async (id) => {
      if (Number(id.slice(1)) < 15) throw apiError(50013, 'Missing Permissions');
      return {};
    });
    await reconciler.reconcileGuilds(guilds(20));
    expect(report).toHaveBeenCalledWith(
      'reconcile.denied',
      expect.any(String),
      expect.objectContaining({ denied: 15, of: 20 }),
    );
    expect(report.mock.calls.map((c) => c[0])).not.toContain('reconcile.failed');
  });

  /** A handful of refusals is normal background; only a majority is ours. */
  it('stays quiet when refusals are a minority of the sweep', async () => {
    const { reconciler, report } = reconcilerWith(async (id) => {
      if (Number(id.slice(1)) < 12) throw apiError(50013, 'Missing Permissions');
      return {};
    });
    await reconciler.reconcileGuilds(guilds(100));
    expect(report).not.toHaveBeenCalled();
  });

  /** A sweep both failing and being refused reads as one event, not two. */
  it('carries the refusal count alongside a real failure', async () => {
    const { reconciler, report } = reconcilerWith(async (id) => {
      if (id === 'g1') throw new Error('database is unreachable');
      if (id === 'g2') throw apiError(50013, 'Missing Permissions');
      return {};
    });
    await reconciler.reconcileGuilds(guilds(20));
    expect(report).toHaveBeenCalledWith(
      'reconcile.failed',
      expect.any(String),
      expect.objectContaining({ failed: 1, deniedOnPermissions: 1 }),
    );
  });
});

/**
 * The remembered settings orphan sweep rides the same timer as the guild sweep and the
 * companion pass, and has to be something that can never cost either of them anything.
 */
describe('Reconciler remembered settings orphan sweep', () => {
  const logger = () => {
    const base = fakeLogger() as unknown as Record<string, unknown>;
    const info = vi.fn();
    const error = vi.fn();
    return { logger: { ...base, info, error } as never, info, error };
  };

  function sweeperWith(
    sweepMemberPrefsOrphans: () => Promise<{ removed: number }>,
    over: { paused?: boolean; sweepDisabled?: boolean } = {},
  ) {
    const reconcileGuild = vi.fn().mockResolvedValue({});
    const dispatch = vi.fn((_guildId: string, _name: string, task: () => Promise<unknown>) =>
      task(),
    );
    const { logger: log, info, error } = logger();
    const reconciler = new Reconciler({
      feature: { reconcileGuild } as never,
      dispatcher: { dispatch } as never,
      secondaries: { listGuildIds: async () => ['g1', 'g2'] } as never,
      autoChannels: { listGuildIds: async () => [] } as never,
      flags: {
        getBool: async (key: string) =>
          key === 'global.pause' ? (over.paused ?? false) : (over.sweepDisabled ?? false),
      } as never,
      logger: log,
      sweepMemberPrefsOrphans,
    });
    return { reconciler, reconcileGuild, dispatch, info, error };
  }

  const clock = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  };
  afterEach(() => vi.useRealTimers());

  it('runs on a sweep, outside any guild dispatch, and still sweeps the guilds', async () => {
    const sweep = vi.fn().mockResolvedValue({ removed: 0 });
    const { reconciler, reconcileGuild, dispatch } = sweeperWith(sweep);
    await reconciler.sweep();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(reconcileGuild).toHaveBeenCalledTimes(2);
    // Every dispatch is a guild's reconcile: the sweep is never queued behind one, so it
    // cannot hold a guild's queue and no guild's breaker can count it.
    expect(dispatch.mock.calls.map((call) => call[1])).toEqual(['reconcile', 'reconcile']);
  });

  /** A row waits a week to become eligible, so asking every five minutes reads a table for nothing. */
  it('asks at most once an hour in one process, and again after the hour', async () => {
    clock();
    const sweep = vi.fn().mockResolvedValue({ removed: 0 });
    const { reconciler } = sweeperWith(sweep);

    await reconciler.sweep();
    vi.advanceTimersByTime(5 * 60 * 1000);
    await reconciler.sweep();
    vi.advanceTimersByTime(54 * 60 * 1000);
    await reconciler.sweep();
    expect(sweep).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 1000);
    await reconciler.sweep();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  /**
   * It is unrelated work sharing a timer: a database error here must not cost the guild
   * sweep, which customers are waiting on, and must not be retried every tick.
   */
  it('cannot fail the guild sweep, logs the error, and waits an hour before asking again', async () => {
    clock();
    const sweep = vi.fn().mockRejectedValue(new Error('db down'));
    const { reconciler, reconcileGuild, error } = sweeperWith(sweep);

    await expect(reconciler.sweep()).resolves.toBeUndefined();
    expect(reconcileGuild).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000);
    await reconciler.sweep();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  /** Counts only: the rows hold member ids and the names they chose. */
  it('logs how many it removed and nothing else, and says nothing when there were none', async () => {
    clock();
    const sweep = vi
      .fn()
      .mockResolvedValueOnce({ removed: 0 })
      .mockResolvedValueOnce({ removed: 7 });
    const { reconciler, info } = sweeperWith(sweep);

    await reconciler.sweep();
    expect(info).not.toHaveBeenCalled();

    vi.advanceTimersByTime(61 * 60 * 1000);
    await reconciler.sweep();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({ removed: 7 }, expect.any(String));
  });

  it('is skipped on a dry run, which reports drift and acts on nothing', async () => {
    const sweep = vi.fn().mockResolvedValue({ removed: 0 });
    const { reconciler } = sweeperWith(sweep);
    await reconciler.sweep({ dryRun: true });
    expect(sweep).not.toHaveBeenCalled();
  });

  it('is skipped under global pause and when the sweep is disabled', async () => {
    const paused = vi.fn().mockResolvedValue({ removed: 0 });
    await sweeperWith(paused, { paused: true }).reconciler.sweep();
    expect(paused).not.toHaveBeenCalled();

    const disabled = vi.fn().mockResolvedValue({ removed: 0 });
    await sweeperWith(disabled, { sweepDisabled: true }).reconciler.sweep();
    expect(disabled).not.toHaveBeenCalled();
  });

  it('is optional, so a self-host or a test that wires none sweeps as it always did', async () => {
    const reconcileGuild = vi.fn().mockResolvedValue({});
    const reconciler = new Reconciler({
      feature: { reconcileGuild } as never,
      dispatcher: {
        dispatch: (_g: string, _n: string, task: () => Promise<unknown>) => task(),
      } as never,
      secondaries: { listGuildIds: async () => ['g1'] } as never,
      autoChannels: { listGuildIds: async () => [] } as never,
      flags: { getBool: async () => false } as never,
      logger: fakeLogger(),
    });
    await reconciler.sweep();
    expect(reconcileGuild).toHaveBeenCalledTimes(1);
  });
});
