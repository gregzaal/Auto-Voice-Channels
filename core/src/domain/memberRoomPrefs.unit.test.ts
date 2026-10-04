import { describe, expect, it } from 'vitest';
import {
  MAX_MEMBER_PREF_LIMIT,
  MAX_MEMBER_PREF_NAME_LENGTH,
  MAX_MEMBER_PREF_STATUS_LENGTH,
  MEMBER_PREFS_ORPHAN_GRACE_MS,
  MEMBER_PREFS_ORPHAN_SWEEP_LIMIT,
} from './memberRoomPrefs.js';

/**
 * The numbers `docs/operations.md` and the schema comments state in words. A change to one is
 * a change to what an operator was told and to what the Privacy page will describe, so it has
 * to be made on purpose and here as well as there.
 */
describe('remembered room settings limits', () => {
  it('keeps an orphan for seven days, counted from when its creator channel went', () => {
    expect(MEMBER_PREFS_ORPHAN_GRACE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('deletes at most 500 rows per pass of the orphan sweep', () => {
    expect(MEMBER_PREFS_ORPHAN_SWEEP_LIMIT).toBe(500);
  });

  it('remembers a name and a status up to what /name accepts, and a limit up to what Discord allows', () => {
    expect(MAX_MEMBER_PREF_NAME_LENGTH).toBe(1000);
    expect(MAX_MEMBER_PREF_STATUS_LENGTH).toBe(1000);
    expect(MAX_MEMBER_PREF_LIMIT).toBe(99);
  });
});
