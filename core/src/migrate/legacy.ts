import { z } from 'zod';

/**
 * The legacy Python bot's per-guild JSON, and the pure mapping onto the new
 * schema (`plans/migration.md` §2, §3, §4).
 *
 * Pure on purpose: every decision that could silently corrupt 1862 real guilds
 * is a function of its input, so it can be tested exhaustively rather than
 * discovered on the day. The writer that touches Postgres is separate.
 */

/** Discord's epoch, for recovering a channel's creation time from its id. */
const DISCORD_EPOCH = 1_420_070_400_000;

/**
 * Legacy shape, parsed leniently.
 *
 * `.passthrough()` and near-total optionality are deliberate: this is eight
 * years of accreted files written by several versions of a bot that never
 * validated anything. Rejecting an unexpected key would mean refusing to
 * migrate a guild over a field we already decided to drop (§4).
 */
/**
 * **The schema discovers shape; it does not validate.** Every field a value is
 * actually read from is `unknown`, and the mapping below narrows it.
 *
 * That is not laziness, it is the lesson from running this over the real dump.
 * The first draft typed `logging` as string-or-number, which is what 1858
 * guilds have. Two guilds store `logging: false`, meaning "off", and zod
 * rejected the *entire guild* over it, so both were silently counted as
 * departed and would never have been imported. A schema strict enough to
 * reject a field we already know how to ignore is a schema that loses guilds.
 *
 * Eight years of files, several bot versions, no validation on the way in. The
 * only safe assumption is that any field may be any type.
 */
export const legacySecondarySchema = z
  .object({
    creator: z.unknown(),
    priv: z.unknown(),
    jc: z.unknown(),
    msgs: z.unknown(),
    tc: z.unknown(),
    tcr: z.unknown(),
  })
  .passthrough();

export const legacyPrimarySchema = z
  .object({
    template: z.unknown(),
    above: z.unknown(),
    limit: z.unknown(),
    secondaries: z.unknown(),
  })
  .passthrough();

export const legacyGuildSchema = z
  .object({
    enabled: z.unknown(),
    general: z.unknown(),
    channel_name_template: z.unknown(),
    aliases: z.unknown(),
    custom_nicks: z.unknown(),
    logging: z.unknown(),
    log_level: z.unknown(),
    auto_channels: z.unknown(),
    /**
     * Truthy when the bot has left the guild: a `"YYYY-MM-DD HH:MM"` stamp on
     * 2781 files, `false` on 1844, absent on 18.
     */
    left: z.unknown(),
  })
  .passthrough();

export type LegacyGuild = z.infer<typeof legacyGuildSchema>;

/** Fields we knowingly do not carry (§4), used to report what a guild loses. */
export const DROPPED_FIELDS = [
  'custom_bitrates',
  'requiredrole',
  'restrictions',
  'text_channels',
  'text_channel_name',
  'msgs',
  'asip',
  'dcnf',
  'uniquenames',
  'stct',
  'prefix',
  'last_activity',
  'last_channel',
  'guild_name',
  'server_contact',
  'left',
] as const;

export interface PlannedSecondary {
  channelId: string;
  primaryChannelId: string;
  ownerId: string | null;
  private: boolean;
  createdAt: Date;
}

export interface PlannedJoinChannel {
  channelId: string;
  secondaryChannelId: string;
  creatorId: string | null;
}

export interface PlannedPrimary {
  channelId: string;
  template: Record<string, unknown>;
}

export interface GuildPlan {
  guildId: string;
  /** False when the bot has left: nothing is written, nothing is charged. */
  importable: boolean;
  skipReason?: string;
  settings: Record<string, unknown>;
  primaries: PlannedPrimary[];
  secondaries: PlannedSecondary[];
  joinChannels: PlannedJoinChannel[];
  /** Discord objects the legacy Gold feature left behind (§5.3). */
  orphanedTextChannels: string[];
  orphanedRoles: string[];
  droppedFields: string[];
  warnings: string[];
}

/** A channel's creation time, recovered from its snowflake. */
export function snowflakeToDate(id: string): Date | null {
  if (!/^\d{5,25}$/.test(id)) return null;
  const ms = Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  // A snowflake from before Discord existed, or from the future, is a corrupt
  // key rather than a channel.
  if (ms <= DISCORD_EPOCH || ms > Date.now() + 86_400_000) return null;
  return date;
}

/** Entries of a value that may not be an object at all. */
function entriesOf(value: unknown): [string, unknown][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value);
}

/** A record of string values, or null when there is nothing usable. */
function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

const asId = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(BigInt(Math.trunc(v)));
  if (typeof v === 'string' && /^\d{5,25}$/.test(v.trim())) return v.trim();
  return null;
};

/**
 * Whether the bot is still in this guild.
 *
 * The filter that decides the size of the whole migration: 2781 of 4644 files
 * are guilds the bot has left. Importing them would create rows for servers we
 * are not in and, because the importer starts trial clocks, eventually send
 * billing mail about them.
 */
export function hasLeft(guild: LegacyGuild): boolean {
  const value = guild.left;
  return value !== undefined && value !== null && value !== false;
}

export interface PlanOptions {
  /**
   * The guilds the bot is **actually in**, from Discord rather than from the
   * dump. Optional only so the mapping stays testable; the importer requires it.
   *
   * `left` is necessary and not sufficient, measured against the live fleet on
   * 2026-08-18: of 1862 files not marked left, only **1004** are guilds the bot
   * is still in. The other 858 are servers it was removed from while offline,
   * so no `GUILD_DELETE` was ever processed and the flag was never written.
   * Nothing marked `left` was wrongly excluded, so the flag has no false
   * positives, only false negatives.
   *
   * Importing those 858 would create rows for servers we are not in and, because
   * the importer starts trial clocks, eventually send billing mail about them.
   */
  liveGuildIds?: ReadonlySet<string>;
}

/**
 * Maps one legacy guild onto the new schema. No I/O, no clock, no randomness.
 */
export function planGuild(guildId: string, raw: unknown, options: PlanOptions = {}): GuildPlan {
  const parsed = legacyGuildSchema.safeParse(raw);
  const base: GuildPlan = {
    guildId,
    importable: false,
    settings: {},
    primaries: [],
    secondaries: [],
    joinChannels: [],
    orphanedTextChannels: [],
    orphanedRoles: [],
    droppedFields: [],
    warnings: [],
  };

  if (!parsed.success) {
    return { ...base, skipReason: `unparseable: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  const guild = parsed.data;

  if (hasLeft(guild)) {
    return { ...base, skipReason: 'bot has left this guild' };
  }

  // The dump's own flag is not enough; see PlanOptions.liveGuildIds.
  if (options.liveGuildIds && !options.liveGuildIds.has(guildId)) {
    return { ...base, skipReason: 'not in the live guild list (stale `left` flag)' };
  }

  const record = raw as Record<string, unknown>;
  const droppedFields = DROPPED_FIELDS.filter((f) => record[f] !== undefined);

  // -- settings (§3.1) ------------------------------------------------------
  const settings: Record<string, unknown> = {};
  if (typeof guild.enabled === 'boolean') settings.enabled = guild.enabled;
  if (typeof guild.general === 'string') settings.general = guild.general;
  if (typeof guild.channel_name_template === 'string') {
    settings.channel_name_template = guild.channel_name_template;
  }
  const aliases = stringMap(guild.aliases);
  if (aliases) settings.aliases = aliases;
  const nicks = stringMap(guild.custom_nicks);
  if (nicks) settings.custom_nicks = nicks;
  // The new schema stores channel ids as text; legacy wrote them as numbers.
  const loggingId = asId(guild.logging);
  if (loggingId) settings.logging = loggingId;
  if (guild.log_level !== undefined && guild.log_level !== null) {
    const level = Math.trunc(Number(guild.log_level));
    if (Number.isFinite(level)) settings.log_level = Math.min(3, Math.max(1, level));
  }

  const warnings: string[] = [];
  const primaries: PlannedPrimary[] = [];
  const secondaries: PlannedSecondary[] = [];
  const joinChannels: PlannedJoinChannel[] = [];
  const orphanedTextChannels: string[] = [];
  const orphanedRoles: string[] = [];

  for (const [rawPrimaryId, rawPrimary] of entriesOf(guild.auto_channels)) {
    const primaryId = asId(rawPrimaryId);
    if (!primaryId) {
      warnings.push(`skipped a primary with an unusable id: ${rawPrimaryId}`);
      continue;
    }
    const primary = legacyPrimarySchema.safeParse(rawPrimary ?? {});
    if (!primary.success) {
      warnings.push(`skipped primary ${primaryId}: unreadable`);
      continue;
    }
    const p = primary.data;

    // -- template (§3.2) ----------------------------------------------------
    const template: Record<string, unknown> = {};
    if (typeof p.template === 'string' && p.template.length > 0) {
      template.name = p.template;
    }
    const limit = Math.trunc(Number(p.limit));
    if (Number.isFinite(limit) && limit > 0) template.limit = Math.min(99, limit);

    /**
     * The position inversion, and the single most damaging thing this file can
     * get wrong.
     *
     * Legacy defaults to *above* (`functions.py:1209` sets `above = True` and
     * only flips on an explicit `False`); the rewrite defaults to *below*. 3380
     * primaries rely on the absent-means-above default, so the position is
     * written explicitly for every primary rather than ever left to a default.
     */
    template.above = p.above !== false;

    primaries.push({ channelId: primaryId, template });

    for (const [rawSecondaryId, rawSecondary] of entriesOf(p.secondaries)) {
      const secondaryId = asId(rawSecondaryId);
      if (!secondaryId) {
        warnings.push(`skipped a secondary with an unusable id: ${rawSecondaryId}`);
        continue;
      }
      const secondaryParsed = legacySecondarySchema.safeParse(rawSecondary ?? {});
      const secondary = secondaryParsed.success ? secondaryParsed.data : {};
      const createdAt = snowflakeToDate(secondaryId);
      if (!createdAt) {
        warnings.push(`skipped secondary ${secondaryId}: id is not a usable snowflake`);
        continue;
      }

      secondaries.push({
        channelId: secondaryId,
        primaryChannelId: primaryId,
        ownerId: asId(secondary.creator),
        private: secondary.priv === true,
        // From the snowflake, not now(): the reconciler derives `##` numbering
        // from sibling createdAt order, so this preserves the original numbers
        // and avoids a fleet-wide renumber on first reconcile.
        createdAt,
      });

      const jc = asId(secondary.jc);
      if (jc) {
        joinChannels.push({
          channelId: jc,
          secondaryChannelId: secondaryId,
          creatorId: asId(secondary.creator),
        });
      }

      // Gold "voice context" leftovers. Dropping the field is not enough: the
      // new bot will never clean these up, so they need Discord-side deletion.
      const tc = asId(secondary.tc);
      if (tc) orphanedTextChannels.push(tc);
      const tcr = asId(secondary.tcr);
      if (tcr) orphanedRoles.push(tcr);
    }
  }

  return {
    guildId,
    importable: true,
    settings,
    primaries,
    secondaries,
    joinChannels,
    orphanedTextChannels,
    orphanedRoles,
    droppedFields,
    warnings,
  };
}

/**
 * A guild's trial start, jittered forward 10 to 30 days (owner, 2026-08-18).
 *
 * Two jobs. It buys every imported guild at least 10 extra free days, and it
 * spreads the expiry wave across 20 days so the T-30, T-7 and T-1 notification
 * runs are not a single fleet-wide event a year out (`migration.md` §5.1).
 *
 * **Derived from the guild id, not random.** The importer is idempotent and
 * meant to be re-runnable, and a random jitter would reshuffle every guild's
 * clock on every run, which is both unfair and impossible to reason about after
 * the fact. Same input, same answer, forever.
 */
export function trialStartFor(guildId: string, importedAt: Date): Date {
  // FNV-1a. Not for security, only for a stable, well-spread bucket.
  let hash = 0x811c9dc5;
  for (let i = 0; i < guildId.length; i++) {
    hash ^= guildId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const days = 10 + (hash % 21); // 10..30 inclusive
  return new Date(importedAt.getTime() + days * 86_400_000);
}
