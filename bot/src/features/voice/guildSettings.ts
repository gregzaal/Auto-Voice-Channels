import {
  DEFAULT_CHANNEL_NAME_TEMPLATE,
  DEFAULT_STATUS_TEMPLATE,
  isValidTimeZone,
} from './nameTemplate.js';
import type { GameNameMode } from './nameTemplate.js';

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
  timezone: 'timezone',
  lists: 'lists',
  gameNameMode: 'game_name_mode',
  textChannelName: 'text_channel_name',
  textChannelRole: 'text_channel_role',
  controlPanel: 'control_panel',
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
 * without the `m` flag also matches before a trailing newline, so
 * `/^\d{17,20}$/` happily accepts a string like `"123...\n"`. That would
 * render as an inert `<@123...\n>` and put a newline inside
 * `allowed_mentions.users`, which Discord rejects, failing the whole send.
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
  /** Per-user custom display names for `@@owner@@` (set via `/nick`). */
  customNicks: Record<string, string>;
  /**
   * IANA zone for the date and time tokens. `undefined` means UTC.
   *
   * Undefined rather than defaulted to `'UTC'` so a caller can tell "never
   * configured" from "deliberately UTC", which is what lets `/setup` and the
   * template editor point out that a date token is rendering in UTC.
   */
  timezone: string | undefined;
  /** Named `[[list:name]]` random pools. */
  lists: Record<string, string[]>;
  /**
   * How `@@game_name@@` resolves a tie for most-played game. `shared` names
   * both, `top` names one. See `GameNameMode`.
   */
  gameNameMode: GameNameMode;
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

/**
 * True only when `value` is a plain object whose values are all arrays of
 * strings, which is the shape of `lists`.
 *
 * Own-property enumeration via `Object.entries`, and the KEYS are not validated
 * here: `randomOptions` looks a name up with `hasOwnProperty`, so a stored
 * `constructor` key is inert rather than dangerous.
 */
export function isStringArrayMap(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => Array.isArray(v) && v.every((e) => typeof e === 'string'))
  );
}

function stringArrayMap(value: unknown): Record<string, string[]> {
  return isStringArrayMap(value) ? value : {};
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
    // Validated on the way out as well as in: the blob is `record(unknown)` at
    // the repository boundary and `/import` fills it from a file, so a zone
    // Intl does not know could otherwise reach the render path.
    timezone: readTimeZone(settings),
    lists: stringArrayMap(settings[SETTINGS_KEYS.lists]),
    gameNameMode: readGameNameMode(settings),
  };
}

/**
 * How a most-played tie resolves, defaulting to `shared`.
 *
 * `shared` is the default because it is what every guild has always had, and
 * naming one of two equally-played games is an opinion, not a correction.
 * Anything unrecognised reads as `shared` for the same reason: the blob is
 * `record(unknown)` at the repository boundary and `/import` fills it from a
 * file, so an unknown value must fall back to the behaviour nobody chose.
 */
export function readGameNameMode(settings: Record<string, unknown>): GameNameMode {
  return settings[SETTINGS_KEYS.gameNameMode] === 'top' ? 'top' : 'shared';
}

/**
 * What a companion text channel is called when a guild has not set a name.
 *
 * The legacy bot's default, kept deliberately: it is what people who are asking
 * for this feature back call these channels.
 */
export const DEFAULT_TEXT_CHANNEL_NAME = 'voice context';
/**
 * The name to give companion text channels, or `undefined` for the default.
 *
 * Stored as the admin typed it. Discord lowercases and hyphenates a text
 * channel name itself, so this is never exactly what the channel ends up
 * called, and every surface that shows it says so.
 */
export function readTextChannelName(settings: Record<string, unknown>): string | undefined {
  const raw = settings[SETTINGS_KEYS.textChannelName];
  // Trimmed-empty is refused as well as empty: Discord rejects a whitespace-only
  // channel name (50035), which would fail every create with nothing to show for
  // it, so an unusable stored value reads as absent and the default is used.
  return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= 100 ? raw : undefined;
}

/**
 * The role allowed to read every companion text channel, or null for none.
 *
 * The legacy bot's `showtextchannelsto`. Recognition of a moderation need, not
 * an entitlement: it grants one role read access to every private room
 * conversation in the server, which is why `/setup` and `/channelinfo` both
 * disclose it rather than leaving it in a settings blob a new admin inherits.
 */
export function readTextChannelRole(settings: Record<string, unknown>): string | null {
  const raw = settings[SETTINGS_KEYS.textChannelRole];
  return isSnowflake(raw) ? raw : null;
}
/** The stored zone, or `undefined` when absent or unrecognised. */
export function readTimeZone(settings: Record<string, unknown>): string | undefined {
  const raw = settings[SETTINGS_KEYS.timezone];
  return typeof raw === 'string' && isValidTimeZone(raw) ? raw : undefined;
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

/**
 * Reads the logging config from the settings blob (channel id + verbosity level).
 *
 * The id is validated, not merely truthy. Until `/import` existed the only
 * writer was the `/logging` modal, whose channel picker Discord scopes to the
 * guild, so any non-empty string was in practice a real channel here. A file an
 * admin uploads carries no such guarantee, and this value outlives whatever
 * wrote it. {@link ServerLogger} binds the guild at the read end too.
 */
export function readLogging(settings: Record<string, unknown>): LoggingConfig {
  const raw = settings[SETTINGS_KEYS.logging];
  const channelId = isSnowflake(raw) ? raw : null;
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
 * test can enumerate all three without a hand-copied list of literals that
 * could drift from the messages actually sent.
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
 * The line confirming a time zone, quoting the current local time in it.
 *
 * The time is the confirmation. A zone name is easy to mistype into a real but
 * wrong zone (`America/Indiana/Indianapolis` against `America/Indianapolis`),
 * and an admin who can see it is 19:30 there knows immediately whether they got
 * the one they meant.
 *
 * Lives here beside {@link problemAlertConfirmation} so the copy-rules test can
 * reach it without a hand-copied list of literals.
 */
export function timeZoneConfirmation(zone: string, now: Date): string {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return `🕓 Time zone set to **${zone}**. It is ${clock} there now.`;
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

/**
 * The controls the room control panel can carry, in the order they are shown.
 *
 * Order is fixed here rather than configurable, which is the whole reason this
 * is a list and not a set: an admin can take a button away, and cannot move one.
 * Appending is safe; reordering changes every server's panel at once, and
 * renaming an id silently re-enables a control somebody switched off, because
 * the stored map is keyed by these strings.
 */
export const CONTROL_PANEL_CONTROLS = [
  'lock',
  'unlock',
  'limit',
  'rename',
  'claim',
  'transfer',
  'kick',
  'info',
] as const;

export type ControlPanelControl = (typeof CONTROL_PANEL_CONTROLS)[number];

/**
 * The entry inside the control panel map that switches the whole panel off.
 *
 * It shares the map with the per-button flags rather than taking a settings key
 * of its own, so `/controlpanel` writes one key and an export carries one
 * field. It cannot collide with a control id because
 * {@link isControlPanelControl} checks against the fixed list above, and
 * `panel` is not on it.
 */
export const CONTROL_PANEL_ENABLED_KEY = 'panel';

/** Anything `/controlpanel` can switch: one control, or the panel itself. */
export type ControlPanelEntry = ControlPanelControl | typeof CONTROL_PANEL_ENABLED_KEY;

/** True only for a string this build recognises as a control id. */
export function isControlPanelControl(value: unknown): value is ControlPanelControl {
  return typeof value === 'string' && (CONTROL_PANEL_CONTROLS as readonly string[]).includes(value);
}

/**
 * One server's room control panel configuration.
 *
 * `enabled` is the panel itself; `controls` is which buttons it carries. Both
 * default to on, because the panel ships on by default and a server that has
 * never run `/controlpanel` has no stored key at all.
 */
export interface ControlPanelConfig {
  enabled: boolean;
  controls: Record<ControlPanelControl, boolean>;
}

/**
 * Reads the control panel configuration from the settings blob.
 *
 * **Only what an admin has switched OFF is ever stored**, so an absent key, an
 * empty map and a corrupt value all read as "everything on", which is the
 * documented default. Unknown ids are ignored rather than refused: a file
 * exported from a newer build can carry a control this one has never heard of,
 * and losing the rest of the map over it would be worse than ignoring it.
 *
 * The returned object is freshly built every call rather than handed back by
 * reference. `SettingsCache` serves the same row object to every caller on the
 * instance, so returning a stored reference would let one caller's mutation
 * corrupt every other guild read in the process, with no write and no
 * invalidation behind it.
 */
export function readControlPanel(settings: Record<string, unknown>): ControlPanelConfig {
  const controls = Object.fromEntries(CONTROL_PANEL_CONTROLS.map((c) => [c, true])) as Record<
    ControlPanelControl,
    boolean
  >;
  const config: ControlPanelConfig = { enabled: true, controls };
  const raw = settings[SETTINGS_KEYS.controlPanel];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return config;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'boolean') continue;
    if (key === CONTROL_PANEL_ENABLED_KEY) {
      config.enabled = value;
      continue;
    }
    if (isControlPanelControl(key)) config.controls[key] = value;
  }
  return config;
}

/** How each control reads in a `/controlpanel` confirmation. */
const CONTROL_PANEL_NAMES: Record<ControlPanelControl, string> = {
  lock: 'Lock',
  unlock: 'Unlock',
  limit: 'Limit',
  rename: 'Rename',
  claim: 'Claim',
  transfer: 'Transfer',
  kick: 'Kick',
  info: 'Info',
};

/**
 * What `/controlpanel` says after a toggle.
 *
 * Every one of them names the rooms that already exist, because the panel is
 * posted once when a room is made and is never edited afterwards. An admin who
 * is told only "turned off" and then finds the button still there in the room
 * they are sitting in will reasonably conclude the setting did not save.
 */
export function controlPanelConfirmation(control: ControlPanelEntry, on: boolean): string {
  const rooms = ' Rooms that already exist keep the panel they were given.';
  if (control === CONTROL_PANEL_ENABLED_KEY) {
    return on
      ? 'New rooms will get the control panel in their chat again.' + rooms
      : 'New rooms will not get a control panel.' +
          rooms +
          ' Every button has a command that still works.';
  }
  const name = CONTROL_PANEL_NAMES[control];
  return on
    ? `New rooms will show the **${name}** button again.` + rooms
    : `New rooms will not show the **${name}** button.` +
        rooms +
        ' The command behind it still works.';
}

/** One category's grouping config, or `undefined` when that category isn't grouped. */
export function readGroup(
  settings: Record<string, unknown>,
  categoryKey: string,
): GroupConfig | undefined {
  return readGroups(settings)[categoryKey];
}
