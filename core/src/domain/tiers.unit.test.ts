import { describe, expect, it } from 'vitest';
import { isFreeForever, tierFor, TIERS } from './tiers.js';

describe('tierFor', () => {
  it('maps boundary member counts to the right tier', () => {
    expect(tierFor(0).id).toBe('free');
    expect(tierFor(99).id).toBe('free');
    expect(tierFor(100).id).toBe('s');
    expect(tierFor(999).id).toBe('s');
    expect(tierFor(1_000).id).toBe('m');
    expect(tierFor(9_999).id).toBe('m');
    expect(tierFor(10_000).id).toBe('l');
    expect(tierFor(99_999).id).toBe('l');
    expect(tierFor(100_000).id).toBe('xl');
    expect(tierFor(999_999).id).toBe('xl');
    expect(tierFor(1_000_000).id).toBe('xxl');
    expect(tierFor(50_000_000).id).toBe('xxl');
  });

  it('clamps negative / non-finite counts to the free tier', () => {
    expect(tierFor(-5).id).toBe('free');
    expect(tierFor(Number.NaN).id).toBe('free');
  });

  it('exposes prices matching the monetization plan', () => {
    expect(tierFor(50).pricePerYear).toBe(0);
    expect(tierFor(500).pricePerYear).toBe(19);
    expect(tierFor(5_000).pricePerYear).toBe(59);
    expect(tierFor(50_000).pricePerYear).toBe(399);
    expect(tierFor(500_000).pricePerYear).toBe(1_999);
    expect(tierFor(2_000_000).pricePerYear).toBeNull();
  });

  it('isFreeForever tracks the <100 boundary', () => {
    expect(isFreeForever(99)).toBe(true);
    expect(isFreeForever(100)).toBe(false);
  });

  it('the table is ascending and exhaustive', () => {
    const bounds = TIERS.map((t) => t.maxExclusive);
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));
    expect(TIERS[TIERS.length - 1]!.maxExclusive).toBe(Number.POSITIVE_INFINITY);
  });
});
