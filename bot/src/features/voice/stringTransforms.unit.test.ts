import { describe, expect, it } from 'vitest';
import { applyMode } from './stringTransforms.js';
import { FONT_MAPS } from './unicodeFonts.generated.js';

describe('applyMode — math font styles', () => {
  it('bold maps letters and digits', () => {
    expect(applyMode('bold', 'Hi 9')).toBe('𝐇𝐢 𝟗');
  });

  it('mono and double map their styled digits', () => {
    expect(applyMode('mono', 'a1')).toBe('𝚊𝟷');
    // 0 → double-struck digit; Z is a double-struck hole → plain Z.
    expect(applyMode('double', '0Z')).toBe('𝟘Z');
  });

  it('italic preserves the legacy hole (no styled lowercase h)', () => {
    // U+1D455 is unassigned; the legacy unicodedata.lookup raised KeyError → plain h.
    expect(applyMode('italic', 'h')).toBe('h');
    expect(applyMode('italic', 'a')).toBe('𝑎');
  });

  it('every math-font style is recognised (maps "A")', () => {
    for (const mode of Object.keys(FONT_MAPS)) {
      expect(applyMode(mode, 'A')).not.toBe('A');
    }
  });
});

describe('applyMode — scaps', () => {
  it('small-caps lowercase letters, leaving holes (x) and uppercase alone', () => {
    expect(applyMode('scaps', 'abxq')).toBe('ᴀʙxꞯ');
    expect(applyMode('scaps', 'AB')).toBe('AB');
  });
});

describe('applyMode — uwu (verified against the legacy algorithm)', () => {
  it.each([
    ['really', 'weawwy'],
    ['love', 'wuv'],
    ['the', 'za'],
    ['this', 'dis'],
    ['Hello', 'Hewwo'],
    ['cute nice', 'kawaii suteki'],
    ['monkey', 'myonkey'],
    ['human', 'hooman'],
  ])('uwu(%s) = %s', (input, expected) => {
    expect(applyMode('uwu', input)).toBe(expected);
  });
});

describe('applyMode — usd, rand, and misc', () => {
  it('usd flips and reverses', () => {
    expect(applyMode('usd', 'abc')).toBe('ɔqɐ');
  });

  it('rand is deterministic per text (no rename churn) and case-preserving', () => {
    const a = applyMode('rand', 'hello world');
    expect(applyMode('rand', 'hello world')).toBe(a); // stable
    expect(a.toLowerCase()).toBe('hello world'); // same letters, only case varies
  });

  it('<N>w keeps the first N words', () => {
    expect(applyMode('3w', 'a b c d e')).toBe('a b c');
  });

  it('unknown modes pass the text through unchanged', () => {
    expect(applyMode('definitely-not-a-mode', 'Keep Me')).toBe('Keep Me');
  });
});
