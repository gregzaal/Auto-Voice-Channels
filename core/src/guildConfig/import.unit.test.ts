import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AVC_EXPORT_VERSION,
  parseFilenameGuildId,
  parseNativeFile,
  sniffFormat,
  type GuildConfigFile,
} from './format.js';
import { DROPPED_FIELDS, planGuild } from '../migrate/legacy.js';
import {
  diffGuildConfig,
  fromLegacyPlan,
  fromNativeFile,
  IMPORT_LIMITS,
  RESTRICTION_REPLACED_FIELDS,
  type ChannelFact,
  type CurrentConfig,
  type GuildFacts,
  type ImportNoteCode,
  type ImportPlan,
} from './import.js';

const GUILD = '460459401086763010';
const OTHER_GUILD = '111111111111111111';
const CREATOR = '345678901234567890';
const ADOPTED = '456789012345678901';
const LOG_CHANNEL = '234567890123456789';
const CATEGORY = '567890123456789012';
const CONTACT = '123456789012345678';
const HOSTED_APP = '479393422705426432';
const SELF_HOST_APP = '675405085752164372';
const ACTOR = '333333333333333333';

function voiceChannel(name: string, over: Partial<ChannelFact> = {}): ChannelFact {
  return { name, kind: 'voice', botCanManage: true, botCanRename: true, ...over };
}

function facts(over: Partial<GuildFacts> = {}): GuildFacts {
  return {
    guildId: GUILD,
    channels: new Map<string, ChannelFact>([
      [CREATOR, voiceChannel('New session')],
      [ADOPTED, voiceChannel('Lobby')],
      [LOG_CHANNEL, { name: 'bot-log', kind: 'text', botCanManage: true, botCanRename: true }],
      [CATEGORY, { name: 'Voice', kind: 'category', botCanManage: true, botCanRename: true }],
    ]),
    members: new Map([[CONTACT, true]]),
    foreignFleetChannels: new Map(),
    applicationId: HOSTED_APP,
    otherFleetsPresent: [],
    actorId: ACTOR,
    ...over,
  };
}

/** A total document: every settings key and every template field present. */
function nativeFile(over: Partial<GuildConfigFile> = {}): GuildConfigFile {
  return {
    avc_export_version: AVC_EXPORT_VERSION,
    exported_at: '2026-08-31T12:00:00.000Z',
    guild_id: GUILD,
    guild_name: 'Example server',
    source_application_id: HOSTED_APP,
    source_fleet_channel_scope: null,
    // A guild with nothing configured. Under the format's own invariant that is
    // every key `null`, not `{}` and `false`: the exporter emits null for a key
    // ABSENT from the stored blob, so an empty guild's file is entirely nulls.
    settings: {
      enabled: null,
      general: null,
      channel_name_template: null,
      channel_status_template: null,
      aliases: null,
      custom_nicks: null,
      logging: null,
      log_level: null,
      groups: null,
      contact_user_id: null,
      problem_alerts: null,
      timezone: null,
      lists: null,
      game_name_mode: null,
      command_access: null,
    },
    creator_channels: [],
    adopted_channels: [],
    ...over,
  };
}

function currentConfig(over: Partial<CurrentConfig> = {}): CurrentConfig {
  return { settings: {}, creatorChannels: [], adoptedChannels: [], ...over };
}

function planOf(
  file: GuildConfigFile,
  current = currentConfig(),
  guildFacts = facts(),
): ImportPlan {
  const result = diffGuildConfig(fromNativeFile(file), current, guildFacts);
  if (!result.ok) throw new Error(`expected a plan, got refusals: ${codes(result.refusals)}`);
  return result.plan;
}

function refusalsOf(
  file: GuildConfigFile,
  current = currentConfig(),
  guildFacts = facts(),
): ImportNoteCode[] {
  const result = diffGuildConfig(fromNativeFile(file), current, guildFacts);
  if (result.ok) throw new Error('expected refusals, got a plan');
  return codes(result.refusals);
}

function codes(notes: readonly { code: ImportNoteCode }[]): ImportNoteCode[] {
  return notes.map((n) => n.code);
}

function noteCodes(plan: ImportPlan): ImportNoteCode[] {
  return codes(plan.notes);
}

describe('sniffFormat', () => {
  it('reads a native file, a legacy file, and refuses the rest', () => {
    expect(sniffFormat({ avc_export_version: 1 })).toEqual({ format: 'native', version: 1 });
    expect(sniffFormat({ enabled: true, general: 'General' })).toEqual({ format: 'legacy' });
    expect(sniffFormat([1, 2])).toMatchObject({ format: 'unreadable' });
    expect(sniffFormat('a string')).toMatchObject({ format: 'unreadable' });
    expect(sniffFormat({ avc_export_version: '1' })).toMatchObject({ format: 'unreadable' });
    expect(sniffFormat({ avc_export_version: 1.5 })).toMatchObject({ format: 'unreadable' });
  });

  /** Forwards only: a newer file may give a value a meaning this build cannot see. */
  it('refuses a version from the future and never guesses', () => {
    const result = sniffFormat({ avc_export_version: AVC_EXPORT_VERSION + 1 });
    expect(result.format).toBe('unreadable');
    expect(result).toMatchObject({ reason: expect.stringContaining('version') });
  });
});

describe('parseFilenameGuildId', () => {
  /**
   * The dump's files are named `<guildId>.json`, so a bare snowflake test
   * against the whole filename never fired on the real corpus, and the filename
   * is the only cross-guild check a legacy file offers.
   */
  it('strips the extension the legacy dump actually uses', () => {
    expect(parseFilenameGuildId('460459401086763010.json')).toBe(GUILD);
    expect(parseFilenameGuildId('460459401086763010')).toBe(GUILD);
    expect(parseFilenameGuildId('460459401086763010.JSON')).toBe(GUILD);
  });

  it('returns null for a renamed file, which is the soft case', () => {
    expect(parseFilenameGuildId('my-server-config.json')).toBeNull();
    expect(parseFilenameGuildId('backup (1).json')).toBeNull();
    expect(parseFilenameGuildId(null)).toBeNull();
    expect(parseFilenameGuildId('')).toBeNull();
  });
});

describe('parseNativeFile', () => {
  it('accepts a total document', () => {
    expect(parseNativeFile(nativeFile()).ok).toBe(true);
  });

  /**
   * Reversed deliberately. This used to refuse a file missing a settings key,
   * on the grounds that totality catches a serializer that forgot one. That
   * protection lives on the WRITE side instead, where it belongs: the exporter
   * is a loop over `EXPORT_SETTINGS_KEYS` returning a total `ExportedSettings`,
   * and `configSnapshot.unit.test.ts` binds it to that list.
   *
   * What the refusal actually cost was every file an older build wrote. Adding
   * `timezone` and `lists` already made pre-2.1.0 files un-importable in
   * production, silently, and `game_name_mode` would have done it again to
   * every file the current release wrote. The pre-import snapshot IS the
   * documented undo, so that refusal lands on the one file somebody reaches
   * for after a mistake.
   */
  it('accepts a file written before a settings key existed', () => {
    const file = nativeFile() as unknown as Record<string, Record<string, unknown>>;
    delete file.settings.game_name_mode;
    delete file.settings.timezone;
    expect(parseNativeFile(file).ok).toBe(true);
  });

  /**
   * The same rule for a creator channel's template, and the reason `defaultHidden` is
   * optional on the wire while the keys before it are not. A file a previous release wrote
   * (every export and every pre-import snapshot) has no such key, and refusing it would
   * refuse the documented undo.
   */
  it('accepts a creator channel template written before defaultHidden existed', () => {
    const fromPreviousRelease = {
      name: 'Room ##',
      status: null,
      limit: null,
      startAt: null,
      above: null,
      defaultPrivate: true,
      inheritperms: null,
      textChannel: null,
    };
    const file = nativeFile({
      creator_channels: [
        { channel_id: CREATOR, channel_name: null, template: fromPreviousRelease },
      ],
    });
    const result = parseNativeFile(JSON.parse(JSON.stringify(file)));
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  /**
   * And again for `rememberPrefs`, which arrived after `defaultHidden`: a file written by
   * the release before it has the first of the two and not the second.
   */
  it('accepts a creator channel template written before rememberPrefs existed', () => {
    const fromPreviousRelease = {
      name: 'Room ##',
      status: null,
      limit: null,
      startAt: null,
      above: null,
      defaultPrivate: true,
      defaultHidden: true,
      inheritperms: null,
      textChannel: null,
    };
    const file = nativeFile({
      creator_channels: [
        { channel_id: CREATOR, channel_name: null, template: fromPreviousRelease },
      ],
    });
    const result = parseNativeFile(JSON.parse(JSON.stringify(file)));
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  /** A reason may name the path and the problem. It may never carry a value. */
  it('never puts a file value in the failure reason', () => {
    const file = nativeFile() as unknown as Record<string, Record<string, unknown>>;
    file.settings.general = { secret: 'do-not-leak-this' };
    const result = parseNativeFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('do-not-leak-this');
  });
});

describe('diffGuildConfig: refusals', () => {
  it('refuses a file for another guild, naming both ids', () => {
    expect(refusalsOf(nativeFile({ guild_id: OTHER_GUILD }))).toEqual(['file_guild_mismatch']);
  });

  /**
   * A cold channel cache reads as every channel having vanished. `/setup` fails
   * open on it and the reconciler bails on it; an import must REFUSE, because
   * here the admin can confirm past a preview that says their setup is gone.
   */
  it('refuses when the guild is not hydrated', () => {
    expect(refusalsOf(nativeFile(), currentConfig(), facts({ channels: new Map() }))).toEqual([
      'guild_not_hydrated',
    ]);
  });

  it('refuses a file over the creator-channel cap', () => {
    const creator_channels = Array.from({ length: IMPORT_LIMITS.creatorChannels + 1 }, (_, i) => ({
      channel_id: `${1000000000000000000 + i}`,
      channel_name: null,
      template: {
        name: null,
        status: null,
        limit: null,
        above: null,
        defaultPrivate: null,
        inheritperms: null,
      },
    }));
    expect(refusalsOf(nativeFile({ creator_channels }))).toEqual(['too_many_creator_channels']);
  });

  it('refuses a channel named in both sections rather than letting write order decide', () => {
    const file = nativeFile({
      creator_channels: [
        {
          channel_id: CREATOR,
          channel_name: null,
          template: {
            name: 'Room ##',
            status: null,
            limit: null,
            above: null,
            defaultPrivate: null,
            inheritperms: null,
          },
        },
      ],
      adopted_channels: [
        {
          channel_id: CREATOR,
          channel_name: null,
          template: { name: 'Lobby', status: null },
          state: { seed: null, name: null, status: null },
        },
      ],
    });
    expect(refusalsOf(file)).toEqual(['channel_in_both_sections']);
  });

  /**
   * A partial foreign-fleet collision skips the row and imports the rest. Every
   * channel being foreign is different: the import would change settings only,
   * which is a decision for the admin rather than a long skip list.
   */
  it('refuses when every channel in the file belongs to another fleet', () => {
    const file = nativeFile({
      creator_channels: [
        {
          channel_id: CREATOR,
          channel_name: null,
          template: {
            name: 'Room ##',
            status: null,
            limit: null,
            above: null,
            defaultPrivate: null,
            inheritperms: null,
          },
        },
      ],
    });
    const guildFacts = facts({ foreignFleetChannels: new Map([[CREATOR, 'beta']]) });
    expect(refusalsOf(file, currentConfig(), guildFacts)).toEqual(['every_channel_foreign_fleet']);
  });

  it('refuses a legacy file whose filename names another guild', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: OTHER_GUILD },
    );
    const result = diffGuildConfig(incoming, currentConfig(), facts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.refusals)).toEqual(['filename_guild_mismatch']);
  });

  it('accepts a legacy file whose filename parses as nothing', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: null },
    );
    expect(diffGuildConfig(incoming, currentConfig(), facts()).ok).toBe(true);
  });
});

describe('diffGuildConfig: settings', () => {
  it('replaces a key the file carries', () => {
    const file = nativeFile();
    file.settings.general = 'Voice rooms';
    const plan = planOf(file, currentConfig({ settings: { general: 'General' } }));
    expect(plan.settingsPatch).toEqual({ general: 'Voice rooms' });
    expect(plan.settingsRemove).toEqual([]);
  });

  it('clears a key the file carries as null', () => {
    const plan = planOf(nativeFile(), currentConfig({ settings: { general: 'General' } }));
    expect(plan.settingsRemove).toEqual(['general']);
    expect(plan.settingChanges.find((c) => c.key === 'general')?.cleared).toBe(true);
  });

  it('does nothing for a null key that was already absent', () => {
    const plan = planOf(nativeFile(), currentConfig({ settings: {} }));
    expect(plan.settingsRemove).toEqual([]);
    expect(plan.changed).toBe(false);
  });

  /**
   * The distinction the format exists for. Absent means "use the default"; `""`
   * means "no status at all". Conflating them loses voice statuses on every room
   * in the guild, forever, from a file the guild exported itself.
   */
  it('treats a cleared status template and an empty one as different', () => {
    const cleared = planOf(
      nativeFile(),
      currentConfig({ settings: { channel_status_template: 'x' } }),
    );
    expect(cleared.settingsRemove).toContain('channel_status_template');
    expect(cleared.settingsPatch.channel_status_template).toBeUndefined();

    const emptied = nativeFile();
    emptied.settings.channel_status_template = '';
    const plan = planOf(emptied, currentConfig({ settings: { channel_status_template: 'x' } }));
    expect(plan.settingsRemove).not.toContain('channel_status_template');
    expect(plan.settingsPatch.channel_status_template).toBe('');
  });

  /** A key a legacy file does not carry is untouched, which is the true half. */
  it('leaves keys a legacy file omits exactly as they are', () => {
    const incoming = fromLegacyPlan(
      {
        settings: { enabled: true },
        primaries: [],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: GUILD },
    );
    const result = diffGuildConfig(
      incoming,
      currentConfig({ settings: { channel_status_template: 'keep me', problem_alerts: 'quiet' } }),
      facts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.settingsRemove).toEqual([]);
    // `enabled` is carried by the legacy plan, so it is written. The point is
    // the two keys the legacy format cannot express are not touched at all.
    expect(Object.keys(result.plan.settingsPatch)).toEqual(['enabled']);
  });

  /**
   * Replacement is safe only if its removals are visible before confirmation:
   * a key the file carries replaces the stored value entirely, so entries it
   * does not list are gone and that must be visible before the button.
   */
  it('lists removed dictionary entries by name', () => {
    const file = nativeFile();
    file.settings.aliases = { 'Counter-Strike 2': 'CS2' };
    const plan = planOf(
      file,
      currentConfig({
        settings: { aliases: { 'Counter-Strike 2': 'CS2', Valorant: 'Val', 'Overwatch 2': 'OW2' } },
      }),
    );
    const change = plan.settingChanges.find((c) => c.key === 'aliases');
    expect(change?.entriesRemoved.sort()).toEqual(['Overwatch 2', 'Valorant']);
    expect(change?.entriesAdded).toEqual([]);
  });

  it('reports added and changed dictionary entries separately', () => {
    const file = nativeFile();
    file.settings.aliases = { Valorant: 'VAL', Fortnite: 'FN' };
    const plan = planOf(file, currentConfig({ settings: { aliases: { Valorant: 'Val' } } }));
    const change = plan.settingChanges.find((c) => c.key === 'aliases');
    expect(change?.entriesAdded).toEqual(['Fortnite']);
    expect(change?.entriesChanged).toEqual(['Valorant']);
  });

  it('drops the whole aliases key when the file lists more than the limit', () => {
    const file = nativeFile();
    const many: Record<string, string> = {};
    for (let i = 0; i <= IMPORT_LIMITS.aliases; i++) many[`game ${i}`] = `g${i}`;
    file.settings.aliases = many;
    const plan = planOf(file, currentConfig({ settings: { aliases: { Valorant: 'Val' } } }));
    expect(plan.settingsPatch.aliases).toBeUndefined();
    expect(noteCodes(plan)).toContain('setting_over_limit');
  });

  it('drops a custom_nicks entry whose key is not a user snowflake', () => {
    const file = nativeFile();
    file.settings.custom_nicks = { [CONTACT]: 'Greg', 'not-an-id': 'Nobody' };
    const plan = planOf(file);
    expect(plan.settingsPatch.custom_nicks).toEqual({ [CONTACT]: 'Greg' });
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  it('accepts a log channel in this guild and drops one that is not', () => {
    const good = nativeFile();
    good.settings.logging = LOG_CHANNEL;
    expect(planOf(good).settingsPatch.logging).toBe(LOG_CHANNEL);

    const foreign = nativeFile();
    foreign.settings.logging = '999999999999999999';
    const plan = planOf(foreign);
    expect(plan.settingsPatch.logging).toBeUndefined();
    expect(noteCodes(plan)).toContain('logging_unresolved');
  });

  it('drops a log channel that resolves to a voice channel', () => {
    const file = nativeFile();
    file.settings.logging = CREATOR;
    expect(noteCodes(planOf(file))).toContain('logging_unresolved');
  });

  it('keeps logging: false, which is a legal stored value meaning off', () => {
    const file = nativeFile();
    file.settings.logging = false;
    const plan = planOf(file, currentConfig({ settings: { logging: LOG_CHANNEL } }));
    expect(plan.settingsPatch.logging).toBe(false);
  });

  it('drops a group key that is not a category in this guild', () => {
    const file = nativeFile();
    file.settings.groups = { '@root': { above: true }, [CREATOR]: { above: false } };
    const plan = planOf(file);
    expect(plan.settingsPatch.groups).toEqual({ '@root': { above: true } });
    expect(noteCodes(plan)).toContain('group_unresolved');
  });

  it('accepts a group key naming a real category', () => {
    const file = nativeFile();
    file.settings.groups = { [CATEGORY]: { above: true } };
    expect(planOf(file).settingsPatch.groups).toEqual({ [CATEGORY]: { above: true } });
  });

  /**
   * `/import` is the first writer that can name somebody other than the person
   * running the command, and the contact receives an unsolicited DM and an
   * @-ping. 20% of imported contacts have already left their server.
   */
  it('accepts a contact who is a member and drops one who is not', () => {
    const good = nativeFile();
    good.settings.contact_user_id = CONTACT;
    expect(planOf(good).settingsPatch.contact_user_id).toBe(CONTACT);

    const gone = nativeFile();
    gone.settings.contact_user_id = '222222222222222222';
    const plan = planOf(gone);
    expect(plan.settingsPatch.contact_user_id).toBeUndefined();
    expect(noteCodes(plan)).toContain('contact_not_member');
  });

  /** `readProblemAlerts` reads an unrecognised value as `contact`, the loudest mode. */
  it('drops an unrecognised problem_alerts value rather than letting it read as contact', () => {
    const file = nativeFile();
    file.settings.problem_alerts = 'loud';
    const plan = planOf(file);
    expect(plan.settingsPatch.problem_alerts).toBeUndefined();
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  /**
   * The distinction the laxer parse depends on: OMITTED means the file does not
   * speak to the key, `null` means the key is absent from the stored blob and
   * should be removed. Collapsing the two would let an older file silently
   * clear settings it has never heard of.
   */
  it('leaves an omitted settings key untouched, where null removes it', () => {
    const current = currentConfig({ settings: { general: 'Voice rooms' } });

    const omitted = nativeFile() as unknown as Record<string, Record<string, unknown>>;
    delete omitted.settings.general;
    const untouched = planOf(omitted, current);
    expect(untouched.settingsPatch.general).toBeUndefined();
    expect(untouched.settingsRemove).not.toContain('general');

    const explicitNull = planOf(nativeFile(), current);
    expect(explicitNull.settingsRemove).toContain('general');
  });

  it('carries game_name_mode through, and drops an unrecognised one', () => {
    const good = nativeFile();
    good.settings.game_name_mode = 'top';
    expect(planOf(good).settingsPatch.game_name_mode).toBe('top');

    // `readGameNameMode` reads anything unknown as `shared`, so without the
    // validation an admin's file could store a mode that never takes effect.
    const bad = nativeFile();
    bad.settings.game_name_mode = 'owner';
    const plan = planOf(bad);
    expect(plan.settingsPatch.game_name_mode).toBeUndefined();
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  it('carries the control panel map through, keeping ids it does not know', () => {
    const file = nativeFile();
    // `panel` is the sentinel for the whole panel, `kick` is a control, and
    // `somethingnew` is what a file written by a newer build looks like.
    file.settings.control_panel = { panel: false, kick: false, somethingnew: false };
    const plan = planOf(file);
    expect(plan.settingsPatch.control_panel).toEqual({
      panel: false,
      kick: false,
      somethingnew: false,
    });
  });

  /**
   * Shape is enforced even though ids are not: an unknown id is inert,
   * because the reader looks each control up by name, but a non-boolean value
   * is junk that would sit in the blob forever.
   */
  it('drops a control panel entry whose value is not a flag', () => {
    const file = nativeFile();
    file.settings.control_panel = { kick: 'off', info: false };
    const plan = planOf(file);
    expect(plan.settingsPatch.control_panel).toEqual({ info: false });
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  it('refuses a control panel value that is not a map at all', () => {
    const file = nativeFile();
    file.settings.control_panel = ['kick'];
    const plan = planOf(file);
    expect(plan.settingsPatch.control_panel).toBeUndefined();
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  it('drops an out-of-range log level rather than clamping it', () => {
    const file = nativeFile();
    file.settings.log_level = 9;
    const plan = planOf(file);
    expect(plan.settingsPatch.log_level).toBeUndefined();
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  /**
   * The fourth hook on `settings.contact_user_id`.
   *
   * A path that configures creator channels and leaves nobody recorded produces
   * a guild nothing can reach when its automation breaks, which is why the three
   * existing writers all stamp it.
   */
  describe('the contact stamp', () => {
    const withTemplate = () =>
      nativeFile({
        creator_channels: [
          {
            channel_id: CREATOR,
            channel_name: null,
            template: {
              name: 'Room ##',
              status: null,
              limit: null,
              above: null,
              defaultPrivate: null,
              inheritperms: null,
            },
          },
        ],
      });

    it('stamps the importer when the file names nobody and the guild has nobody', () => {
      const plan = planOf(withTemplate());
      expect(plan.settingsPatch.contact_user_id).toBe(ACTOR);
      expect(noteCodes(plan)).toContain('contact_stamped');
    });

    it('stamps the importer when the file names somebody who has left', () => {
      const file = withTemplate();
      file.settings.contact_user_id = '222222222222222222';
      const plan = planOf(file);
      expect(noteCodes(plan)).toContain('contact_not_member');
      expect(plan.settingsPatch.contact_user_id).toBe(ACTOR);
    });

    it('leaves the file own contact alone when that person is a member', () => {
      const file = withTemplate();
      file.settings.contact_user_id = CONTACT;
      const plan = planOf(file);
      expect(plan.settingsPatch.contact_user_id).toBe(CONTACT);
      expect(noteCodes(plan)).not.toContain('contact_stamped');
    });

    it('leaves a stored contact alone when the file carries the same one', () => {
      const file = withTemplate();
      file.settings.contact_user_id = CONTACT;
      const plan = planOf(file, currentConfig({ settings: { contact_user_id: CONTACT } }));
      expect(plan.settingsPatch.contact_user_id).toBeUndefined();
      expect(plan.settingsRemove).not.toContain('contact_user_id');
    });

    /**
     * The case worth pinning: the clear is WITHDRAWN, not layered over. The
     * settings write applies the key minus AFTER the concat, so a key left in
     * both would be deleted again and the stamp would silently do nothing.
     */
    it('withdraws the clear rather than writing and deleting the same key', () => {
      const plan = planOf(
        withTemplate(),
        currentConfig({ settings: { contact_user_id: CONTACT } }),
      );
      expect(plan.settingsRemove).not.toContain('contact_user_id');
      expect(plan.settingsPatch.contact_user_id).toBe(ACTOR);
    });

    /** Settings-only imports are not a setup path, so they do not stamp. */
    it('does not stamp when the import writes no template', () => {
      const file = nativeFile();
      file.settings.general = 'Voice';
      const plan = planOf(file);
      expect(plan.settingsPatch.contact_user_id).toBeUndefined();
      expect(noteCodes(plan)).not.toContain('contact_stamped');
    });

    it('does not stamp when there is no actor to stamp', () => {
      const result = diffGuildConfig(
        fromNativeFile(withTemplate()),
        currentConfig(),
        facts({ actorId: null }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.plan.settingsPatch.contact_user_id).toBeUndefined();
    });
  });

  it('warns when the file switches automation off', () => {
    const file = nativeFile();
    file.settings.enabled = false;
    const plan = planOf(file, currentConfig({ settings: { enabled: true } }));
    expect(noteCodes(plan)).toContain('automation_switched_off');
  });
});

describe('diffGuildConfig: creator channels', () => {
  const creatorEntry = (over: Record<string, unknown> = {}) => ({
    channel_id: CREATOR,
    channel_name: 'New session',
    template: {
      name: 'Room ##',
      status: null,
      limit: 4,
      above: null,
      defaultPrivate: null,
      inheritperms: null,
      ...over,
    },
  });

  it('writes a template for a resolvable voice channel', () => {
    const plan = planOf(nativeFile({ creator_channels: [creatorEntry()] as never }));
    expect(plan.creatorWrites).toEqual([
      { channelId: CREATOR, template: { name: 'Room ##', limit: 4 } },
    ]);
    expect(plan.creatorChanges[0]?.action).toBe('adopt');
  });

  it('drops a channel that no longer exists, and names it from the file', () => {
    const entry = {
      ...creatorEntry(),
      channel_id: '888888888888888888',
      channel_name: 'Squad room',
    };
    const plan = planOf(nativeFile({ creator_channels: [entry] as never }));
    expect(plan.creatorWrites).toEqual([]);
    const note = plan.notes.find((n) => n.code === 'channel_missing');
    expect(note?.name).toBe('Squad room');
  });

  it('drops a channel that is not a voice channel', () => {
    const entry = { ...creatorEntry(), channel_id: LOG_CHANNEL };
    expect(noteCodes(planOf(nativeFile({ creator_channels: [entry] as never })))).toContain(
      'channel_wrong_type',
    );
  });

  /** A row is harmless until someone joins, and the fix is a grantable permission. */
  it('warns but still writes when the bot cannot manage the channel', () => {
    const guildFacts = facts({
      channels: new Map([[CREATOR, voiceChannel('New session', { botCanManage: false })]]),
    });
    const plan = planOf(
      nativeFile({ creator_channels: [creatorEntry()] as never }),
      currentConfig(),
      guildFacts,
    );
    expect(plan.creatorWrites).toHaveLength(1);
    expect(noteCodes(plan)).toContain('channel_cannot_manage');
  });

  it('reports no change when the stored template already matches', () => {
    const plan = planOf(
      nativeFile({ creator_channels: [creatorEntry()] as never }),
      currentConfig({
        creatorChannels: [{ channelId: CREATOR, template: { name: 'Room ##', limit: 4 } }],
      }),
    );
    expect(plan.creatorWrites).toEqual([]);
    expect(plan.changed).toBe(false);
  });

  it('drops a user limit outside 0 to 99', () => {
    const plan = planOf(nativeFile({ creator_channels: [creatorEntry({ limit: 500 })] as never }));
    expect(plan.creatorWrites[0]?.template.limit).toBeUndefined();
    expect(noteCodes(plan)).toContain('template_field_invalid');
  });

  describe('defaultHidden', () => {
    it('is carried beside defaultPrivate, and a re-import of the same file changes nothing', () => {
      const file = nativeFile({
        creator_channels: [creatorEntry({ defaultPrivate: true, defaultHidden: true })] as never,
      });
      const plan = planOf(file);
      expect(plan.creatorWrites[0]?.template).toEqual({
        name: 'Room ##',
        limit: 4,
        defaultPrivate: true,
        defaultHidden: true,
      });
      const again = planOf(
        file,
        currentConfig({
          creatorChannels: [{ channelId: CREATOR, template: plan.creatorWrites[0]!.template }],
        }),
      );
      expect(again.creatorWrites).toEqual([]);
      expect(again.changed).toBe(false);
    });

    it('is dropped with a note when it is not a boolean, and the rest of the template stays', () => {
      const plan = planOf(
        nativeFile({
          creator_channels: [creatorEntry({ defaultPrivate: true, defaultHidden: 'yes' })] as never,
        }),
      );
      expect(plan.creatorWrites[0]?.template).toEqual({
        name: 'Room ##',
        limit: 4,
        defaultPrivate: true,
      });
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'template_field_invalid',
          subject: `${CREATOR}.defaultHidden`,
        }),
      );
    });

    /** `null` on the wire means the key is absent from the stored blob, so it clears. */
    it('is cleared by a null, which is how a file says the key is absent', () => {
      const plan = planOf(
        nativeFile({
          creator_channels: [creatorEntry({ defaultPrivate: true, defaultHidden: null })] as never,
        }),
        currentConfig({
          creatorChannels: [
            {
              channelId: CREATOR,
              template: { name: 'Room ##', limit: 4, defaultPrivate: true, defaultHidden: true },
            },
          ],
        }),
      );
      expect(plan.creatorWrites[0]?.template).toEqual({
        name: 'Room ##',
        limit: 4,
        defaultPrivate: true,
      });
      expect(plan.creatorChanges[0]?.fields).toContainEqual(
        expect.objectContaining({ field: 'defaultHidden', before: true, after: undefined }),
      );
    });
  });

  /**
   * The switch for remembered room settings is configuration and travels with the creator
   * channel. What members saved is a table of its own and is not in the file at all.
   */
  describe('rememberPrefs', () => {
    it('is carried, and a re-import of the same file changes nothing', () => {
      const file = nativeFile({
        creator_channels: [creatorEntry({ rememberPrefs: true })] as never,
      });
      const plan = planOf(file);
      expect(plan.creatorWrites[0]?.template).toEqual({
        name: 'Room ##',
        limit: 4,
        rememberPrefs: true,
      });
      const again = planOf(
        file,
        currentConfig({
          creatorChannels: [{ channelId: CREATOR, template: plan.creatorWrites[0]!.template }],
        }),
      );
      expect(again.creatorWrites).toEqual([]);
      expect(again.changed).toBe(false);
    });

    it('is dropped with a note when it is not a boolean, and the rest of the template stays', () => {
      const plan = planOf(
        nativeFile({ creator_channels: [creatorEntry({ rememberPrefs: 'yes' })] as never }),
      );
      expect(plan.creatorWrites[0]?.template).toEqual({ name: 'Room ##', limit: 4 });
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'template_field_invalid',
          subject: `${CREATOR}.rememberPrefs`,
        }),
      );
    });

    /** `null` on the wire means the key is absent from the stored blob, so it clears. */
    it('is cleared by a null, which is how a file says the key is absent', () => {
      const plan = planOf(
        nativeFile({ creator_channels: [creatorEntry({ rememberPrefs: null })] as never }),
        currentConfig({
          creatorChannels: [
            { channelId: CREATOR, template: { name: 'Room ##', limit: 4, rememberPrefs: true } },
          ],
        }),
      );
      expect(plan.creatorWrites[0]?.template).toEqual({ name: 'Room ##', limit: 4 });
      expect(plan.creatorChanges[0]?.fields).toContainEqual(
        expect.objectContaining({ field: 'rememberPrefs', before: true, after: undefined }),
      );
    });

    /**
     * A native import replaces the whole template, so a file that does not carry the key,
     * which is every file written before it existed, turns it off. The preview lists it as a
     * change, and what members saved is untouched. Pinned so the docs that say so stay true.
     */
    it('is turned off by a file that omits it, and the preview says so', () => {
      // The default fixture carries no `rememberPrefs`, as a file from before it existed does not.
      const plan = planOf(
        nativeFile({ creator_channels: [creatorEntry()] as never }),
        currentConfig({
          creatorChannels: [
            { channelId: CREATOR, template: { name: 'Room ##', limit: 4, rememberPrefs: true } },
          ],
        }),
      );
      expect(plan.creatorWrites[0]?.template).toEqual({ name: 'Room ##', limit: 4 });
      expect(plan.creatorChanges[0]?.fields).toContainEqual(
        expect.objectContaining({ field: 'rememberPrefs', before: true }),
      );
    });
  });

  it('drops an inheritperms id that does not resolve, and keeps the two keywords', () => {
    const bad = planOf(
      nativeFile({
        creator_channels: [creatorEntry({ inheritperms: '777777777777777777' })] as never,
      }),
    );
    expect(noteCodes(bad)).toContain('inheritperms_unresolved');

    const good = planOf(
      nativeFile({ creator_channels: [creatorEntry({ inheritperms: 'category' })] as never }),
    );
    expect(good.creatorWrites[0]?.template.inheritperms).toBe('category');
  });

  /**
   * A native file is a complete-state document, so a row it omits is one
   * the admin has said should not exist. That is what makes the snapshot a real
   * undo in both directions.
   */
  it('removes a stored creator channel the native file omits', () => {
    const plan = planOf(
      nativeFile(),
      currentConfig({ creatorChannels: [{ channelId: CREATOR, template: { name: 'Room ##' } }] }),
    );
    expect(plan.creatorRemovals).toEqual([CREATOR]);
    expect(noteCodes(plan)).toContain('creator_removal_is_one_way');
  });

  /** A legacy file cannot express the rewrite's state, so it may only add. */
  it('never removes a creator channel from a legacy file', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: GUILD },
    );
    const result = diffGuildConfig(
      incoming,
      currentConfig({ creatorChannels: [{ channelId: CREATOR, template: { name: 'Room ##' } }] }),
      facts(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.creatorRemovals).toEqual([]);
  });

  /**
   * Removals come from FILE ABSENCE, never from a resolution failure. The other
   * way round makes the write set "resolvable file entries" and deletes exactly
   * the rows the keep-the-row rule exists to protect.
   */
  it('does not remove a stored row just because its channel has vanished', () => {
    const entry = { ...creatorEntry(), channel_id: '888888888888888888' };
    const plan = planOf(
      nativeFile({ creator_channels: [entry] as never }),
      currentConfig({
        creatorChannels: [{ channelId: '888888888888888888', template: { name: 'x' } }],
      }),
    );
    expect(plan.creatorRemovals).toEqual([]);
    expect(noteCodes(plan)).toContain('channel_missing');
  });
});

describe('diffGuildConfig: legacy templates', () => {
  /**
   * A legacy import must preserve fields its format cannot express. `planGuild`
   * structurally cannot emit `status` or `defaultPrivate`, and
   * `autoChannels.upsert` writes the whole column, so a wholesale write would
   * silently clear the voice-status template and `/alwaysprivate` on every
   * creator channel the file names. Days later, with no way to tell why. `defaultHidden`
   * is held to the same rule: a hidden creator channel that a legacy import turned into a
   * locked one would show every room's name in the channel list again. So is `rememberPrefs`,
   * which a legacy file cannot say either, and which would otherwise be switched off quietly.
   */
  it('leaves status, defaultPrivate, defaultHidden and rememberPrefs alone, because the legacy format cannot express them', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [{ channelId: CREATOR, template: { name: 'Legacy ##', above: true } }],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: GUILD },
    );
    const result = diffGuildConfig(
      incoming,
      currentConfig({
        creatorChannels: [
          {
            channelId: CREATOR,
            template: {
              name: 'Room ##',
              status: 'Playing @@game_name@@',
              defaultPrivate: true,
              defaultHidden: true,
              rememberPrefs: true,
            },
          },
        ],
      }),
      facts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.creatorWrites[0]?.template).toEqual({
      name: 'Legacy ##',
      status: 'Playing @@game_name@@',
      defaultPrivate: true,
      defaultHidden: true,
      rememberPrefs: true,
      above: true,
    });
  });

  it('warns that a legacy import always rewrites the position field', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: GUILD },
    );
    const result = diffGuildConfig(incoming, currentConfig(), facts());
    if (result.ok) expect(noteCodes(result.plan)).toContain('position_overwritten');
  });

  it('surfaces the legacy free wins: dropped fields and orphans', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: ['sapphire', 'diamond'],
        orphanedTextChannels: [LOG_CHANNEL],
        orphanedRoles: ['901234567890123456'],
      },
      { wasMarkedLeft: true, filenameGuildId: GUILD },
    );
    const result = diffGuildConfig(incoming, currentConfig(), facts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = noteCodes(result.plan);
    expect(found).toContain('legacy_field_dropped');
    expect(found).toContain('orphaned_text_channel');
    expect(found).toContain('orphaned_role');
    // Recorded before the `left` key was stripped, which is the only way to know.
    expect(found).toContain('legacy_marked_left');
  });

  /**
   * `restrictions` is the old per-command role rule, and `/restrict` is what
   * answers it now, so telling an admin only that it is "an old setting AVC no
   * longer has" would be misleading. Every other dropped field keeps the generic
   * note, `requiredrole` included: the old bot never read it.
   */
  it('tells the old role rule apart from the other dropped fields, per field', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: ['restrictions', 'requiredrole', 'sapphire'],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: GUILD },
    );
    const result = diffGuildConfig(incoming, currentConfig(), facts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bySubject = Object.fromEntries(
      result.plan.notes.filter((n) => n.code.startsWith('legacy_')).map((n) => [n.subject, n.code]),
    );
    expect(bySubject).toEqual({
      restrictions: 'legacy_restriction_replaced',
      requiredrole: 'legacy_field_dropped',
      sapphire: 'legacy_field_dropped',
    });
  });

  /**
   * What the old bot actually wrote to almost every server: `requiredrole` as an
   * empty default (73,692 of 73,861 files in the dump, 44 with a value) and no
   * `restrictions` at all. Read through the real planner, so the test fails if the
   * planner's own list and this note ever disagree again.
   */
  it('does not tell a default legacy server it had a role rule', () => {
    const planned = planGuild(GUILD, {
      aliases: {},
      enabled: true,
      requiredrole: '',
      auto_channels: {},
      channel_name_template: '## [@@game_name@@]',
    });
    const incoming = fromLegacyPlan(planned, { wasMarkedLeft: false, filenameGuildId: GUILD });
    const result = diffGuildConfig(incoming, currentConfig(), facts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacy = result.plan.notes.filter((n) => n.code.startsWith('legacy_'));
    expect(legacy.map((n) => [n.subject, n.code])).toEqual([
      ['requiredrole', 'legacy_field_dropped'],
    ]);
  });

  it('tells a server that had a restrictions map, which is the one old role rule', () => {
    const planned = planGuild(GUILD, {
      enabled: true,
      requiredrole: '',
      restrictions: { name: ['123456789012345678'] },
      auto_channels: {},
    });
    const incoming = fromLegacyPlan(planned, { wasMarkedLeft: false, filenameGuildId: GUILD });
    const result = diffGuildConfig(incoming, currentConfig(), facts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bySubject = Object.fromEntries(
      result.plan.notes.filter((n) => n.code.startsWith('legacy_')).map((n) => [n.subject, n.code]),
    );
    expect(bySubject).toEqual({
      restrictions: 'legacy_restriction_replaced',
      requiredrole: 'legacy_field_dropped',
    });
  });

  it('only names a replaced field the importer reports as dropped', () => {
    for (const field of RESTRICTION_REPLACED_FIELDS) {
      expect(DROPPED_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('never carries adopted channels, which the legacy format has no concept of', () => {
    const incoming = fromLegacyPlan(
      {
        settings: {},
        primaries: [],
        droppedFields: [],
        orphanedTextChannels: [],
        orphanedRoles: [],
      },
      { wasMarkedLeft: false, filenameGuildId: GUILD },
    );
    expect(incoming.adoptedChannels).toEqual([]);
    const result = diffGuildConfig(
      incoming,
      currentConfig({ adoptedChannels: [{ channelId: ADOPTED, template: {}, state: {} }] }),
      facts(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.adoptedRemovals).toEqual([]);
  });
});

describe('diffGuildConfig: adopted channels', () => {
  const adoptedEntry = (over: Record<string, unknown> = {}) => ({
    channel_id: ADOPTED,
    channel_name: 'Lobby',
    template: { name: '__Lobby/@@creator@@ room__', status: null },
    state: { seed: 812345, name: 'Lobby', status: null, ...over },
  });

  it('writes template and state for a first-time adopt', () => {
    const plan = planOf(nativeFile({ adopted_channels: [adoptedEntry()] as never }));
    expect(plan.adoptedWrites).toHaveLength(1);
    expect(plan.adoptedWrites[0]?.firstTime).toBe(true);
    expect(plan.adoptedWrites[0]?.state).toEqual({ seed: 812345, name: 'Lobby' });
  });

  /**
   * The permission answers are the full sets, not a single flag.
   *
   * A creator channel the bot can See but cannot Connect to creates no rooms,
   * and an adopted channel where it holds Manage Channels but not View Channel
   * cannot be renamed at all, so a proxy on one flag was wrong both ways.
   */
  it('names the missing permission on a drop, so the admin knows what to grant', () => {
    const guildFacts = facts({
      channels: new Map([
        [
          ADOPTED,
          voiceChannel('Lobby', { botCanRename: false, missingPermissions: ['View Channel'] }),
        ],
      ]),
    });
    const plan = planOf(
      nativeFile({ adopted_channels: [adoptedEntry()] as never }),
      currentConfig(),
      guildFacts,
    );
    const note = plan.notes.find((n) => n.code === 'channel_cannot_rename');
    expect(note?.missingPermissions).toEqual(['View Channel']);
  });

  /**
   * The import self-destruct, and the reason this is a hard drop rather than a
   * warning. A `managed_channels` row for a channel the bot cannot rename makes
   * the next sweep call `rerenderManaged` with `onUnmanageable: 'abandon'`, which
   * deletes the row AND records a permission problem, which fires the outbound
   * notifier ladder. Success, then a silent un-adopt, then an unsolicited notice.
   */
  it('drops an adopted channel the bot cannot rename', () => {
    const guildFacts = facts({
      channels: new Map([[ADOPTED, voiceChannel('Lobby', { botCanRename: false })]]),
    });
    const plan = planOf(
      nativeFile({ adopted_channels: [adoptedEntry()] as never }),
      currentConfig(),
      guildFacts,
    );
    expect(plan.adoptedWrites).toEqual([]);
    expect(noteCodes(plan)).toContain('channel_cannot_rename');
  });

  /**
   * `updateState` replaces the whole column, which also holds `roster`: arrival
   * order, which decides `@@creator@@` and the owner. Writing the file's state
   * wholesale reassigns ownership mid-session.
   */
  it('preserves the stored roster and never overwrites a stored seed', () => {
    const plan = planOf(
      nativeFile({ adopted_channels: [adoptedEntry({ seed: 999 })] as never }),
      currentConfig({
        adoptedChannels: [
          {
            channelId: ADOPTED,
            template: { name: 'old' },
            state: { seed: 7, roster: ['user-1', 'user-2'], name: 'Lobby' },
          },
        ],
      }),
    );
    expect(plan.adoptedWrites[0]?.state).toMatchObject({
      seed: 7,
      roster: ['user-1', 'user-2'],
    });
  });

  it('refuses to make an existing creator channel an adopted one', () => {
    const entry = { ...adoptedEntry(), channel_id: CREATOR };
    const plan = planOf(
      nativeFile({ adopted_channels: [entry] as never }),
      currentConfig({ creatorChannels: [{ channelId: CREATOR, template: {} }] }),
    );
    expect(plan.adoptedWrites).toEqual([]);
    expect(noteCodes(plan)).toContain('channel_already_creator');
  });

  it('removes a stored adopted channel the native file omits', () => {
    const plan = planOf(
      nativeFile(),
      currentConfig({ adoptedChannels: [{ channelId: ADOPTED, template: {}, state: {} }] }),
    );
    expect(plan.adoptedRemovals).toEqual([ADOPTED]);
  });

  /** Carried so an import does not rename every adopted channel it touches. */
  it('carries the last rendered name so an unchanged channel is not renamed', () => {
    const plan = planOf(
      nativeFile({ adopted_channels: [adoptedEntry()] as never }),
      currentConfig({
        adoptedChannels: [
          {
            channelId: ADOPTED,
            template: { name: '__Lobby/@@creator@@ room__' },
            state: { seed: 812345, name: 'Lobby' },
          },
        ],
      }),
    );
    expect(plan.adoptedWrites).toEqual([]);
    expect(plan.changed).toBe(false);
  });
});

describe('diffGuildConfig: the two-bots warning', () => {
  /**
   * The one warning the feature cannot omit. In the promised flow both bots end
   * up holding rows for the same channel ids in SEPARATE databases, so the
   * foreign-fleet check cannot see it, and both create a room on every join.
   */
  it('warns when the file came from a different application', () => {
    const file = nativeFile({ source_application_id: SELF_HOST_APP });
    expect(noteCodes(planOf(file))).toContain('other_bot_may_be_present');
  });

  it('imports cleanly despite the different application, and never refuses on it', () => {
    const file = nativeFile({ source_application_id: SELF_HOST_APP });
    file.settings.general = 'Voice';
    const plan = planOf(file);
    expect(plan.settingsPatch).toEqual({ general: 'Voice' });
  });

  it('warns when another AVC fleet is configured in this guild', () => {
    const plan = planOf(nativeFile(), currentConfig(), facts({ otherFleetsPresent: ['beta'] }));
    expect(noteCodes(plan)).toContain('other_bot_may_be_present');
  });

  it('stays quiet when the file came from this same application', () => {
    expect(noteCodes(planOf(nativeFile()))).not.toContain('other_bot_may_be_present');
  });
});

describe('the differ writes no auth state, by construction', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));

  /**
   * `mergeIntoExisting` returns a `writeTrial` COMMAND that `importDump` obeys
   * by calling `transitionAuth`, and `trialStartFor` sits beside `planGuild` in
   * the same public surface. An import says nothing about whether anyone is
   * paying, so the differ must not be able to reach either.
   */
  it('imports nothing that could write auth state', () => {
    const source = readFileSync(join(HERE, 'import.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    /**
     * An allow-list, not a count, and every entry has to be a module that
     * CANNOT reach auth state or the database:
     *
     * - `./format.js` is the wire schema, zod and nothing else.
     * - `../template/nameTemplate.js` is the render engine, which is pure by
     *   construction and asserted so by its own barrel: no repositories, no
     *   `pg`, no node builtins. The differ borrows `canonicalTimeZone` from it
     *   rather than keeping a second copy, which is the lesson the shared
     * engine was extracted to learn.
     *
     * Widening this list is a real decision. The forbidden-call checks below
     * are the teeth and stay whatever it contains.
     */
    // Counted first: a loop of assertions over a list the scan failed to build
    // passes vacuously, which is the same silent-pass failure a source-scanning
    // test exists to avoid.
    expect(imports.length).toBeGreaterThan(0);
    for (const from of imports) {
      expect(['./format.js', '../template/nameTemplate.js']).toContain(from);
    }
    for (const forbidden of [
      'mergeIntoExisting',
      'trialStartFor',
      'transitionAuth',
      'writeTrial',
    ]) {
      // Named in the prose above deliberately, so match a call rather than a word.
      expect(source).not.toMatch(new RegExp(`${forbidden}\\s*\\(`));
    }
  });

  it('never puts a settings or template VALUE in a note', () => {
    const file = nativeFile();
    file.settings.general = 'x'.repeat(IMPORT_LIMITS.generalChars + 1);
    file.settings.problem_alerts = 'a-secret-value';
    const plan = planOf(file);
    const serialized = JSON.stringify(plan.notes);
    expect(serialized).not.toContain('a-secret-value');
    expect(serialized).not.toContain('xxxx');
  });
});

/**
 * The room control panel's APPEARANCE round trip (2026-09-20).
 *
 * It lives in `control_panel_style`, not in `control_panel`, and these tests
 * exist because putting it in `control_panel` broke the round trip outright:
 * that key is typed `record(string, boolean)`, so a string title made the whole
 * exported file unreadable, including the pre-import snapshot that is the
 * documented undo.
 */
describe('control panel appearance round trip', () => {
  const withSettings = (settings: Record<string, unknown>): GuildConfigFile =>
    nativeFile({ settings: { ...nativeFile().settings, ...settings } as never });

  it('accepts a file carrying a title, a description and a colour', () => {
    const parsed = parseNativeFile(
      withSettings({
        control_panel_style: {
          title: 'Your room',
          description: 'Owner: @@owner@@',
          color: 12860415,
        },
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  /** The regression that started this: a string inside the boolean-typed key. */
  it('still refuses a string inside the switches key, which is why they are two keys', () => {
    const parsed = parseNativeFile(withSettings({ control_panel: { title: 'Your room' } }));
    expect(parsed.ok).toBe(false);
  });

  it('accepts both keys together, and either alone', () => {
    for (const settings of [
      { control_panel: { kick: false } },
      { control_panel_style: { title: 'T' } },
      { control_panel: { kick: false }, control_panel_style: { title: 'T' } },
      { control_panel_style: null },
    ]) {
      expect(parseNativeFile(withSettings(settings)).ok).toBe(true);
    }
  });

  /**
   * An older build reading a newer file must IGNORE this key rather than refuse
   * the file, which is the property that made a separate key the right answer.
   * Zod strips unknown keys, so a key no schema knows behaves the same way.
   */
  it('ignores a style key an older schema would not know, rather than refusing', () => {
    const parsed = parseNativeFile(withSettings({ some_future_key: { a: 1 } }));
    expect(parsed.ok).toBe(true);
  });

  it('carries the appearance through the import plan', () => {
    const plan = planOf(
      withSettings({ control_panel_style: { title: 'Your room', color: 12860415 } }),
    );
    expect(plan.settingsPatch.control_panel_style).toEqual({
      title: 'Your room',
      color: 12860415,
    });
  });

  /** Junk still cannot reach the blob: shape is enforced entry by entry. */
  it('drops an entry of the wrong shape and keeps the rest', () => {
    const plan = planOf(withSettings({ control_panel_style: { title: 'Kept', color: { no: 1 } } }));
    expect(plan.settingsPatch.control_panel_style).toEqual({ title: 'Kept' });
  });
});

/**
 * Who may use which room command (`command_access`): an allow list and a deny list
 * per feature.
 *
 * A key of its own for `control_panel_style`'s reason, and a permissive wire
 * schema so that a shape a newer build invents costs one entry and an issue
 * rather than making the whole file, the pre-import snapshot included,
 * unreadable.
 */
describe('command_access', () => {
  const USER_A = '111111111111111111';
  const USER_B = '222222222222222222';
  const ROLE_A = '333333333333333333';
  const ROLE_B = '444444444444444444';

  const withAccess = (command_access: unknown): GuildConfigFile =>
    nativeFile({ settings: { ...nativeFile().settings, command_access } as never });

  const ids = (prefix: number, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(17, '0')}`);

  it('carries a map through, in the order it was written', () => {
    const plan = planOf(
      withAccess({
        rename: { deny: { users: [USER_B, USER_A], roles: [ROLE_A] } },
        limit: { deny: { roles: [ROLE_B] } },
      }),
    );
    expect(plan.settingsPatch.command_access).toEqual({
      rename: { deny: { users: [USER_B, USER_A], roles: [ROLE_A] } },
      limit: { deny: { roles: [ROLE_B] } },
    });
  });

  it('keeps a feature id this build has never heard of', () => {
    const plan = planOf(withAccess({ somethingnew: { deny: { users: [USER_A] } } }));
    expect(plan.settingsPatch.command_access).toEqual({
      somethingnew: { deny: { users: [USER_A] } },
    });
  });

  /**
   * An empty list is the same as no list, and an entry with nothing left is not
   * worth a slot. Quietly: it is what normalising looks like, not a mistake.
   */
  it('normalises an empty list to absent and drops an entry with nothing in it', () => {
    const plan = planOf(
      withAccess({
        rename: { deny: { users: [], roles: [ROLE_A] } },
        limit: { deny: { users: [], roles: [] } },
        nick: {},
      }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { roles: [ROLE_A] } } });
    expect(noteCodes(plan)).not.toContain('setting_invalid');
  });

  it('removes a repeated id, and does not call a repeat a mistake', () => {
    const plan = planOf(withAccess({ rename: { deny: { users: [USER_A, USER_B, USER_A] } } }));
    expect(plan.settingsPatch.command_access).toEqual({
      rename: { deny: { users: [USER_A, USER_B] } },
    });
    expect(noteCodes(plan)).not.toContain('setting_invalid');
  });

  it('drops an id that is not a snowflake and says so', () => {
    const plan = planOf(
      withAccess({ rename: { deny: { users: [USER_A, 'not-an-id', 42, '12'] } } }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [USER_A] } } });
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  /** The guild id as a role is `@everyone`, which would deny the whole server. */
  it('drops the guild id from the roles, and keeps it nowhere', () => {
    const plan = planOf(withAccess({ rename: { deny: { roles: [GUILD, ROLE_A] } } }));
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { roles: [ROLE_A] } } });
    expect(noteCodes(plan)).toContain('setting_invalid');

    const only = planOf(withAccess({ rename: { deny: { roles: [GUILD] } } }));
    expect(only.settingsPatch.command_access).toBeUndefined();
  });

  /** The guild id is a legal USER id as far as shape goes: it is only a role that it denies. */
  it('does not drop the guild id from the users, since there it is just an id', () => {
    const plan = planOf(withAccess({ rename: { deny: { users: [GUILD] } } }));
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [GUILD] } } });
  });

  it('drops an entry that is not a map, or whose lists are not lists, and keeps the rest', () => {
    const plan = planOf(
      withAccess({
        rename: ['nope'],
        limit: { deny: { users: 'nope' } },
        nick: { deny: { users: [USER_A] } },
      }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ nick: { deny: { users: [USER_A] } } });
    expect(noteCodes(plan).filter((c) => c === 'setting_invalid')).toHaveLength(2);
  });

  it('refuses a value that is not a map, and a map with nothing in it', () => {
    for (const value of [['rename'], 'rename', 7, {}]) {
      const plan = planOf(withAccess(value));
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(noteCodes(plan)).toContain('setting_invalid');
    }
  });

  /**
   * Not reachable through a file: the wire schema's record drops a `__proto__` key
   * while parsing, so the validator's `fromEntries` is a precaution and this pins
   * the path a file really takes, with the entry beside it surviving.
   */
  it('never sees an entry named __proto__, which the wire schema drops while parsing', () => {
    const text = JSON.stringify(nativeFile()).replace(
      '"command_access":null',
      `"command_access":{"__proto__":{"deny":{"users":["${USER_A}"]}},"rename":{"deny":{"users":["${USER_B}"]}}}`,
    );
    expect(text).toContain('"__proto__"');
    const parsed = parseNativeFile(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const written = planOf(parsed.file).settingsPatch.command_access as Record<string, unknown>;
    expect(written).toEqual({ rename: { deny: { users: [USER_B] } } });
    expect(Object.keys(written)).toEqual(['rename']);
  });

  /** The validator keeps a feature id of 40 characters, like `control_panel`, and no more. */
  it('keeps a feature id of 40 characters and drops one of 41, with a note', () => {
    const plan = planOf(
      withAccess({
        ['a'.repeat(40)]: { deny: { users: [USER_A] } },
        ['b'.repeat(41)]: { deny: { users: [USER_B] } },
        nick: { deny: { users: [USER_B] } },
      }),
    );
    expect(plan.settingsPatch.command_access).toEqual({
      ['a'.repeat(40)]: { deny: { users: [USER_A] } },
      nick: { deny: { users: [USER_B] } },
    });
    expect(noteCodes(plan).filter((c) => c === 'setting_invalid')).toHaveLength(1);
  });

  /**
   * The writer copies an entry whole so a newer build's field survives another
   * admin's edit, and the importer does not: it is the boundary that bounds what
   * reaches the blob. Pinned so the difference is a decision, not a surprise.
   */
  it('rebuilds an entry as lists of users and roles, so a field a newer build added is not carried', () => {
    const plan = planOf(
      withAccess({ rename: { deny: { users: [USER_A], note: 'x' }, until: 1700000000 } }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [USER_A] } } });
  });

  describe('caps', () => {
    it('is bound to the numbers /restrict enforces', () => {
      expect(IMPORT_LIMITS.commandAccessUsers).toBe(50);
      expect(IMPORT_LIMITS.commandAccessRoles).toBe(25);
      expect(IMPORT_LIMITS.commandAccessTotal).toBe(150);
    });

    /** Both lists full is 150, which is also the whole-map cap, so it is exactly allowed. */
    it('accepts a feature with both lists at exactly the user and role limits', () => {
      const entry = {
        allow: {
          users: ids(1, IMPORT_LIMITS.commandAccessUsers),
          roles: ids(2, IMPORT_LIMITS.commandAccessRoles),
        },
        deny: {
          users: ids(3, IMPORT_LIMITS.commandAccessUsers),
          roles: ids(4, IMPORT_LIMITS.commandAccessRoles),
        },
      };
      const plan = planOf(withAccess({ rename: entry }));
      expect(plan.settingsPatch.command_access).toEqual({ rename: entry });
    });

    it('drops the whole key when an allow list has more users than the limit', () => {
      const plan = planOf(
        withAccess({ rename: { allow: { users: ids(1, IMPORT_LIMITS.commandAccessUsers + 1) } } }),
      );
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'setting_over_limit',
          limit: IMPORT_LIMITS.commandAccessUsers,
        }),
      );
    });

    it('drops the whole key when one feature has more users than the limit', () => {
      const plan = planOf(
        withAccess({
          nick: { deny: { users: [USER_A] } },
          rename: { deny: { users: ids(1, IMPORT_LIMITS.commandAccessUsers + 1) } },
        }),
        currentConfig({ settings: { command_access: { limit: { deny: { users: [USER_B] } } } } }),
      );
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'setting_over_limit',
          subject: 'command_access',
          limit: IMPORT_LIMITS.commandAccessUsers,
          count: IMPORT_LIMITS.commandAccessUsers + 1,
        }),
      );
    });

    it('drops the whole key when one feature has more roles than the limit', () => {
      const plan = planOf(
        withAccess({ rename: { deny: { roles: ids(2, IMPORT_LIMITS.commandAccessRoles + 1) } } }),
      );
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'setting_over_limit',
          limit: IMPORT_LIMITS.commandAccessRoles,
        }),
      );
    });

    /** Four features, each inside its own limit, together past the whole-map one. */
    it('drops the whole key when the entries add up past the total', () => {
      const full = (prefix: number) => ({
        users: ids(prefix, IMPORT_LIMITS.commandAccessUsers),
        roles: ids(prefix + 10, IMPORT_LIMITS.commandAccessRoles),
      });
      const plan = planOf(
        withAccess({
          privacy: { deny: full(1) },
          limit: { allow: full(2) },
          rename: { deny: full(3) },
        }),
      );
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'setting_over_limit',
          limit: IMPORT_LIMITS.commandAccessTotal,
          count: 3 * (IMPORT_LIMITS.commandAccessUsers + IMPORT_LIMITS.commandAccessRoles),
        }),
      );
    });

    /**
     * Every stored entry holds an id, so a real map has no more entries than the
     * total. A file of junk entries must be one note and not thousands, which would
     * ride into the audit row's list of what was dropped.
     */
    it('drops the whole key past the total in entries, with one note and not one per entry', () => {
      const junk = Object.fromEntries(
        Array.from({ length: IMPORT_LIMITS.commandAccessTotal + 1 }, (_, i) => [`feature${i}`, 7]),
      );
      const plan = planOf(withAccess(junk));
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(plan.notes).toContainEqual(
        expect.objectContaining({
          code: 'setting_over_limit',
          subject: 'command_access',
          limit: IMPORT_LIMITS.commandAccessTotal,
          count: IMPORT_LIMITS.commandAccessTotal + 1,
        }),
      );
      expect(noteCodes(plan)).not.toContain('setting_invalid');
    });

    it('counts an id once however often the file repeats it', () => {
      const repeated = Array.from({ length: 80 }, () => USER_A);
      const plan = planOf(withAccess({ rename: { deny: { users: repeated } } }));
      expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [USER_A] } } });
    });
  });

  describe('round trip', () => {
    const stored = {
      rename: { deny: { users: [USER_A], roles: [ROLE_A] } },
      nick: { deny: { users: [USER_B] } },
    };

    it('changes nothing when the file matches what is stored', () => {
      const plan = planOf(
        withAccess(stored),
        currentConfig({ settings: { command_access: stored } }),
      );
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(plan.settingsRemove).not.toContain('command_access');
    });

    it('clears the stored map when the file says it is absent', () => {
      const plan = planOf(
        withAccess(null),
        currentConfig({ settings: { command_access: stored } }),
      );
      expect(plan.settingsRemove).toContain('command_access');
    });

    it('leaves the stored map alone when an older file does not mention the key', () => {
      const file = nativeFile() as unknown as Record<string, Record<string, unknown>>;
      delete file.settings.command_access;
      const plan = planOf(file as never, currentConfig({ settings: { command_access: stored } }));
      expect(plan.settingsRemove).not.toContain('command_access');
      expect(plan.settingsPatch.command_access).toBeUndefined();
    });

    it('reads a file whose entry has a shape this build does not know, and drops that entry', () => {
      const newer = { rename: { deny: { users: { [USER_A]: 1700000000 } } } };
      const parsed = parseNativeFile(withAccess(newer));
      expect(parsed.ok).toBe(true);
      const plan = planOf(withAccess(newer));
      expect(plan.settingsPatch.command_access).toBeUndefined();
      expect(noteCodes(plan)).toContain('setting_invalid');
    });

    it('lists the features whose entries changed, by feature name', () => {
      const plan = planOf(
        withAccess({
          rename: { deny: { users: [USER_A, USER_B] } },
          limit: { deny: { roles: [ROLE_A] } },
        }),
        currentConfig({ settings: { command_access: { rename: { deny: { users: [USER_A] } } } } }),
      );
      const change = plan.settingChanges.find((c) => c.key === 'command_access');
      expect(change?.entriesChanged).toEqual(['rename']);
      expect(change?.entriesAdded).toEqual(['limit']);
    });
  });

  it('carries an allow list through beside a deny list, and both lists of one feature', () => {
    const plan = planOf(
      withAccess({
        rename: { allow: { roles: [ROLE_A] }, deny: { users: [USER_A] } },
        kick: { allow: { users: [USER_B] } },
      }),
    );
    expect(plan.settingsPatch.command_access).toEqual({
      rename: { allow: { roles: [ROLE_A] }, deny: { users: [USER_A] } },
      kick: { allow: { users: [USER_B] } },
    });
    expect(noteCodes(plan)).not.toContain('setting_invalid');
  });

  /**
   * On an allow list `@everyone` lets everyone in, which the bot reads as no allow list.
   * Dropping only the id would close the feature to everyone else, the opposite of what
   * the file says, so the whole allow list goes, with a note, and the deny list stays.
   */
  it('drops an allow list that names the everyone role, with a note, and keeps the deny list', () => {
    const plan = planOf(
      withAccess({
        rename: { allow: { users: [USER_B], roles: [GUILD, ROLE_A] }, deny: { users: [USER_A] } },
        limit: { allow: { roles: [GUILD] } },
      }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [USER_A] } } });
    expect(noteCodes(plan).filter((c) => c === 'setting_invalid')).toHaveLength(2);
  });

  /** A list it cannot read costs that list and not its neighbour, which is what the bot would read. */
  it('drops a list that is not the shape, with a note, and keeps the other list of the entry', () => {
    const plan = planOf(
      withAccess({ rename: { allow: 'nope', deny: { users: [USER_A] } }, limit: { allow: ['x'] } }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [USER_A] } } });
    expect(noteCodes(plan).filter((c) => c === 'setting_invalid')).toHaveLength(2);
  });

  /** Null is nothing stored, to the writer and the reader, so it is no mistake either. */
  it('skips a list that is null without a note', () => {
    const plan = planOf(withAccess({ rename: { allow: null, deny: { users: [USER_A] } } }));
    expect(plan.settingsPatch.command_access).toEqual({ rename: { deny: { users: [USER_A] } } });
    expect(noteCodes(plan)).not.toContain('setting_invalid');
  });

  /**
   * The bot reads the roles of a list whose users are not a list, so the import keeps
   * them: dropping the whole allow list would open a feature the bot keeps closed.
   */
  it('keeps the roles of a list whose users are not a list, with a note', () => {
    const plan = planOf(withAccess({ rename: { allow: { users: 'nope', roles: [ROLE_A] } } }));
    expect(plan.settingsPatch.command_access).toEqual({ rename: { allow: { roles: [ROLE_A] } } });
    expect(noteCodes(plan)).toContain('setting_invalid');
  });

  /** An entry with neither list holds no rule the bot reads, so it is dropped like an empty one. */
  it('drops an entry with no allow or deny list quietly', () => {
    const plan = planOf(
      withAccess({ rename: { users: [USER_A] }, nick: { deny: { users: [USER_B] } } }),
    );
    expect(plan.settingsPatch.command_access).toEqual({ nick: { deny: { users: [USER_B] } } });
  });

  /** Notes name a key and a count, never a value, and an id is a value. */
  it('never puts a denied id in a note', () => {
    const plan = planOf(
      withAccess({
        rename: { deny: { users: [USER_A, 'junk'], roles: [GUILD] } },
        limit: { deny: { users: ids(1, IMPORT_LIMITS.commandAccessUsers + 1) } },
      }),
    );
    const serialized = JSON.stringify(plan.notes);
    expect(serialized).not.toContain(USER_A);
    expect(serialized).not.toContain('junk');
    expect(serialized).not.toMatch(/\d{17,}/);
  });
});
