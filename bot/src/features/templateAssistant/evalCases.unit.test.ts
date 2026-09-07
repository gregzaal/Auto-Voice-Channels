import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type TemplateField } from './validate.js';

/**
 * Structural guard for `eval/cases.json`.
 *
 * The eval harness itself is deliberately outside CI, because it makes real API
 * calls (`plans/assisted_templates.md`). **This is not the harness**: it reads
 * the case file and checks nothing but its shape, so the expensive half stays
 * out of CI while the half that can be checked for free comes in.
 *
 * It exists because a duplicate got through. A scripted edit selected on
 * `group === 'long'`, which matched TWO cases, and rewrote both with the same
 * content: one case was destroyed and the survivor was reported as two. The
 * suite ran 38 cases and scored out of 39 for four commits, and the pair then
 * produced one PASS and one FAIL from byte-identical input, which read as the
 * surviving case being flaky. Nothing about that is visible from a run's score.
 */

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = join(here, '..', '..', '..', '..', 'eval', 'cases.json');

interface EvalCase {
  group?: unknown;
  request?: unknown;
  locale?: unknown;
  expect?: { field?: unknown; contains?: unknown; containsAny?: unknown; notContains?: unknown };
}

const file = JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: EvalCase[] };
const cases = file.cases;

const FIELDS: readonly TemplateField[] = ['name', 'status'];

describe('eval/cases.json is well formed', () => {
  it('has cases at all', () => {
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThan(0);
  });

  /**
   * The one this file was written for. Identical cases are not merely wasted
   * API spend: they inflate the denominator, so a run reports a total the suite
   * cannot reach, and they make the same input answerable two ways in one run.
   */
  it('has no two identical cases', () => {
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    cases.forEach((testCase, index) => {
      const key = JSON.stringify(testCase, Object.keys(testCase).sort());
      const first = seen.get(key);
      if (first === undefined) seen.set(key, index);
      else duplicates.push(`case ${index} is byte-identical to case ${first}`);
    });
    expect(duplicates, duplicates.join('; ')).toEqual([]);
  });

  /**
   * A weaker check than the one above and worth having separately: two cases may
   * legitimately share a request (a different locale, or a `history` making it a
   * refinement), so this reports rather than forbids by asserting the pair
   * differs somewhere other than the request.
   */
  it('never repeats a request with no other difference', () => {
    const byRequest = new Map<string, EvalCase[]>();
    for (const testCase of cases) {
      const key = String(testCase.request);
      byRequest.set(key, [...(byRequest.get(key) ?? []), testCase]);
    }
    for (const [request, group] of byRequest) {
      if (group.length < 2) continue;
      const distinct = new Set(group.map((c) => JSON.stringify(c, Object.keys(c).sort())));
      expect(
        distinct.size,
        `"${request.slice(0, 60)}" repeats with nothing to tell them apart`,
      ).toBe(group.length);
    }
  });

  it('gives every case a group and a request', () => {
    for (const [index, testCase] of cases.entries()) {
      expect(typeof testCase.group, `case ${index} group`).toBe('string');
      expect(String(testCase.group).length, `case ${index} group`).toBeGreaterThan(0);
      expect(typeof testCase.request, `case ${index} request`).toBe('string');
      expect(String(testCase.request).length, `case ${index} request`).toBeGreaterThan(0);
    }
  });

  /**
   * A `field` the runner does not recognise silently skips the template checks,
   * so the case passes while testing nothing. Same for an assertion listing an
   * empty needle, which every string contains.
   */
  it('only names fields and needles the runner can act on', () => {
    for (const [index, testCase] of cases.entries()) {
      const expected = testCase.expect;
      if (!expected) continue;
      if (expected.field !== undefined) {
        expect(FIELDS, `case ${index} field`).toContain(expected.field);
      }
      for (const key of ['contains', 'containsAny', 'notContains'] as const) {
        const needles = expected[key];
        if (needles === undefined) continue;
        expect(Array.isArray(needles), `case ${index} ${key}`).toBe(true);
        for (const needle of needles as unknown[]) {
          expect(typeof needle, `case ${index} ${key}`).toBe('string');
          expect(String(needle).length, `case ${index} ${key} has an empty needle`).toBeGreaterThan(
            0,
          );
        }
      }
    }
  });
});
