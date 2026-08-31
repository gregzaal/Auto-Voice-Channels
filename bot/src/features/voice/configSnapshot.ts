import {
  AVC_EXPORT_VERSION,
  EXPORT_SETTINGS_KEYS,
  type AutoChannelRepository,
  type CurrentConfig,
  type ExportedSettings,
  type GuildConfigFile,
  type GuildSettingsReader,
  type ManagedChannelRepository,
} from '@avc/core';

/**
 * Reads a guild's configuration into the export shape. One reader, three
 * callers: `/export`, the pre-import snapshot, and the apply-time diff.
 *
 * **Everything here reads the RAW columns.** Never `parseVoiceSettings`,
 * `readLogging`, `readProblemAlerts` or a zod re-parse of a template, all of
 * which materialise defaults or strip unknown fields. Two consequences if that
 * rule is broken, both silent:
 *
 * - A round trip through a default-materialising reader PINS the guild to
 *   whatever the default string was on the day of the export. The guild then
 *   stops following the product default forever, and nothing says so.
 * - A zod re-parse drops any template field a newer build added, so during a
 *   rolling deploy an old instance exporting a new instance's guild silently
 *   loses configuration (golden rule 3).
 *
 * The format's own invariant does the rest: `null` on the wire means the key is
 * ABSENT from the stored blob, so the exporter is a straight `?? null` per key
 * and the importer's "restore absence" is exact.
 */

export interface ConfigSnapshotDeps {
  guilds: GuildSettingsReader;
  autoChannels: AutoChannelRepository;
  managed: ManagedChannelRepository;
}

/** How the caller resolves a channel id to its current Discord name. */
export type ChannelNameLookup = (channelId: string) => string | null;

/**
 * The guild as stored, for the differ.
 *
 * Note this includes rows whose Discord channel no longer exists. That is
 * deliberate and load-bearing: `/export` emitting them is what keeps a
 * re-import from reading them as "absent from the file" and removing them,
 * which would turn the keep-the-row rule into a delete on the next round trip.
 */
export async function readCurrentConfig(
  deps: ConfigSnapshotDeps,
  guildId: string,
): Promise<CurrentConfig> {
  const [guild, creators, adopted] = await Promise.all([
    deps.guilds.ensure(guildId),
    deps.autoChannels.listByGuild(guildId),
    deps.managed.listByGuild(guildId),
  ]);

  return {
    settings: (guild.settings ?? {}) as Record<string, unknown>,
    creatorChannels: creators.map((row) => ({
      channelId: row.channelId,
      template: row.template as Record<string, unknown>,
    })),
    adoptedChannels: adopted.map((row) => ({
      channelId: row.channelId,
      template: row.template as Record<string, unknown>,
      state: row.state as Record<string, unknown>,
    })),
  };
}

export interface BuildExportOptions {
  guildId: string;
  guildName: string | null;
  /** This bot's application id, so `/import` can spot a different bot. */
  applicationId: string | null;
  /** Other AVC fleets present here, which makes the file one fleet's view. */
  otherFleetsPresent: readonly string[];
  channelName: ChannelNameLookup;
  exportedAt: Date;
}

/** Builds the file. Pure given the config and the options. */
export function buildExportFile(
  current: CurrentConfig,
  options: BuildExportOptions,
): GuildConfigFile {
  return {
    avc_export_version: AVC_EXPORT_VERSION,
    exported_at: options.exportedAt.toISOString(),
    guild_id: options.guildId,
    guild_name: options.guildName,
    source_application_id: options.applicationId,
    source_fleet_channel_scope: fleetScopeNote(options.otherFleetsPresent),
    settings: exportedSettings(current.settings),
    creator_channels: current.creatorChannels.map((row) => ({
      channel_id: row.channelId,
      channel_name: options.channelName(row.channelId),
      template: asWireTemplate({
        name: pick(row.template, 'name'),
        status: pick(row.template, 'status'),
        limit: pick(row.template, 'limit'),
        above: pick(row.template, 'above'),
        defaultPrivate: pick(row.template, 'defaultPrivate'),
        inheritperms: pick(row.template, 'inheritperms'),
        // Unknown keys carried through, for the rolling-deploy case above.
        ...unknownKeys(row.template, [
          'name',
          'status',
          'limit',
          'above',
          'defaultPrivate',
          'inheritperms',
        ]),
      }),
    })),
    adopted_channels: current.adoptedChannels.map((row) => ({
      channel_id: row.channelId,
      channel_name: options.channelName(row.channelId),
      template: asWireTemplate({
        name: pick(row.template, 'name'),
        status: pick(row.template, 'status'),
        ...unknownKeys(row.template, ['name', 'status']),
      }),
      /**
       * `seed`, `name` and `status`, and deliberately NOT `roster`.
       *
       * `seed` keeps `[[a/b/c]]` and `@@random_emoji@@` stable. `name` and
       * `status` are the last-rendered values, and carrying them is what stops
       * every adopted channel getting renamed on the first pass after an import
       * even when its name is already right. `roster` is live occupancy, and
       * importing one moment's arrival order would reassign `@@creator@@` to
       * somebody who is not in the channel.
       */
      state: asWireTemplate({
        seed: pick(row.state, 'seed'),
        name: pick(row.state, 'name'),
        status: pick(row.state, 'status'),
      }),
    })),
  };
}

/**
 * A short note when the file is one fleet's view of the guild rather than the
 * whole server.
 *
 * Both channel repositories AND their own fleet onto every read, so in a guild
 * running two AVC bots `/export` genuinely cannot see the other one's channels.
 * Exporting them would be wrong (they belong to that fleet), so the file says so
 * instead of quietly under-reporting.
 */
function fleetScopeNote(otherFleetsPresent: readonly string[]): string | null {
  if (otherFleetsPresent.length === 0) return null;
  return 'another AVC bot is also set up in this server, and its creator channels are not in this file';
}

/**
 * The raw stored value, or `null` when the key is absent.
 *
 * Returns whatever is stored, including a value of the wrong type, rather than
 * coercing it. That is deliberate: the file mirrors the blob, and `/import`'s
 * differ is the gate that drops a bad value WITH A NOTE. Coercing to null here
 * would instead make a round trip silently CLEAR the key, since null means
 * absent, which is a mutation nobody asked for and nothing would report.
 */
function pick(source: Record<string, unknown>, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return null;
  return source[key] ?? null;
}

/**
 * The single widening point between a stored jsonb blob and the wire schema.
 *
 * `template` and `state` are `Record<string, unknown>` in the database and the
 * schemas that describe them are `passthrough`, so the shapes agree at runtime
 * and cannot be made to agree at compile time without either coercing values
 * (which would silently clear keys on a round trip, see {@link pick}) or
 * re-parsing through zod (which would make `/export` throw on a value some
 * older build wrote). One named cast, with the reason, beats three anonymous
 * ones.
 */
function asWireTemplate<T>(value: Record<string, unknown>): T {
  return value as T;
}

function unknownKeys(
  source: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (known.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Every one of the eleven keys, `null` where the blob has none. */
function exportedSettings(settings: Record<string, unknown>): ExportedSettings {
  const out: Record<string, unknown> = {};
  for (const key of EXPORT_SETTINGS_KEYS) {
    out[key] = Object.prototype.hasOwnProperty.call(settings, key) ? (settings[key] ?? null) : null;
  }
  return out as ExportedSettings;
}
