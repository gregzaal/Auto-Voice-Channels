import { describe, expect, it } from 'vitest';
import { checkCopyRules, parseCopy } from './announce.js';

const GOOD = `<!--
  A comment with an em dash — and a "curly quote", neither of which is copy.
-->

=== body ===
## Hello

Some text.

{{PRICING}}

Links: https://auto-voice.io

=== pricing:dormant ===
Free forever.

=== pricing:year ===
Free until {{EXPIRY}}.

=== pricing:short ===
Free until {{EXPIRY}}, shorter for big servers.

=== pricing:active ===
You already pay, nothing changes.
`;

describe('parseCopy', () => {
  it('reads the body and every pricing variant', () => {
    const s = parseCopy(GOOD);
    expect(s.body).toContain('## Hello');
    expect(s.body).toContain('{{PRICING}}');
    expect(Object.keys(s.pricing).sort()).toEqual(['active', 'dormant', 'short', 'year']);
    expect(s.pricing.year).toBe('Free until {{EXPIRY}}.');
  });

  /**
   * The instructions at the top of the copy file are HTML comments and contain
   * exactly the characters the rules ban, because they are explaining the rules.
   * Treating them as copy would fail every run.
   */
  it('strips the HTML comment so its contents are never sent or linted', () => {
    const s = parseCopy(GOOD);
    expect(s.body).not.toContain('curly quote');
    expect(checkCopyRules('body', s.body)).toEqual([]);
  });

  it('refuses a body with no pricing placeholder, which would silently drop the price', () => {
    const bad = GOOD.replace('{{PRICING}}', 'nothing here');
    expect(() => parseCopy(bad)).toThrow(/PRICING/);
  });

  it('refuses a missing pricing variant rather than sending some guilds nothing', () => {
    const bad = GOOD.replace('=== pricing:short ===', '=== pricing:typo ===');
    expect(() => parseCopy(bad)).toThrow(/pricing:short/);
  });

  /**
   * A paying guild told its service is "free until 2027" is worse than one told
   * nothing, so the variant has to exist before a send can start.
   */
  it('refuses copy with no active variant, which would mis-price paying guilds', () => {
    const bad = GOOD.replace('=== pricing:active ===', '=== pricing:unused ===');
    expect(() => parseCopy(bad)).toThrow(/pricing:active/);
  });

  it('refuses a file with no body at all', () => {
    expect(() => parseCopy('=== pricing:year ===\nhi\n')).toThrow(/body/);
  });
});

describe('checkCopyRules', () => {
  it('passes clean copy', () => {
    expect(checkCopyRules('x', 'Straight quotes, a comma, and a full stop.')).toEqual([]);
  });

  it('catches an em dash and an en dash', () => {
    expect(checkCopyRules('x', 'one — two')).toHaveLength(1);
    expect(checkCopyRules('x', 'one – two')).toHaveLength(1);
  });

  it('catches curly quotes, which is what pasting from a doc produces', () => {
    expect(checkCopyRules('x', 'it’s')).toHaveLength(1);
    expect(checkCopyRules('x', '“quoted”')).toHaveLength(1);
  });

  it('catches a prose semicolon', () => {
    expect(checkCopyRules('x', 'one thing; another thing')).toHaveLength(1);
  });

  /** A template like `{{a}};{{b}}` inside backticks is code, not prose. */
  it('allows a semicolon inside a code span', () => {
    expect(checkCopyRules('x', 'Set it to `a;b` and you are done.')).toEqual([]);
  });

  it('reports every distinct problem, not just the first', () => {
    expect(checkCopyRules('x', 'a — b “c” d; e')).toHaveLength(3);
  });
});
