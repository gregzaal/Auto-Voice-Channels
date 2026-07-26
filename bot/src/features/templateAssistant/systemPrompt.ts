import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The assistant's system prompt — the **stable prefix** of every request
 * (`plans/assisted_templates.md` §3): automatic prompt caching is prefix-matched
 * on request shape, so this must stay byte-identical call to call and the
 * variable per-request context must go in the user turn, never in here.
 *
 * Kept as markdown next to the code that uses it, and next to the token
 * reference it documents, because it has to be re-read and re-edited by hand
 * whenever the engine gains a token (§8). `tsc` does not copy it, so
 * `bot/scripts/copy-assets.mjs` places it beside this module in `dist/` — the
 * same relative path resolves under `tsx`, vitest, and the container.
 *
 * Read eagerly: a packaging mistake then fails loudly at boot rather than at
 * some admin's first `/templateassistant`, matching the repo's fail-fast posture.
 */
export const TEMPLATE_ASSISTANT_SYSTEM_PROMPT = readFileSync(
  resolve(here, 'systemPrompt.md'),
  'utf8',
);
