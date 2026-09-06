/**
 * The channel-name template engine moved to `@avc/core/template` so the
 * marketing site can render real templates through the same code instead of a
 * hand-maintained port (`plans/name-tokens.md` §4.1, §6.1).
 *
 * This file stays as a re-export so every other module in the voice feature and
 * the template assistant keeps importing from where it always did.
 */
export * from '@avc/core/template';
