import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type InteractionReplyOptions,
  type ModalSubmitFields,
} from 'discord.js';
import { LIST_NAME_MAX } from '../features/voice/nameTemplate.js';

/**
 * The `/setup` panel for named `[[list:name]]` pools.
 *
 * Shaped after the `/alias` panel, with one deliberate difference: a list name
 * is validated to carry no `:`, so ids and select values carry the NAME rather
 * than a hash of it. `/alias` needs the hash because a game name is whatever
 * Discord reports and routinely contains a colon; a list name is something an
 * admin types here, so the constraint is ours to make and it removes a whole
 * class of lookup failure.
 */

/** Custom-id namespace for the named-lists panel. */
export const LISTS_PREFIX = 'avc:lists:';

/** Custom id of the panel's list picker (a message-level string select). */
export const LISTS_SELECT_ID = `${LISTS_PREFIX}pick`;

/** Discord's cap on a select option's label and description. */
const OPTION_TEXT_MAX = 100;

/**
 * Discord's cap on a paragraph text input.
 *
 * The real ceiling on what a list may hold is `MAX_LIST_OPTIONS` in the settings
 * service, checked on the way in. This only stops the modal itself rejecting the
 * submit, which would lose the whole edit with no message.
 */
export const LIST_OPTIONS_INPUT_MAX = 4000;

/** Embed budget, matching the alias panel's: Discord refuses a description past 4096. */
const DESCRIPTION_MAX = 3900;

/** The panel's actions. `edit`, `remove` and `save` carry a list name. */
export type ListsAction = 'add' | 'edit' | 'remove' | 'save' | 'back' | 'close';

const ACTIONS: readonly string[] = ['add', 'edit', 'remove', 'save', 'back', 'close'];

/** Builds `avc:lists:<action>[:<name>]`. */
export const listsId = (action: ListsAction, name?: string): string =>
  name === undefined ? `${LISTS_PREFIX}${action}` : `${LISTS_PREFIX}${action}:${name}`;

/**
 * Parses `avc:lists:<action>[:<name>]`.
 *
 * The name is rejoined rather than read as one field, so a stored name that
 * somehow contains a colon (an `/import` from a file written before
 * `isValidListName` existed) opens the detail view and can be removed, instead
 * of resolving to a truncated name that matches nothing.
 */
export function parseListsId(
  customId: string,
): { action: ListsAction; name: string | null } | null {
  if (!customId.startsWith(LISTS_PREFIX)) return null;
  const rest = customId.slice(LISTS_PREFIX.length);
  const colon = rest.indexOf(':');
  const action = colon === -1 ? rest : rest.slice(0, colon);
  if (!ACTIONS.includes(action)) return null;
  const name = colon === -1 ? null : rest.slice(colon + 1);
  return { action: action as ListsAction, name };
}

/** Sorted case-insensitively by name, so the panel order never wobbles. */
export function sortLists(lists: Record<string, string[]>): [string, string[]][] {
  return Object.entries(lists).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Finds a list by its exact stored name, or null when it is gone. */
export function findList(lists: Record<string, string[]>, name: string): string[] | null {
  return Object.prototype.hasOwnProperty.call(lists, name) ? lists[name]! : null;
}

/**
 * The panel's main view: every list this guild has, a picker to open one, and an
 * Add button.
 *
 * No pagination, because the cap is 25 and a select holds 25. If the cap ever
 * rises this needs the alias panel's paging, not a silently short list.
 */
export function buildListsPanel(
  lists: Record<string, string[]>,
  opts: { note?: string } = {},
): InteractionReplyOptions {
  const entries = sortLists(lists);
  const embed = new EmbedBuilder().setTitle('🎲 Named lists').setColor(0x5865f2);
  if (entries.length === 0) {
    embed.setDescription(
      'No lists yet. A list is a set of words AVC picks one of, written in a template ' +
        'as `[[list:name]]`. Useful when the choices are too many to fit in the ' +
        'template itself, and for reusing the same set in several templates.',
    );
  } else {
    const lines: string[] = [];
    let budget = DESCRIPTION_MAX;
    let hidden = 0;
    for (const [name, options] of entries) {
      const preview = options.slice(0, 6).join(', ');
      const more = options.length > 6 ? `, and ${options.length - 6} more` : '';
      const line = `**${clean(name, LIST_NAME_MAX)}** (${options.length}): ${clean(
        preview,
        160,
      )}${more}`;
      if (line.length + 1 > budget) {
        hidden += 1;
        continue;
      }
      budget -= line.length + 1;
      lines.push(line);
    }
    if (hidden > 0) lines.push(`_${hidden} more are too long to list. Use the picker below._`);
    embed.setDescription(lines.join('\n'));
  }
  const json: APIEmbed = embed.toJSON();
  if (opts.note) json.fields = [{ name: '​', value: truncate(opts.note, 1024) }];

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (entries.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(LISTS_SELECT_ID)
          .setPlaceholder('Choose a list to edit or remove')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            entries.map(([name, options]) =>
              new StringSelectMenuOptionBuilder()
                .setValue(truncate(name, OPTION_TEXT_MAX))
                .setLabel(truncate(name, OPTION_TEXT_MAX))
                .setDescription(
                  truncate(`${options.length} options: ${options.join(', ')}`, OPTION_TEXT_MAX),
                ),
            ),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(listsId('add'))
        .setLabel('Add')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(listsId('close'))
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [json], components: rows, ephemeral: true };
}

/**
 * One list, with the actions for it.
 *
 * Showing every option is what makes the single-click Danger remove safe: the
 * view itself is the confirmation, matching the alias panel and the editor's
 * "Stop managing".
 */
export function buildListDetailPanel(name: string, options: string[]): InteractionReplyOptions {
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('🎲 Named list')
    .setColor(0x5865f2)
    .setDescription(
      `**${clean(name, LIST_NAME_MAX)}**, used in a template as ` +
        `\`[[list:${clean(name, LIST_NAME_MAX)}]]\`.\n\n` +
        `${clean(options.join(', '), 3600)}\n\n` +
        '_One of these is picked per room, and it never changes for that room._',
    )
    .toJSON();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(listsId('edit', name))
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(listsId('remove', name))
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(listsId('back'))
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}

/**
 * The add/edit modal.
 *
 * One option per line rather than slash-separated, because that is the one
 * layout a phone keyboard and a paste from a spreadsheet both produce, and
 * because a `/` is what separates choices inside a template: an admin who typed
 * them that way here would get one option containing slashes.
 *
 * The name is prefilled and editable, so a rename is a delete plus a set in ONE
 * write, exactly as `/alias` does it.
 */
export function buildListEditModal(name?: string, options?: readonly string[]): ModalBuilder {
  const nameInput = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('List name')
    .setPlaceholder('animals')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(LIST_NAME_MAX);
  if (name) nameInput.setValue(name.slice(0, LIST_NAME_MAX));
  const optionsInput = new TextInputBuilder()
    .setCustomId('options')
    .setLabel('Options, one per line')
    .setPlaceholder('otter\nbadger\nheron')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(LIST_OPTIONS_INPUT_MAX);
  if (options && options.length > 0) {
    optionsInput.setValue(options.join('\n').slice(0, LIST_OPTIONS_INPUT_MAX));
  }
  return new ModalBuilder()
    .setCustomId(name === undefined ? listsId('save') : listsId('save', name))
    .setTitle(name === undefined ? 'Add a named list' : 'Edit a named list')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(optionsInput),
    );
}

/** Reads the submitted modal. Options are one per line, blanks dropped. */
export function parseListEditModal(fields: ModalSubmitFields): {
  name: string;
  options: string[];
} {
  return {
    name: fields.getTextInputValue('name').trim(),
    options: parseListOptions(fields.getTextInputValue('options')),
  };
}

/**
 * Splits the options box into options.
 *
 * Duplicates are KEPT: repeating an option is the only way to weight a pick, and
 * silently collapsing them would change what the admin asked for.
 */
export function parseListOptions(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Truncates first, then escapes, so a cut can never bisect an escape sequence. */
function clean(s: string, max: number): string {
  return escapeMarkdown(truncate(s, max));
}

function truncate(s: string, max = 180): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
