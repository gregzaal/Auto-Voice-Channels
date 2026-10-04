import {
  AutoChannelRepository,
  GuildRepository,
  MemberRoomPrefsRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  MAX_LIST_TOTAL_LENGTH,
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
    await env.handle.db.delete(db.schema.memberRoomPrefs);
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

  /**
   * A stored list has to be editable by the surface that stores it. The edit
   * modal prefills a 4000-character input, so a longer list would come back
   * from an untouched Save with its tail silently gone.
   */
  it('refuses a list too long for the modal that edits it to round-trip', async () => {
    const fits = Array.from({ length: 50 }, () => 'x'.repeat(79));
    expect((await settings.setNamedList(GUILD, 'ok', fits)).ok).toBe(true);
    const tooBig = Array.from({ length: 50 }, () => 'x'.repeat(80));
    const res = await settings.setNamedList(GUILD, 'big', tooBig);
    expect(res.ok).toBe(false);
    expect(res.message).toContain(String(MAX_LIST_TOTAL_LENGTH));
    expect(Object.keys(await settings.listNamedLists(GUILD))).toEqual(['ok']);
  });

  /**
   * The cap is skipped for a rename because a rename leaves the count alone,
   * which is only true if the old name is still there. A panel opened before
   * someone else removed that list would otherwise push the guild past the cap.
   */
  it('does not let a rename of a vanished list slip past the cap', async () => {
    for (let i = 0; i < MAX_LISTS; i++) {
      await settings.setNamedList(GUILD, `list${i}`, ['one']);
    }
    const res = await settings.setNamedList(GUILD, 'ghost', ['one'], 'already-removed');
    expect(res.ok).toBe(false);
    expect(Object.keys(await settings.listNamedLists(GUILD))).toHaveLength(MAX_LISTS);
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

  it.each([
    ['public', {}, {}],
    ['private', { defaultPrivate: true }, { defaultPrivate: true }],
    [
      'hidden',
      { defaultPrivate: true, defaultHidden: true },
      { defaultPrivate: true, defaultHidden: true },
    ],
    // Hidden is a kind of private, so it is never stored alone, where it would read as public.
    ['hidden without private', { defaultHidden: true }, {}],
  ])('creates a primary that starts rooms %s', async (_name, options, stored) => {
    await settings.createPrimary(GUILD, options);
    const created = actions.ofType('create')[0]!;
    expect((await autoChannels.get(created.channelId))!.template).toEqual(stored);
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
   * `/alwaysprivate` and `/alwayshidden` toggle one stored mode between them, and each
   * toggles its OWN: already in that mode goes to public, anywhere else goes to it.
   */
  describe('how new rooms start (/alwaysprivate and /alwayshidden)', () => {
    type Mode = 'public' | 'locked' | 'hidden';
    const STORED: Record<Mode, Record<string, unknown>> = {
      public: {},
      locked: { defaultPrivate: true },
      hidden: { defaultPrivate: true, defaultHidden: true },
    };
    const WORDS: Record<Mode, string> = {
      public: '**public**',
      locked: '**private**',
      hidden: '**hidden**',
    };

    /** A creator channel with a template, and the room the command is run from. */
    async function creatorWith(template: Record<string, unknown>): Promise<string> {
      const primaryId = 'creator-mode';
      await autoChannels.upsert(GUILD, primaryId, template);
      await secondaries.create({
        channelId: 'sec-mode',
        guildId: GUILD,
        primaryChannelId: primaryId,
        state: {},
      });
      return primaryId;
    }

    /**
     * A service whose creator channel read runs a hook once the row has been read and before
     * it is returned: the window a concurrent edit has to land in.
     */
    function racingService() {
      const racy = new (class extends AutoChannelRepository {
        after: (() => Promise<unknown>) | undefined;
        override async get(channelId: string) {
          const row = await super.get(channelId);
          const hook = this.after;
          this.after = undefined;
          await hook?.();
          return row;
        }
      })(env.handle.db);
      const racing = new GuildSettingsService({
        guilds,
        autoChannels: racy,
        secondaries,
        actions,
        logger: fakeLogger(),
      });
      return { racing, racy };
    }

    const press = (command: 'private' | 'hidden') =>
      command === 'private'
        ? settings.toggleDefaultPrivate(GUILD, 'sec-mode')
        : settings.toggleDefaultHidden(GUILD, 'sec-mode');

    const matrix: [Mode, 'private' | 'hidden', Mode][] = [
      ['public', 'private', 'locked'],
      ['public', 'hidden', 'hidden'],
      ['locked', 'private', 'public'],
      ['locked', 'hidden', 'hidden'],
      ['hidden', 'private', 'locked'],
      ['hidden', 'hidden', 'public'],
    ];

    it.each(matrix)('from %s, /always%s leaves it %s', async (start, command, after) => {
      const primaryId = await creatorWith({ name: 'Room ##', ...STORED[start] });

      const res = await press(command);

      expect(res.ok).toBe(true);
      // Each reply states the mode it ended in, in plain words.
      expect(res.message).toContain(WORDS[after]);
      // And the stored pair is exactly that mode, with nothing else disturbed.
      expect((await autoChannels.get(primaryId))!.template).toEqual({
        name: 'Room ##',
        ...STORED[after],
      });
    });

    it('says what a switch replaced when it was the other kind of privacy', async () => {
      await creatorWith({ ...STORED.hidden });
      expect((await press('private')).message).toContain('instead of hidden');
      expect((await press('hidden')).message).toContain('instead of private');
    });

    /**
     * `defaultHidden` beside no `defaultPrivate` is public (an older instance's toggle can
     * leave exactly that), so `/alwaysprivate` has to make the room private and NOT hidden,
     * which means the leftover key has to go.
     */
    it('treats a leftover defaultHidden as public, and never revives it', async () => {
      const primaryId = await creatorWith({ defaultHidden: true });
      const res = await press('private');
      expect(res.message).toContain('**private**');
      expect((await autoChannels.get(primaryId))!.template).toEqual({ defaultPrivate: true });
    });

    it('refuses outside a managed channel, for both commands', async () => {
      expect((await settings.toggleDefaultPrivate(GUILD, 'not-a-channel')).ok).toBe(false);
      expect((await settings.toggleDefaultHidden(GUILD, 'not-a-channel')).ok).toBe(false);
    });

    /**
     * The defect the DB-side merge fixes. The toggle reads the template, decides, and
     * writes, and a `/template` or `/defaultlimit` edit that lands between the read and
     * the write was thrown away when the write replaced the whole template from the
     * stale read. The edit here lands exactly there.
     */
    it.each(['private', 'hidden'] as const)(
      'keeps a template edit made while /always%s was deciding',
      async (command) => {
        const { racing, racy } = racingService();
        const primaryId = await creatorWith({ name: 'Old name', limit: 2 });
        racy.after = () => autoChannels.upsert(GUILD, primaryId, { name: 'Edited name', limit: 7 });

        const res =
          command === 'private'
            ? await racing.toggleDefaultPrivate(GUILD, 'sec-mode')
            : await racing.toggleDefaultHidden(GUILD, 'sec-mode');

        expect(res.ok).toBe(true);
        expect((await autoChannels.get(primaryId))!.template).toMatchObject({
          name: 'Edited name',
          limit: 7,
          defaultPrivate: true,
        });
      },
    );

    it('answers a refusal, not a mode, when the creator channel was removed while it decided', async () => {
      const { racing, racy } = racingService();
      const primaryId = await creatorWith({});
      racy.after = () => autoChannels.remove(GUILD, primaryId);

      const res = await racing.toggleDefaultHidden(GUILD, 'sec-mode');

      expect(res.ok).toBe(false);
      expect(res.message).not.toContain('hidden');
    });
  });

  /**
   * The creator channel editor's switch for remembered room settings, and its "Clear saved
   * settings". The service resolves the creator channel from a room or from the creator channel
   * itself, as every other `/template` write does, and the switch is a DB-side merge.
   */
  describe('remembered room settings (the editor switch and clear)', () => {
    const PRIMARY = 'creator-remember';
    const OTHER_GUILD = 'guild-settings-other';

    function serviceWith(prefs: MemberRoomPrefsRepository | undefined) {
      return new GuildSettingsService({
        guilds,
        autoChannels,
        secondaries,
        actions,
        logger: fakeLogger(),
        ...(prefs ? { memberPrefs: prefs } : {}),
      });
    }

    /** A creator channel, and one room it made, so both ways of naming it can be tried. */
    async function creatorWith(template: Record<string, unknown> = { name: 'Room ##' }) {
      await autoChannels.upsert(GUILD, PRIMARY, template);
      await secondaries.create({
        channelId: 'sec-remember',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        state: {},
      });
    }

    const stored = async () => (await autoChannels.get(PRIMARY))!.template;

    it('turns it on and off from the creator channel or from one of its rooms', async () => {
      const prefs = new MemberRoomPrefsRepository(env.handle.db);
      const service = serviceWith(prefs);
      await creatorWith();

      expect((await service.setRememberPrefs(GUILD, PRIMARY, true)).ok).toBe(true);
      expect(await stored()).toEqual({ name: 'Room ##', rememberPrefs: true });

      expect((await service.setRememberPrefs(GUILD, 'sec-remember', false)).ok).toBe(true);
      expect(await stored()).toEqual({ name: 'Room ##' });
    });

    /**
     * What an admin reads when they turn it on: what it does. The storage sentence was cut as
     * redundant on 2026-10-04 (the first sentence says what is kept, and Privacy covers it).
     */
    it('says what turning it on and off does', async () => {
      const service = serviceWith(undefined);
      await creatorWith();

      const on = await service.setRememberPrefs(GUILD, PRIMARY, true);
      expect(on.message).toContain('**Remember user settings** is on');
      expect(on.message).toContain('name, size and privacy');
      expect(on.message).toContain("instead of this creator channel's defaults");
      expect(on.message).toContain('only remembered when the member set one themselves');

      const off = await service.setRememberPrefs(GUILD, PRIMARY, false);
      expect(off.message).toContain('kept and not used');
    });

    it('is idempotent: a repeat, a retry and a click on a stale panel end where the click asked', async () => {
      const service = serviceWith(undefined);
      await creatorWith();
      for (let i = 0; i < 3; i++) await service.setRememberPrefs(GUILD, PRIMARY, true);
      expect(await stored()).toEqual({ name: 'Room ##', rememberPrefs: true });
      for (let i = 0; i < 3; i++) await service.setRememberPrefs(GUILD, PRIMARY, false);
      expect(await stored()).toEqual({ name: 'Room ##' });
    });

    it('leaves a /template edit and every other field alone', async () => {
      const service = serviceWith(undefined);
      await creatorWith({ name: 'Room ##', limit: 4, defaultPrivate: true, textChannel: true });
      await service.setRememberPrefs(GUILD, PRIMARY, true);
      expect(await stored()).toEqual({
        name: 'Room ##',
        limit: 4,
        defaultPrivate: true,
        textChannel: true,
        rememberPrefs: true,
      });
    });

    it('refuses a channel that is neither a creator channel nor one of its rooms', async () => {
      const service = serviceWith(undefined);
      await creatorWith();
      expect((await service.setRememberPrefs(GUILD, 'not-a-channel', true)).ok).toBe(false);
      expect((await service.clearRememberedPrefs(GUILD, 'not-a-channel')).ok).toBe(false);
    });

    /** Another server's admin naming this channel changes nothing here. */
    it('is bound to the server, so naming another server channel changes and clears nothing', async () => {
      const prefs = new MemberRoomPrefsRepository(env.handle.db);
      const service = serviceWith(prefs);
      await creatorWith({ name: 'Room ##', rememberPrefs: true });
      await prefs.saveName(GUILD, PRIMARY, 'u1', 'den');

      expect((await service.setRememberPrefs(OTHER_GUILD, PRIMARY, false)).ok).toBe(false);
      expect((await service.clearRememberedPrefs(OTHER_GUILD, PRIMARY)).ok).toBe(false);
      expect(await stored()).toEqual({ name: 'Room ##', rememberPrefs: true });
      expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(1);
    });

    it('does not touch what members saved when it is turned off or on', async () => {
      const prefs = new MemberRoomPrefsRepository(env.handle.db);
      const service = serviceWith(prefs);
      await creatorWith({ name: 'Room ##', rememberPrefs: true });
      await prefs.saveName(GUILD, PRIMARY, 'u1', 'den');

      await service.setRememberPrefs(GUILD, PRIMARY, false);
      expect(await prefs.get(PRIMARY, 'u1')).toMatchObject({ name: 'den' });
      await service.setRememberPrefs(GUILD, PRIMARY, true);
      expect(await prefs.get(PRIMARY, 'u1')).toMatchObject({ name: 'den' });
    });

    it('clears every member for the creator channel and says how many', async () => {
      const prefs = new MemberRoomPrefsRepository(env.handle.db);
      const service = serviceWith(prefs);
      await creatorWith({ name: 'Room ##', rememberPrefs: true });
      await prefs.saveName(GUILD, PRIMARY, 'u1', 'den');
      await prefs.saveLimit(GUILD, PRIMARY, 'u2', 4);

      const cleared = await service.clearRememberedPrefs(GUILD, 'sec-remember');
      expect(cleared.ok).toBe(true);
      expect(cleared.message).toContain('2 members');
      expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);

      // And a second press has nothing to remove, which it says rather than claiming a clear.
      const again = await service.clearRememberedPrefs(GUILD, PRIMARY);
      expect(again.ok).toBe(true);
      expect(again.message).toContain('nothing to clear');
    });

    /**
     * An admin emptying what members saved cannot be undone, and this is the only record of it,
     * so it logs where and how many. Ids and a count: never a member's id or a name they chose.
     */
    it('logs what it cleared as ids and a count, and never anything a member typed', async () => {
      const prefs = new MemberRoomPrefsRepository(env.handle.db);
      const info = vi.fn();
      const service = new GuildSettingsService({
        guilds,
        autoChannels,
        secondaries,
        actions,
        logger: { ...fakeLogger(), info } as never,
        memberPrefs: prefs,
      });
      await creatorWith({ name: 'Room ##', rememberPrefs: true });
      await prefs.saveName(GUILD, PRIMARY, 'u1', 'a secret den name');
      await prefs.saveLimit(GUILD, PRIMARY, 'u2', 4);

      await service.clearRememberedPrefs(GUILD, 'sec-remember');

      expect(info).toHaveBeenCalledTimes(1);
      const [fields, message] = info.mock.calls[0]!;
      expect(fields).toEqual({ guildId: GUILD, channelId: PRIMARY, removed: 2 });
      expect(message).toBe('cleared remembered room settings');
      expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
      expect(JSON.stringify(info.mock.calls)).not.toContain('u1');
    });

    /** What an admin who switched it off may now want gone. */
    it('clears while the creator channel does not remember, since the rows are only dormant', async () => {
      const prefs = new MemberRoomPrefsRepository(env.handle.db);
      const service = serviceWith(prefs);
      await creatorWith({ name: 'Room ##', rememberPrefs: true });
      await prefs.saveName(GUILD, PRIMARY, 'u1', 'den');
      await service.setRememberPrefs(GUILD, PRIMARY, false);

      expect((await service.clearRememberedPrefs(GUILD, PRIMARY)).message).toContain('1 member');
      expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
    });

    it('says clearing is not available when it was given nothing to clear', async () => {
      const service = serviceWith(undefined);
      await creatorWith();
      const result = await service.clearRememberedPrefs(GUILD, PRIMARY);
      expect(result.ok).toBe(false);
    });

    it('answers a refusal, not a success, when the creator channel was removed first', async () => {
      await creatorWith();
      const racy = new (class extends AutoChannelRepository {
        override async get(channelId: string) {
          const row = await super.get(channelId);
          await autoChannels.remove(GUILD, PRIMARY);
          return row;
        }
      })(env.handle.db);
      const racing = new GuildSettingsService({
        guilds,
        autoChannels: racy,
        secondaries,
        actions,
        logger: fakeLogger(),
      });
      const result = await racing.setRememberPrefs(GUILD, PRIMARY, true);
      expect(result.ok).toBe(false);
    });
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

  /**
   * The restriction map, against a real row lock. The unit tests cover what one
   * edit decides, and these cover what only the database can: that two admins
   * editing at once both land, and that the nickname goes in the same statement.
   */
  describe('command restrictions', () => {
    const SERVER = '460459401086763010';
    const user = (n: number) => ({ kind: 'user' as const, id: `7${String(n).padStart(17, '0')}` });

    it('loses no restriction when concurrent admins edit the map at once', async () => {
      await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(0));
      await Promise.all([
        settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1)),
        settings.addCommandRestriction(SERVER, 'rename', 'deny', user(2)),
        settings.addCommandRestriction(SERVER, 'limit', 'deny', user(3)),
        settings.addCommandRestriction(SERVER, 'nick', 'deny', {
          kind: 'role',
          id: '8'.repeat(18),
        }),
        settings.addCommandRestriction(SERVER, 'rename', 'deny', user(4)),
      ]);
      const access = await settings.getCommandAccess(SERVER);
      expect([...(access.rename?.deny?.users ?? [])].sort()).toEqual(
        [0, 1, 2, 4].map((n) => user(n).id).sort(),
      );
      expect(access.limit?.deny?.users).toEqual([user(3).id]);
      expect(access.nick?.deny?.roles).toEqual(['8'.repeat(18)]);
    });

    it('does not let concurrent adds of one user stack', async () => {
      await Promise.all([
        settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1)),
        settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1)),
        settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1)),
      ]);
      expect((await settings.getCommandAccess(SERVER)).rename?.deny?.users).toEqual([user(1).id]);
    });

    it('enforces the per-feature cap under concurrency', async () => {
      const results = await Promise.all(
        Array.from({ length: 55 }, (_, n) =>
          settings.addCommandRestriction(SERVER, 'rename', 'deny', user(n)),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(50);
      expect((await settings.getCommandAccess(SERVER)).rename?.deny?.users).toHaveLength(50);
    });

    /** Denying /nick and leaving the name in every room they own would defeat the rule. */
    it('removes the saved nickname in the same write as the Nickname restriction', async () => {
      const who = user(1);
      const other = user(2);
      await guilds.updateSettings(SERVER, { custom_nicks: { [who.id]: 'Kay', [other.id]: 'Sam' } });

      const result = await settings.addCommandRestriction(SERVER, 'nick', 'deny', who);

      expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: true });
      const row = await guilds.ensure(SERVER);
      expect(row.settings.custom_nicks).toEqual({ [other.id]: 'Sam' });
      expect(row.settings.command_access).toEqual({ nick: { deny: { users: [who.id] } } });
    });

    it('takes the key off the blob when the last restriction goes, and keeps the rest', async () => {
      await guilds.updateSettings(SERVER, { general: 'Voice rooms' });
      await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1));
      await settings.removeCommandRestriction(SERVER, 'rename', user(1));
      const row = await guilds.ensure(SERVER);
      expect(row.settings).not.toHaveProperty('command_access');
      expect(row.settings.general).toBe('Voice rooms');
    });

    it('keeps an entry a newer build wrote across an edit it knows nothing about', async () => {
      await guilds.updateSettings(SERVER, {
        command_access: { somethingnew: { users: [user(9).id], until: 1800000000 } },
      });
      await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1));
      await settings.removeCommandRestriction(SERVER, 'rename', user(1));
      expect((await guilds.ensure(SERVER)).settings.command_access).toEqual({
        somethingnew: { users: [user(9).id], until: 1800000000 },
      });
    });

    /**
     * A list full of people who left and roles that were deleted cannot be edited
     * through the picker, so `clear` is the way out, and it has to leave the room
     * for the next add and the rest of the blob alone.
     */
    it('clears one feature, leaves the rest of the blob, and frees the list for a new add', async () => {
      await guilds.updateSettings(SERVER, { general: 'Voice rooms' });
      for (let n = 0; n < 50; n++)
        await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(n));
      await settings.addCommandRestriction(SERVER, 'limit', 'deny', user(60));
      expect((await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(70))).ok).toBe(
        false,
      );

      const cleared = await settings.clearCommandRestrictions(SERVER, 'rename');

      expect(cleared).toMatchObject({ ok: true, changed: true });
      expect(cleared.message).toContain('Removed 50 restrictions');
      const row = await guilds.ensure(SERVER);
      expect(row.settings.command_access).toEqual({ limit: { deny: { users: [user(60).id] } } });
      expect(row.settings.general).toBe('Voice rooms');
      expect((await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(70))).ok).toBe(
        true,
      );
    });

    it('takes the key off the blob when a clear leaves nothing', async () => {
      await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1));
      await settings.clearCommandRestrictions(SERVER, 'rename');
      expect((await guilds.ensure(SERVER)).settings).not.toHaveProperty('command_access');
    });

    it('does not lose a restriction added while another admin clears a different feature', async () => {
      await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1));
      await Promise.all([
        settings.clearCommandRestrictions(SERVER, 'rename'),
        settings.addCommandRestriction(SERVER, 'limit', 'deny', user(2)),
        settings.addCommandRestriction(SERVER, 'nick', 'deny', user(3)),
      ]);
      const access = await settings.getCommandAccess(SERVER);
      expect(access.rename).toBeUndefined();
      expect(access.limit?.deny?.users).toEqual([user(2).id]);
      expect(access.nick?.deny?.users).toEqual([user(3).id]);
    });

    /**
     * A shape this build does not write can only be a newer build's. Refused with
     * nothing written, against the real jsonb round trip and not only a fake.
     */
    it('refuses an add onto a list of a shape it cannot read, and leaves it as it was', async () => {
      const newer = { [user(9).id]: 1700000000 };
      await guilds.updateSettings(SERVER, {
        command_access: { rename: { deny: { users: newer } } },
      });

      const result = await settings.addCommandRestriction(SERVER, 'rename', 'deny', user(1));

      expect(result).toMatchObject({ ok: false, changed: false });
      expect((await guilds.ensure(SERVER)).settings.command_access).toEqual({
        rename: { deny: { users: newer } },
      });
    });

    it('writes a guild with no row yet', async () => {
      const result = await settings.addCommandRestriction(
        '999999999999999999',
        'limit',
        'allow',
        user(1),
      );
      expect(result.ok).toBe(true);
      expect((await settings.getCommandAccess('999999999999999999')).limit?.allow?.users).toEqual([
        user(1).id,
      ]);
    });

    /**
     * Allowing somebody takes them off the deny list in the same write, so concurrent
     * edits of both lists of one feature must still all land, each id on one list.
     */
    it('loses nothing when admins edit both lists of one feature at once', async () => {
      await settings.addCommandRestriction(SERVER, 'kick', 'deny', user(1));
      await Promise.all([
        settings.addCommandRestriction(SERVER, 'kick', 'allow', user(1)),
        settings.addCommandRestriction(SERVER, 'kick', 'allow', user(2)),
        settings.addCommandRestriction(SERVER, 'kick', 'deny', user(3)),
        settings.addCommandRestriction(SERVER, 'kick', 'allow', {
          kind: 'role',
          id: '8'.repeat(18),
        }),
      ]);
      const access = await settings.getCommandAccess(SERVER);
      expect([...(access.kick?.allow?.users ?? [])].sort()).toEqual(
        [1, 2].map((n) => user(n).id).sort(),
      );
      expect(access.kick?.allow?.roles).toEqual(['8'.repeat(18)]);
      expect(access.kick?.deny?.users).toEqual([user(3).id]);
    });

    it('clears both lists of a feature against the real row', async () => {
      await settings.addCommandRestriction(SERVER, 'claim', 'allow', user(1));
      await settings.addCommandRestriction(SERVER, 'claim', 'deny', user(2));
      const cleared = await settings.clearCommandRestrictions(SERVER, 'claim');
      expect(cleared.message).toContain('Removed 2 restrictions');
      expect((await guilds.ensure(SERVER)).settings).not.toHaveProperty('command_access');
    });
  });

  /** The whole list in one write under the row lock, against the real row. */
  describe('blocked words', () => {
    it('stores the list, reads it back as a copy, and removes the key when emptied', async () => {
      await settings.setBlockedWords(GUILD, ['bad', 'worse*']);
      expect(await settings.getBlockedWords(GUILD)).toEqual(['bad', 'worse*']);
      await settings.setBlockedWords(GUILD, []);
      expect((await guilds.ensure(GUILD)).settings).not.toHaveProperty('blocked_words');
    });

    it('leaves the other settings in the blob alone', async () => {
      await settings.setGeneral(GUILD, 'Hangout');
      await settings.setBlockedWords(GUILD, ['bad']);
      const stored = (await guilds.ensure(GUILD)).settings;
      expect(stored.general).toBe('Hangout');
      expect(stored.blocked_words).toEqual(['bad']);
    });

    it('refuses an addition in a lapsed server against the list as it stands at the write', async () => {
      await settings.setBlockedWords(GUILD, ['bad']);
      const added = await settings.setBlockedWords(GUILD, ['bad', 'worse'], {
        refuseAdditions: true,
      });
      expect(added.refusedAddition).toBe(true);
      expect(await settings.getBlockedWords(GUILD)).toEqual(['bad']);
      const removed = await settings.setBlockedWords(GUILD, [], { refuseAdditions: true });
      expect(removed).toMatchObject({ ok: true, changed: true, count: 0 });
    });
  });
});
