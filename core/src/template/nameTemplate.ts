import { applyMode } from './stringTransforms.js';
import type { VoiceMember } from './types.js';

/**
 * Channel-name templating, ported from the legacy bot's `rename_channel` /
 * `get_channel_games` / `get_game_name` / `get_alias` / `get_party_info` /
 * `eval_expression`. Covers the index tokens, game name, member counts, the
 * `[[random]]` picker (resolved once per channel via a stored seed),
 * `@@nato@@`, the rich-presence party/stream tokens, `<<singular/plural>>`
 * (member / non-owner / party-size selectors), and `{{conditional}}`
 * expressions.
 *
 * Tier gating from the legacy bot is gone (single standard bot), so every token
 * is available to every guild.
 *
 * Presence is consumed lazily: game/party detection only runs when the template
 * needs it (see {@link renderChannelName}).
 */

/**
 * The default channel-name template. Picks a stable random emoji (`@@random_emoji@@`)
 * + word per channel (resolved once, so it never triggers later renames) around
 * the owner's name — deliberately free of `##`/`@@game_name@@` so the default
 * experience generates almost no renames over a channel's life.
 */
export const DEFAULT_CHANNEL_NAME_TEMPLATE =
  "@@random_emoji@@ @@owner@@'s [[den/gang/crew/platoon/cave/room/party/hangout/lounge/lair/squad/club/nest/base/zone/spot]]";

/**
 * The default voice-channel-status template: blank when nobody's playing, and
 * "Playing <game>" once a game is detected (the `PLAYING` conditional has no
 * `// false` branch, so it renders empty — clearing the status — when idle).
 */
export const DEFAULT_STATUS_TEMPLATE = '{{PLAYING ?? Playing @@game_name@@}}';

/** Discord's max length for a voice channel status. */
export const MAX_STATUS_LENGTH = 500;

/** Built-in game-name aliases (ported from the legacy `std_aliases`). */
const STD_ALIASES: Record<string, string> = {
  'Apex Legends': 'Apex',
  'League of Legends': 'LoL',
  'Counter-Strike: Global Offensive': 'CS:GO',
  'Team Fortress 2': 'TF2',
  'Grand Theft Auto V': 'GTAV',
  "PLAYERUNKNOWN'S BATTLEGROUNDS": 'PUBG',
  'MONSTER HUNTER: WORLD': 'MH:W',
  'The Elder Scrolls V: Skyrim': 'Skyrim',
  'The Elder Scrolls V: Skyrim Special Edition': 'Skyrim',
  'The Elder Scrolls Online': 'ESO',
  "Tom Clancy's Rainbow Six Siege": 'Rainbow Six Siege',
  'FINAL FANTASY XIV': 'FFXIV',
  'FINAL FANTASY XIV Online': 'FFXIV',
  'Warhammer End Times Vermintide': 'Vermintide 1',
  'Warhammer: Vermintide 2': 'Vermintide 2',
  'World of Warcraft Classic': 'WoW Classic',
  'World of Warcraft': 'WoW',
};

export function getAlias(name: string, aliases: Record<string, string> = {}): string {
  // Own-property checks, never `in`: the name comes from a member's Rich
  // Presence, so someone playing a game called "constructor" or "toString"
  // would otherwise resolve up the prototype chain and get the FUNCTION back,
  // naming their room "function Object() { [native code] }".
  if (Object.prototype.hasOwnProperty.call(aliases, name)) return aliases[name]!;
  if (Object.prototype.hasOwnProperty.call(STD_ALIASES, name)) return STD_ALIASES[name]!;
  return name;
}

export interface GameNameOptions {
  /** Per-guild aliases (override the built-ins). */
  aliases?: Record<string, string>;
  /** The "no specific game" label (legacy `settings.general`). */
  general?: string;
}

/**
 * The "playing" game names for a member. Prefers the structured `activities`
 * (the source of truth when present, keeping game detection consistent with the
 * party tokens) and falls back to the flat `playing` list otherwise.
 */
function playingNames(m: VoiceMember): string[] {
  if (m.activities) return m.activities.filter((a) => a.kind === 'playing').map((a) => a.name);
  return m.playing;
}

/**
 * Determines the representative game(s) for a channel, replicating the legacy
 * tie-breaking: the most-played game wins; ties of two are joined; three or more
 * distinct ties fall back to "General".
 */
export function getChannelGames(members: VoiceMember[], general = 'General'): string[] {
  const counts = new Map<string, number>();
  const sorted = [...members]
    .filter((m) => !m.bot)
    .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  for (const m of sorted) {
    for (const gname of playingNames(m)) {
      if (gname === 'Custom Status') continue;
      counts.set(gname, (counts.get(gname) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return [general];

  const games = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [biggest, mostPlayers] = games[0]!;
  const gnames = [biggest];
  for (const [gn, gp] of games.slice(1)) {
    if (gp === mostPlayers) gnames.push(gn);
  }
  if (gnames.length > 2) return [general];
  return gnames;
}

/** Resolves a single display string for the channel's game(s). */
export function getGameName(members: VoiceMember[], options: GameNameOptions = {}): string {
  const general = options.general ?? 'General';
  const games = getChannelGames(members, general);
  if (games.length === 1 && games[0] === general) return general;
  const aliased: string[] = [];
  for (const g of games) {
    const a = getAlias(g, options.aliases ?? {});
    if (!aliased.includes(a)) aliased.push(a);
  }
  return aliased.join(', ');
}

const ROMAN: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function toRoman(n: number): string {
  if (n <= 0) return String(n);
  let out = '';
  let rem = n;
  for (const [value, sym] of ROMAN) {
    while (rem >= value) {
      out += sym;
      rem -= value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// [[random]] — picked once per channel from a stored seed (never re-rolled)
// ---------------------------------------------------------------------------

/** Deterministic 32-bit mix of two ints, for stable per-channel random picks. */
function mixHash(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Resolves every `[[a/b/c]]` group to a single option, chosen deterministically
 * from `seed` + the group's ordinal. Because the seed is fixed per channel (see
 * {@link RenderContext.seed}), a channel always renders the same pick — so the
 * random default never causes a rename. Groups are processed left-to-right; a
 * `[[…]]` with no `/` is left untouched (matching the legacy delimiter check).
 */
export function resolveRandom(template: string, seed: number): string {
  let name = template;
  let group = 0;
  // Bounded to avoid any pathological loop on malformed input.
  for (let guard = 0; guard < 50; guard++) {
    const open = name.indexOf('[[');
    if (open === -1) break;
    const close = name.indexOf(']]', open + 2);
    if (close === -1) break;
    const inner = name.slice(open + 2, close);
    if (!inner.includes('/')) break;
    const options = inner.split('/');
    const choice = options[mixHash(seed, group) % options.length] ?? '';
    name = name.slice(0, open) + choice + name.slice(close + 2);
    group++;
  }
  return name;
}

/** The built-in pool for `@@random_emoji@@` (and the legacy default template). */
export const RANDOM_EMOJIS = [
  '😸',
  '🙀',
  '🚀',
  '☕',
  '🍆',
  '🍌',
  '🍕',
  '🐍',
  '🐗',
  '🐙',
  '🐝',
  '🐞',
  '🐭',
  '🐶',
  '👻',
  '👽',
  '👾',
  '💀',
  '🔥',
  '🔫',
  '🐀',
  '🐁',
  '🐆',
  '🐇',
  '🐋',
  '🐉',
  '🐓',
  '🦊',
  '🐺',
  '🦁',
  '🐯',
  '🦄',
  '🐲',
  '🦅',
  '🦉',
  '🐢',
  '🦖',
];

/**
 * Picks a `@@random_emoji@@` for a channel — stable per channel via the seed (so
 * it never causes a rename), using a distinct salt so it's independent of any
 * `[[…]]` random groups in the same template.
 */
export function pickRandomEmoji(seed: number): string {
  return RANDOM_EMOJIS[mixHash(seed, 0x6d6f_6a69) % RANDOM_EMOJIS.length]!;
}

// ---------------------------------------------------------------------------
// @@nato@@ — NATO phonetic word by channel number (wraps past 26)
// ---------------------------------------------------------------------------

const NATO = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliett',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
  'Sierra',
  'Tango',
  'Uniform',
  'Victor',
  'Whiskey',
  'X Ray',
  'Yankee',
  'Zulu',
];

/** NATO word for a 0-based channel index; past 26 it appends a cycle number. */
export function natoWord(index: number): string {
  if (index < 0) return '?';
  if (index < NATO.length) return NATO[index]!;
  return `${NATO[index % NATO.length]} ${Math.ceil((index + 1) / NATO.length)}`;
}

// ---------------------------------------------------------------------------
// Rich-presence party info — @@num_playing@@ / @@party_size@@ / state / details
// ---------------------------------------------------------------------------

export interface PartyInfo {
  state: string;
  details: string;
  rich: boolean;
  numPlaying: string;
  size: string;
}

/**
 * Aggregates rich-presence party info across the members playing `gameName`,
 * ported from the legacy `get_party_info`: it groups by party id (synthesizing
 * one from size/state/details when Discord doesn't supply it), picks the biggest
 * party, and reports its current/max size, state, and details.
 */
export function getPartyInfo(
  members: VoiceMember[],
  gameName: string,
  aliases: Record<string, string> = {},
  userLimit = 0,
): PartyInfo {
  const counts = new Map<string, number>();
  const states = new Map<string, string>();
  const details = new Map<string, string>();
  const numPlaying = new Map<string, string>();
  const sizes = new Map<string, string>();

  for (const m of members) {
    if (m.bot) continue;
    const act = (m.activities ?? []).find(
      (a) => a.kind !== 'other' && getAlias(a.name, aliases) === gameName,
    );
    if (!act) continue;

    let pid = act.party?.id ?? '';
    if (!pid) {
      pid = gameName;
      if (act.party?.size) pid += act.party.size.join('/');
      if (act.state) pid += act.state;
      if (act.details) pid += act.details;
    }
    if (act.state) states.set(pid, act.state);
    if (act.details) details.set(pid, act.details);
    if (act.party?.size) {
      numPlaying.set(pid, String(act.party.size[0]));
      sizes.set(pid, String(act.party.size[1] ?? 0));
    }
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }

  let bestPid: string | undefined;
  let best = 0;
  for (const [pid, n] of counts) {
    if (n > best) {
      best = n;
      bestPid = pid;
    }
  }

  const info: PartyInfo = { state: '', details: '', rich: false, numPlaying: '0', size: '0' };
  if (bestPid !== undefined) {
    info.state = states.get(bestPid) ?? '';
    info.details = details.get(bestPid) ?? '';
    info.rich = states.has(bestPid) || details.has(bestPid);
    info.numPlaying = numPlaying.get(bestPid) ?? String(best);
    info.size = sizes.get(bestPid) ?? (userLimit ? String(userLimit) : '0');
  }
  return info;
}

// ---------------------------------------------------------------------------
// <<singular/plural>>
// ---------------------------------------------------------------------------

/**
 * Resolves `<<singular/plural>>` (count = total members), `<<singular\\plural>>`
 * (count = members excluding the creator), and `<<singular|plural>>` (count =
 * players in the channel's biggest rich-presence party, `@@num_playing@@`): the
 * singular form when the count is exactly 1, else the plural.
 *
 * Processed INNERMOST-first (first `>>`, then the nearest `<<` before it) so that
 * NESTED groups work — e.g. `<<a/<<b\\c>>>>` gives a 3-way select. The legacy bot
 * (and an earlier version here) paired the first `<<` with the first `>>`, which
 * mis-parsed any nesting: it matched the outer `<<` to the inner `>>`, resolved
 * the wrong span, and left a dangling `>>`. Mirrors {@link resolveConditionals}.
 */
export function resolveSingularPlural(
  template: string,
  numMembers: number,
  numOthers: number,
  numPlaying: number,
): string {
  let name = template;
  for (let guard = 0; guard < 50; guard++) {
    const close = name.indexOf('>>');
    if (close === -1) break;
    const open = name.lastIndexOf('<<', close);
    if (open === -1) break;
    const inner = name.slice(open + 2, close);
    let parts: string[] | undefined;
    let count: number | undefined;
    if ((inner.match(/\//g) ?? []).length === 1) {
      parts = inner.split('/');
      count = numMembers;
    } else if ((inner.match(/\\/g) ?? []).length === 1) {
      parts = inner.split('\\');
      count = numOthers;
    } else if ((inner.match(/\|/g) ?? []).length === 1) {
      parts = inner.split('|');
      count = numPlaying;
    }
    if (!parts || count === undefined) break;
    const choice = count === 1 ? parts[0]! : parts[1]!;
    name = name.slice(0, open) + choice + name.slice(close + 2);
  }
  return name;
}

// ---------------------------------------------------------------------------
// __empty/occupied__ — resting vs in-use name for adopted standalone channels
// ---------------------------------------------------------------------------

/**
 * Resolves `__empty/occupied__` groups: the first branch when the channel has no
 * non-bot members, the second when it's occupied. Used by adopted standalone
 * channels (`/template` on any voice channel) so they show a resting name when
 * idle and an in-use name once someone joins. Mirrors the other block resolvers
 * (left-to-right, requires a `/`); splits on the FIRST `/` only, so the occupied
 * branch may itself contain `/`.
 */
export function resolveEmptyOccupied(template: string, isEmpty: boolean): string {
  let name = template;
  for (let guard = 0; guard < 50; guard++) {
    const open = name.indexOf('__');
    if (open === -1) break;
    const close = name.indexOf('__', open + 2);
    if (close === -1) break;
    const inner = name.slice(open + 2, close);
    const slash = inner.indexOf('/');
    if (slash === -1) break;
    const choice = isEmpty ? inner.slice(0, slash) : inner.slice(slash + 1);
    name = name.slice(0, open) + choice + name.slice(close + 2);
  }
  return name;
}

// ---------------------------------------------------------------------------
// {{conditional}} expressions
// ---------------------------------------------------------------------------

/** Variables available to `{{…}}` conditionals. */
export interface ExpressionVars {
  ROLE: string[];
  LIVE: boolean;
  LIVE_DISCORD: boolean;
  LIVE_EXTERNAL: boolean;
  GAME: string;
  /** True when a real game is detected (not the "no game" fallback). */
  PLAYING: boolean;
  PLAYERS: number;
  MAX: number;
  RICH: boolean;
  /**
   * Room-scoped twins of the owner-scoped variables above. The unprefixed ones
   * ask about the OWNER and are kept exactly as they were, because changing
   * them would silently alter every deployed template that uses them; `ANY_`
   * asks about anyone in the room, and `MEMBER` asks whether one specific
   * person is in it (`plans/name-tokens.md` §5.4).
   */
  ANY_LIVE: boolean;
  ANY_ROLE: string[];
  MEMBER: string[];
  /**
   * True only when the room has a limit AND is at or over it. Unlimited is
   * never full, which is the whole reason this is a variable rather than
   * `{{@@num@@>=@@limit@@}}`: with no limit that comparison reads `3>=0` and
   * reports a full room. Nothing else here may be a variable that a comparison
   * of two tokens already expresses.
   */
  FULL: boolean;
  /**
   * The room is not public. Deliberately "not public" rather than "locked", so
   * it stays correct if the three-state privacy model in
   * `plans/feature-parity.md` §3.1 ships and `{{HIDDEN}}` arrives as a
   * narrowing. Always false for an adopted standalone channel, which has no
   * privacy model.
   */
  PRIVATE: boolean;
}

/** What a resolved conditional operand can be. */
type ExpressionValue = ExpressionVars[keyof ExpressionVars];

/**
 * The `{{…}}` variable names, as a value. Exhaustiveness is enforced by the
 * type, not by a test: adding a field to {@link ExpressionVars} without listing
 * it here (or listing one that doesn't exist) fails to compile. The template
 * assistant's validator reads this to reject an invented variable, which would
 * otherwise render as a silently-false condition (`plans/assisted_templates.md` §9).
 */
const CONDITION_VARIABLE_SET: Record<keyof ExpressionVars, true> = {
  ROLE: true,
  LIVE: true,
  LIVE_DISCORD: true,
  LIVE_EXTERNAL: true,
  GAME: true,
  PLAYING: true,
  PLAYERS: true,
  MAX: true,
  RICH: true,
  ANY_LIVE: true,
  ANY_ROLE: true,
  MEMBER: true,
  FULL: true,
  PRIVATE: true,
};

export const CONDITION_VARIABLES = Object.keys(CONDITION_VARIABLE_SET) as (keyof ExpressionVars)[];

/**
 * Every `@@…@@` token the renderer substitutes. `@@creator@@` is `@@owner@@`'s
 * older name, kept working forever so a template written before the rename
 * never breaks; new templates (including the built-in default, above) should
 * use `@@owner@@`.
 */
export const AT_TOKENS: readonly string[] = [
  '@@nato@@',
  '@@game_name@@',
  '@@num@@',
  '@@num_others@@',
  '@@num_playing@@',
  '@@num_live@@',
  '@@party_size@@',
  '@@party_state@@',
  '@@party_details@@',
  '@@owner@@',
  '@@creator@@',
  '@@stream_name@@',
  '@@random_emoji@@',
  '@@limit@@',
  '@@slots@@',
];

/**
 * The tokens substituted at step 9, AFTER conditionals resolve.
 *
 * They can never be conditional operands, and the reason is different from the
 * one that rules out `##`: at the moment a condition is evaluated these are
 * still their own literal text, so the test never matches whatever the value
 * would have been. The ordering is deliberate. All four carry free text written
 * by a member or by a game, and substituting them earlier would let a nickname
 * of `a ?? b // c` split the very conditional it sits inside, which is the
 * defect `collapseMarkers` exists to stop for the party tokens.
 *
 * `GAME` is the supported way to test the first of them: a VARIABLE carries the
 * value into the comparison without putting it into the template string, so it
 * is safe by construction. The other three have no such counterpart
 * (`plans/name-tokens.md` §5.1).
 */
/**
 * The tokens that can be used as a `{{…}}` conditional operand, i.e. those that
 * are substituted before conditionals resolve AND substitute a bare integer.
 *
 * Both halves are required and the second is the one that surprises people:
 * `@@nato@@` and `@@random_emoji@@` substitute early but produce `Alpha` and an
 * emoji, and `##` produces `#5` while `+#` produces `V`. None of those parse, so
 * they take the false branch exactly like an unknown variable would. Exported
 * because the assistant's validator lints against it and the system prompt is
 * tested against it (`plans/name-tokens.md` §5.1).
 */
export const LATE_TOKENS: readonly string[] = [
  '@@game_name@@',
  '@@owner@@',
  '@@creator@@',
  '@@stream_name@@',
];

export const OPERAND_TOKENS: readonly string[] = [
  '@@num@@',
  '@@num_others@@',
  '@@num_playing@@',
  '@@num_live@@',
  '@@party_size@@',
  '@@limit@@',
  '@@slots@@',
  '$#',
  '$0#',
  '$00#',
  '$000#',
  '$0000#',
];

/** The channel-number tokens (all meaningless on a standalone channel, where they render `?`). */
export const NUMBER_TOKENS: readonly string[] = [
  '##',
  '$#',
  '$0#',
  '$00#',
  '$000#',
  '$0000#',
  '+#',
];

// ---------------------------------------------------------------------------
// Member-controlled text must not eat the engine's delimiters
// ---------------------------------------------------------------------------

/**
 * Markers still live when a value is substituted at step 6, i.e. before
 * conditionals, `<<…>>` and `""…""` resolve. Rich presence is written by a
 * MEMBER, so without this a party's details line reaching `@@party_details@@`
 * could split a conditional in half (`{{RICH ?? [@@party_details@@] // no}}`
 * with details `x ?? EVIL // y` rendered `[x ?? EVIL`), or introduce a
 * construct the admin never wrote: a whole `{{…}}` condition, a `""upper:…""`
 * transform, a `<<one/many>>` group, or another `@@token@@`. All five were
 * reproduced against the running engine (`plans/name-tokens.md` §5.2).
 *
 * `[[…]]` and `__…__` resolve at steps 1 and 0, before any substitution, so
 * they are unreachable and deliberately absent.
 */
const EARLY_MARKER_CHARS = ['{', '}', '?', '/', '<', '>', '"', '@'] as const;

/** By step 9 only the `""mode:text""` wrapper is still unresolved. */
const LATE_MARKER_CHARS = ['"'] as const;

const MARKER_RUNS = new Map<string, RegExp>(
  [...new Set([...EARLY_MARKER_CHARS, ...LATE_MARKER_CHARS])].map((c) => [
    c,
    new RegExp(`${c.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}{2,}`, 'g'),
  ]),
);

/**
 * Collapses every run of a marker character down to a single one, so a
 * substituted value can never form a live delimiter.
 *
 * **Run-based, not pair-based, and that is the whole correctness argument.**
 * Replacing the doubled form once is bypassable: `????` collapses to `??`,
 * `{{{{` to `{{`, `""""` to `""` — each one re-creating the marker it just
 * removed. Collapsing a RUN of two or more to exactly one is idempotent by
 * construction, and it cannot manufacture a marker, because every delimiter
 * here is a doubled SAME character and collapsing never brings two unlike
 * characters together.
 *
 * Collapsing rather than deleting keeps the text readable: a party details line
 * of `Co-op // Salvage` becomes `Co-op / Salvage`.
 */
function collapseMarkers(text: string, chars: readonly string[]): string {
  let out = text;
  for (const c of chars) out = out.replace(MARKER_RUNS.get(c)!, c);
  return out;
}

function splitFirst(text: string, sep: string): [string, string] {
  const i = text.indexOf(sep);
  if (i === -1) return [text, ''];
  return [text.slice(0, i), text.slice(i + sep.length)];
}

const COMPARATORS: [string, (a: number, b: number) => boolean][] = [
  ['<=', (a, b) => a <= b],
  ['>=', (a, b) => a >= b],
  ['<', (a, b) => a < b],
  ['>', (a, b) => a > b],
];

/**
 * Evaluates one `{{condition ?? true // false}}` expression (the `// false`
 * branch is optional), ported from the legacy `eval_expression`. Supports the
 * comparison operators `<= >= < > != =` and `:` (contains / role membership)
 * over the variables in {@link ExpressionVars}. An unknown variable yields the
 * false branch.
 */
/**
 * Resolves one side of a condition to a value: a known variable, else a bare
 * integer literal, else nothing.
 *
 * **Own-property, never `in`.** `vars` is an object literal, so `'toString' in
 * vars` is true and yields the FUNCTION, which is truthy: `{{constructor ?? Y
 * // N}}`, `{{toString …}}`, `{{valueOf …}}`, `{{hasOwnProperty …}}` and every
 * other `Object.prototype` member rendered the TRUE branch. Same trap
 * {@link getAlias} documents from the other side.
 *
 * **Integers only, never bare strings.** Treating an unknown NAME as a string
 * literal would flip existing behaviour: `{{PLAYERZ!=5 ?? yes // no}}` renders
 * `no` today and would render `yes`, because the string `PLAYERZ` genuinely is
 * not `5`. A typo'd variable has to keep failing safe
 * (`plans/assisted_templates.md` §9 leans on it).
 */
function operandValue(raw: string, vars: ExpressionVars): ExpressionValue | undefined {
  const name = raw.trim();
  if (Object.prototype.hasOwnProperty.call(vars, name)) {
    return vars[name as keyof ExpressionVars];
  }
  if (/^-?\d+$/.test(name)) return Number(name);
  return undefined;
}

export function evalExpression(text: string, vars: ExpressionVars): string {
  if (!text.includes('??')) return text;
  const [condRaw, rest] = splitFirst(text, '??');
  let truthy = rest;
  let falsy = '';
  if (rest.includes('//')) [truthy, falsy] = splitFirst(rest, '//');

  let name = condRaw.trim();
  let op: string | undefined;
  let rhs = '';
  for (const sym of ['<=', '>=', '<', '>', '!=', '=', ':']) {
    if (condRaw.includes(sym)) {
      const [l, r] = splitFirst(condRaw, sym);
      name = l.trim();
      rhs = r.trim();
      op = sym;
      break;
    }
  }

  // The LEFT side resolves to a variable or an integer. Tokens have already
  // been substituted by the time this runs (step 5 vs step 7), so
  // `{{@@num@@>=2}}` genuinely arrives as `3>=2` and now compares instead of
  // silently taking the false branch (`plans/name-tokens.md` §5.1).
  const value = operandValue(name, vars);
  if (value === undefined) return falsy;

  let result: boolean;
  if (!op) {
    result = Array.isArray(value) ? value.length > 0 : Boolean(value);
  } else if (op === ':') {
    // `:` keeps the RAW right side, or `{{ROLE:998877}}` and `{{GAME:Halo}}`
    // stop working.
    result = Array.isArray(value) ? value.includes(rhs) : String(value).includes(rhs);
  } else if (op === '=' || op === '!=') {
    // Unchanged, deliberately: resolving the right side here would invent a
    // rule for `{{GAME=PLAYERS}}` for no gain, since a numeric literal already
    // compares numerically.
    const equal =
      typeof value === 'number' && /^-?\d+$/.test(rhs)
        ? value === Number(rhs)
        : String(value) === rhs;
    result = op === '=' ? equal : !equal;
  } else {
    // Only the ordering comparators resolve BOTH sides, so `{{PLAYERS>=MAX}}`
    // and `{{@@num@@>=@@limit@@}}` work. Both must land on numbers; anything
    // else is false, exactly as a non-numeric right side is today.
    const other = operandValue(rhs, vars);
    const cmp = COMPARATORS.find(([s]) => s === op)![1];
    result = typeof value === 'number' && typeof other === 'number' ? cmp(value, other) : false;
  }
  return result ? truthy : falsy;
}

/** Resolves all `{{…}}` expressions, innermost-first to support nesting. */
export function resolveConditionals(template: string, vars: ExpressionVars): string {
  let name = template;
  for (let guard = 0; guard < 50; guard++) {
    const close = name.indexOf('}}');
    if (close === -1) break;
    const open = name.lastIndexOf('{{', close);
    if (open === -1) break;
    const inner = name.slice(open + 2, close);
    name = name.slice(0, open) + evalExpression(inner, vars) + name.slice(close + 2);
  }
  return name;
}

/** Builds the conditional variables from the channel's owner + party state. */
function buildExpressionVars(
  ctx: RenderContext,
  gameName: string,
  party: PartyInfo,
): ExpressionVars {
  const creator = ctx.creator;
  const liveExternal = (creator?.activities ?? []).some((a) => a.kind === 'streaming');
  const liveDiscord = creator?.selfStreaming ?? false;
  const nonBot = ctx.members.filter((m) => !m.bot);
  const limit = ctx.userLimit ?? 0;
  return {
    ROLE: creator?.roleIds ?? [],
    LIVE: liveExternal || liveDiscord,
    LIVE_DISCORD: liveDiscord,
    LIVE_EXTERNAL: liveExternal,
    GAME: gameName,
    // A real game is detected when the resolved name isn't the "no game" label.
    PLAYING: gameName !== (ctx.general ?? 'General'),
    PLAYERS: Number.parseInt(party.numPlaying, 10) || 0,
    MAX: Number.parseInt(party.size, 10) || 0,
    RICH: party.rich,
    ANY_LIVE: nonBot.some(isLive),
    // Flattened and de-duplicated so the existing `:` (includes) operator
    // covers `{{ANY_ROLE:id}}` with no new operator code, mirroring `ROLE`.
    ANY_ROLE: [...new Set(nonBot.flatMap((m) => m.roleIds ?? []))],
    MEMBER: nonBot.map((m) => m.id),
    // Unlimited is never full, and an unknown limit reads as unlimited, so this
    // fails open: it never claims a room is full on missing information.
    FULL: limit >= 1 && nonBot.length >= limit,
    PRIVATE: ctx.isPrivate ?? false,
  };
}

/** Whether a member is streaming, either Discord Go Live or an external site. */
function isLive(m: VoiceMember): boolean {
  return (m.selfStreaming ?? false) || (m.activities ?? []).some((a) => a.kind === 'streaming');
}

/** The stream title from the owner's streaming activity, or `''`. */
function streamName(ctx: RenderContext): string {
  return (ctx.creator?.activities ?? []).find((a) => a.kind === 'streaming')?.name ?? '';
}

// ---------------------------------------------------------------------------
// ""mode:text"" — string transforms applied to already-substituted text
// ---------------------------------------------------------------------------

/**
 * Resolves the legacy `""mode:text""` string-transform wrapper, ported from the
 * `while '""' in cname …` block of the legacy `rename_channel`. Each `""…""` pair
 * of the form `mode:text` has its (already token-substituted) text transformed by
 * the `+`-chained modes — e.g. `""lower+scaps:Foo""`. Runs LAST, so transforms see
 * the final text. The first pair must be a transform (contain `:`), matching the
 * legacy guard. The individual modes live in {@link applyMode}; an unrecognised
 * mode leaves its text unchanged rather than emitting the literal wrapper.
 */
export function applyStringTransforms(template: string): string {
  let name = template;
  for (let guard = 0; guard < 50; guard++) {
    const pairs = name.split('""').length - 1;
    if (pairs < 2 || pairs % 2 !== 0) break;
    const first = name.indexOf('""');
    const second = name.indexOf('""', first + 2);
    if (second === -1) break;
    const inner = name.slice(first + 2, second);
    const colon = inner.indexOf(':');
    if (colon === -1) break;
    let text = inner.slice(colon + 1).trim();
    for (const mode of inner.slice(0, colon).split('+')) {
      text = applyMode(mode.trim().toLowerCase(), text);
    }
    name = name.slice(0, first) + text + name.slice(second + 2);
  }
  return name;
}

export interface RenderContext {
  /** Zero-based sibling index of this secondary (legacy `i`). -1 → "?". */
  index: number;
  members: VoiceMember[];
  aliases?: Record<string, string>;
  general?: string;
  /** Owner display name, for `@@owner@@` (and its older name, `@@creator@@`). */
  creatorName?: string;
  /**
   * The resolved owner member, for tokens/conditionals that read their
   * presence (`@@stream_name@@`, `{{LIVE…}}`, `{{ROLE:…}}`).
   */
  creator?: VoiceMember;
  /**
   * Stable per-channel random seed for `[[random]]`. Generated once at creation
   * and stored on the secondary, so picks never change (no rename churn). When
   * omitted, `0` is used (deterministic but identical across channels).
   */
  seed?: number;
  /**
   * The channel's LIVE user limit (0 = unlimited), for `@@limit@@`,
   * `@@slots@@`, `{{FULL}}` and as a `@@party_size@@` fallback.
   *
   * Every render path must supply it, which is why they all go through
   * `buildRenderContext` and a guard test binds them there: it used to be
   * passed only on the create path, so `@@party_size@@`'s fallback worked once
   * and silently degraded to `0` on every re-render after that
   * (`plans/name-tokens.md` §5.3).
   */
  userLimit?: number;
  /** Whether the room is locked, for `{{PRIVATE}}`. Adopted channels: false. */
  isPrivate?: boolean;
  /**
   * Added to the sibling index before every number token renders, so a guild
   * can start its rooms at 4 (or at 0). Comes from the primary's `startAt`
   * (`offset = startAt - 1`), so it applies uniformly to `##`, `$#`, `$0#…`,
   * `+#` and `@@nato@@` rather than being a suffix on one token
   * (`plans/name-tokens.md` §6.9).
   */
  numberOffset?: number;
}

/**
 * Renders a channel name from a template + context. Tokens (all available to
 * every guild — the legacy tier gating is gone):
 *
 * - `##` / `$#` / `$0#`… / `+#`  → channel number (plain / hash / zero-padded / roman)
 * - `@@nato@@`                    → NATO phonetic word for the channel number
 * - `@@game_name@@`               → representative game (aliases / "General" fallback)
 * - `@@num@@` / `@@num_others@@`   → member count (all / excluding owner)
 * - `@@owner@@` (or the older `@@creator@@`) → owner display name
 * - `@@stream_name@@`             → owner's stream title (or empty)
 * - `@@num_playing@@` / `@@party_size@@` / `@@party_state@@` / `@@party_details@@`
 *                                 → rich-presence party info for the channel's game
 * - `[[a/b/c]]`                   → random pick, fixed per channel (via `seed`)
 * - `__empty/occupied__`          → resting vs in-use name (adopted standalone channels)
 * - `<<one/many>>` / `<<one\\many>>` / `<<one|many>>` → singular/plural by member /
 *                                    non-owner / party-size (`@@num_playing@@`) count
 * - `{{cond ?? yes // no}}`        → conditional (see {@link evalExpression})
 * - `""mode:text""`                → string transform of the substituted text;
 *                                    case (`lower`/`upper`/`caps`/`title`/`swap`),
 *                                    `scaps`, the 13 math-font styles (`bold`,
 *                                    `italic`, `script`, `fraktur`, `mono`, …),
 *                                    `uwu`, `usd`, `rand`, `spaces`, `acro`,
 *                                    `remshort`, `<N>w` — chain with `+` (see
 *                                    {@link applyMode})
 *
 * Processing order follows the legacy `rename_channel` so tokens can nest inside
 * `[[…]]`, `<<…>>` and `{{…}}`.
 */
export interface RenderOptions {
  /** Max output length (default 100 for names; ~500 for voice statuses). */
  maxLength?: number;
  /** When true, an empty result stays empty (statuses); else falls back to "-". */
  allowEmpty?: boolean;
}

export function renderChannelName(
  template: string,
  ctx: RenderContext,
  opts: RenderOptions = {},
): string {
  let name = template;
  // `numberOffset` shifts every index-derived token together (`plans/name-tokens.md`
  // §6.9). `natoWord` is clamped at 0 so `startAt: 0` still yields Alpha.
  const offset = ctx.numberOffset ?? 0;
  const displayIndex = ctx.index === -1 ? -1 : ctx.index + offset;
  const iStr = ctx.index === -1 ? '?' : String(displayIndex + 1);
  const nonBot = ctx.members.filter((m) => !m.bot);
  const num = nonBot.length;
  const numOthers = ctx.creator ? nonBot.filter((m) => m.id !== ctx.creator!.id).length : num;
  const userLimit = ctx.userLimit ?? 0;

  // 0. Empty/occupied selection for adopted standalone channels (__empty/occupied__).
  //    Resolved first, so the chosen branch's own tokens are still substituted below.
  if (name.includes('__')) name = resolveEmptyOccupied(name, num === 0);

  // 1. Random picks first, fixed per channel by the stored seed.
  if (name.includes('[[')) name = resolveRandom(name, ctx.seed ?? 0);
  if (name.includes('@@random_emoji@@')) {
    name = name.split('@@random_emoji@@').join(pickRandomEmoji(ctx.seed ?? 0));
  }

  // 2. Channel-number variants (padded/roman before `##`).
  name = name.split('+#').join(ctx.index === -1 ? '?' : toRoman(displayIndex + 1));
  for (let x = 4; x >= 0; x--) {
    const token = '$' + '0'.repeat(x) + '#';
    if (name.includes(token)) {
      name = name.split(token).join(ctx.index === -1 ? '?' : iStr.padStart(x + 1, '0'));
    }
  }
  name = name.split('##').join('#' + iStr);

  // 3. NATO word, indexed by the 0-based channel number.
  if (name.includes('@@nato@@')) {
    // Two edges, both from `startAt: 0`, and both must be handled on
    // `ctx.index` rather than on `displayIndex`. A zero start puts the first
    // room's displayIndex at -1, which would otherwise collide with the
    // standalone-channel sentinel and render `?`. And a NEGATIVE offset is
    // simply not meaningful here, because the NATO alphabet has no zeroth
    // word: clamping the index instead would name the first two rooms both
    // Alpha. So numbering from zero leaves the words alone (Alpha, Bravo, …)
    // while `##` still reads `#0`.
    const natoIndex = ctx.index === -1 ? -1 : ctx.index + Math.max(offset, 0);
    name = name.split('@@nato@@').join(natoWord(natoIndex));
  }

  // 4. Representative game (needed by party info + conditionals too).
  const gameName = getGameName(ctx.members, {
    ...(ctx.aliases ? { aliases: ctx.aliases } : {}),
    ...(ctx.general ? { general: ctx.general } : {}),
  });

  // 5. Member counts and the room's capacity. All of these substitute BEFORE
  //    conditionals resolve (step 7), which is what makes them usable as
  //    conditional operands - see OPERAND_TOKENS.
  if (name.includes('@@num@@')) name = name.split('@@num@@').join(String(num));
  if (name.includes('@@num_others@@')) {
    name = name.split('@@num_others@@').join(String(numOthers));
  }
  if (name.includes('@@num_live@@')) {
    name = name.split('@@num_live@@').join(String(nonBot.filter(isLive).length));
  }
  if (name.includes('@@limit@@')) name = name.split('@@limit@@').join(String(userLimit));
  if (name.includes('@@slots@@')) {
    // Empty rather than `0` when unlimited: "0 spots left" is a lie, while an
    // empty gap is visible and guardable with `{{@@limit@@>=1 ?? …}}`. As an
    // operand it then resolves to nothing and takes the false branch, which is
    // the right answer for "is this room nearly full" on an unlimited room.
    name = name.split('@@slots@@').join(userLimit >= 1 ? String(Math.max(userLimit - num, 0)) : '');
  }

  // 6. Rich-presence party tokens (computed lazily, only when referenced — including
  //    by a `<<one|many>>` group, which selects on the party's @@num_playing@@ count).
  let numPlaying = 0;
  if (
    name.includes('@@party_') ||
    name.includes('@@num_playing@@') ||
    name.includes('{{') ||
    (name.includes('<<') && name.includes('|'))
  ) {
    const party = getPartyInfo(ctx.members, gameName, ctx.aliases ?? {}, ctx.userLimit ?? 0);
    numPlaying = Number.parseInt(party.numPlaying, 10) || 0;
    name = name.split('@@num_playing@@').join(party.numPlaying);
    name = name.split('@@party_size@@').join(party.size);
    // State and details are MEMBER-written free text. Collapse the delimiters
    // that are still live at this point, or a party line can split the very
    // conditional it sits inside, or introduce one (see collapseMarkers).
    name = name.split('@@party_state@@').join(collapseMarkers(party.state, EARLY_MARKER_CHARS));
    name = name.split('@@party_details@@').join(collapseMarkers(party.details, EARLY_MARKER_CHARS));
    // 7. Conditionals, which can read GAME/PLAYERS/MAX/RICH/LIVE/ROLE.
    if (name.includes('{{')) {
      name = resolveConditionals(name, buildExpressionVars(ctx, gameName, party));
    }
  }

  // 8. Singular/plural selection.
  if (name.includes('<<')) name = resolveSingularPlural(name, num, numOthers, numPlaying);

  // 9. Game name, owner (@@owner@@, plus its older name @@creator@@), and stream
  //    title. These land AFTER conditionals, so they can never be conditional
  //    operands; only `""` is still an unresolved marker here, so that is all
  //    they collapse (an owner called `Greg // AVC` renders unchanged).
  if (name.includes('@@game_name@@')) {
    name = name.split('@@game_name@@').join(collapseMarkers(gameName, LATE_MARKER_CHARS));
  }
  if (name.includes('@@owner@@') || name.includes('@@creator@@')) {
    // One pass over the ORIGINAL string via regex replace, not two chained
    // split/joins: a custom nickname can itself contain the literal text
    // "@@creator@@", and a second independent pass would re-match and
    // re-substitute that inserted text instead of leaving it alone.
    const ownerName = collapseMarkers(ctx.creatorName ?? 'Unknown', LATE_MARKER_CHARS);
    name = name.replace(/@@owner@@|@@creator@@/g, () => ownerName);
  }
  if (name.includes('@@stream_name@@')) {
    name = name.split('@@stream_name@@').join(collapseMarkers(streamName(ctx), LATE_MARKER_CHARS));
  }

  // 10. Legacy ""mode:text"" string transforms — applied LAST, to the fully
  //     substituted text (case, small-caps, math fonts, uwu, …; see applyMode).
  if (name.includes('""')) name = applyStringTransforms(name);

  // Clamp to the platform limit (100 for names, ~500 for statuses). An empty
  // channel name isn't valid (fall back to "-"), but an empty status is — it
  // clears the status — so `allowEmpty` keeps it empty.
  const max = opts.maxLength ?? MAX_CHANNEL_NAME_LENGTH;
  const trimmed = name.trim();
  const clamped = trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  return clamped === '' && !opts.allowEmpty ? '-' : clamped;
}

/** Discord's hard limit on a channel name's length. */
export const MAX_CHANNEL_NAME_LENGTH = 100;
