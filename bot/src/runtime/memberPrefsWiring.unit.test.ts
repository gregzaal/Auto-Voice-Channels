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
    expect(reconciler).toContain('memberRoomPrefsRepo.sweepOrphans({');
    expect(reconciler).toContain('graceMs: MEMBER_PREFS_ORPHAN_GRACE_MS,');
    expect(reconciler).toContain('limit: MEMBER_PREFS_ORPHAN_SWEEP_LIMIT,');
  });

  /** A fleet column would make a fleet's sweep invent orphans out of another fleet's creator channels. */
  it('from a repository with no fleet', () => {
    expect(SOURCE).toContain('const memberRoomPrefsRepo = new MemberRoomPrefsRepository(db);');
  });
});

/**
 * Both readers take the repository as optional, and absent reads as "not counted" and "nothing
 * to clear": a wiring that dropped either would leave the editor's "Clear saved settings"
 * answering that clearing is not available, and the editor and `/channelinfo` showing no count,
 * with every test green because each builds its own service.
 */
describe('the remembered settings repository reaches the admin readouts', () => {
  it('the voice feature, which counts for the editor and /channelinfo', () => {
    expect(statementFrom('const voiceFeature = new VoiceFeature({')).toContain(
      'memberPrefs: memberRoomPrefsRepo,',
    );
  });

  it('the settings service, which clears for the editor', () => {
    expect(statementFrom('const settingsService = new GuildSettingsService({')).toContain(
      'memberPrefs: memberRoomPrefsRepo,',
    );
  });

  it('and nothing else is handed it, so a new consumer has to be added here too', () => {
    expect(SOURCE.split('memberRoomPrefsRepo').length - 1).toBe(
      // the declaration, the sweep, the two readers, and the two services that save
      6,
    );
  });
});

const LEVER = 'memberPrefsDisabled: () => creationGate.memberPrefsDisabled()';

/**
 * Saving and restoring each take their dependency as optional, and absent reads as "off": a
 * consumer that was never handed the repository saves nothing, and one that was never handed the
 * lever keeps saving through the incident `member_prefs.disabled` was thrown for. Every test
 * builds its own wiring, so none of them could notice.
 */
describe('remembered room settings are saved by the services that change a room', () => {
  it('the commands that set a limit and a name, with the lever that stops what they store', () => {
    const commands = statementFrom('const voiceCommands = new VoiceCommands({');
    expect(commands).toContain('memberPrefs: memberRoomPrefsRepo,');
    expect(commands).toContain(LEVER);
  });

  it('the privacy service, which saves a lock or a hide and takes a privacy back out', () => {
    const service = statementFrom('const privacy = new PrivacyService({');
    expect(service).toContain('memberPrefs: memberRoomPrefsRepo,');
    expect(service).toContain(LEVER);
  });

  it('and the lever is handed to exactly those two, so a third saver has to be added here too', () => {
    expect(SOURCE.split(LEVER).length - 1).toBe(2);
  });
});
