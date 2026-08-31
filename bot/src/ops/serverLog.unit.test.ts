import { describe, expect, it, vi } from 'vitest';
import { ServerLogger } from './serverLog.js';

const LOG_CHANNEL = '234567890123456789';
const HOME_GUILD = '460459401086763010';

interface SentMessage {
  content: string;
}

/**
 * A client with two guilds, each holding one channel. The point of the fake is
 * that channel resolution goes *through* a guild, so a lookup that ignores the
 * guild would find the foreign channel and a lookup that respects it cannot.
 */
function fakeClient(opts: { homeHasChannel: boolean }) {
  const sent: Array<{ guild: string; message: SentMessage }> = [];
  const makeChannel = (guild: string) => ({
    isTextBased: () => true,
    send: (message: SentMessage) => {
      sent.push({ guild, message });
      return Promise.resolve({ edit: () => Promise.resolve() });
    },
  });

  const homeChannels = new Map(opts.homeHasChannel ? [[LOG_CHANNEL, makeChannel(HOME_GUILD)]] : []);
  // The same id exists in another guild. If resolution is global, this is what
  // gets found, because `client.channels` is keyed by channel id alone.
  const foreignChannels = new Map([[LOG_CHANNEL, makeChannel('other-guild')]]);

  const guildManager = (channels: Map<string, unknown>) => ({
    channels: {
      cache: { get: (id: string) => channels.get(id) },
      fetch: (id: string) => {
        const hit = channels.get(id);
        // Discord.js rejects a channel owned by another guild rather than
        // returning it, which is the behaviour the fix leans on.
        return hit ? Promise.resolve(hit) : Promise.reject(new Error('GuildChannelUnowned'));
      },
    },
    members: { fetch: () => Promise.reject(new Error('no member')) },
  });

  return {
    sent,
    client: {
      guilds: {
        cache: {
          get: (id: string) =>
            id === HOME_GUILD ? guildManager(homeChannels) : guildManager(foreignChannels),
        },
      },
      // Present so a regression back to the global path resolves and posts,
      // making this test fail loudly instead of silently passing.
      channels: { fetch: (id: string) => Promise.resolve(foreignChannels.get(id) ?? null) },
    },
  };
}

function loggerFor(client: unknown, settings: Record<string, unknown>) {
  return new ServerLogger({
    client: client as never,
    guilds: {
      ensure: () => Promise.resolve({ guildId: HOME_GUILD, settings } as never),
    } as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
}

/** `log` is fire and forget, so give the floated promise a turn to settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ServerLogger', () => {
  it('posts to the log channel when it belongs to this guild', async () => {
    const { client, sent } = fakeClient({ homeHasChannel: true });
    loggerFor(client, { logging: LOG_CHANNEL, log_level: 2 }).log(
      HOME_GUILD,
      1,
      'a thing happened',
    );
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.guild).toBe(HOME_GUILD);
  });

  /**
   * The reason this file exists. `client.channels.fetch` is global, so a stored
   * id naming a channel in another server used to resolve and get posted to.
   * Only `/import` can write such an id, and at level 3 the stream is every
   * join and leave in every managed channel.
   */
  it('posts nowhere when the configured channel is not in this guild', async () => {
    const { client, sent } = fakeClient({ homeHasChannel: false });
    loggerFor(client, { logging: LOG_CHANNEL, log_level: 3 }).log(
      HOME_GUILD,
      1,
      'a thing happened',
    );
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('posts nowhere when the configured id is not a snowflake', async () => {
    const { client, sent } = fakeClient({ homeHasChannel: true });
    loggerFor(client, { logging: 'not-an-id', log_level: 3 }).log(
      HOME_GUILD,
      1,
      'a thing happened',
    );
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('stays quiet when the event is above the configured level', async () => {
    const { client, sent } = fakeClient({ homeHasChannel: true });
    loggerFor(client, { logging: LOG_CHANNEL, log_level: 1 }).log(HOME_GUILD, 3, 'a member joined');
    await settle();
    expect(sent).toHaveLength(0);
  });
});
