import { DiscordAPIError } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { describeError } from './describeError.js';

function apiError(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError(
    { code, message } as never,
    code,
    403,
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
