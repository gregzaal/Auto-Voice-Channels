import { DiscordAPIError } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
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
