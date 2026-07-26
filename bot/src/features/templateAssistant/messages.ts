/**
 * User-facing copy for `/templateassistant`.
 *
 * Written to `plans/assisted_templates.md` §5.1, which is explicit about the
 * tone: the cap is an infrastructure backstop, **not a product tier**, so none
 * of this may read as an upsell. There is nothing to upsell to. Every tier gets
 * the same allowance and paying more does not raise it, so both cap messages
 * say so outright and the refusal hands back the manual path rather than simply
 * stopping the admin.
 *
 * Follows the site's copy rules (sentence case, no em or en dashes, no prose
 * semicolons, straight quotes) since this is the same voice the admin meets on
 * auto-voice.io.
 */

const DOCS_TOKENS = 'auto-voice.io/docs/name-templates';

/**
 * The soft notice, appended to a normal successful result once the guild passes
 * the notice threshold. Never blocks anything, and is silent below the
 * threshold so ordinary use never learns a limit exists.
 */
export function capNoticeMessage(used: number, limit: number): string {
  return (
    `Heads up, that is ${used} of ${limit} AI builds this month for this server. ` +
    `The cap resets on the 1st. It is not a paid limit, every plan gets the same ${limit}, ` +
    'it is just there so a stuck loop cannot run up a bill.'
  );
}

/** The refusal at the cap. */
export function capReachedMessage(limit: number): string {
  return (
    `This server has used all ${limit} AI builds this month. The cap resets on the 1st.\n\n` +
    'This is not a paid feature and upgrading will not raise it, every plan gets the same ' +
    `${limit}. The limit only exists so a runaway loop cannot run up a bill on our side.\n\n` +
    `You can still set names by hand with \`/template\`, and the full token reference is at ${DOCS_TOKENS}.`
  );
}

/** No API key configured (self-host default), or the `ai.disabled` lever is on. */
export function assistantUnavailableMessage(selfHosted: boolean): string {
  if (selfHosted) {
    return (
      'The template assistant is not configured on this instance. Set `AVC_AI_API_KEY` (and ' +
      'optionally `AVC_AI_BASE_URL` and `AVC_AI_MODEL`) to point it at any OpenAI-compatible ' +
      'endpoint, including a local one, then restart.\n\n' +
      `You can always set names by hand with \`/template\`. Token reference: ${DOCS_TOKENS}.`
    );
  }
  return (
    'The template assistant is temporarily switched off. You can still set names by hand ' +
    `with \`/template\`, and the full token reference is at ${DOCS_TOKENS}.`
  );
}

/** The provider was unreachable or kept failing. The build is refunded. */
export function providerFailureMessage(): string {
  return (
    'The assistant could not reach the model just now, so nothing was used from this ' +
    "server's monthly allowance. Try again in a moment, or set the name by hand with " +
    '`/template`.'
  );
}

/** The model answered, repeatedly, with something that would not render correctly. */
export function invalidProposalMessage(): string {
  return (
    'The assistant could not build a working template for that. Try describing it a ' +
    `different way, or set it by hand with \`/template\`. Token reference: ${DOCS_TOKENS}.`
  );
}

/**
 * The model produced something it had no business producing (a link, an
 * `@everyone`, disguising characters) that the admin had not typed themselves.
 * Deliberately not detailed: the useful action is rewording, and echoing the
 * offending text back is how it would end up in a screenshot anyway.
 */
export function unsafeProposalMessage(): string {
  return (
    'The assistant produced something that is not allowed in a generated name, so it was ' +
    'discarded. Try rewording your request, or set the name by hand with `/template`.'
  );
}

/** The fleet-wide spend ceiling tripped. Nothing the admin did, and not their fault. */
export function budgetExhaustedMessage(): string {
  return (
    'The template assistant is paused right now for reasons on our side, not anything to ' +
    'do with this server or its plan. It will be back shortly. In the meantime you can set ' +
    `names by hand with \`/template\`, and the token reference is at ${DOCS_TOKENS}.`
  );
}
