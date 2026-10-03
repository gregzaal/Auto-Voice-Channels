import type { RoomAccess } from '@avc/core';
import { describe, expect, it } from 'vitest';
import { roomMode, type RoomMode } from './roomMode.js';

const room = (isPrivate: boolean | undefined, access: RoomAccess | null) => ({
  state: isPrivate === undefined ? {} : { private: isPrivate },
  access,
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

  it('reads a record this build cannot read as unknown, never as a locked or public room', () => {
    for (const isPrivate of [true, false, undefined]) {
      expect(roomMode(room(isPrivate, null), { accessReadable: false })).toBe('unknown');
    }
    // Even if something did parse: the caller's word that it could not read it stands.
    expect(roomMode(room(true, { hidden: true }), { accessReadable: false })).toBe('unknown');
  });

  it('reads an explicitly readable record as the record says', () => {
    expect(roomMode(room(true, null), { accessReadable: true })).toBe('locked');
    expect(roomMode(room(undefined, null), { accessReadable: true })).toBe('public');
  });
});
