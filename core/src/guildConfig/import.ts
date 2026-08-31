import { EXPORT_SETTINGS_KEYS, type ExportSettingsKey, type GuildConfigFile } from './format.js';

/**
 * The pure differ behind `/import`: a file plus the guild's current state in, a
 * plan plus a human-facing diff out.
 *
 * **No I/O, no clock, no Discord, and no reachable path to anything that writes
 * auth state.** The last one is not decoration: `migrate/merge.ts` returns a
 * `writeTrial` command that `importDump` obeys by calling `transitionAuth`, and
 * `trialStartFor` sits right beside `planGuild` in the same public surface. An
 * import is a configuration change and says nothing about whether anyone is
 * paying, so this module reaches neither and `import.unit.test.ts` asserts it.
 *
 * **Nothing here interpolates a value from the file into a note's `detail`.** A
 * throw from this module reaches `reportError`, which posts to the admin
 * channel, so file content must not travel that way. Displayable data goes in
 * the typed change fields instead, where the caller decides what each audience
 * sees: the ephemeral reply may name things, the public announcement may not.
 */

/** Which format the file came from, which decides how authoritative it is. */
export type ImportSource = 'native' | 'legacy';

/** Ceilings, all of them, with the numbers in code rather than in prose. */
export const IMPORT_LIMITS = {
  /** Refused from `attachment.size` before any fetch happens. */
  attachmentBytes: 512 * 1024,
  /**
   * 50 against a prod fleet mean of 1.95 creator channels per guild
   * (10,827 over 5,556), so 25x observed, and a guild holding 50 has already
   * spent a tenth of Discord's 500-channel budget before a room is created.
   */
  creatorChannels: 50,
  /** 100 against the 40 adopted rooms the entire 5,556-guild prod base carries. */
  adoptedChannels: 100,
  /** `MAX_ALIASES` on the interactive path. */
  aliases: 100,
  aliasChars: 100,
  /**
   * 500 entries at ~110 bytes each is ~55 KB, and that 55 KB is resident in
   * `SettingsCache` on every instance that ever served the guild, which is the
   * reason this needs a cap at all rather than anything about the file.
   */
  customNicks: 500,
  customNickChars: 80,
  /** A guild cannot have more categories worth grouping than this. */
  groups: 50,
  generalChars: 80,
  /** `TEMPLATE_INPUT_MAX` on the interactive path. */
  templateChars: 1000,
  /** `MAX_USER_LIMIT`. */
  userLimit: 99,
} as const;

export type ChannelKind = 'voice' | 'text' | 'category' | 'other';

export interface ChannelFact {
  name: string;
  kind: ChannelKind;
  /**
   * Whether the bot holds the full creator-channel permission set.
   *
   * Computed by the caller from `missingBotPermissions`, not from a single flag:
   * a channel where the bot can see but cannot Connect creates no rooms, and a
   * proxy that checked View Channel alone reported it as fine.
   */
  botCanManage: boolean;
  /**
   * Whether the bot can rename it, which is all an adopted channel needs.
   *
   * From `missingRenamePermissions`, which is deliberately narrower: renaming
   * needs View Channel and Manage Channels and neither Move Members nor Manage
   * Roles, so demanding the full set here would refuse setups that work.
   */
  botCanRename: boolean;
  /** The human labels of what is missing, for copy that says what to grant. */
  missingPermissions?: readonly string[] | undefined;
}

/**
 * Everything about the guild that had to be read from Discord, passed in as
 * plain data so this module stays pure and the hard cases stay testable.
 */
export interface GuildFacts {
  guildId: string;
  /**
   * Every channel the bot can see. **An empty map means the guild is not
   * hydrated, not that it has no channels**, and the caller must refuse before
   * calling this rather than letting a cold cache read as everything vanishing.
   */
  channels: ReadonlyMap<string, ChannelFact>;
  /** Ids the caller resolved, and whether each is currently a member. */
  members: ReadonlyMap<string, boolean>;
  /** Channel ids held by another fleet, mapped to that fleet's name. */
  foreignFleetChannels: ReadonlyMap<string, string>;
  /** This bot's own application id, for the two-bots warning. */
  applicationId: string | null;
  /** Other AVC fleets configured in this guild, if any. */
  otherFleetsPresent: readonly string[];
  /**
   * Whoever ran the command, for the contact rule in {@link diffSettings}.
   *
   * `/import` is the fourth writer of `settings.contact_user_id`, alongside
   * `handleCreateSubmit`, `applyEditor` and `handleAdoptButton`, and the rule
   * they all follow is that a path which writes a template must not leave the
   * guild with no recorded contact. Null only for a caller with nobody to
   * stamp, which no real caller is.
   */
  actorId: string | null;
}

export interface CurrentCreatorChannel {
  channelId: string;
  template: Record<string, unknown>;
}

export interface CurrentAdoptedChannel {
  channelId: string;
  template: Record<string, unknown>;
  state: Record<string, unknown>;
}

/** The guild as stored, read from the RAW columns (never through a parser). */
export interface CurrentConfig {
  settings: Record<string, unknown>;
  creatorChannels: readonly CurrentCreatorChannel[];
  adoptedChannels: readonly CurrentAdoptedChannel[];
}

export interface IncomingCreator {
  channelId: string;
  /** The name the file recorded, for legibility. Never used to resolve anything. */
  channelName: string | null;
  /** Field to value. `null` means the field is absent from the file. */
  template: Record<string, unknown>;
}

export interface IncomingAdopted extends IncomingCreator {
  state: Record<string, unknown>;
}

export interface LegacyExtras {
  droppedFields: readonly string[];
  orphanedTextChannels: readonly string[];
  orphanedRoles: readonly string[];
  /** Recorded BEFORE the `left` key is stripped, because stripping removes it. */
  wasMarkedLeft: boolean;
  /** The guild id recovered from the filename, when it parsed as one. */
  filenameGuildId: string | null;
}

/**
 * One normalised view both formats produce, so the diff is written once.
 *
 * A settings key ABSENT from the map is untouched. A key present with the value
 * `null` is cleared. Any other value replaces what is stored.
 */
export interface IncomingConfig {
  source: ImportSource;
  /** Present in a native file, absent from a legacy one by construction. */
  guildId: string | null;
  sourceApplicationId: string | null;
  settings: ReadonlyMap<ExportSettingsKey, unknown>;
  creatorChannels: readonly IncomingCreator[];
  adoptedChannels: readonly IncomingAdopted[];
  /**
   * Whether the channel arrays describe the COMPLETE state.
   *
   * True for a native export, which is a machine-written snapshot of one moment,
   * so a row it omits is one the admin has said should not exist. False for a
   * legacy file, which cannot express the rewrite's state and whose guild check
   * is weaker, so it may only add and update (`plans/import_command.md` §5.5a).
   */
  authoritative: boolean;
  legacy?: LegacyExtras;
}

export type ImportNoteCode =
  | 'file_guild_mismatch'
  | 'filename_guild_mismatch'
  | 'guild_not_hydrated'
  | 'too_many_creator_channels'
  | 'too_many_adopted_channels'
  | 'channel_in_both_sections'
  | 'every_channel_foreign_fleet'
  | 'channel_missing'
  | 'channel_wrong_type'
  | 'channel_foreign_fleet'
  | 'channel_already_creator'
  | 'channel_already_adopted'
  | 'channel_cannot_manage'
  | 'channel_cannot_rename'
  | 'creator_removal_is_one_way'
  | 'setting_invalid'
  | 'setting_over_limit'
  | 'setting_unknown_key'
  | 'logging_unresolved'
  | 'group_unresolved'
  | 'inheritperms_unresolved'
  | 'contact_not_member'
  | 'contact_stamped'
  | 'template_field_invalid'
  | 'automation_switched_off'
  | 'position_overwritten'
  | 'other_bot_may_be_present'
  | 'legacy_field_dropped'
  | 'legacy_marked_left'
  | 'orphaned_text_channel'
  | 'orphaned_role';

export type NoteSeverity = 'refusal' | 'dropped' | 'warning';

export interface ImportNote {
  code: ImportNoteCode;
  severity: NoteSeverity;
  /** A settings key, a channel id, or a field path. Never a value from the file. */
  subject: string;
  /**
   * A name we hold ourselves (a Discord channel name), for legibility.
   *
   * Explicitly `| undefined` rather than merely optional: under
   * `exactOptionalPropertyTypes` a note built from a lookup that may have missed
   * is the normal case here, and writing every construction site as a
   * conditional spread would bury the code that matters.
   */
  name?: string | undefined;
  /** A count, where the useful thing to say is how many. */
  count?: number | undefined;
  /** A limit that was exceeded, so the copy can say what the limit is. */
  limit?: number | undefined;
  /** A second id, for a mismatch. Never file content beyond an id. */
  other?: string | undefined;
  /** Permission labels the bot is missing, so a drop can say what to grant. */
  missingPermissions?: readonly string[] | undefined;
}

export interface SettingChange {
  key: ExportSettingsKey;
  before: unknown;
  after: unknown;
  /** True when the key is being removed rather than given a new value. */
  cleared: boolean;
  /** Entry-level detail for the three dictionary keys. Names, not values. */
  entriesAdded: string[];
  entriesRemoved: string[];
  entriesChanged: string[];
}

export interface ChannelFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ChannelChange {
  channelId: string;
  /** From Discord where we could resolve it, else the file's recorded name. */
  name: string | null;
  action: 'adopt' | 'update' | 'remove';
  fields: ChannelFieldChange[];
}

export interface ImportPlan {
  source: ImportSource;
  authoritative: boolean;
  /** Keys to write. Never contains a `null` value: clears go in `settingsRemove`. */
  settingsPatch: Record<string, unknown>;
  /** Keys to delete outright, which concat cannot do. */
  settingsRemove: string[];
  creatorWrites: { channelId: string; template: Record<string, unknown> }[];
  creatorRemovals: string[];
  adoptedWrites: {
    channelId: string;
    template: Record<string, unknown>;
    state: Record<string, unknown>;
    /** No stored row, so `create` will insert and needs owner and roster seeding. */
    firstTime: boolean;
  }[];
  adoptedRemovals: string[];
  settingChanges: SettingChange[];
  creatorChanges: ChannelChange[];
  adoptedChanges: ChannelChange[];
  notes: ImportNote[];
  /** False when the file matches the guild exactly, which suppresses the announcement. */
  changed: boolean;
}

export type DiffResult = { ok: true; plan: ImportPlan } | { ok: false; refusals: ImportNote[] };

/** The six fields of `primaryTemplateSchema`. */
const PRIMARY_FIELDS = [
  'name',
  'status',
  'limit',
  'above',
  'defaultPrivate',
  'inheritperms',
] as const;

/** Both fields of `managedTemplateSchema`. */
const MANAGED_FIELDS = ['name', 'status'] as const;

/** The `state` fields a file carries. `roster` is live occupancy and is not one. */
const MANAGED_STATE_FIELDS = ['seed', 'name', 'status'] as const;

/**
 * The only template fields a legacy config can express.
 *
 * Anything outside this list is UNTOUCHED by a legacy import, which is the whole
 * of `plans/import_command.md` §5.6 defect (a): the legacy schema has no
 * `status` and no `defaultPrivate`, and `autoChannels.upsert` writes the whole
 * column, so a wholesale write would silently clear the voice-status template
 * and `/alwaysprivate` on every creator channel the file names.
 */
const LEGACY_TEMPLATE_FIELDS: readonly string[] = ['name', 'limit', 'above', 'inheritperms'];

const PROBLEM_ALERT_VALUES = new Set(['contact', 'quiet', 'off']);
const ROOT_GROUP_KEY = '@root';
const SNOWFLAKE = /^\d{17,20}$/;

const isSnowflake = (v: unknown): v is string => typeof v === 'string' && SNOWFLAKE.test(v);

/**
 * Order-insensitive structural equality, which is what a jsonb column needs.
 *
 * Exported because the settings writer has to reach the same verdict as the
 * differ. `jsonb` does not preserve key order, so a plain `JSON.stringify`
 * comparison of `aliases`, `custom_nicks` or `groups` can report a difference
 * that is not one, which on the drift path means warning an admin their file was
 * overtaken when nothing happened.
 */
export function sameSettingsValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/** Local alias, so the many call sites below stay short. */
const sameValue = sameSettingsValue;

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

/** Turns a validated native file into the normalised shape. */
export function fromNativeFile(file: GuildConfigFile): IncomingConfig {
  const settings = new Map<ExportSettingsKey, unknown>();
  for (const key of EXPORT_SETTINGS_KEYS) settings.set(key, file.settings[key]);

  return {
    source: 'native',
    guildId: file.guild_id,
    sourceApplicationId: file.source_application_id,
    settings,
    creatorChannels: file.creator_channels.map((c) => ({
      channelId: c.channel_id,
      channelName: c.channel_name,
      template: c.template as Record<string, unknown>,
    })),
    adoptedChannels: file.adopted_channels.map((c) => ({
      channelId: c.channel_id,
      channelName: c.channel_name,
      template: c.template as Record<string, unknown>,
      state: c.state as Record<string, unknown>,
    })),
    authoritative: true,
  };
}

/** What `planGuild` produces, narrowed to the parts an import uses. */
export interface LegacyPlanView {
  settings: Record<string, unknown>;
  primaries: readonly { channelId: string; template: Record<string, unknown> }[];
  droppedFields: readonly string[];
  orphanedTextChannels: readonly string[];
  orphanedRoles: readonly string[];
}

/**
 * Turns a `planGuild` result into the normalised shape.
 *
 * A legacy config has no concept of an adopted channel, so
 * {@link IncomingConfig.adoptedChannels} is always empty here, and a legacy
 * import can therefore never write or remove one.
 */
export function fromLegacyPlan(
  plan: LegacyPlanView,
  extras: { wasMarkedLeft: boolean; filenameGuildId: string | null },
): IncomingConfig {
  const settings = new Map<ExportSettingsKey, unknown>();
  for (const key of EXPORT_SETTINGS_KEYS) {
    // Absent means untouched, so only keys the plan actually produced go in.
    if (Object.prototype.hasOwnProperty.call(plan.settings, key)) {
      settings.set(key, plan.settings[key]);
    }
  }

  return {
    source: 'legacy',
    guildId: null,
    sourceApplicationId: null,
    settings,
    creatorChannels: plan.primaries.map((p) => ({
      channelId: p.channelId,
      channelName: null,
      template: p.template,
    })),
    adoptedChannels: [],
    authoritative: false,
    legacy: {
      droppedFields: plan.droppedFields,
      orphanedTextChannels: plan.orphanedTextChannels,
      orphanedRoles: plan.orphanedRoles,
      wasMarkedLeft: extras.wasMarkedLeft,
      filenameGuildId: extras.filenameGuildId,
    },
  };
}

/**
 * Computes what an import would do.
 *
 * Refusals come back as `ok: false` and mean nothing should be applied at all.
 * Everything else is in the plan, with per-piece drops and warnings in `notes`.
 */
export function diffGuildConfig(
  incoming: IncomingConfig,
  current: CurrentConfig,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS = IMPORT_LIMITS,
): DiffResult {
  const refusals: ImportNote[] = [];
  const notes: ImportNote[] = [];

  // A cold channel cache reads as every channel having vanished, so the caller
  // must not reach here. Checked anyway: this is the one condition where being
  // wrong silently produces a destructive plan that looks correct.
  if (facts.channels.size === 0) {
    refusals.push({ code: 'guild_not_hydrated', severity: 'refusal', subject: facts.guildId });
  }

  if (incoming.guildId !== null && incoming.guildId !== facts.guildId) {
    refusals.push({
      code: 'file_guild_mismatch',
      severity: 'refusal',
      subject: facts.guildId,
      other: incoming.guildId,
    });
  }

  // A legacy file's guild id is its FILENAME, so this is the only comparison
  // available for that format, and it is a refusal rather than a warning: the
  // settings half applies in full regardless of whether any channel resolves.
  const filenameGuildId = incoming.legacy?.filenameGuildId ?? null;
  if (filenameGuildId !== null && filenameGuildId !== facts.guildId) {
    refusals.push({
      code: 'filename_guild_mismatch',
      severity: 'refusal',
      subject: facts.guildId,
      other: filenameGuildId,
    });
  }

  if (incoming.creatorChannels.length > limits.creatorChannels) {
    refusals.push({
      code: 'too_many_creator_channels',
      severity: 'refusal',
      subject: 'creator_channels',
      count: incoming.creatorChannels.length,
      limit: limits.creatorChannels,
    });
  }
  if (incoming.adoptedChannels.length > limits.adoptedChannels) {
    refusals.push({
      code: 'too_many_adopted_channels',
      severity: 'refusal',
      subject: 'adopted_channels',
      count: incoming.adoptedChannels.length,
      limit: limits.adoptedChannels,
    });
  }

  // A channel cannot be both, and `adoptChannel` refuses the combination on the
  // interactive path. A file can name it twice, so refuse rather than letting
  // write order decide what the channel becomes.
  const adoptedIds = new Set(incoming.adoptedChannels.map((c) => c.channelId));
  for (const creator of incoming.creatorChannels) {
    if (adoptedIds.has(creator.channelId)) {
      refusals.push({
        code: 'channel_in_both_sections',
        severity: 'refusal',
        subject: creator.channelId,
        name: facts.channels.get(creator.channelId)?.name ?? creator.channelName ?? undefined,
      });
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const storedCreators = new Map(current.creatorChannels.map((c) => [c.channelId, c]));
  const storedAdopted = new Map(current.adoptedChannels.map((c) => [c.channelId, c]));

  /**
   * Every channel id the file names, in EITHER section.
   *
   * Removals are computed against this rather than against the section being
   * processed, and the difference is a silent loss. A channel the guild holds as
   * a creator channel but the file lists under `adopted_channels` is dropped by
   * the adopted pass (it cannot be both) and, if the creator pass only looked at
   * `creator_channels`, removed by that pass for being absent. Net effect: the
   * row is deleted, nothing is written, and the channel silently stops being
   * managed.
   *
   * Naming it anywhere is the admin saying they still want it, so the right
   * outcome is to leave the existing row alone and report the conflict.
   */
  const namedAnywhere = new Set<string>([
    ...incoming.creatorChannels.map((c) => c.channelId),
    ...incoming.adoptedChannels.map((c) => c.channelId),
  ]);

  // Channels first, because the contact rule inside the settings pass only
  // applies to an import that actually writes a template.
  const creator = diffCreatorChannels(
    incoming,
    storedCreators,
    storedAdopted,
    facts,
    limits,
    notes,
    namedAnywhere,
  );
  const adopted = diffAdoptedChannels(
    incoming,
    storedAdopted,
    storedCreators,
    facts,
    limits,
    notes,
    namedAnywhere,
  );
  const wroteTemplates = creator.writes.length > 0 || adopted.writes.length > 0;

  const settingsResult = diffSettings(incoming, current, facts, limits, notes, wroteTemplates);

  // Every channel in the file belongs to another fleet, so the import would
  // change settings only. That is a partial success the admin should get to
  // decline, rather than one buried in a long skip list.
  const namedChannels = incoming.creatorChannels.length + incoming.adoptedChannels.length;
  const foreignSkips = notes.filter((n) => n.code === 'channel_foreign_fleet').length;
  if (namedChannels > 0 && foreignSkips === namedChannels) {
    return {
      ok: false,
      refusals: [
        {
          code: 'every_channel_foreign_fleet',
          severity: 'refusal',
          subject: facts.guildId,
          count: foreignSkips,
        },
      ],
    };
  }

  addWarnings(incoming, settingsResult.changes, facts, notes);

  const changed =
    Object.keys(settingsResult.patch).length > 0 ||
    settingsResult.remove.length > 0 ||
    creator.writes.length > 0 ||
    creator.removals.length > 0 ||
    adopted.writes.length > 0 ||
    adopted.removals.length > 0;

  return {
    ok: true,
    plan: {
      source: incoming.source,
      authoritative: incoming.authoritative,
      settingsPatch: settingsResult.patch,
      settingsRemove: settingsResult.remove,
      creatorWrites: creator.writes,
      creatorRemovals: creator.removals,
      adoptedWrites: adopted.writes,
      adoptedRemovals: adopted.removals,
      settingChanges: settingsResult.changes,
      creatorChanges: creator.changes,
      adoptedChanges: adopted.changes,
      notes,
      changed,
    },
  };
}

interface SettingsDiff {
  patch: Record<string, unknown>;
  remove: string[];
  changes: SettingChange[];
}

function diffSettings(
  incoming: IncomingConfig,
  current: CurrentConfig,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS,
  notes: ImportNote[],
  wroteTemplates: boolean,
): SettingsDiff {
  const patch: Record<string, unknown> = {};
  const remove: string[] = [];
  const changes: SettingChange[] = [];

  for (const key of EXPORT_SETTINGS_KEYS) {
    if (!incoming.settings.has(key)) continue; // absent from the file, untouched
    const raw = incoming.settings.get(key);
    const stored = Object.prototype.hasOwnProperty.call(current.settings, key)
      ? current.settings[key]
      : undefined;

    // `null` means the key is absent from the source blob, so restore absence.
    if (raw === null || raw === undefined) {
      if (stored === undefined) continue;
      remove.push(key);
      changes.push(clearedChange(key, stored));
      continue;
    }

    const validated = validateSetting(key, raw, facts, limits, notes);
    if (validated === undefined) continue; // dropped, already noted
    if (sameValue(validated, stored)) continue;

    patch[key] = validated;
    changes.push(settingChange(key, stored, validated));
  }

  if (wroteTemplates) stampContactIfNeeded(patch, remove, current, facts, changes, notes);
  return { patch, remove, changes };
}

/**
 * `/import` is the fourth hook on `settings.contact_user_id`, and this is it.
 *
 * The contact is who gets told when a guild's automation breaks, and the three
 * existing writers all stamp it because a path that configures creator channels
 * and leaves nobody recorded produces a guild nothing can reach. An import that
 * writes templates is such a path, and it has two ways to end up with no
 * contact: the file names nobody, or the file names somebody who has since left
 * and their id was dropped.
 *
 * Only ever fills a GAP: it never overrides a contact that SURVIVES the import,
 * whether that came from the file or was already stored. Where the import would
 * leave the guild with nobody, the importer is stamped, which is what the other
 * three hooks do and is the same person who just chose to apply the file.
 *
 * Note the case that is easy to misread: a native file carrying
 * `contact_user_id: null` clears the stored contact, because null means absent
 * and replace means replace. The stamp then fills the gap that clear just made.
 * Leaving the old contact in place instead would break the exact round trip,
 * since a snapshot taken from a guild with no contact could no longer restore
 * that state.
 */
function stampContactIfNeeded(
  patch: Record<string, unknown>,
  remove: string[],
  current: CurrentConfig,
  facts: GuildFacts,
  changes: SettingChange[],
  notes: ImportNote[],
): void {
  // Truthiness, not `!== null`: `core/tsconfig.json` excludes `*.test.ts`, so a
  // fixture that omits `actorId` passes undefined here and typechecks nowhere.
  // A strict null check would then write `undefined` into the patch.
  if (!facts.actorId) return;

  const key: ExportSettingsKey = 'contact_user_id';
  if (Object.prototype.hasOwnProperty.call(patch, key)) return; // the file named somebody usable

  const clearing = remove.includes(key);
  const stored = current.settings[key];
  const wouldBeUnset = clearing || typeof stored !== 'string' || stored === '';
  if (!wouldBeUnset) return;

  patch[key] = facts.actorId;
  /**
   * The clear is WITHDRAWN rather than layered over.
   *
   * `mergeSettings` applies the minus after the concat, deliberately, so a key
   * left in both would be deleted again and the stamp would silently do
   * nothing.
   */
  const at = remove.indexOf(key);
  if (at !== -1) remove.splice(at, 1);

  const existing = changes.find((c) => c.key === key);
  if (existing) {
    existing.after = facts.actorId;
    existing.cleared = false;
  } else {
    changes.push(settingChange(key, stored, facts.actorId));
  }
  notes.push({ code: 'contact_stamped', severity: 'warning', subject: key, other: facts.actorId });
}

function clearedChange(key: ExportSettingsKey, before: unknown): SettingChange {
  const removedEntries = isStringMap(before) ? Object.keys(before) : [];
  return {
    key,
    before,
    after: undefined,
    cleared: true,
    entriesAdded: [],
    entriesRemoved: removedEntries,
    entriesChanged: [],
  };
}

function settingChange(key: ExportSettingsKey, before: unknown, after: unknown): SettingChange {
  const change: SettingChange = {
    key,
    before,
    after,
    cleared: false,
    entriesAdded: [],
    entriesRemoved: [],
    entriesChanged: [],
  };

  // Entry-level detail for the dictionary keys. The removals are the reason
  // `plans/import_command.md` §5.5 makes listing them a hard requirement: a key
  // the file carries replaces the stored value entirely, so entries it does not
  // list are gone, and that has to be visible before the button is pressed.
  const beforeMap = asRecord(before);
  const afterMap = asRecord(after);
  if (beforeMap && afterMap) {
    for (const entryKey of Object.keys(afterMap)) {
      if (!(entryKey in beforeMap)) change.entriesAdded.push(entryKey);
      else if (!sameValue(beforeMap[entryKey], afterMap[entryKey]))
        change.entriesChanged.push(entryKey);
    }
    for (const entryKey of Object.keys(beforeMap)) {
      if (!(entryKey in afterMap)) change.entriesRemoved.push(entryKey);
    }
  } else if (afterMap && before === undefined) {
    change.entriesAdded.push(...Object.keys(afterMap));
  }

  return change;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Returns the value to write, or `undefined` when it was dropped and noted. */
function validateSetting(
  key: ExportSettingsKey,
  value: unknown,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS,
  notes: ImportNote[],
): unknown {
  const drop = (code: ImportNoteCode, extra: Partial<ImportNote> = {}): undefined => {
    notes.push({ code, severity: 'dropped', subject: key, ...extra });
    return undefined;
  };

  switch (key) {
    case 'enabled':
      return typeof value === 'boolean' ? value : drop('setting_invalid');

    case 'general':
      if (typeof value !== 'string') return drop('setting_invalid');
      if (value.length > limits.generalChars)
        return drop('setting_over_limit', { limit: limits.generalChars, count: value.length });
      return value;

    case 'channel_name_template':
    case 'channel_status_template':
      if (typeof value !== 'string') return drop('setting_invalid');
      if (value.length > limits.templateChars)
        return drop('setting_over_limit', { limit: limits.templateChars, count: value.length });
      return value;

    case 'aliases': {
      if (!isStringMap(value)) return drop('setting_invalid');
      const entries = Object.entries(value);
      // A count overrun drops the whole key rather than an arbitrary subset: a
      // silent partial alias list is harder to explain than an untouched one.
      if (entries.length > limits.aliases)
        return drop('setting_over_limit', { limit: limits.aliases, count: entries.length });
      const kept: Record<string, string> = {};
      for (const [game, alias] of entries) {
        if (game.length > limits.aliasChars || alias.length > limits.aliasChars) {
          notes.push({
            code: 'setting_over_limit',
            severity: 'dropped',
            subject: `${key}.entry`,
            limit: limits.aliasChars,
          });
          continue;
        }
        kept[game] = alias;
      }
      return kept;
    }

    case 'custom_nicks': {
      if (!isStringMap(value)) return drop('setting_invalid');
      const entries = Object.entries(value);
      if (entries.length > limits.customNicks)
        return drop('setting_over_limit', { limit: limits.customNicks, count: entries.length });
      const kept: Record<string, string> = {};
      for (const [userId, nick] of entries) {
        // The key has to be a user snowflake: the render path looks a member up
        // by it, so anything else is dead weight in a blob every instance holds.
        if (!isSnowflake(userId) || nick.length > limits.customNickChars) {
          notes.push({
            code: 'setting_invalid',
            severity: 'dropped',
            subject: `${key}.entry`,
          });
          continue;
        }
        kept[userId] = nick;
      }
      return kept;
    }

    case 'logging': {
      if (value === false) return false; // explicitly off, a legal stored value
      if (!isSnowflake(value)) return drop('logging_unresolved');
      const fact = facts.channels.get(value);
      // Resolved against THIS guild, and `ServerLogger` binds the guild at the
      // read end too, because this value outlives whatever wrote it.
      if (!fact || fact.kind !== 'text')
        return drop('logging_unresolved', { name: fact?.name ?? undefined });
      if (!fact.botCanManage) return drop('logging_unresolved', { name: fact.name });
      return value;
    }

    case 'log_level':
      // Dropped rather than clamped, per the standing rule: the only clamp we
      // inherit is `planGuild`'s, and its output is already in range.
      if (value !== 1 && value !== 2 && value !== 3) return drop('setting_invalid');
      return value;

    case 'groups': {
      const record = asRecord(value);
      if (!record) return drop('setting_invalid');
      const entries = Object.entries(record);
      if (entries.length > limits.groups)
        return drop('setting_over_limit', { limit: limits.groups, count: entries.length });
      const kept: Record<string, unknown> = {};
      for (const [groupKey, config] of entries) {
        const shape = asRecord(config);
        if (!shape || typeof shape.above !== 'boolean') {
          notes.push({ code: 'setting_invalid', severity: 'dropped', subject: `${key}.entry` });
          continue;
        }
        // `groupKeyFor` validates nothing, so this is the only gate. A key
        // naming a category that is not here is never read, so the cost is a
        // preview line promising a grouping that can never apply.
        if (groupKey !== ROOT_GROUP_KEY) {
          const fact = facts.channels.get(groupKey);
          if (!fact || fact.kind !== 'category') {
            notes.push({
              code: 'group_unresolved',
              severity: 'dropped',
              subject: groupKey,
              name: fact?.name ?? undefined,
            });
            continue;
          }
        }
        kept[groupKey] = { above: shape.above };
      }
      return kept;
    }

    case 'contact_user_id': {
      if (!isSnowflake(value)) return drop('setting_invalid');
      // A file may nominate somebody other than whoever ran the command, and the
      // contact receives an unsolicited DM and an @-ping when automation breaks.
      // Accepted only while they are a member, which also catches the legacy
      // case: 20% of imported contacts have already left their server.
      if (facts.members.get(value) !== true) return drop('contact_not_member', { other: value });
      return value;
    }

    case 'problem_alerts':
      // `readProblemAlerts` silently reads an unrecognised value as `contact`,
      // the loudest of the three modes, so nothing downstream would catch this.
      if (typeof value !== 'string' || !PROBLEM_ALERT_VALUES.has(value))
        return drop('setting_invalid');
      return value;
  }
}

interface ChannelDiff {
  writes: { channelId: string; template: Record<string, unknown> }[];
  removals: string[];
  changes: ChannelChange[];
}

function diffCreatorChannels(
  incoming: IncomingConfig,
  storedCreators: Map<string, CurrentCreatorChannel>,
  storedAdopted: Map<string, CurrentAdoptedChannel>,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS,
  notes: ImportNote[],
  namedAnywhere: ReadonlySet<string>,
): ChannelDiff {
  const writes: ChannelDiff['writes'] = [];
  const changes: ChannelChange[] = [];

  for (const entry of incoming.creatorChannels) {
    const fact = resolveChannel(entry, facts, notes, 'voice');
    if (!fact) continue;

    if (storedAdopted.has(entry.channelId)) {
      notes.push({
        code: 'channel_already_adopted',
        severity: 'dropped',
        subject: entry.channelId,
        name: fact.name,
      });
      continue;
    }
    if (!fact.botCanManage) {
      // A warning, not a drop: the row is harmless until someone joins, and the
      // fix is a permission the admin can grant. Contrast an adopted channel,
      // where the row is actively destroyed by the next sweep.
      notes.push({
        code: 'channel_cannot_manage',
        severity: 'warning',
        subject: entry.channelId,
        name: fact.name,
        missingPermissions: fact.missingPermissions,
      });
    }

    const stored = storedCreators.get(entry.channelId);
    const template = buildTemplate(
      incoming.source,
      PRIMARY_FIELDS,
      entry.template,
      stored?.template ?? {},
      entry.channelId,
      facts,
      limits,
      notes,
    );

    if (stored && sameValue(template, stored.template)) continue;

    writes.push({ channelId: entry.channelId, template });
    changes.push({
      channelId: entry.channelId,
      name: fact.name,
      action: stored ? 'update' : 'adopt',
      fields: fieldChanges(PRIMARY_FIELDS, stored?.template ?? {}, template),
    });
  }

  const removals: string[] = [];
  if (incoming.authoritative) {
    for (const stored of storedCreators.values()) {
      // Computed from FILE ABSENCE only, never from a resolution failure: doing
      // it the other way round makes the write set "resolvable file entries"
      // and deletes exactly the rows the keep-the-row rule says to keep.
      if (namedAnywhere.has(stored.channelId)) continue;
      removals.push(stored.channelId);
      const fact = facts.channels.get(stored.channelId);
      changes.push({
        channelId: stored.channelId,
        name: fact?.name ?? null,
        action: 'remove',
        fields: [],
      });
      // Nothing else in the product can register an existing voice channel as a
      // creator channel: `createPrimary` always creates a new one. So this is
      // one-way, and the snapshot is the only route back.
      notes.push({
        code: 'creator_removal_is_one_way',
        severity: 'warning',
        subject: stored.channelId,
        name: fact?.name ?? undefined,
      });
    }
  }

  return { writes, removals, changes };
}

interface AdoptedDiff {
  writes: ImportPlan['adoptedWrites'];
  removals: string[];
  changes: ChannelChange[];
}

function diffAdoptedChannels(
  incoming: IncomingConfig,
  storedAdopted: Map<string, CurrentAdoptedChannel>,
  storedCreators: Map<string, CurrentCreatorChannel>,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS,
  notes: ImportNote[],
  namedAnywhere: ReadonlySet<string>,
): AdoptedDiff {
  const writes: AdoptedDiff['writes'] = [];
  const changes: ChannelChange[] = [];

  for (const entry of incoming.adoptedChannels) {
    const fact = resolveChannel(entry, facts, notes, 'voice');
    if (!fact) continue;

    if (storedCreators.has(entry.channelId)) {
      notes.push({
        code: 'channel_already_creator',
        severity: 'dropped',
        subject: entry.channelId,
        name: fact.name,
      });
      continue;
    }

    /**
     * A HARD DROP, not a warning, and this is the one that would have made the
     * feature quietly destructive. Write a `managed_channels` row for a channel
     * the bot cannot rename and the next reconcile sweep calls `rerenderManaged`
     * with `onUnmanageable: 'abandon'`, which on a permission error deletes the
     * row AND records a permission problem, which fires the outbound notifier
     * ladder. So the import reports success, un-adopts the channel minutes
     * later, and pushes an unsolicited notice into the guild.
     */
    if (!fact.botCanRename) {
      notes.push({
        code: 'channel_cannot_rename',
        severity: 'dropped',
        subject: entry.channelId,
        name: fact.name,
        missingPermissions: fact.missingPermissions,
      });
      continue;
    }

    const stored = storedAdopted.get(entry.channelId);
    const template = buildTemplate(
      incoming.source,
      MANAGED_FIELDS,
      entry.template,
      stored?.template ?? {},
      entry.channelId,
      facts,
      limits,
      notes,
    );
    const state = buildManagedState(entry.state, stored?.state ?? {});

    if (stored && sameValue(template, stored.template) && sameValue(state, stored.state)) continue;

    writes.push({ channelId: entry.channelId, template, state, firstTime: stored === undefined });
    changes.push({
      channelId: entry.channelId,
      name: fact.name,
      action: stored ? 'update' : 'adopt',
      fields: fieldChanges(MANAGED_FIELDS, stored?.template ?? {}, template),
    });
  }

  const removals: string[] = [];
  if (incoming.authoritative) {
    for (const stored of storedAdopted.values()) {
      if (namedAnywhere.has(stored.channelId)) continue;
      removals.push(stored.channelId);
      changes.push({
        channelId: stored.channelId,
        name: facts.channels.get(stored.channelId)?.name ?? null,
        action: 'remove',
        fields: [],
      });
    }
  }

  return { writes, removals, changes };
}

/**
 * Resolves a file entry against the guild, dropping and noting when it cannot.
 *
 * Every reason is a drop rather than a refusal: a file naming one channel that
 * has since been deleted should still import the rest.
 */
function resolveChannel(
  entry: IncomingCreator,
  facts: GuildFacts,
  notes: ImportNote[],
  want: ChannelKind,
): ChannelFact | undefined {
  const foreign = facts.foreignFleetChannels.get(entry.channelId);
  if (foreign !== undefined) {
    notes.push({
      code: 'channel_foreign_fleet',
      severity: 'dropped',
      subject: entry.channelId,
      name: facts.channels.get(entry.channelId)?.name ?? entry.channelName ?? undefined,
      other: foreign,
    });
    return undefined;
  }

  const fact = facts.channels.get(entry.channelId);
  if (!fact) {
    // A row written for a channel that was already deleted is PERMANENT: only a
    // `channelDelete` dispatch removes a primary row, and the deletion happened
    // before the row existed, so no event will ever fire for it.
    notes.push({
      code: 'channel_missing',
      severity: 'dropped',
      subject: entry.channelId,
      name: entry.channelName ?? undefined,
    });
    return undefined;
  }
  if (fact.kind !== want) {
    notes.push({
      code: 'channel_wrong_type',
      severity: 'dropped',
      subject: entry.channelId,
      name: fact.name,
    });
    return undefined;
  }
  return fact;
}

/**
 * Builds the template to write.
 *
 * Native replaces completely, using the file's nulls to mean "field absent".
 * Legacy merges over what is stored, restricted to the fields the legacy format
 * can express, which is what stops it clearing `status` and `defaultPrivate`.
 *
 * Unknown keys in the file's template are carried through untouched either way,
 * for expand/contract: during a rolling deploy an old instance can be handed a
 * file a new one wrote.
 */
function buildTemplate(
  source: ImportSource,
  fields: readonly string[],
  fileTemplate: Record<string, unknown>,
  storedTemplate: Record<string, unknown>,
  channelId: string,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS,
  notes: ImportNote[],
): Record<string, unknown> {
  const known = new Set<string>(fields);
  const out: Record<string, unknown> = {};

  if (source === 'legacy') {
    for (const [key, value] of Object.entries(storedTemplate)) out[key] = value;
  } else {
    // Unknown keys survive a native replace; known ones are governed by the
    // file's own value, including its nulls.
    for (const [key, value] of Object.entries(fileTemplate)) {
      if (!known.has(key) && value !== null && value !== undefined) out[key] = value;
    }
  }

  for (const field of fields) {
    if (source === 'legacy' && !LEGACY_TEMPLATE_FIELDS.includes(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(fileTemplate, field)) continue;

    const raw = fileTemplate[field];
    if (raw === null || raw === undefined) {
      // Native: the field is absent in the source, so absent here.
      // Legacy: the planner did not produce it, so leave what is stored.
      if (source === 'native') delete out[field];
      continue;
    }

    const value = validateTemplateField(field, raw, channelId, facts, limits, notes);
    if (value === undefined) continue;
    out[field] = value;
  }

  return out;
}

function validateTemplateField(
  field: string,
  value: unknown,
  channelId: string,
  facts: GuildFacts,
  limits: typeof IMPORT_LIMITS,
  notes: ImportNote[],
): unknown {
  const drop = (code: ImportNoteCode = 'template_field_invalid'): undefined => {
    notes.push({ code, severity: 'dropped', subject: `${channelId}.${field}` });
    return undefined;
  };

  switch (field) {
    case 'name':
    case 'status':
      if (typeof value !== 'string') return drop();
      return value.length > limits.templateChars ? drop() : value;
    case 'limit':
      if (typeof value !== 'number' || !Number.isInteger(value)) return drop();
      return value < 0 || value > limits.userLimit ? drop() : value;
    case 'above':
    case 'defaultPrivate':
      return typeof value === 'boolean' ? value : drop();
    case 'inheritperms': {
      if (typeof value !== 'string') return drop();
      if (value === 'primary' || value === 'category') return value;
      const fact = facts.channels.get(value);
      return fact ? value : drop('inheritperms_unresolved');
    }
    default:
      return value;
  }
}

/**
 * Merges the file's state over the stored state, never the other way round.
 *
 * `updateState` replaces the whole `state` column, which also holds `roster`
 * (arrival order, which decides `@@creator@@` and the owner). Writing the file's
 * state wholesale would reassign ownership on an occupied channel and force a
 * gratuitous rename. And the file's `seed` never overwrites a stored one, which
 * is what keeps the write one-shot: a seed exists to be stable for the life of
 * the channel.
 */
function buildManagedState(
  fileState: Record<string, unknown>,
  storedState: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...storedState };

  for (const field of MANAGED_STATE_FIELDS) {
    const raw = fileState[field];
    if (raw === null || raw === undefined) continue;
    if (field === 'seed') {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) continue;
      if (out.seed !== undefined) continue; // one-shot: a stored seed wins
      out.seed = raw;
      continue;
    }
    if (typeof raw === 'string') out[field] = raw;
  }

  return out;
}

function fieldChanges(
  fields: readonly string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ChannelFieldChange[] {
  const out: ChannelFieldChange[] = [];
  for (const field of fields) {
    if (sameValue(before[field], after[field])) continue;
    out.push({ field, before: before[field], after: after[field] });
  }
  return out;
}

/** Warnings that describe the import as a whole rather than one piece of it. */
function addWarnings(
  incoming: IncomingConfig,
  settingChanges: readonly SettingChange[],
  facts: GuildFacts,
  notes: ImportNote[],
): void {
  const enabled = settingChanges.find((c) => c.key === 'enabled');
  if (enabled && enabled.after === false) {
    // The most confusing thing an import can do: `parseVoiceSettings` reads
    // `enabled !== false`, so this switches AVC off fleet-wide the moment the
    // NOTIFY lands, and the symptom is "I imported my config and the bot
    // stopped working". Legitimate, so warned rather than refused.
    notes.push({ code: 'automation_switched_off', severity: 'warning', subject: 'enabled' });
  }

  // `planGuild` writes `above` unconditionally, so no legacy import can leave a
  // position field alone. Worth saying, because it is the one field a guild may
  // have deliberately changed through the rewrite.
  if (incoming.source === 'legacy') {
    notes.push({ code: 'position_overwritten', severity: 'warning', subject: 'above' });
    for (const field of incoming.legacy?.droppedFields ?? []) {
      notes.push({ code: 'legacy_field_dropped', severity: 'warning', subject: field });
    }
    if (incoming.legacy?.wasMarkedLeft) {
      notes.push({ code: 'legacy_marked_left', severity: 'warning', subject: facts.guildId });
    }
    for (const id of incoming.legacy?.orphanedTextChannels ?? []) {
      notes.push({
        code: 'orphaned_text_channel',
        severity: 'warning',
        subject: id,
        name: facts.channels.get(id)?.name ?? undefined,
      });
    }
    for (const id of incoming.legacy?.orphanedRoles ?? []) {
      notes.push({ code: 'orphaned_role', severity: 'warning', subject: id });
    }
  }

  /**
   * The warning the feature cannot omit.
   *
   * In the flow this exists for, a guild exports from the hosted bot and imports
   * into its own self-hosted one. Both then hold `auto_channels` rows for the
   * same ids in SEPARATE databases, so the foreign-fleet check cannot see the
   * collision, and both bots create a room on every join. It is the only failure
   * mode the headline flow produces every time.
   */
  const differentApp =
    incoming.sourceApplicationId !== null &&
    facts.applicationId !== null &&
    incoming.sourceApplicationId !== facts.applicationId;
  if (differentApp || facts.otherFleetsPresent.length > 0) {
    notes.push({
      code: 'other_bot_may_be_present',
      severity: 'warning',
      subject: facts.guildId,
      other: incoming.sourceApplicationId ?? undefined,
    });
  }
}
