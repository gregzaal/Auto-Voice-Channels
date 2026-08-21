import { describe, expect, it, vi } from 'vitest';
import {
  AdminChannelReporter,
  RecordingErrorReporter,
  TeeErrorReporter,
  type ErrorReporter,
} from './errorReporter.js';

const logger = {
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof AdminChannelReporter.prototype.constructor>[0]['logger'];

/**
 * A `client.rest.post` whose call resolves (or rejects) when we say so, to
 * control the in-flight window and simulate every REST failure mode
 * (channel gone, wrong type, network error) as one shape - the reporter
 * itself no longer distinguishes them, deliberately (`errorReporter.ts`'s
 * `send` doc).
 */
function fakeClient(opts: { fails?: boolean; send?: () => Promise<void> } = {}) {
  const sent: string[] = [];
  return {
    sent,
    client: {
      rest: {
        post: async (_route: unknown, { body }: { body: { content: string } }) => {
          if (opts.fails) throw new Error('channel not found or not messageable');
          sent.push(body.content);
          if (opts.send) await opts.send();
        },
      },
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
      rest: {
        post: async () => {
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
   * Pointing ADMIN_CHANNEL_ID at a channel that doesn't exist, or one Discord
   * refuses a message post to (a category, a voice channel with no text
   * chat), used to disable alerting completely, silently, with no log
   * anywhere. There is deliberately no way from here to tell those causes
   * apart from a channel this instance's shard just doesn't have cached
   * (`errorReporter.ts`'s `send` doc) - all three reach Discord as a REST
   * call, and all three must log the same way when it fails.
   */
  it('logs rather than silently dropping when the REST post fails', async () => {
    const { client } = fakeClient({ fails: true });
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

describe('RecordingErrorReporter', () => {
  function setup(opts: { send?: () => Promise<void>; throttleMs?: number } = {}) {
    const { client, sent } = fakeClient(opts.send ? { send: opts.send } : {});
    const channel = new AdminChannelReporter({
      client,
      channelId: 'c',
      logger,
      throttleMs: opts.throttleMs ?? 0,
    });
    const marks: string[] = [];
    let nextId = 1;
    const alerts = {
      raise: async () => ({ opened: true, id: nextId++ }),
      markDelivered: async (id: number) => void marks.push(`delivered:${id}`),
      markDeliveryFailed: async (id: number) => void marks.push(`failed:${id}`),
    } as never;
    const reporter = new RecordingErrorReporter({
      alerts,
      channel,
      logger,
      instanceId: 'inst-a',
    });
    return { reporter, sent, marks };
  }

  it('posts to Discord and marks the row delivered', async () => {
    const { reporter, sent, marks } = setup();
    reporter.report('db.ping', 'Database down');
    await flush();
    expect(sent).toHaveLength(1);
    expect(marks).toEqual(['delivered:1']);
  });

  it('marks the row failed when the post fails', async () => {
    const client = {
      channels: {
        fetch: async () => {
          throw new Error('nope');
        },
      },
    } as never;
    const channel = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 0 });
    const marks: string[] = [];
    const reporter = new RecordingErrorReporter({
      alerts: {
        raise: async () => ({ opened: true, id: 7 }),
        markDelivered: async () => void marks.push('delivered'),
        markDeliveryFailed: async () => void marks.push('failed'),
      } as never,
      channel,
      logger,
      instanceId: 'inst-a',
    });
    reporter.report('db.ping', 'Database down');
    await flush();
    expect(marks).toEqual(['failed']);
  });

  /**
   * The channel throttles per KIND while a row is keyed (fleet, key, target), so
   * two guilds hitting one condition inside a window are two rows and one
   * message. Reporting the suppressed one as delivered would lose it forever.
   */
  it('leaves a throttle-suppressed row undelivered so the retry loop finds it', async () => {
    const { reporter, sent, marks } = setup({ throttleMs: 60_000 });
    reporter.report('reconcile.failed', 'guild a');
    await flush();
    reporter.report('reconcile.failed', 'guild b');
    await flush();
    expect(sent).toHaveLength(1);
    expect(marks).toEqual(['delivered:1']);
  });

  /**
   * The whole reason this is not a write-then-drain queue: the outage it exists
   * for was the database being unreachable, so the post must never wait on it.
   */
  it('still posts to Discord when the database write fails', async () => {
    const { client, sent } = fakeClient();
    const channel = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 0 });
    const warn = vi.fn();
    const reporter = new RecordingErrorReporter({
      alerts: {
        raise: async () => {
          throw new Error('db unreachable');
        },
      } as never,
      channel,
      logger: { ...logger, warn } as never,
      instanceId: 'inst-a',
    });
    reporter.report('db.ping', 'Database down');
    await flush();
    expect(sent).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('stamps the raising instance, so reconciliation can scope to it', async () => {
    const { client } = fakeClient();
    const channel = new AdminChannelReporter({ client, channelId: 'c', logger, throttleMs: 0 });
    let seen: Record<string, unknown> | undefined;
    const reporter = new RecordingErrorReporter({
      alerts: {
        raise: async (input: { details?: Record<string, unknown> }) => {
          seen = input.details;
          return { opened: true, id: 1 };
        },
        markDelivered: async () => {},
        markDeliveryFailed: async () => {},
      } as never,
      channel,
      logger,
      instanceId: 'inst-a',
    });
    reporter.report('db.ping', 'x', { guildId: 'g1' });
    await flush();
    expect(seen).toMatchObject({ instance: 'inst-a', guildId: 'g1' });
  });
});
