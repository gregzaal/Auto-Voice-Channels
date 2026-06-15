import type {
  AutoChannelRepository,
  AutoChannelRow,
  GuildRepository,
  Logger,
  PrimaryTemplate,
  SecondaryChannelRepository,
} from '@avc/core';
import type { VoiceActions } from './actions.js';
import { DEFAULT_CHANNEL_NAME_TEMPLATE, DEFAULT_STATUS_TEMPLATE } from './nameTemplate.js';
import { MAX_USER_LIMIT, type CommandResult } from './commands.js';

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
  guilds: GuildRepository;
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

  async getConfig(guildId: string): Promise<GuildConfig> {
    const guild = await this.deps.guilds.ensure(guildId);
    const s = guild.settings;
    const primaries = await this.deps.autoChannels.listByGuild(guildId);
    return {
      enabled: s.enabled !== false,
      general: typeof s.general === 'string' ? s.general : 'General',
      defaultTemplate:
        typeof s.channel_name_template === 'string'
          ? s.channel_name_template
          : DEFAULT_CHANNEL_NAME_TEMPLATE,
      defaultStatus:
        typeof s.channel_status_template === 'string'
          ? s.channel_status_template
          : DEFAULT_STATUS_TEMPLATE,
      aliases: isStringMap(s.aliases) ? s.aliases : {},
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

  async setDefaultTemplate(guildId: string, template: string): Promise<CommandResult> {
    const value = template.trim().replace(/[\r\n]+/g, ' ');
    if (!value) return fail('The template cannot be empty.');
    await this.deps.guilds.updateSettings(guildId, { channel_name_template: value });
    return ok(`Default channel-name template set to:\n\`${value}\``);
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

  /** Removes an alias matched by either its game key or its alias value. */
  async removeAlias(guildId: string, name: string): Promise<CommandResult> {
    const needle = name.trim();
    const config = await this.getConfig(guildId);
    const aliases = { ...config.aliases };
    const keys = Object.keys(aliases).filter((k) => k === needle || aliases[k] === needle);
    if (keys.length === 0) return fail(`No alias matching **${needle}**.`);
    for (const k of keys) delete aliases[k];
    await this.deps.guilds.updateSettings(guildId, { aliases });
    return ok(
      `Removed ${keys.length} alias${keys.length === 1 ? '' : 'es'} matching **${needle}**.`,
    );
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
    };
    await this.deps.autoChannels.upsert(guildId, channelId, template);
    this.deps.logger.info({ guildId, channelId, name }, 'created primary channel');
    return ok(
      `Created **${name}**. Join it to spawn a voice channel.\n` +
        'Edit it anytime with `/template`, `/position`, `/defaultlimit`, …',
    );
  }

  async removePrimary(guildId: string, channelId: string): Promise<CommandResult> {
    const primary = await this.deps.autoChannels.get(channelId);
    if (!primary || primary.guildId !== guildId) return fail('That isn’t a creator channel here.');
    await this.deps.autoChannels.remove(channelId);
    await this.deps.actions.deleteChannel(guildId, channelId);
    return ok('Removed the creator channel.');
  }

  async setPrimaryTemplate(
    guildId: string,
    channelId: string,
    template: string,
  ): Promise<CommandResult> {
    const primary = await this.deps.autoChannels.get(channelId);
    if (!primary || primary.guildId !== guildId) return fail('That isn’t a creator channel here.');
    const value = template.trim().replace(/[\r\n]+/g, ' ');
    if (!value) return fail('The template cannot be empty.');
    await this.deps.autoChannels.upsert(guildId, channelId, { ...primary.template, name: value });
    return ok(`Template for this creator channel set to:\n\`${value}\``);
  }

  async setPrimaryLimit(guildId: string, channelId: string, limit: number): Promise<CommandResult> {
    const primary = await this.deps.autoChannels.get(channelId);
    if (!primary || primary.guildId !== guildId) return fail('That isn’t a creator channel here.');
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
      return fail(`The limit must be a whole number between 0 and ${MAX_USER_LIMIT}.`);
    }
    await this.deps.autoChannels.upsert(guildId, channelId, { ...primary.template, limit });
    return ok(
      limit === 0
        ? 'New channels from this creator will be unlimited.'
        : `New channels from this creator will default to a limit of ${limit}.`,
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
    const next = { ...primary.template };
    if (value.toLowerCase() === 'reset' || value === '') {
      delete next[field];
      await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
      return ok(`Reset this creator channel’s ${field} template to the default.`);
    }
    next[field] = value;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
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
    const s = guild.settings;
    const channelId = typeof s.logging === 'string' ? s.logging : null;
    const level: LogLevel = s.log_level === 2 || s.log_level === 3 ? s.log_level : 1;
    return { enabled: channelId !== null, level, channelId };
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

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}
