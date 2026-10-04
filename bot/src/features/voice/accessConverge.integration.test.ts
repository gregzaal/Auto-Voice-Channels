import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  MemberAccessListRepository,
  SecondaryChannelRepository,
  db,
  type Logger,
} from '@avc/core';
import { DiscordAPIError } from 'discord.js';
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
import type { CommandAccess } from './commandAccess.js';
import { ChannelObfuscatedError } from './discordAdapter.js';
import { VoiceFeature } from './handler.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { PrivacyService } from './privacy.js';
import { admitNotInServer } from './roomAccessCopy.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-converge-test';
const PRIMARY = 'primary-1';
const BOT = 'bot-1';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;

const ow = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_MEMBER,
  allow,
  deny,
});
const roleOw = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_ROLE,
  allow,
  deny,
});

/** What an overwrite holds, spelled so a failing assertion reads as bits. */
const bits = (o: ResolvedOverwrite | undefined) =>
  o ? { allow: o.allow, deny: o.deny } : undefined;

const apiError = (code: number, status = 403) =>
  new DiscordAPIError(
    { code, message: `code ${code}` } as never,
    code,
    status,
    'GET',
    'https://discord.test',
    {} as never,
  );

/**
 * The sweep's pass over saved lists and hidden rooms, driven the way production drives it:
 * through `VoiceFeature.reconcileGuild`, over real repositories, with the Discord side a
 * recorder whose overwrites a test seeds to stage drift. Rooms are set up through the
 * privacy service where a real transition would have, so the records are the ones the
 * product writes.
 */
describe('the sweep keeps saved lists and hidden rooms in line (integration)', () => {
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
  /** The privacy service's logger, which a test spies on for what an operator is told. */
  let logger: Logger;
  let privacy: PrivacyService;
  let feature: VoiceFeature;
  /** The moderator role setting, which a test changes like an admin would. */
  let moderatorRole: string | null;
  let leverOn: boolean;
  let rules: CommandAccess;

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
    moderatorRole = null;
    leverOn = false;
    rules = {};
    logger = fakeLogger();
    privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger,
      botUserId: () => BOT,
      memberAccessLists: lists,
      moderatorRoleId: () => Promise.resolve(moderatorRole),
      permissionProblems: problems,
      serverLog: (_guildId, _level, message) => serverLogs.push(message),
      roomAccessDisabled: () => Promise.resolve(leverOn),
      commandAccess: () => Promise.resolve(rules),
    });
    feature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      roomAccess: privacy,
      permissionProblems: problems,
    });
    await guilds.ensure(GUILD);
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -- helpers ----------------------------------------------------------------------

  /** A live room: its row, its channel in the voice view and its owner sitting in it. */
  const room = async (id: string, owner = 'alice', creator = owner) => {
    await secondaries.create({
      channelId: id,
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: owner,
      originalCreator: creator,
      state: { name: '#1 []', index: 0, roster: [owner] },
    });
    voice.put(id, member(owner));
  };

  const sweep = (opts: { dryRun?: boolean } = {}) => feature.reconcileGuild(GUILD, opts);
  /** The pass alone, without the sweep's other passes, which read rooms of their own. */
  const pass = async () => privacy.convergeGuild(GUILD, await secondaries.listByGuild(GUILD));
  const held = (channel: string, id: string, type = OVERWRITE_MEMBER) =>
    actions.overwritesOf(channel).find((o) => o.id === id && o.type === type);
  const everyone = (channel: string) => held(channel, GUILD, OVERWRITE_ROLE);
  const access = (channel: string) => secondaries.getAccess(channel);
  const row = async (channel: string) => (await secondaries.get(channel))!;
  const liveJoins = () => {
    const deleted = new Set(actions.ofType('delete').map((a) => a.channelId));
    return actions.ofType('joinChannel').filter((a) => !deleted.has(a.channelId));
  };
  const stageAccess = (channel: string, blob: unknown) =>
    env.handle.pool.query(
      'UPDATE secondary_channels SET access = $1::jsonb WHERE channel_id = $2',
      [JSON.stringify(blob), channel],
    );
  /** Everything a repeat of the sweep must leave exactly as it found it. */
  const snapshot = async (channel: string) => ({
    overwrites: actions.overwritesOf(channel),
    writes: actions.ofType('overwrites').length,
    access: await access(channel),
    state: (await row(channel)).state.private,
    joins: liveJoins().length,
    deletes: actions.ofType('delete').length,
    moves: actions.ofType('move').length,
  });

  // -- what it costs --------------------------------------------------------------

  describe('a guild with nothing to converge', () => {
    it('costs one query and no call to Discord', async () => {
      await room('r1');
      await room('r2', 'bob');
      const read = vi.spyOn(actions, 'readOverwrites');
      const readAccess = vi.spyOn(secondaries, 'readAccess');
      const byGuild = vi.spyOn(lists, 'listByGuild');
      const joins = vi.spyOn(joinChannels, 'listBySecondaries');

      await sweep();

      expect(byGuild).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(readAccess).not.toHaveBeenCalled();
      expect(joins).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('does nothing for a creator whose saved entries cannot matter to the room they made', async () => {
      // Trusted entries mean nothing in a room that is open to everyone.
      await room('r1');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      const read = vi.spyOn(actions, 'readOverwrites');

      await sweep();

      expect(read).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
      expect(await access('r1')).toBeNull();
    });

    it('leaves a room an older build locked alone, and makes no Join channel for it', async () => {
      // Private in state, no record, no saved list: not a room this pass has any claim on.
      await room('old');
      await secondaries.updateState('old', { ...(await row('old')).state, private: true });
      const read = vi.spyOn(actions, 'readOverwrites');

      await sweep();

      expect(read).not.toHaveBeenCalled();
      expect(actions.ofType('joinChannel')).toEqual([]);
      expect(actions.ofType('overwrites')).toEqual([]);
    });
  });

  // -- what a room that holds what it should costs ----------------------------------

  describe('a room that already holds what it should', () => {
    /**
     * Every locked or hidden room a build with this feature makes records a baseline, so
     * it is in the pass for as long as it lives. What keeps that from being a request to
     * Discord and two reads of the database per room every five minutes is that it is
     * planned from the row the sweep listed and the channel cache.
     */
    it('costs a locked or hidden room with nothing saved no request to Discord and no read of the database', async () => {
      moderatorRole = 'mods';
      await room('r1');
      await room('r2', 'bob');
      await room('r3', 'carol');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      await privacy.makePrivate(GUILD, 'r2', 'bob');
      await privacy.hide(GUILD, 'r3', 'carol');
      await lists.add(GUILD, 'dave', 'mallory', 'blocked'); // somebody with no room
      const rooms = await secondaries.listByGuild(GUILD);
      const read = vi.spyOn(actions, 'readOverwrites');
      const write = vi.spyOn(actions, 'applyOverwrites');
      const getRow = vi.spyOn(secondaries, 'get');
      const readAccess = vi.spyOn(secondaries, 'readAccess');
      const transition = vi.spyOn(secondaries, 'transitionAccess');
      const mutate = vi.spyOn(secondaries, 'mutateAccess');
      const perOwner = vi.spyOn(lists, 'get');
      const byGuild = vi.spyOn(lists, 'listByGuild');
      const joins = vi.spyOn(joinChannels, 'listBySecondaries');

      const result = await privacy.convergeGuild(GUILD, rooms);

      expect(result).toMatchObject({ considered: 3, repaired: 0, completed: 0, failed: 0 });
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(getRow).not.toHaveBeenCalled();
      expect(readAccess).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(mutate).not.toHaveBeenCalled();
      expect(perOwner).not.toHaveBeenCalled();
      // One query for the lists, of the owners who have a room and nobody else, and one for
      // the Join channels of the rooms that are not open.
      expect(byGuild).toHaveBeenCalledTimes(1);
      const asked = byGuild.mock.calls[0]![1]!;
      expect([...asked].sort()).toEqual(['alice', 'bob', 'carol']);
      expect(joins).toHaveBeenCalledTimes(1);
    });

    it('reads the lists once for the guild and never one owner at a time, for the rooms it does act on', async () => {
      await room('r1');
      await room('r2', 'bob');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'mallory', 'blocked');
      const perOwner = vi.spyOn(lists, 'get');
      const byGuild = vi.spyOn(lists, 'listByGuild');
      const getRow = vi.spyOn(secondaries, 'get');

      const result = await pass();

      expect(result).toMatchObject({ considered: 2, repaired: 2 });
      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(byGuild).toHaveBeenCalledTimes(1);
      expect(perOwner).not.toHaveBeenCalled();
      // The row each room was listed with is what it is planned from.
      expect(getRow).not.toHaveBeenCalled();
    });

    it('is read fresh, and written, only when the cache shows it differing, and then costs nothing again', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      // Somebody removed the owner's overwrite by hand.
      actions.seedOverwrites(
        'r1',
        actions.overwritesOf('r1').filter((o) => o.id !== 'alice'),
      );
      const read = vi.spyOn(actions, 'readOverwrites');

      const first = await pass();
      expect(first.repaired).toBe(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(bits(held('r1', 'alice'))).toEqual({ allow: C, deny: 0n });

      read.mockClear();
      const second = await pass();
      expect(second.repaired).toBe(0);
      expect(read).not.toHaveBeenCalled();
    });

    it('is never written from the cache: a stale cache costs one fresh read, and no write when the room is fine', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      expect(held('r1', 'carol')).toBeDefined();
      // The cache lags: it has not seen carol's overwrite, which Discord already holds.
      const real = actions.cachedOverwrites.bind(actions);
      vi.spyOn(actions, 'cachedOverwrites').mockImplementation((guildId, id) =>
        real(guildId, id)?.filter((o) => o.id !== 'carol'),
      );
      const read = vi.spyOn(actions, 'readOverwrites');
      const write = vi.spyOn(actions, 'applyOverwrites');

      const result = await pass();

      expect(read).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(result.repaired).toBe(0);
    });

    it('is read fresh when the cache cannot say, which is what a channel the bot cannot see looks like', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      vi.spyOn(actions, 'cachedOverwrites').mockReturnValue(undefined);
      const read = vi.spyOn(actions, 'readOverwrites');

      const result = await pass();

      expect(read).toHaveBeenCalledTimes(1);
      expect(result.repaired).toBe(0);
    });
  });

  // -- saved lists ----------------------------------------------------------------

  describe('saved lists', () => {
    it('applies a saved block to a public room that was made before it was saved, and asks the member to leave', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      voice.put('r1', member('mallory'));

      await sweep();

      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(bits(held('r1', BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      // A block never touches `@everyone`: the room stays open to everybody else.
      expect(everyone('r1')).toBeUndefined();
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'mallory', channelId: null, onlyFrom: 'r1' }),
      );
      expect(await access('r1')).toMatchObject({ creatorId: 'alice', blocked: ['mallory'] });
      expect((await row('r1')).state.private).toBeUndefined();
    });

    it('adds a trusted entry that is missing from a locked room, and only adds', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      expect((await privacy.makePrivate(GUILD, 'r1', 'alice')).ok).toBe(true);
      // Somebody edited the room by hand and carol's overwrite went with it.
      actions.seedOverwrites(
        'r1',
        actions.overwritesOf('r1').filter((o) => o.id !== 'carol'),
      );

      await sweep();

      expect(bits(held('r1', 'carol'))).toEqual({ allow: C, deny: 0n });
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
    });

    it('lets a trusted entry into a room an older build locked, and keeps the Join channel it has', async () => {
      await room('old');
      actions.seedOverwrites('old', [ow(BOT, BOT_ACCESS), ow('alice', C), roleOw(GUILD, 0n, C)]);
      await secondaries.updateState('old', { ...(await row('old')).state, private: true });
      await joinChannels.create({
        channelId: 'old-join',
        guildId: GUILD,
        secondaryChannelId: 'old',
        creatorId: 'alice',
      });
      await lists.add(GUILD, 'alice', 'carol', 'trusted');

      await sweep();

      expect(bits(held('old', 'carol'))).toEqual({ allow: C, deny: 0n });
      expect(bits(everyone('old'))).toEqual({ allow: 0n, deny: C });
      expect((await joinChannels.getBySecondary('old'))?.channelId).toBe('old-join');
      expect(actions.ofType('joinChannel')).toEqual([]);
    });

    it('takes back a recorded entry the lists no longer name, and nothing else', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      expect(held('r1', 'carol')).toBeDefined();
      expect(held('r1', 'mallory')).toBeDefined();
      // The member's edit was made while this instance was away, so nothing took it back.
      await lists.remove(GUILD, 'alice', 'carol');
      await lists.remove(GUILD, 'alice', 'mallory');

      await sweep();

      expect(held('r1', 'carol')).toBeUndefined();
      expect(held('r1', 'mallory')).toBeUndefined();
      expect((await access('r1'))?.trusted).toBeUndefined();
      expect((await access('r1'))?.blocked).toBeUndefined();
      // The lock itself is not an entry.
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
    });

    it('never deletes an overwrite it did not record: a human, an approved knocker, an older vote', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      actions.seedOverwrites('r1', [
        ...actions.overwritesOf('r1'),
        ow('knocker', C, 0n), // approved from the Join channel, which records nothing
        ow('legacy-kick', 0n, C), // an older instance's vote, which looks exactly like a block
        ow('admin-pal', V, 0n), // a human's
        roleOw('role-x', 0n, V),
      ]);

      await sweep();

      expect(bits(held('r1', 'knocker'))).toEqual({ allow: C, deny: 0n });
      expect(bits(held('r1', 'legacy-kick'))).toEqual({ allow: 0n, deny: C });
      expect(bits(held('r1', 'admin-pal'))).toEqual({ allow: V, deny: 0n });
      expect(bits(held('r1', 'role-x', OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('never blocks or touches the current owner, though the creator listed them', async () => {
      // alice made the room and left, bob inherited it, and alice's list names bob.
      await room('r1', 'bob', 'alice');
      await lists.add(GUILD, 'alice', 'bob', 'blocked');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      await sweep();

      expect(held('r1', 'bob')?.deny ?? 0n).toBe(0n);
      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('re-grants the owner what a locked room gives them when it has gone missing', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      actions.seedOverwrites(
        'r1',
        actions.overwritesOf('r1').filter((o) => o.id !== 'alice'),
      );

      await sweep();

      expect(bits(held('r1', 'alice'))).toEqual({ allow: C, deny: 0n });
    });

    it('puts back a vote’s removal that went missing, for a room that records nothing else', async () => {
      await room('r1');
      await privacy.denyKicked(GUILD, 'r1', 'eve');
      expect(bits(held('r1', 'eve'))).toEqual({ allow: 0n, deny: VC });
      actions.seedOverwrites(
        'r1',
        actions.overwritesOf('r1').filter((o) => o.id !== 'eve'),
      );

      await sweep();

      expect(bits(held('r1', 'eve'))).toEqual({ allow: 0n, deny: VC });
    });

    it('cleans up a stale marker that is all a room records', async () => {
      await room('r1');
      await stageAccess('r1', { creatorId: 'alice', pending: { mode: 'public', at: 1 } });

      await sweep();

      expect((await access('r1'))?.pending).toBeUndefined();
      // And is not looked at again: a record that names only its creator is no work.
      const writes = actions.ofType('overwrites').length;
      await sweep();
      expect(actions.ofType('overwrites')).toHaveLength(writes);
    });

    it('does nothing the second time: the same sweep writes, deletes, creates and moves nothing', async () => {
      moderatorRole = 'mods';
      await room('r1');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.seedOverwrites(
        'r1',
        actions.overwritesOf('r1').filter((o) => o.id !== 'carol'),
      );
      await sweep();
      const once = await snapshot('r1');
      expect(bits(held('r1', 'carol'))).toEqual({ allow: VC, deny: 0n });

      await sweep();

      expect(await snapshot('r1')).toEqual(once);
    });
  });

  // -- a creator who is denied saved lists --------------------------------------------

  describe('a creator denied Saved lists', () => {
    const DENIED = { access: { users: ['alice'], roles: [] } };

    it('has lists that apply to nothing, and what they wrote is taken back', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await sweep();
      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });

      voice.setOwnerAccess('alice', { roleIds: [] });
      rules = DENIED;
      await sweep();

      expect(held('r1', 'mallory')).toBeUndefined();
      expect((await access('r1'))?.blocked).toBeUndefined();
    });

    it('applies again the moment the rule is lifted', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      voice.setOwnerAccess('alice', { roleIds: [] });
      rules = DENIED;
      await sweep();
      expect(held('r1', 'mallory')).toBeUndefined();

      rules = {};
      await sweep();

      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is not inert when the cache cannot say who they are, which fails open', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      rules = DENIED; // nothing says who alice is: ownerAccessOf answers undefined

      await sweep();

      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is not inert for a member who can manage channels, however the rule names them', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      voice.setOwnerAccess('alice', { roleIds: [], canManage: true });
      rules = DENIED;

      await sweep();

      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is inert by role too', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      voice.setOwnerAccess('alice', { roleIds: ['role-bad'] });
      rules = { access: { users: [], roles: ['role-bad'] } };

      await sweep();

      expect(held('r1', 'mallory')).toBeUndefined();
    });
  });

  // -- hidden rooms ----------------------------------------------------------------

  describe('a hidden room', () => {
    it('is put back when somebody edits `@everyone` or removes the bot, with the full overwrite', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      // An admin made the room visible again by hand, and dropped the bot's overwrite.
      actions.seedOverwrites('r1', [ow('alice', VC), roleOw(GUILD, V, 0n), ow('human', C, 0n)]);

      await sweep();

      // View AND Connect denied together, whatever the edit left, and nothing allowed.
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });
      expect(bits(held('r1', BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      expect(bits(held('r1', 'alice'))).toEqual({ allow: VC, deny: 0n });
      // A human's own overwrite is theirs, hidden room or not.
      expect(bits(held('r1', 'human'))).toEqual({ allow: C, deny: 0n });
    });

    it('overrides a role whose View allow would show it, and records what it was', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', [...actions.overwritesOf('r1'), roleOw('vip', V, 0n)]);

      await sweep();

      expect(bits(held('r1', 'vip', OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
      expect((await access('r1'))?.neutralised).toEqual([{ roleId: 'vip', view: 'allow' }]);
    });

    it('has no Join channel: a stray one is deleted, row and channel', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      await joinChannels.create({
        channelId: 'stray-join',
        guildId: GUILD,
        secondaryChannelId: 'r1',
        creatorId: 'alice',
      });

      await sweep();

      expect(await joinChannels.getBySecondary('r1')).toBeUndefined();
      expect(actions.ofType('delete').map((a) => a.channelId)).toContain('stray-join');
    });

    it('gets its lost `private` flag back, through the record write', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      // A stale whole-state write: the flag is gone, the record still says hidden.
      const { private: _private, ...rest } = (await row('r1')).state;
      await secondaries.updateState('r1', rest);
      expect((await row('r1')).state.private).toBeUndefined();

      await sweep();

      expect((await row('r1')).state.private).toBe(true);
      expect((await access('r1'))?.hidden).toBe(true);
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });
      // And not a public room with a lock to offer: no Join channel appeared.
      expect(await joinChannels.getBySecondary('r1')).toBeUndefined();
    });

    it('keeps the bot and the saved lists on it, and a second sweep changes nothing', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.hide(GUILD, 'r1', 'alice');
      await sweep();
      const once = await snapshot('r1');

      await sweep();

      expect(bits(held('r1', 'carol'))).toEqual({ allow: VC, deny: 0n });
      expect(await snapshot('r1')).toEqual(once);
    });
  });

  // -- the Join channel --------------------------------------------------------------

  describe('a locked room has exactly one Join channel', () => {
    it('makes the one it is missing, once, and a second sweep makes no more', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const first = (await joinChannels.getBySecondary('r1'))!;
      await joinChannels.remove(first.channelId);

      await sweep();
      const made = await joinChannels.getBySecondary('r1');
      await sweep();

      expect(made).toBeDefined();
      expect(made?.channelId).not.toBe(first.channelId);
      expect(made?.creatorId).toBe('alice');
      expect(actions.ofType('joinChannel')).toHaveLength(2); // the lock's, and the repair's
      expect((await joinChannels.listBySecondaries(['r1'])).length).toBe(1);
      expect(actions.ofType('joinChannel')[1]!.name).toBe('⇩ Join alice');
    });

    it('denies the creator’s blocked members Connect on the Join channel it makes', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      await joinChannels.remove((await joinChannels.getBySecondary('r1'))!.channelId);

      await sweep();

      const joinId = (await joinChannels.getBySecondary('r1'))!.channelId;
      expect(bits(held(joinId, 'mallory'))).toEqual({ allow: 0n, deny: C });
    });

    it('trims two to the oldest, which is the one the knock keeps', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const keep = (await joinChannels.getBySecondary('r1'))!;
      await joinChannels.create({
        channelId: 'dupe-join',
        guildId: GUILD,
        secondaryChannelId: 'r1',
        creatorId: 'alice',
      });
      await env.handle.pool.query(
        "UPDATE join_channels SET created_at = now() + interval '1 minute' WHERE channel_id = 'dupe-join'",
      );

      await sweep();

      expect((await joinChannels.getBySecondary('r1'))?.channelId).toBe(keep.channelId);
      expect(await joinChannels.get('dupe-join')).toBeUndefined();
      expect(actions.ofType('delete').map((a) => a.channelId)).toEqual(['dupe-join']);
    });

    it('makes none for a room with nobody to name', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      await joinChannels.remove((await joinChannels.getBySecondary('r1'))!.channelId);
      await env.handle.pool.query(
        'UPDATE secondary_channels SET owner_id = NULL WHERE channel_id = $1',
        ['r1'],
      );
      const before = actions.ofType('joinChannel').length;

      await sweep();

      expect(actions.ofType('joinChannel')).toHaveLength(before);
    });
  });

  // -- the moderator role ------------------------------------------------------------

  describe('the moderator role', () => {
    it('is granted View on a room that was hidden before the setting was made', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      expect(held('r1', 'mods', OVERWRITE_ROLE)).toBeUndefined();

      moderatorRole = 'mods';
      await sweep();

      // View only: seeing a room is not joining it.
      expect(bits(held('r1', 'mods', OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect((await access('r1'))?.viewerRoleId).toBe('mods');
    });

    it('is revoked and the new one granted when the setting changes', async () => {
      moderatorRole = 'mods';
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      expect(held('r1', 'mods', OVERWRITE_ROLE)).toBeDefined();

      moderatorRole = 'mods-2';
      await sweep();

      expect(held('r1', 'mods', OVERWRITE_ROLE)).toBeUndefined();
      expect(bits(held('r1', 'mods-2', OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect((await access('r1'))?.viewerRoleId).toBe('mods-2');
    });

    it('is revoked when the setting is cleared, which a hidden room is promised', async () => {
      moderatorRole = 'mods';
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');

      moderatorRole = null;
      await sweep();

      expect(held('r1', 'mods', OVERWRITE_ROLE)).toBeUndefined();
      expect((await access('r1'))?.viewerRoleId).toBeUndefined();
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is dropped, not granted, when the role has been deleted', async () => {
      moderatorRole = 'mods';
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.missingRoleIds.add('mods');

      await sweep();

      expect(held('r1', 'mods', OVERWRITE_ROLE)).toBeUndefined();
      expect((await access('r1'))?.viewerRoleId).toBeUndefined();
    });

    it('is not granted when the setting names a role that does not exist', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.missingRoleIds.add('ghost');

      moderatorRole = 'ghost';
      await sweep();

      expect(held('r1', 'ghost', OVERWRITE_ROLE)).toBeUndefined();
      expect((await access('r1'))?.viewerRoleId).toBeUndefined();
    });

    it('is not granted on a locked room, which anybody who can see the list can see anyway', async () => {
      moderatorRole = 'mods';
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      await sweep();

      expect(held('r1', 'mods', OVERWRITE_ROLE)).toBeUndefined();
    });
  });

  // -- an opening Discord only queued -------------------------------------------------

  describe('an opening that was queued behind the rate limit', () => {
    /**
     * The record of a room whose opening is queued still says hidden (or locked), and a
     * pass that re-derived the room from that would close it again, fighting the write
     * that is about to land.
     */
    it('is carried through, not undone, when an unhide has not landed', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      const hiddenSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      const queued = await privacy.unhide(GUILD, 'r1', 'alice');
      expect(queued.ok).toBe(false);
      expect((await access('r1'))?.hidden).toBe(true);
      expect((await access('r1'))?.pending?.mode).toBe('locked');
      // The write is still in Discord's queue: the channel holds what it held before.
      actions.seedOverwrites('r1', hiddenSet);
      actions.simulateOverwriteRateLimit = false;

      await sweep();

      // Locked, not hidden: View is no longer denied, and Connect still is.
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
      expect((await access('r1'))?.hidden).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect((await row('r1')).state.private).toBe(true);
      expect(liveJoins()).toHaveLength(1);
      expect((await joinChannels.getBySecondary('r1'))?.creatorId).toBe('alice');
    });

    it('is finalised when the queued write has already landed', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.simulateOverwriteRateLimit = true;
      await privacy.unhide(GUILD, 'r1', 'alice');
      actions.simulateOverwriteRateLimit = false;
      const written = actions.ofType('overwrites').length;

      await sweep();

      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
      expect((await access('r1'))?.hidden).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect(liveJoins()).toHaveLength(1);
      // Nothing was left to change on the channel: the pass only finished the record.
      expect(
        actions
          .ofType('overwrites')
          .slice(written)
          .every((a) => a.requests === 0),
      ).toBe(true);
    });

    it('carries a queued /public through too: open, no lock, no Join channel', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const lockedSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      const queued = await privacy.makePublic(GUILD, 'r1', 'alice');
      expect(queued.ok).toBe(false);
      expect((await access('r1'))?.pending?.mode).toBe('public');
      actions.seedOverwrites('r1', lockedSet);
      actions.simulateOverwriteRateLimit = false;

      await sweep();

      expect(everyone('r1')).toBeUndefined();
      expect((await row('r1')).state.private).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect(liveJoins()).toHaveLength(0);
      expect(await joinChannels.getBySecondary('r1')).toBeUndefined();
    });

    it('does not mark a queued ENTRY: its record already names the mode it is heading for', async () => {
      await room('r1');
      actions.simulateOverwriteRateLimit = true;
      const queued = await privacy.hide(GUILD, 'r1', 'alice');
      expect(queued.ok).toBe(false);
      expect((await access('r1'))?.pending).toBeUndefined();
      // Not landed yet; the sweep asserts the hide, which is what was asked for.
      actions.seedOverwrites('r1', []);
      actions.simulateOverwriteRateLimit = false;

      await sweep();

      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });
      expect((await access('r1'))?.hidden).toBe(true);
    });

    it('clears a marker for the mode the room is already in, and changes nothing else', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const record = (await access('r1'))!;
      await stageAccess('r1', { ...record, pending: { mode: 'locked', at: 1 } });
      const before = actions.overwritesOf('r1');

      await sweep();

      expect((await access('r1'))?.pending).toBeUndefined();
      expect((await access('r1'))?.baseline).toEqual(record.baseline);
      expect(actions.overwritesOf('r1')).toEqual(before);
      expect((await row('r1')).state.private).toBe(true);
    });

    /**
     * An opening is an undo, which the lever never blocks, and the owner was told it would
     * land. A restart that lost the write would otherwise leave the room closed against
     * their request for as long as the lever is on.
     */
    it('is carried through while the lever is on, which adds nothing, and the rest waits for it to be lifted', async () => {
      await room('r1');
      await room('r2', 'bob');
      await privacy.hide(GUILD, 'r1', 'alice');
      const hiddenSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      await privacy.unhide(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', hiddenSet); // still in Discord's queue
      actions.simulateOverwriteRateLimit = false;
      // Saved while it was queued, so the room does not hold it, and the lever must not add it.
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'mallory', 'blocked');
      leverOn = true;
      const byGuild = vi.spyOn(lists, 'listByGuild');

      await sweep();

      // The opening landed: locked, with View no longer denied, and its Join channel.
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
      expect((await access('r1'))?.hidden).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect(liveJoins()).toHaveLength(1);
      // And nothing was added to it, or to any other room.
      expect(held('r1', 'mallory')).toBeUndefined();
      expect((await access('r1'))?.blocked).toBeUndefined();
      expect(held('r2', 'mallory')).toBeUndefined();
      // Only the owner of the room that had something queued was asked about.
      expect(byGuild).toHaveBeenCalledTimes(1);
      expect(byGuild).toHaveBeenCalledWith(GUILD, ['alice']);

      leverOn = false;
      await sweep();
      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(bits(held('r2', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is carried through while the lever is on for a /public too, with no Join channel made', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const lockedSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      await privacy.makePublic(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', lockedSet);
      actions.simulateOverwriteRateLimit = false;
      leverOn = true;

      await sweep();

      expect(everyone('r1')).toBeUndefined();
      expect((await row('r1')).state.private).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect(liveJoins()).toHaveLength(0);
    });

    it('leaves a marker the lever has no business with alone: one too old to believe waits for it to be lifted', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      const record = (await access('r1'))!;
      await stageAccess('r1', { ...record, pending: { mode: 'locked', at: 1 } });
      leverOn = true;
      const writes = actions.ofType('overwrites').length;

      await sweep();

      expect((await access('r1'))?.pending).toBeDefined();
      expect(actions.ofType('overwrites')).toHaveLength(writes);
    });

    /**
     * Discord runs the writes of a channel in order, so a change queued behind the opening
     * lands after it and is what the owner last asked for. The marker left standing would
     * have the sweep open the room against it.
     */
    it('is superseded by a later change queued behind it, so the sweep does not open the room against it', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const lockedSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      expect((await privacy.makePublic(GUILD, 'r1', 'alice')).ok).toBe(false);
      expect((await access('r1'))?.pending?.mode).toBe('public');
      actions.seedOverwrites('r1', lockedSet); // the opening is still in the queue
      // The owner changes their mind before it lands: hide the room instead.
      const hidden = await privacy.hide(GUILD, 'r1', 'alice');
      expect(hidden.ok).toBe(false); // queued as well
      expect((await access('r1'))?.pending).toBeUndefined();
      actions.simulateOverwriteRateLimit = false;
      // Both have landed, in order, and the room is hidden.
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });

      await sweep();

      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });
      expect((await access('r1'))?.hidden).toBe(true);
      expect((await row('r1')).state.private).toBe(true);
      expect(liveJoins()).toHaveLength(0);
    });

    it('is replaced by the marker of a later opening queued behind it', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.simulateOverwriteRateLimit = true;
      await privacy.unhide(GUILD, 'r1', 'alice');
      expect((await access('r1'))?.pending?.mode).toBe('locked');
      await privacy.makePublic(GUILD, 'r1', 'alice');
      expect((await access('r1'))?.pending?.mode).toBe('public');
    });

    /**
     * Written by something that did not finish it, and old enough that what it describes is
     * no longer what the owner last asked for. The room stays as its record says, which is
     * closed, and the owner can run the command again.
     */
    it('is not believed once it is older than a queued write can wait, and is only cleared', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      const record = (await access('r1'))!;
      const before = actions.overwritesOf('r1');
      await stageAccess('r1', {
        ...record,
        pending: { mode: 'locked', at: Date.now() - 16 * 60 * 1000 },
      });

      await sweep();

      expect((await access('r1'))?.pending).toBeUndefined();
      expect((await access('r1'))?.hidden).toBe(true);
      expect(actions.overwritesOf('r1')).toEqual(before);
      expect(liveJoins()).toHaveLength(0);
    });

    it('is still believed a little before that', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      const record = (await access('r1'))!;
      await stageAccess('r1', {
        ...record,
        pending: { mode: 'locked', at: Date.now() - 14 * 60 * 1000 },
      });

      await sweep();

      expect((await access('r1'))?.hidden).toBeUndefined();
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
    });

    /**
     * A marker only ever names an exit. One naming a way IN was written by something else,
     * and carrying it through would close a room the owner had opened.
     */
    it.each<[string, 'public' | 'locked' | 'hidden', 'public' | 'locked' | 'hidden']>([
      ['more closed than a public room', 'public', 'hidden'],
      ['locked, from a public room', 'public', 'locked'],
      ['hidden, from a locked room', 'locked', 'hidden'],
      ['the mode a hidden room is already in', 'hidden', 'hidden'],
    ])('only clears a marker for %s', async (_what, mode, marked) => {
      await room('r1');
      if (mode === 'locked') await privacy.makePrivate(GUILD, 'r1', 'alice');
      if (mode === 'hidden') await privacy.hide(GUILD, 'r1', 'alice');
      // A room the bot made holds the bot's own overwrite, which is all a public one needs.
      if (mode === 'public') actions.seedOverwrites('r1', [ow(BOT, BOT_ACCESS)]);
      const record = (await access('r1')) ?? { creatorId: 'alice' };
      await stageAccess('r1', { ...record, pending: { mode: marked, at: Date.now() } });
      const before = actions.overwritesOf('r1');
      const privateBefore = (await row('r1')).state.private;

      await sweep();

      expect((await access('r1'))?.pending).toBeUndefined();
      expect(actions.overwritesOf('r1')).toEqual(before);
      expect((await row('r1')).state.private).toBe(privateBefore);
      expect((await access('r1'))?.hidden).toBe(mode === 'hidden' ? true : undefined);
    });

    /**
     * An admit and a vote's removal both write the room over from what Discord holds now,
     * which for a room with an opening still queued is the closed room. Planned as the mode
     * the record still names they would close it again behind the opening and take the marker
     * off, so the opening would never be finished.
     */
    it('is carried through by an admit that comes before it lands, not closed again behind it', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      const hiddenSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      await privacy.unhide(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', hiddenSet); // still queued
      actions.simulateOverwriteRateLimit = false;

      const admitted = await privacy.admit(GUILD, 'r1', 'alice', 'carol');

      expect(admitted.ok).toBe(true);
      // Locked and not hidden, with carol let in: what the owner asked for, plus the admit.
      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: C });
      expect(bits(held('r1', 'carol'))).toEqual({ allow: C, deny: 0n });
      expect((await access('r1'))?.hidden).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect(liveJoins()).toHaveLength(1);
    });

    it('is told it is open to everyone by an admit when the room is on its way to public', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const lockedSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      await privacy.makePublic(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', lockedSet);
      actions.simulateOverwriteRateLimit = false;
      const before = actions.actions.length;

      const admitted = await privacy.admit(GUILD, 'r1', 'alice', 'carol');

      expect(admitted.ok).toBe(false);
      expect(actions.actions).toHaveLength(before);
      expect((await access('r1'))?.pending?.mode).toBe('public');
      expect((await access('r1'))?.admitted).toBeUndefined();
    });

    it('is carried through by a vote that removes someone before it lands', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const lockedSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      await privacy.makePublic(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', lockedSet);
      actions.simulateOverwriteRateLimit = false;

      expect(await privacy.denyKicked(GUILD, 'r1', 'eve')).toBe(true);

      // Open, as the owner asked, with the vote's removal in force in every mode.
      expect(bits(held('r1', 'eve'))).toEqual({ allow: 0n, deny: VC });
      expect(everyone('r1')).toBeUndefined();
      expect((await row('r1')).state.private).toBeUndefined();
      expect((await access('r1'))?.pending).toBeUndefined();
      expect((await access('r1'))?.kicked).toEqual(['eve']);
    });
  });

  // -- what it leaves alone ------------------------------------------------------------

  describe('a record this build cannot read', () => {
    it('is skipped and reported, never repaired, and no Join channel is made for it', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      // What a newer build might have written for a hidden room.
      await stageAccess('r1', { hidden: 'a-newer-shape' });
      await secondaries.updateState('r1', { ...(await row('r1')).state, private: true });

      const result = await privacy.convergeGuild(GUILD, await secondaries.listByGuild(GUILD));

      expect(result.unreadable).toEqual(['r1']);
      expect(result.repaired).toBe(0);
      expect(actions.ofType('overwrites')).toEqual([]);
      expect(actions.ofType('joinChannel')).toEqual([]);
      const stored = await env.handle.pool.query(
        'SELECT access FROM secondary_channels WHERE channel_id = $1',
        ['r1'],
      );
      expect(stored.rows[0].access).toEqual({ hidden: 'a-newer-shape' });
    });

    it('does not stop the readable rooms beside it', async () => {
      await room('bad');
      await room('good', 'bob');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'mallory', 'blocked');
      await stageAccess('bad', { hidden: 'a-newer-shape' });

      await sweep();

      expect(actions.overwritesOf('bad')).toEqual([]);
      expect(bits(held('good', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });
  });

  describe('a room the bot cannot edit', () => {
    const failFor = (channelId: string, err: unknown) => {
      const real = actions.readOverwrites.bind(actions);
      return vi
        .spyOn(actions, 'readOverwrites')
        .mockImplementation((guildId, id) =>
          id === channelId ? Promise.reject(err) : real(guildId, id),
        );
    };

    it('costs that room only: the rest of the guild is repaired and the passes after it still run', async () => {
      await room('rA', 'alice');
      await room('rB', 'bob');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'mallory', 'blocked');
      failFor('rA', apiError(50013));
      voice.put(PRIMARY, member('carol'));

      const drift = await sweep();

      expect(held('rA', 'mallory')).toBeUndefined();
      expect(bits(held('rB', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      // The catch-up pass after it ran: carol, sitting in the creator channel, got a room.
      expect(drift.created).toHaveLength(1);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rA', operation: 'access' }),
      ]);
    });

    /**
     * The cache knows the bot's permissions, so a room it says the bot cannot edit is not read or
     * written at all: the write is bound to be refused, at the price of a read, a transaction and
     * one or two refused calls per room per sweep. Free to ask, so asked every sweep, and the room
     * is repaired the sweep after the permission comes back.
     */
    it('is neither read nor written while the cache says the bot lacks Manage Roles, and is told once', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      voice.setBotPermissions('rA', { manageRoles: false });
      const read = vi.spyOn(actions, 'readOverwrites');
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      expect(read).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(serverLogs).toHaveLength(1);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rA', operation: 'access' }),
      ]);

      voice.setBotPermissions('rA', { manageRoles: true });
      await sweep();

      expect(bits(held('rA', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('is told to the guild once, and not again by every sweep', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rA', apiError(50013));
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      // Asked once and then left alone for a while: every try is a read and refused calls that
      // count toward Discord's budget of invalid requests. One incident, one line in the log.
      expect(read).toHaveBeenCalledTimes(1);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(serverLogs).toHaveLength(1);
    });

    it('recovers when the permission comes back, and the incident clears with it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rA', apiError(50013));
      await sweep();
      expect(problems.recent(GUILD)).toHaveLength(1);

      // After the half hour it is left alone for, which is how it notices the permission is back.
      read.mockRestore();
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      await sweep();
      expect(bits(held('rA', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('is not counted against the guild: a failure to write never throws out of the sweep', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      actions.failOverwrites = true;

      await expect(sweep()).resolves.toMatchObject({ guildId: GUILD });
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rA', operation: 'access' }),
      ]);
    });

    it('costs that room only even when something throws out of it, which is counted and not rethrown', async () => {
      await room('rA', 'alice');
      await room('rB', 'bob');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'mallory', 'blocked');
      const real = privacy.applyAccessLists.bind(privacy);
      vi.spyOn(privacy, 'applyAccessLists').mockImplementation((guildId, id, opts) =>
        id === 'rA' ? Promise.reject(new Error('boom')) : real(guildId, id, opts),
      );

      const result = await privacy.convergeGuild(GUILD, await secondaries.listByGuild(GUILD));

      expect(result).toMatchObject({ considered: 2, repaired: 1, failed: 1 });
      expect(bits(held('rB', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is not recorded for a failure that is not a permission one', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      failFor('rA', new Error('socket hang up'));

      await sweep();

      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('is lost access when Discord shows only the obfuscated shell, reported once and not asked again', async () => {
      await room('rO', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rO', new ChannelObfuscatedError('rO'));

      await sweep();
      await sweep();
      await sweep();

      expect(read).toHaveBeenCalledTimes(1);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rO', operation: 'delete' }),
      ]);
      expect(serverLogs).toHaveLength(1);
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('is asked about once more after a long while, which is how it notices access came back', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await room('rO', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rO', new ChannelObfuscatedError('rO'));
      await sweep();
      expect(read).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      read.mockRestore();
      await sweep();

      expect(bits(held('rO', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      // And the incident is over: nothing else would clear it, since a room that was fine all
      // along has nothing to write.
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('is not mistaken for a recovery by a retry that fails the same way', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await room('rO', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rO', new ChannelObfuscatedError('rO'));
      await sweep();

      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await sweep();

      expect(read).toHaveBeenCalledTimes(2);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rO', operation: 'delete' }),
      ]);
    });

    it('is forgotten when the room is cleaned up, so nothing lingers for a room that is gone', async () => {
      await room('rO', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rO', new ChannelObfuscatedError('rO'));
      await sweep();
      await sweep();
      expect(read).toHaveBeenCalledTimes(1); // parked

      await privacy.cleanupForSecondary(GUILD, 'rO');
      await sweep();

      expect(read).toHaveBeenCalledTimes(2); // no longer parked
    });

    it('is told once when the write fails, not once per sweep', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      actions.failOverwrites = true;
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      expect(recorded).toHaveBeenCalledTimes(1);
      expect(serverLogs).toHaveLength(1);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rA', operation: 'access' }),
      ]);
    });

    it('is told once when the record cannot be finalised, not once per sweep', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.makePrivate(GUILD, 'rA', 'alice');
      expect(held('rA', 'carol')).toBeDefined();
      // The take-back is what the finalising write records, and it keeps failing.
      await lists.remove(GUILD, 'alice', 'carol');
      const real = secondaries.transitionAccess.bind(secondaries);
      let calls = 0;
      vi.spyOn(secondaries, 'transitionAccess').mockImplementation((id, transition) =>
        ++calls % 2 === 0 ? Promise.reject(apiError(50013)) : real(id, transition),
      );
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      expect(calls).toBe(2); // the intent and the failed finalise, once, and then left alone
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(serverLogs).toHaveLength(1);
    });

    it('is told once when its Join channel cannot be made, and is over when it can', async () => {
      await room('rA', 'alice');
      await privacy.makePrivate(GUILD, 'rA', 'alice');
      await joinChannels.remove((await joinChannels.getBySecondary('rA'))!.channelId);
      const create = vi.spyOn(actions, 'createJoinChannel').mockRejectedValue(apiError(50013));
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      expect(create).toHaveBeenCalledTimes(3);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(serverLogs).toHaveLength(1);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: 'rA', operation: 'access' }),
      ]);

      // The room's own write has nothing to change, so making the channel is all that clears it.
      create.mockRestore();
      await sweep();
      expect(await joinChannels.getBySecondary('rA')).toBeDefined();
      expect(problems.recent(GUILD)).toEqual([]);
    });

    /**
     * The guild's problem list keeps ten, so past ten broken rooms it evicts each one before
     * its next sweep, and a memory that was only that list would tell them all again every
     * five minutes (a line each in the log channel, and the notifier's backoff restarted).
     */
    it('is told once for each of more than ten rooms, though the guild keeps a list of ten', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      for (let i = 1; i <= 11; i++) {
        await room(`r${i}`, `owner${i}`);
        await lists.add(GUILD, `owner${i}`, 'mallory', 'blocked');
      }
      actions.failOverwrites = true;
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      expect(recorded).toHaveBeenCalledTimes(11);
      expect(serverLogs).toHaveLength(11);

      // Still broken a long while later, which is worth saying again.
      vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await sweep();
      expect(recorded).toHaveBeenCalledTimes(22);

      // And over, for every room, once the permission is back and the wait is over.
      actions.failOverwrites = false;
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      await sweep();
      for (let i = 1; i <= 11; i++) {
        expect(bits(held(`r${i}`, 'mallory'))).toEqual({ allow: 0n, deny: VC });
      }
      expect(problems.recent(GUILD)).toEqual([]);
      recorded.mockClear();
      actions.failOverwrites = true;
      await lists.add(GUILD, 'owner1', 'trudy', 'blocked');
      await sweep();
      expect(recorded).toHaveBeenCalledTimes(1); // told again, since it broke again
    });

    it('never logs what a failed Join channel create was asked for, which is the owner’s name', async () => {
      await room('rA', 'alice');
      await privacy.makePrivate(GUILD, 'rA', 'alice');
      await joinChannels.remove((await joinChannels.getBySecondary('rA'))!.channelId);
      const failure = () =>
        new DiscordAPIError(
          { code: 50013, message: 'Missing Permissions' } as never,
          50013,
          403,
          'POST',
          'https://discord.test',
          // What discord.js's REST layer hands the error: it keeps `body` as `json`.
          { body: { name: '⇩ Join Alice Example' }, files: undefined } as never,
        );
      expect(JSON.stringify(failure())).toContain('Alice Example'); // so the test can see it
      vi.spyOn(actions, 'createJoinChannel').mockImplementation(() => Promise.reject(failure()));
      const warn = vi.spyOn(logger, 'warn');

      await pass();
      // And the same for a lock whose Join channel fails, the command's own path.
      await privacy.makePublic(GUILD, 'rA', 'alice');
      await privacy.makePrivate(GUILD, 'rA', 'alice');

      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [fields] of warn.mock.calls) {
        expect(JSON.stringify(fields)).not.toContain('Alice Example');
      }
    });
  });

  // -- a listed member who is not in the server ------------------------------------------

  /**
   * A saved list outlives its entries' membership, and the commonest block is somebody who
   * was banned. A plan always wants an overwrite for each of them, and none can be written,
   * so without a memory of it every sweep would look them up, write the record twice and
   * count the room as repaired, to end where it began.
   */
  describe('a listed member who is no longer in the server', () => {
    const GONE = 'gone';
    beforeEach(() => {
      actions.unknownMemberIds.add(GONE);
    });

    it('is looked for once, and a second pass writes nothing, reads nothing and repairs nothing', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', GONE, 'blocked');
      const apply = vi.spyOn(actions, 'applyOverwrites');

      const first = await pass();

      // The bot's own overwrite is written, and the member gets none.
      expect(first.repaired).toBe(1);
      expect(held('r1', GONE)).toBeUndefined();
      expect(apply).toHaveBeenCalledTimes(1);
      const once = await snapshot('r1');
      apply.mockClear();
      const transition = vi.spyOn(secondaries, 'transitionAccess');
      const read = vi.spyOn(actions, 'readOverwrites');

      const second = await pass();

      expect(second).toMatchObject({ considered: 1, repaired: 0, completed: 0, failed: 0 });
      expect(apply).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(await snapshot('r1')).toEqual(once);
      // The record names what was written, and nothing was written for them.
      expect((await access('r1'))?.blocked).toBeUndefined();
    });

    it('costs a locked room the same, and its other entries are still applied', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', GONE, 'blocked');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      expect(bits(held('r1', 'carol'))).toEqual({ allow: C, deny: 0n });
      const once = await snapshot('r1');
      const apply = vi.spyOn(actions, 'applyOverwrites');

      const result = await pass();

      expect(result.repaired).toBe(0);
      expect(apply).not.toHaveBeenCalled();
      expect(await snapshot('r1')).toEqual(once);
    });

    it('is looked for again when they rejoin, which the member cache shows at once', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', GONE, 'blocked');
      await pass();
      expect(held('r1', GONE)).toBeUndefined();

      actions.unknownMemberIds.delete(GONE);
      voice.setMemberFacts(GONE, {}); // back in the server, and in the cache

      const result = await pass();

      expect(result.repaired).toBe(1);
      expect(bits(held('r1', GONE))).toEqual({ allow: 0n, deny: VC });
      expect((await access('r1'))?.blocked).toEqual([GONE]);
    });

    it('is looked for again after an hour, in case the cache missed their return', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await room('r1');
      await lists.add(GUILD, 'alice', GONE, 'blocked');
      await pass();
      const apply = vi.spyOn(actions, 'applyOverwrites');

      vi.setSystemTime(Date.now() + 59 * 60 * 1000);
      await pass();
      expect(apply).not.toHaveBeenCalled();

      actions.unknownMemberIds.delete(GONE);
      vi.setSystemTime(Date.now() + 2 * 60 * 1000);
      await pass();

      expect(apply).toHaveBeenCalledTimes(1);
      expect(bits(held('r1', GONE))).toEqual({ allow: 0n, deny: VC });
    });

    it('is still answered "not in the server" by an admit, from what was learned, with nothing recorded', async () => {
      await room('r1');
      await privacy.makePrivate(GUILD, 'r1', 'alice');
      const first = await privacy.admit(GUILD, 'r1', 'alice', GONE);
      const second = await privacy.admit(GUILD, 'r1', 'alice', GONE);

      expect(first).toEqual({ ok: false, message: admitNotInServer(GONE) });
      expect(second).toEqual({ ok: false, message: admitNotInServer(GONE) });
      expect(held('r1', GONE)).toBeUndefined();
      expect((await access('r1'))?.admitted).toBeUndefined();
    });

    it('keeps an overwrite it already wrote for them, and the block that outlives their membership', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', GONE, 'blocked');
      actions.unknownMemberIds.delete(GONE);
      await pass();
      expect(bits(held('r1', GONE))).toEqual({ allow: 0n, deny: VC });
      actions.unknownMemberIds.add(GONE); // and now they have left

      await pass();
      await pass();

      expect(bits(held('r1', GONE))).toEqual({ allow: 0n, deny: VC });
      expect((await access('r1'))?.blocked).toEqual([GONE]);
    });
  });

  // -- what the pass says it did -------------------------------------------------------

  describe('what the pass reports', () => {
    it('counts an opening it carried through and a Join channel it made, in one line for the guild', async () => {
      await room('r1');
      await room('r2', 'bob');
      await privacy.hide(GUILD, 'r1', 'alice');
      const hiddenSet = actions.overwritesOf('r1');
      actions.simulateOverwriteRateLimit = true;
      await privacy.unhide(GUILD, 'r1', 'alice');
      actions.seedOverwrites('r1', hiddenSet);
      actions.simulateOverwriteRateLimit = false;
      await privacy.makePrivate(GUILD, 'r2', 'bob');
      await joinChannels.remove((await joinChannels.getBySecondary('r2'))!.channelId);
      const info = vi.spyOn(logger, 'info');

      const result = await pass();

      // r1's opening was carried through (its write made its own Join channel), and r2 only
      // needed one.
      expect(result).toEqual({
        considered: 2,
        repaired: 1,
        completed: 1,
        joinsFixed: 1,
        unreadable: [],
        failed: 0,
      });
      expect(info).toHaveBeenCalledWith(
        { guildId: GUILD, ...result, unreadable: 0 },
        'converged room access',
      );

      info.mockClear();
      await pass();
      expect(info).not.toHaveBeenCalledWith(expect.anything(), 'converged room access');
    });

    it('says which room it could not plan a change for, and why, once and not every sweep', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      // A role above the bot was given View by hand: a hide it can neither undo nor leave.
      actions.seedOverwrites('r1', [...actions.overwritesOf('r1'), roleOw('vip', V, 0n)]);
      voice.setBotRoleAccess({ uneditableRoleIds: ['vip'] });
      const warn = vi.spyOn(logger, 'warn');
      const lines = () =>
        warn.mock.calls.filter(([, message]) =>
          /could not plan a room access change/.test(`${message}`),
        );

      const first = await pass();
      await pass();
      await pass();

      expect(first.failed).toBe(1);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]![0]).toEqual({
        guildId: GUILD,
        channelId: 'r1',
        reason: 'role_defeats_hide',
        defeatedBy: ['vip'],
      });
      // The room was left exactly as it was.
      expect(bits(held('r1', 'vip', OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });

      // Fixed, and then broken again, which is worth saying again.
      voice.setBotRoleAccess({ uneditableRoleIds: [] });
      await pass();
      expect(bits(held('r1', 'vip', OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
      actions.seedOverwrites('r1', [...actions.overwritesOf('r1'), roleOw('vip2', V, 0n)]);
      voice.setBotRoleAccess({ uneditableRoleIds: ['vip2'] });
      await pass();
      expect(lines()).toHaveLength(2);
    });
  });

  // -- where it runs in the sweep ---------------------------------------------------------

  describe('the order of the sweep', () => {
    /**
     * A hidden room is the one thing in the sweep that is a privacy fault when it is wrong, and
     * the rename passes after it have no per-room catch: a rename the bot cannot make throws
     * out of the sweep. The pass runs first so that cannot leave a hidden room visible.
     */
    it('repairs a hidden room even when a rename in the same sweep throws', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      // Made visible by hand, and the name is stale, so the sweep will try to rename it.
      actions.seedOverwrites('r1', [ow('alice', VC), roleOw(GUILD, V, 0n)]);
      await secondaries.updateState('r1', { ...(await row('r1')).state, name: 'stale name' });
      // Not a permission failure, which the sweep now contains per room: any other error still
      // ends it, and this pass has to have run by then.
      actions.renameChannel = () => Promise.reject(new Error('boom'));

      await expect(sweep()).rejects.toThrow('boom');

      expect(bits(everyone('r1'))).toEqual({ allow: 0n, deny: VC });
      expect(bits(held('r1', BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
    });

    /**
     * A hidden room is private whether or not the flag survived. The name used to be worked
     * out from `state.private` alone, so a stale whole-state write that dropped it left a
     * hidden room named as an open one until this pass repaired the flag, and the repair then
     * cost a rename. The render now reads the record, which a whole-state write cannot touch,
     * so the name was right all along and the repair changes nothing a member can see.
     */
    it('names a hidden room private before its lost `private` flag is repaired, and the repair costs no rename', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: '{{PRIVATE ?? L // U}} room' });
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      const { private: _private, ...rest } = (await row('r1')).state;
      // A stale whole-state write dropped the flag.
      await secondaries.updateState('r1', rest);
      await feature.rerenderSecondary(GUILD, 'r1');
      expect((await row('r1')).state.private).toBeUndefined();
      expect((await row('r1')).state.name).toMatch(/^L/);
      const renames = actions.ofType('rename').length;

      await sweep();

      expect((await row('r1')).state.private).toBe(true);
      expect((await row('r1')).state.name).toMatch(/^L/);
      expect(actions.ofType('rename')).toHaveLength(renames);
    });
  });

  // -- when it does not run --------------------------------------------------------------

  describe('when it must not act', () => {
    it('does nothing at all under a dry run', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const byGuild = vi.spyOn(lists, 'listByGuild');

      const drift = await sweep({ dryRun: true });

      expect(drift.dryRun).toBe(true);
      expect(byGuild).not.toHaveBeenCalled();
      expect(actions.actions).toEqual([]);
    });

    it('is off while room_access.disabled is on: no query, no read, no write', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      leverOn = true;
      const byGuild = vi.spyOn(lists, 'listByGuild');
      const read = vi.spyOn(actions, 'readOverwrites');

      await sweep();

      expect(byGuild).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('works again the moment the lever is lifted', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      leverOn = true;
      await sweep();
      leverOn = false;

      await sweep();

      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('takes nothing off a room when the saved lists cannot be read, which is not the same as empty', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await sweep();
      expect(held('r1', 'mallory')).toBeDefined();
      vi.spyOn(lists, 'listByGuild').mockRejectedValue(new Error('db blip'));

      await sweep();

      expect(bits(held('r1', 'mallory'))).toEqual({ allow: 0n, deny: VC });
      expect((await access('r1'))?.blocked).toEqual(['mallory']);
    });

    it('leaves a guild the gateway has not handed over alone', async () => {
      await room('r1');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      voice.setGuildAvailable(false);

      await sweep();

      expect(actions.actions).toEqual([]);
    });
  });
});
