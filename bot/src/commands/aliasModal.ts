import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom id for the `/alias` modal. */
export const ALIAS_MODAL_ID = 'avc:alias';

/**
 * The `/alias` modal: map a game's exact name to a shorter alias shown in
 * channel names. The game field is prefilled with the caller's current game
 * (if they're playing one) so aliasing "the game I'm in" is one tap.
 */
export function buildAliasModal(prefillGame?: string): ModalBuilder {
  const game = new TextInputBuilder()
    .setCustomId('game')
    .setLabel('Game name (exact)')
    .setPlaceholder('Counter-Strike 2')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  if (prefillGame) game.setValue(prefillGame.slice(0, 100));
  const alias = new TextInputBuilder()
    .setCustomId('alias')
    .setLabel('Alias to show instead')
    .setPlaceholder('CS2')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  return new ModalBuilder()
    .setCustomId(ALIAS_MODAL_ID)
    .setTitle('Add a game alias')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(game),
      new ActionRowBuilder<TextInputBuilder>().addComponents(alias),
    );
}

export function parseAliasModal(fields: ModalSubmitFields): { game: string; alias: string } {
  return { game: fields.getTextInputValue('game'), alias: fields.getTextInputValue('alias') };
}
