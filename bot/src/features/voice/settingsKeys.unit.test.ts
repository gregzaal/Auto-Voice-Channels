import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_SETTINGS_KEYS } from '@avc/core';
import { SETTINGS_KEYS } from './guildSettings.js';

/**
 * Binds the settings allow-list to the export format MECHANICALLY, in the two
 * halves `plans/import_command.md` §3.2 asks for, because one half is not enough.
 *
 * The list lives in two places on purpose: `SETTINGS_KEYS` is here in the bot,
 * beside the readers that give each key its meaning, and `EXPORT_SETTINGS_KEYS`
 * is in `core`, which cannot import this file because it would drag the template
 * engine into `core`. Without this test a twelfth key appears on one side and is
 * silently absent from every export, and nothing fails until a restore.
 *
 * **Half two is the one that matters.** Half one catches a key ADDED to
 * `SETTINGS_KEYS`, which is the disciplined path. The likelier drift is a key
 * introduced as a bare literal in an `updateSettings` patch and never registered
 * anywhere, which half one cannot see at all.
 *
 * Relative to this file, not to `process.cwd()`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_SRC = resolve(HERE, '../..');
const CORE_SRC = resolve(HERE, '../../../../core/src');

/** Settings writes whose object keys this test inspects. */
const WRITE_CALLS = ['updateSettings(', 'patch: {'];

/**
 * Keys legitimately written into the settings blob that are NOT settings the
 * product reads, each with the reason.
 *
 * An entry here is a claim that has to stay true, so keep them few.
 */
const NOT_A_SETTING: Record<string, string> = {};

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(path);
        continue;
      }
      // Production sources only: a test fixture legitimately writes junk keys
      // to prove the jsonb merge works, and exempting each one is noise that
      // would hide a real drift.
      if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
      out.push(path);
    }
  };
  walk(root);
  return out;
}

/** The balanced `{...}` starting at `open`, or null. */
function balancedObject(source: string, open: number): string | null {
  if (source[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * The object literal passed as an argument of the call whose `(` is at `paren`.
 *
 * Bounded to the call's own argument list, which matters: an interface
 * declaration like `updateSettings(guildId: string, patch: Record<string,
 * unknown>)` contains no literal, and a naive "next brace in the file" scan
 * attributed whatever block followed it to this call.
 */
function argumentObject(source: string, paren: number): string | null {
  let depth = 0;
  for (let i = paren; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return null;
    } else if (ch === '{' && depth === 1) {
      return balancedObject(source, i);
    } else if (ch === ';') {
      return null;
    }
  }
  return null;
}

/**
 * Top-level keys of an object literal.
 *
 * Depth-1 only, so a nested object's keys are not mistaken for settings keys.
 * A computed key (`[SETTINGS_KEYS.contact]`) is reported as `computed`, which is
 * always acceptable: it can only be a member of the list by construction.
 */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = 0;
  let atKeyPosition = true;
  while (i < literal.length) {
    const ch = literal[i]!;
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 2 && ch === '[' && atKeyPosition) {
        keys.push('computed');
        // Skip to the matching bracket so the inner expression is not scanned.
        let inner = 1;
        i++;
        while (i < literal.length && inner > 0) {
          if (literal[i] === '[') inner++;
          else if (literal[i] === ']') inner--;
          i++;
        }
        depth--;
        atKeyPosition = false;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      i++;
      continue;
    }
    if (depth === 1) {
      if (ch === ',') {
        atKeyPosition = true;
        i++;
        continue;
      }
      const match = /^([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*[:,}]/.exec(literal.slice(i));
      if (atKeyPosition && match) {
        keys.push(match[1]!.replace(/^['"]|['"]$/g, ''));
        atKeyPosition = false;
        i += match[1]!.length;
        continue;
      }
    }
    i++;
  }
  return keys;
}

describe('settings key allow-list', () => {
  it('is the same list on both sides of the client boundary', () => {
    expect([...Object.values(SETTINGS_KEYS)].sort()).toEqual([...EXPORT_SETTINGS_KEYS].sort());
  });

  it('has no duplicate wire keys', () => {
    const values = Object.values(SETTINGS_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });

  /**
   * The count guard, without which a change to the call shape makes the scan
   * match nothing and this file passes on an empty list.
   */
  it('finds settings writes to inspect', () => {
    const found = sourceFiles(BOT_SRC)
      .concat(sourceFiles(CORE_SRC))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return WRITE_CALLS.some((call) => source.includes(call));
      });
    expect(found.length, 'no settings writes found - has the call shape changed?').toBeGreaterThan(
      2,
    );
  });

  /**
   * Half two: a key written into the blob but registered nowhere is invisible to
   * `/export` forever, and the failure only shows up in a restore.
   */
  it('writes no settings key that is not in the allow-list', () => {
    const allowed = new Set<string>([
      ...Object.values(SETTINGS_KEYS),
      'computed',
      ...Object.keys(NOT_A_SETTING),
    ]);
    const problems: string[] = [];

    for (const file of sourceFiles(BOT_SRC).concat(sourceFiles(CORE_SRC))) {
      const source = readFileSync(file, 'utf8');
      for (const call of WRITE_CALLS) {
        let at = source.indexOf(call);
        while (at !== -1) {
          const literal =
            call === 'updateSettings('
              ? argumentObject(source, at + call.length - 1)
              : balancedObject(source, source.indexOf('{', at));
          if (literal) {
            for (const key of topLevelKeys(literal)) {
              // `patch: {` also matches the settings-cache plumbing, whose only
              // key is the variable being forwarded.
              if (key === 'patch' || key === 'result' || key === 'remove') continue;
              if (!allowed.has(key)) {
                problems.push(`${file.slice(BOT_SRC.length + 1)}: writes settings key '${key}'`);
              }
            }
          }
          at = source.indexOf(call, at + 1);
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('has no stale exemptions', () => {
    const sources = sourceFiles(BOT_SRC)
      .concat(sourceFiles(CORE_SRC))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const key of Object.keys(NOT_A_SETTING)) {
      expect(sources, `exemption '${key}' matches nothing any more`).toContain(`${key}:`);
    }
  });
});
