import {
  AT_TOKENS,
  CONDITION_VARIABLES,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_STATUS_LENGTH,
} from '../voice/nameTemplate.js';
import { isKnownStyleMode } from '../voice/stringTransforms.js';

/**
 * Validation for a model-proposed template
 * (`plans/assisted_templates.md` §4 and §9 finding 3).
 *
 * The point of this file is that **"the engine didn't throw" is not a check**.
 * The renderer is deliberately forgiving: an unknown `{{VAR}}` is false, an
 * unknown `""mode:""` is a no-op, a token inside a condition silently fails, and
 * an empty name quietly becomes `-`. Each of those produces output that looks
 * valid and is wrong, and a bare render would pass every one of them. So the
 * lint below reads the template structurally, and the caller additionally
 * renders it and re-checks the *output* (see {@link inspectRendered}).
 *
 * Everything here is pure, so the whole quality bar is unit-testable without a
 * model or a network.
 */

export type IssueCode =
  | 'unclosed-construct'
  | 'random-without-choices'
  | 'plural-without-separator'
  | 'condition-without-branch'
  | 'unknown-token'
  | 'stray-token-marker'
  | 'token-in-condition'
  | 'unknown-variable'
  | 'unknown-style'
  | 'template-too-long'
  | 'renders-empty'
  | 'renders-unsubstituted'
  | 'renders-truncated';

export interface TemplateIssue {
  code: IssueCode;
  /** Fed back to the model on the re-prompt, so it must say how to fix it. */
  message: string;
}

export type TemplateField = 'name' | 'status';

/** Output caps per field. A name may never be empty; a status may. */
export function maxLengthFor(field: TemplateField): number {
  return field === 'name' ? MAX_CHANNEL_NAME_LENGTH : MAX_STATUS_LENGTH;
}

/** Finds every `open…close` block, non-nested, left to right. */
function blocks(template: string, open: string, close: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (let guard = 0; guard < 100; guard++) {
    const start = template.indexOf(open, from);
    if (start === -1) break;
    const end = template.indexOf(close, start + open.length);
    if (end === -1) break;
    found.push(template.slice(start + open.length, end));
    from = end + close.length;
  }
  return found;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The condition half of a `{{…}}` block (everything left of `??`), or undefined
 * when the block has no `??` at all.
 */
function conditionOf(inner: string): string | undefined {
  const i = inner.indexOf('??');
  return i === -1 ? undefined : inner.slice(0, i);
}

/** The variable name a condition tests, i.e. everything left of any comparator. */
function variableOf(condition: string): string {
  for (const sym of ['<=', '>=', '<', '>', '!=', '=', ':']) {
    const i = condition.indexOf(sym);
    if (i !== -1) return condition.slice(0, i).trim();
  }
  return condition.trim();
}

/**
 * Structural lint of a template, before it is rendered.
 *
 * `channelKind` is advisory only: the numbering tokens render `?` on a
 * standalone channel, which is ugly but not invalid, and an admin may be
 * setting a template they intend to reuse. It is reported to the admin in the
 * proposal rather than rejected.
 */
export function lintTemplate(template: string, field: TemplateField): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const add = (code: IssueCode, message: string): void => {
    if (!issues.some((i) => i.code === code)) issues.push({ code, message });
  };

  // -- balance -------------------------------------------------------------
  if (countOf(template, '{{') !== countOf(template, '}}')) {
    add('unclosed-construct', 'A `{{` is missing its matching `}}` (or the other way round).');
  }
  if (countOf(template, '[[') !== countOf(template, ']]')) {
    add('unclosed-construct', 'A `[[` is missing its matching `]]`.');
  }
  if (countOf(template, '<<') !== countOf(template, '>>')) {
    add('unclosed-construct', 'A `<<` is missing its matching `>>`.');
  }
  if (countOf(template, '""') % 2 !== 0) {
    add('unclosed-construct', 'A `""` style wrapper is not closed by a second `""`.');
  }

  // -- constructs that silently render as literal text when malformed ------
  for (const inner of blocks(template, '[[', ']]')) {
    if (!inner.includes('/')) {
      add(
        'random-without-choices',
        'A `[[…]]` random picker needs at least one `/` between choices, ' +
          'otherwise it is printed literally.',
      );
    }
  }
  for (const inner of blocks(template, '<<', '>>')) {
    if (!/[/\\|]/.test(inner)) {
      add(
        'plural-without-separator',
        'A `<<…>>` singular/plural group needs a `/`, `\\` or `|` separator.',
      );
    }
  }

  // -- conditionals --------------------------------------------------------
  for (const inner of blocks(template, '{{', '}}')) {
    const condition = conditionOf(inner);
    if (condition === undefined) {
      add(
        'condition-without-branch',
        'A `{{…}}` needs `??` between the condition and what to show.',
      );
      continue;
    }
    // §9 finding 3 + finding 4: the model's most stubborn failure was putting a
    // token on the left of a condition. It renders to nothing at all, so only a
    // structural check catches it.
    if (condition.includes('@@') || condition.includes('#')) {
      add(
        'token-in-condition',
        'A token cannot go inside a `{{…}}` condition (it silently never matches). ' +
          'Only the documented variables can be tested, and there is no variable for ' +
          'the number of people in the channel.',
      );
    }
    const variable = variableOf(condition);
    if (variable !== '' && !(CONDITION_VARIABLES as string[]).includes(variable)) {
      add(
        'unknown-variable',
        `\`${variable}\` is not a conditional variable. Use one of: ` +
          `${CONDITION_VARIABLES.join(', ')}.`,
      );
    }
  }

  // -- tokens --------------------------------------------------------------
  for (const match of template.matchAll(/@@[^@]*@@/g)) {
    const token = match[0];
    if (!AT_TOKENS.includes(token)) {
      add('unknown-token', `\`${token}\` is not a real token. Only the documented ones exist.`);
    }
  }
  // An odd number of `@@` markers means one was left dangling, which prints raw.
  if (countOf(template.replace(/@@[^@]*@@/g, ''), '@@') > 0) {
    add('stray-token-marker', 'There is a stray `@@` that is not part of a complete token.');
  }

  // -- style modes ---------------------------------------------------------
  for (const inner of blocks(template, '""', '""')) {
    const colon = inner.indexOf(':');
    if (colon === -1) continue; // no `:` is treated as plain text by the engine
    for (const raw of inner.slice(0, colon).split('+')) {
      const mode = raw.trim().toLowerCase();
      if (mode !== '' && !isKnownStyleMode(mode)) {
        add('unknown-style', `\`${mode}\` is not a style mode, so it would do nothing.`);
      }
    }
  }

  // -- length --------------------------------------------------------------
  // Tokens can only make the output longer, so literal text already over the cap
  // is guaranteed truncation.
  if (template.length > maxLengthFor(field)) {
    add(
      'template-too-long',
      `The template is longer than the ${maxLengthFor(field)}-character limit for a ` +
        `${field}, so it would be cut off.`,
    );
  }

  return issues;
}

/**
 * Checks a *rendered* result — the half a structural lint cannot see
 * (`plans/assisted_templates.md` §4).
 *
 * @param rendered   the engine's output, already clamped
 * @param unclamped  the same render with the clamp lifted, to detect truncation
 */
export function inspectRendered(
  rendered: string,
  unclamped: string,
  field: TemplateField,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  // The renderer substitutes `-` for an empty name. A name made only of a
  // no-else conditional hits this whenever the condition is false, which is
  // exactly the case an admin never sees while testing.
  if (field === 'name' && (rendered === '' || rendered === '-')) {
    issues.push({
      code: 'renders-empty',
      message:
        'This name renders to nothing (the channel would show a bare `-`). A name always ' +
        'needs some ordinary text outside any conditional. If they truly want something ' +
        'that disappears, put it in the status instead and say so.',
    });
  }
  if (/@@|\{\{|\}\}|\[\[|\]\]|""/.test(rendered)) {
    issues.push({
      code: 'renders-unsubstituted',
      message: 'The rendered output still contains template markers, so something did not resolve.',
    });
  }
  if (unclamped.length > maxLengthFor(field)) {
    issues.push({
      code: 'renders-truncated',
      message:
        `The rendered ${field} is ${unclamped.length} characters, over the ` +
        `${maxLengthFor(field)}-character limit, so it would be cut off. Make it shorter.`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Safety screen
// ---------------------------------------------------------------------------

export type SafetyCode = 'invite-link' | 'url' | 'mass-mention' | 'control-characters';

export interface SafetyViolation {
  code: SafetyCode;
  /** The offending text, for the log and the operator. */
  match: string;
}

const INVITE_RE = /(?:discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg)\/[^\s]+/gi;
// Explicit URLs, plus a bare `domain.tld/path`. The trailing slash-and-path is
// what keeps this off ordinary names: "Squad.io night" is not a link, but
// "twitch.tv/someone" in a generated channel name is an advert.
const URL_RE = /(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\/[^\s]*/gi;
const MASS_MENTION_RE = /@(?:everyone|here)/gi;
// C0/C1 controls plus the zero-width and bidi-override ranges used to disguise
// text (a name that reads one way and copies another).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Screens a model-generated template for things the admin did not ask for
 * (`plans/assisted_templates.md` §9 "not yet probed": the risk is not the token
 * bill, it is one screenshot).
 *
 * The asymmetry that makes this worth having: an admin with Manage Channels can
 * already type any channel name they like via `/template`, so this is not about
 * restricting *them*. It is about the model never **introducing** an invite
 * link, a URL, a mass-mention string, or disguising control characters that were
 * not in the admin's own words. Anything they typed themselves passes through.
 */
export function screenTemplate(template: string, request: string): SafetyViolation[] {
  const haystack = request.toLowerCase();
  const violations: SafetyViolation[] = [];
  const scan = (re: RegExp, code: SafetyCode): void => {
    for (const match of template.matchAll(re)) {
      const text = match[0];
      // Introduced by the model, not echoed from the admin.
      if (haystack.includes(text.toLowerCase())) continue;
      // The patterns overlap by design (an invite is also a URL). Report the
      // most specific one that fired and don't double up on the same text.
      if (violations.some((v) => v.match.includes(text) || text.includes(v.match))) continue;
      if (!violations.some((v) => v.code === code)) violations.push({ code, match: text });
    }
  };
  scan(INVITE_RE, 'invite-link');
  scan(URL_RE, 'url');
  scan(MASS_MENTION_RE, 'mass-mention');
  scan(CONTROL_RE, 'control-characters');
  return violations;
}
