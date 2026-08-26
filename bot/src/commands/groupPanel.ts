import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbed,
  type InteractionReplyOptions,
} from 'discord.js';

/** Custom-id namespace for the `/group` confirm / turn-off buttons. */
export const GROUP_PREFIX = 'avc:group:';

export type GroupAction = 'below' | 'above' | 'off' | 'cancel';

export const groupId = (action: GroupAction, categoryKey: string): string =>
  `${GROUP_PREFIX}${action}:${categoryKey}`;

/** Parses `avc:group:<below|above|off|cancel>:<categoryKey>`. */
export function parseGroupId(
  customId: string,
): { action: GroupAction; categoryKey: string } | null {
  if (!customId.startsWith(GROUP_PREFIX)) return null;
  const [, , action, categoryKey] = customId.split(':');
  if (
    (action !== 'below' && action !== 'above' && action !== 'off' && action !== 'cancel') ||
    !categoryKey
  ) {
    return null;
  }
  return { action, categoryKey };
}

/** A human label for a category in panel copy ("the **Gaming** category" / "the server root"). */
export function categoryLabel(categoryName: string | null): string {
  return categoryName ? `the **${categoryName}** category` : 'the server root';
}

/**
 * The explainer shown when `/group` runs on an **un-grouped** category, with
 * "Group below" / "Group above" / "Cancel" buttons. `count` is how many creator
 * channels would be grouped.
 */
export function buildGroupEnablePanel(
  categoryKey: string,
  categoryName: string | null,
  count: number,
): InteractionReplyOptions {
  const where = categoryLabel(categoryName);
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle("🧩 Group this category's channels?")
    .setColor(0x5865f2)
    .setDescription(
      `Right now, new voice channels in ${where} sit next to their own creator channel ` +
        'and are numbered separately, so with several creator channels they get tangled up ' +
        'between them.\n\n' +
        '**Grouping** puts every channel here into **one block**, either below or above ' +
        '**all** the creator channels, and numbers them **together** (a new channel always ' +
        'lands at the bottom of the list).\n\n' +
        `This affects **${count}** creator channel${count === 1 ? '' : 's'} here. You can change ` +
        'the direction later with `/position`, or turn grouping off by running `/group` again.',
    )
    .toJSON();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(groupId('below', categoryKey))
      .setLabel('Group below')
      .setEmoji('⬇️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(groupId('above', categoryKey))
      .setLabel('Group above')
      .setEmoji('⬆️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(groupId('cancel', categoryKey))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}

/**
 * Shown when `/group` runs on an **already-grouped** category: current state plus
 * a "Turn off grouping" button. (Direction changes go through `/position`.)
 */
export function buildGroupDisablePanel(
  categoryKey: string,
  categoryName: string | null,
  above: boolean,
): InteractionReplyOptions {
  const where = categoryLabel(categoryName);
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('🧩 Grouping is on for this category')
    .setColor(0x5865f2)
    .setDescription(
      `Channels in ${where} are grouped into one block **${above ? 'above' : 'below'}** the ` +
        'creator channels, numbered together.\n\n' +
        'Use `/position` to switch the direction, or turn grouping off below. Each creator ' +
        'channel then goes back to its own numbering and placement.',
    )
    .toJSON();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(groupId('off', categoryKey))
      .setLabel('Turn off grouping')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(groupId('cancel', categoryKey))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}
