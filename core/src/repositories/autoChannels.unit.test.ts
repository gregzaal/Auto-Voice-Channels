import { describe, expect, it } from 'vitest';
import { primaryTemplateSchema, startModeOf } from './autoChannels.js';

describe('startModeOf', () => {
  it('reads public, locked and hidden from the stored pair', () => {
    expect(startModeOf({})).toBe('public');
    expect(startModeOf({ defaultPrivate: false })).toBe('public');
    expect(startModeOf({ defaultPrivate: true })).toBe('locked');
    expect(startModeOf({ defaultPrivate: true, defaultHidden: false })).toBe('locked');
    expect(startModeOf({ defaultPrivate: true, defaultHidden: true })).toBe('hidden');
  });

  /**
   * Hidden is a kind of private, so `defaultHidden` on its own is a leftover and not an
   * instruction. An instance that predates the field can switch `defaultPrivate` off and
   * leave it behind, and honouring it would hide the rooms of an admin who went back to
   * public.
   */
  it('reads defaultHidden without defaultPrivate as public', () => {
    expect(startModeOf({ defaultHidden: true })).toBe('public');
    expect(startModeOf({ defaultPrivate: false, defaultHidden: true })).toBe('public');
  });

  it('agrees with what the stored schema returns for a row', () => {
    const template = primaryTemplateSchema.parse({ defaultPrivate: true, defaultHidden: true });
    expect(startModeOf(template)).toBe('hidden');
  });
});
