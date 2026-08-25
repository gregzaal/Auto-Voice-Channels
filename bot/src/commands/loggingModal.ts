import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ModalSubmitFields,
} from 'discord.js';
import type { ProblemAlertMode } from '../features/voice/guildSettings.js';

/** Custom id of the `/logging` modal. */
export const LOGGING_MODAL_ID = 'avc:logging:submit';

/** The current logging config, for pre-selecting the modal. */
export interface LoggingState {
  enabled: boolean;
  level: 1 | 2 | 3;
  channelId: string | null;
  alerts: ProblemAlertMode;
}

/** What the `/logging` modal collected. */
export interface ParsedLogging {
  /** True when the user chose "Off". */
  disable: boolean;
  level: 1 | 2 | 3;
  /** Chosen log channel; absent → caller defaults to the current channel. */
  channelId?: string;
  /**
   * How the guild wants to hear about problems only an admin can fix.
   *
   * Read on BOTH branches, including "Off". Event logging and problem alerts
   * are separate settings that happen to share a form, and an admin turning
   * the event stream off has said nothing about whether they still want to be
   * told the bot has stopped working.
   */
  alerts: ProblemAlertMode;
}

/**
 * Builds the `/logging` modal: a detail-level select (including an "Off" option
 * to disable) plus an optional text-channel picker for where logs go. The
 * caller's current settings are pre-selected.
 */
export function buildLoggingModal(current: LoggingState): ModalBuilder {
  const lvl = String(current.level);
  const isLevel = (n: string): boolean => current.enabled && lvl === n;
  return new ModalBuilder()
    .setCustomId(LOGGING_MODAL_ID)
    .setTitle('Event logging')
    .addLabelComponents(
      new LabelBuilder().setLabel('Detail level').setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('level')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel('Off')
              .setDescription('Do not post any events')
              .setValue('off')
              .setDefault(!current.enabled),
            new StringSelectMenuOptionBuilder()
              .setLabel('Channels created & deleted')
              .setDescription('When a voice channel is spawned or removed')
              .setValue('1')
              .setDefault(isLevel('1')),
            new StringSelectMenuOptionBuilder()
              .setLabel('+ Renames & ownership changes')
              .setDescription('Also channel name changes and ownership handovers')
              .setValue('2')
              .setDefault(isLevel('2')),
            new StringSelectMenuOptionBuilder()
              .setLabel('+ Members joining & leaving')
              .setDescription('Also every join and leave in managed channels')
              .setValue('3')
              .setDefault(isLevel('3')),
          ),
      ),
      new LabelBuilder()
        .setLabel('Log channel (defaults to this channel)')
        .setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder()
            .setCustomId('channel')
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(1),
        ),
      // Separate from the detail level above: that is the event stream, this
      // fires only when AVC has already stopped working and needs an admin.
      new LabelBuilder()
        .setLabel('If AVC hits a problem it cannot fix')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('alerts')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel('Tell the server, mentioning whoever set AVC up')
                .setDescription('Only if they are still here, and nobody else is pinged')
                .setValue('contact')
                .setDefault(current.alerts === 'contact'),
              new StringSelectMenuOptionBuilder()
                .setLabel('Tell the server, mentioning nobody')
                .setDescription('Same message, no ping')
                .setValue('quiet')
                .setDefault(current.alerts === 'quiet'),
              new StringSelectMenuOptionBuilder()
                .setLabel('Say nothing')
                .setDescription('Problems show up in /setup only')
                .setValue('off')
                .setDefault(current.alerts === 'off'),
            ),
        ),
    );
}

/** Reads the submitted `/logging` modal. */
export function parseLoggingModal(fields: ModalSubmitFields): ParsedLogging {
  const level = fields.getStringSelectValues('level')[0] ?? '1';
  const raw = fields.getStringSelectValues('alerts')[0];
  const alerts: ProblemAlertMode = raw === 'off' || raw === 'quiet' ? raw : 'contact';
  // The early return still carries `alerts`, deliberately: a future field
  // added above without also being added here would silently reset problem
  // alerts for anyone turning event logging off.
  if (level === 'off') return { disable: true, level: 1, alerts };
  const channelId = fields.getSelectedChannels('channel', false)?.first()?.id;
  return {
    disable: false,
    level: (Number(level) as 1 | 2 | 3) || 1,
    alerts,
    ...(channelId ? { channelId } : {}),
  };
}
