import { describe, expect, it } from 'vitest';
import type { AuthStatus } from '@avc/core';
import { fakeLogger } from '../runtime/testUtils.js';
import { PermissionProblemTracker } from '../features/voice/permissionProblems.js';
import {
  PermissionProblemNotifier,
  readNoticeState,
  type PermissionProblemNotifierOptions,
} from './permissionProblemNotifier.js';

const GUILD = '462606582367125509';
const CONTACT = '111111111111111111';
const OWNER = '222222222222222222';
const HOUR = 60 * 60 * 1000;

interface Sent {
  where: string;
  content: string;
  mentions: string[] | 'none';
}

/**
 * A fake Discord surface stubbing only what the notifier touches. There is no
 * shared fake Client in this repo (each test file builds the shape it needs),
 * so this follows `errorReporter.unit.test.ts`.
 */
function harness(
  over: {
    settings?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    authStatus?: AuthStatus;
    systemChannelId?: string | null;
    contactIsMember?: boolean;
    failChannels?: string[];
    failDm?: boolean;
    creators?: string[];
    flags?: Record<string, unknown>;
    ready?: boolean;
    /** Holds the first channel send open, so a race can be driven from outside. */
    hold?: boolean;
  } = {},
) {
  const sent: Sent[] = [];
  const failChannels = new Set(over.failChannels ?? []);
  const problems = new PermissionProblemTracker();

  let release = (): void => undefined;
  let reached = (): void => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const reachedSend = new Promise<void>((r) => {
    reached = r;
  });

  const channel = (id: string) => ({
    isTextBased: () => true,
    send: async (payload: { content: string; allowedMentions?: { users?: string[] } }) => {
      reached();
      if (over.hold) await held;
      if (failChannels.has(id)) throw new Error('Missing Permissions');
      sent.push({
        where: id,
        content: payload.content,
        mentions: payload.allowedMentions?.users ?? 'none',
      });
    },
  });

  const guild = {
    id: GUILD,
    name: 'Test Server',
    ownerId: OWNER,
    systemChannelId: over.systemChannelId === undefined ? 'sys-1' : over.systemChannelId,
    channels: { fetch: async (id: string) => channel(id) },
    members: {
      cache: { get: () => undefined },
      fetch: async () => {
        if (over.contactIsMember === false) throw new Error('Unknown Member');
        return { id: CONTACT };
      },
    },
  };

  const client = {
    isReady: () => over.ready !== false,
    guilds: { cache: { get: (id: string) => (id === GUILD ? guild : undefined) } },
    users: {
      fetch: async (id: string) => ({
        send: async (payload: { content: string }) => {
          if (over.failDm) throw new Error('Cannot send messages to this user');
          sent.push({ where: `dm:${id}`, content: payload.content, mentions: 'none' });
        },
      }),
    },
  };

  const stamped: { at: Date; sends: number }[] = [];
  const cleared: string[] = [];

  const opts: PermissionProblemNotifierOptions = {
    client: client as never,
    guilds: {
      ensure: async () => ({
        guildId: GUILD,
        authStatus: over.authStatus ?? 'active',
        settings: over.settings ?? { contact_user_id: CONTACT },
        metadata: over.metadata ?? {},
        ownerId: OWNER,
      }),
    } as never,
    store: {
      markProblemNotified: async (_g: string, at: Date, sends: number) => {
        stamped.push({ at, sends });
      },
      clearProblemNotified: async (g: string) => {
        cleared.push(g);
      },
    },
    problems,
    autoChannels: {
      listByGuild: async () => (over.creators ?? []).map((channelId) => ({ channelId })),
    } as never,
    flags: over.flags ? ({ getAll: async () => over.flags } as never) : undefined,
    selfHosted: false,
    logger: fakeLogger(),
    // No real waiting, and a controllable clock.
    wait: async () => undefined,
  };

  let clock = 1_000_000;
  opts.now = () => clock;

  const notifier = new PermissionProblemNotifier(opts);
  problems.onRecord = (guildId) => notifier.record(guildId);
  problems.onResolved = (guildId) => notifier.resolved(guildId);

  return {
    notifier,
    problems,
    sent,
    stamped,
    cleared,
    reachedSend,
    release: () => release(),
    advance: (ms: number) => {
      clock += ms;
    },
    break: (channelId: string, operation: 'create' | 'delete' = 'create') =>
      problems.record(GUILD, { channelId, operation, at: clock }),
  };
}

/**
 * A notifier serving many guilds at once, with the pacer's waits recorded
 * rather than slept. The clock does not advance while waits are recorded, which
 * is what makes the expected values a clean arithmetic series.
 */
function burstHarness(onWait: (ms: number) => void, over: { systemChannelId?: null } = {}) {
  const problems = new PermissionProblemTracker();
  const channel = {
    isTextBased: () => true,
    send: async () => undefined,
  };
  const guild = (id: string) => ({
    id,
    name: 'Test Server',
    ownerId: OWNER,
    systemChannelId: over.systemChannelId === null ? null : 'sys-1',
    channels: { fetch: async () => channel },
    members: { cache: { get: () => ({ id: CONTACT }) }, fetch: async () => ({ id: CONTACT }) },
  });
  const notifier = new PermissionProblemNotifier({
    client: {
      isReady: () => true,
      guilds: { cache: { get: (id: string) => guild(id) } },
      users: { fetch: async () => ({ send: async () => undefined }) },
    } as never,
    guilds: {
      ensure: async (guildId: string) => ({
        guildId,
        authStatus: 'active',
        settings: { contact_user_id: CONTACT },
        metadata: {},
        ownerId: OWNER,
      }),
    } as never,
    problems,
    autoChannels: { listByGuild: async () => [] } as never,
    selfHosted: false,
    logger: fakeLogger(),
    now: () => 1_000_000,
    wait: async (ms: number) => {
      onWait(ms);
    },
  });
  return {
    sendFor: (guildId: string) => {
      problems.record(guildId, { channelId: 'c', operation: 'create', at: 1_000_000 });
      return notifier.send(guildId);
    },
  };
}

describe('PermissionProblemNotifier delivery ladder', () => {
  it('posts in the system channel and mentions the recorded contact', async () => {
    const h = harness();
    h.break('creator-1');
    await h.notifier.send(GUILD);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.where).toBe('sys-1');
    expect(h.sent[0]!.content).toContain(`<@${CONTACT}>`);
    expect(h.sent[0]!.mentions).toEqual([CONTACT]);
    expect(h.sent[0]!.content).toContain('<#creator-1>');
  });

  it('falls back to a DM when the system channel refuses', async () => {
    const h = harness({ failChannels: ['sys-1'] });
    h.break('creator-1');
    await h.notifier.send(GUILD);

    expect(h.sent.map((s) => s.where)).toEqual([`dm:${CONTACT}`]);
    // A DM has no surrounding server, so it names the guild first.
    expect(h.sent[0]!.content.startsWith('**Test Server**')).toBe(true);
  });

  it('DMs the owner when the contact has left, but never mentions them', async () => {
    const h = harness({ contactIsMember: false });
    h.break('creator-1');
    await h.notifier.send(GUILD);

    // The ping is only ever for the recorded contact. The owner fallback is a
    // guess by construction, and a guess is not good enough to ping.
    expect(h.sent[0]!.mentions).toBe('none');
    expect(h.sent[0]!.content).not.toContain(`<@${OWNER}>`);
  });

  it('uses a creator channel last, unmentioned, preferring one that is not broken', async () => {
    const h = harness({
      systemChannelId: null,
      failDm: true,
      creators: ['creator-1', 'creator-2'],
    });
    h.break('creator-1');
    await h.notifier.send(GUILD);

    // creator-1 is the one in the incident, so it is tried last.
    expect(h.sent[0]!.where).toBe('creator-2');
    // Publicly visible, so it never carries the ping.
    expect(h.sent[0]!.mentions).toBe('none');
  });

  it('never posts in an arbitrary text channel', async () => {
    const h = harness({ systemChannelId: null, failDm: true, creators: [] });
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('undeliverable');
    expect(h.sent).toEqual([]);
  });

  it('posts without a mention in quiet mode', async () => {
    const h = harness({ settings: { contact_user_id: CONTACT, problem_alerts: 'quiet' } });
    h.break('creator-1');
    await h.notifier.send(GUILD);
    expect(h.sent[0]!.mentions).toBe('none');
  });
});

describe('PermissionProblemNotifier suppression', () => {
  it('says nothing when the guild turned it off', async () => {
    const h = harness({ settings: { contact_user_id: CONTACT, problem_alerts: 'off' } });
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    expect(h.sent).toEqual([]);
  });

  it.each(['expired', 'blocked'] as AuthStatus[])('says nothing to a %s guild', async (status) => {
    // `maybeCleanup` is reached for gated guilds on purpose, so this has to be
    // caught here. "Grant me a permission" is also just wrong for an audience
    // whose automation is paused for billing.
    const h = harness({ authStatus: status });
    h.break('creator-1', 'delete');
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    expect(h.sent).toEqual([]);
  });

  it.each([
    ['problems.notify_disabled', { 'problems.notify_disabled': true }],
    ['global.pause', { 'global.pause': true }],
  ])('honours the %s kill switch', async (_name, flags) => {
    const h = harness({ flags });
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    expect(h.sent).toEqual([]);
  });

  it('says nothing while the client is being torn down', async () => {
    // Otherwise every deploy burns a window for whatever was mid-flight.
    const h = harness({ ready: false });
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    expect(h.stamped).toEqual([]);
  });

  it('ignores incidents too old to still be happening', async () => {
    const h = harness();
    h.break('creator-1');
    h.advance(7 * HOUR);
    // The tracker never ages entries out, so a channel fixed hours ago would
    // otherwise be named in a message asserting it is broken now.
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    expect(h.sent).toEqual([]);
  });
});

describe('PermissionProblemNotifier backoff', () => {
  it('escalates 6h, 24h, 72h and then stops for good', async () => {
    const h = harness();
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');

    // Too soon.
    h.advance(5 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('skipped');

    // 6h: the second notice.
    h.advance(2 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');

    // 24h, not 6h, for the third.
    h.advance(7 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    h.advance(18 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');

    // 72h for the fourth...
    h.advance(73 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');

    // ...and then never again, however long it has been. A guild that has
    // ignored four notices over five days is not going to act on the fifth.
    h.advance(365 * 24 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    expect(h.sent).toHaveLength(4);
  });

  it('stamps on attempt even when nothing could be delivered', async () => {
    // The guild whose permissions are broken is the guild every rung fails
    // for, and also the guild the 5-minute sweep re-tests forever.
    const h = harness({ systemChannelId: null, failDm: true, creators: [] });
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('undeliverable');
    expect(h.stamped).toEqual([expect.objectContaining({ sends: 1 })]);
  });

  it('resumes the ladder from stored history rather than restarting it', async () => {
    // Otherwise every deploy re-notifies every broken guild in the fleet.
    const h = harness({
      metadata: {
        problems: { lastNotifiedAt: new Date(1_000_000 - HOUR).toISOString(), sends: 2 },
      },
    });
    h.break('creator-1');
    // Two already sent, so the next is due 24h after the last, not now.
    expect(await h.notifier.send(GUILD)).toBe('skipped');
    h.advance(25 * HOUR);
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');
    expect(h.stamped.at(-1)).toEqual(expect.objectContaining({ sends: 3 }));
  });

  it('treats a stamp nobody has refreshed in a month as a finished run', async () => {
    // The ladder ends in permanent silence and that stop is durable, while the
    // thing that lifts it is an in-memory event. A guild whose problem cleared
    // while no process held its state would otherwise keep a spent stamp
    // forever and never be told about anything again.
    const spent = new Date(1_000_000 - 40 * 24 * HOUR).toISOString();
    const h = harness({ metadata: { problems: { lastNotifiedAt: spent, sends: 4 } } });
    h.break('creator-1');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');
    expect(h.stamped.at(-1)).toEqual(expect.objectContaining({ sends: 1 }));
  });

  it('does not stamp a guild that was resolved while the send was in flight', async () => {
    // Both writes are fire-and-forget on the same row and the stamp is issued
    // last, so without a check it resurrects a history that had just been
    // cleared and silences the guild's next problem for free.
    const h = harness({ hold: true });
    h.break('creator-1');
    const inFlight = h.notifier.send(GUILD);
    // Wait until the send is genuinely mid-flight, then resolve the guild
    // underneath it, which is what a retry succeeding on the voice path does.
    await h.reachedSend;
    h.problems.clear(GUILD, 'creator-1');
    h.release();
    await inFlight;

    expect(h.cleared).toEqual([GUILD]);
    expect(h.stamped).toEqual([]);
  });

  it('forgets the history once the guild has no problems left', async () => {
    const h = harness();
    h.break('creator-1');
    await h.notifier.send(GUILD);
    h.problems.clear(GUILD, 'creator-1');
    expect(h.cleared).toEqual([GUILD]);

    // A fresh problem months later starts from the shortest interval again.
    h.break('creator-2');
    expect(await h.notifier.send(GUILD)).toBe('system_channel');
  });
});

describe('PermissionProblemNotifier aggregation', () => {
  it('sends one notice naming every channel, not one per incident', async () => {
    const h = harness();
    // A reconcile pass over a guild whose category permissions changed records
    // several failures in a row.
    h.break('creator-1');
    h.break('creator-2');
    h.break('creator-3', 'delete');
    await h.notifier.send(GUILD);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.content).toContain('<#creator-1>');
    expect(h.sent[0]!.content).toContain('<#creator-2>');
    expect(h.sent[0]!.content).toContain('<#creator-3>');
  });

  it('coalesces a burst into a single scheduled send', async () => {
    const h = harness();
    h.break('creator-1');
    h.break('creator-2');
    h.break('creator-3');
    // Three incidents in one guild, one pending timer, so one message.
    expect(h.notifier.snapshot()['pending']).toBe(1);
  });
});

describe('PermissionProblemNotifier pacing', () => {
  it('spaces a concurrent burst across guilds instead of sending it at once', async () => {
    // Sends are NOT serialised: every guild has its own coalesce timer, so a
    // fleet-wide event fires all of them in the same tick. The slot has to be
    // reserved before the await or they all read the same free slot, nobody
    // waits, and the whole burst leaves together.
    const waits: number[] = [];
    const h = burstHarness((ms) => waits.push(ms));

    await Promise.all(Array.from({ length: 10 }, (_, i) => h.sendFor(`guild-${i}`)));

    expect(waits).toHaveLength(9); // the first goes immediately
    expect(waits).toEqual([250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250]);
  });

  it('gates DMs far more slowly than channel posts', async () => {
    const waits: number[] = [];
    // No system channel, so every guild falls through to the DM rung.
    const h = burstHarness((ms) => waits.push(ms), { systemChannelId: null });

    await Promise.all(Array.from({ length: 3 }, (_, i) => h.sendFor(`guild-${i}`)));

    // Two gates. The general one hands out 250ms slots because it has to
    // reserve before it knows which rung will answer, and the DM rung then
    // books its own 3s slots on top: unsolicited DMs are what Discord's
    // anti-spam heuristics are built to catch, and announce.ts chose this rate
    // for the same act.
    expect(waits.filter((w) => w >= 3000)).toEqual([3000, 6000]);
  });
});

describe('readNoticeState', () => {
  it('reads what markProblemNotified writes, and rejects anything else', () => {
    expect(
      readNoticeState({ problems: { lastNotifiedAt: '2026-08-20T00:00:00.000Z', sends: 2 } }),
    ).toEqual({ lastNotifiedAt: Date.parse('2026-08-20T00:00:00.000Z'), sends: 2 });
    expect(readNoticeState({})).toBeUndefined();
    expect(readNoticeState({ problems: 'nonsense' })).toBeUndefined();
    expect(readNoticeState({ problems: { lastNotifiedAt: 'not a date' } })).toBeUndefined();
    // A stamp with no count is one that was written before the count existed.
    expect(readNoticeState({ problems: { lastNotifiedAt: '2026-08-20T00:00:00.000Z' } })).toEqual({
      lastNotifiedAt: Date.parse('2026-08-20T00:00:00.000Z'),
      sends: 1,
    });
  });
});
