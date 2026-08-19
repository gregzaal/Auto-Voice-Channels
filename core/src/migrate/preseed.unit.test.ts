import { describe, expect, it } from 'vitest';
import { retryAfterSeconds } from './preseed.js';

/**
 * The back-off arithmetic, which is the part of the pre-seed pass that can hurt
 * something other than itself.
 *
 * It runs against the production token during a cutover window, so getting this
 * wrong does not fail the migration, it gets the token rate limited in the one
 * hour that cannot absorb it. None of it was covered until an adversarial
 * review measured the NaN path firing in three milliseconds.
 */
describe('retryAfterSeconds', () => {
  it('reads the ordinary numeric form', () => {
    expect(retryAfterSeconds('5')).toBe(5);
    expect(retryAfterSeconds('0.25')).toBe(0.25);
    expect(retryAfterSeconds('3600')).toBe(3600);
  });

  /**
   * RFC 7231 allows a date, and Cloudflare uses it for the 1015 ban a hammered
   * token earns. `Number(date)` is NaN, and `setTimeout(fn, NaN)` fires
   * immediately, which turned the back-off into a tight retry loop.
   */
  it('reads the HTTP-date form rather than returning NaN', () => {
    const now = Date.parse('2026-08-19T10:00:00Z');
    expect(retryAfterSeconds('Wed, 19 Aug 2026 10:00:30 GMT', now)).toBe(30);
  });

  /** A date already in the past means "go now", not "go back in time". */
  it('never returns a negative wait', () => {
    const now = Date.parse('2026-08-19T10:00:00Z');
    expect(retryAfterSeconds('Wed, 19 Aug 2026 09:59:00 GMT', now)).toBe(0);
  });

  /** Anything unparseable waits a sane interval instead of hammering. */
  it('falls back rather than returning NaN', () => {
    for (const header of [null, '', 'soon', 'later please']) {
      const value = retryAfterSeconds(header);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  /**
   * The specific arithmetic that made the old code dangerous. Kept as an
   * assertion so nobody reintroduces `Number(header)` on its own.
   */
  it('does not produce a value that setTimeout would treat as zero', () => {
    expect(Number.isNaN(Math.min(30, retryAfterSeconds('Wed, 21 Oct 2015 07:28:00 GMT')))).toBe(
      false,
    );
  });
});
