import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type InteractionReplyOptions,
  type ModalSubmitFields,
} from 'discord.js';

/** Custom-id namespace for the `/alias` panel. */
export const ALIAS_PREFIX = 'avc:alias:';

/** Custom id of the panel's alias picker (a message-level string select). */
export const ALIAS_SELECT_ID = `${ALIAS_PREFIX}pick`;

/** Discord's cap on options in one select menu, and so the panel's page size. */
export const ALIAS_PAGE_SIZE = 25;

/** Discord's cap on a select option's label and description. */
const OPTION_TEXT_MAX = 100;

/**
 * Discord's cap on a modal text input, and so on what the edit modal can
 * round-trip. An imported legacy game name can be longer, which is why
 * `handleAliasEditSubmit` treats a prefill read back unchanged as no rename.
 */
export const ALIAS_INPUT_MAX = 100;

/**
 * Display budgets for one listed row, and the ceiling for the whole list.
 *
 * A full page is 25 rows, and a game name and an alias are each up to 100
 * characters, so an unclamped list reaches ~5200 and Discord rejects the embed
 * at 4096. Escaping markdown can double a field again, so the per-field budgets
 * keep rows readable and DESCRIPTION_MAX is the guarantee.
 */
const GAME_DISPLAY_MAX = 60;
const ALIAS_DISPLAY_MAX = 40;
const DESCRIPTION_MAX = 3900;

/** The panel's actions. `page` carries a page index, the rest carry an alias hash. */
export type AliasAction = 'add' | 'edit' | 'remove' | 'save' | 'back' | 'page' | 'close';

const ACTIONS: readonly string[] = ['add', 'edit', 'remove', 'save', 'back', 'page', 'close'];

/**
 * Builds `avc:alias:<action>[:<arg>]`.
 *
 * The arg is a hash for the per-alias actions and a page index for `page` --
 * never the game name itself. Game names routinely contain a colon ("The
 * Witcher 3: Wild Hunt"), which the split-on-colon convention every other panel
 * uses would parse as a field separator, and at up to 100 characters one would
 * exhaust the whole custom id on its own.
 */
export const aliasId = (action: AliasAction, arg?: string): string =>
  arg === undefined ? `${ALIAS_PREFIX}${action}` : `${ALIAS_PREFIX}${action}:${arg}`;

/** Parses `avc:alias:<action>[:<arg>]`. */
export function parseAliasId(customId: string): { action: AliasAction; arg: string | null } | null {
  if (!customId.startsWith(ALIAS_PREFIX)) return null;
  const [, , action, arg] = customId.split(':');
  if (!action || !ACTIONS.includes(action)) return null;
  return { action: action as AliasAction, arg: arg ?? null };
}

/**
 * Hex characters of the game-name hash carried in ids and select values.
 *
 * 12 rather than 8, because the custom id has 75 free characters and 8 does not
 * buy anything with them: at the 100-alias cap, 32 bits gives a ~6e-3 chance of
 * a collision somewhere across a 5.5k-guild fleet, where 48 bits gives ~1e-7.
 * A collision is not cosmetic here, since the Remove button would delete the
 * other alias.
 */
const HASH_LENGTH = 12;

/**
 * A short, stable handle for a game name, for use inside a custom id.
 *
 * Resolved by scanning the guild's current map, so a hash that no longer matches
 * anything means the alias was removed while the panel was open. An index into
 * the list would be smaller but wrong: a concurrent write shifts it, and the
 * panel would then edit or delete a different alias than the one on screen.
 */
export function aliasHash(game: string): string {
  return createHash('sha256').update(game).digest('hex').slice(0, HASH_LENGTH);
}

/** Finds the game name in `aliases` whose hash matches, or null if it is gone. */
export function findAliasByHash(
  aliases: Record<string, string>,
  hash: string,
): { game: string; alias: string } | null {
  for (const [game, alias] of Object.entries(aliases)) {
    if (aliasHash(game) === hash) return { game, alias };
  }
  return null;
}

/** Sorted case-insensitively by game name, matching the legacy `aliases` listing. */
export function sortAliases(aliases: Record<string, string>): [string, string][] {
  return Object.entries(aliases).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** How many pages `count` aliases span (always at least one, so page 0 exists). */
export function aliasPageCount(count: number): number {
  return Math.max(1, Math.ceil(count / ALIAS_PAGE_SIZE));
}

/**
 * The panel's main view: every alias this guild has, a picker to open one, and
 * an Add button. Pagination appears only past a single page.
 */
export function buildAliasListPanel(
  aliases: Record<string, string>,
  opts: { page?: number; note?: string } = {},
): InteractionReplyOptions {
  const entries = sortAliases(aliases);
  const pages = aliasPageCount(entries.length);
  // Clamp rather than trust: removing the last alias on the final page would
  // otherwise leave the panel showing an empty page that no button escapes.
  const page = Math.min(Math.max(opts.page ?? 0, 0), pages - 1);
  const shown = entries.slice(page * ALIAS_PAGE_SIZE, (page + 1) * ALIAS_PAGE_SIZE);

  const embed = new EmbedBuilder().setTitle('🏷️ Game aliases').setColor(0x5865f2);
  if (entries.length === 0) {
    embed.setDescription(
      'No aliases yet. Add one to shorten a game name where it appears in channel names, ' +
        'like **Counter-Strike 2** showing as **CS2**.',
    );
  } else {
    const lines: string[] = [];
    let budget = DESCRIPTION_MAX;
    let hidden = 0;
    for (const [game, alias] of shown) {
      const line = `**${clean(game, GAME_DISPLAY_MAX)}** → ${clean(alias, ALIAS_DISPLAY_MAX)}`;
      if (line.length + 1 > budget) {
        hidden += 1;
        continue;
      }
      budget -= line.length + 1;
      lines.push(line);
    }
    // Only reachable with pathological names. The picker below still offers every
    // alias on the page, so saying so beats silently showing a short list.
    if (hidden > 0) lines.push(`_${hidden} more are too long to list. Use the picker below._`);
    embed.setDescription(lines.join('\n'));
    if (pages > 1) {
      embed.setFooter({ text: `Page ${page + 1} of ${pages}, ${entries.length} aliases` });
    }
  }
  const json: APIEmbed = embed.toJSON();
  // Clamped to Discord's embed field limit: the note is a mutation result that
  // quotes a game name and an alias back, both of them user-supplied.
  if (opts.note) json.fields = [{ name: '​', value: truncate(opts.note, 1024) }];

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (shown.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(ALIAS_SELECT_ID)
          .setPlaceholder('Choose an alias to edit or remove')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            shown.map(([game, alias]) =>
              new StringSelectMenuOptionBuilder()
                // The value is the hash, not the game name. Discord caps an
                // option value at 100 characters and throws outright past it,
                // and an imported legacy alias is bounded by nothing: the add
                // modal's 100-char input cap only governs names typed here.
                .setValue(aliasHash(game))
                .setLabel(truncate(game, OPTION_TEXT_MAX))
                .setDescription(truncate(`Shows as: ${alias}`, OPTION_TEXT_MAX)),
            ),
          ),
      ),
    );
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(aliasId('add'))
      .setLabel('Add')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary),
  );
  if (pages > 1) {
    buttons.addComponents(
      new ButtonBuilder()
        .setCustomId(aliasId('page', String(page - 1)))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(aliasId('page', String(page + 1)))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages - 1),
    );
  }
  buttons.addComponents(
    new ButtonBuilder()
      .setCustomId(aliasId('close'))
      .setLabel('Close')
      .setStyle(ButtonStyle.Secondary),
  );
  rows.push(buttons);

  return { embeds: [json], components: rows, ephemeral: true };
}

/**
 * One alias, with the actions for it.
 *
 * Naming the exact pair here is what makes the single-click Danger remove safe:
 * the view itself is the confirmation, matching the editor's "Stop managing".
 */
export function buildAliasDetailPanel(game: string, alias: string): InteractionReplyOptions {
  const hash = aliasHash(game);
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('🏷️ Game alias')
    .setColor(0x5865f2)
    .setDescription(
      `**${clean(game, 100)}** shows as **${clean(alias, 100)}**.\n\n` +
        'The game name has to match what Discord reports exactly, including capitals.',
    )
    .toJSON();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(aliasId('edit', hash))
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(aliasId('remove', hash))
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(aliasId('back'))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}

/** The edit modal, prefilled with both halves of the alias being changed. */
export function buildAliasEditModal(game: string, alias: string): ModalBuilder {
  const gameInput = new TextInputBuilder()
    .setCustomId('game')
    .setLabel('Game name (exact)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(ALIAS_INPUT_MAX)
    .setValue(game.slice(0, ALIAS_INPUT_MAX));
  const aliasInput = new TextInputBuilder()
    .setCustomId('alias')
    .setLabel('Alias to show instead')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(ALIAS_INPUT_MAX)
    .setValue(alias.slice(0, ALIAS_INPUT_MAX));
  return new ModalBuilder()
    .setCustomId(aliasId('save', aliasHash(game)))
    .setTitle('Edit a game alias')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(gameInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(aliasInput),
    );
}

/** Reads the submitted edit modal. Shares field ids with the add modal. */
export function parseAliasEditModal(fields: ModalSubmitFields): { game: string; alias: string } {
  return { game: fields.getTextInputValue('game'), alias: fields.getTextInputValue('alias') };
}

/**
 * Neutralises markdown in a user-supplied game name so the embed cannot be broken.
 *
 * Truncates FIRST: escaping first and cutting after can slice a two-character
 * escape in half and leave a trailing backslash that eats the formatting after it.
 */
function clean(s: string, max: number): string {
  return truncate(s, max).replace(/[\\*_`~|]/g, '\\$&');
}

function truncate(s: string, max = 180): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
