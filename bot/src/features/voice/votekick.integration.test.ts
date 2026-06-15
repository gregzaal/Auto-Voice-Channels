import { SecondaryChannelRepository, db } from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
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
});
