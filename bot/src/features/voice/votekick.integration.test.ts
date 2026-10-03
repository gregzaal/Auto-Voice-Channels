import {
  JoinChannelRepository,
  MemberAccessListRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { CONNECT, VIEW_CHANNEL } from './accessPlan.js';
import { RecordingVoiceActions } from './actions.js';
import { PrivacyService } from './privacy.js';
import { VoteKickManager } from './votekick.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-kick-test';
const SEC = 'sec-1';

describe('VoteKickManager (integration)', () => {
  let env: PgTestEnv;
  let secondaries: SecondaryChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let kicks: VoteKickManager;

  beforeAll(async () => {
    env = await startPostgres();
    secondaries = new SecondaryChannelRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.secondaryChannels);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    kicks = new VoteKickManager({ secondaries, voice, actions, logger: fakeLogger() });
    await secondaries.create({
      channelId: SEC,
      guildId: GUILD,
      primaryChannelId: 'p',
      ownerId: 'owner',
      state: {},
    });
  });

  it('requires a strict majority of non-target members', () => {
    expect(VoteKickManager.requiredVotes(1)).toBe(1);
    expect(VoteKickManager.requiredVotes(2)).toBe(2);
    expect(VoteKickManager.requiredVotes(3)).toBe(2);
    expect(VoteKickManager.requiredVotes(4)).toBe(3);
  });

  it('kicks once a majority votes', async () => {
    // owner + alice + bob + target → eligible voters = owner, alice, bob (3) → need 2.
    for (const id of ['owner', 'alice', 'bob', 'target']) voice.put(SEC, member(id));

    const start = await kicks.start(GUILD, SEC, 'alice', 'target', 'spam');
    expect(start.ok).toBe(true);
    expect(start.required).toBe(2);
    expect(kicks.hasSession(SEC)).toBe(true); // 1/2 so far

    const res = await kicks.vote(SEC, 'bob');
    expect(res.kicked).toBe(true);
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ memberId: 'target', allow: false }),
    );
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: 'target', channelId: null }),
    );
    expect(kicks.hasSession(SEC)).toBe(false);
  });

  it('still bars a target who left voice as the vote passed, and does not fail', async () => {
    // The disconnect swallows 40032, so the Connect deny is what is left to do, and is done.
    for (const id of ['owner', 'alice', 'bob', 'target']) voice.put(SEC, member(id));
    actions.notConnectedMemberIds.add('target');
    await kicks.start(GUILD, SEC, 'alice', 'target', 'spam');
    const res = await kicks.vote(SEC, 'bob');
    expect(res.kicked).toBe(true);
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ memberId: 'target', allow: false }),
    );
    expect(actions.ofType('move')).toEqual([]);
  });

  it('kicks immediately in a 1v1 channel (initiator is the only voter needed)', async () => {
    for (const id of ['alice', 'target']) voice.put(SEC, member(id));
    const start = await kicks.start(GUILD, SEC, 'alice', 'target');
    expect(start.ok).toBe(true);
    expect(kicks.hasSession(SEC)).toBe(false); // resolved at once
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: 'target', channelId: null }),
    );
  });

  it('refuses to kick the channel owner', async () => {
    for (const id of ['owner', 'alice']) voice.put(SEC, member(id));
    const res = await kicks.start(GUILD, SEC, 'alice', 'owner');
    expect(res.ok).toBe(false);
  });

  it('ignores ineligible and duplicate voters', async () => {
    for (const id of ['owner', 'alice', 'bob', 'carol', 'target']) voice.put(SEC, member(id));
    // eligible = owner, alice, bob, carol (4) → need 3.
    const start = await kicks.start(GUILD, SEC, 'alice', 'target');
    expect(start.required).toBe(3);

    expect((await kicks.vote(SEC, 'target')).ok).toBe(false); // target can't vote
    expect((await kicks.vote(SEC, 'stranger')).ok).toBe(false); // not in channel
    const dup = await kicks.vote(SEC, 'alice'); // already voted at start
    expect(dup.votes).toBe(1);

    expect((await kicks.vote(SEC, 'bob')).resolved).toBe(false); // 2/3
    expect((await kicks.vote(SEC, 'carol')).kicked).toBe(true); // 3/3
  });

  it('rejects a second concurrent vote in the same channel', async () => {
    for (const id of ['owner', 'alice', 'bob', 'target']) voice.put(SEC, member(id));
    await kicks.start(GUILD, SEC, 'alice', 'target');
    const second = await kicks.start(GUILD, SEC, 'bob', 'target');
    expect(second.ok).toBe(false);
  });

  it('a stale-epoch cancel does not end a newer session on the same channel', async () => {
    for (const id of ['owner', 'alice', 'bob', 'target']) voice.put(SEC, member(id));
    const first = await kicks.start(GUILD, SEC, 'alice', 'target'); // 1/2, session A
    expect(kicks.hasSession(SEC)).toBe(true);

    kicks.cancel(SEC); // session A lapses/ends
    const second = await kicks.start(GUILD, SEC, 'bob', 'target'); // session B
    expect(second.epoch).not.toBe(first.epoch);
    expect(kicks.hasSession(SEC)).toBe(true);

    // A's lapsed timer fires with the OLD epoch → must not touch session B.
    kicks.cancel(SEC, first.epoch);
    expect(kicks.hasSession(SEC)).toBe(true);

    // B's own timer (matching epoch) ends it.
    kicks.cancel(SEC, second.epoch);
    expect(kicks.hasSession(SEC)).toBe(false);
  });

  /**
   * With the room's access record behind it, a vote is a block that belongs to the
   * room: View and Connect together, recorded, and no list edit or grant undoes it.
   */
  describe('with the room’s access record', () => {
    const BOT = 'bot-1';
    const VC = VIEW_CHANNEL | CONNECT;
    let lists: MemberAccessListRepository;
    let privacy: PrivacyService;
    let kicksWithAccess: VoteKickManager;

    const held = (id: string) => actions.overwritesOf(SEC).find((o) => o.id === id);
    const vote = async (target = 'target') => {
      for (const id of ['owner', 'alice', 'bob', target]) voice.put(SEC, member(id));
      await kicksWithAccess.start(GUILD, SEC, 'alice', target, 'spam');
      return kicksWithAccess.vote(SEC, 'bob');
    };

    beforeEach(async () => {
      await env.handle.db.delete(db.schema.joinChannels);
      await env.handle.db.delete(db.schema.memberAccessLists);
      lists = new MemberAccessListRepository(env.handle.db);
      privacy = new PrivacyService({
        secondaries,
        joinChannels: new JoinChannelRepository(env.handle.db),
        actions,
        voice,
        logger: fakeLogger(),
        botUserId: () => BOT,
        memberAccessLists: lists,
      });
      kicksWithAccess = new VoteKickManager({
        secondaries,
        voice,
        actions,
        logger: fakeLogger(),
        access: privacy,
      });
    });

    it('denies View and Connect together and records the member, in a room with no record yet', async () => {
      const res = await vote();

      expect(res.kicked).toBe(true);
      expect(held('target')).toMatchObject({ allow: 0n, deny: VC });
      expect(await secondaries.getAccess(SEC)).toEqual({ creatorId: 'owner', kicked: ['target'] });
      // Not the old Connect-only write.
      expect(actions.ofType('connect')).toEqual([]);
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'target', channelId: null, onlyFrom: SEC }),
      );
    });

    it('is not undone by a trusted member’s grant, which used to replace the unrecorded deny', async () => {
      await privacy.makePrivate(GUILD, SEC, 'owner');
      await lists.add(GUILD, 'owner', 'target', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(held('target')).toMatchObject({ allow: CONNECT });

      await vote();
      await privacy.applyAccessLists(GUILD, SEC);

      expect(held('target')).toMatchObject({ allow: 0n, deny: VC });
    });

    it('takes the room out of the member’s channel list in a hidden room too', async () => {
      await privacy.hide(GUILD, SEC, 'owner');
      await privacy.admit(GUILD, SEC, 'owner', 'target');
      expect(held('target')).toMatchObject({ allow: VC });

      await vote();

      expect(held('target')).toMatchObject({ allow: 0n, deny: VC });
    });

    it('bars them the old way when the record cannot be read, so a vote is never a no-op', async () => {
      await env.handle.pool.query(
        'UPDATE secondary_channels SET access = \'{"hidden":"sideways"}\'::jsonb WHERE channel_id = $1',
        [SEC],
      );

      const res = await vote();

      expect(res.kicked).toBe(true);
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ memberId: 'target', allow: false }),
      );
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'target', channelId: null }),
      );
    });

    it('bars them the old way when Discord refuses the new write', async () => {
      actions.failOverwrites = true;

      const res = await vote();

      expect(res.kicked).toBe(true);
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ memberId: 'target', allow: false }),
      );
    });

    it('does not disconnect a target who has since moved to another channel', async () => {
      for (const id of ['owner', 'alice', 'bob', 'target']) voice.put(SEC, member(id));
      await kicksWithAccess.start(GUILD, SEC, 'alice', 'target');
      actions.setMemberChannel('target', 'somewhere-else');

      const res = await kicksWithAccess.vote(SEC, 'bob');

      expect(res.kicked).toBe(true);
      expect(actions.ofType('move')).toEqual([]);
    });

    it('still works without the record, as before, and now leaves a mover alone who has gone', async () => {
      for (const id of ['owner', 'alice', 'bob', 'target']) voice.put(SEC, member(id));
      await kicks.start(GUILD, SEC, 'alice', 'target');
      actions.setMemberChannel('target', 'somewhere-else');

      await kicks.vote(SEC, 'bob');

      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ memberId: 'target', allow: false }),
      );
      expect(actions.ofType('move')).toEqual([]);
    });
  });
});
