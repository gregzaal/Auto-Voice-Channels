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
import type { Proposal } from '../features/templateAssistant/index.js';

/** Custom-id namespace for the `/templateassistant` flow. */
export const ASSISTANT_PREFIX = 'avc:ai:';

/**
 * `avc:ai:<action>:<sessionId>`.
 *
 * The proposal itself never goes in the custom id: a template can be a thousand
 * characters and a custom id caps at a hundred. The session id points at an
 * in-memory record (the same approach `/create`'s retry map takes), so a
 * restart simply forgets a pending proposal rather than mis-applying one.
 */
export const assistantId = (action: string, sessionId: string): string =>
  `${ASSISTANT_PREFIX}${action}:${sessionId}`;

export function parseAssistantId(customId: string): { action: string; sessionId: string } | null {
  if (!customId.startsWith(ASSISTANT_PREFIX)) return null;
  const [, , action, sessionId] = customId.split(':');
  if (!action || !sessionId) return null;
  return { action, sessionId };
}

/** Max length of the plain-language request. Generous, but bounds the prompt. */
export const REQUEST_INPUT_MAX = 500;

/** The "describe what you want" modal. `prefill` carries a refinement forward. */
export function buildAssistantModal(sessionId: string, refining: boolean): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId('request')
    .setLabel(refining ? 'What should change?' : 'Describe the name you want')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(REQUEST_INPUT_MAX)
    .setPlaceholder(
      refining
        ? 'e.g. make the emoji a controller, and drop the number'
        : 'e.g. show the game in caps with a number, and the owner’s name',
    );
  return new ModalBuilder()
    .setCustomId(assistantId(refining ? 'refine' : 'ask', sessionId))
    .setTitle(refining ? 'Refine the template' : 'Template assistant')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function truncate(s: string, max = 180): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const FIELD_LABEL = { name: '📛 Name', status: '💬 Status' } as const;

/**
 * The proposal panel: what the assistant came up with, what it renders to, and
 * Apply / Refine / Cancel.
 *
 * The previews are the point. A template is only correct in the states it will
 * actually meet, and the one state the admin can see (their own channel, right
 * now) is the one least likely to break. Showing the idle / playing / streaming
 * / party renders is what makes "Apply" an informed click.
 */
export function buildProposalPanel(
  sessionId: string,
  proposal: Proposal,
  opts: { capNotice?: string } = {},
): InteractionReplyOptions {
  const embed = new EmbedBuilder()
    .setTitle('✨ Template assistant')
    .setColor(0x9b6dff)
    .setDescription(proposal.explanation || 'Here is a template for that.');

  for (const field of proposal.fields) {
    const previews = field.previews
      .map((p) => `\`${truncate(p.rendered, 90) || ' '}\` · ${p.label}`)
      .join('\n');
    embed.addFields({
      name: FIELD_LABEL[field.field],
      value: `\`${truncate(field.template, 300)}\`\n${previews}`.slice(0, 1024),
    });
  }

  if (proposal.fields.length === 0) {
    embed.addFields({
      name: '​',
      value:
        'Nothing to apply from that one. Try describing it a different way, or set it by ' +
        'hand with `/template`.',
    });
  }
  if (proposal.notes.length > 0) {
    embed.addFields({
      name: 'Worth knowing',
      value: proposal.notes.map((n) => `• ${n}`).join('\n'),
    });
  }
  if (opts.capNotice) embed.setFooter({ text: truncate(opts.capNotice, 2000) });

  const buttons: ButtonBuilder[] = [];
  if (proposal.fields.length > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(assistantId('apply', sessionId))
        .setLabel('Apply')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(assistantId('refine', sessionId))
      .setLabel('Refine')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(assistantId('cancel', sessionId))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed.toJSON() as APIEmbed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)],
    ephemeral: true,
  };
}
