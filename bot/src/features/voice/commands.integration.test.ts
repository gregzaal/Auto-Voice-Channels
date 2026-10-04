import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  MemberAccessListRepository,
  MemberRoomPrefsRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { VoiceCommands } from './commands.js';
import { VoiceFeature } from './handler.js';
import { PrivacyService } from './privacy.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-cmd-test';
const PRIMARY = 'primary-1';
const SEC = 'sec-1';

describe('VoiceCommands (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let commands: VoiceCommands;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.autoChannels);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    const feature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
    });
    commands = new VoiceCommands({ secondaries, actions, voice, feature, logger: fakeLogger() });
    await guilds.ensure(GUILD);
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
    await secondaries.create({
      channelId: SEC,
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [General]', index: 0 },
    });
    voice.put(SEC, member('alice'));
  });

  it('owner can set and clear the user limit', async () => {
    const set = await commands.setLimit(GUILD, SEC, 'alice', 5);
    expect(set.ok).toBe(true);
    expect(actions.ofType('limit').at(-1)).toMatchObject({ channelId: SEC, limit: 5 });

    const cleared = await commands.unlimit(GUILD, SEC, 'alice');
    expect(cleared.ok).toBe(true);
    expect(actions.ofType('limit').at(-1)).toMatchObject({ channelId: SEC, limit: 0 });
  });

  it('rejects an out-of-range limit', async () => {
    const res = await commands.setLimit(GUILD, SEC, 'alice', 500);
    expect(res.ok).toBe(false);
    expect(actions.ofType('limit')).toHaveLength(0);
  });

  it('rejects a non-owner', async () => {
    const res = await commands.setLimit(GUILD, SEC, 'mallory', 5);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/owner/i);
    expect(actions.ofType('limit')).toHaveLength(0);
  });

  it('rejects when the channel is not bot-managed', async () => {
    const res = await commands.setLimit(GUILD, 'random-channel', 'alice', 5);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/bot-managed/i);
  });

  it('sets a custom name override and re-renders, then resets', async () => {
    voice.put(SEC, member('alice', ['Halo']));
    const set = await commands.setName(GUILD, SEC, 'alice', 'My Lounge');
    expect(set.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBe('My Lounge');
    expect(actions.ofType('rename').at(-1)!.name).toBe('My Lounge');

    const reset = await commands.setName(GUILD, SEC, 'alice', 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBeUndefined();
    // Back to the primary template rendered against alice playing Halo.
    expect(actions.ofType('rename').at(-1)!.name).toBe('#1 [Halo]');
  });

  it('warns in the reply when a rename is rate-limited', async () => {
    actions.simulateRenameRateLimit = true;
    voice.put(SEC, member('alice'));
    const res = await commands.setName(GUILD, SEC, 'alice', 'A Brand New Name');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/rate-limit/i);
  });

  it('blocks a non-owner from renaming, but allows an admin override', async () => {
    voice.put(SEC, member('alice', ['Halo']));

    // Mallory doesn't own SEC (alice does) and isn't admin → rejected.
    const denied = await commands.setName(GUILD, SEC, 'mallory', 'Hijacked');
    expect(denied.ok).toBe(false);
    expect((await secondaries.get(SEC))!.state.template).toBeUndefined();

    // Same call with the admin flag succeeds (absorbs the old /rename).
    const allowed = await commands.setName(GUILD, SEC, 'mallory', 'Admin Named', { admin: true });
    expect(allowed.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBe('Admin Named');
    expect(actions.ofType('rename').at(-1)!.name).toBe('Admin Named');
  });

  it('sets and resets the per-channel status override', async () => {
    voice.put(SEC, member('alice'));
    const set = await commands.setStatus(GUILD, SEC, 'alice', 'AFK 💤');
    expect(set.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBe('AFK 💤');
    expect(actions.ofType('status').at(-1)).toMatchObject({ channelId: SEC, status: 'AFK 💤' });

    const reset = await commands.setStatus(GUILD, SEC, 'alice', 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBeUndefined();
  });

  it('stores an empty status as a blank override (not a reset) and clears it', async () => {
    voice.put(SEC, member('alice'));
    await commands.setStatus(GUILD, SEC, 'alice', 'AFK 💤');
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBe('AFK 💤');

    const blank = await commands.setStatus(GUILD, SEC, 'alice', '');
    expect(blank.ok).toBe(true);
    // Stored as an empty string (a deliberate blank), NOT deleted/inherited.
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBe('');
    // …and the channel status is cleared on Discord.
    expect(actions.ofType('status').at(-1)).toMatchObject({ channelId: SEC, status: '' });

    // An explicit `reset` still removes the override entirely.
    const reset = await commands.setStatus(GUILD, SEC, 'alice', 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBeUndefined();
  });

  it('transfers ownership to a member in the channel', async () => {
    voice.put(SEC, member('bob'));
    const res = await commands.transfer(GUILD, SEC, 'alice', 'bob');
    expect(res.ok).toBe(true);
    const row = await secondaries.get(SEC);
    expect(row!.ownerId).toBe('bob');
    // A transfer is a durable handover: bob also becomes the original creator.
    expect(row!.originalCreator).toBe('bob');
  });

  it('refuses transfer to someone not in the channel', async () => {
    const res = await commands.transfer(GUILD, SEC, 'alice', 'charlie');
    expect(res.ok).toBe(false);
    expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
  });

  it('allows claiming when the owner has left', async () => {
    voice.drop(SEC, 'alice');
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'bob');
    expect(res.ok).toBe(true);
    const row = await secondaries.get(SEC);
    expect(row!.ownerId).toBe('bob');
    // A non-creator claim is durable: bob becomes the new original creator.
    expect(row!.originalCreator).toBe('bob');
  });

  it('refuses claiming when the owner is still present', async () => {
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'bob');
    expect(res.ok).toBe(false);
    expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
  });

  it('reassigns the original creator on transfer, so the giver cannot reclaim it', async () => {
    voice.put(SEC, member('bob'));
    await commands.transfer(GUILD, SEC, 'alice', 'bob');
    expect((await secondaries.get(SEC))!.originalCreator).toBe('bob');

    // Alice is still present but no longer the original creator, and bob (the
    // owner) is here — so she can't wrestle it back with /reclaim.
    const reclaim = await commands.claim(GUILD, SEC, 'alice');
    expect(reclaim.ok).toBe(false);
    expect(reclaim.message).toMatch(/still here/i);
    expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
  });

  /**
   * A `/restrict` rule on Claim is asked here, through `refuseClaim`, because only the
   * row says whether the caller is the original creator, who is never restricted.
   */
  describe('a rule on Claim', () => {
    const REFUSAL = 'A server admin has turned off **Claim** for you.';

    it('refuses a member it covers, before anything changes', async () => {
      voice.drop(SEC, 'alice');
      voice.put(SEC, member('bob'));
      const refuseClaim = vi.fn().mockResolvedValue(REFUSAL);
      const res = await commands.claim(GUILD, SEC, 'bob', { refuseClaim });
      expect(res).toEqual({ ok: false, message: REFUSAL });
      expect(refuseClaim).toHaveBeenCalledTimes(1);
      const row = await secondaries.get(SEC);
      expect(row!.ownerId).toBe('alice');
      expect(row!.originalCreator).toBe('alice');
    });

    it('lets a member it does not cover take an ownerless room', async () => {
      voice.drop(SEC, 'alice');
      voice.put(SEC, member('bob'));
      const res = await commands.claim(GUILD, SEC, 'bob', {
        refuseClaim: vi.fn().mockResolvedValue(null),
      });
      expect(res.ok).toBe(true);
      expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
    });

    /** Taking your own room back is never restricted, so the rule is not even asked. */
    it('never asks it for the original creator taking their room back', async () => {
      await secondaries.setOwner(SEC, 'bob');
      voice.put(SEC, member('bob'));
      const refuseClaim = vi.fn().mockResolvedValue(REFUSAL);
      const res = await commands.claim(GUILD, SEC, 'alice', { refuseClaim });
      expect(res.ok).toBe(true);
      expect(refuseClaim).not.toHaveBeenCalled();
      expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
    });
  });

  it('lets the original creator reclaim the channel from a caretaker owner', async () => {
    // Alice leaves; the caretaker handoff (setOwner, as handleSecondaryLeave does)
    // makes bob the owner but keeps alice as the original creator.
    await secondaries.setOwner(SEC, 'bob');
    expect((await secondaries.get(SEC))!.originalCreator).toBe('alice');

    // Alice returns — both she and caretaker bob are present. She reclaims it even
    // though bob is still here, because she is the original creator.
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'alice');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/reclaim/i);
    const row = await secondaries.get(SEC);
    expect(row!.ownerId).toBe('alice');
    expect(row!.originalCreator).toBe('alice');
  });

  /**
   * A private room's "⇩ Join" companion names its owner and gates who may answer
   * a knock (`avc:join:` checks `join_channels.creator_id`). The owner-left path
   * re-points it; `/transfer` and `/reclaim` did not, so after a handover only the
   * PREVIOUS owner could approve anyone, and the companion kept their name.
   */
  describe('a handover re-points the "⇩ Join" companion', () => {
    const JOIN = 'join-1';
    let joinChannels: JoinChannelRepository;
    let handoverCommands: VoiceCommands;

    beforeEach(async () => {
      await env.handle.db.delete(db.schema.joinChannels);
      joinChannels = new JoinChannelRepository(env.handle.db);
      const privacy = new PrivacyService({
        secondaries,
        joinChannels,
        actions,
        voice,
        logger: fakeLogger(),
      });
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        onOwnerChanged: (gid, cid, ownerId, ownerName) =>
          privacy.handleOwnerChanged(gid, cid, ownerId, ownerName),
      });
      handoverCommands = new VoiceCommands({
        secondaries,
        actions,
        voice,
        feature,
        logger: fakeLogger(),
      });
      await joinChannels.create({
        channelId: JOIN,
        guildId: GUILD,
        secondaryChannelId: SEC,
        creatorId: 'alice',
      });
      await secondaries.updateState(SEC, { name: '#1 [General]', index: 0, private: true });
    });

    it('/transfer moves the right to answer a knock, and renames the companion', async () => {
      voice.put(SEC, member('bob'));
      const res = await handoverCommands.transfer(GUILD, SEC, 'alice', 'bob');
      expect(res.ok).toBe(true);
      expect((await joinChannels.getBySecondary(SEC))!.creatorId).toBe('bob');
      expect(actions.ofType('rename')).toContainEqual(
        expect.objectContaining({ channelId: JOIN, name: '⇩ Join bob' }),
      );
    });

    it('/reclaim does the same for a claim of an abandoned room', async () => {
      voice.drop(SEC, 'alice');
      voice.put(SEC, member('bob'));
      const res = await handoverCommands.claim(GUILD, SEC, 'bob');
      expect(res.ok).toBe(true);
      expect((await joinChannels.getBySecondary(SEC))!.creatorId).toBe('bob');
    });

    it('leaves a public room alone, since it has no companion', async () => {
      await joinChannels.removeBySecondary(SEC);
      voice.put(SEC, member('bob'));
      const before = actions.ofType('rename').length;
      const res = await handoverCommands.transfer(GUILD, SEC, 'alice', 'bob');
      expect(res.ok).toBe(true);
      expect(
        actions
          .ofType('rename')
          .slice(before)
          .filter((r) => r.channelId === JOIN),
      ).toHaveLength(0);
    });

    it('still completes the handover when the companion cannot be renamed', async () => {
      voice.put(SEC, member('bob'));
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        onOwnerChanged: () => Promise.reject(new Error('Missing Permissions')),
      });
      const broken = new VoiceCommands({
        secondaries,
        actions,
        voice,
        feature,
        logger: fakeLogger(),
      });
      const res = await broken.transfer(GUILD, SEC, 'alice', 'bob');
      expect(res.ok).toBe(true);
      expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
    });
  });

  /**
   * Whose saved lists apply to a room. The owner LEAVING never changes it, so a
   * caretaker cannot revoke the creator's guests or blocks. A deliberate `/transfer`,
   * a claim of an ownerless room and `/reclaim` do: the repository re-points the
   * record's creator in the statement that moves the column, and the same hook that
   * re-points the Join channel applies the new creator's lists.
   */
  describe('a handover changes whose saved lists apply', () => {
    let lists: MemberAccessListRepository;
    let privacy: PrivacyService;
    let handoverCommands: VoiceCommands;
    let feature: VoiceFeature;

    const holds = (id: string) => actions.overwritesOf(SEC).find((o) => o.id === id);

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
        botUserId: () => 'the-bot',
        memberAccessLists: lists,
      });
      // As index.ts wires it: the options ride along, which is what says "handover".
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        onOwnerChanged: (gid, cid, ownerId, ownerName, opts) =>
          privacy.handleOwnerChanged(gid, cid, ownerId, ownerName, opts),
      });
      handoverCommands = new VoiceCommands({
        secondaries,
        actions,
        voice,
        feature,
        logger: fakeLogger(),
      });
      // Alice's room, locked, with her guest and her block in place.
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
      await privacy.applyAccessLists(GUILD, SEC);
      expect(holds('carol')).toBeDefined();
      expect(holds('mallory')).toBeDefined();
    });

    it('/transfer revokes the giver’s entries and applies the recipient’s lists', async () => {
      await lists.add(GUILD, 'bob', 'dave', 'trusted');
      await lists.add(GUILD, 'bob', 'eve', 'blocked');
      voice.put(SEC, member('bob'));

      const res = await handoverCommands.transfer(GUILD, SEC, 'alice', 'bob');

      expect(res.ok).toBe(true);
      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('bob');
      expect(holds('carol')).toBeUndefined();
      expect(holds('mallory')).toBeUndefined();
      expect(holds('dave')?.allow).toBeGreaterThan(0n);
      expect(holds('eve')?.deny).toBeGreaterThan(0n);
    });

    it('/transfer to somebody with no lists leaves no saved entries on the room', async () => {
      voice.put(SEC, member('bob'));
      await handoverCommands.transfer(GUILD, SEC, 'alice', 'bob');
      expect(holds('carol')).toBeUndefined();
      expect(holds('mallory')).toBeUndefined();
      expect((await secondaries.getAccess(SEC))?.trusted).toBeUndefined();
    });

    it('a stranger’s claim of an ownerless room does the same', async () => {
      await secondaries.updateState(SEC, { ...(await secondaries.get(SEC))!.state, private: true });
      await env.handle.pool.query(
        'UPDATE secondary_channels SET owner_id = NULL WHERE channel_id = $1',
        [SEC],
      );
      voice.drop(SEC, 'alice');
      voice.put(SEC, member('bob'));
      await lists.add(GUILD, 'bob', 'eve', 'blocked');

      const res = await handoverCommands.claim(GUILD, SEC, 'bob');

      expect(res.ok).toBe(true);
      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('bob');
      expect(holds('carol')).toBeUndefined();
      expect(holds('eve')?.deny).toBeGreaterThan(0n);
    });

    it('/reclaim by the original creator gives the room back to their lists', async () => {
      voice.put(SEC, member('bob'));
      await handoverCommands.transfer(GUILD, SEC, 'alice', 'bob');
      expect(holds('carol')).toBeUndefined();

      // Bob hands it back by /transfer, and alice's lists apply again.
      voice.put(SEC, member('alice'));
      await handoverCommands.transfer(GUILD, SEC, 'bob', 'alice');

      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('alice');
      expect(holds('carol')?.allow).toBeGreaterThan(0n);
      expect(holds('mallory')?.deny).toBeGreaterThan(0n);
    });

    it('/reclaim from a caretaker restores the creator’s lists the same way', async () => {
      // Alice leaves and bob inherits as a caretaker: nothing about the lists moves.
      voice.put(SEC, member('bob'));
      voice.drop(SEC, 'alice');
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: member('alice'),
        beforeChannelId: SEC,
      });
      expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
      expect((await secondaries.get(SEC))!.originalCreator).toBe('alice');
      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('alice');
      expect(holds('carol')).toBeDefined();
      expect(holds('mallory')).toBeDefined();

      voice.put(SEC, member('alice'));
      const res = await handoverCommands.claim(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('alice');
      expect(holds('carol')?.allow).toBeGreaterThan(0n);
      expect(holds('mallory')?.deny).toBeGreaterThan(0n);
    });

    it('the owner leaving never revokes the creator’s guests or blocks', async () => {
      await lists.add(GUILD, 'bob', 'dave', 'trusted');
      voice.put(SEC, member('bob'));
      voice.drop(SEC, 'alice');

      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: member('alice'),
        beforeChannelId: SEC,
      });

      expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('alice');
      expect(holds('carol')).toBeDefined();
      expect(holds('mallory')).toBeDefined();
      // And a caretaker’s own lists were not applied to a room that is not theirs.
      expect(holds('dave')).toBeUndefined();
    });

    it('still completes the handover when applying the lists fails', async () => {
      voice.put(SEC, member('bob'));
      actions.failOverwrites = true;

      const res = await handoverCommands.transfer(GUILD, SEC, 'alice', 'bob');

      expect(res.ok).toBe(true);
      expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
      expect((await secondaries.getAccess(SEC))?.creatorId).toBe('bob');
    });
  });

  /**
   * The commands that change something a template can read now trigger a
   * re-render, and the cost of that has to stay at zero for the guilds whose
   * templates say nothing about it.
   *
   * Both halves matter. The first proves the feature works. **The second is what
   * protects the property the whole design leans on**: `rerenderSecondary`
   * compares the rendered name against the stored one and issues nothing when
   * they match, so `/limit`, `/private` and `/public` cost no renames for the
   * overwhelming majority of guilds. A refactor that weakened the no-op guard
   * would spend a rename per command on every room in the install base, against
   * a budget of two per ten minutes.
   *
   * The re-render is deliberately not awaited by the command (the reply has to
   * land inside Discord's 3-second window and a rate-limited rename spends 2.5s
   * in its probe), so these await a macrotask to let it settle.
   */
  describe('re-renders triggered by a command', () => {
    /**
     * Waits for the detached re-render to land. Polling rather than a fixed
     * number of ticks: it does several awaited database round trips, and how
     * many turns that takes is not something a test should hard-code.
     */
    const settle = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    it('renames once when the template reads the user limit, and never otherwise', async () => {
      voice.setUserLimit(SEC, 0);
      await autoChannels.upsert(GUILD, PRIMARY, {
        name: 'room{{@@limit@@>=1 ?? @@slots@@ free}}',
      });
      await secondaries.updateState(SEC, { name: 'room', index: 0 });

      const before = actions.ofType('rename').length;
      // The recording action seam does not move the live view, so mirror what
      // Discord's cache does after a successful edit.
      voice.setUserLimit(SEC, 4);
      await commands.setLimit(GUILD, SEC, 'alice', 4);
      await settle(() => actions.ofType('rename').length > before);
      const renames = actions.ofType('rename').slice(before);
      expect(renames).toHaveLength(1);
      expect(renames[0]).toMatchObject({ channelId: SEC, name: 'room 3 free' });
    });

    it('renames nothing when the template does not mention the limit', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
      await secondaries.updateState(SEC, { name: '#1 [General]', index: 0 });

      const before = actions.ofType('rename').length;
      voice.setUserLimit(SEC, 4);
      await commands.setLimit(GUILD, SEC, 'alice', 4);
      // Nothing to wait FOR here, so give the detached work a generous window
      // and assert it still did nothing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(actions.ofType('rename').slice(before)).toHaveLength(0);
    });

    it('still reports the limit change to the caller when the name is unchanged', async () => {
      const res = await commands.setLimit(GUILD, SEC, 'alice', 7);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('7');
    });
  });

  /**
   * Hiding and showing a room re-render the name for `{{HIDDEN}}`, after the access write
   * (the render reads the stored record), and cost nothing for a template that does not read
   * it. Both halves matter for the reason the block above gives: the no-op guard is what
   * keeps a command from spending one of a room's two renames per ten minutes on every
   * room in the install base.
   *
   * `{{PRIVATE}}` stays true for a hidden room, so a template that reads only that one has
   * nothing to rename when a locked room is hidden or a hidden one is shown.
   */
  describe('hiding and showing a room', () => {
    let privacy: PrivacyService;
    let rooms: VoiceFeature;

    beforeEach(async () => {
      await env.handle.db.delete(db.schema.joinChannels);
      rooms = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
      });
      // As index.ts wires it: the privacy service re-renders through the feature.
      privacy = new PrivacyService({
        secondaries,
        joinChannels: new JoinChannelRepository(env.handle.db),
        actions,
        voice,
        logger: fakeLogger(),
        botUserId: () => 'bot',
        rerender: (gid, cid) => rooms.rerenderSecondary(gid, cid),
      });
    });

    /** Polls for the detached re-render, which several awaited round trips make slow to predict. */
    const settle = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    /** Runs a command and returns how many renames it cost, once the detached re-render is quiet. */
    async function renamesFrom(run: () => Promise<{ ok: boolean }>): Promise<string[]> {
      const before = actions.ofType('rename').length;
      expect((await run()).ok).toBe(true);
      await settle(() => actions.ofType('rename').length > before);
      // Nothing to wait FOR on the negative path, and a second rename would arrive late.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return actions
        .ofType('rename')
        .slice(before)
        .map((r) => r.name.replace(/\s+/g, ''));
    }

    /** Puts the room's stored name where its template says an open room is called. */
    async function settleName(template: string): Promise<void> {
      await autoChannels.upsert(GUILD, PRIMARY, { name: template });
      await rooms.rerenderSecondary(GUILD, SEC);
    }

    it('renames exactly once on hide and once on unhide when the template reads HIDDEN', async () => {
      await settleName('{{HIDDEN ?? H // V}}room');

      expect(await renamesFrom(() => privacy.hide(GUILD, SEC, 'alice'))).toEqual(['Hroom']);
      expect(await renamesFrom(() => privacy.unhide(GUILD, SEC, 'alice'))).toEqual(['Vroom']);
    });

    it('costs no rename at all when the template does not read HIDDEN or PRIVATE', async () => {
      await settleName('## [@@game_name@@]');

      expect(await renamesFrom(() => privacy.hide(GUILD, SEC, 'alice'))).toEqual([]);
      expect(await renamesFrom(() => privacy.unhide(GUILD, SEC, 'alice'))).toEqual([]);
    });

    it('costs no rename for a template that reads only HIDDEN when a room is locked or opened', async () => {
      await settleName('{{HIDDEN ?? H // V}}room');

      expect(await renamesFrom(() => privacy.makePrivate(GUILD, SEC, 'alice'))).toEqual([]);
      expect(await renamesFrom(() => privacy.makePublic(GUILD, SEC, 'alice'))).toEqual([]);
    });

    it('leaves a name that reads only PRIVATE alone between locked and hidden', async () => {
      await settleName('{{PRIVATE ?? P // O}}room');

      expect(await renamesFrom(() => privacy.makePrivate(GUILD, SEC, 'alice'))).toEqual(['Proom']);
      // Hidden is private too, so the name was already right.
      expect(await renamesFrom(() => privacy.hide(GUILD, SEC, 'alice'))).toEqual([]);
      expect(await renamesFrom(() => privacy.unhide(GUILD, SEC, 'alice'))).toEqual([]);
      expect(await renamesFrom(() => privacy.makePublic(GUILD, SEC, 'alice'))).toEqual(['Oroom']);
    });

    it('renames once from public straight to hidden for a template reading both', async () => {
      await settleName('{{HIDDEN ?? H // V}}{{PRIVATE ?? P // O}}');

      // One command, one rename, and not a hidden name followed by a private one.
      expect(await renamesFrom(() => privacy.hide(GUILD, SEC, 'alice'))).toEqual(['HP']);
      expect(await renamesFrom(() => privacy.makePublic(GUILD, SEC, 'alice'))).toEqual(['VO']);
    });
  });

  /**
   * What an owner's `/limit` and `/name` leave behind for their next room from this creator
   * channel. The save is the owner's own by equality, runs after the command has worked, is
   * stopped by `member_prefs.disabled` for a value and never for a clear, and can never fail
   * the command it follows.
   */
  describe('remembering what the owner chose', () => {
    let prefs: MemberRoomPrefsRepository;
    let remembering: VoiceCommands;
    let paused: boolean;

    /** The commands as `index.ts` wires them, over a prefs repository a test may swap. */
    const build = (
      memberPrefs: Pick<MemberRoomPrefsRepository, 'saveName' | 'saveLimit'> | null = prefs,
      logger = fakeLogger(),
    ): VoiceCommands => {
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
      });
      return new VoiceCommands({
        secondaries,
        actions,
        voice,
        feature,
        logger,
        ...(memberPrefs ? { memberPrefs } : {}),
        memberPrefsDisabled: () => Promise.resolve(paused),
      });
    };

    beforeEach(async () => {
      await env.handle.db.delete(db.schema.memberRoomPrefs);
      prefs = new MemberRoomPrefsRepository(env.handle.db);
      paused = false;
      remembering = build();
      await autoChannels.setRememberPrefs(GUILD, PRIMARY, true);
    });

    const saved = () => prefs.get(PRIMARY, 'alice');

    describe('the limit', () => {
      it('saves a limit the owner sets, for the creator channel the room came from', async () => {
        expect((await remembering.setLimit(GUILD, SEC, 'alice', 5)).ok).toBe(true);
        expect(await saved()).toEqual({ name: null, limit: 5, privacy: null });
      });

      /** 0 is the member's explicit "no limit", which is not the same as never having chosen one. */
      it('saves /unlimit as 0, an explicit no limit', async () => {
        await remembering.setLimit(GUILD, SEC, 'alice', 5);
        expect((await remembering.unlimit(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(await saved()).toEqual({ name: null, limit: 0, privacy: null });
      });

      it('saves nothing for a limit that was refused, or that Discord did not accept', async () => {
        expect((await remembering.setLimit(GUILD, SEC, 'alice', 500)).ok).toBe(false);
        expect(await saved()).toBeUndefined();

        actions.setUserLimit = () => Promise.reject(new Error('Missing Permissions'));
        await expect(remembering.setLimit(GUILD, SEC, 'alice', 5)).rejects.toThrow();
        expect(await saved()).toBeUndefined();
      });
    });

    describe('the name', () => {
      it('saves the template as the room stores it, and not the voice status', async () => {
        expect((await remembering.setName(GUILD, SEC, 'alice', '  My\nLounge  ')).ok).toBe(true);
        expect((await secondaries.get(SEC))!.state.template).toBe('My Lounge');
        expect(await saved()).toEqual({ name: 'My Lounge', limit: null, privacy: null });

        await remembering.setStatus(GUILD, SEC, 'alice', 'AFK');
        await remembering.setStatus(GUILD, SEC, 'alice', 'reset');
        expect(await saved()).toEqual({ name: 'My Lounge', limit: null, privacy: null });
      });

      it('takes the saved name back out on a reset, and leaves the rest', async () => {
        await remembering.setLimit(GUILD, SEC, 'alice', 5);
        await remembering.setName(GUILD, SEC, 'alice', 'My Lounge');

        expect((await remembering.setName(GUILD, SEC, 'alice', 'reset')).ok).toBe(true);

        expect(await saved()).toEqual({ name: null, limit: 5, privacy: null });
      });

      it('reads a blank name as a reset too, and deletes the row when it was the last setting', async () => {
        await remembering.setName(GUILD, SEC, 'alice', 'My Lounge');

        expect((await remembering.setName(GUILD, SEC, 'alice', '   ')).ok).toBe(true);

        expect(await saved()).toBeUndefined();
        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
      });

      /**
       * The panel's Name box shows the first 100 characters of a template and stops there, while
       * `/name` takes ten times that. Pressing Save on a long template without touching it
       * submits the cut version, and remembering that would replace the template with its start.
       */
      describe('submitted unchanged from the panel box', () => {
        const LONG = `${'a'.repeat(60)} ${'b'.repeat(60)} ${'c'.repeat(60)}`;
        const CUT = LONG.slice(0, 100).trim();

        it('does not overwrite a longer remembered template with its cut', async () => {
          await remembering.setName(GUILD, SEC, 'alice', LONG);
          expect((await saved())!.name).toBe(LONG);

          expect((await remembering.setName(GUILD, SEC, 'alice', CUT)).ok).toBe(true);

          expect((await saved())!.name).toBe(LONG);
          // The room's own template is cut by that submit, as it always was.
          expect((await secondaries.get(SEC))!.state.template).toBe(CUT);
        });

        /**
         * The box is pressed Save on without a change, twice: the first used to cut the room's
         * template to what the box showed, and the second then read that cut as a whole template
         * of its own and remembered it over the longer one. Unchanged is no change at all.
         */
        it('changes nothing from the panel, however many times it is pressed', async () => {
          await remembering.setName(GUILD, SEC, 'alice', LONG);

          for (let press = 0; press < 3; press += 1) {
            const res = await remembering.setName(GUILD, SEC, 'alice', CUT, { fromPanel: true });
            expect(res.ok).toBe(true);
            expect(res.message).toContain("Left this channel's name as it was");
            expect((await secondaries.get(SEC))!.state.template).toBe(LONG);
            expect((await saved())!.name).toBe(LONG);
          }
        });

        it('still applies a name changed in the panel box, and a short one, and a reset', async () => {
          await remembering.setName(GUILD, SEC, 'alice', LONG);

          await remembering.setName(GUILD, SEC, 'alice', `${CUT}!`, { fromPanel: true });
          expect((await secondaries.get(SEC))!.state.template).toBe(`${CUT}!`);
          expect((await saved())!.name).toBe(`${CUT}!`);

          await remembering.setName(GUILD, SEC, 'alice', 'Den', { fromPanel: true });
          expect((await secondaries.get(SEC))!.state.template).toBe('Den');
          expect((await saved())!.name).toBe('Den');

          await remembering.setName(GUILD, SEC, 'alice', LONG);
          expect(
            (await remembering.setName(GUILD, SEC, 'alice', 'reset', { fromPanel: true })).ok,
          ).toBe(true);
          expect((await secondaries.get(SEC))!.state.template).toBeUndefined();
          expect(await saved()).toBeUndefined();
        });

        it('does remember a name that was really changed, or written whole again', async () => {
          await remembering.setName(GUILD, SEC, 'alice', LONG);
          await remembering.setName(GUILD, SEC, 'alice', `${CUT}!`);
          expect((await saved())!.name).toBe(`${CUT}!`);

          await remembering.setName(GUILD, SEC, 'alice', LONG);
          expect((await saved())!.name).toBe(LONG);
        });

        it('remembers a short name that happens to be a start of nothing', async () => {
          await remembering.setName(GUILD, SEC, 'alice', 'My Lounge');
          await remembering.setName(GUILD, SEC, 'alice', 'My');
          expect((await saved())!.name).toBe('My');
        });
      });
    });

    /**
     * The save is for the room's owner by equality. `opts.admin` is true for every moderator,
     * including one renaming their OWN room, and an ownerless room passes every owner check.
     */
    describe('whose settings they are', () => {
      it('saves for a moderator renaming their own room', async () => {
        const res = await remembering.setName(GUILD, SEC, 'alice', 'Mine', { admin: true });
        expect(res.ok).toBe(true);
        expect((await saved())!.name).toBe('Mine');
      });

      it('saves nothing, for anybody, when a moderator renames somebody else’s room', async () => {
        const res = await remembering.setName(GUILD, SEC, 'mallory', 'Hijacked', { admin: true });

        expect(res.ok).toBe(true);
        expect((await secondaries.get(SEC))!.state.template).toBe('Hijacked');
        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
        // And a moderator’s reset does not take the owner’s own name back out.
        await remembering.setName(GUILD, SEC, 'alice', 'Mine');
        await remembering.setName(GUILD, SEC, 'mallory', 'reset', { admin: true });
        expect((await saved())!.name).toBe('Mine');
      });

      it('saves nothing for a room that has no owner, whoever changes it', async () => {
        await env.handle.pool.query(
          'UPDATE secondary_channels SET owner_id = NULL WHERE channel_id = $1',
          [SEC],
        );

        expect((await remembering.setLimit(GUILD, SEC, 'mallory', 5)).ok).toBe(true);
        expect((await remembering.setName(GUILD, SEC, 'mallory', 'Mine')).ok).toBe(true);
        expect((await remembering.setName(GUILD, SEC, 'mallory', 'Mine', { admin: true })).ok).toBe(
          true,
        );

        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
      });
    });

    describe('for a creator channel that does not remember', () => {
      it('stores nothing, and the commands work as they always did', async () => {
        await autoChannels.setRememberPrefs(GUILD, PRIMARY, false);

        expect((await remembering.setLimit(GUILD, SEC, 'alice', 5)).ok).toBe(true);
        expect((await remembering.setName(GUILD, SEC, 'alice', 'Mine')).ok).toBe(true);

        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
        expect(actions.ofType('limit').at(-1)).toMatchObject({ channelId: SEC, limit: 5 });
      });

      /** The statement checks the opt-in itself, so the command reads no creator channel of its own. */
      it('costs the command no read of the creator channel that it did not already make', async () => {
        const reads = vi.spyOn(autoChannels, 'get');
        await build(null).setName(GUILD, SEC, 'alice', 'Without');
        const without = reads.mock.calls.length;
        reads.mockClear();

        await remembering.setName(GUILD, SEC, 'alice', 'With');

        expect(without).toBeGreaterThan(0);
        expect(reads.mock.calls.length).toBe(without);
      });
    });

    describe('when saving goes wrong', () => {
      /**
       * The room has its name by the time the re-render runs, and the re-render reaches Discord,
       * so it can throw. A save that sat behind it would leave a member told the command failed
       * about a room that was renamed, and not remembered.
       */
      it('saves a name, and takes one back out, even when the re-render after it throws', async () => {
        const rerender = vi
          .spyOn(VoiceFeature.prototype, 'rerenderSecondary')
          .mockRejectedValue(new Error('discord down'));
        try {
          await expect(remembering.setName(GUILD, SEC, 'alice', 'Mine')).rejects.toThrow(
            'discord down',
          );
          expect((await secondaries.get(SEC))!.state.template).toBe('Mine');
          expect((await saved())!.name).toBe('Mine');

          await expect(remembering.setName(GUILD, SEC, 'alice', 'reset')).rejects.toThrow(
            'discord down',
          );
          expect(await saved()).toBeUndefined();
        } finally {
          rerender.mockRestore();
        }
      });

      /** The command has already worked, so a failed save costs next time’s convenience and nothing else. */
      it('never fails the command, and logs ids and never what was typed', async () => {
        const warn = vi.fn();
        const failing = build(
          {
            saveName: () => Promise.reject(new Error('db down')),
            saveLimit: () => Promise.reject(new Error('db down')),
          },
          { ...fakeLogger(), warn } as never,
        );

        const limit = await failing.setLimit(GUILD, SEC, 'alice', 5);
        const name = await failing.setName(GUILD, SEC, 'alice', 'a secret den name');

        expect(limit.ok).toBe(true);
        expect(name.ok).toBe(true);
        expect(actions.ofType('limit').at(-1)).toMatchObject({ channelId: SEC, limit: 5 });
        expect((await secondaries.get(SEC))!.state.template).toBe('a secret den name');
        expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      });
    });

    /**
     * The lever stops what is stored and never what is taken back out, so a member can still
     * reset a name while it is on, and what they reset does not come back when it is lifted.
     */
    describe('while member_prefs.disabled is on', () => {
      it('stores nothing, and still takes a name back out', async () => {
        await remembering.setName(GUILD, SEC, 'alice', 'Mine');
        paused = true;

        await remembering.setLimit(GUILD, SEC, 'alice', 5);
        await remembering.unlimit(GUILD, SEC, 'alice');
        await remembering.setName(GUILD, SEC, 'alice', 'Changed');
        expect(await saved()).toEqual({ name: 'Mine', limit: null, privacy: null });

        await remembering.setName(GUILD, SEC, 'alice', 'reset');
        expect(await saved()).toBeUndefined();
      });

      it('saves again once it is lifted', async () => {
        paused = true;
        await remembering.setLimit(GUILD, SEC, 'alice', 5);
        paused = false;
        await remembering.setLimit(GUILD, SEC, 'alice', 6);
        expect((await saved())!.limit).toBe(6);
      });
    });
  });
});
