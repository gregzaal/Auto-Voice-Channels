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
} as const;

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
