import type { BlockedWordProblem } from './nameTemplate.js';
import {
  MAX_BLOCKED_WORD_LENGTH,
  MAX_BLOCKED_WORDS,
  type RejectedBlockedWord,
} from './blockedWords.js';

/**
 * What the bot says about a server's blocked words, worded once so one render-time test
 * covers every sentence.
 *
 * **No sentence a member reads ever repeats a blocked word.** A refusal says that the text
 * holds one and not which, and the `/logging` line names who tried and not what they typed:
 * the words may be slurs, and the log channel is read by whoever the admin chose. The one
 * place an entry is quoted back is the `/blockedwords` reply, which only the admin who typed
 * it sees, and only for an entry that could not be saved.
 */

/** Which door a typed text came in by, for the refusal and the log line. */
export type BlockedWordDoor = 'name' | 'status' | 'nick';

/** What a member is told when a typed name, status or nickname holds a blocked word. */
export function blockedWordRefusal(door: BlockedWordDoor): string {
  return door === 'status'
    ? "That has a word this server doesn't allow in a room's status. Try something else."
    : "That has a word this server doesn't allow in room names. Try something else.";
}

/** The `/logging` line for a refusal: who, and where, and never the text. */
export function blockedWordLogLine(userId: string, door: BlockedWordDoor): string {
  const where =
    door === 'nick' ? 'their nickname' : door === 'status' ? "a room's status" : 'a room name';
  return `🚫 <@${userId}> tried to use a blocked word in ${where}.`;
}

/** "1 word", "3 words". */
const words = (n: number): string => `${n} ${n === 1 ? 'word' : 'words'}`;

/**
 * What saving the list says: how many words are blocked and what that does, or that nothing
 * is filtered. Where it applies is said in full, because an admin who blocks a word and then
 * sees it in a game title would otherwise call it a bug.
 *
 * A "⇩ Join" channel is named when it is made (and when its room changes hands), and nothing
 * renames it after, so the promise is about new ones. A room's name is rendered again on
 * every sweep, which is what makes the last sentence true of rooms that already exist.
 */
export function blockedWordsSavedMessage(count: number): string {
  if (count === 0) return 'The blocked words list is empty, so nothing is filtered.';
  return (
    `This server blocks **${words(count)}**. Nobody can type one into \`/name\`, the Name ` +
    "button on a room's panel or `/nick`, admins included. Anywhere else one turns up, like a " +
    'game title or a display name, it shows as `***` in room names, voice statuses and new ' +
    '**⇩ Join** channels. A room that already shows one changes the next time its name updates.'
  );
}

/** Added to the reply while `word_filter.disabled` is on, so the sentence above stays true. */
export const BLOCKED_WORDS_PAUSED =
  'Word filtering is switched off for now, so nothing is refused or shown as `***` until it is back on.';

/** Why each kind of entry could not be saved, as the start of a sentence. */
const PROBLEM_LEAD: Record<BlockedWordProblem, string> = {
  wildcard: 'A `*` can only go at the very start or the very end, so these were not saved',
  too_long: `An entry can be up to ${MAX_BLOCKED_WORD_LENGTH} characters, so these were not saved`,
  empty: 'These have no letter or number to match, so they were not saved',
  character: 'These hold a character an entry cannot have, so they were not saved',
};

/** Said, above the lines below, when the box held text and none of it could be saved. */
export const BLOCKED_WORDS_NOTHING_USABLE =
  'Nothing in that could be saved, so the list is as it was.';

/** How many rejected entries one line quotes before it says how many more. */
const QUOTED = 10;
/** How much of one rejected entry is quoted, in characters, before it is cut short. */
const QUOTED_LENGTH = 40;

/**
 * The entries that could not be saved, one line per reason. Each is quoted in a code span with
 * any backtick taken out, so an entry cannot close the span and turn the rest of the reply
 * into markdown, and cut to {@link QUOTED_LENGTH} characters, so a paste that came in as one
 * long entry cannot push the reply past what Discord takes.
 */
export function rejectedWordsLines(rejected: readonly RejectedBlockedWord[]): string[] {
  const lines: string[] = [];
  for (const problem of Object.keys(PROBLEM_LEAD) as BlockedWordProblem[]) {
    const entries = rejected.filter((r) => r.problem === problem).map((r) => r.entry);
    if (entries.length === 0) continue;
    const quoted = entries
      .slice(0, QUOTED)
      .map((entry) => {
        const points = [...entry.replace(/`/g, '')];
        const shown =
          points.length > QUOTED_LENGTH
            ? `${points.slice(0, QUOTED_LENGTH - 1).join('')}…`
            : points.join('');
        return `\`${shown || ' '}\``;
      })
      .join(', ');
    const more = entries.length > QUOTED ? `, and ${entries.length - QUOTED} more` : '';
    lines.push(`⚠️ ${PROBLEM_LEAD[problem]}: ${quoted}${more}.`);
  }
  return lines;
}

/** Said when the box held more entries than a server may block, and nothing was saved. */
export function tooManyBlockedWords(count: number): string {
  return `That is ${words(count)}, and a server can block up to ${MAX_BLOCKED_WORDS}. Nothing was saved.`;
}

/** Said when the whole list is longer than the box that edits it can hold. Nothing was saved. */
export const BLOCKED_WORDS_TOO_LONG =
  'That list is longer than the box can hold, so it could not be edited again. Nothing was saved.';

/** The `/logging` line for a change to the list: who, and how many, and never the words. */
export function blockedWordsAuditLine(adminId: string, count: number): string {
  return count === 0
    ? `🚫 <@${adminId}> emptied the blocked words list.`
    : `🚫 <@${adminId}> changed the blocked words list. It has ${words(count)} now.`;
}
