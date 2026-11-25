/**
 * Text that is always well-formed UTF-16, for anything the bot stores or sends.
 *
 * Some text reaches the bot as it was written: a game's activity name is whatever the
 * game sent, and JSON lets that include half of a surrogate pair. A cut by UTF-16
 * length can also split a pair in two. Postgres refuses such a string in jsonb, so a
 * room name holding one failed the write after every rename.
 *
 * Browser-safe, like the rest of this entry point.
 */

/**
 * A whole pair, or a surrogate on its own. Pairs match first, so what the second
 * alternative finds is exactly a lone half. No lookbehind, which older Safari cannot parse.
 */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * `text` with each lone surrogate replaced by U+FFFD, the replacement character.
 *
 * Replaced rather than dropped: it is the standard repair, what `TextEncoder` and Node's
 * `Buffer` make of a lone half, and it keeps the text on either side apart rather than
 * joining it into a new word. One unit in, one unit out, so no length limit is crossed
 * by it. What `String.prototype.toWellFormed` does, which the ES2022 target lacks.
 */
export function wellFormed(text: string): string {
  return text.replace(SURROGATES, (m) => (m.length === 2 ? m : '\uFFFD'));
}

/**
 * `text` cut to at most `max` UTF-16 units, one fewer when the cut would end on the
 * first half of a pair, so it never leaves half a character behind.
 */
export function cutWellFormed(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * A JSON value with {@link wellFormed} applied to every string in it, keys included.
 * Every other value is kept as it is, so a field this build does not know survives.
 */
export function wellFormedJson<T>(value: T): T {
  if (typeof value === 'string') return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => wellFormedJson(v)) as T;
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    // `fromEntries` defines each key, where `out[k] =` would set the prototype for a key
    // named `__proto__` and lose it.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [wellFormed(k), wellFormedJson(v)]),
    ) as T;
  }
  return value;
}
