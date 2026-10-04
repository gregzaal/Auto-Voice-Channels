import {
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitFields,
} from 'discord.js';
import { blockedWordsText, MAX_BLOCKED_WORDS_TEXT } from '../features/voice/blockedWords.js';

/** Custom id for the `/blockedwords` modal. */
export const BLOCKED_WORDS_MODAL_ID = 'avc:blockedwords:set';

const WORDS_FIELD = 'words';

/**
 * The modal `/blockedwords` opens: one box, prefilled with the server's list one entry per
 * line, which the admin edits and submits whole. Not required, so emptying the box and
 * submitting empties the list.
 *
 * The box is capped at {@link MAX_BLOCKED_WORDS_TEXT}, and so is the stored list, which is
 * what keeps every stored list editable here without losing its tail.
 */
export function buildBlockedWordsModal(
  current: readonly string[],
  opts: { paused?: boolean } = {},
): ModalBuilder {
  const box = new TextInputBuilder()
    .setCustomId(WORDS_FIELD)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(MAX_BLOCKED_WORDS_TEXT)
    .setPlaceholder('One per line. word matches the whole word, word* its start, *word its end.');
  const text = blockedWordsText(current);
  if (text !== '') box.setValue(text.slice(0, MAX_BLOCKED_WORDS_TEXT));

  return new ModalBuilder()
    .setCustomId(BLOCKED_WORDS_MODAL_ID)
    .setTitle('Blocked words')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Words to keep out of room names')
        // While `word_filter.disabled` is on, the one place an admin is looking says so. No `*`
        // in the description: it may be read as markdown, and a pair would turn into italics.
        .setDescription(
          opts.paused
            ? 'Word filtering is switched off for now. You can still change the list.'
            : 'A star at both ends matches inside other words too. Leave empty to block none.',
        )
        .setTextInputComponent(box),
    );
}

/** What the admin submitted, as typed. Splitting and checking it is `parseBlockedWordsInput`'s. */
export function parseBlockedWordsModal(fields: ModalSubmitFields): string {
  return fields.getTextInputValue(WORDS_FIELD);
}
