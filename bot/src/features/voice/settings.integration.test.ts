import { AutoChannelRepository, GuildRepository, SecondaryChannelRepository, db } from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from './nameTemplate.js';
import { readContact } from './guildSettings.js';
import {
  GuildSettingsService,
  MAX_ALIASES,
  MAX_LISTS,
  MAX_LIST_OPTIONS,
  MAX_LIST_OPTION_LENGTH,
} from './settings.js';

const GUILD = 'guild-settings-test';

/** A fixed instant, so the time-zone confirmation is assertable. 21:30 in Amsterdam. */
const FRIDAY = new Date('2026-09-04T19:30:00Z');

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

  it('toggles enabled and the “no game” word', async () => {
    await settings.setEnabled(GUILD, false);
    await settings.setGeneral(GUILD, 'Hangout');

    const config = await settings.getConfig(GUILD);
    expect(config.enabled).toBe(false);
    expect(config.general).toBe('Hangout');
  });

  it('adds aliases by game name', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    await settings.addAlias(GUILD, 'Dead by Daylight', 'DbD');
    expect((await settings.getConfig(GUILD)).aliases).toEqual({
      'Counter-Strike 2': 'CS2',
      'Dead by Daylight': 'DbD',
    });
  });

  it('replaces the alias when the same game is added again', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    const res = await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('updated');
    expect(await settings.listAliases(GUILD)).toEqual({ 'Counter-Strike 2': 'CS' });
  });

  it('refuses to add past the cap, but still lets an existing one be replaced', async () => {
    for (let i = 0; i < MAX_ALIASES; i += 1) await settings.addAlias(GUILD, `Game ${i}`, `G${i}`);
    const full = await settings.addAlias(GUILD, 'One More', 'OM');
    expect(full.ok).toBe(false);
    expect(full.message).toContain(String(MAX_ALIASES));
    const replace = await settings.addAlias(GUILD, 'Game 0', 'ZERO');
    expect(replace.ok).toBe(true);
    expect(Object.keys(await settings.listAliases(GUILD))).toHaveLength(MAX_ALIASES);
  });

  it('removes an alias, and reports a removal of one that is already gone', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    await settings.addAlias(GUILD, 'Dead by Daylight', 'DbD');

    const res = await settings.removeAlias(GUILD, 'Counter-Strike 2');
    expect(res.ok).toBe(true);
    expect(await settings.listAliases(GUILD)).toEqual({ 'Dead by Daylight': 'DbD' });

    const again = await settings.removeAlias(GUILD, 'Counter-Strike 2');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('no longer there');
  });

  it('edits just the alias, leaving the game name alone', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    const res = await settings.replaceAlias(GUILD, 'Counter-Strike 2', 'Counter-Strike 2', 'CS');
    expect(res.ok).toBe(true);
    expect(await settings.listAliases(GUILD)).toEqual({ 'Counter-Strike 2': 'CS' });
  });

  it('renames the game name without leaving the old key behind', async () => {
    await settings.addAlias(GUILD, 'Countr-Strike 2', 'CS2');
    const res = await settings.replaceAlias(GUILD, 'Countr-Strike 2', 'Counter-Strike 2', 'CS2');
    expect(res.ok).toBe(true);
    // The whole point of the edit path: no orphan under the misspelling.
    expect(await settings.listAliases(GUILD)).toEqual({ 'Counter-Strike 2': 'CS2' });
  });

  it('says so when a rename overwrites an alias that already existed', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    await settings.addAlias(GUILD, 'Apex Legends', 'Apex');
    const res = await settings.replaceAlias(GUILD, 'Apex Legends', 'Counter-Strike 2', 'CS');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('replaced');
    expect(await settings.listAliases(GUILD)).toEqual({ 'Counter-Strike 2': 'CS' });
  });

  it('refuses to edit an alias that has been removed since the panel opened', async () => {
    const res = await settings.replaceAlias(GUILD, 'Counter-Strike 2', 'Counter-Strike 2', 'CS');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('no longer there');
    expect(await settings.listAliases(GUILD)).toEqual({});
  });

  it('treats an inherited property name as an ordinary game name', async () => {
    // `'constructor' in map` is true on any plain object, so a bare `in` check
    // would report an alias this guild does not have, and deleting it would
    // silently do nothing.
    const missing = await settings.removeAlias(GUILD, 'constructor');
    expect(missing.ok).toBe(false);

    await settings.addAlias(GUILD, 'constructor', 'Ctor');
    expect(await settings.listAliases(GUILD)).toEqual({ constructor: 'Ctor' });
    const removed = await settings.removeAlias(GUILD, 'constructor');
    expect(removed.ok).toBe(true);
    expect(await settings.listAliases(GUILD)).toEqual({});
  });

  it('loses no alias when concurrent writers touch the map at once', async () => {
    // The whole reason these go through mergeSettings rather than
    // updateSettings. The latter merges DB-side only at the TOP level, so
    // `aliases` is replaced wholesale and a read-then-write drops whatever
    // landed in between. The per-guild dispatcher does not cover this: it is
    // per instance, and the legacy importer writes this same key from outside
    // the fleet entirely.
    await settings.addAlias(GUILD, 'Seed', 'S');
    await Promise.all([
      settings.addAlias(GUILD, 'Apex Legends', 'Apex'),
      settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2'),
      settings.addAlias(GUILD, 'Dead by Daylight', 'DbD'),
      settings.addAlias(GUILD, 'Rocket League', 'RL'),
    ]);
    expect(await settings.listAliases(GUILD)).toEqual({
      Seed: 'S',
      'Apex Legends': 'Apex',
      'Counter-Strike 2': 'CS2',
      'Dead by Daylight': 'DbD',
      'Rocket League': 'RL',
    });
  });

  it('does not hand out the settings cache map by reference', async () => {
    await settings.addAlias(GUILD, 'Counter-Strike 2', 'CS2');
    const first = await settings.listAliases(GUILD);
    first['Injected'] = 'nope';
    expect(await settings.listAliases(GUILD)).toEqual({ 'Counter-Strike 2': 'CS2' });
  });

  it('sets a time zone, canonicalising what was typed', async () => {
    const res = await settings.setTimeZone(GUILD, ' europe/amsterdam ', FRIDAY);
    expect(res.ok).toBe(true);
    // The current local time is the confirmation: a real but wrong zone is easy
    // to type and impossible to spot from the name alone.
    expect(res.message).toContain('Europe/Amsterdam');
    expect(res.message).toContain('21:30');
    expect((await settings.getConfig(GUILD)).timezone).toBe('Europe/Amsterdam');
  });

  it('refuses a zone it does not recognise, and an offset, without writing', async () => {
    await settings.setTimeZone(GUILD, 'Europe/Amsterdam', FRIDAY);
    for (const bad of ['Amsterdam', '+02:00', 'Etc/GMT+2']) {
      const res = await settings.setTimeZone(GUILD, bad, FRIDAY);
      expect(res.ok, `${bad} should be refused`).toBe(false);
    }
    expect((await settings.getConfig(GUILD)).timezone).toBe('Europe/Amsterdam');
  });

  /**
   * The key is REMOVED rather than set to `UTC`. Both render the same, and only
   * the absent one lets `/setup` and the template editor say "not set", which is
   * the whole point of the setting.
   */
  it('clears the zone by removing the key, not by writing UTC', async () => {
    await settings.setTimeZone(GUILD, 'Europe/Amsterdam', FRIDAY);
    const res = await settings.setTimeZone(GUILD, '   ', FRIDAY);
    expect(res.ok).toBe(true);
    expect((await settings.getConfig(GUILD)).timezone).toBeUndefined();
    const row = await guilds.ensure(GUILD);
    expect(Object.keys(row.settings)).not.toContain('timezone');
  });

  it('adds, replaces and removes a named list', async () => {
    const added = await settings.setNamedList(GUILD, 'animals', ['otter', 'badger']);
    expect(added.ok).toBe(true);
    expect(added.message).toContain('[[list:animals]]');
    expect(await settings.listNamedLists(GUILD)).toEqual({ animals: ['otter', 'badger'] });

    const replaced = await settings.setNamedList(GUILD, 'animals', ['heron'], 'animals');
    expect(replaced.ok).toBe(true);
    expect(await settings.listNamedLists(GUILD)).toEqual({ animals: ['heron'] });

    const removed = await settings.removeNamedList(GUILD, 'animals');
    expect(removed.ok).toBe(true);
    expect(await settings.listNamedLists(GUILD)).toEqual({});
    expect((await settings.removeNamedList(GUILD, 'animals')).ok).toBe(false);
  });

  /** A rename is one write, so the old name can never be left behind by a failure. */
  it('renames a list without leaving the old name behind', async () => {
    await settings.setNamedList(GUILD, 'animals', ['otter']);
    const res = await settings.setNamedList(GUILD, 'beasts', ['otter'], 'animals');
    expect(res.ok).toBe(true);
    expect(await settings.listNamedLists(GUILD)).toEqual({ beasts: ['otter'] });
  });

  it('refuses a name no template could reach, and an empty list', async () => {
    for (const bad of ['a:b', 'a/b', 'x]]', ' spaced', '']) {
      const res = await settings.setNamedList(GUILD, bad, ['one']);
      expect(res.ok, `${bad} should be refused`).toBe(false);
    }
    expect((await settings.setNamedList(GUILD, 'animals', [])).ok).toBe(false);
    expect(await settings.listNamedLists(GUILD)).toEqual({});
  });

  it('refuses past the list cap, but still lets an existing list be replaced', async () => {
    for (let i = 0; i < MAX_LISTS; i++) {
      const res = await settings.setNamedList(GUILD, `list${i}`, ['one']);
      expect(res.ok, `list ${i} should be accepted`).toBe(true);
    }
    expect((await settings.setNamedList(GUILD, 'one-too-many', ['one'])).ok).toBe(false);
    // Replacing is not adding, so it stays available at the cap.
    expect((await settings.setNamedList(GUILD, 'list0', ['two'], 'list0')).ok).toBe(true);
    // And so is renaming, which leaves the count the same.
    expect((await settings.setNamedList(GUILD, 'renamed', ['two'], 'list0')).ok).toBe(true);
    expect(Object.keys(await settings.listNamedLists(GUILD))).toHaveLength(MAX_LISTS);
  });

  it('refuses too many options, and one that could never fit a name', async () => {
    const tooMany = Array.from({ length: MAX_LIST_OPTIONS + 1 }, (_, i) => `o${i}`);
    expect((await settings.setNamedList(GUILD, 'animals', tooMany)).ok).toBe(false);
    const tooLong = ['x'.repeat(MAX_LIST_OPTION_LENGTH + 1)];
    expect((await settings.setNamedList(GUILD, 'animals', tooLong)).ok).toBe(false);
    expect(await settings.listNamedLists(GUILD)).toEqual({});
  });

  it('treats an inherited property name as an ordinary list name', async () => {
    expect((await settings.setNamedList(GUILD, 'constructor', ['one'])).ok).toBe(true);
    expect(await settings.listNamedLists(GUILD)).toEqual({ constructor: ['one'] });
    // The cap counts it, which a prototype-walking `in` check would not.
    expect((await settings.removeNamedList(GUILD, 'toString')).ok).toBe(false);
    expect((await settings.removeNamedList(GUILD, 'constructor')).ok).toBe(true);
  });

  it('does not hand out the lists map by reference', async () => {
    await settings.setNamedList(GUILD, 'animals', ['otter']);
    const first = await settings.listNamedLists(GUILD);
    first['injected'] = ['nope'];
    first['animals']!.push('nope');
    expect(await settings.listNamedLists(GUILD)).toEqual({ animals: ['otter'] });
  });

  it('loses no list when concurrent writers touch the map at once', async () => {
    await settings.setNamedList(GUILD, 'seed', ['s']);
    await Promise.all([
      settings.setNamedList(GUILD, 'a', ['1']),
      settings.setNamedList(GUILD, 'b', ['2']),
      settings.setNamedList(GUILD, 'c', ['3']),
    ]);
    expect(await settings.listNamedLists(GUILD)).toEqual({
      seed: ['s'],
      a: ['1'],
      b: ['2'],
      c: ['3'],
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

  /**
   * The write half of the 2026-09-02 report. Fixing only `getEditorState` would
   * have shown the admin a working panel and then refused the save with "you
   * need to be in a bot-managed voice channel", for a creator channel AVC
   * plainly manages.
   */
  it('sets a primary template when aimed at the creator channel itself', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;

    // No secondary exists at all: this is the creator channel, targeted directly.
    const set = await settings.setTemplate(GUILD, primaryId, 'Direct [@@game_name@@]');
    expect(set.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.name).toBe('Direct [@@game_name@@]');

    const status = await settings.setStatusTemplate(GUILD, primaryId, 'Playing @@game_name@@');
    expect(status.ok).toBe(true);
    expect((await autoChannels.get(primaryId))!.template.status).toBe('Playing @@game_name@@');

    // A channel that is neither a primary nor a secondary is still refused.
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

  /**
   * `/defaultlimit`. The field was readable by the creation path long before
   * anything could write it (`handler.ts` passes `template.limit` into
   * createVoiceChannel), so these assert the writer, not the plumbing.
   */
  it('sets and clears the default user limit for the primary (/defaultlimit)', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-dl',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    // Unset by default, which is what makes every spawned channel unlimited.
    expect((await autoChannels.get(primaryId))!.template.limit).toBeUndefined();

    const set = await settings.setDefaultLimit(GUILD, 'sec-dl', 5);
    expect(set.ok).toBe(true);
    expect(set.message).toContain('5');
    expect((await autoChannels.get(primaryId))!.template.limit).toBe(5);

    // 0 clears the field rather than storing a zero, matching Discord's own
    // meaning for a user limit and keeping imported configs tidy.
    const cleared = await settings.setDefaultLimit(GUILD, 'sec-dl', 0);
    expect(cleared.ok).toBe(true);
    expect(cleared.message).toContain('no user limit');
    expect((await autoChannels.get(primaryId))!.template.limit).toBeUndefined();

    // Setting it must not disturb the rest of the template.
    await settings.toggleDefaultPrivate(GUILD, 'sec-dl');
    await settings.setDefaultLimit(GUILD, 'sec-dl', 9);
    const template = (await autoChannels.get(primaryId))!.template;
    expect(template.limit).toBe(9);
    expect(template.defaultPrivate).toBe(true);
  });

  it('refuses a default limit Discord would not accept (/defaultlimit)', async () => {
    await settings.createPrimary(GUILD);
    const primaryId = actions.ofType('create')[0]!.channelId;
    await secondaries.create({
      channelId: 'sec-dl2',
      guildId: GUILD,
      primaryChannelId: primaryId,
      state: {},
    });

    for (const bad of [-1, 100, 1.5]) {
      const res = await settings.setDefaultLimit(GUILD, 'sec-dl2', bad);
      expect(res.ok).toBe(false);
    }
    expect((await autoChannels.get(primaryId))!.template.limit).toBeUndefined();

    // And it still needs a managed channel to act on.
    expect((await settings.setDefaultLimit(GUILD, 'not-a-channel', 5)).ok).toBe(false);
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

  describe('recordContact', () => {
    const ADMIN = '291185187105275904';
    const OTHER = '224358985464152064';

    it('stores the contact so readContact can find it', async () => {
      await settings.recordContact(GUILD, ADMIN);
      const guild = await guilds.ensure(GUILD);
      expect(readContact(guild.settings)).toBe(ADMIN);
    });

    it('overwrites with whoever set up most recently', async () => {
      await settings.recordContact(GUILD, ADMIN);
      await settings.recordContact(GUILD, OTHER);
      const guild = await guilds.ensure(GUILD);
      expect(readContact(guild.settings)).toBe(OTHER);
    });

    /**
     * The early return is what stops a repeated admin action bumping
     * `updated_at` and firing a settings-cache NOTIFY across the whole fleet.
     */
    it('does not write again when the contact is unchanged', async () => {
      await settings.recordContact(GUILD, ADMIN);
      const before = (await guilds.ensure(GUILD)).updatedAt;
      await new Promise((r) => setTimeout(r, 25));
      await settings.recordContact(GUILD, ADMIN);
      expect((await guilds.ensure(GUILD)).updatedAt).toEqual(before);
    });

    it('refuses a value that is not a snowflake, rather than storing junk', async () => {
      await settings.recordContact(GUILD, 'not-an-id');
      await settings.recordContact(GUILD, '123');
      const guild = await guilds.ensure(GUILD);
      expect(readContact(guild.settings)).toBeNull();
    });

    /** Bookkeeping on an already-succeeded action must never throw upward. */
    it('swallows a store failure instead of failing the caller', async () => {
      const broken = new GuildSettingsService({
        guilds: {
          ensure: () => Promise.reject(new Error('db down')),
        } as unknown as typeof guilds,
        autoChannels,
        secondaries,
        actions,
        logger: fakeLogger(),
      });
      await expect(broken.recordContact(GUILD, ADMIN)).resolves.toBeUndefined();
    });

    it('leaves the rest of the settings blob alone', async () => {
      await settings.setGeneral(GUILD, 'lobby');
      await settings.recordContact(GUILD, ADMIN);
      const guildAfter = await guilds.ensure(GUILD);
      expect(guildAfter.settings.general).toBe('lobby');
      expect(readContact(guildAfter.settings)).toBe(ADMIN);
    });
  });
});
