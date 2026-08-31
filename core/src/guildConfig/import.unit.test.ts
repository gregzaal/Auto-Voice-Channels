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
import {
  diffGuildConfig,
  fromLegacyPlan,
  fromNativeFile,
  IMPORT_LIMITS,
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

  it('refuses a file missing a settings key, rather than reading it as untouched', () => {
    const file = nativeFile() as unknown as Record<string, Record<string, unknown>>;
    delete file.settings.problem_alerts;
    const result = parseNativeFile(file);
    expect(result.ok).toBe(false);
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
   * The hard requirement in §5.5, and the whole reason replace is safe to offer:
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
   * §5.5a: a native file is a complete-state document, so a row it omits is one
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
   * §5.6 defect (a), the one that was live on the headline path. `planGuild`
   * structurally cannot emit `status` or `defaultPrivate`, and
   * `autoChannels.upsert` writes the whole column, so a wholesale write would
   * silently clear the voice-status template and `/alwaysprivate` on every
   * creator channel the file names. Days later, with no way to tell why.
   */
  it('leaves status and defaultPrivate alone, because the legacy format cannot express them', () => {
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
            template: { name: 'Room ##', status: 'Playing @@game_name@@', defaultPrivate: true },
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
    expect(imports).toEqual(['./format.js']);
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
