import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_BLOCKED,
  MAX_SAVED_TRUSTED,
  MEMBER_ACCESS_KINDS,
  parseRoomAccess,
  readRoomAccess,
  roomAccessSchema,
} from './roomAccess.js';

const full = {
  creatorId: '1418271927263854593',
  hidden: true,
  baseline: { view: 'allow', connect: 'none' },
  neutralised: [{ roleId: '1418271927263854600', view: 'allow' }],
  neutralisedConnect: ['1418271927263854600'],
  viewerRoleId: '1418271927263854601',
  trusted: ['u1', 'u2'],
  blocked: ['u3'],
  admitted: ['u4'],
  kicked: ['u5'],
  pending: { mode: 'locked', at: 1_788_000_000_000 },
} as const;

describe('roomAccessSchema', () => {
  it('accepts an empty record and a fully populated one', () => {
    expect(roomAccessSchema.safeParse({}).success).toBe(true);
    expect(roomAccessSchema.safeParse(full).success).toBe(true);
  });

  it('reads the roles a lock took Connect from, and refuses a list that is not ids', () => {
    expect(parseRoomAccess({ neutralisedConnect: ['r1', 'r2'] })).toEqual({
      neutralisedConnect: ['r1', 'r2'],
    });
    expect(roomAccessSchema.safeParse({ neutralisedConnect: [1] }).success).toBe(false);
    // An older build that has never heard of the field still reads the rest of the record.
    expect(parseRoomAccess({ hidden: true, neutralisedConnect: ['r1'] })).toMatchObject({
      hidden: true,
    });
  });

  /**
   * Every top-level field optional is what lets a build that has never heard of
   * one still read the rest, and an absent baseline bit means "unknown", not
   * "none".
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
    expect(roomAccessSchema.safeParse({ kicked: 'u1' }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ creatorId: 123 }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ baseline: { view: 'maybe' } }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ neutralised: [{ roleId: 'r' }] }).success).toBe(false);
    expect(roomAccessSchema.safeParse({ neutralised: [{ view: 'allow' }] }).success).toBe(false);
  });

  /**
   * A pending exit is the one field the converge pass cannot act without a mode for, and
   * the one a newer build might widen: a mode this build does not know fails the record,
   * like every enum here, so a writer never replaces what it could not read.
   */
  describe('a pending exit', () => {
    it('reads with or without a timestamp, and keeps an unknown key beside it', () => {
      expect(parseRoomAccess({ pending: { mode: 'public' } })).toEqual({
        pending: { mode: 'public' },
      });
      expect(parseRoomAccess({ pending: { mode: 'locked', at: 5, by: 'x' } })).toEqual({
        pending: { mode: 'locked', at: 5, by: 'x' },
      });
    });

    it('is not readable when it names no mode, or one this build does not know', () => {
      for (const bad of [
        { pending: {} },
        { pending: { at: 5 } },
        { pending: { mode: 'sealed' } },
        { pending: { mode: 'locked', at: 'now' } },
        { pending: 'locked' },
      ]) {
        expect(readRoomAccess(bad), JSON.stringify(bad)).toEqual({ readable: false });
      }
    });
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

/**
 * What a WRITER needs that `parseRoomAccess` does not say: a column with nothing
 * in it is not the same as a blob that is there and unreadable, because only the
 * first is safe to write over.
 */
describe('readRoomAccess', () => {
  it('reads an empty column as readable with no record', () => {
    expect(readRoomAccess(null)).toEqual({ readable: true, access: null });
    expect(readRoomAccess(undefined)).toEqual({ readable: true, access: null });
  });

  it('reads a valid record as readable', () => {
    expect(readRoomAccess(full)).toEqual({ readable: true, access: full });
    expect(readRoomAccess({})).toEqual({ readable: true, access: {} });
  });

  it('reads a blob that is there but does not parse as unreadable', () => {
    for (const bad of [
      'hidden',
      42,
      true,
      [],
      { hidden: 'yes' },
      { trusted: 'u1' },
      { baseline: { view: 'inherit' } },
      { hidden: true, neutralised: [{ roleId: 'r', view: 'inherit' }] },
    ]) {
      expect(readRoomAccess(bad), JSON.stringify(bad)).toEqual({ readable: false });
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
