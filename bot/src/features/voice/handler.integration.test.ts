import {
  AutoChannelRepository,
  CompanionChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  ManagedChannelRepository,
  MemberRoomPrefsRepository,
  SecondaryChannelRepository,
  db,
  startModeOf,
} from '@avc/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  BOT_ACCESS,
  CONNECT,
  MAX_PLANNED_OVERWRITES,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
} from './accessPlan.js';
import { RecordingVoiceActions } from './actions.js';
import { CompanionTextService } from './companionText.js';
import { ChannelObfuscatedError } from './discordAdapter.js';
import { ControlPanelPoster } from './controlPanelPoster.js';
import { VoiceFeature, type VoiceFeatureDeps } from './handler.js';
import { renderChannelName } from './nameTemplate.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { PrivacyService } from './privacy.js';
import type { VoiceStateEvent } from './types.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-voice-test';
const PRIMARY = 'primary-1';

describe('VoiceFeature (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let managed: ManagedChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let feature: VoiceFeature;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
    managed = new ManagedChannelRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.managedChannels);
    await env.handle.db.delete(db.schema.autoChannels);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    feature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
    });
    await guilds.ensure(GUILD);
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
  });

  it('creates and moves a member into a secondary on joining a primary', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);

    const event: VoiceStateEvent = { guildId: GUILD, member: alice, afterChannelId: PRIMARY };
    await feature.handleVoiceStateUpdate(event);

    const created = actions.ofType('create');
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('#1 [Halo]');

    const moves = actions.ofType('move');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.memberId).toBe('alice');

    const rows = await secondaries.listByGuild(GUILD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerId).toBe('alice');
    expect(rows[0]!.primaryChannelId).toBe(PRIMARY);
  });

  it('copies the primary bitrate, region, video-quality and nsfw onto the secondary', async () => {
    voice.setVoiceProperties(PRIMARY, {
      bitrate: 96000,
      rtcRegion: 'us-east',
      videoQualityMode: 2,
      nsfw: true,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });

    const created = actions.ofType('create')[0]!;
    expect(created.bitrate).toBe(96000);
    expect(created.rtcRegion).toBe('us-east');
    expect(created.videoQualityMode).toBe(2);
    expect(created.nsfw).toBe(true);
  });

  it('leaves region and video-quality unset when the primary has no override ("Automatic"/"Auto")', async () => {
    voice.setVoiceProperties(PRIMARY, {
      bitrate: 64000,
      rtcRegion: null,
      videoQualityMode: null,
      nsfw: false,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });

    const created = actions.ofType('create')[0]!;
    expect(created.bitrate).toBe(64000);
    expect(created.rtcRegion).toBeUndefined();
    expect(created.videoQualityMode).toBeUndefined();
    expect(created.nsfw).toBe(false);
  });

  it('sets none of bitrate/region/video-quality/nsfw when the primary is unknown to the view', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });

    const created = actions.ofType('create')[0]!;
    expect(created.bitrate).toBeUndefined();
    expect(created.rtcRegion).toBeUndefined();
    expect(created.videoQualityMode).toBeUndefined();
    expect(created.nsfw).toBeUndefined();
  });

  it('is idempotent: a replayed join does not create a second channel', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    const event: VoiceStateEvent = { guildId: GUILD, member: alice, afterChannelId: PRIMARY };

    await feature.handleVoiceStateUpdate(event);
    // Simulate the move taking effect (member left primary, now in the secondary).
    voice.drop(PRIMARY, 'alice');
    await feature.handleVoiceStateUpdate(event); // replay

    expect(actions.ofType('create')).toHaveLength(1);
    expect(await secondaries.listByGuild(GUILD)).toHaveLength(1);
  });

  it('deletes the secondary when the last non-bot member leaves', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });

    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Member is now in the secondary; simulate them leaving it.
    voice.put(secondaryId, alice);
    voice.drop(PRIMARY, 'alice');
    voice.drop(secondaryId, 'alice');

    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      beforeChannelId: secondaryId,
    });

    expect(actions.ofType('delete').map((a) => a.channelId)).toContain(secondaryId);
    expect(await secondaries.get(secondaryId)).toBeUndefined();
  });

  it('does not delete a secondary that still has members', async () => {
    const alice = member('alice');
    const bob = member('bob');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;

    // Both in the secondary, then alice leaves but bob remains.
    voice.put(secondaryId, alice);
    voice.put(secondaryId, bob);
    voice.drop(secondaryId, 'alice');

    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      beforeChannelId: secondaryId,
    });

    expect(actions.ofType('delete')).toHaveLength(0);
    expect(await secondaries.get(secondaryId)).toBeDefined();
  });

  it('hands ownership to a remaining member when the owner leaves (no "Unknown")', async () => {
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room" });
    const ownerChanges: { channelId: string; newOwnerId: string; newOwnerName: string }[] = [];
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      onOwnerChanged: (_g, channelId, newOwnerId, newOwnerName) => {
        ownerChanges.push({ channelId, newOwnerId, newOwnerName });
        return Promise.resolve();
      },
    });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    expect((await secondaries.get(secondaryId))!.ownerId).toBe('alice');

    // alice (owner) + bob both inside; alice leaves, bob remains.
    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob'));
    voice.drop(secondaryId, 'alice');
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, beforeChannelId: secondaryId });

    expect((await secondaries.get(secondaryId))!.ownerId).toBe('bob');
    // The "⇩ Join" companion hook fires with the new owner.
    expect(ownerChanges).toEqual([
      { channelId: secondaryId, newOwnerId: 'bob', newOwnerName: 'bob' },
    ]);

    // The re-render now resolves the new owner instead of "Unknown".
    await f.rerenderSecondary(GUILD, secondaryId);
    const rename = actions.ofType('rename').at(-1)!;
    expect(rename.name).toBe("bob's room");
    expect(rename.name).not.toContain('Unknown');
  });

  it('keeps ownership when a non-owner leaves', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;

    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob'));
    voice.drop(secondaryId, 'bob');
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: member('bob'),
      beforeChannelId: secondaryId,
    });

    expect((await secondaries.get(secondaryId))!.ownerId).toBe('alice');
  });

  it('transfers to the longest-present member (arrival order), not an arbitrary one', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const sec = actions.ofType('create')[0]!.channelId;
    voice.put(sec, alice); // creator now sitting in the secondary (roster: [alice])

    // carol joins first, then bob → roster becomes [alice, carol, bob].
    const carol = member('carol');
    voice.put(sec, carol);
    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: carol, afterChannelId: sec });
    const bob = member('bob');
    voice.put(sec, bob);
    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: sec });
    expect((await secondaries.get(sec))!.state.roster).toEqual(['alice', 'carol', 'bob']);

    // The owner (alice) leaves → carol inherits (joined before bob), not bob.
    voice.drop(sec, 'alice');
    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: alice, beforeChannelId: sec });

    expect((await secondaries.get(sec))!.ownerId).toBe('carol');
    expect((await secondaries.get(sec))!.state.roster).toEqual(['carol', 'bob']);
  });

  it('self-heals the roster from current members after a gap', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const sec = actions.ofType('create')[0]!.channelId;

    // Simulate members who joined while untracked (roster still just [alice]).
    voice.put(sec, alice);
    voice.put(sec, member('bob'));
    voice.put(sec, member('carol'));
    voice.drop(sec, 'alice'); // owner leaves

    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: alice, beforeChannelId: sec });

    // alice pruned; bob/carol appended in cache order; first inherits.
    const row = await secondaries.get(sec);
    expect(row!.state.roster).toEqual(['bob', 'carol']);
    expect(row!.ownerId).toBe('bob');
  });

  it('ignores mute/unmute (no channel change)', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      beforeChannelId: PRIMARY,
      afterChannelId: PRIMARY,
    });
    expect(actions.actions).toHaveLength(0);
  });

  it('repositionSecondaries hands all the primary’s secondaries to the action seam', async () => {
    for (const id of ['a', 'b', 'c']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        state: {},
      });
    }
    const moved = await feature.repositionSecondaries(GUILD, PRIMARY, true);
    expect(moved).toBe(3);
    const action = actions.ofType('reposition')[0]!;
    expect(action.primaryChannelId).toBe(PRIMARY);
    expect(action.above).toBe(true);
    expect([...action.channelIds].sort()).toEqual(['a', 'b', 'c']);
  });

  describe('room ordering', () => {
    /** Two existing rooms of PRIMARY, oldest first, with distinct creation times. */
    const seedRooms = async (): Promise<void> => {
      for (const [i, id] of ['room-1', 'room-2'].entries()) {
        await secondaries.create({
          channelId: id,
          guildId: GUILD,
          primaryChannelId: PRIMARY,
          state: {},
          createdAt: new Date(1_700_000_000_000 + i * 1000),
        });
      }
    };

    /**
     * The misorder check refuses to act without a category, because it cannot
     * otherwise tell a room somebody moved elsewhere from one that is genuinely
     * out of order, and the repair could not move it either way.
     */
    const inOneCategory = (): void => {
      for (const id of [PRIMARY, 'room-1', 'room-2']) voice.setParent(id, 'cat');
    };

    const join = async (): Promise<void> => {
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        afterChannelId: PRIMARY,
      });
    };

    it('places a new room below the primary’s existing rooms, not below the primary', async () => {
      await seedRooms();
      inOneCategory();
      await join();
      // Creating at the primary's own position is only correct while the whole
      // block still shares it; the adapter ties with the bottom-most of these.
      expect(actions.ofType('create')[0]!.afterChannelIds).toEqual(['room-1', 'room-2']);
    });

    it('does not reorder a block that is already in order', async () => {
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 62);
      await join();
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('does not reorder a block that shares one position (the steady state)', async () => {
      await seedRooms();
      inOneCategory();
      for (const id of [PRIMARY, 'room-1', 'room-2']) voice.setPosition(id, 60);
      await join();
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('does not reorder when positions are unknowable', async () => {
      await seedRooms();
      inOneCategory();
      await join();
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('repairs a block whose rooms have drifted out of order', async () => {
      await seedRooms();
      inOneCategory();
      // The reported shape: the newer room sits directly under the primary,
      // above the older one, because it was created at the primary's position
      // after the category had been renumbered.
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-2', 61);
      voice.setPosition('room-1', 62);
      await join();

      const repairs = actions.ofType('reposition');
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.above).toBe(false);
      // Oldest first. The room this join creates is deliberately NOT in the list:
      // the repair runs BEFORE the create, so the new room is placed into a block
      // that is already right rather than being moved after the member can see it.
      expect(repairs[0]!.channelIds).toEqual(['room-1', 'room-2']);
      // ...and that ordering is the whole anti-flicker property, so pin it.
      const order = actions.actions.map((a) => a.type);
      expect(order.indexOf('reposition')).toBeLessThan(order.indexOf('create'));
    });

    it('never repairs a room that has been moved to another category', async () => {
      // Positions in two categories are separate number spaces, so comparing
      // across them means nothing, and repositionSecondaries would not move it
      // anyway. Reading it as misordered buys a bulk reorder on every join and
      // never once fixes anything.
      await seedRooms();
      voice.setParent(PRIMARY, 'cat');
      voice.setParent('room-1', 'cat');
      voice.setParent('room-2', 'elsewhere');
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 0);
      await join();
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('does not repair when the category is unknowable', async () => {
      await seedRooms();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-2', 61);
      voice.setPosition('room-1', 62);
      await join();
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('honours voice.order_repair_disabled', async () => {
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-2', 61);
      voice.setPosition('room-1', 62);
      const gated = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        gate: { allowCreate: () => Promise.resolve({ allowed: true, orderRepairDisabled: true }) },
      });
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await gated.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        afterChannelId: PRIMARY,
      });
      expect(actions.ofType('create')).toHaveLength(1);
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('still reports the room as created when the repair fails', async () => {
      // The room exists and the member is already in it by this point, so a
      // failure here must not cost the caller its result or trip the guild's
      // circuit-breaker over a cosmetic reorder.
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-2', 61);
      voice.setPosition('room-1', 62);
      const broken = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        joinCompanionFor: () => Promise.reject(new Error('database is having a moment')),
      });
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      // Resolving at all is the assertion: unguarded, the rejected companion
      // lookup unwinds the whole create into the dispatcher's catch, which costs
      // the guild's circuit-breaker a failure over a cosmetic reorder.
      await expect(
        broken.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY }),
      ).resolves.toBeDefined();
      expect(await secondaries.get('sec-1')).toBeDefined();
      expect(actions.ofType('move').map((m) => m.channelId)).toContain('sec-1');
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('repairs a block that was in order when the new room had to tie', async () => {
      // A tie is not a harmless resting state: the client renders one in an order
      // of its own, and Discord later makes that order permanent. So a create with
      // nowhere unique to land buys the reorder even though nothing was wrong yet.
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 62);
      actions.collidingChannels.add('sec-1');
      await join();

      const repairs = actions.ofType('reposition');
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.channelIds).toEqual(['room-1', 'room-2', 'sec-1']);
    });

    it('still repairs a tie that survived the pre-create repair', async () => {
      // Two reorders here, and that is the point rather than a regression. They
      // are no longer the same repair counted twice: the first fixes the block
      // BEFORE the room is created, and the second only fires because the room
      // then tied anyway - which in production means the re-space that would have
      // opened a slot failed. Skipping it to keep the count at one would leave a
      // tie with nothing left to repair it, and a tie is what decays into a
      // permanent wrong order once Discord normalises it.
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-2', 61);
      voice.setPosition('room-1', 62);
      actions.collidingChannels.add('sec-1');
      await join();

      const repairs = actions.ofType('reposition');
      expect(repairs).toHaveLength(2);
      // The inherited block first, without the room that does not exist yet...
      expect(repairs[0]!.channelIds).toEqual(['room-1', 'room-2']);
      // ...then the tie, with it.
      expect(repairs[1]!.channelIds).toEqual(['room-1', 'room-2', 'sec-1']);
      const order = actions.actions.map((a) => a.type);
      expect(order.indexOf('reposition')).toBeLessThan(order.indexOf('create'));
    });

    it('spends no reorder at all once the block is in order and has a free slot', async () => {
      // The ordinary join, and the shape that makes the room appear in its final
      // place: nothing to repair before the create, nowhere to tie, nothing to
      // move after it.
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 62);
      await join();

      expect(actions.ofType('reposition')).toHaveLength(0);
      expect(actions.ofType('repositionGroup')).toHaveLength(0);
    });

    it('does not reorder when the new room landed on a free slot', async () => {
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 62);
      await join();
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('honours voice.order_repair_disabled for a tie as well', async () => {
      await seedRooms();
      inOneCategory();
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 62);
      actions.collidingChannels.add('sec-1');
      const gated = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        gate: { allowCreate: () => Promise.resolve({ allowed: true, orderRepairDisabled: true }) },
      });
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await gated.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        afterChannelId: PRIMARY,
      });
      expect(actions.ofType('create')).toHaveLength(1);
      expect(actions.ofType('reposition')).toHaveLength(0);
    });

    it('still reports the room as created when the collision check throws', async () => {
      // The check runs after the room exists and the member is in it, so it has
      // to be inside the same guard as the reorder. It sat one line above it once.
      await seedRooms();
      inOneCategory();
      const throwing = new RecordingVoiceActions();
      throwing.positionCollides = () => Promise.reject(new Error('cache is having a moment'));
      const feat = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions: throwing,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
      });
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await expect(
        feat.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY }),
      ).resolves.toBeDefined();
      expect(await secondaries.get('sec-1')).toBeDefined();
      expect(throwing.ofType('move').map((m) => m.channelId)).toContain('sec-1');
    });

    it('repairs a tie on an above primary too', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]', above: true });
      await seedRooms();
      inOneCategory();
      // Correct for "above", so only the tie can ask for the reorder.
      voice.setPosition('room-1', 60);
      voice.setPosition('room-2', 61);
      voice.setPosition(PRIMARY, 62);
      actions.collidingChannels.add('sec-1');
      await join();

      const repairs = actions.ofType('reposition');
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.above).toBe(true);
    });

    it('repairs against the primary’s own above/below setting', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]', above: true });
      await seedRooms();
      inOneCategory();
      // Correct for "below", and therefore wrong for this primary.
      voice.setPosition(PRIMARY, 60);
      voice.setPosition('room-1', 61);
      voice.setPosition('room-2', 62);
      await join();

      const repairs = actions.ofType('reposition');
      expect(repairs).toHaveLength(1);
      expect(repairs[0]!.above).toBe(true);
    });
  });

  it('repositionSecondaries is a no-op when the primary has no secondaries', async () => {
    const moved = await feature.repositionSecondaries(GUILD, PRIMARY, false);
    expect(moved).toBe(0);
    expect(actions.ofType('reposition')).toHaveLength(0);
  });

  it('repositionSecondaries moves each private channel’s “⇩ Join” companion with it', async () => {
    for (const id of ['a', 'b']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        state: {},
      });
    }
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      // 'a' is private (has a Join companion); 'b' is public.
      joinCompanionFor: (id) => Promise.resolve(id === 'a' ? 'join-a' : undefined),
    });
    await f.repositionSecondaries(GUILD, PRIMARY, true);

    const ids = actions.ofType('reposition')[0]!.channelIds;
    expect(ids).toHaveLength(3);
    expect(ids).toContain('b');
    // The companion sits directly above its secondary.
    expect(ids.indexOf('join-a')).toBe(ids.indexOf('a') - 1);
  });

  it('logs members joining and leaving a secondary at level 3', async () => {
    const logs: { level: number; message: string }[] = [];
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
    });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    const sec = actions.ofType('create')[0]!.channelId;
    voice.put(sec, alice);

    // bob joins the secondary → level-3 "joined".
    voice.put(sec, member('bob'));
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: member('bob'), afterChannelId: sec });
    expect(logs).toContainEqual({ level: 3, message: expect.stringContaining('joined') });

    // bob leaves while alice remains → level-3 "left" (not a deletion).
    voice.drop(sec, 'bob');
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: member('bob'), beforeChannelId: sec });
    expect(logs).toContainEqual({ level: 3, message: expect.stringContaining('left') });
  });

  it('notifies (without crashing) when it can’t create a secondary (missing permissions)', async () => {
    const logs: { level: number; message: string }[] = [];
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
      permissionProblems: problems,
    });
    actions.failCreate = true;
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    expect(actions.ofType('create')).toHaveLength(0); // the create threw
    expect(problems.recent(GUILD).map((p) => p.channelId)).toContain(PRIMARY);
    expect(logs.some((l) => l.level === 1 && l.message.includes('create a room'))).toBe(true);
  });

  it('clears the create incident once a create works again', async () => {
    const problems = new PermissionProblemTracker();
    const resolved: string[] = [];
    problems.onResolved = (guildId) => resolved.push(guildId);
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);

    actions.failCreate = true;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    expect(problems.recent(GUILD)).toHaveLength(1);

    // The admin fixes the override. Nothing cleared the create incident before
    // this, and unlike a secondary the creator channel lives on, so it stuck
    // around for the life of the process and kept being reported as broken.
    actions.failCreate = false;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    expect(problems.recent(GUILD)).toEqual([]);
    expect(resolved).toEqual([GUILD]);
  });

  it('blames the creator channel, not the room it just deleted, when the move fails', async () => {
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    actions.failMove = true;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    // The secondary is created then deleted on this path, so recording it
    // would hand the admin a `<#id>` mention for a channel that no longer
    // exists. The creator channel is the thing they configured.
    const recorded = problems.recent(GUILD);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.channelId).toBe(PRIMARY);
    expect(recorded[0]!.operation).toBe('move');
  });

  /**
   * `moveMember` swallows 40032, so a creator who left voice while the room was
   * being made is not an error. The room is kept (the reconciler removes an empty
   * one) and is not rolled back, which only a permission error does.
   */
  it('keeps the room, and does not fail, for a creator who left voice before the move', async () => {
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    actions.notConnectedMemberIds.add('alice');

    await expect(
      f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY }),
    ).resolves.not.toThrow();
    expect(actions.ofType('create')).toHaveLength(1);
    expect(actions.ofType('delete')).toEqual([]);
    expect(await secondaries.listByGuild(GUILD)).toHaveLength(1);
    expect(problems.recent(GUILD)).toEqual([]);
  });

  it('does not clear-and-re-record on every join when only the move fails', async () => {
    const problems = new PermissionProblemTracker();
    const resolved: string[] = [];
    problems.onResolved = (guildId) => resolved.push(guildId);
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    actions.failMove = true;

    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    // Both failures record against the primary, so clearing on a bare create
    // would resolve and re-open the guild on every join, which resets the
    // notifier's backoff and turns four notices into one per join.
    expect(resolved).toEqual([]);
    expect(problems.recent(GUILD)).toHaveLength(1);
  });

  it('gives up a channel it can no longer delete (Missing Access), notifying instead of retrying', async () => {
    const logs: { level: number; message: string }[] = [];
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
      permissionProblems: problems,
    });
    await secondaries.create({
      channelId: 'locked',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: 'Locked', index: 0 },
    });
    // The empty channel can't be deleted — a permission override hid it from us.
    actions.failDeleteForChannel = 'locked';
    await f.handleVoiceStateUpdate({
      guildId: GUILD,
      member: member('alice'),
      beforeChannelId: 'locked',
    });

    // Stopped tracking it (so the reconcile won't retry forever), recorded + notified.
    expect(await secondaries.get('locked')).toBeUndefined();
    expect(problems.recent(GUILD).map((p) => p.channelId)).toContain('locked');
    expect(logs.some((l) => l.level === 1 && l.message.includes('lost access'))).toBe(true);
  });

  it('logs a rate-limited rename as deferred (level 2), and a normal rename as applied', async () => {
    const logs: { level: number; message: string }[] = [];
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
    });
    await secondaries.create({
      channelId: 'rl',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: 'stale', index: 0 },
    });
    voice.put('rl', member('alice', ['Halo']));

    // Discord defers the rename → the log says so, at the renames level (2).
    actions.simulateRenameRateLimit = true;
    await f.rerenderSecondary(GUILD, 'rl');
    const deferred = logs.find((l) => l.message.includes('deferred'));
    expect(deferred?.level).toBe(2);
    expect(deferred?.message).toContain('rate-limiting');
    expect(deferred?.message).not.toContain('renamed to');

    // When the limit clears, a real rename logs as applied (no "deferred").
    logs.length = 0;
    actions.simulateRenameRateLimit = false;
    voice.put('rl', member('alice', ['Doom'])); // change the game so the name drifts again
    await f.rerenderSecondary(GUILD, 'rl');
    expect(logs).toContainEqual({ level: 2, message: expect.stringContaining('renamed to') });
    expect(logs.some((l) => l.message.includes('deferred'))).toBe(false);
  });

  it('secondaries.create is create-once: a replay does not clobber live state', async () => {
    await secondaries.create({
      channelId: 'co',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { roster: ['alice'], seed: 7 },
    });
    await secondaries.setOwner('co', 'bob');
    await secondaries.updateState('co', { roster: ['alice', 'bob'], seed: 7 });

    // A replayed create with the original seed state must leave the live row intact.
    const replay = await secondaries.create({
      channelId: 'co',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { roster: ['alice'], seed: 7 },
    });
    expect(replay.ownerId).toBe('bob');
    expect(replay.state.roster).toEqual(['alice', 'bob']);
  });

  it('re-renders a secondary when its membership/game changes', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    expect(actions.ofType('create')[0]!.name).toBe('#1 [Halo]');

    // Alice is now in the secondary; Bob joins playing a different game.
    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob', ['Doom']));
    await feature.rerenderSecondary(GUILD, secondaryId);

    const renames = actions.ofType('rename');
    expect(renames).toHaveLength(1);
    expect(renames[0]!.channelId).toBe(secondaryId);
    expect(renames[0]!.name).toContain('Halo');
    expect(renames[0]!.name).toContain('Doom');
    const row = await secondaries.get(secondaryId);
    expect(row!.state.name).toBe(renames[0]!.name);
  });

  /**
   * The rename a re-render waits on can sit rate limited for seconds, and a `/private` or
   * `/public` can finalise inside that time. `private` lives in `state`, so a re-render that
   * wrote its snapshot back whole would revert it: the room locked on Discord and public in the
   * row, or the other way round.
   */
  it('keeps a lock that finalised while a re-render waited on its rename', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob', ['Doom']));

    const rename = actions.renameChannel.bind(actions);
    actions.renameChannel = async (...args) => {
      await secondaries.transitionAccess(secondaryId, {
        statePatch: { private: true },
        access: (stored) => stored,
      });
      return rename(...args);
    };
    await feature.rerenderSecondary(GUILD, secondaryId);

    const row = await secondaries.get(secondaryId);
    expect(row!.state.name).toContain('Doom');
    expect(row!.state.private).toBe(true);
  });

  /**
   * A room the bot can no longer edit costs that room, and not the guild's sweep. Discord shows
   * a channel the bot cannot View as an obfuscated shell, which stays in the cache, so its rename
   * throws; the renumber loops have no catch of their own, so it used to end the sweep at that
   * room every five minutes, with the rooms after it never renumbered.
   */
  describe('a room the bot can no longer rename, in the sweep', () => {
    let problems: PermissionProblemTracker;
    let told: string[];
    let rename: RecordingVoiceActions['renameChannel'];

    beforeEach(async () => {
      problems = new PermissionProblemTracker();
      told = [];
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        permissionProblems: problems,
        // The guild's log channel at the level problems go to, and not the renames at level 2.
        serverLog: (_guild, level, message) => {
          if (level === 1) told.push(message);
        },
      });
      // Three rooms in creation order, each with a stale name so the sweep wants to rename it.
      for (const id of ['r1', 'r2', 'r3']) {
        await secondaries.create({
          channelId: id,
          guildId: GUILD,
          primaryChannelId: PRIMARY,
          ownerId: 'alice',
          state: { name: 'STALE', index: 9 },
        });
        voice.put(id, member('alice', ['Halo']));
      }
      rename = actions.renameChannel.bind(actions);
    });

    /** Every rename of the first room fails with this, whatever the others do. */
    const failFirstRoom = (make: () => Error) => {
      actions.renameChannel = (guildId, channelId, name) =>
        channelId === 'r1' ? Promise.reject(make()) : rename(guildId, channelId, name);
    };
    const triedFirstRoom = () =>
      actions.ofType('rename').filter((a) => a.channelId === 'r1').length;

    it('renumbers the rooms after it, records it once and leaves it alone on the next sweep', async () => {
      let attempts = 0;
      failFirstRoom(() => {
        attempts += 1;
        return new ChannelObfuscatedError('r1');
      });

      await feature.reconcileGuild(GUILD);

      expect(attempts).toBe(1);
      expect((await secondaries.get('r2'))!.state.index).toBe(1);
      expect((await secondaries.get('r3'))!.state.index).toBe(2);
      expect(actions.ofType('rename').map((a) => a.channelId)).toEqual(['r2', 'r3']);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'r1', operation: 'delete' }),
      ]);
      expect(told).toHaveLength(1);

      await feature.reconcileGuild(GUILD);

      expect(attempts).toBe(1);
      expect(problems.recent(GUILD)).toHaveLength(1);
      expect(told).toHaveLength(1);
    });

    it('does the same for a Missing Access refusal, recorded as a rename it could not make', async () => {
      actions.failRenameForChannel = 'r1';

      await feature.reconcileGuild(GUILD);

      expect((await secondaries.get('r3'))!.state.index).toBe(2);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'r1', operation: 'rename' }),
      ]);
    });

    it('asks again once the wait is over, and the incident ends when it works', async () => {
      failFirstRoom(() => new ChannelObfuscatedError('r1'));
      await feature.reconcileGuild(GUILD);
      expect(problems.recent(GUILD)).toHaveLength(1);

      actions.renameChannel = rename;
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 7 * 60 * 60 * 1000);
      try {
        await feature.reconcileGuild(GUILD);
      } finally {
        clock.mockRestore();
      }

      expect(triedFirstRoom()).toBe(1);
      expect((await secondaries.get('r1'))!.state.index).toBe(0);
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('still lets an error that is not a permission failure end the sweep', async () => {
      failFirstRoom(() => new Error('boom'));
      await expect(feature.reconcileGuild(GUILD)).rejects.toThrow('boom');
    });

    it('does not act, or remember anything, under a dry run', async () => {
      failFirstRoom(() => new ChannelObfuscatedError('r1'));
      await feature.reconcileGuild(GUILD, { dryRun: true });
      expect(actions.ofType('rename')).toEqual([]);
      expect(problems.recent(GUILD)).toEqual([]);
    });
  });

  it('rerenderSecondary is a no-op when the name is unchanged', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    voice.put(secondaryId, alice);

    await feature.rerenderSecondary(GUILD, secondaryId);
    expect(actions.ofType('rename')).toHaveLength(0);
  });

  it('rerenderSecondary no-ops for an unknown or empty channel', async () => {
    await feature.rerenderSecondary(GUILD, 'not-a-secondary');
    expect(actions.ofType('rename')).toHaveLength(0);
  });

  it('handleVoiceStateUpdate reports a joined secondary as needing re-render', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;

    const bob = member('bob');
    voice.put(secondaryId, bob);
    const touched = await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: bob,
      afterChannelId: secondaryId,
    });
    expect(touched).toContain(secondaryId);
  });

  it('does not create when the runtime gate denies (e.g. global pause)', async () => {
    const gatedFeature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      gate: { allowCreate: () => Promise.resolve({ allowed: false, reason: 'global pause' }) },
      logger: fakeLogger(),
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await gatedFeature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    expect(actions.ofType('create')).toHaveLength(0);
    expect(await secondaries.listByGuild(GUILD)).toHaveLength(0);
  });

  it('does not create when the guild is blocked', async () => {
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'blocked' });
    const blockedFeature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true, // kill-switch wins even when self-hosted
      logger: fakeLogger(),
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await blockedFeature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    expect(actions.ofType('create')).toHaveLength(0);
  });

  it('rerenderByOwner re-renders every channel a member owns', async () => {
    for (const id of ['c1', 'c2']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'stale', index: 0 },
      });
      voice.put(id, member('alice'));
    }
    // A channel owned by someone else must be untouched.
    await secondaries.create({
      channelId: 'c3',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'bob',
      state: { name: 'stale', index: 0 },
    });
    voice.put('c3', member('bob'));

    const summary = await feature.rerenderByOwner(GUILD, 'alice');
    expect(summary).toMatchObject({ considered: 2, renamed: 2 });
    expect(
      actions
        .ofType('rename')
        .map((a) => a.channelId)
        .sort(),
    ).toEqual(['c1', 'c2']);
  });

  /**
   * A restricted feature is inert for a denied member, saved data included. The
   * nickname is a saved value that is already in every room name an owner has,
   * and a role-based rule cannot clear it (a role's members are not listable), so
   * the render has to stop using it.
   */
  describe('a restriction on Nickname', () => {
    const DENIED_ROLE = '323456789012345678';
    // A real snowflake, because a rule drops an id that is not one.
    const DENIED_USER = '423456789012345678';

    async function ownedRoom(id: string, owner: string, roleIds: string[]): Promise<void> {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: owner,
        state: { name: 'stale', index: 0 },
      });
      voice.put(id, { ...member(owner), roleIds });
    }

    beforeEach(async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: '@@owner@@' });
      await guilds.updateSettings(GUILD, {
        custom_nicks: {
          alice: 'Big Alice',
          bea: 'Big Bea',
          bob: 'Big Bob',
          carol: 'Big Carol',
          [DENIED_USER]: 'Big Dan',
        },
        command_access: { nick: { roles: [DENIED_ROLE] } },
      });
    });

    // Guild settings outlive a test, and a nickname or rule left behind would
    // rename every later test's owner.
    afterEach(async () => {
      await guilds.updateSettings(GUILD, { custom_nicks: {}, command_access: {} });
    });

    it("names a role-denied owner's room by their Discord name, not their saved nickname", async () => {
      await ownedRoom('c1', 'alice', ['999999999999999999', DENIED_ROLE]);
      await feature.rerenderSecondary(GUILD, 'c1');
      expect(actions.ofType('rename').map((a) => a.name)).toEqual(['alice']);
    });

    it('still uses a nickname for an owner nobody has restricted', async () => {
      await ownedRoom('c2', 'bea', ['999999999999999999']);
      await feature.rerenderSecondary(GUILD, 'c2');
      expect(actions.ofType('rename').map((a) => a.name)).toEqual(['Big Bea']);
    });

    it('brings the nickname back when the rule is lifted, because it was never cleared', async () => {
      await ownedRoom('c1', 'alice', [DENIED_ROLE]);
      await feature.rerenderSecondary(GUILD, 'c1');
      await guilds.updateSettings(GUILD, { command_access: {} });
      await feature.rerenderSecondary(GUILD, 'c1');
      expect(actions.ofType('rename').map((a) => a.name)).toEqual(['alice', 'Big Alice']);
    });

    /**
     * A member who can manage channels is never restricted, so `/nick` lets them
     * through. If the render did not agree, their `/nick` would reply that rooms
     * will call them the new name and no room ever would.
     */
    it('keeps the nickname of an owner who can manage channels, whatever role a rule names', async () => {
      await secondaries.create({
        channelId: 'c1',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'stale', index: 0 },
      });
      voice.put('c1', { ...member('alice'), roleIds: [DENIED_ROLE], canManage: true });
      await feature.rerenderSecondary(GUILD, 'c1');
      expect(actions.ofType('rename').map((a) => a.name)).toEqual(['Big Alice']);
    });

    /**
     * `@@original_creator@@` is a second place a nickname is read, and the creator
     * has usually left, so what the rule needs to know about them comes from the
     * room's snapshot while they are in it and from the cache after.
     */
    describe('for @@original_creator@@', () => {
      async function roomMadeBy(
        creator: string,
        inRoom: { roleIds: string[]; canManage?: boolean } | null,
      ): Promise<void> {
        await autoChannels.upsert(GUILD, PRIMARY, { name: '@@original_creator@@' });
        await secondaries.create({
          channelId: 'oc',
          guildId: GUILD,
          primaryChannelId: PRIMARY,
          ownerId: 'alice',
          originalCreator: creator,
          state: { name: 'stale', index: 0, originalCreatorName: creator },
        });
        // Somebody nobody has restricted is always in the room, so it is never empty.
        voice.put('oc', member('alice'));
        if (inRoom) voice.put('oc', { ...member(creator), ...inRoom });
      }
      const rendered = async (): Promise<string[]> => {
        await feature.rerenderSecondary(GUILD, 'oc');
        return actions.ofType('rename').map((a) => a.name);
      };

      it('names a creator who is still in the room by their Discord name when their role is denied', async () => {
        await roomMadeBy('carol', { roleIds: [DENIED_ROLE] });
        expect(await rendered()).toEqual(['carol']);
      });

      it('keeps the nickname of a creator in the room whom no rule names', async () => {
        await roomMadeBy('carol', { roleIds: ['999999999999999999'] });
        expect(await rendered()).toEqual(['Big Carol']);
      });

      it('finds the roles of a creator who has left in the cache', async () => {
        await roomMadeBy('carol', null);
        voice.setOwnerAccess('carol', { roleIds: [DENIED_ROLE] });
        expect(await rendered()).toEqual(['carol']);
      });

      it('keeps the nickname of a departed creator the cache does not hold the roles of', async () => {
        await roomMadeBy('carol', null);
        expect(await rendered()).toEqual(['Big Carol']);
      });

      it('still applies a rule that names a departed creator themselves, with nothing to look up', async () => {
        await guilds.updateSettings(GUILD, { command_access: { nick: { users: [DENIED_USER] } } });
        await roomMadeBy(DENIED_USER, null);
        expect(await rendered()).toEqual([DENIED_USER]);
      });

      it('keeps the nickname of a departed creator who can manage channels', async () => {
        await roomMadeBy('carol', null);
        voice.setOwnerAccess('carol', { roleIds: [DENIED_ROLE], canManage: true });
        expect(await rendered()).toEqual(['Big Carol']);
      });
    });

    /**
     * The same member's name is also what a private room's "Join" channel is named
     * after, and it is read on the three paths below. Each reads it through
     * `displayName`, so each has to be shown to apply the rule.
     */
    describe('where a new owner is named', () => {
      const handovers = (): { changes: string[]; f: VoiceFeature } => {
        const changes: string[] = [];
        const f = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          onOwnerChanged: (_g, _c, _id, name) => {
            changes.push(name);
            return Promise.resolve();
          },
        });
        return { changes, f };
      };

      it.each([
        ['a denied role', [DENIED_ROLE], 'bob'],
        ['no restriction', ['999999999999999999'], 'Big Bob'],
      ])('names a new owner after the owner leaves (%s)', async (_what, roleIds, expected) => {
        const { changes, f } = handovers();
        await ownedRoom('c1', 'alice', []);
        voice.put('c1', { ...member('bob'), roleIds });
        voice.drop('c1', 'alice');
        await f.handleVoiceStateUpdate({
          guildId: GUILD,
          member: member('alice'),
          beforeChannelId: 'c1',
        });
        expect((await secondaries.get('c1'))!.ownerId).toBe('bob');
        expect(changes).toEqual([expected]);
      });

      it.each([
        ['a denied role', [DENIED_ROLE], 'bob'],
        ['no restriction', ['999999999999999999'], 'Big Bob'],
      ])(
        'names a new owner after a /transfer or /reclaim (%s)',
        async (_what, roleIds, expected) => {
          const { changes, f } = handovers();
          await f.repointJoinCompanion(GUILD, 'c1', { ...member('bob'), roleIds });
          expect(changes).toEqual([expected]);
        },
      );

      it.each([
        ['a denied role', [DENIED_ROLE], 'bob'],
        ['no restriction', ['999999999999999999'], 'Big Bob'],
      ])('gives any other site the same name (%s)', async (_what, roleIds, expected) => {
        const { f } = handovers();
        expect(await f.nameFor(GUILD, { ...member('bob'), roleIds })).toBe(expected);
      });

      /**
       * A deliberate handover changes whose saved lists apply to the room, and the
       * owner leaving must not: the hook is the one place that tells them apart.
       */
      it('says a /transfer or /reclaim is a handover, and the owner leaving is not', async () => {
        const seen: (boolean | undefined)[] = [];
        const f = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          onOwnerChanged: (_g, _c, _id, _name, opts) => {
            seen.push(opts?.handover);
            return Promise.resolve();
          },
        });
        await ownedRoom('c1', 'alice', []);
        voice.put('c1', member('bob'));
        voice.drop('c1', 'alice');
        await f.handleVoiceStateUpdate({
          guildId: GUILD,
          member: member('alice'),
          beforeChannelId: 'c1',
        });
        await f.repointJoinCompanion(GUILD, 'c1', member('bob'));
        expect(seen).toEqual([undefined, true]);
      });

      it.each([
        ['a denied role', [DENIED_ROLE], 'alice'],
        ['no restriction', ['999999999999999999'], 'Big Alice'],
      ])('names the creator of a room born private (%s)', async (_what, roleIds, expected) => {
        const named: string[] = [];
        const f = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          makePrivateOnCreate: (_g, _c, _owner, name) => {
            named.push(name);
            return Promise.resolve();
          },
        });
        // A prior test blocks the guild, and a blocked guild creates nothing.
        await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
        await autoChannels.upsert(GUILD, PRIMARY, { name: '@@owner@@', defaultPrivate: true });
        const alice = { ...member('alice'), roleIds };
        voice.put(PRIMARY, alice);
        await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
        expect(named).toEqual([expected]);
      });
    });

    /**
     * `command_access.disabled` is the incident lever, and a saved nickname is the
     * one rule that is enforced when a name is rendered and not at a guard. If the
     * lever stopped at the guards, "enforcement is paused" would be untrue for the
     * rule that changes what every member of a room reads.
     */
    describe('and command_access.disabled', () => {
      let asked = 0;
      const withLever = (disabled: boolean): VoiceFeature =>
        new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          gate: {
            allowCreate: () => Promise.resolve({ allowed: true }),
            commandAccessDisabled: () => {
              asked += 1;
              return Promise.resolve(disabled);
            },
          },
        });

      beforeEach(() => {
        asked = 0;
      });

      it("shows a restricted owner's nickname again while it is on", async () => {
        await ownedRoom('c1', 'alice', [DENIED_ROLE]);
        await withLever(true).rerenderSecondary(GUILD, 'c1');
        expect(actions.ofType('rename').map((a) => a.name)).toEqual(['Big Alice']);
      });

      it('keeps the rule in force while it is off', async () => {
        await ownedRoom('c1', 'alice', [DENIED_ROLE]);
        await withLever(false).rerenderSecondary(GUILD, 'c1');
        expect(actions.ofType('rename').map((a) => a.name)).toEqual(['alice']);
      });

      it('takes the nickname away again when it is lifted, because nothing was cleared', async () => {
        await ownedRoom('c1', 'alice', [DENIED_ROLE]);
        await withLever(true).rerenderSecondary(GUILD, 'c1');
        await withLever(false).rerenderSecondary(GUILD, 'c1');
        expect(actions.ofType('rename').map((a) => a.name)).toEqual(['Big Alice', 'alice']);
      });

      it('is never asked about for a server with no rules', async () => {
        await guilds.updateSettings(GUILD, { command_access: {} });
        await ownedRoom('c1', 'alice', [DENIED_ROLE]);
        await withLever(true).rerenderSecondary(GUILD, 'c1');
        expect(asked).toBe(0);
        expect(actions.ofType('rename').map((a) => a.name)).toEqual(['Big Alice']);
      });
    });
  });

  it('rerenderSiblings re-renders all channels of a primary, counting rate limits', async () => {
    actions.simulateRenameRateLimit = true;
    for (const id of ['s1', 's2']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'stale', index: 0 },
      });
      voice.put(id, member('alice'));
    }
    const summary = await feature.rerenderSiblings(GUILD, 's1');
    expect(summary).toMatchObject({ considered: 2, renamed: 2, rateLimited: 2 });
  });

  it('getEditorState returns name + status (current + preview) for both scopes', async () => {
    await secondaries.create({
      channelId: 'ed',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0, template: 'My Room' },
    });
    voice.put('ed', member('alice', ['Halo']));

    // channel scope (/name): per-channel name override + inherited status.
    const ch = await feature.getEditorState('channel', GUILD, 'ed');
    expect(ch.found).toBe(true);
    expect(ch.name).toMatchObject({ currentTemplate: 'My Room', preview: 'My Room' });
    // No status override → inherits the default ("Playing @@game_name@@" since Halo).
    expect(ch.status.currentTemplate).toBeUndefined();
    expect(ch.status.preview).toBe('Playing Halo');
    expect(ch.ownerId).toBe('alice');

    // primary scope (/template): the primary's name template (ignores the override).
    const pr = await feature.getEditorState('primary', GUILD, 'ed');
    expect(pr.name).toMatchObject({ currentTemplate: '## [@@game_name@@]', preview: '#1 [Halo]' });

    expect((await feature.getEditorState('channel', GUILD, 'missing')).found).toBe(false);
  });

  /**
   * `/template` aimed at the creator channel itself. Reported by a customer on
   * 2026-09-02, who was stuck between two individually correct messages:
   * `/template` said the channel was not managed and offered an adopt button,
   * and the adopt button said "that's a creator channel, edit it with
   * `/template` directly".
   *
   * The cause was that both the read and the write path resolved the primary
   * ONLY through `secondary_channels`, so a creator channel with no live rooms
   * looked unmanaged to both.
   */
  it('getEditorState resolves a creator channel targeted directly, with no secondary', async () => {
    const pr = await feature.getEditorState('primary', GUILD, PRIMARY);
    expect(pr.found).toBe(true);
    expect(pr.primaryChannelId).toBe(PRIMARY);
    expect(pr.name.currentTemplate).toBe('## [@@game_name@@]');
    // Previews the FIRST room this creator spawns: empty, so `@@game_name@@`
    // falls back to "General", and `##` renders index 0 as 1.
    expect(pr.name.preview).toBe('#1 [General]');
    expect(pr.ownerId).toBeNull();
  });

  /**
   * The same first-room preview in the `/template` editor, which is the surface an admin
   * writes a `{{HIDDEN ?? ...}}` name on, so it has to preview the name the room will have.
   */
  it.each([
    ['public', {}, 'V-O'],
    ['locked', { defaultPrivate: true }, 'V-P'],
    ['hidden', { defaultPrivate: true, defaultHidden: true }, 'H-P'],
  ] as const)(
    'getEditorState previews a creator channel that starts rooms %s',
    async (_mode, template, expected) => {
      await autoChannels.upsert(GUILD, PRIMARY, {
        name: '{{HIDDEN ?? H // V}}-{{PRIVATE ?? P // O}}',
        ...template,
      });
      const pr = await feature.getEditorState('primary', GUILD, PRIMARY);
      expect(pr.found).toBe(true);
      expect(pr.name.preview.replace(/\s+/g, '')).toBe(expected);
    },
  );

  it('/name is NOT given the creator-channel fallback: it edits a secondary override', async () => {
    expect((await feature.getEditorState('channel', GUILD, PRIMARY)).found).toBe(false);
  });

  /**
   * What the creator channel editor and `/channelinfo` say about remembered room settings: the
   * switch, and how many members have something saved. The count is a read of its own, so these
   * pin when it is paid for and that it can never cost an admin their panel.
   */
  describe('remembered room settings readouts', () => {
    let prefs: MemberRoomPrefsRepository;
    let withPrefs: VoiceFeature;

    const featureWith = (memberPrefs: VoiceFeatureDeps['memberPrefs'], logger = fakeLogger()) =>
      new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger,
        ...(memberPrefs ? { memberPrefs } : {}),
      });

    beforeEach(async () => {
      await env.handle.db.delete(db.schema.memberRoomPrefs);
      prefs = new MemberRoomPrefsRepository(env.handle.db);
      withPrefs = featureWith(prefs);
      await secondaries.create({
        channelId: 'rm-room',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { index: 0 },
      });
      voice.put('rm-room', member('alice'));
    });

    const remember = (on: boolean) =>
      autoChannels.upsert(GUILD, PRIMARY, {
        name: '## [@@game_name@@]',
        ...(on ? { rememberPrefs: true } : {}),
      });

    describe('the creator channel editor', () => {
      it('says it does not remember, and that nobody has saved anything, by default', async () => {
        const state = await withPrefs.getEditorState('primary', GUILD, PRIMARY);
        expect(state).toMatchObject({ found: true, rememberPrefs: false, savedSettings: 0 });
      });

      it('says it remembers, and counts the members who have something saved', async () => {
        await remember(true);
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'den');
        await prefs.saveLimit(GUILD, PRIMARY, 'bob', 4);
        const state = await withPrefs.getEditorState('primary', GUILD, PRIMARY);
        expect(state).toMatchObject({ rememberPrefs: true, savedSettings: 2 });
      });

      /** Rows are kept when it is turned off, and the editor's Clear acts on them. */
      it('still counts what is kept while it is off', async () => {
        await remember(true);
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'den');
        await remember(false);
        const state = await withPrefs.getEditorState('primary', GUILD, PRIMARY);
        expect(state).toMatchObject({ rememberPrefs: false, savedSettings: 1 });
      });

      it('reads the same through one of the rooms, which is how /template is usually reached', async () => {
        await remember(true);
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'den');
        const state = await withPrefs.getEditorState('primary', GUILD, 'rm-room');
        expect(state).toMatchObject({
          rememberPrefs: true,
          savedSettings: 1,
          primaryChannelId: PRIMARY,
        });
      });

      it('counts this server only', async () => {
        await remember(true);
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'den');
        await env.handle.db.insert(db.schema.memberRoomPrefs).values({
          primaryChannelId: PRIMARY,
          userId: 'mallory',
          guildId: 'another-guild',
          nameTemplate: 'not yours',
        });
        const state = await withPrefs.getEditorState('primary', GUILD, PRIMARY);
        expect(state.savedSettings).toBe(1);
      });

      /** A room's own editor has no switch to show, so it carries neither field. */
      it('says nothing about it for a room editor', async () => {
        await remember(true);
        const state = await withPrefs.getEditorState('channel', GUILD, 'rm-room');
        expect(state.found).toBe(true);
        expect(state).not.toHaveProperty('rememberPrefs');
        expect(state).not.toHaveProperty('savedSettings');
      });

      it('leaves the count out, and still reports the switch, when it cannot count', async () => {
        await remember(true);
        const noPrefs = featureWith(undefined);
        const state = await noPrefs.getEditorState('primary', GUILD, PRIMARY);
        expect(state).toMatchObject({ found: true, rememberPrefs: true });
        expect(state).not.toHaveProperty('savedSettings');
      });

      /**
       * A number on an admin's panel is not worth the panel. It fails open: the count is left
       * out, which the panel shows as no count and never as nobody, and what is logged is ids.
       */
      it('fails open when the count throws, and logs ids and never anything typed', async () => {
        await remember(true);
        const warn = vi.fn();
        const failing = featureWith(
          { countByPrimary: () => Promise.reject(new Error('db down')) },
          { ...fakeLogger(), warn } as never,
        );
        const state = await failing.getEditorState('primary', GUILD, PRIMARY);
        expect(state).toMatchObject({ found: true, rememberPrefs: true });
        expect(state).not.toHaveProperty('savedSettings');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(Object.keys(warn.mock.calls[0]![0] as object).sort()).toEqual([
          'channelId',
          'err',
          'guildId',
        ]);
      });
    });

    describe('/channelinfo', () => {
      it('says it does not remember, and does not count, for a creator channel that never turned it on', async () => {
        const countByPrimary = vi.fn().mockResolvedValue(9);
        const counting = featureWith({ countByPrimary });
        const info = await counting.channelInfo(GUILD, PRIMARY);
        expect(info.primary?.rememberPrefs).toBeUndefined();
        expect(info.primary?.savedSettings).toBeUndefined();
        // Not paid for: this is a command any member can run.
        expect(countByPrimary).not.toHaveBeenCalled();
        await counting.channelInfo(GUILD, 'rm-room');
        expect(countByPrimary).not.toHaveBeenCalled();
      });

      it('counts the members with something saved, for the creator channel and for a room of it', async () => {
        await remember(true);
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'den');
        await prefs.savePrivacy(GUILD, PRIMARY, 'bob', 'hidden');

        const creator = await withPrefs.channelInfo(GUILD, PRIMARY);
        expect(creator.kind).toBe('creator');
        expect(creator.primary).toMatchObject({ rememberPrefs: true, savedSettings: 2 });

        const room = await withPrefs.channelInfo(GUILD, 'rm-room');
        expect(room.kind).toBe('room');
        expect(room.primary).toMatchObject({ rememberPrefs: true, savedSettings: 2 });
      });

      /**
       * The count is shown only in the admin section, so a viewer who is not an admin must not
       * cost the read, even for a creator channel that remembers.
       */
      it('does not count for a viewer who will not see it, and says it remembers all the same', async () => {
        await remember(true);
        const countByPrimary = vi.fn().mockResolvedValue(9);
        const counting = featureWith({ countByPrimary });

        const creator = await counting.channelInfo(GUILD, PRIMARY, { savedCount: false });
        expect(creator.primary?.rememberPrefs).toBe(true);
        expect(creator.primary).not.toHaveProperty('savedSettings');
        const room = await counting.channelInfo(GUILD, 'rm-room', { savedCount: false });
        expect(room.primary?.rememberPrefs).toBe(true);
        expect(room.primary).not.toHaveProperty('savedSettings');
        expect(countByPrimary).not.toHaveBeenCalled();

        // Counted when asked, and by default for a caller that does not say.
        expect(
          (await counting.channelInfo(GUILD, PRIMARY, { savedCount: true })).primary,
        ).toMatchObject({ savedSettings: 9 });
        expect((await counting.channelInfo(GUILD, PRIMARY)).primary).toMatchObject({
          savedSettings: 9,
        });
        expect(countByPrimary).toHaveBeenCalledTimes(2);
      });

      it('leaves the count out when it cannot be read, and still answers', async () => {
        await remember(true);
        const failing = featureWith({ countByPrimary: () => Promise.reject(new Error('db down')) });
        const info = await failing.channelInfo(GUILD, PRIMARY);
        expect(info.primary?.rememberPrefs).toBe(true);
        expect(info.primary).not.toHaveProperty('savedSettings');
        expect(info.kind).toBe('creator');
      });

      it('says it remembers without a count when this feature has no way to count', async () => {
        await remember(true);
        const info = await featureWith(undefined).channelInfo(GUILD, PRIMARY);
        expect(info.primary?.rememberPrefs).toBe(true);
        expect(info.primary).not.toHaveProperty('savedSettings');
      });
    });

    /**
     * `member_prefs.disabled` has consumers now, and an admin who reads "on" while nothing is
     * saved or restored would take it for a fault in their own setup. The lever is asked only of
     * a creator channel that remembers, and for a viewer who will see the line.
     */
    describe('while member_prefs.disabled is on', () => {
      const gateAnswering = (answer: () => Promise<boolean>) => ({
        allowCreate: () => Promise.resolve({ allowed: true }),
        memberPrefsDisabled: answer,
      });
      const withGate = (answer: () => Promise<boolean>) =>
        new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          memberPrefs: prefs,
          gate: gateAnswering(answer),
        });

      it('has the creator channel editor say so, and still counts what is kept', async () => {
        await remember(true);
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'den');
        const paused = withGate(() => Promise.resolve(true));

        const state = await paused.getEditorState('primary', GUILD, PRIMARY);

        expect(state).toMatchObject({
          rememberPrefs: true,
          savedSettings: 1,
          rememberPaused: true,
        });
        // Through one of its rooms too, which is how /template is usually reached.
        expect(await paused.getEditorState('primary', GUILD, 'rm-room')).toMatchObject({
          rememberPaused: true,
        });
      });

      it('has /channelinfo say so for the creator channel and for a room of it', async () => {
        await remember(true);
        const paused = withGate(() => Promise.resolve(true));

        expect((await paused.channelInfo(GUILD, PRIMARY)).primary).toMatchObject({
          rememberPrefs: true,
          rememberPaused: true,
        });
        expect((await paused.channelInfo(GUILD, 'rm-room')).primary).toMatchObject({
          rememberPaused: true,
        });
      });

      it('says nothing of it when the lever is off, or cannot be read', async () => {
        await remember(true);
        for (const answer of [
          () => Promise.resolve(false),
          () => Promise.reject(new Error('flags down')),
        ]) {
          const f = withGate(answer);
          expect(await f.getEditorState('primary', GUILD, PRIMARY)).not.toHaveProperty(
            'rememberPaused',
          );
          expect((await f.channelInfo(GUILD, PRIMARY)).primary).not.toHaveProperty(
            'rememberPaused',
          );
        }
      });

      it('is not asked of a creator channel that does not remember', async () => {
        const asked = vi.fn(() => Promise.resolve(true));
        const f = withGate(asked);

        expect(await f.getEditorState('primary', GUILD, PRIMARY)).not.toHaveProperty(
          'rememberPaused',
        );
        expect((await f.channelInfo(GUILD, PRIMARY)).primary).not.toHaveProperty('rememberPaused');
        expect(asked).not.toHaveBeenCalled();
      });

      it('is not asked for a viewer who will not see the line', async () => {
        await remember(true);
        const asked = vi.fn(() => Promise.resolve(true));
        const f = withGate(asked);

        const info = await f.channelInfo(GUILD, PRIMARY, { savedCount: false });

        expect(info.primary).not.toHaveProperty('rememberPaused');
        expect(asked).not.toHaveBeenCalled();
      });

      it('is not asked by a room editor, which has no switch to show', async () => {
        await remember(true);
        const asked = vi.fn(() => Promise.resolve(true));
        const state = await withGate(asked).getEditorState('channel', GUILD, 'rm-room');
        expect(state).not.toHaveProperty('rememberPaused');
        expect(asked).not.toHaveBeenCalled();
      });
    });
  });

  it('rerenderSecondary sets the voice status from the status template, and clears it when idle', async () => {
    await secondaries.create({
      channelId: 'st',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0 },
    });
    // Playing Blender → default status template renders "Playing Blender".
    voice.put('st', member('alice', ['Blender']));
    await feature.rerenderSecondary(GUILD, 'st');
    expect(actions.ofType('status').at(-1)).toMatchObject({
      channelId: 'st',
      status: 'Playing Blender',
    });
    expect((await secondaries.get('st'))!.state.status).toBe('Playing Blender');

    // Stops playing → status clears (empty), and a redundant rerender is a no-op.
    voice.put('st', member('alice'));
    await feature.rerenderSecondary(GUILD, 'st');
    expect(actions.ofType('status').at(-1)).toMatchObject({ channelId: 'st', status: '' });

    const before = actions.ofType('status').length;
    await feature.rerenderSecondary(GUILD, 'st');
    expect(actions.ofType('status').length).toBe(before); // no change → no extra status call
  });

  it('debugChannel reports the data behind a channel name', async () => {
    await secondaries.create({
      channelId: 'dbg',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0, seed: 7 },
    });
    voice.put('dbg', member('alice', ['Halo']));

    const info = await feature.debugChannel(GUILD, 'dbg');
    expect(info.isSecondary).toBe(true);
    expect(info.effectiveTemplate).toBe('## [@@game_name@@]');
    expect(info.computedGame).toBe('Halo');
    expect(info.renderedName).toBe('#1 [Halo]');
    expect(info.seed).toBe(7);
    expect(info.members).toHaveLength(1);
    expect(info.members[0]).toMatchObject({ id: 'alice', playing: ['Halo'] });
  });

  /**
   * Both diagnostics resolve the game the way the render path does.
   *
   * They each used to call `getGameName` with the aliases and the label alone,
   * so in a `top` guild they would report the shared-mode answer while the
   * channel carried a different name. A diagnostic that disagrees with the
   * thing it is describing is worse than no diagnostic.
   */
  it('reports the same game the channel is named after under top mode', async () => {
    await guilds.updateSettings(GUILD, { game_name_mode: 'top' });
    await secondaries.create({
      channelId: 'tie',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'bella',
      state: { index: 0, seed: 7 },
    });
    // Tied two-all, and the owner is on Doom, so the owner's game wins.
    voice.put('tie', member('alice', ['Halo']));
    voice.put('tie', member('bella', ['Doom']));
    voice.put('tie', member('carol', ['Halo']));
    voice.put('tie', member('dave', ['Doom']));

    await feature.rerenderSecondary(GUILD, 'tie');
    const renamed = actions.ofType('rename').at(-1);
    expect(renamed).toMatchObject({ channelId: 'tie', name: '#1 [Doom]' });

    const dbg = await feature.debugChannel(GUILD, 'tie');
    expect(dbg.computedGame).toBe('Doom');
    const info = await feature.channelInfo(GUILD, 'tie');
    expect(info.game).toBe('Doom');
    expect(info.rawGames).toEqual(['Doom']);

    // `beforeEach` clears the channel tables but not the guild row, and
    // `ensure` is `onConflictDoNothing`, so the mode would otherwise leak into
    // every test below this one. Harmless today only because none of them
    // builds a tie.
    await guilds.updateSettings(GUILD, { game_name_mode: 'shared' });
  });

  /**
   * `/channelinfo`'s four answers, which is the thing `debugChannel` gets wrong:
   * it never consults `managed`, so an adopted channel reads back as unmanaged.
   */
  describe('channelInfo', () => {
    it('resolves a room, with its template provenance and live context', async () => {
      await secondaries.create({
        channelId: 'ci-room',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        originalCreator: 'bob',
        state: { index: 0, seed: 7 },
      });
      voice.put('ci-room', member('alice', ['Halo']));

      const info = await feature.channelInfo(GUILD, 'ci-room');
      expect(info.kind).toBe('room');
      expect(info.ownerId).toBe('alice');
      expect(info.originalCreator).toBe('bob');
      expect(info.render?.synthetic).toBe(false);
      expect(info.render?.nameTemplate).toBe('## [@@game_name@@]');
      expect(info.render?.nameSource).toBe('creator');
      expect(info.game).toBe('Halo');
      expect(info.seed).toBe(7);
      // The context is the assembled one, so the panel can render through it.
      expect(renderChannelName(info.render!.nameTemplate, info.render!.ctx)).toBe('#1 [Halo]');
    });

    /**
     * `/channelinfo` has to tell hidden from locked, and the row's own `access` cannot: it
     * is null both for no record and for one this build cannot read.
     */
    describe('says how open a room is', () => {
      const room = async (channelId: string) => {
        await secondaries.create({
          channelId,
          guildId: GUILD,
          primaryChannelId: PRIMARY,
          ownerId: 'alice',
          state: { index: 0 },
        });
        voice.put(channelId, member('alice'));
      };

      it('public for a room with no record, and for a creator channel', async () => {
        await room('ci-public');
        const info = await feature.channelInfo(GUILD, 'ci-public');
        expect(info.accessMode).toBe('public');
        expect(info.isPrivate).toBe(false);
        expect((await feature.channelInfo(GUILD, PRIMARY)).accessMode).toBe('public');
      });

      it('locked for a private room that no record says is hidden', async () => {
        await room('ci-locked');
        await secondaries.updateState('ci-locked', {
          ...(await secondaries.get('ci-locked'))!.state,
          private: true,
        });
        const info = await feature.channelInfo(GUILD, 'ci-locked');
        expect(info.accessMode).toBe('locked');
        expect(info.isPrivate).toBe(true);
        expect(info.viewerRoleId).toBeUndefined();
      });

      it('hidden for a hidden room, still private for the condition probes, and names the role that sees it', async () => {
        await room('ci-hidden');
        await secondaries.transitionAccess('ci-hidden', {
          statePatch: { private: true },
          access: (stored) => ({ ...(stored ?? {}), hidden: true, viewerRoleId: 'mods' }),
        });
        const info = await feature.channelInfo(GUILD, 'ci-hidden');
        expect(info.accessMode).toBe('hidden');
        expect(info.isPrivate).toBe(true);
        expect(info.viewerRoleId).toBe('mods');
        // The probes render against this context, so it carries both, as the room's name does.
        expect(info.render?.ctx).toMatchObject({ isPrivate: true, isHidden: true });
      });

      it('hands the probes a locked room that is private and not hidden', async () => {
        await room('ci-locked-ctx');
        await secondaries.transitionAccess('ci-locked-ctx', {
          statePatch: { private: true },
          access: (stored) => stored,
        });
        const info = await feature.channelInfo(GUILD, 'ci-locked-ctx');
        expect(info.render?.ctx).toMatchObject({ isPrivate: true, isHidden: false });
      });

      /** A stale whole-state write dropping `private` from a hidden room must not make it read as public. */
      it('hidden even when a stale write dropped private from the state', async () => {
        await room('ci-stale');
        await secondaries.transitionAccess('ci-stale', {
          statePatch: { private: true },
          access: (stored) => ({ ...(stored ?? {}), hidden: true }),
        });
        const { private: _gone, ...rest } = (await secondaries.get('ci-stale'))!.state;
        await secondaries.updateState('ci-stale', rest);
        const info = await feature.channelInfo(GUILD, 'ci-stale');
        expect(info.accessMode).toBe('hidden');
        expect(info.isPrivate).toBe(true);
        expect(info.render?.ctx).toMatchObject({ isPrivate: true, isHidden: true });
      });

      it('unknown for a record this build cannot read, rather than public or locked', async () => {
        await room('ci-unknown');
        await secondaries.updateState('ci-unknown', {
          ...(await secondaries.get('ci-unknown'))!.state,
          private: true,
        });
        await env.handle.pool.query(
          'UPDATE secondary_channels SET access = $1::jsonb WHERE channel_id = $2',
          [JSON.stringify({ hidden: 'yes' }), 'ci-unknown'],
        );
        const info = await feature.channelInfo(GUILD, 'ci-unknown');
        expect(info.accessMode).toBe('unknown');
        expect(info.viewerRoleId).toBeUndefined();
      });
    });

    it("prefers the room's own override, and says so", async () => {
      await secondaries.create({
        channelId: 'ci-override',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { index: 0, template: 'My room' },
      });
      const info = await feature.channelInfo(GUILD, 'ci-override');
      expect(info.render?.nameTemplate).toBe('My room');
      expect(info.render?.nameSource).toBe('channel');
    });

    /**
     * A creator channel has no room, so its preview is synthetic and must be
     * flagged. Rendering against whoever is standing in the creator right now
     * would report a name no channel has ever had.
     */
    it('previews a creator channel from an empty first room, flagged synthetic', async () => {
      voice.put(PRIMARY, member('alice', ['Halo']));
      const info = await feature.channelInfo(GUILD, PRIMARY);
      expect(info.kind).toBe('creator');
      expect(info.render?.synthetic).toBe(true);
      expect(info.render?.ctx.members).toHaveLength(0);
      expect(info.primary?.channelId).toBe(PRIMARY);
    });

    /** The creator channel's own readout carries how its new rooms start, in all three states. */
    it.each([
      ['public', {}],
      ['locked', { defaultPrivate: true }],
      ['hidden', { defaultPrivate: true, defaultHidden: true }],
      // Leftover from an instance that predates the field: public, not hidden.
      ['public', { defaultHidden: true }],
    ] as const)('says a creator channel starts rooms %s', async (mode, template) => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: 'Room', ...template });
      expect((await feature.channelInfo(GUILD, PRIMARY)).primary?.defaultMode).toBe(mode);
    });

    /**
     * The first-room preview is of a room born in the creator channel's own mode, so the
     * conditions probed against it agree with the readout beside it. A preview that said
     * "no" to `{{HIDDEN}}` under "New rooms start: hidden" would contradict its own panel.
     */
    it.each([
      ['public', {}, 'V-O'],
      ['locked', { defaultPrivate: true }, 'V-P'],
      ['hidden', { defaultPrivate: true, defaultHidden: true }, 'H-P'],
      // Leftover from an instance that predates the field: public, not hidden.
      ['public', { defaultHidden: true }, 'V-O'],
    ] as const)(
      "previews a creator channel's first room as %s in /channelinfo",
      async (mode, template, expected) => {
        await autoChannels.upsert(GUILD, PRIMARY, {
          name: '{{HIDDEN ?? H // V}}-{{PRIVATE ?? P // O}}',
          ...template,
        });
        const info = await feature.channelInfo(GUILD, PRIMARY);
        expect(info.render?.ctx).toMatchObject({
          isPrivate: mode !== 'public',
          isHidden: mode === 'hidden',
        });
        expect(
          renderChannelName(info.render!.nameTemplate, info.render!.ctx).replace(/\s+/g, ''),
        ).toBe(expected);
      },
    );

    it('resolves an adopted channel that debugChannel reports as unmanaged', async () => {
      const f = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        managed,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
      });
      await managed.create({
        channelId: 'ci-adopted',
        guildId: GUILD,
        ownerId: 'alice',
        template: { name: 'Lounge __quiet/busy__' },
      });
      expect((await f.debugChannel(GUILD, 'ci-adopted')).isSecondary).toBe(false);

      const info = await f.channelInfo(GUILD, 'ci-adopted');
      expect(info.kind).toBe('managed');
      expect(info.render?.nameSource).toBe('managed');
      expect(info.render?.nameTemplate).toBe('Lounge __quiet/busy__');
    });

    it('reports an ordinary voice channel as unmanaged, with nothing to render', async () => {
      const info = await feature.channelInfo(GUILD, 'ci-nothing');
      expect(info.kind).toBe('unmanaged');
      expect(info.render).toBeUndefined();
    });
  });

  it('a default-private primary spawns its secondaries private (locked + companion)', async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    const joinChannels = new JoinChannelRepository(env.handle.db);
    const privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => 'bot',
    });
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      makePrivateOnCreate: (g, c, ownerId, ownerName) =>
        privacy.makePrivateForCreation(g, c, ownerId, ownerName),
    });
    // A prior test may have left the guild blocked; ensure it's entitled to create.
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room", defaultPrivate: true });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Locked to @everyone, the creator granted Connect by id, and a companion spawned.
    // One overwrite write now, in place of the lock and the grant as two calls: the
    // bot's own allow, the creator's Connect and the `@everyone` deny together.
    const held = actions.overwritesOf(secondaryId);
    expect(held).toContainEqual(expect.objectContaining({ id: 'bot', allow: BOT_ACCESS }));
    expect(held).toContainEqual(expect.objectContaining({ id: 'alice', allow: CONNECT }));
    expect(held).toContainEqual(expect.objectContaining({ id: GUILD, deny: CONNECT }));
    expect(actions.ofType('joinChannel')).toHaveLength(1);
    expect((await secondaries.get(secondaryId))!.state.private).toBe(true);
    // The channel is locked before the creator is moved into it.
    const lockIdx = actions.actions.findIndex(
      (a) => a.type === 'overwrites' && a.channelId === secondaryId,
    );
    const moveIdx = actions.actions.findIndex((a) => a.type === 'move' && a.memberId === 'alice');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(moveIdx);
  });

  it('deletes a default-private room it could not lock down, blaming the creator channel', async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    const joinChannels = new JoinChannelRepository(env.handle.db);
    const problems = new PermissionProblemTracker();
    const logs: { level: number; message: string }[] = [];
    // Wired into the service as well as the feature, as production does: a service
    // that records its own failure here is what put a second problem on the list.
    const privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => 'bot',
      permissionProblems: problems,
      serverLog: (_g, level, message) => logs.push({ level, message }),
    });
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
      serverLog: (_g, level, message) => logs.push({ level, message }),
      makePrivateOnCreate: (g, c, ownerId, ownerName) =>
        privacy.makePrivateForCreation(g, c, ownerId, ownerName),
    });
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room", defaultPrivate: true });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    // The lock is an overwrite write now, so that is what has to fail.
    actions.failOverwrites = true;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Created, then deleted again -- a locked room nobody, not even the
    // owner, can get into is worse than no room at all.
    expect(actions.ofType('delete')).toContainEqual(
      expect.objectContaining({ channelId: secondaryId }),
    );
    expect(await secondaries.get(secondaryId)).toBeUndefined();
    // Nobody was ever moved into a room they could not have gotten into anyway.
    expect(actions.ofType('move')).toEqual([]);

    // Same convention as a failed move: blame the creator channel, not the
    // secondary that's already gone by the time this is recorded.
    const recorded = problems.recent(GUILD);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.channelId).toBe(PRIMARY);
    expect(recorded[0]!.operation).toBe('privacy');
    // One line for the guild too, naming the creator channel and never the room
    // that is already deleted (a `<#id>` for it would be a dead link).
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain(`<#${PRIMARY}>`);
    expect(logs[0]!.message).not.toContain(secondaryId);
  });

  it('a public (default) primary spawns secondaries without locking them', async () => {
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      makePrivateOnCreate: () => Promise.reject(new Error('should not be called')),
    });
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room" });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    expect(actions.ofType('privacy')).toHaveLength(0);
    expect(actions.ofType('joinChannel')).toHaveLength(0);
  });

  /**
   * How a new room starts: open, locked behind a "⇩ Join" channel, or hidden from the channel
   * list. One value, read once per creation, from the creator channel's stored pair.
   */
  describe('how a new room starts', () => {
    const BOTH = VIEW_CHANNEL | CONNECT;
    const ABOVE = 'role-above-the-bot';

    /**
     * The feature wired as index.ts does: the privacy service behind makePrivateOnCreate.
     * `roomAccessDisabled` is the creation gate's answer for `room_access.disabled`, and
     * leaving it out leaves the feature with no gate at all.
     */
    function wire(over: { roomAccessDisabled?: () => Promise<boolean> } = {}) {
      const problems = new PermissionProblemTracker();
      const logs: { level: number; message: string }[] = [];
      const privacy = new PrivacyService({
        secondaries,
        joinChannels: new JoinChannelRepository(env.handle.db),
        actions,
        voice,
        logger: fakeLogger(),
        botUserId: () => 'bot',
        permissionProblems: problems,
        serverLog: (_g, level, message) => logs.push({ level, message }),
      });
      const views: { isPrivate: boolean; isHidden: boolean | 'unknown' }[] = [];
      const f = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        permissionProblems: problems,
        serverLog: (_g, level, message) => logs.push({ level, message }),
        ...(over.roomAccessDisabled
          ? {
              gate: {
                allowCreate: () => Promise.resolve({ allowed: true }),
                roomAccessDisabled: over.roomAccessDisabled,
              },
            }
          : {}),
        // As index.ts wires it: the mode rides along.
        makePrivateOnCreate: (g, c, ownerId, ownerName, mode) =>
          privacy.makePrivateForCreation(g, c, ownerId, ownerName, mode),
        controlPanel: {
          postForRoom: (_g, _room, _primary, _destination, view) => {
            views.push({ isPrivate: view.isPrivate, isHidden: view.isHidden });
            return Promise.resolve();
          },
          refreshForRoom: () => Promise.resolve(),
        },
      });
      return { f, problems, logs, views, privacy };
    }

    /** A name with its runs of spaces collapsed, so a branch's own padding is not the thing under test. */
    const spaced = (name: string): string => name.replace(/\s+/g, ' ').trim();

    /** Alice joins the creator channel, and the id of the room that was made for her. */
    async function join(f: VoiceFeature): Promise<string> {
      await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
      return actions.ofType('create')[0]!.channelId;
    }

    describe('a hidden creator channel', () => {
      beforeEach(async () => {
        await autoChannels.upsert(GUILD, PRIMARY, {
          name: "@@creator@@'s room",
          defaultPrivate: true,
          defaultHidden: true,
        });
      });

      it('spawns a room hidden from the channel list, with no Join channel', async () => {
        const { f } = wire();
        const id = await join(f);

        const held = actions.overwritesOf(id);
        // The bot's own allow, the creator's View and Connect by id (their move has not
        // reached the cache), and @everyone denied both.
        expect(held).toContainEqual(expect.objectContaining({ id: 'bot', allow: BOT_ACCESS }));
        expect(held).toContainEqual(expect.objectContaining({ id: 'alice', allow: BOTH }));
        expect(held).toContainEqual(expect.objectContaining({ id: GUILD, deny: BOTH }));
        // Nothing for a stranger to knock on, which would name the owner.
        expect(actions.ofType('joinChannel')).toHaveLength(0);
        expect(await new JoinChannelRepository(env.handle.db).getBySecondary(id)).toBeUndefined();
        // Recorded as hidden, and private for readers that predate hiding.
        const row = (await secondaries.get(id))!;
        expect(row.state.private).toBe(true);
        expect(row.access?.hidden).toBe(true);
      });

      it('writes the access before the owner is moved in, so the owner can enter', async () => {
        const { f } = wire();
        const id = await join(f);

        const hideIdx = actions.actions.findIndex(
          (a) => a.type === 'overwrites' && a.channelId === id,
        );
        const moveIdx = actions.actions.findIndex(
          (a) => a.type === 'move' && a.memberId === 'alice',
        );
        expect(hideIdx).toBeGreaterThanOrEqual(0);
        expect(hideIdx).toBeLessThan(moveIdx);
        // And the creator was moved: the room is not one they were shut out of.
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'alice', channelId: id }),
        );
      });

      it('reserves no slot above the room, since there is no Join channel to put there', async () => {
        const { f } = wire();
        await join(f);
        expect(actions.ofType('create')[0]!.reserveSlotAbove).toBeUndefined();
      });

      /**
       * The reason the create path hands the render its privacy explicitly: the access write
       * happens after the name is rendered, so reading it back would render HIDDEN and
       * PRIVATE as false and spend one of the room's two renames per ten minutes at once.
       */
      it('names the room hidden and private from the first render, with no second rename', async () => {
        await autoChannels.upsert(GUILD, PRIMARY, {
          name: '{{HIDDEN ?? 🙈 // 👁}}{{PRIVATE ?? 🔒 // 🔓}} @@creator@@',
          defaultPrivate: true,
          defaultHidden: true,
        });
        const { f } = wire();
        const id = await join(f);
        expect(spaced(actions.ofType('create')[0]!.name)).toBe('🙈 🔒 alice');

        // The room as it stands once Alice is in it, re-rendered the way every sweep does.
        voice.put(id, member('alice'));
        expect(await f.rerenderSecondary(GUILD, id)).toEqual({});
        expect(actions.ofType('rename')).toHaveLength(0);
      });

      it('hands the control panel a hidden room, not a public one', async () => {
        const { f, views } = wire();
        await join(f);
        expect(views).toEqual([{ isPrivate: true, isHidden: true }]);
      });

      it('deletes the room when it cannot be hidden, blaming the creator channel once', async () => {
        const { f, problems, logs } = wire();
        actions.failOverwrites = true;
        const id = await join(f);

        expect(actions.ofType('delete')).toContainEqual(expect.objectContaining({ channelId: id }));
        expect(await secondaries.get(id)).toBeUndefined();
        // A room nobody can see, or one that is open to everyone, is worse than no room.
        expect(actions.ofType('move')).toEqual([]);
        const recorded = problems.recent(GUILD);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ channelId: PRIMARY, operation: 'privacy' });
        expect(logs).toHaveLength(1);
        expect(logs[0]!.message).toContain(`<#${PRIMARY}>`);
        expect(logs[0]!.message).not.toContain(id);
      });

      /**
       * A role the bot cannot edit that shows the creator channel would show the room, so
       * the hide is refused. That is not a Discord error, and it must not leave an open room
       * behind a creator channel the admin set to hidden, or count against the guild.
       */
      it('deletes the room when a role above the bot would still show it', async () => {
        const { f, problems } = wire();
        voice.setBotRoleAccess({ uneditableRoleIds: [ABOVE] });
        actions.seedOverwrites('sec-1', [
          { id: ABOVE, type: OVERWRITE_ROLE, allow: VIEW_CHANNEL, deny: 0n },
        ]);
        const id = await join(f);

        expect(id).toBe('sec-1');
        expect(actions.ofType('delete')).toContainEqual(expect.objectContaining({ channelId: id }));
        expect(await secondaries.get(id)).toBeUndefined();
        expect(actions.ofType('move')).toEqual([]);
        expect(problems.recent(GUILD)).toEqual([
          expect.objectContaining({ channelId: PRIMARY, operation: 'privacy' }),
        ]);
      });

      it('still creates the room when the bot can neutralise the role', async () => {
        const { f } = wire();
        voice.setBotRoleAccess({ uneditableRoleIds: [] });
        actions.seedOverwrites('sec-1', [
          { id: ABOVE, type: OVERWRITE_ROLE, allow: VIEW_CHANNEL, deny: 0n },
        ]);
        const id = await join(f);
        expect((await secondaries.get(id))!.access?.hidden).toBe(true);
        // The role's View is flipped on this room's copy, or it would still show it.
        expect(actions.overwritesOf(id)).toContainEqual(
          expect.objectContaining({ id: ABOVE, deny: VIEW_CHANNEL }),
        );
      });

      /**
       * Any other failure to hide (a Discord 5xx, a dropped socket) leaves the same open room
       * in everyone's channel list, named after its owner, so the room is deleted for it too.
       * The error is still thrown for the guild's breaker, and no notice blames the admin for
       * a fault that is not a permission or a role.
       */
      it('deletes the room for any other failure to hide it, and still throws it', async () => {
        const problems = new PermissionProblemTracker();
        const removed: string[] = [];
        const failing = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          permissionProblems: problems,
          onSecondaryRemoved: (_g, channelId) => {
            removed.push(channelId);
            return Promise.resolve();
          },
          makePrivateOnCreate: () => Promise.reject(new Error('socket hang up')),
        });
        await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
        const alice = member('alice');
        voice.put(PRIMARY, alice);
        await expect(
          failing.handleVoiceStateUpdate({
            guildId: GUILD,
            member: alice,
            afterChannelId: PRIMARY,
          }),
        ).rejects.toThrow('socket hang up');

        const id = actions.ofType('create')[0]!.channelId;
        expect(actions.ofType('delete')).toContainEqual(expect.objectContaining({ channelId: id }));
        expect(await secondaries.get(id)).toBeUndefined();
        expect(removed).toEqual([id]);
        // Nobody was moved into it, and the admin is not told to fix a permission.
        expect(actions.ofType('move')).toEqual([]);
        expect(problems.recent(GUILD)).toEqual([]);
      });

      it('throws the original failure even when cleaning the room up fails too', async () => {
        const failing = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          onSecondaryRemoved: () => Promise.reject(new Error('cleanup failed')),
          makePrivateOnCreate: () => Promise.reject(new Error('socket hang up')),
        });
        await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
        const alice = member('alice');
        voice.put(PRIMARY, alice);
        await expect(
          failing.handleVoiceStateUpdate({
            guildId: GUILD,
            member: alice,
            afterChannelId: PRIMARY,
          }),
        ).rejects.toThrow('socket hang up');
      });

      /**
       * The plan refuses a hide for either reason, and the room is deleted for both. The role
       * case is above, and a room whose copied overrides leave no room for the hide is the
       * other, which is a refusal and not a Discord error, so it is checked on its own.
       */
      it('deletes the room when its permissions leave no room for the hide', async () => {
        const { f, problems } = wire();
        actions.seedOverwrites(
          'sec-1',
          Array.from({ length: MAX_PLANNED_OVERWRITES }, (_, i) => ({
            id: `foreign-${i}`,
            type: OVERWRITE_ROLE,
            allow: 0n,
            deny: VIEW_CHANNEL,
          })),
        );
        const id = await join(f);

        expect(id).toBe('sec-1');
        expect(actions.ofType('delete')).toContainEqual(expect.objectContaining({ channelId: id }));
        expect(await secondaries.get(id)).toBeUndefined();
        expect(actions.ofType('move')).toEqual([]);
        expect(problems.recent(GUILD)).toEqual([
          expect.objectContaining({ channelId: PRIMARY, operation: 'privacy' }),
        ]);
      });

      /**
       * `room_access.disabled` stops new hides, and a hidden creator channel is the one
       * creation that hides. A locked room is what an instance that predates hiding makes
       * from the same stored setting, so the room is still private and never open. It is
       * decided before the render, so the name and the panel say what the room is.
       */
      describe('while room_access.disabled is on', () => {
        beforeEach(async () => {
          await autoChannels.upsert(GUILD, PRIMARY, {
            name: '{{HIDDEN ?? 🙈 // 👁}}{{PRIVATE ?? 🔒 // 🔓}} @@creator@@',
            defaultPrivate: true,
            defaultHidden: true,
          });
        });

        it('makes a locked room, with a Join channel, and not a hidden one', async () => {
          const { f, views } = wire({ roomAccessDisabled: () => Promise.resolve(true) });
          const id = await join(f);

          const held = actions.overwritesOf(id);
          expect(held).toContainEqual(expect.objectContaining({ id: GUILD, deny: CONNECT }));
          expect(held).not.toContainEqual(expect.objectContaining({ id: GUILD, deny: BOTH }));
          expect(actions.ofType('joinChannel')).toHaveLength(1);
          expect(actions.ofType('create')[0]!.reserveSlotAbove).toBe(true);
          const row = (await secondaries.get(id))!;
          expect(row.state.private).toBe(true);
          expect(row.access?.hidden).not.toBe(true);
          expect(views).toEqual([{ isPrivate: true, isHidden: false }]);
          // The creator channel's own setting is untouched: the next room after the lever is
          // lifted is hidden again.
          expect(startModeOf((await autoChannels.get(PRIMARY))!.template)).toBe('hidden');
        });

        it('renders the first name as a locked room, with no second rename', async () => {
          const { f } = wire({ roomAccessDisabled: () => Promise.resolve(true) });
          const id = await join(f);
          expect(spaced(actions.ofType('create')[0]!.name)).toBe('👁 🔒 alice');

          voice.put(id, member('alice'));
          expect(await f.rerenderSecondary(GUILD, id)).toEqual({});
          expect(actions.ofType('rename')).toHaveLength(0);
        });

        it('hides the room as the admin asked once the lever is lifted', async () => {
          let on = true;
          const { f } = wire({ roomAccessDisabled: () => Promise.resolve(on) });
          const first = await join(f);
          expect((await secondaries.get(first))!.access?.hidden).not.toBe(true);

          on = false;
          // A second member, because the first is still standing in the creator channel.
          const bob = member('bob');
          voice.put(PRIMARY, bob);
          await f.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: PRIMARY });
          const second = actions.ofType('create')[1]!.channelId;
          expect((await secondaries.get(second))!.access?.hidden).toBe(true);
        });

        it('fails open: a gate that cannot answer hides the room', async () => {
          const { f } = wire({ roomAccessDisabled: () => Promise.reject(new Error('flags down')) });
          const id = await join(f);
          expect((await secondaries.get(id))!.access?.hidden).toBe(true);
          expect(actions.ofType('joinChannel')).toHaveLength(0);
        });

        /**
         * The lever is asked only of a creator channel that starts hidden, which is what keeps
         * it free for every other creation: the gate's snapshot is cached, but an open or a
         * locked creator channel has no reason to read it at all.
         */
        it.each([
          ['an open', {}],
          ['a locked', { defaultPrivate: true }],
        ] as const)(
          'is not asked of %s creator channel, and does not change it',
          async (_n, template) => {
            await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room", ...template });
            const asked = vi.fn(() => Promise.resolve(true));
            const { f } = wire({ roomAccessDisabled: asked });
            const id = await join(f);
            expect(asked).not.toHaveBeenCalled();
            const row = (await secondaries.get(id))!;
            expect(row.state.private === true).toBe('defaultPrivate' in template);
          },
        );
      });
    });

    describe('a locked creator channel', () => {
      beforeEach(async () => {
        await autoChannels.upsert(GUILD, PRIMARY, {
          name: "@@creator@@'s room",
          defaultPrivate: true,
        });
      });

      it('is unchanged: a Join channel, a reserved slot, and the owner allowed to connect', async () => {
        const { f, views } = wire();
        const id = await join(f);

        expect(actions.ofType('create')[0]!.reserveSlotAbove).toBe(true);
        expect(actions.ofType('joinChannel')).toHaveLength(1);
        const held = actions.overwritesOf(id);
        expect(held).toContainEqual(expect.objectContaining({ id: 'alice', allow: CONNECT }));
        expect(held).toContainEqual(expect.objectContaining({ id: GUILD, deny: CONNECT }));
        const row = (await secondaries.get(id))!;
        expect(row.state.private).toBe(true);
        expect(row.access?.hidden).not.toBe(true);
        expect(views).toEqual([{ isPrivate: true, isHidden: false }]);
      });

      it('names the room private and not hidden from the first render', async () => {
        await autoChannels.upsert(GUILD, PRIMARY, {
          name: '{{HIDDEN ?? 🙈 // 👁}}{{PRIVATE ?? 🔒 // 🔓}} @@creator@@',
          defaultPrivate: true,
        });
        const { f } = wire();
        const id = await join(f);
        expect(spaced(actions.ofType('create')[0]!.name)).toBe('👁 🔒 alice');
        voice.put(id, member('alice'));
        expect(await f.rerenderSecondary(GUILD, id)).toEqual({});
        expect(actions.ofType('rename')).toHaveLength(0);
      });

      /**
       * Only a hidden room is deleted for a failure that is not a refusal or a permission. A
       * locked room that fails that way is left to the sweep and the breaker, as it always
       * was, and this keeps the widening above from reaching it.
       */
      it('leaves the room for a failure that is not a refusal or a permission', async () => {
        const failing = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          makePrivateOnCreate: () => Promise.reject(new Error('socket hang up')),
        });
        await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
        const alice = member('alice');
        voice.put(PRIMARY, alice);
        await expect(
          failing.handleVoiceStateUpdate({
            guildId: GUILD,
            member: alice,
            afterChannelId: PRIMARY,
          }),
        ).rejects.toThrow('socket hang up');
        expect(actions.ofType('delete')).toHaveLength(0);
      });

      it('deletes the room when its permissions leave no room for the lock', async () => {
        const { f, problems } = wire();
        actions.seedOverwrites(
          'sec-1',
          Array.from({ length: MAX_PLANNED_OVERWRITES }, (_, i) => ({
            id: `foreign-${i}`,
            type: OVERWRITE_ROLE,
            allow: 0n,
            deny: VIEW_CHANNEL,
          })),
        );
        const id = await join(f);

        expect(actions.ofType('delete')).toContainEqual(expect.objectContaining({ channelId: id }));
        expect(await secondaries.get(id)).toBeUndefined();
        expect(problems.recent(GUILD)).toEqual([
          expect.objectContaining({ channelId: PRIMARY, operation: 'privacy' }),
        ]);
      });
    });

    /**
     * Hidden is a kind of private, so `defaultHidden` on its own is a leftover and not an
     * instruction (an instance that predates the field can switch `defaultPrivate` off and
     * leave it behind), and honouring it would hide the rooms of an admin who went back to
     * public.
     */
    it('reads defaultHidden without defaultPrivate as public', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, {
        name: '{{HIDDEN ?? 🙈 // 👁}} @@creator@@',
        defaultHidden: true,
      });
      const { f, views } = wire();
      const id = await join(f);

      expect(actions.ofType('create')[0]!.name).toBe('👁 alice');
      expect(actions.ofType('create')[0]!.reserveSlotAbove).toBeUndefined();
      expect(actions.ofType('overwrites')).toHaveLength(0);
      expect(actions.ofType('joinChannel')).toHaveLength(0);
      const row = (await secondaries.get(id))!;
      expect(row.state.private).not.toBe(true);
      expect(row.access).toBeNull();
      expect(views).toEqual([{ isPrivate: false, isHidden: false }]);
    });

    it('never touches privacy for a public creator channel', async () => {
      const f = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        makePrivateOnCreate: () => Promise.reject(new Error('should not be called')),
      });
      await join(f);
      expect(actions.ofType('overwrites')).toHaveLength(0);
    });
  });

  /**
   * `{{PRIVATE}}` and `{{HIDDEN}}` for a room that exists, which every render path reads from the
   * row: the sweep and every command's re-render, `/debug` and the `/template` preview. A
   * hidden room is private as well, and it is hidden whatever a stale whole-state write did to
   * `state.private`, so the row is made the way a stale write leaves it.
   */
  describe('a room that exists renders its own privacy', () => {
    const NAME = '{{HIDDEN ?? H // V}}-{{PRIVATE ?? P // O}}';
    /** The engine pads a branch with spaces, which is not what these assert. */
    const squash = (name: string | undefined): string => (name ?? '').replace(/\s+/g, '');
    const rows = [
      ['public', 'V-O'],
      ['locked', 'V-P'],
      ['hidden', 'H-P'],
    ] as const;

    async function roomIn(mode: (typeof rows)[number][0]): Promise<string> {
      const id = `priv-${mode}`;
      await autoChannels.upsert(GUILD, PRIMARY, { name: NAME });
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { index: 0, name: 'stale' },
      });
      voice.put(id, member('alice'));
      if (mode !== 'public') {
        await secondaries.transitionAccess(id, {
          statePatch: { private: true },
          access: (stored) => (mode === 'hidden' ? { ...(stored ?? {}), hidden: true } : stored),
        });
      }
      if (mode === 'hidden') {
        // What a stale whole-state write leaves: hidden in the record, and no `private`.
        const { private: _gone, ...rest } = (await secondaries.get(id))!.state;
        await secondaries.updateState(id, rest);
      }
      return id;
    }

    it.each(rows)('renames a %s room to %s on a re-render', async (mode, expected) => {
      const id = await roomIn(mode);
      await feature.rerenderSecondary(GUILD, id);
      const renamed = actions.ofType('rename').at(-1);
      expect(renamed?.channelId).toBe(id);
      expect(squash(renamed?.name)).toBe(expected);
    });

    it.each(rows)('shows a %s room as %s in /debug', async (mode, expected) => {
      const id = await roomIn(mode);
      expect(squash((await feature.debugChannel(GUILD, id)).renderedName)).toBe(expected);
    });

    it.each(rows)('previews a %s room as %s in the /name editor', async (mode, expected) => {
      const id = await roomIn(mode);
      const editor = await feature.getEditorState('channel', GUILD, id);
      expect(squash(editor.name.preview)).toBe(expected);
    });
  });

  describe('adopted standalone channels (managed)', () => {
    const ADOPTED = 'adopted-vc';
    let f: VoiceFeature;

    beforeEach(() => {
      f = new VoiceFeature({
        autoChannels,
        secondaries,
        managed,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
      });
    });

    it('adopts a channel: seeds owner from occupants and renders the occupied name', async () => {
      const alice = member('alice');
      voice.put(ADOPTED, alice);

      const res = await f.adoptChannel(GUILD, ADOPTED, 'General');
      expect(res.ok).toBe(true);

      const row = (await managed.get(ADOPTED))!;
      expect(row.ownerId).toBe('alice');
      expect(row.template.name).toBe("__General/@@owner@@'s room__");
      // Occupied → "Alice's room".
      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: "alice's room",
      });
    });

    it('refuses to adopt a primary or an already-adopted channel', async () => {
      expect((await f.adoptChannel(GUILD, PRIMARY, 'x')).ok).toBe(false);
      voice.put(ADOPTED, member('alice'));
      await f.adoptChannel(GUILD, ADOPTED, 'General');
      expect((await f.adoptChannel(GUILD, ADOPTED, 'General')).ok).toBe(false);
    });

    it('drops a managed channel confirmed deleted on Discord, without pestering the admin', async () => {
      const logs: { level: number; message: string }[] = [];
      const problems = new PermissionProblemTracker();
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        managed,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        serverLog: (_g, level, message) => logs.push({ level, message }),
        permissionProblems: problems,
      });
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await feature.adoptChannel(GUILD, ADOPTED, 'General');

      // The channel is deleted on Discord; the next rename confirms it is gone.
      actions.renameGoneForChannel = ADOPTED;
      voice.drop(ADOPTED, 'alice');
      await feature.rerenderManaged(GUILD, ADOPTED, { onUnmanageable: 'abandon' });

      // The row is gone, so reconcile can never retry the impossible rename.
      expect(await managed.get(ADOPTED)).toBeUndefined();
      // Deleting your own channel is not a permission problem: say nothing.
      expect(problems.recent(GUILD)).toHaveLength(0);
      expect(logs.filter((l) => l.level === 1)).toHaveLength(0);
    });

    it('gives up an adopted channel it can no longer rename (Missing Access), notifying instead of retrying', async () => {
      const logs: { level: number; message: string }[] = [];
      const problems = new PermissionProblemTracker();
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        managed,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        serverLog: (_g, level, message) => logs.push({ level, message }),
        permissionProblems: problems,
      });
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await feature.adoptChannel(GUILD, ADOPTED, 'General');

      // The channel still exists but an override hid it from us.
      actions.failRenameForChannel = ADOPTED;
      voice.drop(ADOPTED, 'alice');
      await feature.rerenderManaged(GUILD, ADOPTED, { onUnmanageable: 'abandon' });

      expect(await managed.get(ADOPTED)).toBeUndefined();
      expect(problems.recent(GUILD).map((p) => p.operation)).toContain('rename');
      expect(logs.some((l) => l.level === 1 && l.message.includes('lost access'))).toBe(true);
    });

    it('keeps the admin’s template when an interactive rename hits a permission error', async () => {
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await f.adoptChannel(GUILD, ADOPTED, 'General');
      const before = (await managed.get(ADOPTED))!.template;

      // An interactive caller (the `/template` editor) must never have the
      // template it just saved binned under it for a recoverable problem.
      actions.failRenameForChannel = ADOPTED;
      voice.drop(ADOPTED, 'alice');
      await expect(f.rerenderManaged(GUILD, ADOPTED)).rejects.toThrow();

      const after = await managed.get(ADOPTED);
      expect(after).toBeDefined();
      expect(after!.template).toEqual(before);
    });

    it('stops tracking managed and secondary channels deleted on Discord', async () => {
      voice.put(ADOPTED, member('alice'));
      await f.adoptChannel(GUILD, ADOPTED, 'General');
      await secondaries.create({
        channelId: 'sec-gone',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'Gone', index: 0 },
      });

      await f.handleChannelDeleted(GUILD, ADOPTED);
      await f.handleChannelDeleted(GUILD, 'sec-gone');

      expect(await managed.get(ADOPTED)).toBeUndefined();
      expect(await secondaries.get('sec-gone')).toBeUndefined();
      // Idempotent: a redelivered event must not throw.
      await expect(f.handleChannelDeleted(GUILD, ADOPTED)).resolves.toBeUndefined();
    });

    /**
     * The primaries branch. Without it a deleted creator channel left an
     * `auto_channels` row that nothing anywhere removed, so `/setup` listed a
     * channel that no longer existed for as long as the guild lived.
     */
    it('stops tracking a creator channel deleted on Discord', async () => {
      expect(await autoChannels.get(PRIMARY)).toBeDefined();

      await f.handleChannelDeleted(GUILD, PRIMARY);

      expect(await autoChannels.get(PRIMARY)).toBeUndefined();
      // Idempotent: a redelivered event must not throw.
      await expect(f.handleChannelDeleted(GUILD, PRIMARY)).resolves.toBeUndefined();
    });

    it('ignores a deleted channel belonging to another guild', async () => {
      await f.handleChannelDeleted('some-other-guild', PRIMARY);

      expect(await autoChannels.get(PRIMARY)).toBeDefined();
    });

    it('renames to the resting name when emptied — and never deletes the channel', async () => {
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await f.adoptChannel(GUILD, ADOPTED, 'General');

      // alice leaves → channel empties.
      voice.drop(ADOPTED, 'alice');
      const touched = await f.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        beforeChannelId: ADOPTED,
      });
      expect(touched).toContain(ADOPTED);
      await f.rerenderManaged(GUILD, ADOPTED); // the scheduler does this in production

      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: 'General',
      });
      expect(actions.ofType('delete')).toHaveLength(0);
      expect(await managed.get(ADOPTED)).toBeDefined();
      expect((await managed.get(ADOPTED))!.ownerId).toBeNull();
    });

    it('claims ownership and shows the occupied name when someone joins an empty one', async () => {
      await managed.create({
        channelId: ADOPTED,
        guildId: GUILD,
        template: { name: "__General/@@creator@@'s room__" },
        state: { seed: 1, name: 'General' },
      });
      const bob = member('bob');
      voice.put(ADOPTED, bob);

      await f.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: ADOPTED });
      expect((await managed.get(ADOPTED))!.ownerId).toBe('bob');
      await f.rerenderManaged(GUILD, ADOPTED);
      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: "bob's room",
      });
    });

    it('edits templates, stops managing, and exposes editor state', async () => {
      voice.put(ADOPTED, member('alice'));
      await f.adoptChannel(GUILD, ADOPTED, 'General');

      const editor = await f.getManagedEditorState(GUILD, ADOPTED);
      expect(editor.found).toBe(true);
      expect(editor.name.currentTemplate).toBe("__General/@@owner@@'s room__");

      expect((await f.setManagedName(GUILD, ADOPTED, '__Lobby/@@creator@@ is live__')).ok).toBe(
        true,
      );
      expect((await managed.get(ADOPTED))!.template.name).toBe('__Lobby/@@creator@@ is live__');
      expect((await f.setManagedName(GUILD, ADOPTED, '   ')).ok).toBe(false); // blank rejected

      const stop = await f.stopManaging(GUILD, ADOPTED);
      expect(stop.ok).toBe(true);
      expect(await managed.get(ADOPTED)).toBeUndefined();
    });

    it('reconcile converges names, never deletes, and drops vanished records', async () => {
      // A live adopted channel whose stored name has drifted from reality.
      await managed.create({
        channelId: ADOPTED,
        guildId: GUILD,
        ownerId: 'alice',
        template: { name: "__General/@@creator@@'s room__" },
        state: { seed: 1, name: 'STALE', roster: ['alice'] },
      });
      voice.put(ADOPTED, member('alice'));
      // A vanished adopted channel (record exists, channel gone).
      await managed.create({
        channelId: 'gone-vc',
        guildId: GUILD,
        template: { name: '__X/Y__' },
        state: {},
      });

      await f.reconcileGuild(GUILD);

      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: "alice's room",
      });
      expect(actions.ofType('delete')).toHaveLength(0); // adopted channels are never deleted
      expect(await managed.get(ADOPTED)).toBeDefined();
      expect(await managed.get('gone-vc')).toBeUndefined(); // stale record dropped
    });
  });

  describe('category grouping (/group)', () => {
    const CAT = 'cat-1';
    const A = 'primary-A';
    const B = 'primary-B';

    beforeEach(async () => {
      await autoChannels.upsert(GUILD, A, { name: '## room' });
      await autoChannels.upsert(GUILD, B, { name: '## room' });
      voice.setParent(A, CAT);
      voice.setParent(B, CAT);
      await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
      // The guilds row persists across tests, so clear any grouping from a prior one.
      await guilds.updateSettings(GUILD, { groups: {} });
    });

    const enableGroup = (above = false): Promise<unknown> =>
      guilds.updateSettings(GUILD, { groups: { [CAT]: { above } } });

    it('numbers group-wide and positions one block across primaries on create', async () => {
      await enableGroup(false); // below
      const alice = member('alice');
      voice.put(A, alice);
      await feature.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: A });
      const sA = actions.ofType('create').at(-1)!.channelId;
      voice.put(sA, alice);
      voice.drop(A, 'alice');

      const bob = member('bob');
      voice.put(B, bob);
      await feature.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: B });
      const sB = actions.ofType('create').at(-1)!.channelId;

      // Group-wide numbering across the two primaries: #1 then #2.
      expect((await secondaries.get(sA))!.state.index).toBe(0);
      expect((await secondaries.get(sB))!.state.index).toBe(1);
      expect(actions.ofType('create').map((a) => a.name)).toEqual(['#1 room', '#2 room']);

      // One block of both secondaries, below all primaries.
      const rg = actions.ofType('repositionGroup').at(-1)!;
      expect(rg.channelIds).toEqual([sA, sB]);
      expect(new Set(rg.primaryChannelIds)).toEqual(new Set([A, B]));
      expect(rg.above).toBe(false);

      // Appending a new channel never renames the existing ones (no churn).
      expect(actions.ofType('rename')).toHaveLength(0);
    });

    it('anchors a grouped create at the group, not at the primary joined', async () => {
      // The three-jump case in the recording. A grouped block is positioned
      // relative to EVERY creator channel in the category, so anchoring the
      // create at whichever primary the member happened to join put the room
      // somewhere the group rule then had to undo. Worse, it used that primary's
      // own above flag, which here points the opposite way to the group's, so the
      // room was placed above the primary and then moved below both of them.
      await enableGroup(false); // the group sits BELOW every primary
      await autoChannels.upsert(GUILD, A, { name: '## room' });
      await autoChannels.upsert(GUILD, B, { name: '## room', above: true });
      voice.setPosition(A, 10);
      voice.setPosition(B, 20);

      const bob = member('bob');
      voice.put(B, bob);
      await feature.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: B });

      const created = actions.ofType('create').at(-1)!;
      // The GROUP's direction, never this primary's own (which says above).
      expect(created.above).toBe(false);
      // Anchored at the bottom-most primary of the group, where the block goes.
      expect(created.anchorChannelId).toBe(B);
      // ...but the room still BELONGS to the primary the member joined, which is
      // what gives it its category and, by default, its permission overwrites.
      // Collapsing the two is how a grouped room came to copy a different creator
      // channel's permissions.
      expect(created.nearChannelId).toBe(B);
    });

    it('anchors an above-group create at the topmost primary', async () => {
      await enableGroup(true); // the group sits ABOVE every primary
      voice.setPosition(A, 10);
      voice.setPosition(B, 20);

      const bob = member('bob');
      voice.put(B, bob);
      await feature.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: B });

      const created = actions.ofType('create').at(-1)!;
      expect(created.above).toBe(true);
      expect(created.anchorChannelId).toBe(A);
      // Placed against A, but still B's room: B is what it inherits from.
      expect(created.nearChannelId).toBe(B);
    });

    it('resyncCategory renumbers group-wide and repositions the block', async () => {
      await enableGroup(true); // above
      await secondaries.create({
        channelId: 's1',
        guildId: GUILD,
        primaryChannelId: A,
        ownerId: 'a',
        state: { name: 'stale', index: 5 },
      });
      await secondaries.create({
        channelId: 's2',
        guildId: GUILD,
        primaryChannelId: B,
        ownerId: 'b',
        state: { name: 'stale', index: 9 },
      });
      voice.put('s1', member('a'));
      voice.put('s2', member('b'));

      const summary = await feature.resyncCategory(GUILD, CAT);
      expect(summary.considered).toBe(2);
      expect((await secondaries.get('s1'))!.state.index).toBe(0);
      expect((await secondaries.get('s2'))!.state.index).toBe(1);
      expect(actions.ofType('rename').map((a) => a.name)).toEqual(['#1 room', '#2 room']);
      const rg = actions.ofType('repositionGroup').at(-1)!;
      expect(rg.channelIds).toEqual(['s1', 's2']);
      expect(rg.above).toBe(true);
    });

    it('resyncCategory reverts to per-primary numbering + positioning when not grouped', async () => {
      // No group config → ungrouped path.
      for (const [p, id] of [
        [A, 'a1'],
        [A, 'a2'],
        [B, 'b1'],
      ] as const) {
        await secondaries.create({
          channelId: id,
          guildId: GUILD,
          primaryChannelId: p,
          ownerId: 'o',
          state: { name: 'stale', index: 7 },
        });
        voice.put(id, member('o'));
      }

      await feature.resyncCategory(GUILD, CAT);
      // Per-primary numbering: A → 0,1 ; B → 0.
      expect((await secondaries.get('a1'))!.state.index).toBe(0);
      expect((await secondaries.get('a2'))!.state.index).toBe(1);
      expect((await secondaries.get('b1'))!.state.index).toBe(0);
      // Per-primary reposition for each primary — not a single group reposition.
      expect(actions.ofType('repositionGroup')).toHaveLength(0);
      expect(
        actions
          .ofType('reposition')
          .map((a) => a.primaryChannelId)
          .sort(),
      ).toEqual([A, B].sort());
    });

    it('reconcile compacts group numbering + repositions, and never deletes', async () => {
      await enableGroup(false);
      await secondaries.create({
        channelId: 's1',
        guildId: GUILD,
        primaryChannelId: A,
        ownerId: 'a',
        state: { name: 'STALE', index: 3 },
      });
      await secondaries.create({
        channelId: 's2',
        guildId: GUILD,
        primaryChannelId: B,
        ownerId: 'b',
        state: { name: 'STALE', index: 8 },
      });
      voice.put('s1', member('a'));
      voice.put('s2', member('b'));

      await feature.reconcileGuild(GUILD);
      expect((await secondaries.get('s1'))!.state.index).toBe(0);
      expect((await secondaries.get('s2'))!.state.index).toBe(1);
      const names = actions.ofType('rename').map((a) => a.name);
      expect(names).toContain('#1 room');
      expect(names).toContain('#2 room');
      expect(actions.ofType('repositionGroup').length).toBeGreaterThan(0);
      expect(actions.ofType('delete')).toHaveLength(0);
    });

    it('groups root-level primaries via the @root sentinel', async () => {
      voice.setParent(A, null);
      voice.setParent(B, null);
      await guilds.updateSettings(GUILD, { groups: { '@root': { above: true } } });
      await secondaries.create({
        channelId: 'r1',
        guildId: GUILD,
        primaryChannelId: A,
        ownerId: 'a',
        state: { name: 'x', index: 0 },
      });
      await secondaries.create({
        channelId: 'r2',
        guildId: GUILD,
        primaryChannelId: B,
        ownerId: 'b',
        state: { name: 'x', index: 0 },
      });
      voice.put('r1', member('a'));
      voice.put('r2', member('b'));

      await feature.resyncCategory(GUILD, '@root');
      expect((await secondaries.get('r1'))!.state.index).toBe(0);
      expect((await secondaries.get('r2'))!.state.index).toBe(1);
      const rg = actions.ofType('repositionGroup').at(-1)!;
      expect(rg.channelIds).toEqual(['r1', 'r2']);
      expect(rg.above).toBe(true);
    });
  });
  /**
   * The wiring, not the service: that the live voice path actually reaches
   * companion text channels at the three moments it has to. The service itself
   * is covered in companionText.integration.test.ts.
   */
  describe('companion text channels', () => {
    let companions: CompanionChannelRepository;
    let companionText: CompanionTextService;

    beforeEach(async () => {
      companions = new CompanionChannelRepository(env.handle.db);
      await env.handle.db.delete(db.schema.companionChannels);
      companionText = new CompanionTextService({
        companions,
        secondaries,
        autoChannels,
        guilds,
        actions,
        voice,
        logger: fakeLogger(),
      });
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        companionText,
        onSecondaryRemoved: (gid, cid) => companionText.removeForRoom(gid, cid),
      });
      await autoChannels.upsert(GUILD, PRIMARY, { name: 'Room', textChannel: true });
    });

    it('makes one with the room, keeps it in step, and deletes it with the room', async () => {
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        afterChannelId: PRIMARY,
      });

      const [room] = await secondaries.listByGuild(GUILD);
      const companion = await companions.getBySecondary(room!.channelId);
      expect(companion).toBeDefined();

      // A second member joining the room is added to its chat.
      const bob = member('bob');
      voice.put(room!.channelId, bob);
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: bob,
        afterChannelId: room!.channelId,
      });
      const syncs = actions.actions.filter((a) => a.type === 'companionSync');
      expect(syncs.at(-1)!.memberIds).toContain('bob');

      // Everyone leaves: the room is cleaned up and the chat goes with it.
      voice.drop(room!.channelId, 'alice');
      voice.drop(room!.channelId, 'bob');
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: bob,
        beforeChannelId: room!.channelId,
      });

      expect(await companions.getBySecondary(room!.channelId)).toBeUndefined();
      expect(actions.actions).toContainEqual({
        type: 'companionDelete',
        guildId: GUILD,
        channelId: companion!.channelId,
      });
    });

    it('drops the row when a human deletes the text channel', async () => {
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        afterChannelId: PRIMARY,
      });
      const [room] = await secondaries.listByGuild(GUILD);
      const companion = await companions.getBySecondary(room!.channelId);

      await feature.handleChannelDeleted(GUILD, companion!.channelId);

      expect(await companions.get(companion!.channelId)).toBeUndefined();
      // The room itself is untouched.
      expect(await secondaries.get(room!.channelId)).toBeDefined();
    });
  });

  /**
   * The room control panel, which the create path posts into the room's chat.
   *
   * What is worth pinning here is not the message, which is covered by the
   * builder's own unit tests, but the two wiring facts nothing else can see:
   * WHERE it goes (the room, or its companion text channel when the creator
   * channel has those switched on), and that a failure to post it leaves a
   * perfectly working room behind.
   */
  describe('the room control panel', () => {
    let companions: CompanionChannelRepository;
    let problems: PermissionProblemTracker;
    let sent: { channelId: string }[];
    let edited: { channelId: string; messageId: string; payload: unknown }[];
    let poster: ControlPanelPoster;

    function build(opts: { companionText?: boolean; failSend?: boolean; failEdit?: boolean } = {}) {
      sent = [];
      edited = [];
      problems = new PermissionProblemTracker();
      poster = new ControlPanelPoster({
        send: (channelId) => {
          if (opts.failSend) return Promise.reject(new Error('Missing Permissions'));
          sent.push({ channelId });
          return Promise.resolve(`msg-${sent.length}`);
        },
        edit: (channelId, messageId, payload) => {
          if (opts.failEdit) return Promise.reject(new Error('Unknown Message'));
          edited.push({ channelId, messageId, payload });
          return Promise.resolve();
        },
        guilds,
        secondaries,
        logger: fakeLogger(),
        permissionProblems: problems,
      });
      const companionText = opts.companionText
        ? new CompanionTextService({
            companions,
            secondaries,
            autoChannels,
            guilds,
            actions,
            voice,
            logger: fakeLogger(),
          })
        : undefined;
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        controlPanel: poster,
        permissionProblems: problems,
        ...(companionText ? { companionText } : {}),
      });
    }

    async function makeRoom(): Promise<string> {
      const alice = member('alice');
      voice.put(PRIMARY, alice);
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        afterChannelId: PRIMARY,
      });
      const [room] = await secondaries.listByGuild(GUILD);
      // The recorder notes the move but the fake view does not apply it, and a
      // rerender bails on an empty room before it reaches the panel. Put her
      // where the real move would have.
      voice.drop(PRIMARY, 'alice');
      voice.put(room!.channelId, alice);
      return room!.channelId;
    }

    beforeEach(async () => {
      companions = new CompanionChannelRepository(env.handle.db);
      await env.handle.db.delete(db.schema.companionChannels);
      await autoChannels.upsert(GUILD, PRIMARY, { name: 'Room' });
      // The panel is off for a server that has never configured it, so these
      // switch it on exactly as an admin does with `/controlpanel`.
      await guilds.updateSettings(GUILD, { control_panel: { panel: true } });
    });

    it("posts into the room's own chat and records where it went", async () => {
      build();
      const room = await makeRoom();
      expect(sent).toEqual([{ channelId: room }]);
      const row = await secondaries.get(room);
      expect(row!.state.controlPanelMessageId).toBe('msg-1');
      expect(row!.state.controlPanelChannelId).toBe(room);
    });

    /**
     * The owner's 2026-09-19 override: when a creator channel has companion
     * text channels switched on, the panel goes in the companion instead. Which
     * is also why the create path captures the companion id rather than
     * discarding it.
     */
    it('posts into the companion text channel when the creator channel has one', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: 'Room', textChannel: true });
      build({ companionText: true });
      const room = await makeRoom();
      const companion = await companions.getBySecondary(room);
      expect(companion).toBeDefined();
      expect(sent).toEqual([{ channelId: companion!.channelId }]);
      expect((await secondaries.get(room))!.state.controlPanelChannelId).toBe(companion!.channelId);
    });

    /**
     * The scoped no-deploy lever for companions must not take the panel with
     * it: a guild whose companions are frozen still gets rooms, and those rooms
     * still have a chat to put the buttons in.
     */
    it('falls back to the room when the companion lever is on', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: 'Room', textChannel: true });
      build({ companionText: true });
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        controlPanel: {
          postForRoom: (g, roomId, _p, destination) => {
            sent.push({ channelId: destination });
            void g;
            void roomId;
            return Promise.resolve();
          },
          refreshForRoom: () => Promise.resolve(),
        },
        gate: {
          allowCreate: () => Promise.resolve({ allowed: true, companionTextDisabled: true }),
        },
      });
      const room = await makeRoom();
      expect(sent).toEqual([{ channelId: room }]);
      expect(await companions.getBySecondary(room)).toBeUndefined();
    });

    it('posts nothing when the panel lever is on', async () => {
      build();
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        controlPanel: {
          postForRoom: () => {
            sent.push({ channelId: 'should-not-happen' });
            return Promise.resolve();
          },
          refreshForRoom: () => Promise.resolve(),
        },
        gate: { allowCreate: () => Promise.resolve({ allowed: true, controlPanelDisabled: true }) },
      });
      await makeRoom();
      expect(sent).toEqual([]);
    });

    /**
     * The realistic failure, and the whole reason the post is fail-soft: a
     * created room grants the bot no Send Messages, so any category that denies
     * it produces this on every room.
     */
    it('leaves a working room behind when it cannot post, and tells the admin', async () => {
      build({ failSend: true });
      const room = await makeRoom();
      expect(await secondaries.get(room)).toBeDefined();
      expect(actions.actions.filter((a) => a.type === 'create')).toHaveLength(1);
      expect(actions.actions.some((a) => a.type === 'delete')).toBe(false);
      expect((await secondaries.get(room))!.state.controlPanelMessageId).toBeUndefined();
      // Against the CREATOR channel, so ten rooms do not evict every other
      // incident the guild has.
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: PRIMARY, operation: 'panel' }),
      ]);
    });

    /**
     * The whole point of a panel that follows the room, end to end: lock the
     * room and the button it offers has to change, through the real state
     * write and the real fingerprint in the row.
     */
    it('edits the panel when the room is locked, and not before', async () => {
      build();
      const room = await makeRoom();
      expect(edited).toHaveLength(0);

      await secondaries.updateState(room, {
        ...(await secondaries.get(room))!.state,
        private: true,
      });
      await feature.rerenderSecondary(GUILD, room);

      expect(edited).toHaveLength(1);
      expect(edited[0]!.messageId).toBe('msg-1');
      const rendered = JSON.stringify(edited[0]!.payload);
      expect(rendered).toContain(`avc:panel:unlock:${room}`);
      expect(rendered).not.toContain(`avc:panel:lock:${room}`);
    });

    /**
     * The fingerprint is what lets this hang off every rerender, including the
     * sweeps that walk a whole guild. If it stops short-circuiting, each of
     * those becomes one edit per room.
     */
    it('issues no edit when a rerender would change nothing', async () => {
      build();
      await makeRoom();
      await feature.reconcileGuild(GUILD);
      await feature.reconcileGuild(GUILD);
      expect(edited).toHaveLength(0);
    });

    /**
     * `/restrict`: the panel follows the room owner. The wiring is what these
     * pin: the create-time post and the re-render both read the owner's standing
     * from the voice view and hand it to the poster, which applies the rules.
     */
    describe('and /restrict', () => {
      const DENIED_ROLE = '523456789012345678';
      let posted: { channelId: string; payload: unknown }[];

      // Guild settings outlive a test, and a rule left behind by the last one
      // would hide buttons from this one's first panel.
      beforeEach(async () => {
        await guilds.updateSettings(GUILD, { command_access: {} });
      });

      /** `build()`, with the payloads of what it sends as well as where it sent them. */
      function buildCapturing(): void {
        build();
        posted = [];
        poster = new ControlPanelPoster({
          send: (channelId, payload) => {
            sent.push({ channelId });
            posted.push({ channelId, payload });
            return Promise.resolve(`msg-${sent.length}`);
          },
          edit: (channelId, messageId, payload) => {
            edited.push({ channelId, messageId, payload });
            return Promise.resolve();
          },
          guilds,
          secondaries,
          logger: fakeLogger(),
          permissionProblems: problems,
        });
        feature = new VoiceFeature({
          autoChannels,
          secondaries,
          guilds,
          actions,
          voice,
          selfHosted: true,
          logger: fakeLogger(),
          controlPanel: poster,
          permissionProblems: problems,
        });
      }

      const RULE = { command_access: { rename: { roles: [DENIED_ROLE] } } };
      const has = (payload: unknown, action: string): boolean =>
        JSON.stringify(payload).includes(`avc:panel:${action}:`);

      it("posts a denied owner's panel without the buttons their rules withdraw", async () => {
        buildCapturing();
        await guilds.updateSettings(GUILD, RULE);
        voice.setOwnerAccess('alice', { roleIds: [DENIED_ROLE] });
        await makeRoom();
        expect(has(posted[0]!.payload, 'rename')).toBe(false);
        expect(has(posted[0]!.payload, 'limit')).toBe(true);
      });

      /**
       * On the create path the lookup is an argument to the post, after the room
       * exists and outside any catch. A throw there would reject a create that
       * already succeeded: no result, no log line, no repair, and a failure against
       * the guild's breaker.
       */
      it('still creates the room, with every control, when looking up the owner throws', async () => {
        buildCapturing();
        await guilds.updateSettings(GUILD, RULE);
        voice.ownerAccessOf = () => {
          throw new Error('cache exploded');
        };
        const room = await makeRoom();
        expect((await secondaries.get(room))!.ownerId).toBe('alice');
        expect(posted).toHaveLength(1);
        expect(has(posted[0]!.payload, 'rename')).toBe(true);
        // And the re-render path, which has its own catch, agrees.
        await feature.rerenderSecondary(GUILD, room);
        expect(edited).toHaveLength(0);
      });

      it('leaves the panel alone for an owner nobody can resolve', async () => {
        buildCapturing();
        await guilds.updateSettings(GUILD, RULE);
        await makeRoom();
        expect(has(posted[0]!.payload, 'rename')).toBe(true);
      });

      /** The create-time builder and the re-render must reach the same panel. */
      it('draws the same panel at the post and the next re-render', async () => {
        buildCapturing();
        await guilds.updateSettings(GUILD, RULE);
        voice.setOwnerAccess('alice', { roleIds: [DENIED_ROLE] });
        const room = await makeRoom();
        await feature.rerenderSecondary(GUILD, room);
        expect(edited).toHaveLength(0);
      });

      it('hides a button when a rule is added, and shows it again when the room changes hands', async () => {
        buildCapturing();
        voice.setOwnerAccess('alice', { roleIds: [DENIED_ROLE] });
        const room = await makeRoom();
        expect(has(posted[0]!.payload, 'rename')).toBe(true);

        // An admin runs `/restrict add`, which refreshes every panel.
        await guilds.updateSettings(GUILD, RULE);
        await feature.refreshGuildPanels(GUILD);
        expect(edited).toHaveLength(1);
        expect(has(edited[0]!.payload, 'rename')).toBe(false);

        // Bea is not denied, and takes the room over.
        const bea = member('bea');
        voice.put(room, bea);
        voice.setOwnerAccess('bea', { roleIds: [] });
        await secondaries.setOwnerAndCreator(room, bea.id, bea.displayName);
        await feature.rerenderSecondary(GUILD, room);
        expect(edited).toHaveLength(2);
        expect(has(edited[1]!.payload, 'rename')).toBe(true);
      });

      it('keeps a bare embed when every control the server leaves on is hidden', async () => {
        buildCapturing();
        await guilds.updateSettings(GUILD, {
          control_panel: { panel: true, claim: false, kick: false, info: false },
          command_access: {
            privacy: { roles: [DENIED_ROLE] },
            hide: { roles: [DENIED_ROLE] },
            limit: { roles: [DENIED_ROLE] },
            rename: { roles: [DENIED_ROLE] },
            transfer: { roles: [DENIED_ROLE] },
          },
        });
        voice.setOwnerAccess('alice', { roleIds: [DENIED_ROLE] });
        const room = await makeRoom();
        // Posted, not skipped, and with no buttons.
        expect(posted).toHaveLength(1);
        expect((posted[0]!.payload as { components: unknown[] }).components).toEqual([]);

        // The re-render path: the owner stops being denied, then is denied again.
        voice.setOwnerAccess('alice', { roleIds: [] });
        await feature.rerenderSecondary(GUILD, room);
        expect(has(edited[0]!.payload, 'rename')).toBe(true);
        voice.setOwnerAccess('alice', { roleIds: [DENIED_ROLE] });
        await feature.rerenderSecondary(GUILD, room);
        const last = edited[edited.length - 1]!.payload as {
          content?: string;
          components: unknown[];
        };
        expect(last.components).toEqual([]);
        // Not the line that says the server switched the controls off.
        expect(last.content).toBeUndefined();
      });

      /**
       * The Hide control follows the room like the privacy button does, and its state
       * lives in the access column, which the row schema reads as null both for no
       * record and for one this build cannot read. So the refresh reads it for a locked
       * room, the only kind an unreadable record changes anything for.
       */
      describe('and the hide control', () => {
        const hasAction = (payload: unknown, action: string, room: string): boolean =>
          JSON.stringify(payload).includes(`avc:panel:${action}:${room}`);

        /** What a hide leaves in the row: `private` in state and the flag in the record. */
        const hide = (room: string) =>
          secondaries.transitionAccess(room, {
            statePatch: { private: true },
            access: (stored) => ({ ...(stored ?? {}), hidden: true }),
          });

        /** The lock an older instance leaves behind: `private` and no record at all. */
        const lock = async (room: string) =>
          secondaries.updateState(room, { ...(await secondaries.get(room))!.state, private: true });

        it('offers Hide in the panel a new room is posted with', async () => {
          buildCapturing();
          await makeRoom();
          expect(has(posted[0]!.payload, 'hide')).toBe(true);
          expect(has(posted[0]!.payload, 'unhide')).toBe(false);
        });

        it('offers Unhide with Public once the room is hidden, and Hide with Private before', async () => {
          buildCapturing();
          const room = await makeRoom();
          await feature.rerenderSecondary(GUILD, room);
          expect(edited).toHaveLength(0);

          await hide(room);
          await feature.rerenderSecondary(GUILD, room);

          expect(edited).toHaveLength(1);
          expect(hasAction(edited[0]!.payload, 'unhide', room)).toBe(true);
          expect(hasAction(edited[0]!.payload, 'hide', room)).toBe(false);
          expect(hasAction(edited[0]!.payload, 'unlock', room)).toBe(true);
          expect(hasAction(edited[0]!.payload, 'lock', room)).toBe(false);
        });

        /**
         * A stale whole-state write can drop `private` from a hidden room. The record
         * still says hidden, so the panel must still show Unhide and Public, never Private.
         */
        it('still draws a hidden room as hidden and locked when a stale write dropped private', async () => {
          buildCapturing();
          const room = await makeRoom();
          await hide(room);
          const { private: _gone, ...rest } = (await secondaries.get(room))!.state;
          await secondaries.updateState(room, rest);

          await feature.rerenderSecondary(GUILD, room);

          expect(hasAction(edited[0]!.payload, 'unhide', room)).toBe(true);
          expect(hasAction(edited[0]!.payload, 'unlock', room)).toBe(true);
          expect(hasAction(edited[0]!.payload, 'lock', room)).toBe(false);
        });

        /**
         * A record this build cannot read may be a hidden room's: the control is left off,
         * rather than offering a Hide that would be refused or an Unhide that is a guess.
         */
        it('offers neither Hide nor Unhide when the record cannot be read, and keeps Public', async () => {
          buildCapturing();
          const room = await makeRoom();
          await lock(room);
          await env.handle.pool.query(
            'UPDATE secondary_channels SET access = $1::jsonb WHERE channel_id = $2',
            [JSON.stringify({ hidden: 'yes' }), room],
          );

          await feature.rerenderSecondary(GUILD, room);

          expect(edited).toHaveLength(1);
          expect(hasAction(edited[0]!.payload, 'hide', room)).toBe(false);
          expect(hasAction(edited[0]!.payload, 'unhide', room)).toBe(false);
          expect(hasAction(edited[0]!.payload, 'unlock', room)).toBe(true);
        });

        it('offers Hide on a locked room with no record, which an older instance leaves behind', async () => {
          buildCapturing();
          const room = await makeRoom();
          await lock(room);

          await feature.rerenderSecondary(GUILD, room);

          expect(hasAction(edited[0]!.payload, 'hide', room)).toBe(true);
          expect(hasAction(edited[0]!.payload, 'unlock', room)).toBe(true);
        });

        /**
         * Per-read DB pricing: the refresh runs for every room on every sweep, so the
         * extra read happens only where it can change the answer.
         */
        it('reads the access record only for a locked room that has none, never for a public one', async () => {
          buildCapturing();
          const room = await makeRoom();
          const read = vi.spyOn(secondaries, 'readAccess');

          await feature.rerenderSecondary(GUILD, room);
          expect(read).not.toHaveBeenCalled();

          await lock(room);
          await feature.rerenderSecondary(GUILD, room);
          expect(read).toHaveBeenCalledTimes(1);

          read.mockClear();
          await hide(room);
          await feature.rerenderSecondary(GUILD, room);
          // The row carries a record, which is readable by being there.
          expect(read).not.toHaveBeenCalled();
          read.mockRestore();
        });

        it('skips the refresh and tries again when that read fails, rather than draw a guess', async () => {
          buildCapturing();
          const room = await makeRoom();
          await lock(room);
          const read = vi
            .spyOn(secondaries, 'readAccess')
            .mockRejectedValueOnce(new Error('db down'));

          await feature.rerenderSecondary(GUILD, room);
          expect(edited).toHaveLength(0);

          await feature.rerenderSecondary(GUILD, room);
          expect(edited).toHaveLength(1);
          read.mockRestore();
        });

        it('withdraws Hide from a denied owner and keeps Unhide for the same owner once hidden', async () => {
          buildCapturing();
          await guilds.updateSettings(GUILD, {
            command_access: { hide: { roles: [DENIED_ROLE] } },
          });
          voice.setOwnerAccess('alice', { roleIds: [DENIED_ROLE] });
          const room = await makeRoom();
          expect(has(posted[0]!.payload, 'hide')).toBe(false);

          await hide(room);
          await feature.rerenderSecondary(GUILD, room);

          expect(hasAction(edited[0]!.payload, 'unhide', room)).toBe(true);
        });
      });
    });

    it('edits every open room when a button is switched off server-wide', async () => {
      build();
      const room = await makeRoom();
      await guilds.updateSettings(GUILD, { control_panel: { panel: true, kick: false } });

      const summary = await feature.refreshGuildPanels(GUILD);

      expect(summary.considered).toBe(1);
      expect(edited).toHaveLength(1);
      expect(JSON.stringify(edited[0]!.payload)).not.toContain(`avc:panel:kick:${room}`);
    });

    /**
     * The panel write is a jsonb MERGE and the rerender's own state write is a
     * REPLACE of the snapshot read at the top of it, so refreshing before that
     * write reverted the fingerprint: the next render saw a mismatch and issued
     * a second, byte-identical edit, for ever. This is that, through the real
     * row: a change that moves the owner moves the rendered NAME too, so both
     * writes happen in one pass.
     */
    it('does not revert the fingerprint when the name changes in the same pass', async () => {
      build();
      await autoChannels.upsert(GUILD, PRIMARY, { name: '@@owner@@' });
      const room = await makeRoom();
      expect(edited).toHaveLength(0);

      // Bea takes over: the panel description AND the rendered name both move.
      const bea = member('bea');
      voice.put(room, bea);
      await secondaries.setOwnerAndCreator(room, bea.id, bea.displayName);
      await feature.rerenderSecondary(GUILD, room);
      expect(edited).toHaveLength(1);

      // Nothing has moved since, so no further edit may be issued.
      await feature.rerenderSecondary(GUILD, room);
      await feature.rerenderSecondary(GUILD, room);
      expect(edited).toHaveLength(1);
    });

    /**
     * Same ordering, the other direction: a cleared binding must not be
     * resurrected by the state write that follows it.
     */
    it('does not resurrect a panel it just forgot when the name changes too', async () => {
      build({ failEdit: true });
      await autoChannels.upsert(GUILD, PRIMARY, { name: '@@owner@@' });
      const room = await makeRoom();

      const bea = member('bea');
      voice.put(room, bea);
      await secondaries.setOwnerAndCreator(room, bea.id, bea.displayName);
      await feature.rerenderSecondary(GUILD, room);

      const row = await secondaries.get(room);
      expect(row!.state.controlPanelMessageId).toBeUndefined();
      expect(row!.state.controlPanelHash).toBeUndefined();
    });

    /**
     * The lever stops EDITS as well as posts, so it can shed the load its name
     * implies, and that is only safe because it self-heals: the fingerprint
     * still holds what was last drawn, so lifting it catches the panel up.
     */
    it('freezes re-rendering while the lever is on, and catches up when it is lifted', async () => {
      let disabled = false;
      build();
      feature = new VoiceFeature({
        autoChannels,
        secondaries,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        controlPanel: poster,
        permissionProblems: problems,
        gate: {
          allowCreate: () => Promise.resolve({ allowed: true }),
          controlPanelDisabled: () => Promise.resolve(disabled),
        },
      });
      const room = await makeRoom();
      expect(sent).toHaveLength(1);

      disabled = true;
      await secondaries.updateState(room, {
        ...(await secondaries.get(room))!.state,
        private: true,
      });
      await feature.rerenderSecondary(GUILD, room);
      expect(edited).toHaveLength(0);

      disabled = false;
      await feature.rerenderSecondary(GUILD, room);
      expect(edited).toHaveLength(1);
      expect(JSON.stringify(edited[0]!.payload)).toContain(`avc:panel:unlock:${room}`);
    });

    /**
     * Almost always a message somebody deleted. Retrying it on every rerender
     * for the life of the room would be a request per render forever.
     */
    it('forgets a panel it cannot edit, and stops trying', async () => {
      build({ failEdit: true });
      const room = await makeRoom();
      await secondaries.updateState(room, {
        ...(await secondaries.get(room))!.state,
        private: true,
      });

      await feature.rerenderSecondary(GUILD, room);

      const row = await secondaries.get(room);
      expect(row!.state.controlPanelMessageId).toBeUndefined();
      expect(row!.state.controlPanelChannelId).toBeUndefined();
      expect(row!.state.controlPanelHash).toBeUndefined();
      // Nothing is reported: the post proved the permissions were fine.
      expect(problems.recent(GUILD)).toEqual([]);
    });

    /**
     * The replay guard, against a real row rather than a fake repository:
     * what stops a redelivered voice event or a caught-up reconcile giving
     * one room two panels is the stored message id, so the guard has to read
     * what the first post actually wrote.
     */
    it('posts once per room, however many times the path runs', async () => {
      build();
      const room = await makeRoom();
      expect(sent).toHaveLength(1);
      await poster.postForRoom(GUILD, room, PRIMARY, room);
      await poster.postForRoom(GUILD, room, PRIMARY, room);
      expect(sent).toHaveLength(1);
      expect((await secondaries.get(room))!.state.controlPanelMessageId).toBe('msg-1');
    });
  });
});
