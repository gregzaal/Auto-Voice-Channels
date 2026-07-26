import { FONT_MAPS, SMALL_CAPS_MAP } from './unicodeFonts.generated.js';

/**
 * String-transform modes for the legacy `""mode:text""` template wrapper, ported
 * from the legacy `functions.py` ops table (which dispatched to `translate.py` /
 * `utils.py`). Each mode takes the already token-substituted text and returns a
 * transformed copy; modes chain with `+` (e.g. `lower+scaps`).
 *
 * The font styles (`bold`, `italic`, … `mono`) and `scaps` use static maps in
 * `unicodeFonts.generated.ts`, generated from the SAME Python `unicodedata` the
 * legacy used — so output is byte-for-byte identical, including the legacy
 * "holes" (a char with no styled glyph passes through unchanged).
 */

/** Python `str.isupper`: at least one cased char, and all cased chars uppercase. */
function isUpper(s: string): boolean {
  return s !== s.toLowerCase() && s === s.toUpperCase();
}
function isLower(s: string): boolean {
  return s !== s.toUpperCase() && s === s.toLowerCase();
}

/** Legacy `utils.match_case`: cast `target` to the case of `source`. */
function matchCase(target: string, source: string): string {
  if (isUpper(source)) return target.toUpperCase();
  if (isLower(source)) return target.toLowerCase();
  return target;
}

/** Per-character table lookup; unmapped characters (incl. emoji) pass through. */
function mapChars(table: Record<string, string>, s: string): string {
  let out = '';
  for (const ch of s) out += table[ch] ?? ch;
  return out;
}

// --- pure-string modes (ported from utils.py) ------------------------------

/** Legacy `capitalize`: split on whitespace, capitalize each word, single-space join. */
function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Per-character case swap (`str.swapcase`); caseless characters untouched. */
function swapCase(s: string): string {
  let out = '';
  for (const c of s) {
    if (c.toLowerCase() === c.toUpperCase()) out += c;
    else out += c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
  }
  return out;
}

/** Legacy `full_strip`: trim and collapse runs of spaces to one. */
function fullStrip(s: string): string {
  return s.trim().replace(/ {2,}/g, ' ');
}

const SHORT_WORDS = new Set('a an and at by from in is of on or the to'.split(' '));
function removeShortWords(s: string): string {
  return s
    .split(' ')
    .filter((w) => !SHORT_WORDS.has(w.toLowerCase()))
    .join(' ');
}

function acronym(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
}

function firstNWords(s: string, n: number): string {
  return s.split(' ').slice(0, n).join(' ');
}

/**
 * Deterministic stand-in for the legacy `random_case`. The legacy reseeded from
 * the current hour, so a channel renamed itself hourly — incompatible with the
 * new engine's "render is stable → no rename churn" invariant. We instead derive
 * the per-character case from a hash of the text itself, so the same text always
 * yields the same mixed-case result (no churn) while still looking randomised.
 *
 * The per-character hash runs the FULL three-step avalanche finalizer (matching
 * `mixHash` in nameTemplate.ts). An earlier version stopped after two steps,
 * which left the low bit degenerate: it came out identical for every index, so
 * a whole word rendered in one case instead of a mix. The extra rounds diffuse
 * the index into the low bit, so the case now actually varies per character.
 */
function randomCase(s: string): string {
  let seed = 0;
  for (const c of s) seed = (seed + c.charCodeAt(0)) >>> 0;
  let out = '';
  let i = 0;
  for (const c of s) {
    let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    out += h & 1 ? c.toUpperCase() : c.toLowerCase();
    i++;
  }
  return out;
}

// --- usd (upside-down) ------------------------------------------------------
// The legacy delegated to the optional pip `upsidedown` package (and no-op'd
// when it wasn't installed), so there's no canonical output to match. This is a
// standard flip map + string reversal.
const FLIP: Record<string, string> = {
  a: 'ɐ',
  b: 'q',
  c: 'ɔ',
  d: 'p',
  e: 'ǝ',
  f: 'ɟ',
  g: 'ƃ',
  h: 'ɥ',
  i: 'ᴉ',
  j: 'ɾ',
  k: 'ʞ',
  l: 'l',
  m: 'ɯ',
  n: 'u',
  o: 'o',
  p: 'd',
  q: 'b',
  r: 'ɹ',
  s: 's',
  t: 'ʇ',
  u: 'n',
  v: 'ʌ',
  w: 'ʍ',
  x: 'x',
  y: 'ʎ',
  z: 'z',
  A: '∀',
  B: 'ᗺ',
  C: 'Ɔ',
  D: 'ᗡ',
  E: 'Ǝ',
  F: 'Ⅎ',
  G: '⅁',
  H: 'H',
  I: 'I',
  J: 'ſ',
  K: 'ʞ',
  L: '˥',
  M: 'W',
  N: 'N',
  O: 'O',
  P: 'Ԁ',
  Q: 'Ò',
  R: 'ᴚ',
  S: 'S',
  T: '⊥',
  U: '∩',
  V: 'Λ',
  W: 'M',
  X: 'X',
  Y: '⅄',
  Z: 'Z',
  '0': '0',
  '1': 'Ɩ',
  '2': 'ᄅ',
  '3': 'Ɛ',
  '4': 'ㄣ',
  '5': 'ϛ',
  '6': '9',
  '7': 'ㄥ',
  '8': '8',
  '9': '6',
  '.': '˙',
  ',': "'",
  "'": ',',
  '"': ',,',
  '`': ',',
  '?': '¿',
  '!': '¡',
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '&': '⅋',
  _: '‾',
};
function upsideDown(s: string): string {
  return [...s]
    .map((c) => FLIP[c] ?? c)
    .reverse()
    .join('');
}

// --- uwu (ported verbatim from translate.py) --------------------------------

/** Word-level Japanese-ish substitutions, applied AFTER the r/l→w pass. */
const UWU_TRANS: [string[], string][] = [
  [['wove'], 'wuv'],
  [['wewcome'], 'youkoso'],
  [['is that so'], 'naruhodo'],
  [['thats why', "that's why"], 'dakara'],
  [['what'], 'nani'],
  [['when'], 'itsu'],
  [['the'], 'za'],
  [['wowwd'], 'warudo'],
  [['good morning'], 'ohayou'],
  [['good aftewnoon'], 'konnichiwa'],
  [['good night'], 'oyasumi'],
  [['thank you', 'thanks', 'tnx', 'ty'], 'arigatou'],
  [['bye bye', 'bye', 'goodbye'], 'sayonara'],
  [['sowwy', 'apowogies'], 'gomenasai'],
  [['my bad'], 'warukatta'],
  [['excuse me'], 'sumimasen'],
  [['wife'], 'waifu'],
  [['husband'], 'hasubando'],
  [['cute'], 'kawaii'],
  [['nice'], 'suteki'],
  [['bad'], 'warui'],
  [['coow'], 'sugoi'],
  [['handsome'], 'kakkoi'],
  [['idiot'], 'baka'],
  [['dumb', 'dumbass'], 'aho'],
  [['undewstand'], 'wakarimasu'],
  [['undewstood'], 'wakatta'],
  [['dead'], 'deddo'],
  [['shut up', 'shut the fuck up', 'stfu', 'shutup', 'shattap'], 'urusai'],
  [['fuck'], 'fack'],
  [['fucked'], 'facked'],
  [['fucking'], 'facking'],
  [['this is bad', 'oh no', "that's bad", 'thats bad'], 'yabai'],
  [['name'], 'namae'],
  [['sistew'], 'oneesan'],
  [['bwothew'], 'oniichan'],
  [['wittwe sistew'], 'imouto'],
  [['wittwe bwothew'], 'otouto'],
  [['fwiends'], 'fwends'],
  [['fwiend'], 'fwend'],
  [['awwy', 'awwies', 'comnrade', 'comrades'], 'nakama'],
  [['enemy', 'enemies', 'nemesis'], 'teki'],
  [['see you', 'see ya'], 'mata ne'],
  [['good wuck', 'goodwuck', 'do your best', 'you got this'], 'ganbatte'],
  [['dog'], 'inu'],
  [['cat'], 'neko'],
  [['with'], 'wid'],
  [['without'], 'widout'],
];

const UWU_TRANS_MAP = new Map<string, string>();
for (const [words, repl] of UWU_TRANS) for (const w of words) UWU_TRANS_MAP.set(w, repl);

/** Ordered substring replacements, applied last (matches the legacy dict order). */
const UWU_REPLACEMENTS: [string, string][] = [
  ['no', 'nyo'],
  ['mo', 'myo'],
  ['No', 'Nyo'],
  ['Mo', 'Myo'],
  ['NO', 'NYO'],
  ['MO', 'MYO'],
  ['hu', 'hoo'],
  ['Hu', 'Hoo'],
  ['HU', 'HOO'],
  ['th', 'd'],
  ['Th', 'D'],
  ['TH', 'D'],
];

function uwu(s: string): string {
  // 1. r/l → w, preserving case.
  let out = '';
  for (const c of s)
    out += c.toLowerCase() === 'r' || c.toLowerCase() === 'l' ? matchCase('w', c) : c;
  // 2. whole-word substitutions (legacy splits on a single space, per word).
  out = out
    .split(' ')
    .map((w) => {
      const repl = UWU_TRANS_MAP.get(w.toLowerCase());
      return repl !== undefined ? matchCase(repl, w) : w;
    })
    .join(' ');
  // 3. ordered substring replacements (all occurrences).
  for (const [from, to] of UWU_REPLACEMENTS) out = out.replaceAll(from, to);
  return out;
}

/**
 * Applies one legacy transform mode to `s`. Unrecognised modes return `s`
 * unchanged (matching the legacy "mode not in ops" path). The full set:
 * `caps`/`upper`, `lower`, `title`, `swap`, `scaps`, `spaces`, `acro`,
 * `remshort`, `uwu`, `usd`, `rand`, the 13 math-font styles in
 * {@link FONT_MAPS}, and `<N>w` (first N words).
 */
/**
 * The named modes {@link applyMode} acts on. Kept beside the switch so the two
 * can't drift (a unit test asserts every entry actually transforms), and read by
 * the template assistant's validator — an unknown mode is silently a no-op, so
 * a bare render check would never notice the model inventing one
 * (`plans/assisted_templates.md` §9).
 */
export const STYLE_MODES: readonly string[] = [
  'caps',
  'upper',
  'lower',
  'title',
  'swap',
  'scaps',
  'spaces',
  'acro',
  'remshort',
  'uwu',
  'usd',
  'rand',
  ...Object.keys(FONT_MAPS),
];

/** Whether `applyMode` recognises `mode` (including the `<N>w` first-N-words form). */
export function isKnownStyleMode(mode: string): boolean {
  if (STYLE_MODES.includes(mode)) return true;
  if (mode.length <= 3 && mode.endsWith('w')) {
    return Number.isFinite(Number.parseInt(mode.slice(0, -1), 10));
  }
  return false;
}

export function applyMode(mode: string, s: string): string {
  switch (mode) {
    case 'caps':
    case 'upper':
      return s.toUpperCase();
    case 'lower':
      return s.toLowerCase();
    case 'title':
      return titleCase(s);
    case 'swap':
      return swapCase(s);
    case 'scaps':
      return mapChars(SMALL_CAPS_MAP, s);
    case 'spaces':
      return fullStrip(s);
    case 'acro':
      return acronym(s);
    case 'remshort':
      return removeShortWords(s);
    case 'uwu':
      return uwu(s);
    case 'usd':
      return upsideDown(s);
    case 'rand':
      return randomCase(s);
  }
  const font = FONT_MAPS[mode];
  if (font) return mapChars(font, s);
  // `<N>w` → first N words (legacy: ends with 'w', total length <= 3).
  if (mode.length <= 3 && mode.endsWith('w')) {
    const n = Number.parseInt(mode.slice(0, -1), 10);
    if (Number.isFinite(n)) return firstNWords(s, n);
  }
  return s;
}
