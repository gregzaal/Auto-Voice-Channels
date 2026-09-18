import {
  LabelBuilder,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom id for the `/setup` companion text channel settings modal. */
export const TEXT_CHANNELS_MODAL_ID = 'avc:setup:textchannels:set';

const NAME_FIELD = 'name';
const ROLE_FIELD = 'role';

/** Discord's own channel-name limit. */
const NAME_INPUT_MAX = 100;

export interface TextChannelSettings {
  /** The stored name, or undefined for the default. */
  name?: string | undefined;
  /** The stored moderator role id, or null for none. */
  roleId: string | null;
}

/**
 * The modal behind the `/setup` "Room text channels" control: what new companion
 * channels are called, and the one role allowed to read all of them.
 *
 * Both settings in one modal rather than two options, because they are the same
 * decision seen twice and an admin who sets one almost always wants to see the
 * other. Neither is required: an empty name clears back to the default, and an
 * empty role select clears the moderator role.
 *
 * A role SELECT rather than a pasted id. The legacy command took a role by name,
 * and asking an admin to find a snowflake for a permission this sensitive is how
 * the wrong role gets granted.
 */
export function buildTextChannelsModal(current: TextChannelSettings): ModalBuilder {
  const name = new TextInputBuilder()
    .setCustomId(NAME_FIELD)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(NAME_INPUT_MAX)
    .setPlaceholder('voice context');
  if (current.name) name.setValue(current.name.slice(0, NAME_INPUT_MAX));

  const role = new RoleSelectMenuBuilder()
    .setCustomId(ROLE_FIELD)
    // Optional: a modal select needs required=false to allow min_values 0.
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .setPlaceholder('Nobody (only people in the room)');
  if (current.roleId) role.setDefaultRoles(current.roleId);

  return new ModalBuilder()
    .setCustomId(TEXT_CHANNELS_MODAL_ID)
    .setTitle('Room text channels')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Channel name (Discord lowercases it)')
        .setTextInputComponent(name),
      new LabelBuilder()
        .setLabel('Role that can read every room chat')
        .setRoleSelectMenuComponent(role),
    );
}

export interface ParsedTextChannelSettings {
  /** Untrimmed: the service owns what counts as valid, and empty means clear. */
  name: string;
  /** The chosen role, or null when the select was left empty. */
  roleId: string | null;
}

export function parseTextChannelsModal(fields: ModalSubmitFields): ParsedTextChannelSettings {
  return {
    name: fields.getTextInputValue(NAME_FIELD),
    roleId: fields.getSelectedRoles(ROLE_FIELD, false)?.first()?.id ?? null,
  };
}
