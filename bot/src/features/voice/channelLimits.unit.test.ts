import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  CHANNEL_LIMIT_COOLDOWN_MS,
  ChannelLimitTracker,
  channelLimitMemberMessage,
  LIMIT_MESSAGE_TTL_MS,
  LIMIT_QUIET_MS,
  LIMIT_TOLD_MS,
  MAX_LIMIT_MENTIONS,
  type LimitChat,
} from './channelLimits.js';

const GUILD = 'g1';
const CREATOR = 'creator-1';

function harness(opts: { serves?: (guildId: string) => boolean } = {}) {
  let now = 1_000_000_000;
  /** Each post as `send <channel> <pinged ids>`, and each delete. */
  const calls: string[] = [];
  const contents: string[] = [];
  let seq = 0;
  const chat: LimitChat = {
    send: (channelId, content, pingIds) => {
      calls.push(`send ${channelId} ${pingIds.join(',')}`);
      contents.push(content);
      return Promise.resolve(`m${++seq}`);
    },
    remove: (channelId, messageId) => {
      calls.push(`remove ${channelId} ${messageId}`);
      return Promise.resolve();
    },
  };
  const tracker = new ChannelLimitTracker({
    chat,
    logger: fakeLogger(),
    now: () => now,
    ...(opts.serves ? { serves: opts.serves } : {}),
  });
  const settled: string[] = [];
  tracker.onSettled = (_g, creatorId) => settled.push(creatorId);
  return {
    tracker,
    calls,
    contents,
    settled,
    advance: (ms: number) => {
      now += ms;
    },
    tell: async (memberId: string, waiting: string[], joined = true) => {
      tracker.tellMember(CREATOR, memberId, waiting, joined);
      await tracker.idle();
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
    expect(h.tracker.isCoolingDown(CREATOR)).toBe(true);
    h.advance(CHANNEL_LIMIT_COOLDOWN_MS - 1);
    expect(h.tracker.coolingDown(CREATOR)).toBe('category');
    h.advance(1);
    expect(h.tracker.coolingDown(CREATOR)).toBe(undefined);
    expect(h.tracker.coolingDown('another')).toBe(undefined);
    // Only the skips the create path counts, not the sweep's look.
    expect(h.tracker.snapshot()['skipped']).toBe(2);
  });

  it('says a refusal is news once per incident, and again for the other limit', () => {
    const h = harness();
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(true);
    h.advance(CHANNEL_LIMIT_COOLDOWN_MS);
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(false);
    expect(h.tracker.refused(GUILD, CREATOR, 'server')).toBe(true);
  });

  /**
   * A busy category hovers at its limit as rooms come and go. A room made between two refusals
   * must not end the incident, or each refusal is a fresh first notice.
   */
  it('keeps one incident across a room made and a refusal inside the quiet window', () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.roomMade(CREATOR);
    expect(h.tracker.isCoolingDown(CREATOR)).toBe(false);
    h.advance(LIMIT_QUIET_MS - 1);
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(false);
    expect(h.settled).toEqual([]);
  });

  it('ends the incident after the quiet window, on its timer', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.advance(60_000);
    h.tracker.roomMade(CREATOR);
    await vi.advanceTimersByTimeAsync(LIMIT_QUIET_MS - 60_000 - 1);
    expect(h.settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.settled).toEqual([CREATOR]);
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(true);
  });

  it('ends the incident when the next refusal comes after the quiet window', () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.roomMade(CREATOR);
    h.advance(LIMIT_QUIET_MS);
    expect(h.tracker.refused(GUILD, CREATOR, 'category')).toBe(true);
    expect(h.settled).toEqual([CREATOR]);
  });

  it('a refusal stops the quiet window, so its timer ends nothing', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.roomMade(CREATOR);
    h.tracker.refused(GUILD, CREATOR, 'category');
    await vi.advanceTimersByTimeAsync(LIMIT_QUIET_MS * 2);
    expect(h.settled).toEqual([]);
  });

  it('deletes the message on its own once it has been up long enough', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    expect(h.calls).toEqual([`send ${CREATOR} alice`]);

    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    await h.tracker.idle();
    expect(h.calls).toEqual([`send ${CREATOR} alice`, `remove ${CREATOR} m1`]);
    expect(h.tracker.snapshot()['messages']).toBe(0);
  });

  /** An edit that adds a mention notifies nobody, so a new member gets a new message. */
  it('replaces the message for a new member, naming everyone and pinging only the new one', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    await h.tell('bob', ['alice', 'bob']);
    expect(h.calls).toEqual([
      `send ${CREATOR} alice`,
      `send ${CREATOR} bob`,
      `remove ${CREATOR} m1`,
    ]);
    expect(h.contents[1]).toMatch(/^<@bob> <@alice> I couldn't make your rooms /);
    expect(h.tracker.snapshot()['messages']).toBe(1);
  });

  /** A category hovering at its limit must not ping the same people on every join. */
  it('does not ping a member again after a room is made and the category fills again', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    h.tracker.roomMade(CREATOR);
    h.advance(CHANNEL_LIMIT_COOLDOWN_MS);
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('bob', ['alice', 'bob']);
    expect(h.calls.filter((c) => c.startsWith('send'))).toEqual([
      `send ${CREATOR} alice`,
      `send ${CREATOR} bob`,
    ]);
  });

  it('says nothing for a member the message already mentions', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    await h.tell('alice', ['alice']);
    await h.tell('alice', ['alice'], false);
    expect(h.calls).toEqual([`send ${CREATOR} alice`]);
  });

  it('lets the sweep post again only for someone not told lately', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    await h.tracker.idle();
    // The message has expired, and alice was told a few minutes ago.
    await h.tell('alice', ['alice'], false);
    expect(h.calls).toHaveLength(2);

    h.advance(LIMIT_TOLD_MS);
    await h.tell('alice', ['alice'], false);
    expect(h.calls).toHaveLength(3);
  });

  it('caps how many members one message mentions, the joining member first', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    const waiting = Array.from({ length: 30 }, (_, i) => `m${i}`);
    await h.tell('m29', waiting);
    const mentioned = h.contents[0]!.match(/<@m\d+>/g)!.map((m) => m.slice(2, -1));
    expect(mentioned).toHaveLength(MAX_LIMIT_MENTIONS);
    expect(mentioned[0]).toBe('m29');
  });

  it('posts nothing for a creator channel it has no refusal for', async () => {
    const h = harness();
    await h.tell('alice', ['alice']);
    expect(h.calls).toEqual([]);
  });

  it('takes the message down at once when a room is made', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    h.tracker.roomMade(CREATOR);
    await h.tracker.idle();
    expect(h.calls).toEqual([`send ${CREATOR} alice`, `remove ${CREATOR} m1`]);
    // The expiry timer was cancelled, so nothing is deleted twice.
    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    await h.tracker.idle();
    expect(h.calls.filter((c) => c.startsWith('remove'))).toHaveLength(1);
  });

  it('posts nothing when the room is made before its turn comes', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.tellMember(CREATOR, 'alice', ['alice'], true);
    h.tracker.roomMade(CREATOR);
    await h.tracker.idle();
    expect(h.calls).toEqual([]);
  });

  /**
   * `serves` is false for a lease that could not be refreshed, too. The incident is kept, not
   * dropped, or nothing would ever clear the guild's problem entry, and the next sweep settles it.
   */
  it('keeps an incident while the guild cannot be proven served, and settles it later', async () => {
    let serving = true;
    const h = harness({ serves: () => serving });
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.roomMade(CREATOR);
    serving = false;
    await vi.advanceTimersByTimeAsync(LIMIT_QUIET_MS);
    h.advance(LIMIT_QUIET_MS);
    h.tracker.expire();
    expect(h.settled).toEqual([]);
    expect(h.tracker.snapshot()['creatorChannels']).toBe(1);

    serving = true;
    h.tracker.expire();
    expect(h.settled).toEqual([CREATOR]);
    expect(h.tracker.snapshot()['creatorChannels']).toBe(0);
  });

  it('ends an idle incident when the sweep asks, with nothing else happening', () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.tracker.expire();
    expect(h.settled).toEqual([]);
    h.advance(LIMIT_TOLD_MS);
    h.tracker.expire();
    expect(h.settled).toEqual([CREATOR]);
  });

  describe('release', () => {
    const categories: Record<string, string> = { [CREATOR]: 'cat-a', 'creator-2': 'cat-b' };
    const categoryOf = (id: string) => categories[id];

    it('ends a full category only for a channel deleted from that category', () => {
      const h = harness();
      h.tracker.refused(GUILD, CREATOR, 'category');
      h.tracker.refused(GUILD, 'creator-2', 'category');
      expect(h.tracker.release(GUILD, 'cat-b', categoryOf)).toEqual(['creator-2']);
      expect(h.tracker.isCoolingDown(CREATOR)).toBe(true);
      expect(h.tracker.isCoolingDown('creator-2')).toBe(false);
    });

    it('ends a full server for any channel deleted there, and only there', () => {
      const h = harness();
      h.tracker.refused(GUILD, CREATOR, 'server');
      h.tracker.refused('g2', 'creator-2', 'server');
      expect(h.tracker.release(GUILD, null, categoryOf)).toEqual([CREATOR]);
      expect(h.tracker.isCoolingDown('creator-2')).toBe(true);
    });

    /** A room made and discarded again deletes a channel too, which must not start the next. */
    it('releases once per refusal', () => {
      const h = harness();
      h.tracker.refused(GUILD, CREATOR, 'category');
      expect(h.tracker.release(GUILD, 'cat-a', categoryOf)).toEqual([CREATOR]);
      expect(h.tracker.release(GUILD, 'cat-a', categoryOf)).toEqual([]);
      h.tracker.refused(GUILD, CREATOR, 'category');
      expect(h.tracker.release(GUILD, 'cat-a', categoryOf)).toEqual([CREATOR]);
    });

    it('releases a full category when either category is unknown', () => {
      const h = harness();
      h.tracker.refused(GUILD, CREATOR, 'category');
      expect(h.tracker.release(GUILD, undefined, categoryOf)).toEqual([CREATOR]);
      h.tracker.refused(GUILD, 'creator-3', 'category');
      expect(h.tracker.release(GUILD, 'cat-z', categoryOf)).toEqual(['creator-3']);
    });
  });

  it('forgets a creator channel nobody has been refused or told about for a while', () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    h.advance(LIMIT_TOLD_MS);
    h.tracker.refused(GUILD, 'creator-2', 'category');
    expect(h.tracker.snapshot()['creatorChannels']).toBe(1);
    expect(h.settled).toEqual([CREATOR]);
  });

  it('trims members told long ago while refusals go on', async () => {
    const h = harness();
    h.tracker.refused(GUILD, CREATOR, 'category');
    await h.tell('alice', ['alice']);
    await vi.advanceTimersByTimeAsync(LIMIT_MESSAGE_TTL_MS);
    await h.tracker.idle();
    h.advance(LIMIT_TOLD_MS);
    h.tracker.refused(GUILD, CREATOR, 'category');
    // Alice was trimmed, so the sweep finding her waiting tells her again.
    await h.tell('alice', ['alice'], false);
    expect(h.calls.filter((c) => c.startsWith('send'))).toHaveLength(2);
  });

  it('never throws, and never rejects, when the chat refuses everything', async () => {
    const tracker = new ChannelLimitTracker({
      chat: {
        send: () => Promise.reject(new Error('Missing Permissions')),
        remove: () => Promise.reject(new Error('x')),
      },
      noticesDisabled: () => Promise.reject(new Error('db down')),
      logger: fakeLogger(),
    });
    tracker.onSettled = () => {
      throw new Error('hook');
    };
    tracker.refused(GUILD, CREATOR, 'server');
    expect(() => tracker.tellMember(CREATOR, 'alice', ['alice'], true)).not.toThrow();
    await expect(tracker.idle()).resolves.toBeUndefined();
    expect(tracker.snapshot()['failed']).toBe(1);
    expect(() => tracker.roomMade(CREATOR)).not.toThrow();
    await expect(tracker.idle()).resolves.toBeUndefined();
  });
});

/** The project's copy rules, over every string this module renders. */
describe('channel limit copy rules', () => {
  const every = [
    channelLimitMemberMessage(['123'], 'category'),
    channelLimitMemberMessage(['123'], 'server'),
    channelLimitMemberMessage(['123', '456'], 'category'),
    channelLimitMemberMessage(['123', '456'], 'server'),
  ];

  it('opens with the mentions and mentions nobody else', () => {
    expect(every[0]!.startsWith('<@123> I ')).toBe(true);
    expect(every[2]!.startsWith('<@123> <@456> I ')).toBe(true);
    for (const msg of every) expect(msg).not.toMatch(/<[#&]|@everyone|@here/);
  });

  it('uses no em or en dashes, curly quotes or semicolons', () => {
    for (const msg of every) expect(msg).not.toMatch(/[—–‘’“”;]/);
  });

  it('says room, or rooms for several members', () => {
    expect(every[0]).toContain("I couldn't make your room because");
    expect(every[2]).toContain("I couldn't make your rooms because");
  });
});
