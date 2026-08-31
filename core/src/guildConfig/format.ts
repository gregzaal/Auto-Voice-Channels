import { z } from 'zod';

/**
 * The `/export` file format: one guild's AVC configuration, versioned.
 *
 * **The governing invariant, and everything else here follows from it:**
 *
 * > A wire value of `null` means the key is ABSENT from the stored blob.
 * > Any other value is the stored value verbatim.
 *
 * That is what makes the round trip exact, and an exact round trip is what makes
 * the pre-import snapshot a real undo rather than an approximation
 * (`plans/import_command.md` §6.3). Two failure modes it closes, both of which
 * an "omit what is unset" format has:
 *
 * - **`""` and absent are different values, and the runtime distinguishes them at
 *   three levels.** An absent `channel_status_template` means "use
 *   `DEFAULT_STATUS_TEMPLATE`", while `""` means "no status at all". A guild that
 *   never configured one, exported, and imported its own file back would lose
 *   voice statuses on every room forever, and the diff line would read
 *   `(unset) -> ""`, which nobody reads as that. Same distinction per creator
 *   channel and per adopted channel, where absent means inherit the guild
 *   template.
 * - **A snapshot that omits what the guild did not have cannot undo an
 *   addition.** Import sets `logging`, the snapshot has no `logging` key, and
 *   re-importing leaves logging switched on.
 *
 * The consequence for whoever writes the exporter: **read the RAW settings blob
 * and the RAW `template` / `state` columns.** Never `parseVoiceSettings`,
 * `readLogging` or `readProblemAlerts`, which materialise defaults, so a round
 * trip through them would pin every guild to whatever the default string was on
 * the day of the export. And never a zod re-parse of a template before writing
 * it back, which strips any field a newer build added.
 *
 * This module is deliberately free of anything Discord-shaped and of any I/O, so
 * both the bot and any future web surface can use it.
 */

/** The only version this build writes. Bumping it is a format change, not a tidy-up. */
export const AVC_EXPORT_VERSION = 1;

/**
 * The eleven settings keys a file carries, as they appear on the wire.
 *
 * These are the literal keys of the `guilds.settings` blob, mirroring
 * `SETTINGS_KEYS` in `bot/src/features/voice/guildSettings.ts`, which cannot be
 * imported here because it pulls in the bot's template engine.
 * `settingsKeys.unit.test.ts` in the bot binds the two lists mechanically, so a
 * twelfth key cannot appear there and be silently missing from every export.
 */
export const EXPORT_SETTINGS_KEYS = [
  'enabled',
  'general',
  'channel_name_template',
  'channel_status_template',
  'aliases',
  'custom_nicks',
  'logging',
  'log_level',
  'groups',
  'contact_user_id',
  'problem_alerts',
] as const;

export type ExportSettingsKey = (typeof EXPORT_SETTINGS_KEYS)[number];

/** A map of string to string, which is the shape of `aliases` and `custom_nicks`. */
const stringMap = z.record(z.string(), z.string());

/** One category's grouping config, mirroring `GroupConfig` on the bot side. */
const groupConfig = z.object({ above: z.boolean() });

/**
 * Every key required and every key nullable: a total document.
 *
 * Required rather than optional so a serializer that forgets one fails here
 * instead of producing a file whose missing key silently means "leave alone".
 * The only place absent is legal is a LEGACY file, which does not go through
 * this schema at all.
 */
export const exportedSettingsSchema = z.object({
  enabled: z.boolean().nullable(),
  general: z.string().nullable(),
  channel_name_template: z.string().nullable(),
  channel_status_template: z.string().nullable(),
  aliases: stringMap.nullable(),
  custom_nicks: stringMap.nullable(),
  /** A channel id, or `false` for explicitly off, or `null` for never configured. */
  logging: z.union([z.string(), z.literal(false)]).nullable(),
  log_level: z.number().int().nullable(),
  groups: z.record(z.string(), groupConfig).nullable(),
  contact_user_id: z.string().nullable(),
  problem_alerts: z.string().nullable(),
});

export type ExportedSettings = z.infer<typeof exportedSettingsSchema>;

/**
 * A creator channel's template on the wire: all six fields of
 * `primaryTemplateSchema`, each nullable, unknown keys preserved.
 *
 * `passthrough` is load-bearing for expand/contract (golden rule 3): during a
 * rolling deploy an old instance can be handed a file a new instance wrote, and
 * stripping a field it does not know about would silently drop configuration on
 * the one command that bulk-writes this column.
 */
export const exportedPrimaryTemplateSchema = z
  .object({
    name: z.string().nullable(),
    status: z.string().nullable(),
    limit: z.number().int().nullable(),
    above: z.boolean().nullable(),
    defaultPrivate: z.boolean().nullable(),
    inheritperms: z.string().nullable(),
  })
  .passthrough();

export const exportedManagedTemplateSchema = z
  .object({
    name: z.string().nullable(),
    status: z.string().nullable(),
  })
  .passthrough();

/**
 * The parts of an adopted channel's `state` column worth carrying.
 *
 * `seed` fixes `[[a/b/c]]` and `@@random_emoji@@` for the life of the channel.
 * `name` and `status` are the last-rendered values used to skip a no-op rename,
 * and carrying them is what stops every adopted channel getting renamed on the
 * first pass after an import even when its name is already exactly right: a
 * Discord write, a `serverLog` line and a rename-rate-limit slot per channel.
 *
 * `roster` is deliberately absent. It is live occupancy, not configuration, and
 * importing one guild's arrival order into a channel with different people in it
 * would reassign `@@creator@@` to somebody who is not there.
 */
export const exportedManagedStateSchema = z
  .object({
    seed: z.number().int().nullable(),
    name: z.string().nullable(),
    status: z.string().nullable(),
  })
  .passthrough();

export const exportedCreatorChannelSchema = z.object({
  channel_id: z.string(),
  /** For legibility and for the preview, which should never quote a bare snowflake. */
  channel_name: z.string().nullable(),
  template: exportedPrimaryTemplateSchema,
});

export const exportedAdoptedChannelSchema = z.object({
  channel_id: z.string(),
  channel_name: z.string().nullable(),
  template: exportedManagedTemplateSchema,
  state: exportedManagedStateSchema,
});

export const guildConfigFileSchema = z.object({
  avc_export_version: z.number().int(),
  exported_at: z.string(),
  guild_id: z.string(),
  guild_name: z.string().nullable(),
  /**
   * The exporting bot's application id, which is public and identifies it
   * unambiguously.
   *
   * **A mismatch is never a refusal.** In the flow this whole feature exists for
   * it differs by construction: the hosted bot exports and the self-hoster's own
   * application imports. It is the trigger for the two-bots warning
   * (`plans/import_command.md` §5.9), nothing else.
   */
  source_application_id: z.string().nullable(),
  /**
   * Human-readable note when more than one AVC fleet is configured in the source
   * guild, because both channel repositories AND their own fleet onto every
   * read, so the file is one fleet's view while the envelope names the server.
   */
  source_fleet_channel_scope: z.string().nullable(),
  settings: exportedSettingsSchema,
  creator_channels: z.array(exportedCreatorChannelSchema),
  adopted_channels: z.array(exportedAdoptedChannelSchema),
});

export type GuildConfigFile = z.infer<typeof guildConfigFileSchema>;
export type ExportedCreatorChannel = z.infer<typeof exportedCreatorChannelSchema>;
export type ExportedAdoptedChannel = z.infer<typeof exportedAdoptedChannelSchema>;

/**
 * Serializes a file. Two-space indent, because `channel_name` only earns its
 * place if a human can read the result.
 */
export function serializeGuildConfig(file: GuildConfigFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** `avc-config-<guildId>-<YYYY-MM-DD>.json`. */
export function exportFilename(guildId: string, at: Date): string {
  return `avc-config-${guildId}-${at.toISOString().slice(0, 10)}.json`;
}

/**
 * The pre-import snapshot's filename, deliberately different from
 * {@link exportFilename}.
 *
 * Two files reach the admin in this feature, and the undo depends on being able
 * to tell them apart.
 */
export function snapshotFilename(guildId: string, at: Date): string {
  return `avc-config-before-import-${guildId}-${at.toISOString().slice(0, 10)}.json`;
}

/**
 * The guild id a legacy filename encodes, or null when it encodes none.
 *
 * A legacy dump's files are named `<guildId>.json`, which the bulk importer
 * recovers by stripping the extension, so a bare snowflake test against the
 * whole filename never matches the real corpus. That mattered: the filename is
 * the ONLY cross-guild check a legacy file offers, since the format carries no
 * guild id of its own.
 *
 * Returns null for a renamed file, which is the case a soft check is for. A
 * name that does parse and does not match is refused by the differ.
 */
export function parseFilenameGuildId(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const base = filename.replace(/\.json$/i, '').trim();
  return /^\d{17,20}$/.test(base) ? base : null;
}

export type SniffResult =
  | { format: 'native'; version: number }
  | { format: 'legacy' }
  | { format: 'unreadable'; reason: string };

/**
 * Decides which format a parsed file is, and refuses rather than guessing.
 *
 * A version we know is native; no version key at all is legacy, which is the
 * legacy dump's actual shape. Anything else is refused with the reason.
 * Forwards only: version 2 reading a version 1 file is a supported case, version
 * 1 reading a version 2 file is a refusal, because a field this build does not
 * know about may be the one that changes what a value means.
 */
export function sniffFormat(parsed: unknown): SniffResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { format: 'unreadable', reason: 'the file is not a JSON object' };
  }
  const raw = (parsed as Record<string, unknown>)['avc_export_version'];
  if (raw === undefined) return { format: 'legacy' };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return {
      format: 'unreadable',
      reason: 'avc_export_version is present but is not a whole number',
    };
  }
  if (raw > AVC_EXPORT_VERSION) {
    return {
      format: 'unreadable',
      reason: `the file is version ${raw} and this bot reads up to version ${AVC_EXPORT_VERSION}. Update the bot, or export again from it`,
    };
  }
  if (raw < 1) {
    return { format: 'unreadable', reason: `version ${raw} is not a version this bot ever wrote` };
  }
  return { format: 'native', version: raw };
}

export type ParseNativeResult = { ok: true; file: GuildConfigFile } | { ok: false; reason: string };

/**
 * Validates a parsed native file.
 *
 * The failure reason names the path and the problem and **never the value**: an
 * error from here can reach the admin channel through `reportError`, and file
 * content must not travel that way (`plans/import_command.md` §9).
 */
export function parseNativeFile(parsed: unknown): ParseNativeResult {
  const result = guildConfigFileSchema.safeParse(parsed);
  if (result.success) return { ok: true, file: result.data };
  const first = result.error.issues[0];
  const where = first?.path.join('.') || 'the file';
  return { ok: false, reason: `${where}: ${first?.code ?? 'is not the expected shape'}` };
}
