import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type ButtonInteraction,
  type InteractionReplyOptions,
} from 'discord.js';
import type { GuildConfig } from '../features/voice/index.js';

/** Custom-id namespace for all `/settings` panel components. */
export const SETTINGS_PREFIX = 'avc:settings:';
export const settingsId = (action: string): string => `${SETTINGS_PREFIX}${action}`;

const MODALS = {
  general: settingsId('modal:general'),
  template: settingsId('modal:template'),
  alias: settingsId('modal:alias'),
} as const;

/** Renders the configuration panel embed for the current guild config. */
export function renderSettingsPanel(config: GuildConfig): InteractionReplyOptions {
  const aliasLines = Object.entries(config.aliases)
    .slice(0, 10)
    .map(([game, alias]) => `• ${game} → **${alias}**`)
    .join('\n');
  const primaryLines = config.primaries
    .slice(0, 10)
    .map((p) => `• <#${p.channelId}> — \`${p.template}\`${p.limit ? ` (limit ${p.limit})` : ''}`)
    .join('\n');

  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('Auto-Voice-Channels — Server Settings')
    .setColor(config.enabled ? 0x4caf50 : 0x9e9e9e)
    .addFields(
      { name: 'Automation', value: config.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
      { name: '“No game” label', value: config.general, inline: true },
      { name: 'Default name template', value: `\`${config.defaultTemplate}\`` },
      {
        name: `Creator channels (${config.primaries.length})`,
        value: primaryLines || '_None yet — use “Create creator channel”._',
      },
      {
        name: `Aliases (${Object.keys(config.aliases).length})`,
        value: aliasLines || '_None._',
      },
    )
    .toJSON();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(settingsId('toggle'))
      .setLabel(config.enabled ? 'Disable' : 'Enable')
      .setStyle(config.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(settingsId('open:general'))
      .setLabel('Set “no game” label')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(settingsId('open:template'))
      .setLabel('Set default template')
      .setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(settingsId('create'))
      .setLabel('Create creator channel')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(settingsId('open:alias'))
      .setLabel('Add alias')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

/** The modal opened by a given panel button, or null if the button isn't a modal opener. */
export function modalForButton(interaction: ButtonInteraction): ModalBuilder | null {
  const id = interaction.customId;
  if (id === settingsId('open:general')) {
    return textModal(
      MODALS.general,
      'Set “no game” label',
      'label',
      'General',
      TextInputStyle.Short,
    );
  }
  if (id === settingsId('open:template')) {
    return textModal(
      MODALS.template,
      'Default name template',
      'template',
      '## [@@game_name@@]',
      TextInputStyle.Short,
    );
  }
  if (id === settingsId('open:alias')) {
    const modal = new ModalBuilder().setCustomId(MODALS.alias).setTitle('Add a game alias');
    modal.addComponents(
      rowInput('game', 'Game name (exact)', 'Counter-Strike 2', TextInputStyle.Short),
      rowInput('alias', 'Alias to show', 'CS2', TextInputStyle.Short),
    );
    return modal;
  }
  return null;
}

export const SETTINGS_MODAL_IDS = MODALS;

function textModal(
  customId: string,
  title: string,
  fieldId: string,
  placeholder: string,
  style: TextInputStyle,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(rowInput(fieldId, title, placeholder, style));
}

function rowInput(
  id: string,
  label: string,
  placeholder: string,
  style: TextInputStyle,
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label.slice(0, 45))
      .setPlaceholder(placeholder)
      .setStyle(style)
      .setRequired(true),
  );
}
