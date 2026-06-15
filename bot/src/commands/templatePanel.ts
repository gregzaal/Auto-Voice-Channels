import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type InteractionReplyOptions,
} from 'discord.js';
import type { EditorField, EditorScope, EditorState } from '../features/voice/index.js';

/** Custom-id namespace for the `/name` and `/template` editor panel. */
export const EDITOR_PREFIX = 'avc:tpl:';
export const editorId = (
  action: string,
  scope: EditorScope,
  field: EditorField,
  channelId: string,
): string => `${EDITOR_PREFIX}${action}:${scope}:${field}:${channelId}`;

/** Parses `avc:tpl:<action>:<scope>:<field>:<channelId>`. */
export function parseEditorId(
  customId: string,
): { action: string; scope: EditorScope; field: EditorField; channelId: string } | null {
  if (!customId.startsWith(EDITOR_PREFIX)) return null;
  const [, , action, scope, field, channelId] = customId.split(':');
  if (
    !action ||
    (scope !== 'channel' && scope !== 'primary') ||
    (field !== 'name' && field !== 'status') ||
    !channelId
  ) {
    return null;
  }
  return { action, scope, field, channelId };
}

/** Max length of a template in the edit modal (well above any rendered-output cap). */
const TEMPLATE_INPUT_MAX = 1000;
const DOCS_LINK = 'https://wiki.dotsbots.com/en/commands/template';
const VARIABLES_HELP =
  '`##` number · `@@game_name@@` game · `@@creator@@` owner · `@@num@@` members\n' +
  '`@@nato@@` Alpha/Bravo… · `[[a/b]]` random · `<<one/many>>` plural · `{{cond ?? a // b}}` if\n' +
  `_Plain text works too. **[Full documentation & variables ↗](${DOCS_LINK})**_`;

function fieldValue(template: string | undefined, fallbackHint: string): string {
  if (template === undefined) return fallbackHint;
  return template === '' ? '_(empty — no status)_' : `\`${truncate(template)}\``;
}

/** Builds the ephemeral editor panel showing both the name and status templates. */
export function renderEditorPanel(
  scope: EditorScope,
  channelId: string,
  state: EditorState,
  opts: { updated?: boolean; note?: string } = {},
): InteractionReplyOptions {
  const isChannel = scope === 'channel';
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle(isChannel ? '✏️ Channel name & status' : '🧩 Creator-channel templates')
    .setColor(0x5865f2)
    .setDescription(
      isChannel
        ? `Editing <#${channelId}> — just this channel.`
        : `Editing the templates for **all** channels of <#${channelId}>’s creator channel.`,
    )
    .addFields(
      {
        name: '📛 Name',
        value:
          `${fieldValue(state.name.currentTemplate, '_(inheriting default)_')}\n` +
          `Preview: \`${truncate(state.name.preview) || '—'}\``,
      },
      {
        name: '💬 Status',
        value:
          `${fieldValue(state.status.currentTemplate, '_(inheriting default)_')}\n` +
          `Preview: ${state.status.preview ? `\`${truncate(state.status.preview)}\`` : '_(none)_'}`,
      },
      { name: 'Variables', value: VARIABLES_HELP },
    )
    .toJSON();
  if (opts.note) embed.fields!.push({ name: '​', value: opts.note });
  if (opts.updated) embed.footer = { text: '✅ Saved' };

  const editRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(editorId('edit', scope, 'name', channelId))
      .setLabel('Edit name template')
      .setEmoji('📛')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(editorId('edit', scope, 'status', channelId))
      .setLabel('Edit status template')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Primary),
  );
  const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(editorId('reset', scope, 'name', channelId))
      .setLabel('Reset name')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(editorId('reset', scope, 'status', channelId))
      .setLabel('Reset status')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(editorId('close', scope, 'name', channelId))
      .setLabel('Close')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [editRow, manageRow], ephemeral: true };
}

/** The "Edit" modal for one field, prefilled with the current/effective value. */
export function buildEditorModal(
  scope: EditorScope,
  field: EditorField,
  channelId: string,
  state: EditorState,
): ModalBuilder {
  const fs = state[field];
  // Per-channel overrides start blank (people type a literal); a primary template
  // (and any existing override) starts from the current value so it can be tweaked.
  const prefill = fs.currentTemplate ?? (scope === 'primary' ? fs.effectiveTemplate : '');
  const input = new TextInputBuilder()
    .setCustomId('template')
    .setLabel(field === 'name' ? 'Name template' : 'Status template')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    // A *template* (with tokens) can be far longer than the *rendered* output it
    // produces, so the input limit is the generous template cap — not the 100/500
    // output limits (that truncated the default template's prefill).
    .setMaxLength(TEMPLATE_INPUT_MAX)
    .setPlaceholder(
      field === 'name'
        ? 'e.g. ## [@@game_name@@]  or  My Lounge'
        : 'e.g. Playing @@game_name@@  (blank = no status)',
    )
    .setValue(prefill.slice(0, TEMPLATE_INPUT_MAX));
  return new ModalBuilder()
    .setCustomId(editorId('save', scope, field, channelId))
    .setTitle(field === 'name' ? 'Edit name template' : 'Edit status template')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function truncate(s: string, max = 180): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
