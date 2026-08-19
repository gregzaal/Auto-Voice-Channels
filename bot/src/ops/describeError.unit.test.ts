import { DiscordAPIError } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { categorizeError, describeError } from './describeError.js';

function apiError(code: number, message: string, status = 403): DiscordAPIError {
  return new DiscordAPIError(
    { code, message } as never,
    code,
    status,
    'POST',
    'https://discord.test',
    {} as never,
  );
}

describe('describeError', () => {
  it('maps a known Discord code to a plain hint plus the technical detail', () => {
    const out = describeError(apiError(50013, 'Missing Permissions'));
    expect(out).toContain("I'm missing the permissions");
    expect(out).toContain('Discord error 50013: Missing Permissions');
  });

  it('falls back to the raw Discord detail for an unmapped code', () => {
    const out = describeError(apiError(40001, 'Unauthorized'));
    expect(out).toBe('Discord error 40001: Unauthorized');
  });

  it('uses the message of a plain Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('handles a non-Error thrown value', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError({ weird: true })).toBe('{"weird":true}');
  });

  it('truncates very long messages', () => {
    const out = describeError(new Error('x'.repeat(1000)));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith('…')).toBe(true);
  });
});

/**
 * The key vocabulary of the `errors` metric. Deliberately coarse: the useful
 * question a chart of errors answers is "did the shape of our failures change",
 * and a category per Discord code would be a cardinality problem answering a
 * question nobody asks.
 */
describe('categorizeError', () => {
  it('separates the permission failures, which are the common operator problem', () => {
    expect(categorizeError(apiError(50013, 'Missing Permissions'))).toBe('permission');
    expect(categorizeError(apiError(50001, 'Missing Access'))).toBe('permission');
  });

  it("names Discord's channel ceiling, which is not our fault and not a permission", () => {
    expect(categorizeError(apiError(30013, 'Maximum number of channels reached'))).toBe(
      'channel_limit',
    );
  });

  it('folds the whole 10xxx family into one "it is gone" bucket', () => {
    expect(categorizeError(apiError(10003, 'Unknown Channel'))).toBe('gone');
    expect(categorizeError(apiError(10007, 'Unknown Member'))).toBe('gone');
    expect(categorizeError(apiError(10999, 'Unknown Something'))).toBe('gone');
  });

  it('reads a 429 as rate limiting whatever code rides with it', () => {
    expect(categorizeError(apiError(0, 'You are being rate limited', 429))).toBe('rate_limit');
  });

  it('keeps any other Discord failure distinct from our own', () => {
    expect(categorizeError(apiError(50035, 'Invalid Form Body'))).toBe('discord');
    expect(categorizeError(new Error('boom'))).toBe('internal');
    expect(categorizeError('a string')).toBe('unknown');
    expect(categorizeError(undefined)).toBe('unknown');
  });

  /**
   * Back-pressure working as designed is not a fault of its own, and counting it
   * with real failures would make a guild that is already failing look several
   * times worse than it is. Coupled to `CircuitBreaker` setting this exact name.
   */
  it('separates our own back-pressure from a real failure', () => {
    const err = new Error('circuit open');
    err.name = 'CircuitOpenError';
    expect(categorizeError(err)).toBe('circuit_open');
  });

  it('agrees with the name CircuitBreaker actually sets', async () => {
    const { CircuitOpenError } = await import('../runtime/circuitBreaker.js');
    expect(categorizeError(new CircuitOpenError(1_000))).toBe('circuit_open');
  });

  /** Every category has to be a stable, low-cardinality key for the metric. */
  it('only ever returns one of the documented categories', () => {
    const allowed = new Set([
      'permission',
      'channel_limit',
      'gone',
      'rate_limit',
      'discord',
      'circuit_open',
      'internal',
      'unknown',
    ]);
    for (const err of [
      apiError(50013, 'x'),
      apiError(30013, 'x'),
      apiError(10003, 'x'),
      apiError(1, 'x', 429),
      apiError(99999, 'x'),
      new Error('x'),
      'x',
      null,
      42,
    ]) {
      expect(allowed).toContain(categorizeError(err));
    }
  });
});
