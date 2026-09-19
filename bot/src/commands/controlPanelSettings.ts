import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
  type APIEmbedField,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  CONTROL_PANEL_CONTROLS,
  isControlPanelControl,
  type ControlPanelConfig,
  type ControlPanelControl,
} from '../features/voice/guildSettings.js';
import { settingsFaceOf } from '../features/voice/controlPanel.js';

/**
 * `/controlpanel`: the admin surface for what the room control panel carries.
 *
 * Enable and disable only. No reordering and no custom labels, deliberately:
 * both are editing problems that a web dashboard solves far better than a
 * Discord select can, and shipping a half of either here would be a surface to
 * maintain forever in exchange for very little.
 *
 * Laid out like the panel it configures - a field per control, carrying the
 * same emoji, label and description a member reads on the room's own panel - so
 * an admin switching something off is looking at the thing they are taking
 * away. `✅` and `❌` in the field name carry the state, which a Discord embed
 * has no checkbox for.
 *
 * Follows `/setup`'s rendering rules (`rewrite.md` decision 11): at most one
 * Success button, never a Primary, a Danger or a disabled one. The Success
 * button is whatever this state's answer is, which here means it exists only
 * when the whole panel is switched off and turning it back on is the thing to
 * do. The per-control toggles are all Secondary, because none of them is more
 * the thing to press than the others.
 */

/** Custom-id namespace for the `/controlpanel` configuration panel. */
export const CONTROL_SETTINGS_PREFIX = 'avc:cp:';

/** The panel's own whole-panel actions, as opposed to the per-control toggles. */
export type ControlSettingsAction = 'on' | 'off' | 'close';

const ACTIONS: readonly string[] = ['on', 'off', 'close'];

/** Builds `avc:cp:<action>`, or `avc:cp:t:<control>` for a toggle. */
export const controlSettingsId = (action: ControlSettingsAction): string =>
  `${CONTROL_SETTINGS_PREFIX}${action}`;

/** Builds the custom id of one control's toggle button. */
export const controlToggleId = (control: ControlPanelControl): string =>
  `${CONTROL_SETTINGS_PREFIX}t:${control}`;

/** Parses `avc:cp:<action>`, or null when it is not one of ours (or is a toggle). */
export function parseControlSettingsId(customId: string): ControlSettingsAction | null {
  if (!customId.startsWith(CONTROL_SETTINGS_PREFIX)) return null;
  const action = customId.slice(CONTROL_SETTINGS_PREFIX.length);
  return ACTIONS.includes(action) ? (action as ControlSettingsAction) : null;
}

/**
 * Parses a toggle button's custom id back into a control.
 *
 * Validated against the known list rather than trusted. A custom id comes back
 * from a message we posted, but it is still client input on the wire and it
 * goes straight into a settings key, so it is checked the same way a select
 * value would be.
 */
export function parseControlToggleId(customId: string): ControlPanelControl | null {
  const prefix = `${CONTROL_SETTINGS_PREFIX}t:`;
  if (!customId.startsWith(prefix)) return null;
  const control = customId.slice(prefix.length);
  return isControlPanelControl(control) ? control : null;
}

/** How the rooms that exist right now are affected, said the same way everywhere. */
const EXISTING_ROOMS = 'Panels already posted are updated too.';

/**
 * What this server's rooms actually get, in three states rather than two.
 *
 * Switching every button off leaves the panel "on" but produces no message at
 * all, because a panel with no buttons is an embed nobody can act on. Read as
 * two states, that server was told "every new room gets these buttons" while
 * nothing was being posted anywhere.
 */
function describeControlState(config: ControlPanelConfig, offCount: number): string {
  if (!config.enabled) {
    return (
      'Rooms are not getting a control panel. ' +
      EXISTING_ROOMS +
      ' Every button has a command that still works, so nothing is lost except the shortcut.'
    );
  }
  if (offCount === CONTROL_PANEL_CONTROLS.length) {
    return (
      'Every button is switched off, so rooms are getting no control panel at all. ' +
      'Switch one back on below, or leave it: every button has a command that still works. ' +
      EXISTING_ROOMS
    );
  }
  return (
    'Rooms get these buttons posted in their chat, so members never have to learn a command ' +
    'name. Press one below to switch it on or off. ' +
    EXISTING_ROOMS
  );
}

/**
 * The configuration panel.
 *
 * Buttons rather than a select, so the whole state is visible at once: seven
 * fields showing what each control does and whether it is on, and seven buttons
 * under them that flip it. A select would hide six of the seven behind a click
 * and could not show state without repeating it in every option label.
 */
export function buildControlSettingsPanel(
  config: ControlPanelConfig,
  opts: { note?: string } = {},
): InteractionReplyOptions {
  const offCount = CONTROL_PANEL_CONTROLS.filter((c) => !config.controls[c]).length;

  const fields: APIEmbedField[] = CONTROL_PANEL_CONTROLS.map((c) => {
    const face = settingsFaceOf(c);
    return {
      name: `${config.controls[c] ? '✅' : '❌'} ${face.emoji} ${face.label}`,
      value: face.blurb,
      inline: true,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle('Control panel')
    .setColor(0x5865f2)
    .setDescription(describeControlState(config, offCount))
    .addFields(fields);
  const json: APIEmbed = embed.toJSON();
  if (opts.note) {
    json.fields = [...(json.fields ?? []), { name: '​', value: opts.note.slice(0, 1024) }];
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (config.enabled) {
    // Five per row is Discord's ceiling, so seven controls land as five and two.
    for (let i = 0; i < CONTROL_PANEL_CONTROLS.length; i += 5) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          CONTROL_PANEL_CONTROLS.slice(i, i + 5).map((c) =>
            new ButtonBuilder()
              .setCustomId(controlToggleId(c))
              .setLabel(settingsFaceOf(c).label)
              .setEmoji(config.controls[c] ? '✅' : '❌')
              .setStyle(ButtonStyle.Secondary),
          ),
        ),
      );
    }
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
            .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(controlSettingsId('close'))
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [json], components: rows, ephemeral: true };
}
