import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type APIEmbedField,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  CONTROL_PANEL_COLOR_KEY,
  CONTROL_PANEL_CONTROLS,
  CONTROL_PANEL_CREATOR_TOKEN,
  CONTROL_PANEL_DESCRIPTION_KEY,
  CONTROL_PANEL_DESCRIPTION_MAX,
  CONTROL_PANEL_OWNER_TOKEN,
  CONTROL_PANEL_TITLE_KEY,
  CONTROL_PANEL_TITLE_MAX,
  formatPanelColor,
  isControlPanelAppearanceKey,
  isControlPanelControl,
  type ControlPanelAppearanceKey,
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

/** Builds `avc:cp:a:<key>`, shared by an appearance button and its modal. */
export const controlAppearanceId = (key: ControlPanelAppearanceKey): string =>
  `${CONTROL_SETTINGS_PREFIX}a:${key}`;

/**
 * Parses an appearance id back into a key, or null.
 *
 * Validated against the known list for the same reason the toggle id is: it
 * comes back from a message we posted and it still names a settings key.
 */
export function parseControlAppearanceId(customId: string): ControlPanelAppearanceKey | null {
  const prefix = `${CONTROL_SETTINGS_PREFIX}a:`;
  if (!customId.startsWith(prefix)) return null;
  const key = customId.slice(prefix.length);
  return isControlPanelAppearanceKey(key) ? key : null;
}

/** The text input id inside all three appearance modals. */
export const CONTROL_APPEARANCE_INPUT_ID = 'value';

/** Label, button text and modal title for one appearance entry. */
const APPEARANCE_FACES: Record<
  ControlPanelAppearanceKey,
  { label: string; emoji: string; modalTitle: string }
> = {
  [CONTROL_PANEL_TITLE_KEY]: { label: 'Title', emoji: '✏️', modalTitle: 'Panel title' },
  [CONTROL_PANEL_DESCRIPTION_KEY]: {
    label: 'Description',
    emoji: '📝',
    modalTitle: 'Panel description',
  },
  [CONTROL_PANEL_COLOR_KEY]: { label: 'Colour', emoji: '🎨', modalTitle: 'Panel colour' },
};

/**
 * The modal behind one appearance button.
 *
 * Prefilled with what is set right now, so an admin editing a word does not
 * retype the sentence, and blank-submits back to the default, which is the same
 * contract the room panel's own Name modal uses. Not required, for that reason:
 * Discord refuses to submit a required field left blank, which would make the
 * placeholder a lie.
 */
export function buildAppearanceModal(
  key: ControlPanelAppearanceKey,
  config: ControlPanelConfig,
): ModalBuilder {
  const face = APPEARANCE_FACES[key];
  const isDescription = key === CONTROL_PANEL_DESCRIPTION_KEY;
  const current =
    key === CONTROL_PANEL_COLOR_KEY
      ? formatPanelColor(config.color)
      : isDescription
        ? config.description
        : config.title;
  const input = new TextInputBuilder()
    .setCustomId(CONTROL_APPEARANCE_INPUT_ID)
    .setLabel(face.modalTitle)
    .setStyle(isDescription ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(false)
    .setValue(current)
    /**
     * Only the DESCRIPTION advertises the two variables. Discord renders an
     * embed title as plain text, so a mention in one prints as raw markup.
     */
    .setPlaceholder(
      key === CONTROL_PANEL_COLOR_KEY
        ? 'A hex code like #c43bff. Blank for the default'
        : isDescription
          ? `Blank for the default. ${CONTROL_PANEL_OWNER_TOKEN} and ${CONTROL_PANEL_CREATOR_TOKEN} work here`
          : 'Blank for the default. Plain text only, no variables',
    );
  if (key === CONTROL_PANEL_COLOR_KEY) input.setMaxLength(7);
  else if (isDescription) input.setMaxLength(CONTROL_PANEL_DESCRIPTION_MAX);
  else input.setMaxLength(CONTROL_PANEL_TITLE_MAX);
  return new ModalBuilder()
    .setCustomId(controlAppearanceId(key))
    .setTitle(face.modalTitle)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/**
 * What the feature IS, said to somebody who has not met it yet.
 *
 * One sentence about the thing, not three about the mechanics of this screen.
 * The older copy narrated its own state ("rooms are not getting a control
 * panel", "panels already posted are updated too") in a panel whose state is
 * visible in the title and in seven ticks and crosses below it, which is the
 * self-referential copy AGENTS.md rules out.
 */
const WHAT_IT_IS =
  'The control panel is a message posted in every room this server makes, so members can see, and ' +
  'easily reach, the things they can do with their own room. Each button can be switched off.';

/**
 * What this server's rooms actually get, in three states rather than two.
 *
 * Switching every button off leaves the panel "on" but produces no message at
 * all, because a panel with no buttons is an embed nobody can act on. Read as
 * two states, that server would see "enabled" in the title while nothing was
 * being posted anywhere, so that one state still says so.
 */
function describeControlState(config: ControlPanelConfig, offCount: number): string {
  if (config.enabled && offCount === CONTROL_PANEL_CONTROLS.length) {
    return (
      WHAT_IT_IS + '\n\nEvery button is switched off right now, so nothing is being posted at all.'
    );
  }
  return WHAT_IT_IS;
}

/** The title carries the state, which is the first thing an admin looks for. */
const controlStateTitle = (enabled: boolean): string =>
  enabled ? 'Control panels are enabled ✅' : 'Control panels are disabled ❌';

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

  /**
   * What the panel looks like, as one field rather than three.
   *
   * The values are shown raw, tokens and all, because that is what the modal
   * will hand back and what an admin has to edit. The description is truncated
   * here and nowhere else: a 4000-character one would push this embed past
   * Discord's 6000-character total and take the whole configuration surface
   * down over a setting.
   */
  fields.push({
    name: '🎨 Appearance',
    value:
      `Title: ${config.title}\n` +
      `Description: ${config.description.replaceAll('\n', ' ').slice(0, 300)}\n` +
      `Colour: \`${formatPanelColor(config.color)}\``,
    inline: false,
  });

  const embed = new EmbedBuilder()
    .setTitle(controlStateTitle(config.enabled))
    // The colour this server's rooms actually get, so changing it shows here
    // immediately. Every other panel in the bot stays Discord blurple.
    .setColor(config.color)
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
    // Three more, in their own row: they change what the panel says rather than
    // what it carries, so mixing them in with the toggles would read as three
    // more buttons to switch off. Discord's ceiling is FIVE action rows; this
    // is the fourth, and the whole-panel row below is the fifth.
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        (Object.keys(APPEARANCE_FACES) as ControlPanelAppearanceKey[]).map((key) =>
          new ButtonBuilder()
            .setCustomId(controlAppearanceId(key))
            .setLabel(APPEARANCE_FACES[key].label)
            .setEmoji(APPEARANCE_FACES[key].emoji)
            .setStyle(ButtonStyle.Secondary),
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
            .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(controlSettingsId('close'))
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [json], components: rows, ephemeral: true };
}
