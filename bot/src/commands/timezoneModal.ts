import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom id for the `/setup` time zone modal. */
export const TIMEZONE_MODAL_ID = 'avc:setup:timezone:set';

/** Field id inside the modal. */
const FIELD = 'zone';

/**
 * Longest zone name in the IANA database is 30 characters
 * (`America/Argentina/ComodRivadavia`), so 64 is room to spare without letting
 * an accidental paste through.
 */
const ZONE_INPUT_MAX = 64;

/**
 * The modal behind the `/setup` time zone control.
 *
 * A typed zone name rather than a select, and the reason is arithmetic: there
 * are ~350 zones with anything like a distinct offset history and a Discord
 * select holds 25 options. A shortlist would be right for the servers it
 * happened to cover and silently wrong for everyone else, which is the exact
 * failure mode the whole setting exists to remove.
 *
 * Not required, because clearing it is a real choice: an empty submit removes
 * the setting and the date tokens go back to UTC.
 */
export function buildTimeZoneModal(current?: string | undefined): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(FIELD)
    .setLabel('Time zone')
    .setPlaceholder('Europe/Amsterdam')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(ZONE_INPUT_MAX);
  if (current) input.setValue(current.slice(0, ZONE_INPUT_MAX));
  return new ModalBuilder()
    .setCustomId(TIMEZONE_MODAL_ID)
    .setTitle('Set the server time zone')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/** The submitted zone, untrimmed: the service owns what counts as valid. */
export function parseTimeZoneModal(fields: ModalSubmitFields): string {
  return fields.getTextInputValue(FIELD);
}
