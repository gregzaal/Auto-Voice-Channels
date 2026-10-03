import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Binds remembered room settings to everything that has to be handed it, by reading
 * `index.ts`'s own source, for the reason `roomAccessWiring.unit.test.ts` gives: every
 * consumer takes its dependency as optional and absent means "off", so a consumer that was
 * never handed one is a feature that quietly does nothing there, with every test green
 * because each test builds its own wiring.
 *
 * Residual limit, stated rather than papered over: this reads source text, so it proves the
 * wiring is written, not that the gate answers correctly (that is `creationGate.unit.test.ts`)
 * or that each consumer honours it (that is each consumer's own tests).
 *
 * Relative to this file, not to `process.cwd()`: vitest runs from `avc/`, so a cwd-relative
 * path resolves to nothing and the suite silently collapses to zero assertions.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('the member_prefs.disabled lever is reported', () => {
  it('by /diagnostics, per fleet', () => {
    expect(SOURCE).toMatch(
      /memberPrefs: \{\s*disabled: runtimeFlags\[RUNTIME_FLAGS\.MEMBER_PREFS_DISABLED\] === true,\s*\}/,
    );
  });
});

/** The statement that starts at `marker`, up to the `});` that closes it at the same indent. */
function statementFrom(marker: string): string {
  const start = SOURCE.indexOf(marker);
  expect(start, `${marker} is in index.ts`).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('\n  });', start);
  expect(end, `${marker} is closed`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/**
 * The orphan sweep is optional on the reconciler and silent when absent, so a wiring that
 * dropped it would leave the table to grow with every test green: each reconciler test builds
 * its own deps.
 */
describe('the remembered settings orphan sweep is wired', () => {
  it('into the reconciler, with the grace period and a bounded pass', () => {
    const reconciler = statementFrom('const reconciler = new Reconciler({');
    expect(reconciler).toContain('sweepMemberPrefsOrphans: async () => ({');
    expect(reconciler).toContain('memberRoomPrefsRepo.deleteOrphans({');
    expect(reconciler).toContain('olderThanMs: MEMBER_PREFS_ORPHAN_GRACE_MS,');
    expect(reconciler).toContain('limit: MEMBER_PREFS_ORPHAN_SWEEP_LIMIT,');
  });

  /** A fleet column would make a fleet's sweep invent orphans out of another fleet's creator channels. */
  it('from a repository with no fleet', () => {
    expect(SOURCE).toContain('const memberRoomPrefsRepo = new MemberRoomPrefsRepository(db);');
  });
});
