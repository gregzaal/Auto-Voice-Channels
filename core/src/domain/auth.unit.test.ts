import { describe, expect, it } from 'vitest';
import { AUTH_STATUSES, isAuthStatus, isEntitled } from './auth.js';

describe('isEntitled', () => {
  it('allows trial and active when not self-hosted', () => {
    expect(isEntitled({ status: 'trial', selfHosted: false })).toBe(true);
    expect(isEntitled({ status: 'active', selfHosted: false })).toBe(true);
  });

  it('grace keeps a guild fully entitled (the leniency buffer)', () => {
    expect(isEntitled({ status: 'grace', selfHosted: false })).toBe(true);
    expect(isEntitled({ status: 'grace', selfHosted: true })).toBe(true);
  });

  it('denies expired when not self-hosted', () => {
    expect(isEntitled({ status: 'expired', selfHosted: false })).toBe(false);
  });

  it('always allows non-blocked guilds when self-hosted', () => {
    expect(isEntitled({ status: 'expired', selfHosted: true })).toBe(true);
    expect(isEntitled({ status: 'trial', selfHosted: true })).toBe(true);
  });

  it('blocked is never entitled, even when self-hosted (kill-switch precedence)', () => {
    expect(isEntitled({ status: 'blocked', selfHosted: false })).toBe(false);
    expect(isEntitled({ status: 'blocked', selfHosted: true })).toBe(false);
  });
});

describe('isAuthStatus', () => {
  it('recognises valid statuses', () => {
    for (const s of AUTH_STATUSES) expect(isAuthStatus(s)).toBe(true);
  });
  it('rejects invalid values', () => {
    expect(isAuthStatus('paused')).toBe(false);
    expect(isAuthStatus(42)).toBe(false);
    expect(isAuthStatus(undefined)).toBe(false);
  });
});
