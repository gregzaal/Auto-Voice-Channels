import {
  AutoChannelRepository,
  CompanionChannelRepository,
  GuildRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { DiscordAPIError } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { CompanionTextService } from './companionText.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-companion-test';
const PRIMARY = 'primary-1';
const ROOM = 'room-1';

/**
 * The companion text channel feature, against a real database.
 *
 * Integration rather than unit because the two things most likely to be wrong
 * are SQL: the fleet guards, and `listOrphans`, whose whole purpose is reaching
 * rows no per-guild pass can see.
 */
describe('CompanionTextService (integration)', () => {
  let env: PgTestEnv;
  let companions: CompanionChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let autoChannels: AutoChannelRepository;
  let guilds: GuildRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let problems: PermissionProblemTracker;
  let service: CompanionTextService;

  beforeAll(async () => {
    env = await startPostgres();
    companions = new CompanionChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    guilds = new GuildRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.companionChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.autoChannels);
    await env.handle.db.delete(db.schema.guilds);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    problems = new PermissionProblemTracker();
    service = new CompanionTextService({
      companions,
      secondaries,
      autoChannels,
      guilds,
      actions,
      voice,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    await guilds.ensure(GUILD);
  });

  /** A creator channel, opted in or not, plus a room spawned from it. */
  async function setupRoom(optIn: boolean, occupants: string[] = ['u1']): Promise<void> {
    await autoChannels.upsert(GUILD, PRIMARY, optIn ? { textChannel: true } : {});
    await secondaries.create({
      channelId: ROOM,
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: occupants[0] ?? null,
      state: {},
    });
    voice.ensureChannel(ROOM);
    for (const id of occupants) voice.put(ROOM, member(id));
  }

  const created = (): string[] =>
    actions.actions.filter((a) => a.type === 'companionCreate').map((a) => a.channelId);

  it('creates a companion for an opted-in creator channel, with the room occupants on it', async () => {
    await setupRoom(true);
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(channelId).not.toBeNull();
    expect(created()).toHaveLength(1);
    const create = actions.actions.find((a) => a.type === 'companionCreate');
    expect(create).toMatchObject({ secondaryChannelId: ROOM, name: 'voice context' });
    expect(await companions.getBySecondary(ROOM)).toMatchObject({ channelId, guildId: GUILD });
  });

  it('does nothing at all for a creator channel that did not opt in', async () => {
    await setupRoom(false);
    expect(await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1'])).toBeNull();
    expect(created()).toHaveLength(0);
    expect(await companions.getBySecondary(ROOM)).toBeUndefined();
  });

  it('is idempotent: a replayed create returns the existing companion and makes no second one', async () => {
    await setupRoom(true);
    const first = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);
    const second = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(second).toBe(first);
    expect(created()).toHaveLength(1);
  });

  it('uses the guild name and moderator role when they are set', async () => {
    await setupRoom(true);
    await guilds.updateSettings(GUILD, {
      text_channel_name: 'war room',
      text_channel_role: '555000111222333444',
    });
    await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(actions.actions.find((a) => a.type === 'companionCreate')).toMatchObject({
      name: 'war room',
    });
  });

  /**
   * The defect legacy never fixed: its role sync only ever ADDED, so a member
   * who left while the bot was down kept read access for the life of the room.
   */
  it('converges viewers on the LIVE roster, adding joiners and removing leavers', async () => {
    await setupRoom(true, ['u1']);
    await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    voice.put(ROOM, member('u2'));
    await service.syncRoom(GUILD, ROOM);
    voice.drop(ROOM, 'u1');
    await service.syncRoom(GUILD, ROOM);

    const syncs = actions.actions.filter((a) => a.type === 'companionSync');
    expect(syncs).toHaveLength(2);
    expect(syncs[0]!.memberIds).toEqual(['u1', 'u2']);
    expect(syncs[1]!.memberIds).toEqual(['u2']);
  });

  it('ignores bots when deciding who may read', async () => {
    await setupRoom(true, ['u1']);
    await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);
    voice.put(ROOM, { ...member('bot-1'), bot: true });

    await service.syncRoom(GUILD, ROOM);

    expect(actions.actions.find((a) => a.type === 'companionSync')!.memberIds).toEqual(['u1']);
  });

  it('drops the row when Discord reports the companion is gone', async () => {
    await setupRoom(true);
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);
    actions.companionGoneForChannel = channelId!;

    await service.syncRoom(GUILD, ROOM);

    expect(await companions.getBySecondary(ROOM)).toBeUndefined();
  });

  it('deletes the channel and the row when the room goes away', async () => {
    await setupRoom(true);
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    await service.removeForRoom(GUILD, ROOM);

    expect(actions.actions).toContainEqual({
      type: 'companionDelete',
      guildId: GUILD,
      channelId,
    });
    expect(await companions.getBySecondary(ROOM)).toBeUndefined();
  });

  /**
   * A failed delete is only permanent when Discord says so.
   *
   * The row is the only index this feature has, so dropping it on a transient
   * failure (a 500, an exhausted rate limit, a dropped socket) is not untidy,
   * it is unrecoverable: the orphan sweep can never see that channel again and
   * `/diagnostics` will never count it. A 403 or a 404 is different, and
   * keeping the row there would retry the impossible on every pass.
   */
  describe('when the delete fails', () => {
    const serviceWith = (err: Error): CompanionTextService =>
      new CompanionTextService({
        companions,
        secondaries,
        autoChannels,
        guilds,
        actions: {
          ...actions,
          deleteCompanionChannel: () => Promise.reject(err),
        } as unknown as RecordingVoiceActions,
        voice,
        logger: fakeLogger(),
      });

    it('keeps the row on a transient failure, so the sweep can still reclaim it', async () => {
      await setupRoom(true);
      await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

      await serviceWith(new Error('socket hang up')).removeForRoom(GUILD, ROOM);

      expect(await companions.getBySecondary(ROOM)).toBeDefined();
    });

    it('drops the row when Discord says the channel is gone or unreachable', async () => {
      await setupRoom(true);
      await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);
      const forbidden = new DiscordAPIError(
        { code: 50013, message: 'Missing Permissions' } as never,
        50013,
        403,
        'DELETE',
        'https://discord.test',
        {} as never,
      );

      await serviceWith(forbidden).removeForRoom(GUILD, ROOM);

      expect(await companions.getBySecondary(ROOM)).toBeUndefined();
    });
  });

  /**
   * The unique index makes the create idempotent by construction rather than by
   * the dispatcher's scheduling. The loser has already made a channel nothing
   * knows about, so it must delete that channel before returning.
   */
  it('discards the duplicate when another pass recorded one first', async () => {
    await setupRoom(true);
    await companions.create({
      channelId: 'someone-elses-text',
      guildId: GUILD,
      secondaryChannelId: ROOM,
    });
    /**
     * The row has to appear AFTER this pass looked and BEFORE it inserts, which
     * is the whole window the unique index exists to close. The opening check
     * is stubbed blind for exactly that one call; everything after it is real,
     * so the conflict is a genuine constraint violation rather than a fake.
     */
    const racing = new CompanionTextService({
      companions: {
        ...companions,
        getBySecondary: (id: string) =>
          companions.getBySecondary(id).then((row) => (blind ? ((blind = false), undefined) : row)),
        create: companions.create.bind(companions),
      } as never,
      secondaries,
      autoChannels,
      guilds,
      actions,
      voice,
      logger: fakeLogger(),
    });
    let blind = true;

    const result = await racing.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(result).toBe('someone-elses-text');
    // The channel it made on the way is deleted rather than leaked.
    const madeId = actions.actions.find((a) => a.type === 'companionCreate')!.channelId;
    expect(actions.actions).toContainEqual({
      type: 'companionDelete',
      guildId: GUILD,
      channelId: madeId,
    });
  });

  /**
   * The row is the only index, so a failure to persist AFTER the Discord create
   * leaks the channel permanently unless the create path cleans up after itself.
   */
  it('deletes the channel it just made when the row cannot be written', async () => {
    await setupRoom(true);
    const broken = new CompanionTextService({
      companions: {
        getBySecondary: () => Promise.resolve(undefined),
        create: () => Promise.reject(new Error('db down')),
      } as never,
      secondaries,
      autoChannels,
      guilds,
      actions,
      voice,
      logger: fakeLogger(),
    });

    expect(await broken.createForRoom(GUILD, ROOM, PRIMARY, ['u1'])).toBeNull();

    const madeId = actions.actions.find((a) => a.type === 'companionCreate')!.channelId;
    expect(actions.actions).toContainEqual({
      type: 'companionDelete',
      guildId: GUILD,
      channelId: madeId,
    });
  });

  /** The same permanent-versus-transient rule the room teardown follows. */
  it('keeps an orphan row when its delete fails transiently', async () => {
    await companions.create({
      channelId: 'orphan-text',
      guildId: GUILD,
      secondaryChannelId: 'room-that-died',
    });
    const flaky = new CompanionTextService({
      companions,
      secondaries,
      autoChannels,
      guilds,
      actions: {
        ...actions,
        deleteCompanionChannel: () => Promise.reject(new Error('socket hang up')),
      } as unknown as RecordingVoiceActions,
      voice,
      logger: fakeLogger(),
    });

    expect(await flaky.sweepOrphans()).toEqual({ removed: 0 });
    expect(await companions.get('orphan-text')).toBeDefined();

    // The ordinary sweep then clears it.
    expect(await service.sweepOrphans()).toEqual({ removed: 1 });
    expect(await companions.get('orphan-text')).toBeUndefined();
  });

  it('records the moderator role it granted, so the next pass can revoke it', async () => {
    await setupRoom(true);
    await guilds.updateSettings(GUILD, { text_channel_role: '555000111222333444' });
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(await companions.get(channelId!)).toMatchObject({
      viewerRoleId: '555000111222333444',
    });

    // Clearing the setting hands the old role to the adapter as the one to revoke.
    await guilds.updateSettings(GUILD, { text_channel_role: null });
    await service.syncRoom(GUILD, ROOM);
    const sync = actions.actions.filter((a) => a.type === 'companionSync').at(-1)!;
    expect(sync).toMatchObject({ roleId: null });
    expect(await companions.get(channelId!)).toMatchObject({ viewerRoleId: null });
  });

  it('does not record a moderator role the guild no longer has', async () => {
    // Production, 2026-09-18: a legacy `stct` value restored onto a guild that
    // had deleted the role years earlier. Discord accepts the create and drops
    // the unknown overwrite silently, so recording the configured id claimed a
    // grant that never happened.
    await setupRoom(true);
    await guilds.updateSettings(GUILD, { text_channel_role: '555000111222333444' });
    actions.missingCompanionRole = true;

    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);
    expect(channelId).toBeTruthy();
    expect(await companions.get(channelId!)).toMatchObject({ viewerRoleId: null });
  });

  it('reports a deleted moderator role instead of retrying it forever', async () => {
    // The old behaviour was a PUT answering 10009 Unknown Overwrite on every
    // five-minute sweep, for as long as the setting stayed wrong, visible only
    // in the logs. It has to reach the admin, because only they can fix it.
    await setupRoom(true);
    await guilds.updateSettings(GUILD, { text_channel_role: '555000111222333444' });
    actions.missingCompanionRole = true;
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(problems.recent(GUILD)).toContainEqual(
      expect.objectContaining({ channelId: PRIMARY, operation: 'companion_role' }),
    );

    // And the sync keeps reporting it rather than quietly giving up, without
    // ever writing the role it could not grant.
    problems.clear(GUILD, PRIMARY, ['companion_role']);
    await service.syncRoom(GUILD, ROOM);
    expect(problems.recent(GUILD)).toContainEqual(
      expect.objectContaining({ channelId: PRIMARY, operation: 'companion_role' }),
    );
    expect(await companions.get(channelId!)).toMatchObject({ viewerRoleId: null });
  });

  it('still grants a moderator role the guild does have', async () => {
    // The guard above must not cost the feature its normal case.
    await setupRoom(true);
    await guilds.updateSettings(GUILD, { text_channel_role: '555000111222333444' });
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(await companions.get(channelId!)).toMatchObject({
      viewerRoleId: '555000111222333444',
    });
    expect(problems.recent(GUILD)).toEqual([]);
  });

  it('recognises its own channel being deleted by hand, and only its own', async () => {
    await setupRoom(true);
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(await service.handleChannelDeleted(GUILD, 'some-other-channel')).toBe(false);
    // Another guild's id must not match our row either.
    expect(await service.handleChannelDeleted('other-guild', channelId!)).toBe(false);
    expect(await service.handleChannelDeleted(GUILD, channelId!)).toBe(true);
    expect(await companions.get(channelId!)).toBeUndefined();
  });

  it('reports the companion and the moderator role for /channelinfo', async () => {
    await setupRoom(true);
    await guilds.updateSettings(GUILD, { text_channel_role: '555000111222333444' });
    const channelId = await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    expect(await service.describeRoom(GUILD, ROOM)).toEqual({
      channelId,
      roleId: '555000111222333444',
    });
    expect(await service.describeRoom(GUILD, 'not-a-room')).toBeNull();
  });

  it('records a permission problem when it cannot create one, and leaves the room alone', async () => {
    await setupRoom(true);
    actions.failCompanionCreate = true;

    expect(await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1'])).toBeNull();

    // `companion`, not `companion_role`: this one really could not create the
    // channel, which is what that copy describes.
    expect(problems.recent(GUILD)).toContainEqual(
      expect.objectContaining({ channelId: PRIMARY, operation: 'companion' }),
    );
    expect(await secondaries.get(ROOM)).toBeDefined();
  });

  describe('reconcileGuild', () => {
    it('creates the one a room is missing, syncs the one that exists, removes the orphan', async () => {
      await setupRoom(true);
      // An orphan: a companion whose room row is gone.
      await companions.create({
        channelId: 'orphan-text',
        guildId: GUILD,
        secondaryChannelId: 'room-that-died',
      });

      const first = await service.reconcileGuild(GUILD, { allowCreate: true });
      expect(first).toMatchObject({ created: 1, removed: 1 });
      expect(await companions.get('orphan-text')).toBeUndefined();

      const second = await service.reconcileGuild(GUILD, { allowCreate: true });
      expect(second).toMatchObject({ created: 0, synced: 1, removed: 0 });
    });

    it('still syncs and removes when creation is disabled by the lever', async () => {
      await setupRoom(true);
      const result = await service.reconcileGuild(GUILD, { allowCreate: false });

      expect(result.created).toBe(0);
      expect(created()).toHaveLength(0);
    });

    it('reports without acting on a dry run', async () => {
      await setupRoom(true);
      const result = await service.reconcileGuild(GUILD, { allowCreate: true, dryRun: true });

      expect(result.created).toBe(1);
      expect(created()).toHaveLength(0);
      expect(await companions.getBySecondary(ROOM)).toBeUndefined();
    });
  });

  /**
   * The case no guild-scoped pass can reach: the bot has been removed from the
   * guild, so `guildAvailable` is false forever and `ownsGuild` filters it out.
   * The predicate is SQL over two tables and needs neither.
   */
  it('sweeps orphans for a guild it can no longer see', async () => {
    await companions.create({
      channelId: 'left-guild-text',
      guildId: 'a-guild-we-left',
      secondaryChannelId: 'a-room-long-gone',
    });
    await setupRoom(true);
    await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);

    const { removed } = await service.sweepOrphans();

    expect(removed).toBe(1);
    expect(await companions.get('left-guild-text')).toBeUndefined();
    // The live one is untouched.
    expect(await companions.getBySecondary(ROOM)).toBeDefined();
  });

  it('counts what it tracks and what has been orphaned', async () => {
    await setupRoom(true);
    await service.createForRoom(GUILD, ROOM, PRIMARY, ['u1']);
    await companions.create({
      channelId: 'orphan-text',
      guildId: GUILD,
      secondaryChannelId: 'room-that-died',
    });

    expect(await companions.counts()).toEqual({ tracked: 2, orphaned: 1 });
  });

  /**
   * Two fleets can serve one guild, and `channel_id` is globally unique, so an
   * unscoped read would hand one fleet the other's row and let it delete a
   * channel it does not own.
   */
  it('never reads or removes another fleet’s row', async () => {
    const beta = new CompanionChannelRepository(env.handle.db, 'beta');
    await beta.create({ channelId: 'beta-text', guildId: GUILD, secondaryChannelId: ROOM });

    expect(await companions.get('beta-text')).toBeUndefined();
    expect(await companions.getBySecondary(ROOM)).toBeUndefined();
    await companions.remove('beta-text');
    expect(await beta.get('beta-text')).toBeDefined();
  });
});
