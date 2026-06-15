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
import type { EditorKind, EditorState } from '../features/voice/index.js';

/** Custom-id namespace for the `/name` and `/template` editor panel. */
export const EDITOR_PREFIX = 'avc:tpl:';
export const editorId = (action: string, kind: EditorKind, channelId: string): string =>
  `${EDITOR_PREFIX}${action}:${kind}:${channelId}`;
/** Parses `avc:tpl:<action>:<kind>:<channelId>`. */
export function parseEditorId(
  customId: string,
): { action: string; kind: EditorKind; channelId: string } | null {
  if (!customId.startsWith(EDITOR_PREFIX)) return null;
  const [, , action, kind, channelId] = customId.split(':');
  if (!action || (kind !== 'name' && kind !== 'template') || !channelId) return null;
  return { action, kind, channelId };
}

const VARIABLES_HELP =
  '`##` number · `@@game_name@@` current game · `@@creator@@` owner · `@@num@@` members\n' +
  '`@@nato@@` Alpha/Bravo… · `[[a/b]]` random · `<<one/many>>` plural · `{{cond ?? a // b}}` if\n' +
  '_Plain text works too — e.g. `My Lounge`. See `/debug` for the full picture._';

/** Builds the ephemeral editor panel for a `/name` or `/template` target. */
export function renderEditorPanel(
  kind: EditorKind,
  channelId: string,
  state: EditorState,
  opts: { updated?: boolean; note?: string } = {},
): InteractionReplyOptions {
  const isName = kind === 'name';
  const current = state.currentTemplate ?? `(inheriting \`${state.serverDefault}\`)`;
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle(isName ? '✏️ Channel name' : '🧩 Creator-channel template')
    .setColor(0x5865f2)
    .setDescription(
      isName
        ? `Editing <#${channelId}> — only this channel.`
        : `Editing the template for **all** channels of <#${channelId}>’s creator channel.`,
    )
    .addFields(
      { name: 'Current', value: `\`${truncate(current)}\`` },
      { name: 'Preview', value: state.preview ? `\`${truncate(state.preview)}\`` : '—' },
      { name: 'Variables', value: VARIABLES_HELP },
    )
    .toJSON();
  if (opts.note) embed.fields!.push({ name: '​', value: opts.note });
  if (opts.updated) embed.footer = { text: '✅ Saved' };

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(editorId('edit', kind, channelId))
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(editorId('reset', kind, channelId))
      .setLabel('Reset to default')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(editorId('close', kind, channelId))
      .setLabel('Close')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row], ephemeral: true };
}

/** The "Edit" modal: a single multi-line input prefilled with the current value. */
export function buildEditorModal(
  kind: EditorKind,
  channelId: string,
  state: EditorState,
): ModalBuilder {
  // Prefill: a name override starts blank (people usually type a literal); a
  // template starts from the current/effective so it can be tweaked.
  const prefill =
    kind === 'name'
      ? (state.currentTemplate ?? '')
      : (state.currentTemplate ?? state.effectiveTemplate);
  const input = new TextInputBuilder()
    .setCustomId('template')
    .setLabel(kind === 'name' ? 'New name (tokens allowed)' : 'Name template')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(100)
    .setPlaceholder('e.g. ## [@@game_name@@]  or  My Lounge')
    .setValue(prefill.slice(0, 100));
  return new ModalBuilder()
    .setCustomId(editorId('save', kind, channelId))
    .setTitle(kind === 'name' ? 'Rename channel' : 'Set template')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
