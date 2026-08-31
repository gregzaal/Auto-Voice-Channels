/**
 * `JSON.parse` for legacy guild files, without destroying the ids.
 *
 * **The legacy bot wrote Discord snowflakes as JSON numbers**, and every modern
 * snowflake is larger than `Number.MAX_SAFE_INTEGER` (2^53 - 1). Plain
 * `JSON.parse` silently rounds them:
 *
 *   605724722902204416  ->  605724722902204400
 *
 * A survey of the live dump found **3105 such values in the first 1500 files**,
 * in `creator`, `jc`, `logging`, `tc`, `tcr`, `inheritperms`, `vc` and others.
 * Importing those would have given every adopted room a nonexistent owner and a
 * join companion pointing at a channel that does not exist, across 1862 guilds
 * and 1373 live secondaries, and nothing about the result would have looked
 * wrong: the values are still plausible ids.
 *
 * So long integers are quoted *before* parsing, arriving as strings, which is
 * what the new schema stores anyway. Object keys were never at risk, because
 * JSON keys are already strings.
 */

/** At and above this many digits, an integer cannot be trusted to a double. */
const UNSAFE_DIGITS = 16;

/**
 * Quotes bare integer literals of {@link UNSAFE_DIGITS} digits or more.
 *
 * Hand-written rather than a regex because a regex cannot tell a number inside
 * a string from a number in the document, and legacy channel-name templates
 * genuinely contain digits. This walks the text tracking string state and
 * escapes, so `"template": "Room 12345678901234567890"` is left alone.
 */
export function quoteLongIntegers(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    // A number literal can only start where a value can start, and in JSON that
    // means the previous non-space character is one of these.
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++;
      const digits = text.slice(i, j);
      const next = text[j];
      // Only a plain integer: a following '.', 'e' or 'E' makes this the
      // mantissa of a float or exponent, which is not an id.
      const isPlainInteger = next !== '.' && next !== 'e' && next !== 'E';
      // And the run must not be the *tail* of one either. Looking forward alone
      // is not enough: `0.30000000000000004` reaches here with a 17-digit run
      // whose next char is `}`, so it got quoted, emitting `0."300...4"` and
      // making `JSON.parse` throw "Unterminated fractional number" for the whole
      // file. Python's `repr` of a float routinely emits 17 significant digits,
      // so this is an ordinary shape, and for `/import` it is a file the admin
      // cannot fix rather than one line of a bulk dump.
      //
      // `-` and `+` are in the set for the original reason: a signed number is
      // never an id, and quoting the digits after the sign would emit
      // `-"605..."`, which is not JSON at all.
      const prev = out.at(-1);
      const continuesANumber =
        prev === '.' || prev === 'e' || prev === 'E' || prev === '-' || prev === '+';
      if (isPlainInteger && !continuesANumber && digits.length >= UNSAFE_DIGITS) {
        out += `"${digits}"`;
      } else {
        out += digits;
      }
      i = j - 1;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Parses a legacy guild file with ids intact.
 *
 * Long integers become strings. Everything else behaves exactly like
 * `JSON.parse`, including throwing on malformed input, so a corrupt file is
 * still a loud failure rather than a silently empty guild.
 */
export function parseLegacyJson(text: string): unknown {
  return JSON.parse(quoteLongIntegers(text));
}
