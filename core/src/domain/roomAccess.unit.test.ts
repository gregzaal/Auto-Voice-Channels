import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_BLOCKED,
  MAX_SAVED_TRUSTED,
  MEMBER_ACCESS_KINDS,
  parseRoomAccess,
  roomAccessSchema,
} from './roomAccess.js';

const full = {
  creatorId: '1418271927263854593',
  hidden: true,
  baseline: { view: 'allow', connect: 'none' },
  neutralised: [{ roleId: '1418271927263854600', view: 'allow' }],
  viewerRoleId: '1418271927263854601',
  trusted: ['u1', 'u2'],
  blocked: ['u3'],
  admitted: ['u4'],
} as const;

describe('roomAccessSchema', () => {
  it('accepts an empty record and a fully populated one', () => {
    expect(roomAccessSchema.safeParse({}).success).toBe(true);
    expect(roomAccessSchema.safeParse(full).success).toBe(true);
  });

  /**
   * Every field optional is what lets a build that has never heard of one still
   * read the rest, and an absent baseline bit means "unknown", not "none".
   */
  it('accepts a baseline with either bit missing, and keeps it missing', () => {
    expect(parseRoomAccess({ baseline: {} })).toEqual({ baseline: {} });
    expect(parseRoomAccess({ baseline: { view: 'deny' } })).toEqual({ baseline: { view: 'deny' } });
    expect(parseRoomAccess({ baseline: { connect: 'none' } })).toEqual({
      baseline: { connect: 'none' },
    });
  });

  it('rejects a value of the wrong shape', () => {
    expect(roomAccessSchema.safeParse({ hidden: 'yes' }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ trusted: [1, 2] }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ creatorId: 123 }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ baseline: { view: 'maybe' } }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ neutralised: [{ roleId: 'r' }] }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ neutralised: [{ view: 'allow' }] }).success).toBe(false);
  });
});

/**
 * Golden rule 3 for this column: an unknown field a newer build wrote survives a
 * read-modify-write by this one. A bare `z.object` would strip it, and nothing
 * would fail, the field would just be gone.
 */
describe('roomAccessSchema preserves unknown fields', () => {
  it('keeps an unknown top-level key', () => {
    expect(parseRoomAccess({ hidden: true, futureThing: { a: 1 } })).toEqual({
      hidden: true,
      futureThing: { a: 1 },
    });
  });

  it('keeps an unknown key inside the baseline and inside a neutralised entry', () => {
    expect(parseRoomAccess({ baseline: { view: 'allow', speak: 'deny' } })).toEqual({
      baseline: { view: 'allow', speak: 'deny' },
    });
    expect(parseRoomAccess({ neutralised: [{ roleId: 'r', view: 'allow', note: 'x' }] })).toEqual({
      neutralised: [{ roleId: 'r', view: 'allow', note: 'x' }],
    });
  });
});

describe('parseRoomAccess', () => {
  it('returns the record unchanged when it is valid', () => {
    expect(parseRoomAccess(full)).toEqual(full);
  });

  /**
   * It must never throw: it runs on every row of a guild listing, and a throw
   * there fails the whole listing over one room's blob.
   */
  it('reads anything that is not a valid record as null, without throwing', () => {
    for (const bad of [
      null,
      undefined,
      'hidden',
      42,
      true,
      [],
      ['hidden'],
      { hidden: 'yes' },
      { trusted: 'u1' },
      { baseline: 'allow' },
      { baseline: { view: 5 } },
    ]) {
      expect(() => parseRoomAccess(bad), JSON.stringify(bad)).not.toThrow();
      expect(parseRoomAccess(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('saved list constants', () => {
  it('caps each list at 25, our own limit and not the Discord overwrite cap', () => {
    expect(MAX_SAVED_TRUSTED).toBe(25);
    expect(MAX_SAVED_BLOCKED).toBe(25);
  });

  it('has the two kinds the table stores', () => {
    expect([...MEMBER_ACCESS_KINDS]).toEqual(['trusted', 'blocked']);
  });
});
