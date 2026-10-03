import type { RoomAccess } from '@avc/core';
import { describe, expect, it } from 'vitest';
import type { AccessFacts } from './accessPlan.js';
import {
  recordWithFacts,
  sameFacts,
  withMember,
  withoutMember,
  withoutPending,
  withPending,
} from './accessRecord.js';

const facts = (over: Partial<AccessFacts> = {}): AccessFacts => ({
  baseline: null,
  baselineCaptured: null,
  neutralised: [],
  viewerRoleId: null,
  trusted: [],
  admitted: [],
  blocked: [],
  hidden: false,
  ...over,
});

describe('recordWithFacts', () => {
  it('writes every decided field into an empty record', () => {
    expect(
      recordWithFacts(
        null,
        facts({
          baseline: { view: 'allow', connect: 'none' },
          neutralised: [{ roleId: 'r1', view: 'allow' }],
          viewerRoleId: 'mods',
          trusted: ['t'],
          admitted: ['a'],
          blocked: ['b'],
          hidden: true,
        }),
      ),
    ).toEqual({
      baseline: { view: 'allow', connect: 'none' },
      neutralised: [{ roleId: 'r1', view: 'allow' }],
      viewerRoleId: 'mods',
      trusted: ['t'],
      admitted: ['a'],
      blocked: ['b'],
      hidden: true,
    });
  });

  /** The creator, the kicked and a field a newer build wrote are not the plan's to touch. */
  it('keeps what it does not decide, a field a newer build wrote included', () => {
    const current: RoomAccess = {
      creatorId: 'u1',
      kicked: ['k'],
      futureThing: { a: 1 },
      hidden: true,
      blocked: ['old'],
    };
    expect(recordWithFacts(current, facts({ blocked: ['new'] }))).toEqual({
      creatorId: 'u1',
      kicked: ['k'],
      futureThing: { a: 1 },
      blocked: ['new'],
    });
  });

  it('leaves out an empty list, a cleared baseline and hidden false, rather than writing them', () => {
    const current: RoomAccess = {
      baseline: { view: 'deny' },
      neutralised: [{ roleId: 'r1', view: 'allow' }],
      viewerRoleId: 'mods',
      trusted: ['t'],
      admitted: ['a'],
      blocked: ['b'],
      hidden: true,
    };
    expect(recordWithFacts(current, facts())).toEqual({});
  });

  it('does not change the record it was given', () => {
    const current: RoomAccess = { creatorId: 'u1', trusted: ['t'] };
    recordWithFacts(current, facts({ trusted: ['t', 'u'] }));
    expect(current).toEqual({ creatorId: 'u1', trusted: ['t'] });
  });
});

describe('sameFacts', () => {
  it('says a record is the same when the facts would write what it already holds', () => {
    const current: RoomAccess = { creatorId: 'u1', trusted: ['t'], hidden: true, kicked: ['k'] };
    expect(sameFacts(current, facts({ trusted: ['t'], hidden: true }))).toBe(true);
  });

  it('says no record and no facts is the same, so nothing is created for a public room', () => {
    expect(sameFacts(null, facts())).toBe(true);
  });

  it('reads an empty list or a false flag in the stored record as absent', () => {
    expect(sameFacts({ trusted: [], neutralised: [], hidden: false }, facts())).toBe(true);
  });

  const SAME: Partial<AccessFacts> = { trusted: ['t'], admitted: ['b', 'a'] };

  it('says the same record is the same, so each case below differs by exactly one thing', () => {
    expect(sameFacts({ trusted: ['t'], admitted: ['b', 'a'] }, facts(SAME))).toBe(true);
  });

  it.each<[string, Partial<AccessFacts>]>([
    ['a member added', { trusted: ['t', 'u'] }],
    ['a member removed', { trusted: [] }],
    ['hidden flipped', { hidden: true }],
    ['a baseline captured', { baseline: { view: 'allow' } }],
    ['a role neutralised', { neutralised: [{ roleId: 'r', view: 'allow' }] }],
    ['a moderator role granted', { viewerRoleId: 'mods' }],
    ['a list in a different order', { admitted: ['a', 'b'] }],
  ])('says the record changed for %s', (_what, over) => {
    expect(sameFacts({ trusted: ['t'], admitted: ['b', 'a'] }, facts({ ...SAME, ...over }))).toBe(
      false,
    );
  });
});

describe('withMember', () => {
  it('adds a member to a list, creating the record when there is none', () => {
    expect(withMember(null, 'kicked', 'u9')).toEqual({ kicked: ['u9'] });
    expect(withMember({ creatorId: 'u1', kicked: ['u8'] }, 'kicked', 'u9')).toEqual({
      creatorId: 'u1',
      kicked: ['u8', 'u9'],
    });
  });

  it('is a set: adding twice changes nothing', () => {
    const once = withMember({ admitted: ['u9'] }, 'admitted', 'u9');
    expect(once).toEqual({ admitted: ['u9'] });
  });

  it('touches only the list it names', () => {
    expect(withMember({ trusted: ['t'], admitted: ['a'] }, 'admitted', 'u9')).toEqual({
      trusted: ['t'],
      admitted: ['a', 'u9'],
    });
  });
});

describe('withoutMember', () => {
  it('takes a member out of one list and leaves the rest of the record alone', () => {
    expect(
      withoutMember({ creatorId: 'u1', admitted: ['a', 'u9'], trusted: ['u9'] }, 'admitted', 'u9'),
    ).toEqual({ creatorId: 'u1', admitted: ['a'], trusted: ['u9'] });
  });

  it('leaves a list out when it empties, as the merge does, so an emptied record equals a fresh one', () => {
    expect(withoutMember({ creatorId: 'u1', admitted: ['u9'] }, 'admitted', 'u9')).toEqual({
      creatorId: 'u1',
    });
    expect(withoutMember({ admitted: ['u9'] }, 'admitted', 'u9')).toEqual({});
  });

  it('changes nothing for a member who is not on the list, or a record that is not there', () => {
    const record = { admitted: ['a'] };
    expect(withoutMember(record, 'admitted', 'u9')).toBe(record);
    expect(withoutMember({ trusted: ['u9'] }, 'admitted', 'u9')).toEqual({ trusted: ['u9'] });
    expect(withoutMember(null, 'admitted', 'u9')).toBeNull();
  });

  it('undoes withMember', () => {
    const before = { creatorId: 'u1', admitted: ['a'] };
    expect(withoutMember(withMember(before, 'admitted', 'u9'), 'admitted', 'u9')).toEqual(before);
  });
});

/**
 * A queued exit is marked beside the facts and never inside them: a plan's merge must
 * neither drop it nor write it, and only the write that finalises a change takes it off.
 */
describe('a pending exit', () => {
  it('is added to a record, creating one when there is none, and replaces an earlier one', () => {
    expect(withPending(null, 'public', 7)).toEqual({ pending: { mode: 'public', at: 7 } });
    expect(withPending({ hidden: true, creatorId: 'u1' }, 'locked', 9)).toEqual({
      hidden: true,
      creatorId: 'u1',
      pending: { mode: 'locked', at: 9 },
    });
    expect(withPending({ pending: { mode: 'locked', at: 1 } }, 'public', 2)).toEqual({
      pending: { mode: 'public', at: 2 },
    });
  });

  it('is carried through a plan, which neither writes nor drops it', () => {
    const stored = { hidden: true, pending: { mode: 'locked' as const, at: 4 } };
    expect(recordWithFacts(stored, facts({ hidden: true })).pending).toEqual(stored.pending);
    expect(sameFacts(stored, facts({ hidden: true }))).toBe(true);
  });

  it('comes off without touching anything else, and is the same object when there is none', () => {
    expect(
      withoutPending({ hidden: true, creatorId: 'u1', pending: { mode: 'locked', at: 4 } }),
    ).toEqual({ hidden: true, creatorId: 'u1' });
    expect(withoutPending({ pending: { mode: 'public' } })).toEqual({});
    const plain = { hidden: true };
    expect(withoutPending(plain)).toBe(plain);
    expect(withoutPending(null)).toBeNull();
  });
});
