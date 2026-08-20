import { DEFAULT_CHANNEL_NAME_TEMPLATE, DEFAULT_STATUS_TEMPLATE } from './nameTemplate.js';

/**
 * Single source of truth for reading the guild `settings` jsonb blob. The blob is
 * validated only as `record(unknown)` at the repo boundary, so every field read
 * is defensive here — and done in ONE place so the voice feature, the settings
 * service, and the server logger can't drift apart.
 */
export const SETTINGS_KEYS = {
  enabled: 'enabled',
  general: 'general',
  nameTemplate: 'channel_name_template',
  statusTemplate: 'channel_status_template',
  aliases: 'aliases',
  customNicks: 'custom_nicks',
  logging: 'logging',
  logLevel: 'log_level',
  groups: 'groups',
  contact: 'contact_user_id',
  problemAlerts: 'problem_alerts',
} as const;

/**
 * A Discord user snowflake, 17 to 20 digits.
 *
 * Checked at both ends. The settings blob is `record(unknown)` at the repo
 * boundary, so a bad value is only ever caught here, and the legacy dump stores
 * snowflakes as JSON NUMBERS, which lose precision above 2^53 and arrive as a
 * plausible-looking but wrong id.
 */
const DIGITS = /^[0-9]+$/;

/**
 * The guild's designated contact: whoever most recently set up a creator
 * channel or its template.
 *
 * Restored from the legacy bot's `server_contact`, which was set on channel
 * creation and used for exactly this, working out who to talk to when the
 * automation breaks. The person who configured the bot is a better bet than the
 * server owner, who often has never touched it. Callers must still fall back to
 * the owner: 20% of imported contacts have already left their server.
 */
export function readContact(settings: Record<string, unknown>): string | null {
  const raw = settings[SETTINGS_KEYS.contact];
  return isSnowflake(raw) ? raw : null;
}

/**
 * Validates a snowflake, at both the read and the write end.
 *
 * The length check is explicit rather than leaning on the regex's `$`, which
 * without the `m` flag also matches before a trailing newline: `/^\d{17,20}$/`
 * happily accepts `"123...
"`. That would render as an inert `<@123...
>` and
 * put a newline inside `allowed_mentions.users`, which Discord rejects, failing
 * the whole send.
 */
export function isSnowflake(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 17 && value.length <= 20 && DIGITS.test(value)
  );
}

/** Settings-key sentinel for grouping creator channels that sit at the server root. */
export const ROOT_GROUP_KEY = '@root';

/** The `groups` settings key for a category id (or `null`/`undefined` → server root). */
export function groupKeyFor(categoryId: string | null | undefined): string {
  return categoryId ?? ROOT_GROUP_KEY;
}

/** One category's grouping config: present ⇒ grouped; `above` is the single direction. */
export interface GroupConfig {
  above: boolean;
}

/** Guild settings relevant to the voice feature (names, aliases, nicks, …). */
export interface VoiceSettings {
  enabled: boolean;
  channelNameTemplate: string;
  channelStatusTemplate: string;
  aliases: Record<string, string>;
  general: string;
  /** Per-user custom display names for `@@creator@@` (set via `/nick`). */
  customNicks: Record<string, string>;
}

/** True only when `value` is a plain object whose values are ALL strings. */
export function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringMap(value: unknown): Record<string, string> {
  return isStringMap(value) ? value : {};
}

/** Parses the voice-relevant settings, applying defaults for missing/invalid fields. */
export function parseVoiceSettings(settings: Record<string, unknown>): VoiceSettings {
  return {
    enabled: settings[SETTINGS_KEYS.enabled] !== false,
    channelNameTemplate: asString(
      settings[SETTINGS_KEYS.nameTemplate],
      DEFAULT_CHANNEL_NAME_TEMPLATE,
    ),
    channelStatusTemplate: asString(
      settings[SETTINGS_KEYS.statusTemplate],
      DEFAULT_STATUS_TEMPLATE,
    ),
    aliases: stringMap(settings[SETTINGS_KEYS.aliases]),
    general: asString(settings[SETTINGS_KEYS.general], 'General'),
    customNicks: stringMap(settings[SETTINGS_KEYS.customNicks]),
  };
}

/** The display name to use for a member, honouring their `/nick` override. */
export function displayName(
  settings: VoiceSettings,
  member: { id: string; displayName: string },
): string {
  return settings.customNicks[member.id] ?? member.displayName;
}

/** The per-guild logging configuration. */
export interface LoggingConfig {
  enabled: boolean;
  level: 1 | 2 | 3;
  channelId: string | null;
}

/** Reads the logging config from the settings blob (channel id + verbosity level). */
export function readLogging(settings: Record<string, unknown>): LoggingConfig {
  const raw = settings[SETTINGS_KEYS.logging];
  const channelId = typeof raw === 'string' && raw ? raw : null;
  const lvl = settings[SETTINGS_KEYS.logLevel];
  const level: 1 | 2 | 3 = lvl === 2 || lvl === 3 ? lvl : 1;
  return { enabled: channelId !== null, level, channelId };
}

/**
 * How a guild wants to hear about a problem only an admin can fix.
 *
 * `contact` mentions the guild's recorded setup contact, and only while they are
 * still a member. It never mentions the owner: the owner is the fallback for who
 * receives a DM, and a fallback is a guess, which is good enough to deliver to
 * and not good enough to ping. `quiet` still delivers, mentioning nobody. `off`
 * stops the push entirely, and `/setup` remains the pull.
 */
export type ProblemAlertMode = 'contact' | 'quiet' | 'off';

/**
 * Reads the problem-alert preference, defaulting to `contact`.
 *
 * **On rather than off by default, which is a deliberate departure from how
 * `/logging` works.** `/logging` is an event stream nobody asked for until they
 * ask, so it stays silent; this fires only when the bot has already stopped
 * doing the job the guild installed it for, and the whole reason
 * `contact_user_id` exists is to answer "who do we talk to when a guild's
 * automation breaks". A default of `quiet` would leave the message sitting in
 * a channel nobody reads, which is the delivery gap this exists to close.
 */
export function readProblemAlerts(settings: Record<string, unknown>): ProblemAlertMode {
  const raw = settings[SETTINGS_KEYS.problemAlerts];
  // `false` is accepted alongside `'off'` because the `logging` key next door
  // uses `false` for the same meaning, and an admin tool writing the obvious
  // thing should not silently leave alerts on.
  if (raw === false || raw === 'off') return 'off';
  if (raw === 'quiet') return 'quiet';
  return 'contact';
}

/**
 * The line confirming what a guild just chose, appended to the `/logging` reply.
 *
 * Lives here rather than inline in `GuildSettingsService` so the copy-rules
 * test can enumerate all three without a hand-copied list of literals, which is
 * the thing AGENTS.md says rots.
 *
 * Never says "here": the notice goes to the server's system channel or a DM,
 * not to the log channel this panel is otherwise about.
 */
export function problemAlertConfirmation(mode: ProblemAlertMode): string {
  if (mode === 'off')
    return '🔕 Problems only I can flag will show up in `/setup`, and nowhere else.';
  if (mode === 'quiet') {
    return '🔔 If AVC stops working I will say so in the server, without mentioning anyone.';
  }
  return '🔔 If AVC stops working I will say so in the server, and mention whoever set it up.';
}

/**
 * Reads the per-category grouping map from the settings blob: `categoryKey →
 * { above }`, where a present key means that category is grouped. Keys are
 * category ids or the {@link ROOT_GROUP_KEY} sentinel. Defensive against malformed
 * data (a corrupt entry is skipped, not thrown).
 */
export function readGroups(settings: Record<string, unknown>): Record<string, GroupConfig> {
  const raw = settings[SETTINGS_KEYS.groups];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, GroupConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = { above: (value as { above?: unknown }).above === true };
    }
  }
  return out;
}

/** One category's grouping config, or `undefined` when that category isn't grouped. */
export function readGroup(
  settings: Record<string, unknown>,
  categoryKey: string,
): GroupConfig | undefined {
  return readGroups(settings)[categoryKey];
}
