import { describe, expect, it, vi } from 'vitest';
import type { Client, Guild } from 'discord.js';
import type { GuildRepository, Logger } from '@avc/core';
import { backfillGuildIdentities, registerGuildIdentity } from './guildIdentity.js';

function fakeLogger(): Logger {
  const noop = (): void => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => fakeLogger(),
  } as unknown as Logger;
}

/** A minimal event-emitter stand-in for the discord.js client. */
function fakeClient(guilds: Guild[] = []) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    on(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((f) => f !== fn),
      );
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    guilds: { cache: { values: () => guilds.values() } },
    listenerCount: (event: string) => (handlers.get(event) ?? []).length,
  };
}

function guild(id: string, name: string, icon: string | null, ownerId: string): Guild {
  return { id, name, icon, ownerId } as unknown as Guild;
}

describe('registerGuildIdentity', () => {
  it('records identity on guildCreate', async () => {
    const recordIdentity = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient();
    registerGuildIdentity({
      client: client as unknown as Client,
      guilds: { recordIdentity } as unknown as GuildRepository,
      logger: fakeLogger(),
    });

    client.emit('guildCreate', guild('1', 'Test Server', 'abc123', '99'));
    await vi.waitFor(() => expect(recordIdentity).toHaveBeenCalledTimes(1));
    expect(recordIdentity).toHaveBeenCalledWith('1', {
      name: 'Test Server',
      iconHash: 'abc123',
      ownerId: '99',
    });
  });

  it('records the AFTER guild on guildUpdate, not the stale one', async () => {
    const recordIdentity = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient();
    registerGuildIdentity({
      client: client as unknown as Client,
      guilds: { recordIdentity } as unknown as GuildRepository,
      logger: fakeLogger(),
    });

    client.emit(
      'guildUpdate',
      guild('1', 'Old Name', null, '99'),
      guild('1', 'New Name', 'icon', '99'),
    );
    await vi.waitFor(() => expect(recordIdentity).toHaveBeenCalledTimes(1));
    expect(recordIdentity).toHaveBeenCalledWith('1', {
      name: 'New Name',
      iconHash: 'icon',
      ownerId: '99',
    });
  });

  /**
   * The whole point of the per-guild boundary: a guild whose name we cannot
   * write must still get its voice channels. A rejected write here has to stay
   * swallowed, never escalate into an unhandled rejection.
   */
  it('swallows a repository failure', async () => {
    const recordIdentity = vi.fn().mockRejectedValue(new Error('db down'));
    const client = fakeClient();
    registerGuildIdentity({
      client: client as unknown as Client,
      guilds: { recordIdentity } as unknown as GuildRepository,
      logger: fakeLogger(),
    });

    expect(() => client.emit('guildCreate', guild('1', 'Test', null, '9'))).not.toThrow();
    await vi.waitFor(() => expect(recordIdentity).toHaveBeenCalled());
  });

  it('detaches both listeners on dispose', () => {
    const client = fakeClient();
    const dispose = registerGuildIdentity({
      client: client as unknown as Client,
      guilds: { recordIdentity: vi.fn() } as unknown as GuildRepository,
      logger: fakeLogger(),
    });
    expect(client.listenerCount('guildCreate')).toBe(1);
    expect(client.listenerCount('guildUpdate')).toBe(1);
    dispose();
    expect(client.listenerCount('guildCreate')).toBe(0);
    expect(client.listenerCount('guildUpdate')).toBe(0);
  });
});

describe('backfillGuildIdentities', () => {
  it('records every cached guild', async () => {
    const recordIdentity = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient([guild('1', 'A', null, '9'), guild('2', 'B', 'ic', '8')]);

    const recorded = await backfillGuildIdentities({
      client: client as unknown as Client,
      guilds: { recordIdentity } as unknown as GuildRepository,
      logger: fakeLogger(),
    });

    expect(recorded).toBe(2);
    expect(recordIdentity).toHaveBeenCalledWith('2', { name: 'B', iconHash: 'ic', ownerId: '8' });
  });

  /** One bad guild must not abort the backfill for every guild after it. */
  it('continues past a failing guild', async () => {
    const recordIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValue(undefined);
    const client = fakeClient([guild('1', 'A', null, '9'), guild('2', 'B', null, '8')]);

    const recorded = await backfillGuildIdentities({
      client: client as unknown as Client,
      guilds: { recordIdentity } as unknown as GuildRepository,
      logger: fakeLogger(),
    });

    expect(recorded).toBe(1);
    expect(recordIdentity).toHaveBeenCalledTimes(2);
  });
});
