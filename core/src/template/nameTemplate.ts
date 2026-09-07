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

/**
 * How a tie for most-played game resolves.
 *
 * `shared` is the legacy behaviour and the default: two tied games are both
 * named, three or more fall back to the "no game" label. `top` always resolves
 * to exactly one game. Per guild, via `settings.game_name_mode`.
 */
export type GameNameMode = 'shared' | 'top';

export interface GameNameOptions {
  /** Per-guild aliases (override the built-ins). */
  aliases?: Record<string, string>;
  /** The "no specific game" label (legacy `settings.general`). */
  general?: string;
  /** Tie handling. Absent is `shared`. */
  mode?: GameNameMode;
  /**
   * The room owner's id, which breaks a tie in their favour.
   *
   * Optional because an adopted standalone channel has no owner, and because
   * `RenderContext.creator` is only set when the owner is actually in the room.
   * Either way the tie falls through to the deterministic order.
   */
  ownerId?: string;
}

/**
 * What one pass over the members decided about games.
 *
 * Both halves come out of the same call deliberately. `names` may hold two
 * games while the party tokens need exactly one, and computing that separately
 * is how the two drift apart: `getPartyInfo` matches an activity name against
 * the game it is given, so handing it the joined string "Halo, Doom" matched
 * nothing and silently zeroed `@@num_playing@@`, `@@party_size@@`, `{{RICH}}`
 * and `{{PLAYERS}}` on every tied room.
 */
export interface GameResolution {
  /** Raw (un-aliased) names to display, or `[general]` when no game is named. */
  names: string[];
  /**
   * The single raw game the party tokens describe, or `undefined` when the
   * rendered name does not name a game.
   *
   * Undefined for a three-or-more-way tie under `shared`, where the name is the
   * "no game" label: the name declines to claim a game, so the party tokens
   * must decline too, rather than reporting one arbitrary game's party.
   */
  representative?: string;
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
 * Which of the tied games wins.
 *
 * The owner's game first, because it is their room, and it is the only
 * tie-break that means anything to the person reading the name. It costs no
 * rename churn either: the owner's presence changing, the owner leaving,
 * `/transfer` and `/reclaim` all already trigger a re-render, so this value
 * only moves when something was going to re-render anyway.
 *
 * Otherwise the first in the caller's order, which is already deterministic:
 * counts descending, and `Array.prototype.sort` is stable, so equal counts keep
 * insertion order, which is alphabetical by the earliest-sorted player.
 *
 * Matches RAW names, because that is what the counts are keyed on. Aliasing
 * happens afterwards, in `getGameName`.
 */
function breakGameTie(tied: string[], members: VoiceMember[], ownerId?: string): string {
  if (ownerId !== undefined) {
    const owner = members.find((m) => m.id === ownerId && !m.bot);
    if (owner) {
      const playing = new Set(playingNames(owner));
      const theirs = tied.find((g) => playing.has(g));
      if (theirs !== undefined) return theirs;
    }
  }
  return tied[0]!;
}

/**
 * Determines the representative game(s) for a channel, replicating the legacy
 * tie-breaking: the most-played game wins; ties of two are joined; three or more
 * distinct ties fall back to "General". Under `mode: 'top'` a tie instead
 * resolves to one game (see `breakGameTie`).
 *
 * The single authority for both the displayed name and the game the party
 * tokens describe, for the reason `GameResolution` records.
 */
export function resolveGames(
  members: VoiceMember[],
  options: GameNameOptions = {},
): GameResolution {
  const general = options.general ?? 'General';
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
  if (counts.size === 0) return { names: [general] };

  const games = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const mostPlayers = games[0]![1];
  const tied = games.filter(([, gp]) => gp === mostPlayers).map(([gn]) => gn);
  if (tied.length === 1) return { names: tied, representative: tied[0]! };

  if (options.mode === 'top') {
    const winner = breakGameTie(tied, members, options.ownerId);
    return { names: [winner], representative: winner };
  }
  // Three or more tied is the "no game" label, and deliberately has NO
  // representative: see `GameResolution`. Note this cutoff counts RAW names,
  // as it always has, so three games that all alias to one label still read as
  // a three-way tie.
  if (tied.length > 2) return { names: [general] };
  /**
   * Both names, and the party tokens follow the FIRST tied game rather than the
   * owner's.
   *
   * The owner tie-break is deliberately confined to `top`, where the NAME
   * already moves with ownership so the party moving with it costs no extra
   * rename. Here the name does not move, so an owner-dependent representative
   * would make `/transfer`, `/reclaim` and the automatic handover when an owner
   * leaves each rename the room, for any template reading a party token, in a
   * guild that opted into nothing. That is the no-op guard `plans/name-tokens.md`
   * §2 says must not be weakened.
   */
  return { names: tied, representative: tied[0]! };
}

/** Aliases, de-duplicates and joins raw game names for display. */
function joinGameNames(names: string[], general: string, aliases: Record<string, string>): string {
  if (names.length === 1 && names[0] === general) return general;
  const aliased: string[] = [];
  for (const g of names) {
    const a = getAlias(g, aliases);
    if (!aliased.includes(a)) aliased.push(a);
  }
  return aliased.join(', ');
}

/**
 * The channel's game(s) as raw names.
 *
 * Kept as-is for the callers that only want the names (`/debug`, the site's
 * demo adapter). `resolveGames` is the one to reach for inside the renderer,
 * which needs the representative game as well.
 */
export function getChannelGames(
  members: VoiceMember[],
  general = 'General',
  options: Omit<GameNameOptions, 'general'> = {},
): string[] {
  return resolveGames(members, { ...options, general }).names;
}

/** Resolves a single display string for the channel's game(s). */
export function getGameName(members: VoiceMember[], options: GameNameOptions = {}): string {
  const general = options.general ?? 'General';
  return joinGameNames(resolveGames(members, options).names, general, options.aliases ?? {});
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

/** The `[[list:name]]` marker introducing a named pool. */
export const LIST_PREFIX = 'list:';

/**
 * The options a `[[…]]` group offers, or `undefined` when the group is
 * malformed and should be left as literal text for the author to see.
 *
 * `[[list:animals]]` reads a NAMED pool from the guild's settings. It exists
 * because a 100-character template cannot hold forty options inline: the
 * built-in default already spends 130 characters, almost all of it one
 * `[[…]]` group (`plans/name-tokens.md` §10.2). An unknown name is left
 * literal rather than rendered empty, for the same reason a `[[…]]` with no
 * `/` is: a visible mistake beats a silently missing word.
 */
function randomOptions(
  inner: string,
  lists: Record<string, string[]> | undefined,
): string[] | undefined {
  // Trimmed before the prefix test, because the lint, the advisory path and the
  // site's highlighter all trim: without it `[[ list:a]]` rendered as literal
  // text while every surface that describes a template reported it as fine.
  const trimmed = inner.trim();
  if (trimmed.startsWith(LIST_PREFIX)) {
    const key = trimmed.slice(LIST_PREFIX.length).trim();
    // Own-property, never `in` or a bare index: the name comes from a stored
    // template, so `[[list:constructor]]` would otherwise reach up the
    // prototype chain and hand back a function. Same trap `getAlias` and
    // `operandValue` both document.
    if (!lists || !Object.prototype.hasOwnProperty.call(lists, key)) return undefined;
    const options = lists[key]!.filter((o) => o !== '');
    return options.length > 0 ? options : undefined;
  }
  return inner.includes('/') ? inner.split('/') : undefined;
}

/**
 * Resolves every `[[a/b/c]]` group to a single option, chosen deterministically
 * from `seed` + the group's ordinal. Because the seed is fixed per channel (see
 * {@link RenderContext.seed}), a channel always renders the same pick — so the
 * random default never causes a rename. Groups are processed left-to-right; a
 * malformed `[[…]]` is left untouched (see {@link randomOptions}).
 */
export function resolveRandom(
  template: string,
  seed: number,
  lists?: Record<string, string[]>,
): string {
  let name = template;
  let group = 0;
  // Bounded to avoid any pathological loop on malformed input.
  for (let guard = 0; guard < 50; guard++) {
    const open = name.indexOf('[[');
    if (open === -1) break;
    const close = name.indexOf(']]', open + 2);
    if (close === -1) break;
    const inner = name.slice(open + 2, close);
    const options = randomOptions(inner, lists);
    if (!options) break;
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
  gameName: string | undefined,
  aliases: Record<string, string> = {},
  userLimit = 0,
): PartyInfo {
  // No representative game means the rendered name does not name one, so there
  // is nothing for these tokens to describe. Undefined rather than a sentinel
  // string on purpose: passing the "no game" label through would start matching
  // a member genuinely playing a game called General.
  if (gameName === undefined) {
    return { state: '', details: '', rich: false, numPlaying: '0', size: '0' };
  }

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
   * The owner's user id, as a one-element list so the existing `:` operator
   * covers `{{OWNER:123 ?? …}}` with no new operator code.
   *
   * An ID rather than a name, deliberately. A display name is mutable, not
   * unique, and set by the member themselves, so keying a template on one lets
   * anybody who renames themselves inherit whatever it grants. There is no
   * `OWNER_NAME` for that reason.
   *
   * Empty when the owner is not among the channel's current members, which is
   * the same condition that makes `@@owner@@` render `Unknown`. So a bare
   * `{{OWNER ?? …}}` reads as "this room has a known owner" and is the
   * supported way to write a fallback for a room whose owner has left.
   */
  OWNER: string[];
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
  /**
   * Date, in the guild's zone, at day-or-coarser granularity.
   *
   * There is deliberately no minute or second anywhere in this family. A
   * minute-granular value changes on nearly every 5-minute sweep tick, which is
   * the whole rename budget spent on a clock, forever, on every managed channel
   * in the guild (`plans/name-tokens.md` §2). The hour is the finest thing
   * admitted, and it is `@@hour@@` rather than an `HOUR` variable: §5.1's rule
   * is that a variable must express something a comparison of tokens cannot, and
   * `{{@@hour@@>=18 ?? …}}` already says it. These three earn their place
   * because `=` and `:` on a STRING is not something any token can be compared
   * with, and because "is it the weekend" is a rule rather than a value.
   */
  WEEKDAY: string;
  MONTH: string;
  WEEKEND: boolean;
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
  OWNER: true,
  FULL: true,
  PRIVATE: true,
  WEEKDAY: true,
  MONTH: true,
  WEEKEND: true,
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
  '@@original_creator@@',
  '@@weekday@@',
  '@@month@@',
  '@@hour@@',
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
export const LATE_TOKENS: readonly string[] = [
  '@@game_name@@',
  '@@owner@@',
  '@@creator@@',
  '@@original_creator@@',
  '@@stream_name@@',
];

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
export const OPERAND_TOKENS: readonly string[] = [
  '@@num@@',
  '@@num_others@@',
  '@@num_playing@@',
  '@@num_live@@',
  '@@party_size@@',
  '@@limit@@',
  '@@slots@@',
  '@@hour@@',
  '$#',
  '$0#',
  '$00#',
  '$000#',
  '$0000#',
];

/**
 * The tokens whose value comes from the clock, and which therefore depend on the
 * guild having set a time zone.
 *
 * Exported because every surface that can see a guild's settings has to be able
 * to say "this renders in UTC until you set a zone": with no zone the render
 * still succeeds, silently, on the wrong day for most of the install base
 * (`plans/name-tokens.md` §10.1).
 */
export const DATE_TOKENS: readonly string[] = ['@@weekday@@', '@@month@@', '@@hour@@'];

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
// Date and time — coarse only, and injected rather than read from the clock
// ---------------------------------------------------------------------------

/**
 * The canonical IANA name for a zone, or `null` when it is one we refuse.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown zone, which is the
 * only check that needs no bundled zone table, and `resolvedOptions` then hands
 * back the canonical spelling: `europe/amsterdam` and the deprecated alias
 * `Japan` become `Europe/Amsterdam` and `Asia/Tokyo`. Storing the canonical form
 * is what makes the stored value readable back to the admin who typed it.
 *
 * **Fixed offsets are refused even though Intl accepts them**, and that is the
 * whole reason this is not a bare try/catch. `+02:00` is a valid `timeZone`
 * here, and a guild that set one would be an hour out for half of every year
 * with nothing to say so: an offset cannot follow daylight saving, and a region
 * name is the only input that can. `Etc/GMT+2` is refused for a second reason on
 * top of that -- IANA's sign convention there is inverted, so it means UTC-2,
 * which is a trap rather than a choice.
 */
export function canonicalTimeZone(zone: string): string | null {
  if (zone.trim() === '') return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
  if (/^[+-]/.test(resolved) || /^Etc\/GMT[+-]/.test(resolved)) return null;
  return resolved;
}

/**
 * {@link canonicalTimeZone}, memoised.
 *
 * Resolving a zone costs a fresh `Intl.DateTimeFormat`, measured at ~41us, and
 * the render path asks about the zone for **every template containing a `{{`**,
 * which includes the default status template every guild has. Memoised on the
 * RAW input rather than the canonical name so a stored value only ever resolves
 * once, whatever it is. Cleared wholesale past a ceiling: the write paths all
 * store canonical names, so the real key set is the IANA one, and a cache keyed
 * by stored data should still not be the thing that grows without bound.
 */
const CANONICAL_ZONES = new Map<string, string | null>();

export function knownTimeZone(zone: string): string | undefined {
  let hit = CANONICAL_ZONES.get(zone);
  if (hit === undefined) {
    if (CANONICAL_ZONES.size > 2000) CANONICAL_ZONES.clear();
    hit = canonicalTimeZone(zone);
    CANONICAL_ZONES.set(zone, hit);
  }
  return hit ?? undefined;
}

/**
 * Whether a string is a zone the engine will render in.
 *
 * Exported because the value has to be validated at BOTH ends: the settings blob
 * is `record(unknown)` at the repository boundary, and `/import` takes it from a
 * file, so the render path cannot be the only thing that looks. Writers should
 * use {@link canonicalTimeZone} instead, and store what it returns.
 */
export function isValidTimeZone(zone: string): boolean {
  return knownTimeZone(zone) !== undefined;
}

/**
 * Cap on a `[[list:name]]` name.
 *
 * Short enough that a name always fits inside a Discord custom id (100
 * characters, shared with the panel's own prefix and action) and inside a select
 * option's label, so the panel never has to hash a name the way `/alias` does.
 */
export const LIST_NAME_MAX = 40;

/**
 * Whether a string is usable as a `[[list:name]]` name.
 *
 * The characters excluded are the ones that would break the very syntax the name
 * is used in: `]` closes the block early, `[` opens another, `/` is the choice
 * separator every other `[[…]]` uses, and `:` is the field separator in every
 * custom id this panel round-trips a name through. A leading or trailing space
 * is refused rather than trimmed, because the engine trims the key at lookup and
 * two names differing only in spacing would resolve to one pool.
 */
export function isValidListName(name: string): boolean {
  if (name === '' || name.length > LIST_NAME_MAX) return false;
  // `__proto__` is refused rather than sanitised, because the two writers
  // disagree about it and neither is wrong: `out[name] = …` in the importer hits
  // the prototype setter and silently drops the entry, while the panel's object
  // spread stores it as an own property. One name, two behaviours, so it is not
  // a name.
  if (name === '__proto__') return false;
  if (name !== name.trim()) return false;
  if (/[[\]/:]/.test(name)) return false;
  // Control characters, checked by code point rather than by a character class:
  // the class would have to contain literal control bytes, which a formatter
  // rewrites and a reviewer cannot see.
  for (const ch of name) if (ch.codePointAt(0)! < 0x20) return false;
  return true;
}

/**
 * Formatters are expensive to build and are rebuilt per render otherwise, so
 * they are memoised by zone.
 *
 * A pure memo, not state: the same zone always yields the same formatter, and
 * nothing here observes anything outside its arguments. The map is bounded by
 * the number of distinct zones the install base uses, which is at most the
 * number of IANA zones and in practice a handful.
 */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = ZONE_FORMATTERS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'long',
      month: 'long',
      // `h23` rather than `hour12: false`: the latter reports midnight as "24"
      // in some environments, which would make `{{@@hour@@>=18}}` true at 00:00.
      hourCycle: 'h23',
      hour: '2-digit',
    });
    ZONE_FORMATTERS.set(zone, f);
  }
  return f;
}

/** The weekday name, month name and hour of `now` in `zone`. */
export interface DateParts {
  /** English weekday name, e.g. `Monday`. */
  weekday: string;
  /** English month name, e.g. `September`. */
  month: string;
  /**
   * Hour of the day, 0 to 23, or `null` when there is no clock to read.
   *
   * Nullable rather than `0`, because `0` is midnight: a caller with no clock
   * would otherwise render `@@hour@@` as a plausible-looking `0` and make
   * `{{@@hour@@<=1 ?? …}}` true, which is exactly the class of silent wrongness
   * the whole date family is written to avoid.
   */
  hour: number | null;
  /** Saturday or Sunday. False with no clock, like every other unknown here. */
  weekend: boolean;
}

const NO_DATE: DateParts = { weekday: '', month: '', hour: null, weekend: false };

/**
 * Resolves the date parts a template needs.
 *
 * **English names, deliberately**, like `@@nato@@` and every other word the
 * engine supplies: a template is a stored string an admin wrote, so a name that
 * changed language when a viewer's client did would be a different bug.
 *
 * Weekend is Saturday or Sunday. That is wrong in the several countries whose
 * weekend is Friday and Saturday, and it is stated in the docs rather than
 * guessed at from the zone, because a zone does not carry a work week.
 */
export function dateParts(now: Date | undefined, timezone: string | undefined): DateParts {
  if (!now || Number.isNaN(now.getTime())) return NO_DATE;
  // Resolved to a canonical name FIRST, never handed to `Intl` as stored.
  // `Intl.DateTimeFormat` throws `RangeError` on a zone it cannot parse, and a
  // throw here is a throw inside the render of every managed channel in the
  // guild, tripping its breaker with an error mentioning nothing about a zone.
  // A stored value that no longer resolves degrades to UTC instead.
  const parts = formatterFor(timezone ? (knownTimeZone(timezone) ?? 'UTC') : 'UTC').formatToParts(
    now,
  );
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = pick('weekday');
  const hour = Number.parseInt(pick('hour'), 10);
  return {
    weekday,
    month: pick('month'),
    hour: Number.isNaN(hour) ? null : hour,
    weekend: weekday === 'Saturday' || weekday === 'Sunday',
  };
}

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
  clock: DateParts,
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
    OWNER: creator ? [creator.id] : [],
    // Unlimited is never full, and an unknown limit reads as unlimited, so this
    // fails open: it never claims a room is full on missing information.
    FULL: limit >= 1 && nonBot.length >= limit,
    PRIVATE: ctx.isPrivate ?? false,
    WEEKDAY: clock.weekday,
    MONTH: clock.month,
    WEEKEND: clock.weekend,
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
  /**
   * How a tie for most-played game resolves, from `settings.game_name_mode`.
   * Absent is `shared`, the legacy behaviour.
   *
   * A guild setting rather than a per-creator-channel one, so it also covers
   * adopted standalone channels, which render from a different table.
   */
  gameNameMode?: GameNameMode;
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
  /**
   * The moment to render date and time tokens against.
   *
   * **Injected, never read from the clock here**, which is the rule this whole
   * module keeps: no `process`, no `crypto`, no `Date.now()`. That is what makes
   * every render reproducible in a test and on the marketing site, and it is
   * why the date family arrived without loosening it.
   *
   * Absent means the date tokens have nothing to render, so they resolve empty
   * and their variables read as a Sunday midnight rather than throwing.
   */
  now?: Date;
  /**
   * The guild's IANA time zone for `now`. Absent, or unrecognised, means UTC.
   *
   * "Friday night" ends at 2pm Friday in Los Angeles, so a UTC-only date token
   * is wrong for most of the install base. That is the whole reason this exists
   * (`plans/name-tokens.md` §10.1).
   */
  timezone?: string;
  /**
   * Named `[[list:name]]` pools, from the guild's settings.
   *
   * A pool is picked with the same per-channel `seed` as an inline `[[a/b]]`,
   * so a named list never causes a rename either.
   */
  lists?: Record<string, string[]>;
  /**
   * Display name of whoever created the room, for `@@original_creator@@`.
   *
   * Cached on the row at creation rather than resolved here, because the
   * original creator has usually left by the time it matters and a member fetch
   * on the render path is not an option (`plans/name-tokens.md` §10.4).
   */
  originalCreatorName?: string;
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
  let clock: DateParts = NO_DATE;

  // 0. Empty/occupied selection for adopted standalone channels (__empty/occupied__).
  //    Resolved first, so the chosen branch's own tokens are still substituted below.
  if (name.includes('__')) name = resolveEmptyOccupied(name, num === 0);

  // 1. Random picks first, fixed per channel by the stored seed.
  if (name.includes('[[')) name = resolveRandom(name, ctx.seed ?? 0, ctx.lists);
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

  // 4. Representative game (needed by party info + conditionals too). One
  //    resolution feeds both the displayed name and the party lookup, so the
  //    two can never disagree about which game the room is on.
  const resolvedGames = resolveGames(ctx.members, {
    ...(ctx.aliases ? { aliases: ctx.aliases } : {}),
    ...(ctx.general ? { general: ctx.general } : {}),
    ...(ctx.gameNameMode ? { mode: ctx.gameNameMode } : {}),
    // The owner, when they are actually in the room, breaks a tie in their
    // favour. `creator` is already absent otherwise, so no extra check.
    ...(ctx.creator ? { ownerId: ctx.creator.id } : {}),
  });
  const gameName = joinGameNames(resolvedGames.names, ctx.general ?? 'General', ctx.aliases ?? {});
  // Aliased, because that is what `getPartyInfo` compares activity names against.
  const partyGame =
    resolvedGames.representative === undefined
      ? undefined
      : getAlias(resolvedGames.representative, ctx.aliases ?? {});

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
  // Date and time, resolved lazily and only once. At step 5 rather than step 9
  // so `@@hour@@` is a usable conditional operand, and coarse by construction:
  // there is no minute token, for the reason ExpressionVars records.
  if (
    name.includes('@@weekday@@') ||
    name.includes('@@month@@') ||
    name.includes('@@hour@@') ||
    name.includes('{{')
  ) {
    clock = dateParts(ctx.now, ctx.timezone);
    if (name.includes('@@weekday@@')) name = name.split('@@weekday@@').join(clock.weekday);
    if (name.includes('@@month@@')) name = name.split('@@month@@').join(clock.month);
    // Empty, not `0`, when there is no clock: see `DateParts.hour`. An empty
    // left side makes a comparison take the false branch, which is the right
    // default for a value nobody could read.
    if (name.includes('@@hour@@')) {
      name = name.split('@@hour@@').join(clock.hour === null ? '' : String(clock.hour));
    }
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
    const party = getPartyInfo(ctx.members, partyGame, ctx.aliases ?? {}, ctx.userLimit ?? 0);
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
      name = resolveConditionals(name, buildExpressionVars(ctx, gameName, party, clock));
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
  if (
    name.includes('@@owner@@') ||
    name.includes('@@creator@@') ||
    name.includes('@@original_creator@@')
  ) {
    // One pass over the ORIGINAL string via regex replace, not two chained
    // split/joins: a custom nickname can itself contain the literal text
    // "@@creator@@", and a second independent pass would re-match and
    // re-substitute that inserted text instead of leaving it alone.
    const ownerName = collapseMarkers(ctx.creatorName ?? 'Unknown', LATE_MARKER_CHARS);
    /**
     * The original creator falls back to the CURRENT owner's name, not to
     * `Unknown`: a room created before the cache existed, or one whose cached
     * name an older instance stripped, still reads as somebody's room rather
     * than nobody's. Rooms where the two differ are exactly the ones that have
     * changed hands, which is what the token is for.
     */
    const originalName = collapseMarkers(
      ctx.originalCreatorName ?? ctx.creatorName ?? 'Unknown',
      LATE_MARKER_CHARS,
    );
    // ONE pass over the original string, longest alternative first. Two chained
    // passes would re-substitute a name that itself contains `@@creator@@`,
    // which is the trap this line has carried a comment about since `@@owner@@`
    // was introduced; `@@original_creator@@` does not contain `@@creator@@`
    // (the `c` is preceded by `_`), but ordering it first keeps that a fact
    // about the regex rather than about the token's spelling.
    name = name.replace(/@@original_creator@@|@@owner@@|@@creator@@/g, (m) =>
      m === '@@original_creator@@' ? originalName : ownerName,
    );
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
