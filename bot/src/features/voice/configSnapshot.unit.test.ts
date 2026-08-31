import { describe, expect, it } from 'vitest';
import {
  diffGuildConfig,
  fromNativeFile,
  parseNativeFile,
  serializeGuildConfig,
  type ChannelFact,
  type CurrentConfig,
  type GuildFacts,
  type ImportPlan,
} from '@avc/core';
import { buildExportFile, type BuildExportOptions } from './configSnapshot.js';

const GUILD = '460459401086763010';
const CREATOR = '345678901234567890';
const ADOPTED = '456789012345678901';
const LOG_CHANNEL = '234567890123456789';
const CONTACT = '123456789012345678';
const APP = '479393422705426432';

const NAMES: Record<string, string> = {
  [CREATOR]: 'New session',
  [ADOPTED]: 'Lobby',
  [LOG_CHANNEL]: 'bot-log',
};

function options(over: Partial<BuildExportOptions> = {}): BuildExportOptions {
  return {
    guildId: GUILD,
    guildName: 'Example server',
    applicationId: APP,
    otherFleetsPresent: [],
    channelName: (id) => NAMES[id] ?? null,
    exportedAt: new Date('2026-08-31T12:00:00.000Z'),
    ...over,
  };
}

function facts(): GuildFacts {
  const voice = (name: string): ChannelFact => ({
    name,
    kind: 'voice',
    botCanManage: true,
    botCanRename: true,
  });
  return {
    guildId: GUILD,
    channels: new Map<string, ChannelFact>([
      [CREATOR, voice('New session')],
      [ADOPTED, voice('Lobby')],
      [LOG_CHANNEL, { name: 'bot-log', kind: 'text', botCanManage: true, botCanRename: true }],
    ]),
    members: new Map([[CONTACT, true]]),
    foreignFleetChannels: new Map(),
    applicationId: APP,
    otherFleetsPresent: [],
  };
}

/** A guild with real configuration in every shape the format has to carry. */
function configured(): CurrentConfig {
  return {
    settings: {
      enabled: true,
      general: 'Voice rooms',
      channel_name_template: '@@game_name@@ ##',
      channel_status_template: '',
      aliases: { 'Counter-Strike 2': 'CS2', Valorant: 'Val' },
      custom_nicks: { [CONTACT]: 'Greg' },
      logging: LOG_CHANNEL,
      log_level: 2,
      groups: { '@root': { above: true } },
      contact_user_id: CONTACT,
      problem_alerts: 'quiet',
    },
    creatorChannels: [
      {
        channelId: CREATOR,
        template: { name: '@@game_name@@ ##', limit: 4, above: true, defaultPrivate: false },
      },
    ],
    adoptedChannels: [
      {
        channelId: ADOPTED,
        template: { name: '__Lobby/@@creator@@ room__' },
        state: { seed: 812345, name: 'Lobby', roster: [CONTACT] },
      },
    ],
  };
}

/** An empty guild: nothing configured, no channels registered. */
function empty(): CurrentConfig {
  return { settings: {}, creatorChannels: [], adoptedChannels: [] };
}

function planFor(from: CurrentConfig, onto: CurrentConfig): ImportPlan {
  const file = buildExportFile(from, options());
  // Through the wire and back, so the test exercises serialization too.
  const parsed = parseNativeFile(JSON.parse(serializeGuildConfig(file)));
  expect(parsed.ok, parsed.ok ? '' : `the file did not validate: ${parsed.reason}`).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);

  const result = diffGuildConfig(fromNativeFile(parsed.file), onto, facts());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`refused: ${result.refusals.map((r) => r.code).join(', ')}`);
  return result.plan;
}

/**
 * Applies a plan to a config, the way the real apply does, so the round trip can
 * be asserted end to end.
 */
function apply(current: CurrentConfig, plan: ImportPlan): CurrentConfig {
  const settings = { ...current.settings, ...plan.settingsPatch };
  for (const key of plan.settingsRemove) delete settings[key];

  const creators = new Map(current.creatorChannels.map((c) => [c.channelId, { ...c }]));
  for (const id of plan.creatorRemovals) creators.delete(id);
  for (const write of plan.creatorWrites) {
    creators.set(write.channelId, { channelId: write.channelId, template: write.template });
  }

  const adopted = new Map(current.adoptedChannels.map((c) => [c.channelId, { ...c }]));
  for (const id of plan.adoptedRemovals) adopted.delete(id);
  for (const write of plan.adoptedWrites) {
    adopted.set(write.channelId, {
      channelId: write.channelId,
      template: write.template,
      state: write.state,
    });
  }

  return {
    settings,
    creatorChannels: [...creators.values()],
    adoptedChannels: [...adopted.values()],
  };
}

describe('buildExportFile', () => {
  it('emits every settings key, using null for the ones the guild has not set', () => {
    const file = buildExportFile(empty(), options());
    expect(Object.values(file.settings).every((v) => v === null)).toBe(true);
    expect(Object.keys(file.settings)).toHaveLength(11);
  });

  it('emits every template field, using null for the ones the row omits', () => {
    const file = buildExportFile(configured(), options());
    const template = file.creator_channels[0]!.template;
    expect(Object.keys(template).sort()).toEqual([
      'above',
      'defaultPrivate',
      'inheritperms',
      'limit',
      'name',
      'status',
    ]);
    // Stored row has no `status`, so the wire value is null, not `''`.
    expect(template.status).toBeNull();
    expect(template.inheritperms).toBeNull();
  });

  /**
   * The distinction the whole format exists for. This guild stored `''` for the
   * server status template, which means "no status at all", and null would mean
   * "use the default". Collapsing them loses voice statuses on every room.
   */
  it('keeps an empty string distinct from an absent value', () => {
    const file = buildExportFile(configured(), options());
    expect(file.settings.channel_status_template).toBe('');
    expect(file.settings.general).toBe('Voice rooms');
  });

  it('carries the adopted seed and last rendered name, and never the roster', () => {
    const state = buildExportFile(configured(), options()).adopted_channels[0]!.state;
    expect(state.seed).toBe(812345);
    expect(state.name).toBe('Lobby');
    expect(state).not.toHaveProperty('roster');
  });

  it('carries a channel name for legibility', () => {
    const file = buildExportFile(configured(), options());
    expect(file.creator_channels[0]!.channel_name).toBe('New session');
    expect(file.adopted_channels[0]!.channel_name).toBe('Lobby');
  });

  it('says so when the file is only one fleet view of the guild', () => {
    const file = buildExportFile(configured(), options({ otherFleetsPresent: ['beta'] }));
    expect(file.source_fleet_channel_scope).toContain('another AVC bot');
  });

  /** Expand/contract: an old build must not drop a field a new one wrote. */
  it('carries a template field it does not know about', () => {
    const current = configured();
    current.creatorChannels[0]!.template.someFutureField = 'keep me';
    const file = buildExportFile(current, options());
    expect(file.creator_channels[0]!.template).toMatchObject({ someFutureField: 'keep me' });
  });

  it('is legible: two-space indent and a trailing newline', () => {
    const text = serializeGuildConfig(buildExportFile(configured(), options()));
    expect(text).toContain('\n  "guild_id"');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('the round trip', () => {
  /**
   * The claim decision 13 rests on. Exporting a guild and importing the file
   * back must be a no-op, or the "undo" attached to every import is a lie.
   */
  it('changes nothing when a guild imports its own export', () => {
    const plan = planFor(configured(), configured());
    expect(plan.settingsPatch).toEqual({});
    expect(plan.settingsRemove).toEqual([]);
    expect(plan.creatorWrites).toEqual([]);
    expect(plan.creatorRemovals).toEqual([]);
    expect(plan.adoptedWrites).toEqual([]);
    expect(plan.adoptedRemovals).toEqual([]);
    expect(plan.changed).toBe(false);
  });

  it('changes nothing when an empty guild imports its own export', () => {
    expect(planFor(empty(), empty()).changed).toBe(false);
  });

  /**
   * The undo, in full. A snapshot of the guild BEFORE an import, applied to the
   * guild AFTER it, has to restore the original exactly: the settings, the keys
   * that were absent, the templates, and the channel rows the import added.
   */
  it('restores the original exactly, including keys that were absent', () => {
    const before = empty();
    const after = configured();

    const restored = apply(after, planFor(before, after));

    expect(restored.settings).toEqual({});
    expect(restored.creatorChannels).toEqual([]);
    expect(restored.adoptedChannels).toEqual([]);
  });

  it('restores a configured guild from a wiped one', () => {
    const before = configured();
    const after = empty();

    const restored = apply(after, planFor(before, after));

    expect(restored.settings).toEqual(before.settings);
    expect(restored.creatorChannels).toEqual(before.creatorChannels);
    // The roster is not carried, so it comes back empty rather than wrong.
    expect(restored.adoptedChannels[0]?.template).toEqual(before.adoptedChannels[0]?.template);
    expect(restored.adoptedChannels[0]?.state).toMatchObject({ seed: 812345, name: 'Lobby' });
  });

  /**
   * The half an "omit what is unset" format could not do. Reverting an import
   * that SET a key requires removing it, not writing a default over it.
   */
  it('undoes a key the import added by removing it, not by writing a default', () => {
    const before = empty();
    const after: CurrentConfig = {
      ...empty(),
      settings: { logging: LOG_CHANNEL, log_level: 3, general: 'Imported' },
    };

    const plan = planFor(before, after);
    expect(plan.settingsRemove.sort()).toEqual(['general', 'log_level', 'logging']);
    expect(plan.settingsPatch).toEqual({});
    expect(apply(after, plan).settings).toEqual({});
  });

  it('survives two round trips unchanged', () => {
    const once = buildExportFile(configured(), options());
    const parsed = parseNativeFile(JSON.parse(serializeGuildConfig(once)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const applied = apply(empty(), planFor(configured(), empty()));
    const twice = buildExportFile(applied, options());
    expect(twice.settings).toEqual(once.settings);
    expect(twice.creator_channels).toEqual(once.creator_channels);
  });
});
