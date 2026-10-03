import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Binds the `room_access.disabled` lever to everything that reads it, by reading
 * `index.ts`'s own source, for the reason `commandAccessWiring.unit.test.ts` gives:
 * every consumer takes the lever as an optional dependency and absent means "not
 * disabled", so a consumer that was never handed it keeps hiding rooms and applying
 * lists while the incident lever, thrown precisely because that is misbehaving, does
 * nothing there and says nothing.
 *
 * Residual limit, stated rather than papered over: this reads source text, so it
 * proves the wiring is written, not that the gate answers correctly (that is
 * `creationGate.unit.test.ts`) or that each consumer honours it (that is
 * `privacy.integration.test.ts`).
 *
 * Relative to this file, not to `process.cwd()`: vitest runs from `avc/`, so a
 * cwd-relative path resolves to nothing and the suite silently collapses to zero
 * assertions. The count assertion is the guard against that.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

const WIRING = 'roomAccessDisabled: () => creationGate.roomAccessDisabled()';

/** The statement that starts at `marker`, up to the `});` that closes it at the same indent. */
function statementFrom(marker: string): string {
  const start = SOURCE.indexOf(marker);
  expect(start, `${marker} is in index.ts`).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('\n  });', start);
  expect(end, `${marker} is closed`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('the room_access.disabled lever is wired to every consumer', () => {
  it('is handed to the privacy service, which hides rooms and applies saved lists by it', () => {
    expect(statementFrom('const privacy = new PrivacyService({')).toContain(WIRING);
  });

  it('is reported by /diagnostics, per fleet', () => {
    expect(SOURCE).toMatch(
      /roomAccess: \{\s*disabled: runtimeFlags\[RUNTIME_FLAGS\.ROOM_ACCESS_DISABLED\] === true,\s*\}/,
    );
  });

  it('is wired exactly once as a function, so a second consumer has to be added here too', () => {
    expect(SOURCE.split(WIRING).length - 1).toBe(1);
  });
});
