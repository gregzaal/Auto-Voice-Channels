import { describe, expect, it } from 'vitest';
import { cutWellFormed, wellFormed, wellFormedJson } from './wellFormed.js';

describe('wellFormed', () => {
  it('replaces each lone half and keeps whole pairs', () => {
    expect(wellFormed('a\uD83C b\uDC00 😀')).toBe('a\uFFFD b\uFFFD 😀');
    expect(wellFormed('\uDC00\uD83C')).toBe('\uFFFD\uFFFD');
    expect(wellFormed('plain')).toBe('plain');
  });
});

describe('cutWellFormed', () => {
  it('backs off one unit rather than end on the first half of a pair', () => {
    expect(cutWellFormed('ab😀', 3)).toBe('ab');
    expect(cutWellFormed('ab😀', 4)).toBe('ab😀');
    expect(cutWellFormed('abc', 2)).toBe('ab');
    expect(cutWellFormed('abc', 0)).toBe('');
  });
});

describe('wellFormedJson', () => {
  it('repairs strings at any depth, keys included', () => {
    expect(
      wellFormedJson({ a: 'x\uD83C', list: ['y\uDC00', ['z\uD83D']], ['k\uD83C']: { n: 'ok' } }),
    ).toEqual({ a: 'x\uFFFD', list: ['y\uFFFD', ['z\uFFFD']], ['k\uFFFD']: { n: 'ok' } });
  });

  it('keeps null, numbers and booleans as they are', () => {
    expect(wellFormedJson({ a: null, b: 0, c: 1.5, d: false, e: true })).toEqual({
      a: null,
      b: 0,
      c: 1.5,
      d: false,
      e: true,
    });
    expect(wellFormedJson(null)).toBeNull();
    expect(wellFormedJson(3)).toBe(3);
  });

  it('does not change what it was given', () => {
    const input = { a: 'x\uD83C', list: ['y\uDC00'] };
    wellFormedJson(input);
    expect(input).toEqual({ a: 'x\uD83C', list: ['y\uDC00'] });
  });

  /** A key a newer build wrote must survive, including one named like a prototype. */
  it('keeps every key, __proto__ included, without touching the prototype', () => {
    const input = JSON.parse('{"__proto__": {"x": 1}, "future": {"y": "z\uD83C"}}') as Record<
      string,
      unknown
    >;
    const out = wellFormedJson(input);
    expect(Object.keys(out)).toEqual(['__proto__', 'future']);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"x":1},"future":{"y":"z\uFFFD"}}');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});
