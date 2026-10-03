import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  MemberAccessListRepository,
  SecondaryChannelRepository,
  db,
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
    privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
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

    it('is not carried through while the lever is on, and is when it is lifted', async () => {
      await room('r1');
      await privacy.hide(GUILD, 'r1', 'alice');
      actions.simulateOverwriteRateLimit = true;
      await privacy.unhide(GUILD, 'r1', 'alice');
      actions.simulateOverwriteRateLimit = false;
      leverOn = true;

      await sweep();
      expect((await access('r1'))?.pending?.mode).toBe('locked');

      leverOn = false;
      await sweep();
      expect((await access('r1'))?.pending).toBeUndefined();
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

    it('is told to the guild once, and not again by every sweep', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rA', apiError(50013));
      const recorded = vi.fn();
      problems.onRecord = recorded;

      await sweep();
      await sweep();
      await sweep();

      // Tried every time, which is what lets it recover when the permission comes back,
      // but one incident and one line in the log channel.
      expect(read).toHaveBeenCalledTimes(3);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(serverLogs).toHaveLength(1);
    });

    it('recovers when the permission comes back, and the incident clears with it', async () => {
      await room('rA', 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const read = failFor('rA', apiError(50013));
      await sweep();
      expect(problems.recent(GUILD)).toHaveLength(1);

      read.mockRestore();
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
