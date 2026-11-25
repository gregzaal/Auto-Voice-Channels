import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  CHANNEL_LIMIT_COOLDOWN_MS,
  ChannelLimitTracker,
  channelLimitMemberMessage,
  LIMIT_MESSAGE_TTL_MS,
  LIMIT_TOLD_MS,
  type LimitChat,
} from './channelLimits.js';

const GUILD = 'g1';
const CREATOR = 'creator-1';

function harness(opts: { failEdit?: boolean } = {}) {
  let now = 1_000_000_000;
  const calls: string[] = [];
  let seq = 0;
  const chat: LimitChat = {
    send: (channelId, _content, mentionId) => {
      calls.push(`send ${channelId} ${mentionId}`);
      return Promise.resolve(`m${++seq}`);
    },
    edit: (channelId, messageId, _content, mentionId) => {
      calls.push(`edit ${channelId} ${messageId} ${mentionId}`);
      return opts.failEdit ? Promise.reject(new Error('Unknown Message')) : Promise.resolve();
    },
    remove: (channelId, messageId) => {
      calls.push(`remove ${channelId} ${messageId}`);
      return Promise.resolve();
    },
  };
  const tracker = new ChannelLimitTracker({ chat, logger: fakeLogger(), now: () => now });
  return {
    tracker,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ChannelLimitTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cools a creator channel down for a couple of minutes, then lets a create ask again', () => {
    const h = harness();
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(true);
    expect(h.tracker.coolingDown(CREATOR)).toBe('category');
    h.advance(CHANNEL_LIMIT_COOLDOWN_MS - 1);
    expect(h.tracker.coolingDown(CREATOR)).toBe('category');
    h.advance(1);
    expect(h.tracker.coolingDown(CREATOR)).toBe(undefined);
    expect(h.tracker.coolingDown('another')).toBe(undefined);
  });

  it('says a refusal is news once per incident, and again for the other limit', () => {
    const h = harness();
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(true);
    h.advance(CHANNEL_LIMIT_COOLDOWN_MS);
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(false);
    expect(h.tracker.refused(GUILD, CREATOR, 'server')).toBe(true);
  });

  it('deletes the message on its own once it has been up long enough', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tracker.tellMember(CREATOR, 'alice', true);
    expect(h.calls).toEqual([`send ${CREATOR} alice`]);

    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    expect(h.calls).toEqual([`send ${CREATOR} alice`, `remove ${CREATOR} m1`]);
    expect(h.tracker.snapshot()['messages']).toBe(0);
  });

  it('keeps the message up for its full time again when it is edited', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tracker.tellMember(CREATOR, 'alice', true);
    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS - 1000);
    await h.tracker.tellMember(CREATOR, 'bob', true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).not.toContain(`remove ${CREATOR} m1`);
    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    expect(h.calls).toContain(`remove ${CREATOR} m1`);
  });

  it('does not edit for the member it already mentions', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tracker.tellMember(CREATOR, 'alice', true);
    await h.tracker.tellMember(CREATOR, 'alice', true);
    expect(h.calls).toEqual([`send ${CREATOR} alice`]);
  });

  it('lets the sweep tell a member again only once they have been told a while ago', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tracker.tellMember(CREATOR, 'alice', true);
    await h.tracker.tellMember(CREATOR, 'bob', true);
    await h.tracker.tellMember(CREATOR, 'alice', false);
    expect(h.calls).toHaveLength(2);

    h.advance(LIMIT_TOLD_MS);
    await h.tracker.tellMember(CREATOR, 'alice', false);
    expect(h.calls).toHaveLength(3);
  });

  it('posts again when the message it would edit was deleted by somebody', async () => {
    const h = harness({ failEdit: true });
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tracker.tellMember(CREATOR, 'alice', true);
    await h.tracker.tellMember(CREATOR, 'bob', true);
    expect(h.calls).toEqual([
      `send ${CREATOR} alice`,
      `edit ${CREATOR} m1 bob`,
      `send ${CREATOR} bob`,
    ]);
    expect(h.tracker.snapshot()['messages']).toBe(1);
  });

  it('posts nothing for a creator channel it has no refusal for', async () => {
    const h = harness();
    await h.tracker.tellMember(CREATOR, 'alice', true);
    expect(h.calls).toEqual([]);
  });

  it('ends the cooldowns of one server only when a channel there is deleted', () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.refused('g2', 'creator-2', 'server');
    h.tracker.releaseGuild(GUILD);
    expect(h.tracker.coolingDown(CREATOR)).toBe(undefined);
    expect(h.tracker.coolingDown('creator-2')).toBe('server');
  });

  it('deletes the message and forgets the channel once a room is made', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tracker.tellMember(CREATOR, 'alice', true);
    await h.tracker.resolved(CREATOR);
    expect(h.calls).toEqual([`send ${CREATOR} alice`, `remove ${CREATOR} m1`]);
    expect(h.tracker.coolingDown(CREATOR)).toBe(undefined);
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(true);
    // The expiry timer was cancelled, so nothing is deleted twice.
    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    expect(h.calls.filter((c) => c.startsWith('remove'))).toHaveLength(1);
  });

  it('forgets a creator channel nobody has been refused or told about for a while', () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.advance(LIMIT_TOLD_MS);
    h.tracker.refused(GUILD, 'creator-2', 'category');
    expect(h.tracker.snapshot()['creatorChannels']).toBe(1);
  });

  it('never throws when the chat refuses everything', async () => {
    const tracker = new ChannelLimitTracker({
      chat: {
        send: () => Promise.reject(new Error('Missing Permissions')),
        edit: () => Promise.reject(new Error('x')),
        remove: () => Promise.reject(new Error('x')),
      },
      noticesDisabled: () => Promise.reject(new Error('db down')),
      logger: fakeLogger(),
    });
    tracker.refused(GUILD, CREATOR, 'server');
    await expect(tracker.tellMember(CREATOR, 'alice', true)).resolves.toBeUndefined();
    await expect(tracker.resolved(CREATOR)).resolves.toBeUndefined();
  });
});

/** The project's copy rules, over every string this module renders. */
describe('channel limit copy rules', () => {
  const every = [
    channelLimitMemberMessage('123', 'category'),
    channelLimitMemberMessage('123', 'server'),
  ];

  it('mentions only the member, first', () => {
    for (const msg of every) expect(msg.startsWith('<@123> ')).toBe(true);
    for (const msg of every) expect(msg.match(/<[@#&]/g)).toHaveLength(1);
  });

  it('uses no em or en dashes, curly quotes or semicolons', () => {
    for (const msg of every) expect(msg).not.toMatch(/[—–‘’“”;]/);
  });

  it('says room, not channel, for what the member was waiting for', () => {
    for (const msg of every) expect(msg).toContain("I couldn't make your room");
  });
});
