import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Binds the blocked words lever to everything that has to be handed it, by reading
 * `index.ts`'s own source, for the reason `memberPrefsWiring.unit.test.ts` gives: every
 * consumer takes it as optional and absent means "not disabled", so a consumer never handed
 * it is a lever that quietly does nothing there, with every test green because each test
 * builds its own wiring.
 *
 * Residual limit, stated rather than papered over: this reads source text, so it proves the
 * wiring is written, not that the gate answers correctly (that is `creationGate.unit.test.ts`)
 * or that each consumer honours it (each consumer's own tests).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('the word_filter.disabled lever', () => {
  it('is reported by /diagnostics, per fleet', () => {
    expect(SOURCE).toMatch(
      /wordFilter: \{\s*disabled: runtimeFlags\[RUNTIME_FLAGS\.WORD_FILTER_DISABLED\] === true,\s*\}/,
    );
  });

  /** The typed doors and `/blockedwords` read it through the router's dependency. */
  it('reaches the interaction router, through the cached gate', () => {
    expect(SOURCE).toContain('wordFilterDisabled: () => creationGate.wordFilterDisabled(),');
  });

  /** Every render reads it through the gate the voice feature holds. */
  it('reaches the renders, through the gate the voice feature holds', () => {
    const start = SOURCE.indexOf('const voiceFeature = new VoiceFeature({');
    expect(start).toBeGreaterThanOrEqual(0);
    const feature = SOURCE.slice(start, SOURCE.indexOf('\n  });', start));
    expect(feature).toContain('gate: creationGate,');
  });
});
