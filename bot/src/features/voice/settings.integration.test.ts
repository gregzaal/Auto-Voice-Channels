import { AutoChannelRepository, GuildRepository, SecondaryChannelRepository, db } from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from './nameTemplate.js';
import { GuildSettingsService } from './settings.js';

const GUILD = 'guild-settings-test';

describe('GuildSettingsService (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let actions: RecordingVoiceActions;
  let settings: GuildSettingsService;

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
    await env.handle.db.delete(db.schema.guilds);
    actions = new RecordingVoiceActions();
    settings = new GuildSettingsService({
      guilds,
      autoChannels,
      secondaries,
      actions,
      logger: fakeLogger(),
    });
  });

  it('reports defaults for a fresh guild', async () => {
    const config = await settings.getConfig(GUILD);
    expect(config.enabled).toBe(true);
    expect(config.general).toBe('General');
    expect(config.defaultTemplate).toBe(DEFAULT_CHANNEL_NAME_TEMPLATE);
    expect(config.aliases).toEqual({});
    expect(config.primaries).toEqual([]);
  });

  it('toggles enabled, general word and default template', async () => {
    await settings.setEnabled(GUILD, false);
    await settings.setGeneral(GUILD, 'Hangout');
    await settings.setDefaultTemplate(GUILD, '@@creator@@’s room');

    const config = await settings.getConfig(GUILD);
    expect(config.enabled).toBe(false);
    expect(config.general).toBe('Hangout');
    expect(config.defaultTemplate).toBe('@@creator@@’s room');
  });

  it('adds aliases by game name', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    await settings.addAlias(GUILD, 'Dead by Daylight', 'DbD');
    expect((await settings.getConfig(GUILD)).aliases).toEqual({
      'Counter-Strike 2': 'CS2',
      'Dead by Daylight': 'DbD',
    });
  });

  it('creates a primary (real channel + registration) and lists it', async () => {
    const res = await settings.createPrimary(GUILD);
    expect(res.ok).toBe(true);
    const created = actions.ofType('create');
    expect(created).toHaveLength(1);

    const config = await settings.getConfig(GUILD);
    expect(config.primaries).toHaveLength(1);
    expect(config.primaries[0]!.channelId).toBe(created[0]!.channelId);
  });

  it('creates a primary with the /create modal options (category, templates, position)', async () => {
    const res = await settings.createPrimary(GUILD, {
      name: 'Game Lobby',
      parentId: 'cat-1',
      nameTemplate: '## [@@game_name@@]',
      statusTemplate: 'Status here',
      above: true,
    });
    expect(res.ok).toBe(true);
    const created = actions.ofType('create')[0]!;
    expect(created).toMatchObject({ name: 'Game Lobby', parentId: 'cat-1' });

    const primary = await autoChannels.get(created.channelId);
    expect(primary!.template).toMatchObject({
      name: '## [@@game_name@@]',
      status: 'Status here',
      above: true,
    });
  });

  it('sets and resets a custom nick', async () => {
    await settings.setNick(GUILD, 'user-1', 'Big G');
    expect((await guilds.get(GUILD))!.settings.custom_nicks).toEqual({ 'user-1': 'Big G' });
    await settings.setNick(GUILD, 'user-1', 'reset');
    expect((await guilds.get(GUILD))!.settings.custom_nicks).toEqual({});
  });

  it('sets and resets a primary template via the channel you’re in (/template)', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-t',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    const set = await settings.setTemplate(GUILD, 'sec-t', '## [@@game_name@@]');
    expect(set.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.name).toBe('## [@@game_name@@]');

    const reset = await settings.setTemplate(GUILD, 'sec-t', 'reset');
    expect(reset.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.name).toBeUndefined();

    // Must be in a managed channel.
    expect((await settings.setTemplate(GUILD, 'not-a-channel', 'x')).ok).toBe(false);
  });

  it('sets and resets a primary status template', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-st',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    const set = await settings.setStatusTemplate(GUILD, 'sec-st', 'In a meeting');
    expect(set.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.status).toBe('In a meeting');

    const reset = await settings.setStatusTemplate(GUILD, 'sec-st', 'reset');
    expect(reset.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.status).toBeUndefined();
  });

  it('lets a blank status template through as a deliberate "no status"', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-blank',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    await settings.setStatusTemplate(GUILD, 'sec-blank', 'In a meeting');
    const blank = await settings.setStatusTemplate(GUILD, 'sec-blank', '');
    expect(blank.ok).toBe(true);
    // Stored as an empty string (blank), NOT deleted/reset to the default.
    expect((await autoChannels.get(primaryId))!.template.status).toBe('');
  });

  it('sets primary position (above/below) and inherit-permissions via the channel you’re in', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-1',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    // Default is below: nothing stored, getPosition reports above=false.
    expect(await settings.getPosition(GUILD, 'sec-1')).toEqual({
      found: true,
      above: false,
      primaryChannelId: primaryId,
    });

    const up = await settings.setPosition(GUILD, 'sec-1', true);
    expect(up.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.above).toBe(true);
    expect((await settings.getPosition(GUILD, 'sec-1')).above).toBe(true);

    // Switching back to below clears the stored field (below is the default).
    const down = await settings.setPosition(GUILD, 'sec-1', false);
    expect(down.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.above).toBeUndefined();

    const inh = await settings.setInheritPermissions(GUILD, 'sec-1', 'category');
    expect(inh.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.inheritperms).toBe('category');

    expect((await settings.setInheritPermissions(GUILD, 'sec-1', 'bogus')).ok).toBe(false);
  });

  it('toggles default-private for the primary via the channel you’re in', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-1',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    // Default (public): nothing stored.
    expect((await autoChannels.get(primaryId))!.template.defaultPrivate).toBeUndefined();

    const on = await settings.toggleDefaultPrivate(GUILD, 'sec-1');
    expect(on.ok).toBe(true);
    expect(on.message).toContain('private');
    expect((await autoChannels.get(primaryId))!.template.defaultPrivate).toBe(true);

    // Toggling again clears the stored field (public is the default).
    const off = await settings.toggleDefaultPrivate(GUILD, 'sec-1');
    expect(off.ok).toBe(true);
    expect(off.message).toContain('public');
    expect((await autoChannels.get(primaryId))!.template.defaultPrivate).toBeUndefined();

    expect((await settings.toggleDefaultPrivate(GUILD, 'not-a-channel')).ok).toBe(false);
  });

  it('reads and writes per-category grouping config (/group)', async () => {
    expect(await settings.getGroup(GUILD, 'cat-1')).toBeUndefined();

    await settings.setGroup(GUILD, 'cat-1', true); // group above
    expect(await settings.getGroup(GUILD, 'cat-1')).toEqual({ above: true });

    // A second category is independent; the root sentinel is just another key.
    await settings.setGroup(GUILD, '@root', false);
    expect(await settings.getGroup(GUILD, '@root')).toEqual({ above: false });
    expect(await settings.getGroup(GUILD, 'cat-1')).toEqual({ above: true });

    // Disable (null) removes only that category's entry.
    await settings.setGroup(GUILD, 'cat-1', null);
    expect(await settings.getGroup(GUILD, 'cat-1')).toBeUndefined();
    expect(await settings.getGroup(GUILD, '@root')).toEqual({ above: false });
  });

  it('configures and disables logging', async () => {
    await settings.setLogging(GUILD, 'log-channel', 2);
    let s = (await guilds.get(GUILD))!.settings;
    expect(s.logging).toBe('log-channel');
    expect(s.log_level).toBe(2);

    await settings.setLogging(GUILD, null, 1);
    s = (await guilds.get(GUILD))!.settings;
    expect(s.logging).toBe(false);
  });
});
