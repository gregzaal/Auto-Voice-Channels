import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The curly-quote rule, enforced against the SOURCES rather than the rendered
 * strings.
 *
 * Three render-and-assert tests already cover the copy that goes through a
 * builder: `messages.unit.test.ts` for billing, `permissionProblems.unit.test.ts`
 * for problem notices, and `announce.unit.test.ts` for broadcast copy via
 * `checkCopyRules`. None of them reach the biggest surface, which is inline
 * string literals inside discord.js builder chains: command and option
 * descriptions, panel titles, modal labels, and the reply strings in
 * `features/voice`. There is no function to call for those, so the only way to
 * check them is to read the files.
 *
 * That gap let 60 curly characters accumulate across 11 production files,
 * including `/setup` panel titles and most of the voice command replies. A
 * hand-kept list of "strings that must stay clean" rots, which AGENTS.md says
 * explicitly; this does not.
 *
 * **Comments are held to the same standard here, deliberately.** AGENTS.md
 * exempts them, and a check that honoured the exemption would have to strip
 * comments first, which cannot be done reliably with a regex: a line
 * containing `https://` inside a string looks like a line comment, so
 * stripping would hide any violation after it. Holding every line to straight
 * quotes costs nothing (this codebase already has zero elsewhere) and makes
 * the check exact instead of approximately right. Em dashes are NOT checked
 * for the mirror-image reason: comments use them heavily and on purpose, so
 * only a render-time check can judge those.
 */

const CURLY = /[‘’“”]/;

/**
 * `checkCopyRules`'s own character class, which has to contain all four.
 *
 * Matched on content rather than on a file and line number so the exception
 * cannot drift onto some other line during a refactor and quietly excuse a
 * real violation there.
 */
function isTheValidatorItself(line: string): boolean {
  return line.includes('test(text)') && line.includes('contains a curly quote');
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** `bot/src/ops` -> the repo root that holds `bot/` and `core/`. */
const ROOT = join(HERE, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('copy rules, at the source level', () => {
  const files = [
    ...sourceFiles(join(ROOT, 'bot', 'src')),
    ...sourceFiles(join(ROOT, 'core', 'src')),
  ];

  it('finds the sources to check', () => {
    // A wrong ROOT would make every assertion below pass over an empty list,
    // which is the one way this test could fail to do its job silently.
    expect(files.length).toBeGreaterThan(50);
  });

  it('uses no curly quotes or apostrophes anywhere in bot or core sources', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!CURLY.test(line) || isTheValidatorItself(line)) return;
        offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
