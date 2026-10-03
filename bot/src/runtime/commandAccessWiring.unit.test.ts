import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Binds the `command_access.disabled` lever to everything that reads it, by
 * reading `index.ts`'s own source.
 *
 * **An unwired consumer is silent, and that is why this exists.** Every consumer
 * takes the lever as an optional dependency, and absent means "not disabled", so
 * a consumer that was never handed it enforces the rules while the incident
 * lever, thrown precisely because a rule is refusing people it should not, does
 * nothing there and says nothing. `index.ts` is the only place the five (the poster,
 * the interaction handler, the voice feature, the privacy service and `/diagnostics`)
 * are wired together, and no other test sees it.
 *
 * Residual limit, stated rather than papered over: this reads source text, so it
 * proves the wiring is written, not that the gate answers correctly, which is what
 * `creationGate.unit.test.ts` is for.
 *
 * Relative to this file, not to `process.cwd()`: vitest runs from `avc/`, so a
 * cwd-relative path resolves to nothing and the suite silently collapses to zero
 * assertions. The count assertions below are the guard against that.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

const WIRING = 'commandAccessDisabled: () => creationGate.commandAccessDisabled()';

/** The statement that starts at `marker`, up to the `});` that closes it at the same indent. */
function statementFrom(marker: string): string {
  const start = SOURCE.indexOf(marker);
  expect(start, `${marker} is in index.ts`).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf('\n  });', start);
  expect(end, `${marker} is closed`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('the command_access.disabled lever is wired to every consumer', () => {
  it('is handed to the control panel poster, which hides buttons by it', () => {
    expect(statementFrom('const controlPanel = new ControlPanelPoster({')).toContain(WIRING);
  });

  it('is handed to the interaction handler, whose guards and /restrict replies read it', () => {
    expect(statementFrom('registerInteractionHandler({')).toContain(WIRING);
  });

  /** The voice feature reads it off the gate, for the saved nickname a render enforces. */
  it('reaches the voice feature through the creation gate', () => {
    expect(statementFrom('const voiceFeature = new VoiceFeature({')).toContain(
      'gate: creationGate,',
    );
  });

  /**
   * The one rule that reaches saved lists: a member denied Saved lists has lists that apply
   * to nothing. Absent means nobody is restricted, so a service built without it applies a
   * denied member's lists in full, and without the lever in it the rule would go on holding
   * a member's lists back while enforcement is switched off. It reads the lever inside a
   * closure and not through the property the count below looks for, on purpose: it is only
   * asked once a rule names the feature.
   */
  it('is read by the privacy service, which makes a denied member’s saved lists inert by it', () => {
    const privacy = statementFrom('const privacy = new PrivacyService({');
    expect(privacy).toContain('commandAccess: async (gid: string) =>');
    expect(privacy).toContain('readCommandAccess(');
    expect(privacy).toContain('await creationGate.commandAccessDisabled()');
  });

  it('is reported by /diagnostics, per fleet', () => {
    expect(SOURCE).toMatch(
      /commandAccess: \{\s*disabled: runtimeFlags\[RUNTIME_FLAGS\.COMMAND_ACCESS_DISABLED\] === true,\s*\}/,
    );
  });

  it('is wired exactly twice as a function, so a third consumer has to be added here too', () => {
    expect(SOURCE.split(WIRING).length - 1).toBe(2);
  });
});
