import { describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import { AdminChannelReporter, TeeErrorReporter, type ErrorReporter } from './errorReporter.js';

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof AdminChannelReporter.prototype.constructor>[0]['logger'];

/** A channel whose send resolves when we say so, to control the in-flight window. */
function fakeClient(opts: { type?: number; send?: () => Promise<void>; missing?: boolean } = {}) {
  const sent: string[] = [];
  const channel = {
    type: opts.type ?? ChannelType.GuildText,
    send: async ({ content }: { content: string }) => {
      sent.push(content);
      if (opts.send) await opts.send();
    },
  };
  return {
    sent,
    client: {
      channels: { fetch: async () => (opts.missing ? null : channel) },
    } as never,
  };
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe('AdminChannelReporter', () => {
  it('sends the first report of a kind', async () => {
    const { client, sent } = fakeClient();
    new AdminChannelReporter({ client, channelId: 'c', logger }).report('db.ping', 'Database down');
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Database down');
  });

  /**
   * The throttle used to be a single global window, so a backup failure two
   * seconds after a gateway error was silently discarded. Unrelated conditions
   * must not be able to hide each other.
   */
  it('does not let one kind throttle a different kind', async () => {
    const { client, sent } = fakeClient();
    const r = new AdminChannelReporter({ client, channelId: 'c', logger });
    r.report('gateway.error', 'a');
    await flush();
    r.report('db.ping', 'b');
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('throttles repeats of the same kind and reports the suppressed count', async () => {
    const { client, sent } = fakeClient();
    const r = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 60_000 });
    r.report('db.ping', 'first');
    await flush();
    r.report('db.ping', 'second');
    r.report('db.ping', 'third');
    await flush();
    expect(sent).toHaveLength(1);

    // A later window carries the count of what it swallowed.
    const r2 = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 0 });
    r2.report('k', 'one');
    await flush();
    r2.report('k', 'two');
    await flush();
    expect(sent.at(-1)).toContain('two');
  });

  /**
   * The default window, which is the one production actually runs with.
   *
   * It was five SECONDS, which is not a throttle for any source here: every
   * one of them is a repeating check, so a sustained outage would have posted
   * a message every few seconds for as long as it lasted. Nothing asserted the
   * default, so nothing would have caught it going back.
   */
  it('throttles a repeat under the default window, with no throttleMs given', async () => {
    const { client, sent } = fakeClient();
    const r = new AdminChannelReporter({ client, channelId: 'c', logger });
    r.report('sustained', 'first');
    await flush();
    r.report('sustained', 'second');
    await flush();
    expect(sent).toHaveLength(1);
  });

  /**
   * The burst gate. Without a synchronous in-flight flag, every report arriving
   * during the Discord round trip reads the pre-send timestamp, passes the time
   * gate and fires its own request, which is not a throttle at all.
   */
  it('suppresses a burst that arrives while a send is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { client, sent } = fakeClient({ send: () => gate });
    const r = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 0 });

    r.report('storm', '1');
    await new Promise((res) => setTimeout(res, 0));
    r.report('storm', '2');
    r.report('storm', '3');
    r.report('storm', '4');
    expect(sent).toHaveLength(1);

    release();
    await flush();
    expect(sent).toHaveLength(1);
  });

  /**
   * A channel that never accepts a message must still back off. Arming the rate
   * gate only on success meant a permanently broken channel got NO throttling:
   * every report retried immediately, turning an error storm into an equal-rate
   * storm of failing REST calls during an incident.
   */
  it('backs off even when every send fails', async () => {
    const attempts: number[] = [];
    const client = {
      channels: {
        fetch: async () => {
          attempts.push(Date.now());
          throw new Error('nope');
        },
      },
    } as never;
    const r = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 60_000 });
    r.report('broken', 'a');
    await flush();
    r.report('broken', 'b');
    r.report('broken', 'c');
    await flush();
    expect(attempts).toHaveLength(1);
  });

  /**
   * Pointing ADMIN_CHANNEL_ID at a thread, forum or voice text chat used to
   * disable alerting completely, silently, with no log anywhere.
   */
  it('logs rather than silently dropping when the channel is not a text channel', async () => {
    const { client } = fakeClient({ type: ChannelType.GuildVoice });
    const warn = vi.fn();
    const r = new AdminChannelReporter({
      client,
      channelId: 'c',
      logger: { ...logger, warn } as never,
    });
    r.report('k', 'm');
    await flush();
    expect(warn).toHaveBeenCalled();
  });

  it('logs when the channel cannot be found at all', async () => {
    const { client } = fakeClient({ missing: true });
    const warn = vi.fn();
    const r = new AdminChannelReporter({
      client,
      channelId: 'c',
      logger: { ...logger, warn } as never,
    });
    r.report('k', 'm');
    await flush();
    expect(warn).toHaveBeenCalled();
  });
});

describe('TeeErrorReporter', () => {
  it('reports to every reporter', () => {
    const a: string[] = [];
    const b: string[] = [];
    const tee = new TeeErrorReporter([
      { report: (k) => a.push(k) } as ErrorReporter,
      { report: (k) => b.push(k) } as ErrorReporter,
    ]);
    tee.report('k', 'm');
    expect(a).toEqual(['k']);
    expect(b).toEqual(['k']);
  });

  /** A record that throws must not cost us the notification, or vice versa. */
  it('a throwing reporter does not stop its siblings', () => {
    const seen: string[] = [];
    const tee = new TeeErrorReporter([
      {
        report: () => {
          throw new Error('persist failed');
        },
      } as ErrorReporter,
      { report: (k) => seen.push(k) } as ErrorReporter,
    ]);
    expect(() => tee.report('k', 'm')).not.toThrow();
    expect(seen).toEqual(['k']);
  });
});
