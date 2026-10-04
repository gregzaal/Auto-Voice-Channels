/**
 * A server's blocked words: the pure matcher behind `/blockedwords`, which refuses
 * typed room names that use one and masks every match in what the bot renders.
 *
 * **Browser-safe, like the rest of this entry point.** No `process`, no clock, no
 * repository: the engine imports it, and the engine is imported by the marketing
 * site's browser bundle.
 *
 * **Matching is Discord AutoMod's custom keywords, deliberately**, because that is
 * the syntax an admin who writes a list has already met:
 *
 * - `word` matches the whole word only. A word boundary is any character that is not
 *   a Unicode letter or number, judged on the text as written, on either side, so
 *   `bad` matches `bad`, `bad!`, `bad™` and `🍆bad` and not `badge` or `bad2`.
 * - `word*` matches words that start with it, `*word` words that end with it, and
 *   `*word*` the text anywhere, inside other words too. The first two mask the whole
 *   word they matched, the last only the text itself.
 * - A `*` anywhere else is invalid, an entry may contain spaces (a phrase), and an
 *   entry needs at least one letter or number to match.
 *
 * Both sides are folded before they are compared: NFKD, combining marks and
 * invisible format characters (zero-width spaces and joiners, soft hyphens)
 * dropped, lower case, final sigma read as sigma, and each run of whitespace read as
 * one space. So `Bád`, `𝐁𝐀𝐃`, `ｂａｄ` and `b\u200bad` all read as `bad`. Matches are
 * mapped back onto the original characters, so masking replaces exactly what was
 * matched with `***` and leaves the rest of the text as it was.
 *
 * Languages written without spaces (Chinese, Japanese, Thai) have no word
 * boundaries to find, so a plain entry there only matches text standing on its
 * own, and `*word*` is how an admin matches it inside a sentence. That is what
 * AutoMod does too. There is no look-alike or leetspeak mapping: a list somebody
 * is trying to get round is a game they win, which is why `/restrict` exists.
 */

/**
 * What every match is replaced with. Never matchable itself: an entry needs a letter or
 * a number to be usable, and the mask has neither, so masked text never matches again
 * and masking cannot feed on its own output.
 */
export const BLOCKED_WORD_MASK = '***';

/**
 * Why an entry cannot be used.
 *
 * - `empty`: no letter or number left to match once the wildcards are taken off.
 * - `wildcard`: a `*` somewhere other than the very start or end, a character that
 *   reads as one (`＊`) included.
 * - `character`: a comma or a line break, which the `/blockedwords` box splits on, so an
 *   entry holding one would be cut in two the next time the list is saved, or any other
 *   control character.
 * - `too_long`: longer than the cap the caller passes.
 */
export type BlockedWordProblem = 'empty' | 'wildcard' | 'character' | 'too_long';

/** How an entry matches: the whole word, the start of a word, the end of one, or anywhere. */
export type BlockedWordKind = 'word' | 'prefix' | 'suffix' | 'anywhere';

/** One usable entry, folded and ready to match. */
export interface ParsedBlockedWord {
  kind: BlockedWordKind;
  /** The text between the wildcards, folded, with each run of spaces as one space. */
  core: string;
}

/** A match, as UTF-16 offsets into the ORIGINAL text: `text.slice(start, end)`. */
export interface BlockedWordMatch {
  start: number;
  end: number;
}

/** Combining marks, and the invisible format characters that would split a word apart. */
const DROPPED = /[\p{M}\p{Cf}]/gu;
/** A code point that folds to nothing, so it belongs to the character before it. */
const ATTACHED = /^[\p{M}\p{Cf}]$/u;
/** What belongs to the end of a match: what folds to nothing, and emoji skin tones. */
const TRAILING = /^[\p{M}\p{Cf}\p{Emoji_Modifier}]$/u;
/** One code point that is part of a word. */
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
/** What `/blockedwords` splits on, and so what an entry can never hold. */
const SEPARATOR = /[,\r\n\u0085\u2028\u2029]/u;
const CONTROL = /\p{Cc}/u;
const WHITESPACE = /^\s+$/u;

/**
 * Folded code points, remembered. A render folds every character of a room name, and
 * names repeat the same few hundred characters, so this saves a normalisation per
 * character per render. Bounded, and simply emptied when full.
 */
const FOLD_CACHE = new Map<string, string>();
const FOLD_CACHE_MAX = 4096;

/**
 * One code point, folded: NFKD, marks and format characters dropped, lower case, final
 * sigma as sigma (folding a word one character at a time cannot know the sigma is
 * final, and a whole-string lower case writes `ς` at the end of `ΟΔΟΣ`), and whitespace
 * as one space.
 */
function foldCodePoint(cp: string): string {
  const code = cp.codePointAt(0)!;
  if (code < 0x80) return WHITESPACE.test(cp) ? ' ' : cp.toLowerCase();
  const cached = FOLD_CACHE.get(cp);
  if (cached !== undefined) return cached;
  // Twice, because lower-casing can itself produce a decomposable character (`İ`).
  const once = cp.normalize('NFKD').replace(DROPPED, '').toLowerCase();
  let folded = once.normalize('NFKD').replace(DROPPED, '').replace(/ς/g, 'σ');
  if (folded !== '' && WHITESPACE.test(folded)) folded = ' ';
  if (FOLD_CACHE.size >= FOLD_CACHE_MAX) FOLD_CACHE.clear();
  FOLD_CACHE.set(cp, folded);
  return folded;
}

/** Text folded, with where each folded UTF-16 unit came from in the original. */
interface FoldedText {
  text: string;
  /** Per folded unit: the original offset of the code point it came from, and its end. */
  from: number[];
  to: number[];
}

/** Folds `text`, keeping the map back to it. A run of whitespace folds to one space. */
function foldWithMap(text: string): FoldedText {
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const cp of text) {
    const f = foldCodePoint(cp);
    if (f === ' ' && folded.endsWith(' ')) {
      to[to.length - 1] = at + cp.length;
    } else {
      for (let i = 0; i < f.length; i++) {
        from.push(at);
        to.push(at + cp.length);
      }
      folded += f;
    }
    at += cp.length;
  }
  return { text: folded, from, to };
}

/** Text folded the way entries and names are compared. */
export function foldBlockedText(text: string): string {
  return foldWithMap(text).text;
}

/**
 * The text an entry is compared and de-duplicated by: folded, trimmed. `Bad Word`,
 * `bád  word` and ` BAD WORD ` are one entry, and so are `*bad` and `＊bad`.
 */
export function blockedWordKey(entry: string): string {
  return foldBlockedText(entry).trim();
}

/** Splits an entry into its wildcards and its folded text, or says why it cannot be used. */
function splitEntry(entry: string): ParsedBlockedWord | { problem: BlockedWordProblem } {
  const trimmed = entry.trim();
  if (SEPARATOR.test(trimmed) || CONTROL.test(trimmed.replace(/\t/g, ' '))) {
    return { problem: 'character' };
  }
  // Judged FOLDED, so a character that reads as `*` counts as one: an entry of `＊`
  // would otherwise be a core of `*`, which matches the mask itself.
  const folded = blockedWordKey(trimmed);
  const head = folded.startsWith('*');
  const tail = folded.length > 1 && folded.endsWith('*');
  const core = folded.slice(head ? 1 : 0, tail ? -1 : undefined).trim();
  if (core.includes('*')) return { problem: 'wildcard' };
  if (!HAS_WORD_CHAR.test(core)) return { problem: 'empty' };
  const kind: BlockedWordKind = head ? (tail ? 'anywhere' : 'suffix') : tail ? 'prefix' : 'word';
  return { kind, core };
}

/**
 * Why an entry cannot be used, or null when it can.
 *
 * `maxLength` is the caller's, because the cap lives beside the caller's other caps
 * (`MAX_BLOCKED_WORD_LENGTH` in the bot, `IMPORT_LIMITS.blockedWordChars` in the
 * importer, bound to each other by a test). It counts the entry as typed, trimmed,
 * wildcards included, which is how AutoMod counts its 60.
 */
export function blockedWordProblem(entry: string, maxLength: number): BlockedWordProblem | null {
  const split = splitEntry(entry);
  if ('problem' in split) return split.problem;
  return entry.trim().length > maxLength ? 'too_long' : null;
}

/** An entry ready to match, or null when it cannot be used (see {@link blockedWordProblem}). */
export function parseBlockedWord(entry: string): ParsedBlockedWord | null {
  const split = splitEntry(entry);
  return 'problem' in split ? null : split;
}

/**
 * The entries of a stored or imported list that can be used, trimmed, with repeats
 * (by case and accents) dropped and the first spelling kept, and how many were not
 * usable. One rule for the importer and for `/export`'s check of what `/import` would
 * accept, so the two cannot count a list differently.
 */
export function keepBlockedWords(
  values: readonly unknown[],
  maxLength: number,
): { kept: string[]; unusable: number } {
  const kept: string[] = [];
  const seen = new Set<string>();
  let unusable = 0;
  for (const value of values) {
    if (typeof value !== 'string' || blockedWordProblem(value, maxLength) !== null) {
      unusable += 1;
      continue;
    }
    const entry = value.trim();
    const key = blockedWordKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return { kept, unusable };
}

/** A list, compiled once: see {@link compileBlockedWords}. */
export interface BlockedWordMatcher {
  /** How many usable entries it holds. Zero matches nothing and masks nothing. */
  readonly size: number;
  /** The first match in `text`, or null. */
  find(text: string): BlockedWordMatch | null;
  /** `text` with every match replaced by {@link BLOCKED_WORD_MASK}. */
  mask(text: string): string;
}

/** The code point that starts at `at`, or undefined at the end. */
function codePointAt(text: string, at: number): string | undefined {
  return at < text.length ? String.fromCodePoint(text.codePointAt(at)!) : undefined;
}

/** The code point that ends at `at`, or undefined at the start. */
function codePointBefore(text: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  if (at >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text[at - 1];
}

/** Widens an original end offset over code points that belong to the character before. */
function widenEnd(text: string, end: number): number {
  let at = end;
  for (let cp = codePointAt(text, at); cp && TRAILING.test(cp); cp = codePointAt(text, at)) {
    at += cp.length;
  }
  return at;
}

/** Whether the character before `at`, marks skipped, is part of a word. */
function wordBefore(text: string, at: number): boolean {
  let start = at;
  for (let cp = codePointBefore(text, start); cp; cp = codePointBefore(text, start)) {
    if (!ATTACHED.test(cp)) return WORD_CHAR.test(cp);
    start -= cp.length;
  }
  return false;
}

/** Where the word that `at` is inside of ends, in the original text. */
function wordEnd(text: string, at: number): number {
  let end = at;
  for (
    let cp = codePointAt(text, end);
    cp && (WORD_CHAR.test(cp) || TRAILING.test(cp));
    cp = codePointAt(text, end)
  ) {
    end += cp.length;
  }
  return end;
}

/** Where the word that `at` is inside of starts, in the original text. */
function wordStart(text: string, at: number): number {
  let start = at;
  for (
    let cp = codePointBefore(text, start);
    cp && (WORD_CHAR.test(cp) || ATTACHED.test(cp));
    cp = codePointBefore(text, start)
  ) {
    start -= cp.length;
  }
  return start;
}

/** One trie node: the folded units that continue a core, and the kinds that end here. */
interface TrieNode {
  next: Map<string, TrieNode>;
  ends?: BlockedWordKind[];
}

const NO_MATCHES: BlockedWordMatcher = {
  size: 0,
  find: () => null,
  mask: (text) => text,
};

/**
 * Builds the matcher for one list.
 *
 * Every entry's folded core goes into one trie, and a text is walked from every folded
 * position, so each place every entry matches is found, not only the first or the
 * longest one an alternation would pick. Each candidate is then judged against the
 * ORIGINAL text: a boundary is a character as written, so a symbol that folds to letters
 * (`™` is `tm`, `㎏` is `kg`) still ends a word, and a match that starts or ends in the
 * middle of one character's fold is inside a word. Matches are merged where they overlap
 * or touch, and masked in one pass.
 */
function buildMatcher(list: readonly string[]): { matcher: BlockedWordMatcher; nodes: number } {
  const root: TrieNode = { next: new Map() };
  let nodes = 1;
  const seen = new Set<string>();
  for (const entry of list) {
    const word = parseBlockedWord(entry);
    if (!word || seen.has(`${word.kind}:${word.core}`)) continue;
    seen.add(`${word.kind}:${word.core}`);
    let node = root;
    for (const unit of word.core) {
      let child = node.next.get(unit);
      if (!child) {
        child = { next: new Map() };
        node.next.set(unit, child);
        nodes += 1;
      }
      node = child;
    }
    (node.ends ??= []).push(word.kind);
  }
  if (seen.size === 0) return { matcher: NO_MATCHES, nodes };

  /** Every match in `text`, merged where they overlap or touch, as original offsets in order. */
  function matches(text: string): BlockedWordMatch[] {
    const folded = foldWithMap(text);
    const t = folded.text;
    const found: BlockedWordMatch[] = [];
    for (let a = 0; a < t.length; a++) {
      let node: TrieNode | undefined = root;
      for (let b = a; b < t.length; b++) {
        node = node.next.get(t[b]!);
        if (!node) break;
        if (!node.ends) continue;
        // A match that begins or ends partway through one character's fold is inside it.
        const startsClean = a === 0 || folded.from[a - 1] !== folded.from[a];
        const endsClean = b + 1 === t.length || folded.from[b + 1] !== folded.from[b];
        const start = folded.from[a]!;
        const end = widenEnd(text, folded.to[b]!);
        const openBefore = startsClean && !wordBefore(text, start);
        const after = codePointAt(text, end);
        const openAfter = endsClean && !(after !== undefined && WORD_CHAR.test(after));
        for (const kind of node.ends) {
          if ((kind === 'word' || kind === 'prefix') && !openBefore) continue;
          if ((kind === 'word' || kind === 'suffix') && !openAfter) continue;
          found.push({
            start: kind === 'suffix' ? wordStart(text, start) : start,
            end: kind === 'prefix' ? wordEnd(text, end) : end,
          });
        }
      }
    }
    found.sort((x, y) => x.start - y.start);
    const merged: BlockedWordMatch[] = [];
    for (const match of found) {
      const last = merged[merged.length - 1];
      if (last && match.start <= last.end) last.end = Math.max(last.end, match.end);
      else merged.push({ ...match });
    }
    return merged;
  }

  return {
    nodes,
    matcher: {
      size: seen.size,
      find(text) {
        return matches(text)[0] ?? null;
      },
      mask(text) {
        const found = matches(text);
        if (found.length === 0) return text;
        let out = '';
        let at = 0;
        for (const { start, end } of found) {
          out += text.slice(at, start) + BLOCKED_WORD_MASK;
          at = end;
        }
        return out + text.slice(at);
      },
    },
  };
}

/**
 * Compiled lists, by their content. A list is compiled once and reused for every render
 * that carries it: a sweep renders every room in a server, and each render would
 * otherwise build the same trie again. Least recently used out, bounded by the trie
 * nodes held rather than by a count of lists, because one full list is a thousand times
 * the size of a short one. A compile is cheap (a full list is a few milliseconds), so
 * a process serving more lists than fit only pays that again.
 */
const COMPILED = new Map<string, { matcher: BlockedWordMatcher; nodes: number }>();
const COMPILED_NODE_BUDGET = 200_000;
let compiledNodes = 0;

/**
 * The matcher for a list, compiled once per distinct list.
 *
 * Entries that cannot be used are skipped rather than refused, because a stored list
 * is whatever the settings blob holds and the writers are what refuse. An empty list,
 * or one with nothing usable, matches nothing. Keyed by `JSON.stringify`, which is
 * unambiguous whatever an entry holds.
 */
export function compileBlockedWords(list: readonly string[]): BlockedWordMatcher {
  if (list.length === 0) return NO_MATCHES;
  const key = JSON.stringify(list);
  const cached = COMPILED.get(key);
  if (cached) {
    COMPILED.delete(key);
    COMPILED.set(key, cached);
    return cached.matcher;
  }
  const built = buildMatcher(list);
  COMPILED.set(key, built);
  compiledNodes += built.nodes;
  while (compiledNodes > COMPILED_NODE_BUDGET && COMPILED.size > 1) {
    const oldest = COMPILED.keys().next().value!;
    compiledNodes -= COMPILED.get(oldest)!.nodes;
    COMPILED.delete(oldest);
  }
  return built.matcher;
}

/** The first match of any entry in `text`, or null. An empty list never matches. */
export function findBlocked(text: string, list: readonly string[]): BlockedWordMatch | null {
  return compileBlockedWords(list).find(text);
}

/** `text` with every match of any entry replaced by `***`. An empty list changes nothing. */
export function maskBlocked(text: string, list: readonly string[]): string {
  return compileBlockedWords(list).mask(text);
}

/**
 * `text` masked, trimmed and cut to `maxLength`, for text that has a length limit (a
 * channel name, a voice status).
 *
 * Masking comes first, because it can lengthen a short word (`ab` becomes `***`). When
 * that makes the text too long, the cut can end on a new whole word (`hello` cut to
 * `hel`), so the cut text is masked again. Masked text never matches again, so each
 * extra pass only happens when the cut removed something, and the bound is for
 * pathological input. A masked text is never empty, so a caller's empty-name fallback is
 * untouched.
 *
 * An empty list returns `text` exactly as it was, untrimmed and uncut.
 */
export function maskBlockedWithin(
  text: string,
  list: readonly string[],
  maxLength: number,
): string {
  if (list.length === 0) return text;
  const matcher = compileBlockedWords(list);
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    const masked = matcher.mask(out).trim();
    const cut = masked.length > maxLength ? masked.slice(0, maxLength) : masked;
    if (cut === masked) return cut;
    out = cut;
  }
  return out;
}

/**
 * The parts of a name template that are syntax: tokens (`@@owner@@`, `##`, `$0#`, `+#`),
 * a conditional's opening up to its `??`, the markers of conditionals, random picks,
 * plurals, resting and in-use names and string transforms (with a transform's modes),
 * and a named list. Everything between them is text that shows as it was typed.
 */
const TEMPLATE_SYNTAX =
  /@@[a-z_]+@@|\{\{[^{}]*?\?\?|\{\{|\}\}|\/\/|\[\[\s*list:[^\]]*\]\]|\[\[|\]\]|<<|>>|""[a-z0-9+ ]*:|""|__|\$0*#|\+#|##/gi;

/** A template split into the text a member typed and the syntax around it, in order. */
function templateParts(template: string): { text: string; literal: boolean }[] {
  const parts: { text: string; literal: boolean }[] = [];
  let at = 0;
  for (const match of template.matchAll(TEMPLATE_SYNTAX)) {
    if (match.index > at) parts.push({ text: template.slice(at, match.index), literal: true });
    parts.push({ text: match[0], literal: false });
    at = match.index + match[0].length;
  }
  if (at < template.length) parts.push({ text: template.slice(at), literal: true });
  return parts;
}

/**
 * Whether the text typed into a name template holds a blocked word, judged on its literal
 * text alone. Token and variable names are not typed words: blocking `game` must not
 * refuse `@@game_name@@`, and what a token renders is masked anyway.
 */
export function findBlockedInTemplate(template: string, list: readonly string[]): boolean {
  if (list.length === 0) return false;
  const matcher = compileBlockedWords(list);
  return templateParts(template).some((part) => part.literal && matcher.find(part.text) !== null);
}

/**
 * A template with the blocked words in its literal text masked and its syntax left as it
 * is, for a panel that quotes a template to somebody who may not have written it.
 */
export function maskBlockedInTemplate(template: string, list: readonly string[]): string {
  if (list.length === 0) return template;
  const matcher = compileBlockedWords(list);
  return templateParts(template)
    .map((part) => (part.literal ? matcher.mask(part.text) : part.text))
    .join('');
}
