import { JoinChannelRepository, SecondaryChannelRepository, db } from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions, type VoiceActions } from './actions.js';
import { PrivacyService } from './privacy.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-privacy-test';
const SEC = 'sec-1';

describe('PrivacyService (integration)', () => {
  let env: PgTestEnv;
  let secondaries: SecondaryChannelRepository;
  let joinChannels: JoinChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let privacy: PrivacyService;

  beforeAll(async () => {
    env = await startPostgres();
    secondaries = new SecondaryChannelRepository(env.handle.db);
    joinChannels = new JoinChannelRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
    });
    await secondaries.create({
      channelId: SEC,
      guildId: GUILD,
      primaryChannelId: 'p',
      ownerId: 'alice',
      state: { name: 'Alice’s den' },
    });
    voice.put(SEC, member('alice'));
  });

  it('makes a channel private and spawns a "⇩ Join" companion', async () => {
    const res = await privacy.makePrivate(GUILD, SEC, 'alice');
    expect(res.ok).toBe(true);

    expect(actions.ofType('privacy').at(-1)).toMatchObject({ channelId: SEC, isPrivate: true });
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ channelId: SEC, memberId: 'alice', allow: true }),
    );
    const join = actions.ofType('joinChannel');
    expect(join).toHaveLength(1);
    expect(join[0]!.name).toBe('⇩ Join alice');
    expect(join[0]!.nearChannelId).toBe(SEC);

    expect((await secondaries.get(SEC))!.state.private).toBe(true);
    const row = await joinChannels.getBySecondary(SEC);
    expect(row).toMatchObject({
      channelId: join[0]!.channelId,
      secondaryChannelId: SEC,
      creatorId: 'alice',
    });
  });

  it('rejects a non-owner and a double-private', async () => {
    expect((await privacy.makePrivate(GUILD, SEC, 'mallory')).ok).toBe(false);
    await privacy.makePrivate(GUILD, SEC, 'alice');
    expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(false);
  });

  it('resolves a join channel back to its request context', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;
    const ctx = await privacy.getJoinContext(joinId);
    expect(ctx).toMatchObject({
      secondaryChannelId: SEC,
      creatorId: 'alice',
    });
    expect(await privacy.getJoinContext('not-a-join-channel')).toBeUndefined();
  });

  it('approves a requester: grants Connect and pulls them in', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    const res = await privacy.approveJoin(joinId, 'bob');
    expect(res.ok).toBe(true);
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ channelId: SEC, memberId: 'bob', allow: true }),
    );
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: 'bob', channelId: SEC }),
    );
  });

  it('denies a requester, and blocks them on the join channel when asked', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    await privacy.denyJoin(joinId, 'bob', false);
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: 'bob', channelId: null }),
    );

    await privacy.denyJoin(joinId, 'carol', true);
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
    );
  });

  it('makes a channel public again: deletes the join channel and clears state', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    const res = await privacy.makePublic(GUILD, SEC, 'alice');
    expect(res.ok).toBe(true);
    expect(actions.ofType('privacy').at(-1)).toMatchObject({ channelId: SEC, isPrivate: false });
    expect(actions.ofType('delete').map((a) => a.channelId)).toContain(joinId);
    expect((await secondaries.get(SEC))!.state.private).toBeUndefined();
    expect(await joinChannels.getBySecondary(SEC)).toBeUndefined();
  });

  it('reports failure (not "Admitted") when the admit action throws', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;
    const throwing: VoiceActions = {
      createVoiceChannel: () => Promise.resolve('x'),
      deleteChannel: () => Promise.resolve(),
      renameChannel: () => Promise.resolve({ rateLimited: false }),
      moveMember: () => Promise.reject(new Error('member gone')),
      setUserLimit: () => Promise.resolve(),
      setPrivacy: () => Promise.resolve(),
      setMemberConnect: () => Promise.resolve(),
      createJoinChannel: () => Promise.resolve('j'),
      setVoiceStatus: () => Promise.resolve(),
      repositionSecondaries: () => Promise.resolve(),
      repositionGroup: () => Promise.resolve(),
    };
    const p2 = new PrivacyService({
      secondaries,
      joinChannels,
      actions: throwing,
      voice,
      logger: fakeLogger(),
    });
    const res = await p2.approveJoin(joinId, 'bob');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Couldn’t admit');
  });

  it('handleOwnerChanged renames the join channel and re-points its creator', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob');

    expect(actions.ofType('rename')).toContainEqual(
      expect.objectContaining({ channelId: joinId, name: '⇩ Join Bob' }),
    );
    expect((await joinChannels.getBySecondary(SEC))!.creatorId).toBe('bob');
  });

  it('handleOwnerChanged is a no-op for a public channel (no join companion)', async () => {
    await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob');
    expect(actions.ofType('rename')).toHaveLength(0);
  });

  it('cleanupForSecondary removes the join channel when the private channel is deleted', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    await privacy.cleanupForSecondary(GUILD, SEC);
    expect(actions.ofType('delete').map((a) => a.channelId)).toContain(joinId);
    expect(await joinChannels.getBySecondary(SEC)).toBeUndefined();
  });

  describe('makePrivateForCreation (default-private primaries)', () => {
    const FRESH = 'sec-fresh';

    beforeEach(async () => {
      // A just-spawned secondary whose creator's move hasn't landed in the voice
      // cache yet — so the channel reads as empty.
      await secondaries.create({
        channelId: FRESH,
        guildId: GUILD,
        primaryChannelId: 'p',
        ownerId: 'dave',
        state: { name: 'Dave’s den', roster: ['dave'] },
      });
    });

    it('grants Connect to the creator by id even when the voice cache is empty', async () => {
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');

      expect(actions.ofType('privacy').at(-1)).toMatchObject({ channelId: FRESH, isPrivate: true });
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ channelId: FRESH, memberId: 'dave', allow: true }),
      );
      const join = actions.ofType('joinChannel').filter((a) => a.nearChannelId === FRESH);
      expect(join).toHaveLength(1);
      expect(join[0]!.name).toBe('⇩ Join Dave');

      const row = (await secondaries.get(FRESH))!;
      expect(row.state.private).toBe(true);
      // It preserves the rest of the freshly-created state (roster, name).
      expect(row.state.roster).toEqual(['dave']);
      expect(await joinChannels.getBySecondary(FRESH)).toMatchObject({ creatorId: 'dave' });
    });

    it('is idempotent: a replay does not spawn a second companion', async () => {
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');
      expect(actions.ofType('joinChannel').filter((a) => a.nearChannelId === FRESH)).toHaveLength(
        1,
      );
    });

    it('no-ops for an unknown secondary', async () => {
      await privacy.makePrivateForCreation(GUILD, 'ghost', 'dave', 'Dave');
      expect(actions.ofType('joinChannel').filter((a) => a.nearChannelId === 'ghost')).toHaveLength(
        0,
      );
    });
  });
});
