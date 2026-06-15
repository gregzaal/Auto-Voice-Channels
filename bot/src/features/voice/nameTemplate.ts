import type { VoiceMember } from './types.js';

/**
 * Channel-name templating, ported from the legacy bot's `rename_channel` /
 * `get_channel_games` / `get_game_name` / `get_alias` / `get_party_info` /
 * `eval_expression`. Covers the index tokens, game name, member counts, the
 * `[[random]]` picker (resolved once per channel via a stored seed),
 * `@@nato@@`, the rich-presence party/stream tokens, `<<singular/plural>>`, and
 * `{{conditional}}` expressions.
 *
 * Tier gating from the legacy bot is gone (single standard bot), so every token
 * is available to every guild.
 *
 * Presence is consumed lazily: game/party detection only runs when the template
 * needs it (see {@link renderChannelName}).
 */

/**
 * The default channel-name template. Picks a stable random emoji + word per
 * channel (resolved once, so it never triggers later renames) around the
 * creator's name — deliberately free of `##`/`@@game_name@@` so the default
 * experience generates almost no renames over a channel's life.
 */
export const DEFAULT_CHANNEL_NAME_TEMPLATE =
  "[[😸/🙀/🚀/☕/🍆/🍌/🍕/🐍/🐗/🐙/🐝/🐞/🐭/🐶/👻/👽/👾/💀/🔥/🔫/🐀/🐁/🐆/🐇/🐋/🐉/🐓/🦊/🐺/🦁/🐯/🦄/🐲/🦅/🦉/🐢/🦖]] @@creator@@'s [[den/gang/crew/platoon/cave/room/party/hangout/lounge/lair/squad/club/nest/base/zone/spot]]";

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
  if (name in aliases) return aliases[name]!;
  if (name in STD_ALIASES) return STD_ALIASES[name]!;
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
 * Resolves `<<singular/plural>>` (count = total members) and
 * `<<singular\\plural>>` (count = members excluding the creator): the singular
 * form when the count is exactly 1, else the plural.
 */
export function resolveSingularPlural(
  template: string,
  numMembers: number,
  numOthers: number,
): string {
  let name = template;
  for (let guard = 0; guard < 50; guard++) {
    const open = name.indexOf('<<');
    if (open === -1) break;
    const close = name.indexOf('>>', open + 2);
    if (close === -1) break;
    const inner = name.slice(open + 2, close);
    let parts: string[] | undefined;
    let count: number | undefined;
    if ((inner.match(/\//g) ?? []).length === 1) {
      parts = inner.split('/');
      count = numMembers;
    } else if ((inner.match(/\\/g) ?? []).length === 1) {
      parts = inner.split('\\');
      count = numOthers;
    }
    if (!parts || count === undefined) break;
    const choice = count === 1 ? parts[0]! : parts[1]!;
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
  PLAYERS: number;
  MAX: number;
  RICH: boolean;
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

  if (!(name in vars)) return falsy;
  const value = vars[name as keyof ExpressionVars];

  let result: boolean;
  if (!op) {
    result = Array.isArray(value) ? value.length > 0 : Boolean(value);
  } else if (op === ':') {
    result = Array.isArray(value) ? value.includes(rhs) : String(value).includes(rhs);
  } else if (op === '=' || op === '!=') {
    const equal =
      typeof value === 'number' && /^-?\d+$/.test(rhs)
        ? value === Number(rhs)
        : String(value) === rhs;
    result = op === '=' ? equal : !equal;
  } else {
    const cmp = COMPARATORS.find(([s]) => s === op)![1];
    result = typeof value === 'number' && /^-?\d+$/.test(rhs) ? cmp(value, Number(rhs)) : false;
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

/** Builds the conditional variables from the channel's creator + party state. */
function buildExpressionVars(
  ctx: RenderContext,
  gameName: string,
  party: PartyInfo,
): ExpressionVars {
  const creator = ctx.creator;
  const liveExternal = (creator?.activities ?? []).some((a) => a.kind === 'streaming');
  const liveDiscord = creator?.selfStreaming ?? false;
  return {
    ROLE: creator?.roleIds ?? [],
    LIVE: liveExternal || liveDiscord,
    LIVE_DISCORD: liveDiscord,
    LIVE_EXTERNAL: liveExternal,
    GAME: gameName,
    PLAYERS: Number.parseInt(party.numPlaying, 10) || 0,
    MAX: Number.parseInt(party.size, 10) || 0,
    RICH: party.rich,
  };
}

/** The stream title from the creator's streaming activity, or `''`. */
function streamName(ctx: RenderContext): string {
  return (ctx.creator?.activities ?? []).find((a) => a.kind === 'streaming')?.name ?? '';
}

export interface RenderContext {
  /** Zero-based sibling index of this secondary (legacy `i`). -1 → "?". */
  index: number;
  members: VoiceMember[];
  aliases?: Record<string, string>;
  general?: string;
  /** Creator display name, for `@@creator@@`. */
  creatorName?: string;
  /**
   * The resolved creator member, for tokens/conditionals that read their
   * presence (`@@stream_name@@`, `{{LIVE…}}`, `{{ROLE:…}}`).
   */
  creator?: VoiceMember;
  /**
   * Stable per-channel random seed for `[[random]]`. Generated once at creation
   * and stored on the secondary, so picks never change (no rename churn). When
   * omitted, `0` is used (deterministic but identical across channels).
   */
  seed?: number;
  /** The channel's user limit, used as a `@@party_size@@` fallback. */
  userLimit?: number;
}

/**
 * Renders a channel name from a template + context. Tokens (all available to
 * every guild — the legacy tier gating is gone):
 *
 * - `##` / `$#` / `$0#`… / `+#`  → channel number (plain / hash / zero-padded / roman)
 * - `@@nato@@`                    → NATO phonetic word for the channel number
 * - `@@game_name@@`               → representative game (aliases / "General" fallback)
 * - `@@num@@` / `@@num_others@@`   → member count (all / excluding creator)
 * - `@@creator@@`                 → creator display name
 * - `@@stream_name@@`             → creator's stream title (or empty)
 * - `@@num_playing@@` / `@@party_size@@` / `@@party_state@@` / `@@party_details@@`
 *                                 → rich-presence party info for the channel's game
 * - `[[a/b/c]]`                   → random pick, fixed per channel (via `seed`)
 * - `<<one/many>>` / `<<one\\many>>` → singular/plural by member / non-creator count
 * - `{{cond ?? yes // no}}`        → conditional (see {@link evalExpression})
 *
 * Processing order follows the legacy `rename_channel` so tokens can nest inside
 * `[[…]]`, `<<…>>` and `{{…}}`.
 */
export function renderChannelName(template: string, ctx: RenderContext): string {
  let name = template;
  const iStr = ctx.index === -1 ? '?' : String(ctx.index + 1);
  const nonBot = ctx.members.filter((m) => !m.bot);
  const num = nonBot.length;
  const numOthers = ctx.creator ? nonBot.filter((m) => m.id !== ctx.creator!.id).length : num;

  // 1. Random picks first, fixed per channel by the stored seed.
  if (name.includes('[[')) name = resolveRandom(name, ctx.seed ?? 0);

  // 2. Channel-number variants (padded/roman before `##`).
  name = name.split('+#').join(ctx.index === -1 ? '?' : toRoman(ctx.index + 1));
  for (let x = 4; x >= 0; x--) {
    const token = '$' + '0'.repeat(x) + '#';
    if (name.includes(token)) {
      name = name.split(token).join(ctx.index === -1 ? '?' : iStr.padStart(x + 1, '0'));
    }
  }
  name = name.split('##').join('#' + iStr);

  // 3. NATO word, indexed by the 0-based channel number.
  if (name.includes('@@nato@@')) name = name.split('@@nato@@').join(natoWord(ctx.index));

  // 4. Representative game (needed by party info + conditionals too).
  const gameName = getGameName(ctx.members, {
    ...(ctx.aliases ? { aliases: ctx.aliases } : {}),
    ...(ctx.general ? { general: ctx.general } : {}),
  });

  // 5. Member counts.
  if (name.includes('@@num@@')) name = name.split('@@num@@').join(String(num));
  if (name.includes('@@num_others@@')) {
    name = name.split('@@num_others@@').join(String(numOthers));
  }

  // 6. Rich-presence party tokens (computed lazily, only when referenced).
  if (name.includes('@@party_') || name.includes('@@num_playing@@') || name.includes('{{')) {
    const party = getPartyInfo(ctx.members, gameName, ctx.aliases ?? {}, ctx.userLimit ?? 0);
    name = name.split('@@num_playing@@').join(party.numPlaying);
    name = name.split('@@party_size@@').join(party.size);
    name = name.split('@@party_state@@').join(party.state);
    name = name.split('@@party_details@@').join(party.details);
    // 7. Conditionals, which can read GAME/PLAYERS/MAX/RICH/LIVE/ROLE.
    if (name.includes('{{')) {
      name = resolveConditionals(name, buildExpressionVars(ctx, gameName, party));
    }
  }

  // 8. Singular/plural selection.
  if (name.includes('<<')) name = resolveSingularPlural(name, num, numOthers);

  // 9. Game name, creator, and stream title.
  if (name.includes('@@game_name@@')) name = name.split('@@game_name@@').join(gameName);
  if (name.includes('@@creator@@')) {
    name = name.split('@@creator@@').join(ctx.creatorName ?? 'Unknown');
  }
  if (name.includes('@@stream_name@@')) {
    name = name.split('@@stream_name@@').join(streamName(ctx));
  }

  // Discord caps channel names at 100 characters; a long game/creator name could
  // otherwise push past it and make the rename API call fail. An empty result
  // isn't a valid channel name, so fall back to "-" (legacy behaviour).
  const trimmed = name.trim();
  const clamped =
    trimmed.length > MAX_CHANNEL_NAME_LENGTH ? trimmed.slice(0, MAX_CHANNEL_NAME_LENGTH) : trimmed;
  return clamped === '' ? '-' : clamped;
}

/** Discord's hard limit on a channel name's length. */
export const MAX_CHANNEL_NAME_LENGTH = 100;
