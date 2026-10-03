import type { RoomAccess } from '@avc/core';
import { describe, expect, it } from 'vitest';
import { roomMode, type RoomMode } from './roomMode.js';

const room = (isPrivate: boolean | undefined, access: RoomAccess | null) => ({
  state: isPrivate === undefined ? {} : { private: isPrivate },
  access: { readable: true, access } as const,
});

describe('roomMode', () => {
  it.each<[string, boolean | undefined, RoomAccess | null, RoomMode]>([
    ['nothing recorded', undefined, null, 'public'],
    ['private false', false, null, 'public'],
    ['a record that is not hidden, and no private', undefined, { trusted: ['u1'] }, 'public'],
    ['private and no record: what an older build leaves', true, null, 'locked'],
    ['private and a record that is not hidden', true, { trusted: ['u1'] }, 'locked'],
    ['private and hidden', true, { hidden: true }, 'hidden'],
    ['hidden false beside private', true, { hidden: false }, 'locked'],
  ])('reads %s as %s', (_what, isPrivate, access, expected) => {
    expect(roomMode(room(isPrivate, access))).toBe(expected);
  });

  /**
   * The defect: a stale whole-state write drops `private` from a hidden room, and a
   * reader that trusted `private` alone would call it public and offer to lock it.
   */
  it('reads a room hidden even when a stale write has dropped private from it', () => {
    expect(roomMode(room(undefined, { hidden: true }))).toBe('hidden');
    expect(roomMode(room(false, { hidden: true }))).toBe('hidden');
  });

  /**
   * The read carries whether the record could be read, so there is no way to hand
   * this a room's own `access` (null for an unreadable record too) and get a locked
   * or public answer for what may be a hidden room.
   */
  it('reads a record this build cannot read as unknown, never as a locked or public room', () => {
    for (const isPrivate of [true, false, undefined]) {
      expect(
        roomMode({
          state: isPrivate === undefined ? {} : { private: isPrivate },
          access: { readable: false },
        }),
      ).toBe('unknown');
    }
  });
});
