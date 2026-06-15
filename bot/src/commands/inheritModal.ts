import {
  ChannelSelectMenuBuilder,
  ChannelType,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom-id prefix of the `/inheritpermissions` modal; the channel id is appended. */
export const INHERIT_MODAL_PREFIX = 'avc:inherit:';

/**
 * Builds the `/inheritpermissions` modal: a string select for the common modes
 * (the creator channel or its category) plus an optional voice-channel picker to
 * copy from a specific channel instead. The channel being configured is encoded
 * in the custom id.
 */
export function buildInheritModal(channelId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${INHERIT_MODAL_PREFIX}${channelId}`)
    .setTitle('Permission inheritance')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Copy permissions from')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('mode')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel('The creator channel')
                .setValue('primary')
                .setDefault(true),
              new StringSelectMenuOptionBuilder().setLabel('Its category').setValue('category'),
            ),
        ),
      new LabelBuilder()
        .setLabel('…or a specific channel (optional)')
        .setChannelSelectMenuComponent(
          new ChannelSelectMenuBuilder()
            .setCustomId('channel')
            .setChannelTypes(ChannelType.GuildVoice)
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(1)
            .setPlaceholder('Overrides the choice above'),
        ),
    );
}

/** Reads the inherit source: a picked channel id wins, else the mode string. */
export function parseInheritModal(fields: ModalSubmitFields): string {
  const channel = fields.getSelectedChannels('channel', false)?.first()?.id;
  return channel ?? fields.getStringSelectValues('mode')[0] ?? 'primary';
}

/** Extracts the target channel id from an `/inheritpermissions` modal custom id. */
export function inheritChannelId(customId: string): string | undefined {
  return customId.startsWith(INHERIT_MODAL_PREFIX)
    ? customId.slice(INHERIT_MODAL_PREFIX.length)
    : undefined;
}
