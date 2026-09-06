import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom-id prefix of the `/position` modal; the channel id is appended. */
export const POSITION_MODAL_PREFIX = 'avc:position:';

/** The largest first-room number `/position` accepts. Mirrors `IMPORT_LIMITS.startAt`. */
export const MAX_START_AT = 9999;

/** What a submitted `/position` modal says. */
export interface PositionChoice {
  /** `true` = new rooms appear above the creator channel. */
  above: boolean;
  /**
   * The number the first room counts from, or `undefined` to leave it at the
   * default of 1. Unparseable input reads as `undefined` rather than refusing:
   * the field is optional and a modal cannot show a validation error.
   */
  startAt: number | undefined;
}

/**
 * Builds the `/position` modal: where new rooms appear, and what number they
 * count from.
 *
 * Numbering lives here rather than on `/create` because `/create` is already at
 * Discord's five-row modal cap, and because this is the command that already
 * owns how a primary's block is laid out. Both settings describe the same
 * thing: how the rooms under one creator channel are arranged and labelled.
 */
export function buildPositionModal(
  channelId: string,
  currentAbove: boolean,
  currentStartAt?: number,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${POSITION_MODAL_PREFIX}${channelId}`)
    .setTitle('Channel position')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Where new rooms appear')
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId('position')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
              new StringSelectMenuOptionBuilder()
                .setLabel('Below the creator channel')
                .setValue('below')
                .setDefault(!currentAbove),
              new StringSelectMenuOptionBuilder()
                .setLabel('Above the creator channel')
                .setValue('above')
                .setDefault(currentAbove),
            ),
        ),
      new LabelBuilder()
        .setLabel('Start numbering at')
        .setDescription('Leave blank for 1. Applies to ##, $#, +# and @@nato@@.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('startAt')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(4)
            .setPlaceholder('1')
            .setValue(currentStartAt === undefined ? '' : String(currentStartAt)),
        ),
    );
}

/** Reads the chosen position and numbering from a submitted `/position` modal. */
export function parsePositionModal(fields: ModalSubmitFields): PositionChoice {
  const above = fields.getStringSelectValues('position')[0] === 'above';
  const raw = (fields.getTextInputValue('startAt') ?? '').trim();
  if (raw === '') return { above, startAt: undefined };
  const parsed = Number(raw);
  // A blank field and a nonsense one both mean "the default", so neither can
  // pin a guild to a number nobody typed.
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_START_AT) {
    return { above, startAt: undefined };
  }
  // 1 is the default, so store nothing rather than a redundant field.
  return { above, startAt: parsed === 1 ? undefined : parsed };
}

/** Extracts the target channel id from a `/position` modal custom id. */
export function positionChannelId(customId: string): string | undefined {
  return customId.startsWith(POSITION_MODAL_PREFIX)
    ? customId.slice(POSITION_MODAL_PREFIX.length)
    : undefined;
}
