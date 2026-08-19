import type {
  AutoChannelRepository,
  AutoChannelRow,
  GuildSettingsStore,
  Logger,
  PrimaryTemplate,
  SecondaryChannelRepository,
} from '@avc/core';
import type { VoiceActions } from './actions.js';
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from './nameTemplate.js';
import { MAX_USER_LIMIT } from './commands.js';
import {
  SETTINGS_KEYS,
  isSnowflake,
  isStringMap,
  parseVoiceSettings,
  readContact,
  readGroups,
  readLogging,
} from './guildSettings.js';
import type { GroupConfig } from './guildSettings.js';
import { type CommandResult } from './commands.js';

/** Logging verbosity levels (legacy parity): 1 lifecycle, 2 changes, 3 joins/leaves. */
export type LogLevel = 1 | 2 | 3;

const ok = (message: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

/** The default name for a freshly-created primary ("creator") channel. */
export const DEFAULT_PRIMARY_NAME = '➕ New Session';

/** Options for creating a primary (the `/create` setup modal collects these). */
export interface CreatePrimaryOptions {
  name?: string;
  parentId?: string;
  nameTemplate?: string;
  statusTemplate?: string;
  /** Position spawned secondaries above the primary; default (false/unset) is below. */
  above?: boolean;
  /** Make spawned secondaries private on creation; default (false/unset) is public. */
  defaultPrivate?: boolean;
}

/** A normalized read-model of a guild's voice configuration, for the panel. */
export interface GuildConfig {
  enabled: boolean;
  general: string;
  defaultTemplate: string;
  defaultStatus: string;
  aliases: Record<string, string>;
  primaries: { channelId: string; template: string; limit: number }[];
}

export interface GuildSettingsServiceDeps {
  guilds: GuildSettingsStore;
  autoChannels: AutoChannelRepository;
  secondaries: SecondaryChannelRepository;
  actions: VoiceActions;
  logger: Logger;
}

/** Valid `/inheritpermissions` modes (plus an arbitrary channel id). */
const INHERIT_MODES: Record<string, string> = {
  primary: 'primary',
  parent: 'primary',
  category: 'category',
};

/**
 * Admin-facing guild configuration, ported from the legacy server-config
 * commands (`enable`/`disable`, `general`, `template`, `defaultlimit`,
 * `alias`/`removealias`, `create`). Drives the `/settings` panel. Pure logic
 * over the repositories + the action seam, so it's testable with the fakes.
 *
 * Callers must enforce the "manage server/channels" permission gate before
 * invoking these (the interaction layer does so).
 */
export class GuildSettingsService {
  constructor(private readonly deps: GuildSettingsServiceDeps) {}

  /**
   * Records who most recently set up a creator channel or its template.
   *
   * Restores the legacy bot's `server_contact`. It exists to answer "who do I
   * talk to when this guild's automation is broken", and the person who
   * configured it beats the server owner, who frequently has never touched it.
   *
   * **Reads before writing, and returns early when unchanged.** The shape is
   * borrowed from `recordIdentity`, though the reason is stronger here: that one
   * writes columns through the raw repository and never notifies, while this
   * writes the settings blob through the cache, so a blind repeat would bump
   * `updated_at` AND evict that guild's settings on every instance in the fleet
   * for no change at all. These call sites repeat freely (re-opening a template
   * panel and saving the same thing).
   *
   * Never throws. This is bookkeeping hung off a user action that has already
   * succeeded, so failing it must not fail the action. It also deliberately
   * sits OUTSIDE the per-guild dispatcher, unlike every sibling call in the
   * command layer: a failure here must not count against the guild's circuit
   * breaker. The cost of that choice is that it misses `onTaskFailure`, so the
   * `errors` metric never sees it, which is why the log below is `warn` and not
   * `debug` -- it is the only signal a broken contact write produces anywhere.
   */
  async recordContact(guildId: string, userId: string): Promise<void> {
    try {
      if (!isSnowflake(userId)) return;
      const guild = await this.deps.guilds.ensure(guildId);
      if (readContact(guild.settings) === userId) return;
      await this.deps.guilds.updateSettings(guildId, { [SETTINGS_KEYS.contact]: userId });
    } catch (err) {
      this.deps.logger.warn({ err, guildId }, 'could not record the server contact');
    }
  }

  async getConfig(guildId: string): Promise<GuildConfig> {
    const guild = await this.deps.guilds.ensure(guildId);
    const s = parseVoiceSettings(guild.settings);
    const primaries = await this.deps.autoChannels.listByGuild(guildId);
    return {
      enabled: s.enabled,
      general: s.general,
      defaultTemplate: s.channelNameTemplate,
      defaultStatus: s.channelStatusTemplate,
      aliases: s.aliases,
      primaries: primaries.map((p) => toPrimaryView(p)),
    };
  }

  async setEnabled(guildId: string, enabled: boolean): Promise<CommandResult> {
    await this.deps.guilds.updateSettings(guildId, { enabled });
    return ok(
      enabled
        ? 'Channel automation is now **enabled**.'
        : 'Channel automation is now **disabled**.',
    );
  }

  async setGeneral(guildId: string, word: string): Promise<CommandResult> {
    const value = word.trim();
    if (!value) return fail('Provide a word to use when no game is detected.');
    await this.deps.guilds.updateSettings(guildId, { general: value });
    return ok(`The “no game” label is now **${value}**.`);
  }

  async addAlias(guildId: string, game: string, alias: string): Promise<CommandResult> {
    const g = game.trim();
    const a = alias.trim();
    if (!g || !a) return fail('Provide both a game name and an alias.');
    const config = await this.getConfig(guildId);
    const aliases = { ...config.aliases, [g]: a };
    await this.deps.guilds.updateSettings(guildId, { aliases });
    return ok(`Alias added: **${g}** → **${a}**`);
  }

  /** Creates a Discord voice channel and registers it as a primary. */
  async createPrimary(guildId: string, opts: CreatePrimaryOptions = {}): Promise<CommandResult> {
    const name = opts.name?.trim() || DEFAULT_PRIMARY_NAME;
    const channelId = await this.deps.actions.createVoiceChannel({
      guildId,
      name,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    });
    // Only persist non-default fields so the primary inherits where unset. Below
    // is the default placement, so only an explicit "above" is stored.
    const template: PrimaryTemplate = {
      ...(opts.nameTemplate ? { name: opts.nameTemplate } : {}),
      ...(opts.statusTemplate ? { status: opts.statusTemplate } : {}),
      ...(opts.above === true ? { above: true } : {}),
      ...(opts.defaultPrivate === true ? { defaultPrivate: true } : {}),
    };
    await this.deps.autoChannels.upsert(guildId, channelId, template);
    this.deps.logger.info({ guildId, channelId, name }, 'created primary channel');
    return ok(
      `Created **${name}**. Join it to spawn a voice channel.\n` +
        'Edit it anytime with `/template`, `/position`, `/defaultlimit`, …',
    );
  }

  /**
   * Sets the name template for the primary of the channel you're in — the
   * default for all of that creator channel's secondaries (legacy `/template`).
   * `reset`/empty clears it, falling back to the server-default template.
   */
  setTemplate(
    guildId: string,
    secondaryChannelId: string,
    template: string,
  ): Promise<CommandResult> {
    return this.setPrimaryField(guildId, secondaryChannelId, 'name', template);
  }

  /** Sets the voice-status template for the primary of the channel you're in. */
  setStatusTemplate(
    guildId: string,
    secondaryChannelId: string,
    template: string,
  ): Promise<CommandResult> {
    return this.setPrimaryField(guildId, secondaryChannelId, 'status', template);
  }

  /** Shared per-primary template setter for the name + status templates. */
  private async setPrimaryField(
    guildId: string,
    secondaryChannelId: string,
    field: 'name' | 'status',
    template: string,
  ): Promise<CommandResult> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return fail('You need to be in a bot-managed voice channel.');
    const value = template.trim().replace(/[\r\n]+/g, ' ');
    // A blank name template is invalid (resets to the default); a blank status
    // template is a legitimate "no status", so only `reset` clears the status.
    const isReset = value.toLowerCase() === 'reset' || (field === 'name' && value === '');
    const next = { ...primary.template };
    if (isReset) {
      delete next[field];
      await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
      return ok(`Reset this creator channel’s ${field} template to the default.`);
    }
    next[field] = value;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
    if (field === 'status' && value === '') {
      return ok('New channels from this creator will show no status (blank).');
    }
    return ok(
      field === 'name'
        ? `New channels from this creator will be named:\n\`${value}\``
        : `New channels from this creator will show the status:\n\`${value}\``,
    );
  }

  /** Sets (or resets) a member's custom display name for `@@creator@@`. `/nick`. */
  async setNick(guildId: string, userId: string, name: string): Promise<CommandResult> {
    const guild = await this.deps.guilds.ensure(guildId);
    const nicks = isStringMap(guild.settings.custom_nicks)
      ? { ...guild.settings.custom_nicks }
      : {};
    const value = name.trim();
    if (value.toLowerCase() === 'reset' || value === '') {
      delete nicks[userId];
      await this.deps.guilds.updateSettings(guildId, { custom_nicks: nicks });
      return ok('Removed your custom nickname.');
    }
    nicks[userId] = value;
    await this.deps.guilds.updateSettings(guildId, { custom_nicks: nicks });
    return ok(`Channels that show the creator will now call you **${value}**.`);
  }

  /** Reads whether the primary of the channel you're in spawns secondaries above. */
  async getPosition(
    guildId: string,
    secondaryChannelId: string,
  ): Promise<{ found: boolean; above: boolean; primaryChannelId?: string }> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return { found: false, above: false };
    return {
      found: true,
      above: primary.template.above === true,
      primaryChannelId: primary.channelId,
    };
  }

  /** Sets whether new secondaries are positioned above (else below) their primary. */
  async setPosition(
    guildId: string,
    secondaryChannelId: string,
    above: boolean,
  ): Promise<CommandResult> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return fail('You need to be in a bot-managed voice channel.');
    const next = { ...primary.template };
    // Below is the default, so store nothing for it; only persist an explicit "above".
    if (above) next.above = true;
    else delete next.above;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
    return ok(
      `New channels here will now be positioned **${above ? 'above' : 'below'}** the creator channel.`,
    );
  }

  /** Reads a category's grouping config (or `undefined` when it isn't grouped). `/group`. */
  async getGroup(guildId: string, categoryKey: string): Promise<GroupConfig | undefined> {
    const guild = await this.deps.guilds.ensure(guildId);
    return readGroups(guild.settings)[categoryKey];
  }

  /**
   * Enables grouping for a category (`above` = the single direction) or disables it
   * (`above === null` → removes the entry). Persists only; the caller renumbers and
   * repositions the category via `VoiceFeature.resyncCategory`.
   */
  async setGroup(guildId: string, categoryKey: string, above: boolean | null): Promise<void> {
    const guild = await this.deps.guilds.ensure(guildId);
    const groups = { ...readGroups(guild.settings) };
    if (above === null) delete groups[categoryKey];
    else groups[categoryKey] = { above };
    await this.deps.guilds.updateSettings(guildId, { groups });
  }

  /**
   * Toggles whether new secondaries of the primary you're in are made private on
   * creation (legacy had no equivalent; `/alwaysprivate`). Returns the new state
   * in its reply. Stores nothing for the default (public) so primaries stay lean.
   */
  async toggleDefaultPrivate(guildId: string, secondaryChannelId: string): Promise<CommandResult> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return fail('You need to be in a bot-managed voice channel.');
    const enabled = primary.template.defaultPrivate !== true;
    const next = { ...primary.template };
    if (enabled) next.defaultPrivate = true;
    else delete next.defaultPrivate;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
    return ok(
      enabled
        ? '🔒 New channels from this creator will be created **private** automatically.'
        : '🔓 New channels from this creator will be created **public** (the default).',
    );
  }

  /**
   * Sets the default user limit applied to channels this creator spawns.
   * `/defaultlimit`.
   *
   * The plumbing already existed and had no writer: `handler.ts` passes
   * `primary.template.limit` straight into `createVoiceChannel`, but nothing
   * ever set it, so every spawned channel came out unlimited. The legacy Python
   * bot had `defaultlimit` and 446 primaries across 180 live guilds still use
   * it (`plans/migration.md` §2.1), so the importer writes the field and this is
   * how an admin changes it afterwards. Without this command those guilds would
   * carry a limit they could not edit or remove.
   *
   * `0` clears it, matching Discord's own meaning for a user limit of zero and
   * `/unlimit` on an individual channel.
   */
  async setDefaultLimit(
    guildId: string,
    secondaryChannelId: string,
    limit: number,
  ): Promise<CommandResult> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return fail('You need to be in a bot-managed voice channel.');
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
      return fail(
        `Pick a limit between 0 and ${MAX_USER_LIMIT}. Discord does not allow more, and 0 means no limit.`,
      );
    }

    const next = { ...primary.template };
    if (limit > 0) next.limit = limit;
    else delete next.limit;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);

    return ok(
      limit > 0
        ? `👥 New channels from this creator will hold **${limit}** ${limit === 1 ? 'person' : 'people'}. Existing channels keep their current limit.`
        : '👥 New channels from this creator will have **no user limit**. Existing channels keep their current limit.',
    );
  }

  /** Sets how new secondaries inherit permissions. `/inheritpermissions`. */
  async setInheritPermissions(
    guildId: string,
    secondaryChannelId: string,
    mode: string,
  ): Promise<CommandResult> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return fail('You need to be in a bot-managed voice channel.');
    const normalized = INHERIT_MODES[mode.toLowerCase()] ?? (/^\d+$/.test(mode) ? mode : undefined);
    if (!normalized) {
      return fail('Use `primary`, `category`, or a voice-channel id to copy permissions from.');
    }
    await this.deps.autoChannels.upsert(guildId, primary.channelId, {
      ...primary.template,
      inheritperms: normalized,
    });
    return ok(`New channels here will inherit permissions from **${normalized}**.`);
  }

  /** Reads the current logging configuration (for pre-filling the `/logging` modal). */
  async getLogging(
    guildId: string,
  ): Promise<{ enabled: boolean; level: LogLevel; channelId: string | null }> {
    const guild = await this.deps.guilds.ensure(guildId);
    return readLogging(guild.settings);
  }

  /** Configures the per-guild logging channel + level, or turns logging off. */
  async setLogging(
    guildId: string,
    target: string | null,
    level: LogLevel,
  ): Promise<CommandResult> {
    if (target === null) {
      await this.deps.guilds.updateSettings(guildId, { logging: false });
      return ok('📕 Event logging is now disabled.');
    }
    await this.deps.guilds.updateSettings(guildId, { logging: target, log_level: level });
    return ok(`📗 Logging events (level **${level}**) to <#${target}>.`);
  }

  private async primaryFor(
    guildId: string,
    secondaryChannelId: string,
  ): Promise<AutoChannelRow | undefined> {
    const secondary = await this.deps.secondaries.get(secondaryChannelId);
    if (!secondary || secondary.guildId !== guildId) return undefined;
    const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
    return primary && primary.guildId === guildId ? primary : undefined;
  }
}

function toPrimaryView(p: AutoChannelRow): { channelId: string; template: string; limit: number } {
  return {
    channelId: p.channelId,
    template: p.template.name ?? DEFAULT_CHANNEL_NAME_TEMPLATE,
    limit: p.template.limit ?? 0,
  };
}
