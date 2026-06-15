import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom id of the `/logging` modal. */
export const LOGGING_MODAL_ID = 'avc:logging:submit';

/** The current logging config, for pre-selecting the modal. */
export interface LoggingState {
  enabled: boolean;
  level: 1 | 2 | 3;
  channelId: string | null;
}

/** What the `/logging` modal collected. */
export interface ParsedLogging {
  /** True when the user chose "Off". */
  disable: boolean;
  level: 1 | 2 | 3;
  /** Chosen log channel; absent → caller defaults to the current channel. */
  channelId?: string;
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
              .setDescription('Don’t post any events')
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
    );
}

/** Reads the submitted `/logging` modal. */
export function parseLoggingModal(fields: ModalSubmitFields): ParsedLogging {
  const level = fields.getStringSelectValues('level')[0] ?? '1';
  if (level === 'off') return { disable: true, level: 1 };
  const channelId = fields.getSelectedChannels('channel', false)?.first()?.id;
  return {
    disable: false,
    level: (Number(level) as 1 | 2 | 3) || 1,
    ...(channelId ? { channelId } : {}),
  };
}
