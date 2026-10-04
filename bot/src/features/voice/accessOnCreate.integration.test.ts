import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  MemberAccessListRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  BOT_ACCESS,
  CONNECT,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  type ResolvedOverwrite,
} from './accessPlan.js';
import { RecordingVoiceActions } from './actions.js';
import { readCommandAccess } from './commandAccess.js';
import { VoiceFeature, type CreationGate, type VoiceFeatureDeps } from './handler.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { PrivacyService } from './privacy.js';
import type { VoiceMember } from './types.js';
import { FakeVoiceView, fakeMember } from './voiceTestUtils.js';

const GUILD = 'guild-create-lists';
const PRIMARY = 'primary-1';
const BOT = 'bot-1';
/** Snowflakes, because a `/restrict` rule only stores ids that look like one. */
const ALICE = '111111111111111111';
const BOB = '333333333333333333';
const MALLORY = '222222222222222222';
const ROLE = '444444444444444444';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;

const bits = (o: ResolvedOverwrite | undefined) =>
  o ? { allow: o.allow, deny: o.deny } : undefined;

/** A creator as the gateway snapshots them: with the roles they hold. */
const creator = (id: string, over: Partial<VoiceMember> = {}): VoiceMember => ({
  ...fakeMember(id),
  roleIds: [GUILD],
  canManage: false,
  ...over,
});

/**
 * A saved list reaching a room as it is made, end to end: a member joins a creator channel,
 * the room is made and the member moved into it, and what the creator saved is applied.
 * Real repositories and the real privacy service, over the recording Discord seam.
 */
describe('saved lists on a room as it is made (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let joinChannels: JoinChannelRepository;
  let lists: MemberAccessListRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let problems: PermissionProblemTracker;
  let serverLogs: string[];
  let privacy: PrivacyService;
  let leverOn: boolean;
  /** The gate a feature is built with: absent by default, as it is for a self-host. */
  let gate: CreationGate | undefined;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
    joinChannels = new JoinChannelRepository(env.handle.db);
    lists = new MemberAccessListRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.memberAccessLists);
    await env.handle.db.delete(db.schema.autoChannels);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    problems = new PermissionProblemTracker();
    serverLogs = [];
    leverOn = false;
    gate = undefined;
    privacy = buildPrivacy();
    await guilds.ensure(GUILD);
    await guilds.updateSettings(GUILD, { command_access: {} });
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- helpers ----------------------------------------------------------------------

  const buildPrivacy = (): PrivacyService =>
    new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => BOT,
      memberAccessLists: lists,
      permissionProblems: problems,
      serverLog: (_guildId, _level, message) => serverLogs.push(message),
      roomAccessDisabled: () => Promise.resolve(leverOn),
      commandAccess: async (guildId) =>
        readCommandAccess((await guilds.ensure(guildId)).settings, guildId),
    });

  /** A feature wired as `index.ts` wires it, with the pieces a test changes. */
  const buildFeature = (over: Partial<VoiceFeatureDeps> = {}, hook = true): VoiceFeature =>
    new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
      ...(gate ? { gate } : {}),
      makePrivateOnCreate: (g, c, ownerId, ownerName) =>
        privacy.makePrivateForCreation(g, c, ownerId, ownerName),
      ...(hook
        ? {
            applyAccessLists: (g, c, who) => privacy.applyAccessLists(g, c, { creator: who }),
            readSavedLists: (g, owner) => privacy.readSavedLists(g, owner),
          }
        : {}),
      roomAccess: privacy,
      ...over,
    });

  /** A member joins the creator channel, and the event is handled. */
  const join = async (feature: VoiceFeature, member: VoiceMember = creator(ALICE)) => {
    voice.put(PRIMARY, member);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member,
      afterChannelId: PRIMARY,
    });
    const room = actions.ofType('create').at(-1)?.channelId;
    // The move the recorder only records: the member is in the room now, not the creator channel.
    if (room) {
      voice.drop(PRIMARY, member.id);
      voice.put(room, member);
    }
    return room;
  };

  const held = (channel: string, id: string, type = OVERWRITE_MEMBER) =>
    actions.overwritesOf(channel).find((o) => o.id === id && o.type === type);
  const everyone = (channel: string) => held(channel, GUILD, OVERWRITE_ROLE);
  const access = (channel: string) => secondaries.getAccess(channel);
  const restrict = (rule: { users?: string[]; roles?: string[] }) =>
    guilds.updateSettings(GUILD, {
      command_access: { access: { deny: { users: rule.users ?? [], roles: rule.roles ?? [] } } },
    });

  // -- the block that reaches a public room --------------------------------------------

  describe('a saved block', () => {
    it('reaches a PUBLIC room created after it was saved, and the owner was moved in first', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
      expect(bits(held(room!, BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      // The room itself is open to everybody else, and recorded as nothing but its blocks.
      expect(everyone(room!)).toBeUndefined();
      expect((await secondaries.get(room!))?.state.private).toBeUndefined();
      expect(await access(room!)).toMatchObject({ creatorId: ALICE, blocked: [MALLORY] });
      // After the move and never before it.
      const order = actions.actions.map((a) => a.type);
      expect(order.indexOf('move')).toBeGreaterThan(-1);
      expect(order.indexOf('move')).toBeLessThan(order.indexOf('overwrites'));
      expect(actions.ofType('move')[0]).toMatchObject({ memberId: ALICE, channelId: room });
    });

    it('is the creator’s own, so another member’s room is not touched by it', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');

      const room = await join(buildFeature(), creator(BOB));

      expect(held(room!, MALLORY)).toBeUndefined();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('never blocks the creator, whoever the list names', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
      // The command refuses it; a row put in by hand must still not lock a creator out.
      await env.handle.pool.query(
        "INSERT INTO member_access_lists (guild_id, owner_id, member_id, kind) VALUES ($1, $2, $2, 'blocked')",
        [GUILD, ALICE],
      );

      const room = await join(buildFeature());

      expect(held(room!, ALICE)?.deny ?? 0n).toBe(0n);
      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    /**
     * A block on somebody who has left is the commonest block there is. The first room finds
     * out (a lookup on the path before the panel is posted), and every room after it, by the
     * same creator, must not ask Discord again for the hour the answer is believed.
     */
    it('is looked for once when the member has left the server, and the creator’s next room does not ask again', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
      actions.unknownMemberIds.add(MALLORY);
      const feature = buildFeature();

      const first = await join(feature);
      const second = await join(feature);

      const writes = actions.ofType('overwrites');
      expect(writes.find((a) => a.channelId === first)?.droppedMemberIds).toEqual([MALLORY]);
      expect(writes.find((a) => a.channelId === second)?.droppedMemberIds).toEqual([]);
      for (const room of [first!, second!]) {
        expect(held(room, MALLORY)).toBeUndefined();
        expect(bits(held(room, BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
        expect((await access(room))?.blocked).toBeUndefined();
      }
    });

    it('reaches a room the catch-up pass makes for a member who was waiting in the creator channel', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
      voice.put(PRIMARY, creator(ALICE));

      const drift = await buildFeature().reconcileGuild(GUILD);

      expect(drift.created).toHaveLength(1);
      const room = drift.created[0]!.secondaryId!;
      expect(bits(held(room, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });
  });

  // -- trusted entries --------------------------------------------------------------------

  describe('a saved trusted entry', () => {
    it('grants nothing in a public room, which has nobody to be let in past', async () => {
      await lists.add(GUILD, ALICE, BOB, 'trusted');

      const room = await join(buildFeature());

      expect(held(room!, BOB)).toBeUndefined();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('lets them into a room that starts locked, in the one write that locks it', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, {
        name: '## [@@game_name@@]',
        defaultPrivate: true,
      });
      await lists.add(GUILD, ALICE, BOB, 'trusted');
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');

      const room = await join(buildFeature());

      expect(bits(held(room!, BOB))).toEqual({ allow: C, deny: 0n });
      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
      expect(bits(everyone(room!))).toEqual({ allow: 0n, deny: C });
      // The lock was the one write to the room; applying the lists after it found nothing
      // left to do. (The other is the Join channel's, which denies the block there.)
      expect(actions.ofType('overwrites').filter((a) => a.channelId === room)).toHaveLength(1);
    });
  });

  // -- what it costs ----------------------------------------------------------------------

  describe('a creator with nothing saved', () => {
    /**
     * The read is started beside the Discord create, so it does not stand between the owner and
     * the companion channel and the panel, which every room made in every server pays for.
     */
    it('is read while the room is being made, and not after the move', async () => {
      const order: string[] = [];
      const get = vi.spyOn(lists, 'get').mockImplementation(async (...args) => {
        order.push('read');
        return MemberAccessListRepository.prototype.get.apply(lists, args);
      });
      const create = actions.createVoiceChannel.bind(actions);
      actions.createVoiceChannel = (input) => {
        order.push('create');
        return create(input);
      };
      const move = actions.moveMember.bind(actions);
      actions.moveMember = (...args) => {
        order.push('move');
        return move(...args);
      };

      await join(buildFeature());

      expect(get).toHaveBeenCalledTimes(1);
      expect(order.indexOf('read')).toBeLessThan(order.indexOf('create'));
      expect(order.indexOf('read')).toBeLessThan(order.indexOf('move'));
    });

    it('is not read at all while room_access.disabled is on', async () => {
      gate = {
        allowCreate: () => Promise.resolve({ allowed: true }),
        roomAccessDisabled: () => Promise.resolve(true),
      };
      const get = vi.spyOn(lists, 'get');

      await join(buildFeature());

      expect(get).not.toHaveBeenCalled();
    });

    it('is left to the service when the early read fails, and the room is made all the same', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
      vi.spyOn(privacy, 'readSavedLists').mockRejectedValue(new Error('the database blinked'));
      const get = vi.spyOn(lists, 'get');

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(get).toHaveBeenCalledTimes(1); // the service's own read, which found the block
      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    it('costs one indexed read and no call to Discord about access', async () => {
      const read = vi.spyOn(actions, 'readOverwrites');
      const readAccess = vi.spyOn(secondaries, 'readAccess');
      const get = vi.spyOn(lists, 'get');

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(get).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(readAccess).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('does the same for a creator who only trusts people', async () => {
      await lists.add(GUILD, ALICE, BOB, 'trusted');
      const read = vi.spyOn(actions, 'readOverwrites');

      await join(buildFeature());

      expect(read).not.toHaveBeenCalled();
    });

    it('is not asked at all when the feature has no hook wired', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
      const get = vi.spyOn(lists, 'get');

      const room = await join(buildFeature({}, false));

      expect(room).toBeDefined();
      expect(get).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
    });
  });

  // -- a creator who is denied saved lists --------------------------------------------------

  describe('a creator denied Saved lists', () => {
    beforeEach(async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
    });

    it('has a block that applies to nothing, and the hook is not even asked', async () => {
      await restrict({ users: [ALICE] });
      const apply = vi.spyOn(privacy, 'applyAccessLists');

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(apply).not.toHaveBeenCalled();
      expect(held(room!, MALLORY)).toBeUndefined();
    });

    it('is inert by role, from the roles the snapshot carries', async () => {
      await restrict({ roles: [ROLE] });

      const room = await join(buildFeature(), creator(ALICE, { roleIds: [GUILD, ROLE] }));

      expect(held(room!, MALLORY)).toBeUndefined();
    });

    it('is not inert for a creator who can manage channels, however the rule names them', async () => {
      await restrict({ users: [ALICE] });

      const room = await join(buildFeature(), creator(ALICE, { canManage: true }));

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    /** The snapshot is the member as they are NOW, and a cache that has not caught up is not. */
    it('trusts the member’s own snapshot over a cache that disagrees', async () => {
      await restrict({ users: [ALICE] });
      voice.setOwnerAccess(ALICE, { roleIds: [], canManage: false });

      const room = await join(buildFeature(), creator(ALICE, { canManage: true }));

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    it('is not inert for somebody the rule does not name', async () => {
      await restrict({ users: [BOB], roles: [ROLE] });

      const room = await join(buildFeature());

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    /** What the snapshot cannot say, the block's own protection decides: it applies. */
    it('fails open when who they are cannot be resolved', async () => {
      await restrict({ roles: [ROLE] });
      // A snapshot with no roles at all, and a cache that has not got them either.
      const room = await join(buildFeature(), { ...fakeMember(ALICE) });

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    it('asks the cache when the snapshot has no roles, and then it is inert', async () => {
      await restrict({ roles: [ROLE] });
      voice.setOwnerAccess(ALICE, { roleIds: [ROLE] });

      const room = await join(buildFeature(), { ...fakeMember(ALICE) });

      expect(held(room!, MALLORY)).toBeUndefined();
    });

    it('applies again when the rule goes, to the next room', async () => {
      await restrict({ users: [ALICE] });
      const feature = buildFeature();
      const first = await join(feature);
      expect(held(first!, MALLORY)).toBeUndefined();

      await guilds.updateSettings(GUILD, { command_access: {} });
      const second = await join(feature);

      expect(bits(held(second!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    it('is withdrawn with command_access.disabled: the rule is not read, so the block applies', async () => {
      await restrict({ users: [ALICE] });
      gate = {
        allowCreate: () => Promise.resolve({ allowed: true }),
        commandAccessDisabled: () => Promise.resolve(true),
      };
      // The service reads the rules the way index.ts does, lever included.
      privacy = new PrivacyService({
        secondaries,
        joinChannels,
        actions,
        voice,
        logger: fakeLogger(),
        botUserId: () => BOT,
        memberAccessLists: lists,
        commandAccess: async (guildId) =>
          (await gate?.commandAccessDisabled?.())
            ? {}
            : readCommandAccess((await guilds.ensure(guildId)).settings, guildId),
      });

      const room = await join(buildFeature());

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });
  });

  // -- a failure never fails the room --------------------------------------------------------

  describe('when the lists cannot be applied', () => {
    beforeEach(async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
    });

    it('still makes the room and moves the owner in, and records an access problem for a permission error', async () => {
      actions.failOverwrites = true; // Missing Permissions on the write

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(await secondaries.get(room!)).toMatchObject({ ownerId: ALICE });
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: ALICE, channelId: room }),
      );
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: room, operation: 'access' }),
      ]);
      expect(serverLogs).toHaveLength(1);
    });

    it('records nothing for an error that is not a permission one, and still makes the room', async () => {
      vi.spyOn(actions, 'readOverwrites').mockRejectedValue(new Error('socket hang up'));

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('never lets a hook that throws fail the room or the create', async () => {
      const feature = buildFeature({
        applyAccessLists: () => Promise.reject(new Error('boom')),
      });

      const room = await join(feature);

      expect(room).toBeDefined();
      expect(await secondaries.get(room!)).toBeDefined();
      expect(actions.ofType('delete')).toEqual([]);
    });

    it('is applied by the sweep a few minutes later, which is what makes a failure here cheap', async () => {
      actions.failOverwrites = true;
      const feature = buildFeature();
      const room = await join(feature);
      expect(held(room!, MALLORY)).toBeUndefined();

      actions.failOverwrites = false;
      await feature.reconcileGuild(GUILD);

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });
  });

  // -- the lever ------------------------------------------------------------------------------

  describe('room_access.disabled', () => {
    beforeEach(async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
    });

    it('skips the hook when the gate says so, before the service is asked', async () => {
      gate = {
        allowCreate: () => Promise.resolve({ allowed: true }),
        roomAccessDisabled: () => Promise.resolve(true),
      };
      const apply = vi.spyOn(privacy, 'applyAccessLists');

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(apply).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('is skipped by the service too, which reads the same cached snapshot', async () => {
      leverOn = true;

      const room = await join(buildFeature());

      expect(room).toBeDefined();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('fails open when the gate cannot answer', async () => {
      gate = {
        allowCreate: () => Promise.resolve({ allowed: true }),
        roomAccessDisabled: () => Promise.reject(new Error('flags down')),
      };

      const room = await join(buildFeature());

      expect(bits(held(room!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });

    it('applies once the lever is lifted', async () => {
      leverOn = true;
      const feature = buildFeature();
      const first = await join(feature);
      expect(held(first!, MALLORY)).toBeUndefined();

      leverOn = false;
      const second = await join(feature);

      expect(bits(held(second!, MALLORY))).toEqual({ allow: 0n, deny: VC });
    });
  });

  // -- a replay -------------------------------------------------------------------------------

  describe('a replay', () => {
    it('writes nothing: the hook, the sweep and a second hook each find the room as they would leave it', async () => {
      await lists.add(GUILD, ALICE, MALLORY, 'blocked');
      const feature = buildFeature();
      const room = await join(feature);
      const writes = actions.ofType('overwrites').length;
      const stored = await access(room!);

      const again = await privacy.applyAccessLists(GUILD, room!, {
        creator: { id: ALICE, standing: undefined },
      });
      await feature.reconcileGuild(GUILD);

      expect(again.status).toBe('unchanged');
      expect(actions.ofType('overwrites')).toHaveLength(writes);
      expect(await access(room!)).toEqual(stored);
    });
  });
});
