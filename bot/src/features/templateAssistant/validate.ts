import {
  AT_TOKENS,
  CONDITION_VARIABLES,
  DATE_TOKENS,
  LIST_PREFIX,
  MAX_CHANNEL_NAME_LENGTH,
  LATE_TOKENS,
  MAX_STATUS_LENGTH,
  OPERAND_TOKENS,
} from '../voice/nameTemplate.js';
import { isKnownStyleMode } from '../voice/stringTransforms.js';

/**
 * Validation for a model-proposed template.
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
 * Whether a condition's left side is something the engine can actually resolve:
 * a variable, a token that substitutes a bare integer, or an integer literal.
 *
 * The token half is the part that changed. A token on the left used to be
 * uniformly broken; now the numeric ones work and the rest still do not, so
 * this reads {@link OPERAND_TOKENS} rather than restating the list.
 */
function resolvableOperand(text: string): boolean {
  const t = text.trim();
  return (
    (CONDITION_VARIABLES as string[]).includes(t) ||
    (OPERAND_TOKENS as string[]).includes(t) ||
    /^-?\d+$/.test(t)
  );
}

/** Whether a left side is a token at all, resolvable or not. */
function looksLikeToken(text: string): boolean {
  return text.includes('@@') || text.includes('#');
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
    // `[[list:name]]` is the one form with no `/`: its choices live in the
    // guild's settings rather than in the template. Whether the name exists is
    // a question about the guild, so it belongs in `adviseTemplate`, not here.
    if (inner.trim().startsWith(LIST_PREFIX)) continue;
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
    const variable = variableOf(condition);
    if (variable === '') continue;
    if (resolvableOperand(variable)) continue;
    /**
     * The model's most stubborn failure was putting a
     * token on the left of a condition, which rendered to nothing at all.
     *
     * Counting tokens is no longer the test, because the numeric ones now work.
     * What is still broken is a token that substitutes something other than a
     * bare integer, and it is broken the same silent way, so it keeps a lint of
     * its own with a message that names the ones that do work.
     */
    if (looksLikeToken(variable)) {
      /**
       * Two different reasons a token fails here, and conflating them sends the
       * author looking for the wrong fix. `##` is substituted in time but is
       * not a number; `@@owner@@` would be fine as text but is not substituted
       * until after the condition has already been decided.
       */
      add(
        'token-in-condition',
        (LATE_TOKENS as string[]).includes(variable)
          ? `\`${variable}\` cannot go on the left of a condition: it is filled in ` +
              'after conditions are worked out, so the test never matches. Use the ' +
              '`GAME` variable to test the game. There is no variable for the owner ' +
              "or the stream title, so test the owner's role with `{{ROLE:id ?? …}}` " +
              'instead.'
          : `\`${variable}\` cannot go on the left of a condition: it does not become a ` +
              'plain number, so the test silently never matches. The tokens that can be ' +
              `compared are: ${OPERAND_TOKENS.join(', ')}. (\`##\` renders \`#4\` and ` +
              '`+#` renders `IV`, which is why neither works. Use `$#` for the bare number.)',
      );
      continue;
    }
    add(
      'unknown-variable',
      `\`${variable}\` is not a conditional variable. Use one of: ` +
        `${CONDITION_VARIABLES.join(', ')}, a token from ${OPERAND_TOKENS.join(', ')}, ` +
        'or a plain number.',
    );
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
 * What a guild would need to have configured for a template to render as its
 * author expects. Passed separately from the template because none of it is
 * knowable from the template alone.
 */
export interface TemplateAdviceContext {
  /** The guild's IANA zone, absent when it has never been set. */
  timezone?: string | undefined;
  /** The names of the guild's `[[list:name]]` pools. */
  listNames?: readonly string[] | undefined;
}

/**
 * Advice a structural lint cannot give: the two ways a template that is
 * perfectly well formed still renders wrong because of what the GUILD has (or
 * has not) configured.
 *
 * Separate from {@link lintTemplate}, which is pure structure and is shared by
 * surfaces that have no guild context, and separate from the issue list, which
 * is fed back to the model as a correction. These are notes for a human: the
 * template is accepted either way.
 */
export function adviseTemplate(template: string, ctx: TemplateAdviceContext): string[] {
  const advice: string[] = [];

  if (ctx.timezone === undefined && DATE_TOKENS.some((t) => template.includes(t))) {
    advice.push(
      'Date and time tokens use UTC until a time zone is set for this server, ' +
        'in `/setup` under More settings.',
    );
  }

  const known = new Set(ctx.listNames ?? []);
  for (const inner of blocks(template, '[[', ']]')) {
    const trimmed = inner.trim();
    if (!trimmed.startsWith(LIST_PREFIX)) continue;
    const name = trimmed.slice(LIST_PREFIX.length).trim();
    // A pool that does not exist is not an error the engine can report: the
    // whole `[[list:name]]` prints exactly as written, which reads as the
    // feature being broken rather than as a typo.
    if (!known.has(name)) {
      advice.push(
        `There is no list called \`${name}\`, so \`[[list:${name}]]\` would show up as ` +
          'written. Lists are set up in `/setup` under More settings.',
      );
    }
  }

  return advice;
}

/**
 * Checks a *rendered* result — the half a structural lint cannot see.
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
 * Screens a model-generated template for things the admin did not ask for.
 * Unrequested content can cause harm even when generation costs little.
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
