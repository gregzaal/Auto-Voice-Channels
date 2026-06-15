import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom-id prefix of the `/position` modal; the channel id is appended. */
export const POSITION_MODAL_PREFIX = 'avc:position:';

/**
 * Builds the `/position` modal — a single string select choosing whether new
 * channels appear above or below the creator channel. The channel being edited
 * is encoded in the custom id; the caller's current setting is pre-selected.
 */
export function buildPositionModal(channelId: string, currentAbove: boolean): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${POSITION_MODAL_PREFIX}${channelId}`)
    .setTitle('Channel position')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Where new channels appear')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('position')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel('Below primary')
                .setValue('below')
                .setDefault(!currentAbove),
              new StringSelectMenuOptionBuilder()
                .setLabel('Above primary')
                .setValue('above')
                .setDefault(currentAbove),
            ),
        ),
    );
}

/** Reads the chosen position from a submitted `/position` modal (`true` = above). */
export function parsePositionModal(fields: ModalSubmitFields): boolean {
  return fields.getStringSelectValues('position')[0] === 'above';
}

/** Extracts the target channel id from a `/position` modal custom id. */
export function positionChannelId(customId: string): string | undefined {
  return customId.startsWith(POSITION_MODAL_PREFIX)
    ? customId.slice(POSITION_MODAL_PREFIX.length)
    : undefined;
}
