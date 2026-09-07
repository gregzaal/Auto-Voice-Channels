import { sameSettingsValue } from '@avc/core';
import type {
  AutoChannelRepository,
  AutoChannelRow,
  GuildSettingsStore,
  Logger,
  PrimaryTemplate,
  SecondaryChannelRepository,
} from '@avc/core';
import type { VoiceActions } from './actions.js';
import {
  canonicalTimeZone,
  DEFAULT_CHANNEL_NAME_TEMPLATE,
  isValidListName,
  LIST_NAME_MAX,
  MAX_CHANNEL_NAME_LENGTH,
} from './nameTemplate.js';
import { MAX_USER_LIMIT } from './commands.js';
import {
  SETTINGS_KEYS,
  isSnowflake,
  isStringMap,
  parseVoiceSettings,
  readContact,
  readGroups,
  readLogging,
  readProblemAlerts,
  problemAlertConfirmation,
  timeZoneConfirmation,
} from './guildSettings.js';
import type { GroupConfig, ProblemAlertMode } from './guildSettings.js';
import type { GameNameMode } from './nameTemplate.js';
import { type CommandResult } from './commands.js';

/** Logging verbosity levels (legacy parity): 1 lifecycle, 2 changes, 3 joins/leaves. */
export type LogLevel = 1 | 2 | 3;

const ok = (message: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

/**
 * Most game aliases one guild may hold.
 *
 * The map lives in the guild's `settings` blob, which every instance keeps in
 * memory and re-parses on every channel render, so it needs a ceiling. The
 * largest real guild has 23, so this is over four times the observed maximum.
 */
export const MAX_ALIASES = 100;

/**
 * Most named `[[list:name]]` pools one guild may hold.
 *
 * 25 because that is what one Discord select menu shows, so the `/setup` panel
 * needs no pagination and can never present a list an admin cannot reach.
 * Raising it means adding paging, not raising the number.
 */
export const MAX_LISTS = 25;

/**
 * Most options one list may hold, and the longest one option may be.
 *
 * The whole point of a named list is holding more choices than fit in a
 * template, so the ceiling is about memory rather than about the feature: every
 * instance that has served the guild keeps the settings blob resident. 25 lists
 * of 100 options at 100 characters is a ~250 KB worst case, which is the same
 * order as the `customNicks` cap already allows.
 */
export const MAX_LIST_OPTIONS = 100;
export const MAX_LIST_OPTION_LENGTH = 100;

/**
 * Total characters one list may hold, counting the newline between options.
 *
 * Matched to `LIST_OPTIONS_INPUT_MAX`, the cap Discord puts on the paragraph
 * input the edit modal prefills. Without it the two caps disagree: 100 options
 * of 100 characters is ~10k, the modal would only ever hold the first 4000, and
 * an admin who opened Edit and pressed Save without typing anything would
 * silently drop every option past the cut and truncate the one it landed in.
 * A stored list has to be editable by the surface that stores it.
 */
export const MAX_LIST_TOTAL_LENGTH = 4000;

/**
 * Own-property test for a user-typed key.
 *
 * `in` walks the prototype chain, and an alias key is a game name, so a guild
 * with a game called `constructor` or `toString` would otherwise read as having
 * an alias it does not have (and `delete` on the inherited key does nothing).
 * The same trap is documented in the importer's `unionKeepingExisting`.
 */
const has = (map: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

/** The same own-property test for the lists map, whose keys are admin-typed too. */
const hasList = (map: Record<string, string[]>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

/** The default name for a freshly-created creator channel. */
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
  /** Named `[[list:name]]` pools. */
  lists: Record<string, string[]>;
  /** The guild's IANA zone, absent when never set (date tokens then use UTC). */
  timezone?: string;
  /** How `@@game_name@@` resolves a tie for most-played game. */
  gameNameMode: GameNameMode;
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
   * Restores the legacy bot's `server_contact`: answers "who do I talk to
   * when this guild's automation is broken", and the person who configured
   * it beats the server owner, who frequently has never touched it.
   *
   * **Reads before writing, and returns early when unchanged.** This writes
   * the settings blob through the cache, so a blind repeat would bump
   * `updated_at` AND evict that guild's settings fleet-wide for no change at
   * all - these call sites repeat freely (re-opening a template panel and
   * saving the same thing).
   *
   * Never throws: this is bookkeeping hung off a user action that already
   * succeeded, so failing it must not fail the action. Deliberately sits
   * OUTSIDE the per-guild dispatcher too, so a failure here never counts
   * against the guild's circuit breaker, which also means it misses
   * `onTaskFailure` and the `errors` metric, so the log below is `warn`, not
   * `debug`: it's the only signal a broken contact write produces anywhere.
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
      gameNameMode: s.gameNameMode,
      aliases: s.aliases,
      lists: s.lists,
      primaries: primaries.map((p) => toPrimaryView(p)),
      ...(s.timezone !== undefined ? { timezone: s.timezone } : {}),
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
    return ok(`The "no game" label is now **${value}**.`);
  }

  /**
   * How `@@game_name@@` resolves a tie for most-played game.
   *
   * Deliberately does NOT re-render, matching `setGeneral`. This is guild-wide,
   * so a fan-out would rename every managed channel in the guild at once; the
   * five-minute safety-net sweep already re-renders on drift and paces the wave
   * within the per-channel rename budget.
   */
  async setGameNameMode(guildId: string, mode: GameNameMode): Promise<CommandResult> {
    await this.deps.guilds.updateSettings(guildId, {
      [SETTINGS_KEYS.gameNameMode]: mode,
    });
    return ok(
      mode === 'top'
        ? 'Room names now pick one game when several are tied.'
        : 'Room names now show both games when two are tied.',
    );
  }

  /**
   * Sets, or clears, the zone the date and time tokens render in.
   *
   * Stored canonicalised, so `europe/amsterdam` reads back as
   * `Europe/Amsterdam` and the deprecated alias `Japan` reads back as
   * `Asia/Tokyo`. An empty submit REMOVES the key rather than writing `'UTC'`:
   * the two are the same render and a different fact, and `/setup` says "not
   * set" only for the absent one (`plans/name-tokens.md` §10.1).
   */
  async setTimeZone(guildId: string, raw: string, now = new Date()): Promise<CommandResult> {
    const value = raw.trim();
    if (value === '') {
      return this.deps.guilds.mergeSettings(guildId, () => ({
        patch: {},
        remove: [SETTINGS_KEYS.timezone],
        result: ok('Time zone cleared. Date and time tokens will use UTC until one is set again.'),
      }));
    }
    const zone = canonicalTimeZone(value);
    if (zone === null) {
      return fail(
        `**${value}** is not a time zone I recognise. Use a region and city, like ` +
          '`Europe/Amsterdam` or `America/New_York`. A plain offset like `+02:00` will not ' +
          'work, because it cannot follow daylight saving.',
      );
    }
    await this.deps.guilds.updateSettings(guildId, { [SETTINGS_KEYS.timezone]: zone });
    return ok(timeZoneConfirmation(zone, now));
  }

  /**
   * Read-modify-write on the named lists, under the row lock, for the same
   * reason `editAliases` is: the panel reads and writes the same map, and two
   * fleets already share 35 guilds.
   */
  private editLists(
    guildId: string,
    decide: (
      current: Record<string, string[]>,
    ) => { lists: Record<string, string[]> } | CommandResult,
  ): Promise<CommandResult> {
    return this.deps.guilds.mergeSettings(guildId, (existing) => {
      const current = parseVoiceSettings(existing?.settings ?? {}).lists;
      const decided = decide(current);
      if ('lists' in decided) return { patch: { lists: decided.lists }, result: ok('') };
      return { patch: {}, result: decided };
    });
  }

  /** Every named list this guild has. A COPY, for the reason `listAliases` documents. */
  async listNamedLists(guildId: string): Promise<Record<string, string[]>> {
    const guild = await this.deps.guilds.ensure(guildId);
    const lists = parseVoiceSettings(guild.settings).lists;
    return Object.fromEntries(Object.entries(lists).map(([name, options]) => [name, [...options]]));
  }

  /**
   * Adds or replaces one named list, renaming it when the name changed.
   *
   * A rename is a delete plus a set in ONE write, so the old name can never be
   * left behind by a failure between two writes. `previousName` is the exact
   * stored key the panel opened, absent when this is a new list.
   */
  async setNamedList(
    guildId: string,
    name: string,
    options: readonly string[],
    previousName?: string,
  ): Promise<CommandResult> {
    if (!isValidListName(name)) {
      return fail(
        `**${name || 'That'}** cannot be a list name. Up to ${LIST_NAME_MAX} characters, and ` +
          'no `[`, `]`, `/` or `:`, because those are what a template uses to find the list.',
      );
    }
    if (options.length === 0) return fail('Give the list at least one option, one per line.');
    if (options.length > MAX_LIST_OPTIONS) {
      return fail(
        `A list can hold up to ${MAX_LIST_OPTIONS} options. That one has ${options.length}.`,
      );
    }
    const total = options.reduce((sum, o) => sum + o.length + 1, -1);
    if (total > MAX_LIST_TOTAL_LENGTH) {
      return fail(
        `That list is ${total} characters all together, and one list can hold ` +
          `${MAX_LIST_TOTAL_LENGTH}. Split it into two lists, or shorten the options.`,
      );
    }
    const tooLong = options.find((o) => o.length > MAX_LIST_OPTION_LENGTH);
    if (tooLong !== undefined) {
      return fail(
        `Each option can be up to ${MAX_LIST_OPTION_LENGTH} characters, and a room name is ` +
          `capped at ${MAX_CHANNEL_NAME_LENGTH}. This one is longer: **${tooLong.slice(0, 60)}**`,
      );
    }
    let message = '';
    const res = await this.editLists(guildId, (current) => {
      // A rename only leaves the count unchanged if the old name is still THERE.
      // A panel opened before someone else removed that list would otherwise
      // skip the cap and push the guild to 26, one more than the select can show.
      const renaming =
        previousName !== undefined && previousName !== name && hasList(current, previousName);
      const replacing = hasList(current, name);
      // Counted against the cap only when this add would really be a new entry:
      // a rename or a replace leaves the count the same or lower.
      const adding = !replacing && !renaming;
      if (adding && Object.keys(current).length >= MAX_LISTS) {
        return fail(`This server already has ${MAX_LISTS} lists. Remove one to add another.`);
      }
      const lists = { ...current, [name]: [...options] };
      if (renaming) delete lists[previousName!];
      message = renaming
        ? `Renamed to **${name}**, with ${options.length} options.`
        : replacing
          ? `Updated **${name}**: ${options.length} options.`
          : `Added **${name}**: ${options.length} options. Use it as \`[[list:${name}]]\`.`;
      return { lists };
    });
    return res.ok ? ok(message) : res;
  }

  /** Deletes one named list by its exact stored name. */
  async removeNamedList(guildId: string, name: string): Promise<CommandResult> {
    const res = await this.editLists(guildId, (current) => {
      if (!hasList(current, name)) return fail('That list is no longer there.');
      const lists = { ...current };
      delete lists[name];
      return { lists };
    });
    return res.ok ? ok(`Removed the list **${name}**.`) : res;
  }

  /**
   * The guild's game aliases.
   *
   * Deliberately not `getConfig`, which also runs `autoChannels.listByGuild` --
   * an uncached query the alias panel does not need and would repeat on every
   * re-render. This reads the guild row the settings cache already holds.
   */
  async listAliases(guildId: string): Promise<Record<string, string>> {
    const guild = await this.deps.guilds.ensure(guildId);
    // A COPY. `parseVoiceSettings` hands back the map by reference, and the
    // settings cache hands the same row to every caller, so returning it
    // directly would let one caller's `aliases[x] = y` corrupt the cache
    // process-wide with no write and no NOTIFY behind it.
    return { ...parseVoiceSettings(guild.settings).aliases };
  }

  /**
   * Applies a decision to the alias map under the row lock.
   *
   * NOT `updateSettings`, which merges DB-side only at the top level, so
   * `aliases` is replaced wholesale and a read-then-write of it loses anything
   * that landed in between. The importer merges the same key one level deeper
   * and runs for minutes against guilds a live fleet is serving, so "in
   * between" includes an import pass, and the per-guild dispatcher does not
   * help: it is per instance, and two fleets already share 35 guilds.
   * `decide` returns the new map to write, or a failing `CommandResult` to
   * write nothing and report why.
   */
  private editAliases(
    guildId: string,
    decide: (
      current: Record<string, string>,
    ) => { aliases: Record<string, string> } | CommandResult,
  ): Promise<CommandResult> {
    return this.deps.guilds.mergeSettings(guildId, (existing) => {
      const current = parseVoiceSettings(existing?.settings ?? {}).aliases;
      const decided = decide(current);
      if ('aliases' in decided) return { patch: { aliases: decided.aliases }, result: ok('') };
      return { patch: {}, result: decided };
    });
  }

  async addAlias(guildId: string, game: string, alias: string): Promise<CommandResult> {
    const g = game.trim();
    const a = alias.trim();
    if (!g || !a) return fail('Provide both a game name and an alias.');
    let message = '';
    const res = await this.editAliases(guildId, (current) => {
      const replacing = has(current, g);
      if (!replacing && Object.keys(current).length >= MAX_ALIASES) {
        return fail(`This server already has ${MAX_ALIASES} aliases. Remove one to add another.`);
      }
      message = replacing
        ? `Alias updated: **${g}** now shows as **${a}**`
        : `Alias added: **${g}** → **${a}**`;
      return { aliases: { ...current, [g]: a } };
    });
    return res.ok ? ok(message) : res;
  }

  /** Deletes one alias by its exact game name. */
  async removeAlias(guildId: string, game: string): Promise<CommandResult> {
    const res = await this.editAliases(guildId, (current) => {
      if (!has(current, game)) return fail('That alias is no longer there.');
      const aliases = { ...current };
      delete aliases[game];
      return { aliases };
    });
    return res.ok ? ok(`Removed the alias for **${game}**.`) : res;
  }

  /**
   * Edits one alias, renaming the game name too when it changed.
   *
   * A rename is a delete plus a set in ONE write, so the old key can never be
   * left behind by a failure between two writes. `previousGame` is the exact
   * stored key (resolved from the panel's hash), so it is never trimmed.
   */
  async replaceAlias(
    guildId: string,
    previousGame: string,
    game: string,
    alias: string,
  ): Promise<CommandResult> {
    const g = game.trim();
    const a = alias.trim();
    if (!g || !a) return fail('Provide both a game name and an alias.');
    let message = '';
    const res = await this.editAliases(guildId, (current) => {
      if (!has(current, previousGame)) return fail('That alias is no longer there.');
      const renamed = g !== previousGame;
      const overwrote = renamed && has(current, g);
      message = overwrote
        ? `Saved: **${g}** → **${a}**. This replaced the alias **${g}** already had.`
        : renamed
          ? `Saved: **${g}** → **${a}**, replacing the one for **${previousGame}**.`
          : `Saved: **${g}** → **${a}**`;
      const aliases = { ...current };
      delete aliases[previousGame];
      aliases[g] = a;
      return { aliases };
    });
    return res.ok ? ok(message) : res;
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
      `Created **${name}**. Join it to spawn a room.\n` +
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
      return ok(`Reset this creator channel's ${field} template to the default.`);
    }
    next[field] = value;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
    if (field === 'status' && value === '') {
      return ok('New rooms from this creator channel will show no status (blank).');
    }
    return ok(
      field === 'name'
        ? `New rooms from this creator channel will be named:\n\`${value}\``
        : `New rooms from this creator channel will show the status:\n\`${value}\``,
    );
  }

  /** Sets (or resets) a member's custom display name for `@@owner@@`. `/nick`. */
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
    return ok(`Rooms that show the owner will now call you **${value}**.`);
  }

  /** Reads whether the primary of the channel you're in spawns secondaries above. */
  async getPosition(
    guildId: string,
    secondaryChannelId: string,
  ): Promise<{
    found: boolean;
    above: boolean;
    startAt?: number | undefined;
    primaryChannelId?: string;
  }> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return { found: false, above: false };
    const startAt = primary.template.startAt;
    return {
      found: true,
      above: primary.template.above === true,
      // `passthrough` types an unknown key as `unknown`, and this one has been
      // through `primaryTemplateSchema` since it was added, so it is a number
      // or absent. Narrowed rather than cast, so a hand-edited row cannot make
      // the render offset `NaN`.
      ...(typeof startAt === 'number' ? { startAt } : {}),
      primaryChannelId: primary.channelId,
    };
  }

  /** Sets whether new secondaries are positioned above (else below) their primary. */
  async setPosition(
    guildId: string,
    secondaryChannelId: string,
    above: boolean,
    startAt?: number | undefined,
  ): Promise<CommandResult> {
    const primary = await this.primaryFor(guildId, secondaryChannelId);
    if (!primary) return fail('You need to be in a bot-managed voice channel.');
    const next = { ...primary.template };
    // Below is the default, so store nothing for it; only persist an explicit "above".
    if (above) next.above = true;
    else delete next.above;
    // Same rule for numbering: 1 is the default, so absent rather than stored.
    if (startAt !== undefined) next.startAt = startAt;
    else delete next.startAt;
    await this.deps.autoChannels.upsert(guildId, primary.channelId, next);
    const numbering = startAt === undefined ? '' : ` Rooms here now count from **${startAt}**.`;
    return ok(
      `New rooms here will now be positioned **${above ? 'above' : 'below'}** the creator ` +
        `channel.${numbering}`,
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
        ? '🔒 New rooms from this creator channel will be created **private** automatically.'
        : '🔓 New rooms from this creator channel will be created **public** (the default).',
    );
  }

  /**
   * Sets the default user limit applied to rooms this creator channel spawns.
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
        ? `👥 New rooms from this creator channel will hold **${limit}** ${limit === 1 ? 'person' : 'people'}. Existing rooms keep their current limit.`
        : '👥 New rooms from this creator channel will have **no user limit**. Existing rooms keep their current limit.',
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
      return fail(
        'Use `/inheritpermissions` to pick the creator channel, its category, or a specific voice channel.',
      );
    }
    await this.deps.autoChannels.upsert(guildId, primary.channelId, {
      ...primary.template,
      inheritperms: normalized,
    });
    return ok(`New rooms here will inherit permissions from **${normalized}**.`);
  }

  /** Reads the current logging configuration (for pre-filling the `/logging` modal). */
  async getLogging(guildId: string): Promise<{
    enabled: boolean;
    level: LogLevel;
    channelId: string | null;
    alerts: ProblemAlertMode;
  }> {
    const guild = await this.deps.guilds.ensure(guildId);
    return { ...readLogging(guild.settings), alerts: readProblemAlerts(guild.settings) };
  }

  /**
   * Configures the per-guild logging channel + level, or turns logging off, and
   * the separate problem-alert preference.
   *
   * One write for both, because they arrive from one modal and two
   * `updateSettings` calls would be two `pg_notify` round trips to say one
   * thing.
   */
  async setLogging(
    guildId: string,
    target: string | null,
    level: LogLevel,
    alerts: ProblemAlertMode = 'contact',
  ): Promise<CommandResult> {
    // Always says something: a silent confirmation for the default made
    // turning alerts back on look like nothing had happened.
    const alertLine = `\n${problemAlertConfirmation(alerts)}`;
    if (target === null) {
      await this.deps.guilds.updateSettings(guildId, { logging: false, problem_alerts: alerts });
      return ok(`📕 Event logging is now disabled.${alertLine}`);
    }
    await this.deps.guilds.updateSettings(guildId, {
      logging: target,
      log_level: level,
      problem_alerts: alerts,
    });
    return ok(`📗 Logging events (level **${level}**) to <#${target}>.${alertLine}`);
  }

  /**
   * Writes an import's whole settings diff: one transaction, one `pg_notify`.
   *
   * **`mergeSettings`, not `updateSettings`, and that is a correctness choice
   * rather than a style one.** `updateSettings` merges DB-side at the top level,
   * so `aliases`, `custom_nicks` and `groups` are each replaced wholesale by
   * whatever the diff computed. The diff is computed at the start of the apply
   * and this write happens at the end, separated by up to 150 channel writes, so
   * an `/alias` or `/nick` landing in that window would be discarded SILENTLY:
   * the announcement would truthfully report replacing the alias list it read,
   * and nothing anywhere would know an entry had been lost. `editAliases` uses
   * `mergeSettings` for exactly this and names the importer as the concrete
   * concurrent writer.
   *
   * Doing the read and the write in one transaction under `FOR UPDATE` also
   * upgrades the report from "recompute so it is honest" to "the value reported
   * is the value overwritten", which is the only shape that can detect the drift
   * at all. `driftedKeys` is what came back different from the preview.
   *
   * `remove` exists because concat cannot delete a key, and four keys fall back
   * to a default when absent, so writing today's default over one would pin the
   * guild to it forever.
   */
  async applyImportedSettings(
    guildId: string,
    patch: Record<string, unknown>,
    remove: readonly string[],
    expectedBefore: Record<string, unknown>,
  ): Promise<{ before: Record<string, unknown>; driftedKeys: string[] }> {
    return this.deps.guilds.mergeSettings(guildId, (existing) => {
      const before = existing?.settings ?? {};
      /**
       * Drift is the value under the LOCK differing from the value the PREVIEW
       * showed, for a key this write is about to replace.
       *
       * Not "the new value equals the stored value", which is a no-op and the
       * opposite of interesting, and not "the key is absent", which for a clear
       * is the ordinary case. Getting this backwards made the one detector that
       * can see a concurrent `/alias` or `/nick` loss report every harmless
       * no-op and stay silent on every real loss.
       *
       * `expectedBefore` comes from the plan's own `settingChanges`, so this
       * compares like with like: both sides are raw stored values.
       */
      const driftedKeys = [...Object.keys(patch), ...remove].filter(
        (key) => !sameSettingsValue(before[key], expectedBefore[key]),
      );
      return { patch, remove, result: { before, driftedKeys } };
    });
  }

  /**
   * The primary whose template a `/template` edit targets.
   *
   * Usually the caller is in a SECONDARY and the template belongs to its
   * primary. But the editor can also be aimed at the creator channel itself,
   * which has no secondary row, and resolving only through `secondary_channels`
   * made that save fail with "you need to be in a bot-managed voice channel"
   * for a channel AVC plainly manages. Same gap as `getEditorState`, and fixing
   * only the read side would have shown the panel and then refused the write.
   */
  private async primaryFor(
    guildId: string,
    channelId: string,
  ): Promise<AutoChannelRow | undefined> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (secondary && secondary.guildId === guildId) {
      const primary = await this.deps.autoChannels.get(secondary.primaryChannelId);
      return primary && primary.guildId === guildId ? primary : undefined;
    }
    const own = await this.deps.autoChannels.get(channelId);
    return own && own.guildId === guildId ? own : undefined;
  }
}

function toPrimaryView(p: AutoChannelRow): { channelId: string; template: string; limit: number } {
  return {
    channelId: p.channelId,
    template: p.template.name ?? DEFAULT_CHANNEL_NAME_TEMPLATE,
    limit: p.template.limit ?? 0,
  };
}
