import type { RoomAccess } from '@avc/core';
import { describe, expect, it } from 'vitest';
import type { AccessFacts } from './accessPlan.js';
import { recordWithFacts, sameFacts, withMember } from './accessRecord.js';

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
