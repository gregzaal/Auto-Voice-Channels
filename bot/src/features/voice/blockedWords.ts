import { blockedWordKey, blockedWordProblem, type BlockedWordProblem } from './nameTemplate.js';

/**
 * A server's blocked words, the bot's half: the caps, and reading what an admin typed into
 * `/blockedwords`. The matcher itself is the engine's (`@avc/core/template`), so the doors
 * that refuse a typed name and the renders that mask one cannot disagree about a match.
 *
 * **The list ships empty, and there is no built-in list.** Decided by the owner on
 * 2026-10-04, reversing the 2026-10-03 decline: `/restrict` stays the main answer to a
 * member who abuses room names, and this is for an admin who also needs a word kept out.
 * Nobody is exempt, admins included: rendered names are masked whoever typed them, so an
 * exempt typed name would be accepted and then shown masked, and refusing everyone also lets
 * an admin test the list by typing a word.
 */

/**
 * The longest one entry may be, wildcards included: Discord AutoMod's own cap on a custom
 * keyword. `IMPORT_LIMITS.blockedWordChars` in core, bound by `blockedWords.unit.test.ts`.
 */
export const MAX_BLOCKED_WORD_LENGTH = 60;

/**
 * Most entries one server may block: AutoMod's own cap on the keywords of one rule.
 * `IMPORT_LIMITS.blockedWords`. Bounded because the list rides in the settings blob that every
 * instance keeps resident, and because every render of every room in the server runs it.
 */
export const MAX_BLOCKED_WORDS = 1000;

/**
 * Most characters the whole list may hold, one entry per line: the cap Discord puts on the
 * paragraph box `/blockedwords` prefills with it. A stored list has to be editable by the
 * surface that stores it, or opening the box and pressing Submit would silently cut its tail.
 * `IMPORT_LIMITS.blockedWordsTotalChars`.
 */
export const MAX_BLOCKED_WORDS_TEXT = 4000;

/** The list as the `/blockedwords` box shows it: one entry per line. */
export function blockedWordsText(words: readonly string[]): string {
  return words.join('\n');
}

/** An entry an admin typed that cannot be saved, and why. */
export interface RejectedBlockedWord {
  entry: string;
  problem: BlockedWordProblem;
}

/**
 * What an admin typed into `/blockedwords`, read: split on line breaks and commas, trimmed,
 * each run of whitespace inside an entry made one space (a phrase pasted with a tab in it is
 * still a phrase), empties dropped, de-duplicated by case and accents (the first spelling
 * wins), and each entry checked. The entries that can be used and the ones that cannot come
 * back apart, so the caller saves the first and reports the second.
 */
export function parseBlockedWordsInput(raw: string): {
  words: string[];
  rejected: RejectedBlockedWord[];
} {
  const words: string[] = [];
  const rejected: RejectedBlockedWord[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\r\n,\u0085\u2028\u2029]+/)) {
    const entry = piece.trim().replace(/[ \t\u00a0]+/g, ' ');
    if (entry === '') continue;
    const problem = blockedWordProblem(entry, MAX_BLOCKED_WORD_LENGTH);
    if (problem !== null) {
      rejected.push({ entry, problem });
      continue;
    }
    const key = blockedWordKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(entry);
  }
  return { words, rejected };
}

/**
 * Whether `next` puts any entry on the list that `current` does not already hold, compared
 * the way entries are matched. In a lapsed server a save that only takes entries away stays
 * open and one that adds is refused, which is the hard gate's rule everywhere.
 */
export function addsBlockedWords(current: readonly string[], next: readonly string[]): boolean {
  const held = new Set(current.map(blockedWordKey));
  return next.some((word) => !held.has(blockedWordKey(word)));
}
