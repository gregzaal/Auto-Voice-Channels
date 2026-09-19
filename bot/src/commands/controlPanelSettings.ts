import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type APIEmbed,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  CONTROL_PANEL_CONTROLS,
  isControlPanelControl,
  type ControlPanelConfig,
  type ControlPanelControl,
} from '../features/voice/guildSettings.js';
import { CONTROL_PANEL_LABELS } from '../features/voice/controlPanel.js';

/**
 * `/controlpanel`: the admin surface for what the room control panel carries.
 *
 * Enable and disable only. No reordering and no custom labels, deliberately:
 * both are editing problems that a web dashboard solves far better than a
 * Discord select can, and shipping a half of either here would be a surface to
 * maintain forever in exchange for very little.
 *
 * Follows `/setup`'s rendering rules (`rewrite.md` decision 11): at most one
 * Success button, never a Primary, a Danger or a disabled one. The Success
 * button is whatever this state's answer is, which here means it exists only
 * when the panel is switched off and turning it back on is the thing to do.
 */

/** Custom-id namespace for the `/controlpanel` configuration panel. */
export const CONTROL_SETTINGS_PREFIX = 'avc:cp:';

/** Custom id of the panel's button picker (a message-level string select). */
export const CONTROL_SETTINGS_SELECT_ID = `${CONTROL_SETTINGS_PREFIX}pick`;

/** The panel's own actions, which the select's values are not. */
export type ControlSettingsAction = 'on' | 'off' | 'close';

const ACTIONS: readonly string[] = ['on', 'off', 'close'];

/** Builds `avc:cp:<action>`. */
export const controlSettingsId = (action: ControlSettingsAction): string =>
  `${CONTROL_SETTINGS_PREFIX}${action}`;

/** Parses `avc:cp:<action>`, or null when it is not one of ours. */
export function parseControlSettingsId(customId: string): ControlSettingsAction | null {
  if (!customId.startsWith(CONTROL_SETTINGS_PREFIX)) return null;
  const action = customId.slice(CONTROL_SETTINGS_PREFIX.length);
  return ACTIONS.includes(action) ? (action as ControlSettingsAction) : null;
}

/**
 * Reads a select value back into a control id.
 *
 * Validated against the known list rather than trusted, because a select's
 * values are chosen client side: hiding an option enforces nothing, and this
 * value goes straight into a settings key.
 */
export function parseControlSelection(value: string): ControlPanelControl | null {
  return isControlPanelControl(value) ? value : null;
}

/**
 * What each control does, for the picker's descriptions.
 *
 * Its own wording, in its own register: these are sentences an admin reads
 * about a control, where the panel's own lines continue from a bold label. The
 * LABELS are imported rather than repeated, because an admin switching "Kick"
 * off has to be looking at the word on the member's button.
 */
const CONTROL_BLURBS: Record<ControlPanelControl, string> = {
  lock: 'Close the room, others can ask to join',
  unlock: 'Open the room to everyone again',
  limit: 'Set how many people fit in the room',
  rename: 'Give the room a different name',
  claim: 'Take your room back, or one with nobody in charge',
  transfer: 'Hand the room to someone else in it',
  kick: 'Start a vote to remove someone',
  info: 'Show how the room is named and configured',
};

/** How the rooms that exist right now are unaffected, said the same way everywhere. */
const EXISTING_ROOMS = 'Rooms that already exist keep the panel they were given.';

/**
 * What this server's rooms actually get, in three states rather than two.
 *
 * Switching every button off leaves `enabled` true but produces no message at
 * all, because a panel with no buttons is an embed nobody can act on. Read as
 * two states, that server was told "every new room gets these buttons posted in
 * its chat" while nothing was being posted anywhere.
 */
function describeControlState(
  config: ControlPanelConfig,
  off: readonly ControlPanelControl[],
): string {
  if (!config.enabled) {
    return (
      'New rooms are not getting a control panel. ' +
      EXISTING_ROOMS +
      ' Every button has a command that still works, so nothing is lost except the shortcut.'
    );
  }
  if (off.length === CONTROL_PANEL_CONTROLS.length) {
    return (
      'Every button is switched off, so new rooms are getting no control panel at all. ' +
      'Switch one back on below, or leave it: every button has a command that still works. ' +
      EXISTING_ROOMS
    );
  }
  return (
    'Every new room gets these buttons posted in its chat, so members never have to learn a ' +
    'command name. Pick a button below to switch it on or off.\n\n' +
    // Counted rather than written out, so adding a ninth control does not
    // leave this panel quietly claiming there are eight.
    (off.length === 0
      ? `All ${CONTROL_PANEL_CONTROLS.length} buttons are on.`
      : `Switched off: ${off.map((c) => CONTROL_PANEL_LABELS[c].label).join(', ')}.`) +
    '\n\n' +
    EXISTING_ROOMS
  );
}

/**
 * The configuration panel.
 *
 * The select is the whole interface: choosing a button toggles it, so there is
 * no save step and nothing to lose by closing the panel. Each option's
 * description says what the control does and its label says whether it is on,
 * because a select cannot show a checkbox and an admin should not have to
 * cross-reference the embed above it.
 */
export function buildControlSettingsPanel(
  config: ControlPanelConfig,
  opts: { note?: string } = {},
): InteractionReplyOptions {
  const off = CONTROL_PANEL_CONTROLS.filter((c) => !config.controls[c]);
  const embed = new EmbedBuilder()
    .setTitle('🎛️ Room control panel')
    .setColor(0x5865f2)
    .setDescription(describeControlState(config, off));
  const json: APIEmbed = embed.toJSON();
  if (opts.note) json.fields = [{ name: '​', value: opts.note.slice(0, 1024) }];

  const rows: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [];
  if (config.enabled) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(CONTROL_SETTINGS_SELECT_ID)
          .setPlaceholder('Switch a button on or off')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            CONTROL_PANEL_CONTROLS.map((c) =>
              new StringSelectMenuOptionBuilder()
                .setValue(c)
                .setLabel(
                  `${CONTROL_PANEL_LABELS[c].label}${config.controls[c] ? '' : ' (off)'}`.slice(
                    0,
                    100,
                  ),
                )
                .setDescription(CONTROL_BLURBS[c].slice(0, 100))
                .setEmoji(CONTROL_PANEL_LABELS[c].emoji),
            ),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      config.enabled
        ? new ButtonBuilder()
            .setCustomId(controlSettingsId('off'))
            .setLabel('Turn the panel off')
            .setStyle(ButtonStyle.Secondary)
        : new ButtonBuilder()
            .setCustomId(controlSettingsId('on'))
            .setLabel('Turn the panel on')
            .setEmoji('🎛️')
            .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(controlSettingsId('close'))
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [json], components: rows, ephemeral: true };
}
