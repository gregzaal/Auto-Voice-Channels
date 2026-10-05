import type { RoomAccess } from '@avc/core';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  BOT_ACCESS,
  CONNECT,
  MANAGE_CHANNELS,
  MAX_PLANNED_OVERWRITES,
  MOVE_MEMBERS,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  diffOverwrites,
  joinChannelOverwrites,
  leaveOutMembers,
  planAccess,
  type AccessFacts,
  type AccessMode,
  type AccessPlan,
  type AccessPlanInput,
  type OverwriteBit,
  type ResolvedOverwrite,
} from './accessPlan.js';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;
const SPEAK = PermissionFlagsBits.Speak;
const MUTE = PermissionFlagsBits.MuteMembers;

/** `@everyone`'s role id is the guild id. */
const GUILD = 'g1';
const BOT = 'bot';
const OWNER = 'owner';
const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';
const DAVE = 'dave';
const MODS = 'mods';
const MEMBERS = 'members';
const HELPERS = 'helpers';

const role = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_ROLE,
  allow,
  deny,
});
const member = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_MEMBER,
  allow,
  deny,
});
const everyone = (allow = 0n, deny = 0n): ResolvedOverwrite => role(GUILD, allow, deny);

const m = (id: string): string => `m:${id}`;
const r = (id: string): string => `r:${id}`;

/** An overwrite set as a record, so a test says what it expects without caring about order. */
function view(list: readonly ResolvedOverwrite[]): Record<string, { allow: bigint; deny: bigint }> {
  return Object.fromEntries(
    list.map((o) => [
      `${o.type === OVERWRITE_MEMBER ? 'm' : 'r'}:${o.id}`,
      { allow: o.allow, deny: o.deny },
    ]),
  );
}

type Planned = Extract<AccessPlan, { ok: true }>;

function plan(
  over: Partial<AccessPlanInput> & { mode: AccessMode; previousMode: AccessMode },
): Planned {
  const result = planAccess({
    guildId: GUILD,
    botId: BOT,
    current: [],
    record: null,
    ownerId: OWNER,
    occupants: [],
    trusted: [],
    admitted: [],
    blocked: [],
    ...over,
  });
  if (!result.ok) throw new Error(`plan refused: ${result.reason}`);
  return result;
}

const find = (p: Planned, key: string) => view(p.desired)[key];

/**
 * The record a caller holds after persisting a set of facts. Typed as the stored
 * record on purpose: that the facts are assignable to it, with no cast, is what lets
 * a caller merge them in.
 */
function recordOf(facts: AccessFacts): RoomAccess {
  return {
    ...(facts.baseline ? { baseline: facts.baseline } : {}),
    neutralised: facts.neutralised,
    neutralisedConnect: facts.neutralisedConnect,
    ...(facts.viewerRoleId ? { viewerRoleId: facts.viewerRoleId } : {}),
    trusted: facts.trusted,
    admitted: facts.admitted,
    blocked: facts.blocked,
    hidden: facts.hidden,
  };
}

describe('constants', () => {
  /** This file imports nothing from discord.js, so a typo here would be invisible without this. */
  it('are the bits and types Discord uses', () => {
    expect(V).toBe(PermissionFlagsBits.ViewChannel);
    expect(C).toBe(PermissionFlagsBits.Connect);
    expect(MANAGE_CHANNELS).toBe(PermissionFlagsBits.ManageChannels);
    expect(MOVE_MEMBERS).toBe(PermissionFlagsBits.MoveMembers);
    expect(OVERWRITE_ROLE).toBe(OverwriteType.Role);
    expect(OVERWRITE_MEMBER).toBe(OverwriteType.Member);
  });

  it('keeps the bot allowed what the adapter grants it everywhere else', () => {
    expect(BOT_ACCESS).toBe(V | C | MANAGE_CHANNELS | MOVE_MEMBERS);
  });
});

describe('public to locked', () => {
  it('denies @everyone Connect, lets the owner and occupants in, and blocks', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'public',
      occupants: [ALICE],
      trusted: [BOB],
      admitted: [DAVE],
      blocked: [CAROL],
    });
    expect(view(p.desired)).toEqual({
      [m(BOT)]: { allow: BOT_ACCESS, deny: 0n },
      [m(OWNER)]: { allow: C, deny: 0n },
      [m(ALICE)]: { allow: C, deny: 0n },
      // Connect alone: a lock never touches View, so what a trusted or admitted
      // member can see stays the creator channel's rule (a role-gated server's
      // @everyone View deny is not the owner's to relax).
      [m(BOB)]: { allow: C, deny: 0n },
      [m(DAVE)]: { allow: C, deny: 0n },
      [m(CAROL)]: { allow: 0n, deny: VC },
      [r(GUILD)]: { allow: 0n, deny: C },
    });
    expect(p.facts.hidden).toBe(false);
  });

  it('never touches @everyone View, whatever it holds', () => {
    const p = plan({ mode: 'locked', previousMode: 'public', current: [everyone(0n, V)] });
    expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: V | C });
  });

  /**
   * What `@everyone` held before the lock, so going public restores it. Every shape
   * is a different answer, and `none` is a KNOWN absence, not an unknown.
   */
  it.each<[string, ResolvedOverwrite[], { view: OverwriteBit; connect: OverwriteBit }]>([
    ['no overwrite', [], { view: 'none', connect: 'none' }],
    ['an empty overwrite', [everyone()], { view: 'none', connect: 'none' }],
    ['Connect allowed', [everyone(C)], { view: 'none', connect: 'allow' }],
    ['Connect denied', [everyone(0n, C)], { view: 'none', connect: 'deny' }],
    [
      'View denied (a role-gated creator channel)',
      [everyone(0n, V)],
      { view: 'deny', connect: 'none' },
    ],
    ['View allowed', [everyone(V)], { view: 'allow', connect: 'none' }],
    ['View denied and Connect allowed', [everyone(C, V)], { view: 'deny', connect: 'allow' }],
  ])('captures the baseline from %s', (_name, current, expected) => {
    const p = plan({ mode: 'locked', previousMode: 'public', current });
    expect(p.facts.baselineCaptured).toEqual(expected);
    expect(p.facts.baseline).toEqual(expected);
  });

  it('keeps a baseline it already has and captures only the field it lacks', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'public',
      current: [everyone(0n, C)],
      record: { baseline: { connect: 'allow' } },
    });
    // The live Connect deny is NOT the original: the stored allow wins.
    expect(p.facts.baseline).toEqual({ connect: 'allow', view: 'none' });
    expect(p.facts.baselineCaptured).toEqual({ view: 'none' });
  });

  it('captures nothing when the whole baseline is already stored', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'public',
      record: { baseline: { view: 'none', connect: 'none' } },
    });
    expect(p.facts.baselineCaptured).toBeNull();
    expect(p.facts.baseline).toEqual({ view: 'none', connect: 'none' });
  });

  it('does not grant trusted members anything the owner has not saved', () => {
    const p = plan({ mode: 'locked', previousMode: 'public', ownerId: null });
    expect(view(p.desired)).toEqual({
      [m(BOT)]: { allow: BOT_ACCESS, deny: 0n },
      [r(GUILD)]: { allow: 0n, deny: C },
    });
  });
});

describe('public to hidden', () => {
  it('denies @everyone View and Connect and gives every member an explicit allow', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'public',
      occupants: [ALICE],
      trusted: [BOB],
      admitted: [DAVE],
      blocked: [CAROL],
    });
    expect(view(p.desired)).toEqual({
      [m(BOT)]: { allow: BOT_ACCESS, deny: 0n },
      // The owner by id, although they are not in `occupants`: the move may not
      // have landed in the cache yet.
      [m(OWNER)]: { allow: VC, deny: 0n },
      [m(ALICE)]: { allow: VC, deny: 0n },
      [m(BOB)]: { allow: VC, deny: 0n },
      [m(DAVE)]: { allow: VC, deny: 0n },
      [m(CAROL)]: { allow: 0n, deny: VC },
      [r(GUILD)]: { allow: 0n, deny: VC },
    });
    expect(p.facts.hidden).toBe(true);
    expect(p.skippedRoleIds).toEqual([]);
  });

  it('gives the moderator role View only, never Connect', () => {
    const p = plan({ mode: 'hidden', previousMode: 'public', viewerRoleId: MODS });
    expect(find(p, r(MODS))).toEqual({ allow: V, deny: 0n });
    expect(p.facts.viewerRoleId).toBe(MODS);
  });

  it('captures the baseline of both bits before denying them', () => {
    const p = plan({ mode: 'hidden', previousMode: 'public', current: [everyone(C, 0n)] });
    expect(p.facts.baselineCaptured).toEqual({ view: 'none', connect: 'allow' });
  });

  it('refuses to grant @everyone the moderator View, which would undo the hide', () => {
    const p = plan({ mode: 'hidden', previousMode: 'public', viewerRoleId: GUILD });
    expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: VC });
    expect(p.facts.viewerRoleId).toBeNull();
  });

  describe('roles', () => {
    /** A role's View allow beats the `@everyone` deny, measured on a real client 2026-10-03. */
    it('flips a role View allow to a deny and records what it was', () => {
      const p = plan({
        mode: 'hidden',
        previousMode: 'public',
        current: [role(MEMBERS, VC), role(HELPERS, V | SPEAK)],
      });
      // A hide is a lock too, so the Connect allow is flipped with it (see "role Connect").
      expect(find(p, r(MEMBERS))).toEqual({ allow: 0n, deny: VC });
      // Other bits are untouched.
      expect(find(p, r(HELPERS))).toEqual({ allow: SPEAK, deny: V });
      expect(p.facts.neutralised).toEqual([
        { roleId: HELPERS, view: 'allow' },
        { roleId: MEMBERS, view: 'allow' },
      ]);
      expect(p.facts.neutralisedConnect).toEqual([MEMBERS]);
      expect(p.facts.hidden).toBe(true);
    });

    it('handles @everyone through the baseline and never records it as a neutralised role', () => {
      // Recorded twice, it would be restored twice and by the wrong rule.
      const p = plan({ mode: 'hidden', previousMode: 'public', current: [everyone(VC)] });
      expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: VC });
      expect(p.facts.baselineCaptured).toEqual({ view: 'allow', connect: 'allow' });
      expect(p.facts.neutralised).toEqual([]);
    });

    it('leaves a role with no View allow alone, apart from its Connect allow', () => {
      const p = plan({
        mode: 'hidden',
        previousMode: 'public',
        current: [role('muted', 0n, V), role('talkers', C | SPEAK)],
      });
      expect(find(p, r('muted'))).toEqual({ allow: 0n, deny: V });
      expect(find(p, r('talkers'))).toEqual({ allow: SPEAK, deny: C });
      expect(p.facts.neutralised).toEqual([]);
      expect(p.facts.neutralisedConnect).toEqual(['talkers']);
    });

    it('leaves the moderator role and the bot role alone and does not count them', () => {
      const p = plan({
        mode: 'hidden',
        previousMode: 'public',
        viewerRoleId: MODS,
        leaveRoleId: 'botrole',
        current: [role(MODS, V), role('botrole', V | C)],
      });
      expect(find(p, r(MODS))).toEqual({ allow: V, deny: 0n });
      expect(find(p, r('botrole'))).toEqual({ allow: VC, deny: 0n });
      expect(p.facts.neutralised).toEqual([]);
      expect(p.facts.hidden).toBe(true);
    });

    /**
     * Refused whole and not planned half-way. A hide that went ahead with the
     * `@everyone` deny written and the role still showing the room would be recorded
     * as a lock, and a later /public (which restores `@everyone` View only when it
     * is leaving a hide) would leave a room nobody but that role could see.
     */
    it('refuses a hide that a role it cannot edit would defeat, naming the roles', () => {
      const result = planAccess({
        guildId: GUILD,
        botId: BOT,
        current: [role('200', V), role('30', V | SPEAK), role(MEMBERS, V)],
        mode: 'hidden',
        previousMode: 'public',
        record: null,
        ownerId: OWNER,
        occupants: [],
        trusted: [],
        admitted: [],
        blocked: [],
        uneditableRoleIds: ['200', '30'],
      });
      // In snowflake order, whatever order the caller listed them in.
      expect(result).toEqual({ ok: false, reason: 'role_defeats_hide', defeatedBy: ['30', '200'] });
    });

    it('does not refuse a hide for a role it cannot edit that holds no View allow', () => {
      const p = plan({
        mode: 'hidden',
        previousMode: 'public',
        uneditableRoleIds: ['above-me'],
        current: [role('above-me', C | SPEAK), role('above-too', 0n, V)],
      });
      expect(find(p, r('above-me'))).toEqual({ allow: C | SPEAK, deny: 0n });
      expect(p.facts.hidden).toBe(true);
    });

    it('keeps, and does not refuse over, a role an earlier hide denied that has since become uneditable', () => {
      // The flip is already on the channel: nothing is written for the role now.
      const p = plan({
        mode: 'hidden',
        previousMode: 'hidden',
        uneditableRoleIds: [MEMBERS],
        current: [role(MEMBERS, 0n, V)],
        record: { hidden: true, neutralised: [{ roleId: MEMBERS, view: 'allow' }] },
      });
      expect(p.facts.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);
      expect(p.skippedRoleIds).toEqual([]);
    });

    it('does not count a foreign member allow against the hide', () => {
      // A deliberate per-member grant is somebody letting one person in, which is
      // not the hide failing for everyone else.
      const p = plan({
        mode: 'hidden',
        previousMode: 'public',
        current: [member('friend', V)],
      });
      expect(find(p, m('friend'))).toEqual({ allow: V, deny: 0n });
      expect(p.facts.hidden).toBe(true);
    });

    it('is not hidden unless the mode is hidden', () => {
      const p = plan({ mode: 'locked', previousMode: 'public', current: [role(MEMBERS, V)] });
      // Locked does not touch roles at all, and a role it cannot edit is no concern.
      expect(find(p, r(MEMBERS))).toEqual({ allow: V, deny: 0n });
      expect(p.facts.hidden).toBe(false);
      const unedited = plan({
        mode: 'locked',
        previousMode: 'public',
        current: [role(MEMBERS, V)],
        uneditableRoleIds: [MEMBERS],
      });
      expect(unedited.skippedRoleIds).toEqual([]);
    });
  });
});

describe('locked to hidden', () => {
  it('captures only the View baseline, because the live Connect deny is the lock itself', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'locked',
      current: [everyone(0n, C | V)],
    });
    // Recording the Connect deny would restore a lock as the "original".
    expect(p.facts.baselineCaptured).toEqual({ view: 'deny' });
    expect(p.facts.baseline).toEqual({ view: 'deny' });
  });

  it('keeps the baseline the lock captured', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'locked',
      current: [everyone(0n, C)],
      record: { baseline: { view: 'none', connect: 'allow' } },
    });
    expect(p.facts.baselineCaptured).toBeNull();
    expect(p.facts.baseline).toEqual({ view: 'none', connect: 'allow' });
  });

  it('writes the same hidden set as a public room would get', () => {
    const fromLocked = plan({
      mode: 'hidden',
      previousMode: 'locked',
      current: [everyone(0n, C), member(BOT, BOT_ACCESS), member(OWNER, C), member(ALICE, C)],
      occupants: [ALICE],
    });
    expect(view(fromLocked.desired)).toEqual({
      [m(BOT)]: { allow: BOT_ACCESS, deny: 0n },
      [m(OWNER)]: { allow: VC, deny: 0n },
      [m(ALICE)]: { allow: VC, deny: 0n },
      [r(GUILD)]: { allow: 0n, deny: VC },
    });
  });
});

describe('hidden to locked', () => {
  const hiddenRoom = [
    member(BOT, BOT_ACCESS),
    member(OWNER, VC),
    member(ALICE, VC),
    everyone(0n, VC),
    role(MODS, V),
    role(MEMBERS, 0n, VC),
  ];

  it.each<[OverwriteBit | undefined, bigint, bigint]>([
    ['none', 0n, C],
    ['deny', 0n, VC],
    ['allow', V, C],
    // An unknown baseline clears the bit, which for View is the neutral state.
    [undefined, 0n, C],
  ])('restores @everyone View per a %s baseline and keeps Connect denied', (view_, allow, deny) => {
    const p = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: hiddenRoom,
      occupants: [ALICE],
      viewerRoleId: MODS,
      record: {
        hidden: true,
        baseline: { ...(view_ ? { view: view_ } : {}), connect: 'none' },
        neutralised: [{ roleId: MEMBERS, view: 'allow' }],
        viewerRoleId: MODS,
      },
    });
    expect(find(p, r(GUILD))).toEqual({ allow, deny });
  });

  it('restores the neutralised roles, drops the moderator View, and keeps member grants', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: hiddenRoom,
      occupants: [ALICE],
      viewerRoleId: MODS,
      record: {
        baseline: { view: 'none', connect: 'none' },
        neutralised: [{ roleId: MEMBERS, view: 'allow' }],
        neutralisedConnect: [MEMBERS],
        viewerRoleId: MODS,
      },
    });
    // View goes back, and the lock keeps Connect denied for the role.
    expect(find(p, r(MEMBERS))).toEqual({ allow: V, deny: C });
    expect(p.facts.neutralisedConnect).toEqual([MEMBERS]);
    // The moderator grant was View alone, so taking it back empties the overwrite.
    expect(find(p, r(MODS))).toBeUndefined();
    // The owner and the occupant keep View and Connect: harmless in a locked room.
    expect(find(p, m(OWNER))).toEqual({ allow: VC, deny: 0n });
    expect(find(p, m(ALICE))).toEqual({ allow: VC, deny: 0n });
    expect(p.facts.neutralised).toEqual([]);
    expect(p.facts.viewerRoleId).toBeNull();
    expect(p.facts.hidden).toBe(false);
  });
});

describe('locked or hidden to public', () => {
  it('restores @everyone View and Connect per the baseline and drops the empty overwrite', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: [everyone(0n, VC), member(BOT, BOT_ACCESS)],
      record: { baseline: { view: 'none', connect: 'none' } },
    });
    expect(find(p, r(GUILD))).toBeUndefined();
    expect(p.facts.baseline).toBeNull();
  });

  /**
   * The defect: a locked room whose `private` a stale whole-state write dropped reads as
   * public, a plan for it was public to public, and it cleared the baseline the lock
   * captured. The next lock then recorded its own `@everyone` deny as the original.
   */
  it('keeps the baseline of a room that reads as public but was never opened by an exit', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'public',
      current: [everyone(0n, C), member(BOT, BOT_ACCESS)],
      record: { baseline: { view: 'none', connect: 'allow' } },
    });
    expect(p.facts.baseline).toEqual({ view: 'none', connect: 'allow' });
    expect(p.factsBeforeWrite.baseline).toEqual({ view: 'none', connect: 'allow' });
    // Nothing about `@everyone` is written: only an exit restores it.
    expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: C });
  });

  /** `/public` used to write `Connect: null`, wiping an inherited deny from a role-gated creator channel. */
  it.each<[OverwriteBit, OverwriteBit, ResolvedOverwrite | undefined]>([
    ['deny', 'deny', everyone(0n, VC)],
    ['none', 'deny', everyone(0n, C)],
    ['allow', 'none', everyone(V)],
    ['none', 'allow', everyone(C)],
    ['none', 'none', undefined],
  ])('puts back a %s View and %s Connect baseline exactly', (viewBit, connectBit, expected) => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: [everyone(0n, VC), member(BOT, BOT_ACCESS)],
      record: { baseline: { view: viewBit, connect: connectBit } },
    });
    expect(p.desired.find((o) => o.id === GUILD)).toEqual(expected);
  });

  it('clears Connect with null when the baseline is unknown, as /public always has', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'locked',
      current: [everyone(0n, C)],
      record: null,
    });
    expect(find(p, r(GUILD))).toBeUndefined();
  });

  it('never records the live values as a baseline when it has none', () => {
    const p = plan({ mode: 'public', previousMode: 'locked', current: [everyone(0n, C)] });
    // The live Connect deny is the lock itself. Recording it would restore the
    // lock as the "original" the next time the room is locked and opened.
    expect(p.facts.baseline).toBeNull();
    expect(p.facts.baselineCaptured).toBeNull();
  });

  it('leaves a View overwrite alone when it never wrote one, whether or not it knows the baseline', () => {
    // Only a hide writes `@everyone` View. A human's deny on a locked room is theirs.
    for (const record of [
      null,
      { baseline: { view: 'none' as const, connect: 'none' as const } },
    ]) {
      const p = plan({
        mode: 'public',
        previousMode: 'locked',
        current: [everyone(0n, V | C)],
        record,
      });
      expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: V });
    }
  });

  it('clears View with null too when leaving hidden with an unknown baseline', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: [everyone(0n, VC)],
      record: { hidden: true },
    });
    expect(find(p, r(GUILD))).toBeUndefined();
  });

  it('restores the neutralised roles', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: [everyone(0n, VC), role(MEMBERS, C, V)],
      record: {
        baseline: { view: 'none', connect: 'none' },
        neutralised: [{ roleId: MEMBERS, view: 'allow' }],
      },
    });
    expect(find(p, r(MEMBERS))).toEqual({ allow: VC, deny: 0n });
  });

  it('does not put back a role overwrite a human has deleted or changed since', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: [everyone(0n, VC), role('changed', V, 0n)],
      record: {
        baseline: { view: 'none', connect: 'none' },
        neutralised: [
          { roleId: 'deleted', view: 'allow' },
          { roleId: 'changed', view: 'allow' },
        ],
      },
    });
    // Never recreated, and not flipped again: no longer our flip to undo.
    expect(find(p, r('deleted'))).toBeUndefined();
    expect(find(p, r('changed'))).toEqual({ allow: V, deny: 0n });
  });

  it('leaves trusted overwrites on the room and in the record', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'locked',
      current: [everyone(0n, C), member(BOB, VC), member(DAVE, VC)],
      trusted: [BOB],
      admitted: [DAVE],
      record: { baseline: { connect: 'none' }, trusted: [BOB], admitted: [DAVE] },
    });
    expect(find(p, m(BOB))).toEqual({ allow: VC, deny: 0n });
    expect(find(p, m(DAVE))).toEqual({ allow: VC, deny: 0n });
    expect(p.facts.trusted).toEqual([BOB]);
    expect(p.facts.admitted).toEqual([DAVE]);
  });

  it('writes no grants for the owner or occupants in a public room', () => {
    const p = plan({ mode: 'public', previousMode: 'locked', occupants: [ALICE] });
    expect(find(p, m(OWNER))).toBeUndefined();
    expect(find(p, m(ALICE))).toBeUndefined();
  });

  it('applies blocks in a public room too', () => {
    const p = plan({ mode: 'public', previousMode: 'public', blocked: [CAROL] });
    expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: VC });
    expect(p.facts.blocked).toEqual([CAROL]);
    // And leaves @everyone alone: there is nothing to restore in a room that was
    // not locked.
    expect(find(p, r(GUILD))).toBeUndefined();
  });
});

/**
 * A role's Connect allow beats `@everyone`'s Connect deny, so in a server that gates a category
 * with a role override ("Members: allow View and Connect", copied onto every room) a plain
 * lock locked nobody out. Measured on the dev application 2026-10-05: after `/private`, a member
 * holding that role could still connect. A lock now flips each role's Connect allow, and
 * `/public` puts it back.
 */
describe('role Connect', () => {
  const gated = [everyone(0n, V), role(MEMBERS, VC), role(HELPERS, V | SPEAK)];

  it('is flipped to a deny on a lock, leaving View and every other bit alone', () => {
    const p = plan({ mode: 'locked', previousMode: 'public', current: gated });
    expect(find(p, r(MEMBERS))).toEqual({ allow: V, deny: C });
    // No Connect allow, nothing to flip.
    expect(find(p, r(HELPERS))).toEqual({ allow: V | SPEAK, deny: 0n });
    expect(p.facts.neutralisedConnect).toEqual([MEMBERS]);
    // A lock never touches View, so nothing is recorded for it.
    expect(p.facts.neutralised).toEqual([]);
  });

  it('leaves the owner and the occupants a way in, by member overwrite', () => {
    const p = plan({ mode: 'locked', previousMode: 'public', current: gated, occupants: [ALICE] });
    expect(find(p, m(OWNER))).toEqual({ allow: C, deny: 0n });
    expect(find(p, m(ALICE))).toEqual({ allow: C, deny: 0n });
  });

  it('leaves @everyone to its baseline and the bot role alone', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'public',
      current: [everyone(C), role('botrole', VC), role(MEMBERS, C)],
      leaveRoleId: 'botrole',
    });
    expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: C });
    expect(find(p, r('botrole'))).toEqual({ allow: VC, deny: 0n });
    expect(p.facts.neutralisedConnect).toEqual([MEMBERS]);
    expect(p.facts.baselineCaptured).toEqual({ view: 'none', connect: 'allow' });
  });

  it('is put back by /public, and the record forgets it', () => {
    const locked = plan({ mode: 'locked', previousMode: 'public', current: gated });
    const out = plan({
      mode: 'public',
      previousMode: 'locked',
      current: locked.desired,
      record: recordOf(locked.facts),
    });
    expect(find(out, r(MEMBERS))).toEqual({ allow: VC, deny: 0n });
    expect(out.facts.neutralisedConnect).toEqual([]);
  });

  it('survives a lock turning into a hide, and a hide turning back into a lock', () => {
    const locked = plan({ mode: 'locked', previousMode: 'public', current: gated });
    const hidden = plan({
      mode: 'hidden',
      previousMode: 'locked',
      current: locked.desired,
      record: recordOf(locked.facts),
    });
    expect(find(hidden, r(MEMBERS))).toEqual({ allow: 0n, deny: VC });
    expect(hidden.facts.neutralisedConnect).toEqual([MEMBERS]);
    const back = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: hidden.desired,
      record: recordOf(hidden.facts),
    });
    expect(find(back, r(MEMBERS))).toEqual({ allow: V, deny: C });
    expect(back.facts.neutralisedConnect).toEqual([MEMBERS]);
  });

  it('is flipped again when somebody gives the role its Connect allow back, as a hide is', () => {
    const locked = plan({ mode: 'locked', previousMode: 'public', current: gated });
    const edited = locked.desired.map((o) => (o.id === MEMBERS ? role(MEMBERS, VC) : o));
    const again = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: edited,
      record: recordOf(locked.facts),
    });
    expect(find(again, r(MEMBERS))).toEqual({ allow: V, deny: C });
    expect(again.facts.neutralisedConnect).toEqual([MEMBERS]);
  });

  it('is not put back when a human has since changed the role, and not recreated when it was deleted', () => {
    const locked = plan({ mode: 'locked', previousMode: 'public', current: gated });
    const changed = locked.desired.map((o) => (o.id === MEMBERS ? role(MEMBERS, V) : o));
    const out = plan({
      mode: 'public',
      previousMode: 'locked',
      current: changed,
      record: recordOf(locked.facts),
    });
    expect(find(out, r(MEMBERS))).toEqual({ allow: V, deny: 0n });
    expect(out.facts.neutralisedConnect).toEqual([]);
    const deleted = locked.desired.filter((o) => o.id !== MEMBERS);
    const gone = plan({
      mode: 'public',
      previousMode: 'locked',
      current: deleted,
      record: recordOf(locked.facts),
    });
    expect(find(gone, r(MEMBERS))).toBeUndefined();
  });

  it('is never a reason to refuse: a role the bot cannot edit is skipped and reported', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'public',
      current: gated,
      uneditableRoleIds: [MEMBERS],
    });
    expect(find(p, r(MEMBERS))).toEqual({ allow: VC, deny: 0n });
    expect(p.skippedRoleIds).toEqual([MEMBERS]);
    expect(p.facts.neutralisedConnect).toEqual([]);
  });

  it('is named before the write, so a half-applied lock still has its way back', () => {
    const p = plan({ mode: 'locked', previousMode: 'public', current: gated });
    expect(p.factsBeforeWrite.neutralisedConnect).toEqual([MEMBERS]);
  });

  it('does nothing in a public room', () => {
    const p = plan({ mode: 'public', previousMode: 'public', current: gated });
    expect(find(p, r(MEMBERS))).toEqual({ allow: VC, deny: 0n });
    expect(p.facts.neutralisedConnect).toEqual([]);
  });
});

describe('blocks', () => {
  it('beat an occupant, a trusted member and an admitted one', () => {
    for (const mode of ['public', 'locked', 'hidden'] as const) {
      const p = plan({
        mode,
        previousMode: 'public',
        occupants: [CAROL],
        trusted: [CAROL],
        admitted: [CAROL],
        blocked: [CAROL],
      });
      expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: VC });
      expect(p.facts.trusted).not.toContain(CAROL);
      expect(p.facts.admitted).not.toContain(CAROL);
      expect(p.facts.blocked).toEqual([CAROL]);
    }
  });

  it('take an existing allow off the member as well as denying it', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(CAROL, VC | SPEAK)],
      blocked: [CAROL],
    });
    // Speak is somebody else's bit and stays.
    expect(find(p, m(CAROL))).toEqual({ allow: SPEAK, deny: VC });
  });

  it('never apply to the owner, who is also never locked out of their own room', () => {
    const p = plan({ mode: 'hidden', previousMode: 'public', blocked: [OWNER] });
    expect(find(p, m(OWNER))).toEqual({ allow: VC, deny: 0n });
    expect(p.facts.blocked).toEqual([]);
  });

  it('never apply to the bot', () => {
    const p = plan({ mode: 'locked', previousMode: 'public', blocked: [BOT] });
    expect(find(p, m(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
    expect(p.facts.blocked).toEqual([]);
  });

  it('clear a stale deny on a member who became the owner', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(OWNER, 0n, VC)],
      record: { blocked: [OWNER] },
    });
    expect(find(p, m(OWNER))).toEqual({ allow: C, deny: 0n });
  });
});

/**
 * A votekick belongs to the room and not to the owner's saved list, so it is a block
 * that no edit to the list can lift. The first review of the planner found that a
 * trusted member's grant replaced the unrecorded deny a kick left, so the next apply
 * undid it without anyone being told.
 */
describe('kicked members', () => {
  it('are denied View and Connect in every mode, ahead of any grant for the same member', () => {
    for (const mode of ['public', 'locked', 'hidden'] as const) {
      const p = plan({
        mode,
        previousMode: 'public',
        occupants: [CAROL],
        trusted: [CAROL],
        admitted: [CAROL],
        kicked: [CAROL],
      });
      expect(find(p, m(CAROL)), mode).toEqual({ allow: 0n, deny: VC });
    }
  });

  it('take the grant a trusted member already holds off them as well as denying it', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(CAROL, VC | SPEAK)],
      trusted: [CAROL],
      kicked: [CAROL],
    });
    expect(find(p, m(CAROL))).toEqual({ allow: SPEAK, deny: VC });
  });

  it('are not part of the saved list, so they never reach the record of what the list wrote', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      blocked: [DAVE],
      kicked: [CAROL],
    });
    expect(p.facts.blocked).toEqual([DAVE]);
    expect(p.factsBeforeWrite.blocked).toEqual([DAVE]);
    expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: VC });
  });

  it('are not taken back when the saved list stops naming the member', () => {
    for (const mode of ['public', 'locked', 'hidden'] as const) {
      const p = plan({
        mode,
        previousMode: mode,
        current: [member(CAROL, 0n, VC)],
        // The list wrote this block earlier and no longer has it, and a vote removed them too.
        record: { blocked: [CAROL], kicked: [CAROL] },
        kicked: [CAROL],
      });
      expect(find(p, m(CAROL)), mode).toEqual({ allow: 0n, deny: VC });
      expect(p.facts.blocked, mode).toEqual([]);
    }
  });

  it('are still taken back when only the list named them and the vote did not', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(CAROL, 0n, VC)],
      record: { blocked: [CAROL] },
    });
    expect(find(p, m(CAROL))).toBeUndefined();
  });

  it('keep the deny when the member is also on the saved list, which stays recorded', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      blocked: [CAROL],
      kicked: [CAROL],
    });
    expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: VC });
    expect(p.facts.blocked).toEqual([CAROL]);
  });

  it('never apply to the owner or the bot', () => {
    const p = plan({ mode: 'hidden', previousMode: 'public', kicked: [OWNER, BOT] });
    expect(find(p, m(OWNER))).toEqual({ allow: VC, deny: 0n });
    expect(find(p, m(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
  });

  it('keep a trusted member out of a public room too, which only trusted entries would not', () => {
    const p = plan({ mode: 'public', previousMode: 'public', trusted: [CAROL], kicked: [CAROL] });
    expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: VC });
    // A public room keeps trusted overwrites, but never one for a member who was voted out.
    expect(p.facts.trusted).toEqual([]);
  });

  it('are stable: planning the result again changes nothing', () => {
    const first = plan({
      mode: 'hidden',
      previousMode: 'public',
      occupants: [ALICE],
      trusted: [CAROL],
      kicked: [CAROL],
    });
    const again = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: first.desired,
      occupants: [ALICE],
      trusted: [CAROL],
      kicked: [CAROL],
      record: { ...recordOf(first.facts), kicked: [CAROL] },
    });
    expect(again.diff.upserts).toEqual([]);
    expect(again.diff.deletes).toEqual([]);
  });
});

describe('overwrites it does not know about', () => {
  const foreign = [
    // A human's role overwrite on bits this never writes.
    role('stage', SPEAK, MUTE),
    // A member overwrite from somewhere else on the channel.
    member('friend', SPEAK),
    // An approved knocker: Connect only.
    member('knocker', C),
    // A votekick deny on someone with no rule naming them.
    member('kicked', 0n, C),
    // An empty overwrite somebody left behind.
    member('empty'),
  ];

  it.each<[AccessMode, AccessMode]>([
    ['public', 'locked'],
    ['public', 'hidden'],
    ['locked', 'hidden'],
    ['hidden', 'locked'],
    ['locked', 'public'],
    ['hidden', 'public'],
  ])('keeps all of them untouched, %s to %s', (previousMode, mode) => {
    const p = plan({
      mode,
      previousMode,
      current: foreign,
      record: { baseline: { view: 'none', connect: 'none' } },
    });
    for (const o of foreign) {
      expect(p.desired.find((d) => d.id === o.id && d.type === o.type)).toEqual(o);
    }
  });

  it('keeps the other bits on a member it does name, and only sets View and Connect', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'public',
      current: [member(BOB, SPEAK, MUTE)],
      trusted: [BOB],
    });
    expect(find(p, m(BOB))).toEqual({ allow: SPEAK | VC, deny: MUTE });
  });

  it('keeps the channel overwrites in the order they arrived in, with new ones after', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'public',
      current: [member('z'), role('y', SPEAK), member('x', SPEAK)],
      trusted: ['u2'],
      ownerId: 'u1',
    });
    expect(p.desired.map((o) => o.id)).toEqual(['z', 'y', 'x', BOT, 'u1', 'u2', GUILD]);
  });

  /**
   * A grant replaces an unrecorded deny on the same member. That is what undoes a
   * votekick for someone on the owner's saved list, which is why the caller records
   * a member voted out of a hidden room as blocked.
   */
  it('lets a grant replace an unrecorded deny on the same member', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(BOB, 0n, C)],
      trusted: [BOB],
    });
    expect(find(p, m(BOB))).toEqual({ allow: C, deny: 0n });
  });
});

describe('the bot', () => {
  it.each<[AccessMode, AccessMode]>([
    ['public', 'public'],
    ['public', 'locked'],
    ['public', 'hidden'],
    ['locked', 'public'],
    ['locked', 'locked'],
    ['locked', 'hidden'],
    ['hidden', 'public'],
    ['hidden', 'locked'],
    ['hidden', 'hidden'],
  ])('is always present with its permissions, %s to %s', (previousMode, mode) => {
    const p = plan({ mode, previousMode, blocked: [BOT], occupants: [BOT], trusted: [BOT] });
    expect(find(p, m(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
  });

  it('has its denies cleared and keeps any other bit', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'public',
      current: [member(BOT, SPEAK, V | MOVE_MEMBERS)],
    });
    expect(find(p, m(BOT))).toEqual({ allow: SPEAK | BOT_ACCESS, deny: 0n });
  });

  it('is never taken back as a stale trusted or blocked entry', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      record: { trusted: [BOT], blocked: [BOT] },
    });
    expect(find(p, m(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
  });
});

describe('entries an earlier plan wrote and the lists no longer name', () => {
  it('takes back trusted View and Connect, and deletes an overwrite that ends up empty', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(BOB, VC), member(DAVE, VC | SPEAK)],
      record: { trusted: [BOB], admitted: [DAVE] },
    });
    expect(find(p, m(BOB))).toBeUndefined();
    // Only the bits it wrote.
    expect(find(p, m(DAVE))).toEqual({ allow: SPEAK, deny: 0n });
    expect(p.facts.trusted).toEqual([]);
    expect(p.facts.admitted).toEqual([]);
  });

  it('never takes the way back from the owner or an occupant', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(OWNER, VC), member(ALICE, VC)],
      occupants: [ALICE],
      record: { trusted: [OWNER, ALICE] },
    });
    expect(find(p, m(OWNER))).toEqual({ allow: VC, deny: 0n });
    expect(find(p, m(ALICE))).toEqual({ allow: VC, deny: 0n });
  });

  it('leaves an entry for a member it has no overwrite for', () => {
    const p = plan({ mode: 'locked', previousMode: 'locked', record: { trusted: [BOB] } });
    expect(find(p, m(BOB))).toBeUndefined();
  });

  it('takes back a block when the member is no longer blocked, in any mode', () => {
    for (const mode of ['public', 'locked', 'hidden'] as const) {
      const p = plan({
        mode,
        previousMode: mode,
        current: [member(CAROL, 0n, VC | MUTE)],
        record: { blocked: [CAROL] },
      });
      expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: MUTE });
      expect(p.facts.blocked).toEqual([]);
    }
  });

  it('lets a member who moved from blocked to trusted in one plan end up allowed', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(CAROL, 0n, VC)],
      trusted: [CAROL],
      record: { blocked: [CAROL] },
    });
    // The block's deny comes off both bits, and a locked room grants Connect.
    expect(find(p, m(CAROL))).toEqual({ allow: C, deny: 0n });
    expect(p.facts.trusted).toEqual([CAROL]);
    expect(p.facts.blocked).toEqual([]);
  });

  it('lets a member who moved from trusted to blocked in one plan end up denied', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(CAROL, VC)],
      blocked: [CAROL],
      record: { trusted: [CAROL] },
    });
    expect(find(p, m(CAROL))).toEqual({ allow: 0n, deny: VC });
  });

  it('leaves recorded trusted entries alone when the room goes public', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'locked',
      current: [member(BOB, VC), everyone(0n, C)],
      record: { trusted: [BOB], baseline: { connect: 'none' } },
    });
    expect(find(p, m(BOB))).toEqual({ allow: VC, deny: 0n });
    expect(p.facts.trusted).toEqual([BOB]);
  });
});

describe('the moderator role', () => {
  it('is granted only in a hidden room', () => {
    for (const mode of ['public', 'locked'] as const) {
      const p = plan({ mode, previousMode: 'public', viewerRoleId: MODS });
      expect(find(p, r(MODS))).toBeUndefined();
      expect(p.facts.viewerRoleId).toBeNull();
    }
  });

  it('is revoked when the setting changes, and when it clears', () => {
    const current = [role('old', V), role('new')];
    const changed = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current,
      viewerRoleId: 'new',
      record: { viewerRoleId: 'old' },
    });
    expect(find(changed, r('old'))).toBeUndefined();
    expect(find(changed, r('new'))).toEqual({ allow: V, deny: 0n });
    expect(changed.facts.viewerRoleId).toBe('new');

    const cleared = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: [role('old', V)],
      viewerRoleId: null,
      record: { viewerRoleId: 'old' },
    });
    expect(find(cleared, r('old'))).toBeUndefined();
    expect(cleared.facts.viewerRoleId).toBeNull();
  });

  it('takes back only the View it granted, never other bits on the role', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: [role(MODS, V | SPEAK)],
      record: { viewerRoleId: MODS },
    });
    expect(find(p, r(MODS))).toEqual({ allow: SPEAK, deny: 0n });
  });

  it('does not claim, or later revoke, a View it did not write', () => {
    const inherited = plan({
      mode: 'hidden',
      previousMode: 'public',
      current: [role(MODS, V)],
      viewerRoleId: MODS,
    });
    expect(find(inherited, r(MODS))).toEqual({ allow: V, deny: 0n });
    expect(inherited.facts.viewerRoleId).toBeNull();

    // Not recorded, so unhiding leaves it where the creator channel put it.
    const unhidden = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: inherited.desired,
      record: { viewerRoleId: inherited.facts.viewerRoleId ?? undefined },
    });
    expect(find(unhidden, r(MODS))).toEqual({ allow: V, deny: 0n });
  });

  it('keeps a grant it did write across a converge pass', () => {
    const first = plan({ mode: 'hidden', previousMode: 'public', viewerRoleId: MODS });
    const again = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: first.desired,
      viewerRoleId: MODS,
      record: { viewerRoleId: MODS },
    });
    expect(again.facts.viewerRoleId).toBe(MODS);
    expect(again.diff).toEqual({ upserts: [], deletes: [] });
  });

  it('re-grants a View somebody has taken off the role', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: [role(MODS)],
      viewerRoleId: MODS,
      record: { viewerRoleId: MODS },
    });
    expect(find(p, r(MODS))).toEqual({ allow: V, deny: 0n });
  });
});

describe('a role that was neutralised', () => {
  it('stays recorded across a converge pass while it is still denied', () => {
    const first = plan({
      mode: 'hidden',
      previousMode: 'public',
      current: [role(MEMBERS, V)],
    });
    const again = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: first.desired,
      record: { neutralised: first.facts.neutralised, baseline: first.facts.baseline ?? undefined },
    });
    expect(again.facts.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);
  });

  it('drops an entry whose overwrite a human has since changed, and re-flips a new allow', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: [role('relaxed', 0n, 0n), role('reallowed', V)],
      record: {
        neutralised: [
          { roleId: 'relaxed', view: 'allow' },
          { roleId: 'reallowed', view: 'allow' },
        ],
      },
    });
    expect(p.facts.neutralised).toEqual([{ roleId: 'reallowed', view: 'allow' }]);
    expect(find(p, r('reallowed'))).toEqual({ allow: 0n, deny: V });
  });

  it('keeps a field a newer build added to an entry it keeps', () => {
    const entry = { roleId: MEMBERS, view: 'allow' as const, note: 'from a newer build' };
    const p = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: [role(MEMBERS, 0n, V)],
      record: { neutralised: [entry] },
    });
    expect(p.facts.neutralised).toEqual([entry]);
  });

  it('is restored to whatever the entry says it was', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: [role('a', 0n, V), role('b', 0n, V), role('c', 0n, V)],
      record: {
        neutralised: [
          { roleId: 'a', view: 'allow' },
          { roleId: 'b', view: 'deny' },
          { roleId: 'c', view: 'none' },
        ],
      },
    });
    expect(find(p, r('a'))).toEqual({ allow: V, deny: 0n });
    expect(find(p, r('b'))).toEqual({ allow: 0n, deny: V });
    expect(find(p, r('c'))).toBeUndefined();
  });
});

/**
 * The moderator grant and a hide both rewrite the View bit of one role overwrite, so
 * a role that is both has to remember what it was before either did.
 */
describe('a role that is neutralised and also the moderator role', () => {
  const gated = () =>
    plan({ mode: 'hidden', previousMode: 'public', current: [role(MEMBERS, VC)] });

  function makeViewer(first: Planned) {
    return plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: first.desired,
      record: recordOf(first.facts),
      viewerRoleId: MEMBERS,
    });
  }

  it('is granted View, and stays recorded with the allow it had', () => {
    const first = gated();
    expect(find(first, r(MEMBERS))).toEqual({ allow: 0n, deny: VC });
    const second = makeViewer(first);
    // The moderator role sees the room and does not join it: View only.
    expect(find(second, r(MEMBERS))).toEqual({ allow: V, deny: C });
    expect(second.facts.viewerRoleId).toBe(MEMBERS);
    expect(second.facts.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);
  });

  it('gets its original allow back when the room is unhidden', () => {
    const second = makeViewer(gated());
    for (const mode of ['locked', 'public'] as const) {
      const out = plan({
        mode,
        previousMode: 'hidden',
        current: second.desired,
        record: recordOf(second.facts),
        viewerRoleId: MEMBERS,
      });
      // Not View cleared, which is what taking the grant back alone would do. A lock keeps
      // the role's Connect denied, and going public gives it back.
      expect(find(out, r(MEMBERS))).toEqual(
        mode === 'locked' ? { allow: V, deny: C } : { allow: VC, deny: 0n },
      );
      expect(out.facts.neutralised).toEqual([]);
      expect(out.facts.viewerRoleId).toBeNull();
    }
  });

  it('goes back to denied when it stops being the moderator role while the room is still hidden', () => {
    const second = makeViewer(gated());
    const third = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: second.desired,
      record: recordOf(second.facts),
      viewerRoleId: null,
    });
    expect(find(third, r(MEMBERS))).toEqual({ allow: 0n, deny: VC });
    expect(third.facts.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);
    expect(third.facts.viewerRoleId).toBeNull();
  });

  it('converges: planning the same thing again changes nothing', () => {
    const second = makeViewer(gated());
    const again = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: second.desired,
      record: recordOf(second.facts),
      viewerRoleId: MEMBERS,
    });
    expect(again.diff).toEqual({ upserts: [], deletes: [] });
    expect(again.facts).toEqual({ ...second.facts, baselineCaptured: null });
  });

  it('puts back a View deny that the moderator grant replaced', () => {
    const first = plan({
      mode: 'hidden',
      previousMode: 'public',
      current: [role(MODS, 0n, V)],
      viewerRoleId: MODS,
    });
    expect(find(first, r(MODS))).toEqual({ allow: V, deny: 0n });
    expect(first.facts.neutralised).toEqual([{ roleId: MODS, view: 'deny' }]);
    expect(first.facts.viewerRoleId).toBe(MODS);

    const again = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: first.desired,
      record: recordOf(first.facts),
      viewerRoleId: MODS,
    });
    expect(again.diff).toEqual({ upserts: [], deletes: [] });

    const unhidden = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: first.desired,
      record: recordOf(first.facts),
      viewerRoleId: MODS,
    });
    expect(find(unhidden, r(MODS))).toEqual({ allow: 0n, deny: V });
    expect(unhidden.facts.neutralised).toEqual([]);
  });
});

/**
 * One role above the bot's own must not fail a whole atomic write, which is all or
 * nothing: the rest of the transition has to land and the role be reported.
 */
describe('a role the bot cannot edit', () => {
  const hiddenRoom = [
    member(BOT, BOT_ACCESS),
    member(OWNER, VC),
    everyone(0n, VC),
    role(MEMBERS, C, V),
    role(HELPERS, 0n, V),
  ];
  const record = {
    hidden: true,
    baseline: { view: 'none' as const, connect: 'none' as const },
    neutralised: [
      { roleId: HELPERS, view: 'allow' as const },
      { roleId: MEMBERS, view: 'allow' as const },
    ],
  };

  it('is left as it is on the way out, while the rest is restored', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: hiddenRoom,
      record,
      uneditableRoleIds: [MEMBERS],
    });
    expect(find(p, r(MEMBERS))).toEqual({ allow: C, deny: V });
    expect(find(p, r(HELPERS))).toEqual({ allow: V, deny: 0n });
    expect(find(p, r(GUILD))).toEqual({ allow: 0n, deny: C });
    expect(p.skippedRoleIds).toEqual([MEMBERS]);
    // Still named, so the next plan puts it back.
    expect(p.facts.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);

    const later = plan({
      mode: 'public',
      previousMode: 'locked',
      current: p.desired,
      record: recordOf(p.facts),
    });
    expect(find(later, r(MEMBERS))).toEqual({ allow: VC, deny: 0n });
    expect(later.skippedRoleIds).toEqual([]);
    expect(later.facts.neutralised).toEqual([]);
  });

  it('is skipped on the way to public too', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: hiddenRoom,
      record,
      uneditableRoleIds: [HELPERS, MEMBERS],
    });
    expect(find(p, r(MEMBERS))).toEqual({ allow: C, deny: V });
    expect(find(p, r(HELPERS))).toEqual({ allow: 0n, deny: V });
    expect([...p.skippedRoleIds].sort()).toEqual([HELPERS, MEMBERS]);
    expect(p.facts.neutralised).toHaveLength(2);
    // @everyone is still restored: only the roles are held back.
    expect(find(p, r(GUILD))).toBeUndefined();
  });

  it('keeps being named as the moderator role when its View cannot be taken back', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'hidden',
      current: [member(BOT, BOT_ACCESS), role(MODS, V), everyone(0n, VC)],
      record: { hidden: true, viewerRoleId: MODS, baseline: { view: 'none', connect: 'none' } },
      uneditableRoleIds: [MODS],
    });
    expect(find(p, r(MODS))).toEqual({ allow: V, deny: 0n });
    expect(p.skippedRoleIds).toEqual([MODS]);
    expect(p.facts.viewerRoleId).toBe(MODS);
  });

  it('is not given the moderator View, and does not fail the hide', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'public',
      viewerRoleId: MODS,
      uneditableRoleIds: [MODS],
    });
    expect(find(p, r(MODS))).toBeUndefined();
    expect(p.skippedRoleIds).toEqual([MODS]);
    expect(p.facts.viewerRoleId).toBeNull();
    expect(p.facts.hidden).toBe(true);
  });

  it('keeps a moderator View it wrote, when it cannot be edited and nothing changes', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: [member(BOT, BOT_ACCESS), member(OWNER, VC), role(MODS, V), everyone(0n, VC)],
      record: { hidden: true, viewerRoleId: MODS, baseline: { view: 'none', connect: 'none' } },
      viewerRoleId: MODS,
      uneditableRoleIds: [MODS],
    });
    expect(p.diff).toEqual({ upserts: [], deletes: [] });
    expect(p.facts.viewerRoleId).toBe(MODS);
  });
});

/**
 * A record is written twice, and the first write has to hold everything the second
 * will take away, or a write that fails in between leaves a grant nothing names.
 */
describe('the record before the write', () => {
  const channel = [
    member(BOT, BOT_ACCESS),
    member(OWNER, VC),
    member(ALICE, VC),
    member(BOB, VC),
    everyone(0n, VC),
  ];
  const inputs = {
    mode: 'hidden' as const,
    previousMode: 'hidden' as const,
    current: channel,
    occupants: [ALICE],
    trusted: [ALICE],
    record: {
      hidden: true,
      baseline: { view: 'none' as const, connect: 'none' as const },
      trusted: [ALICE, BOB],
      admitted: [DAVE],
    },
  };

  it('keeps naming a member the plan takes back, until it has', () => {
    const p = plan(inputs);
    expect(p.facts.trusted).toEqual([ALICE]);
    expect([...p.factsBeforeWrite.trusted].sort()).toEqual([ALICE, BOB]);
    // An admitted member too: the room's admissions are dropped when it is rebuilt.
    expect(p.facts.admitted).toEqual([]);
    expect(p.factsBeforeWrite.admitted).toEqual([DAVE]);
  });

  /** The defect the second record exists for, shown by what each would let a replay do. */
  it('lets a replay take back what a failed write left, which the final record could not', () => {
    const p = plan(inputs);
    // The write failed: the channel is as it was.
    const fromBefore = plan({ ...inputs, record: recordOf(p.factsBeforeWrite) });
    expect(find(fromBefore, m(BOB))).toBeUndefined();
    const fromFinal = plan({ ...inputs, record: recordOf(p.facts) });
    expect(find(fromFinal, m(BOB))).toEqual({ allow: VC, deny: 0n });
  });

  it('keeps naming a block that is being lifted', () => {
    const p = plan({
      mode: 'locked',
      previousMode: 'locked',
      current: [member(BOT, BOT_ACCESS), member(CAROL, 0n, VC), member(DAVE, 0n, VC)],
      blocked: [DAVE],
      record: { blocked: [CAROL, DAVE] },
    });
    expect(p.facts.blocked).toEqual([DAVE]);
    expect([...p.factsBeforeWrite.blocked].sort()).toEqual([CAROL, DAVE]);
  });

  it('names what a hide adds, before the flip: the roles it flips and the moderator grant', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'public',
      current: [role(MEMBERS, V)],
      viewerRoleId: MODS,
    });
    expect(p.factsBeforeWrite.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);
    expect(p.factsBeforeWrite.viewerRoleId).toBe(MODS);
    expect(p.factsBeforeWrite.hidden).toBe(true);
    expect(p.factsBeforeWrite.baselineCaptured).toEqual(p.facts.baselineCaptured);
  });

  it('keeps the roles it is about to restore, and the baseline it restores from, until it has', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'hidden',
      current: [member(BOT, BOT_ACCESS), everyone(0n, VC), role(MEMBERS, C, V)],
      record: {
        hidden: true,
        baseline: { view: 'none', connect: 'none' },
        neutralised: [{ roleId: MEMBERS, view: 'allow' }],
        viewerRoleId: MODS,
      },
    });
    expect(p.facts.neutralised).toEqual([]);
    expect(p.facts.baseline).toBeNull();
    expect(p.facts.hidden).toBe(false);
    expect(p.factsBeforeWrite.neutralised).toEqual([{ roleId: MEMBERS, view: 'allow' }]);
    expect(p.factsBeforeWrite.baseline).toEqual({ view: 'none', connect: 'none' });
    expect(p.factsBeforeWrite.hidden).toBe(true);
    expect(p.factsBeforeWrite.viewerRoleId).toBe(MODS);
  });

  it('names the OLD moderator role while it is being changed, because that is the leak', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'hidden',
      current: [role('old', V), role('new')],
      viewerRoleId: 'new',
      record: { hidden: true, viewerRoleId: 'old' },
    });
    expect(p.facts.viewerRoleId).toBe('new');
    expect(p.factsBeforeWrite.viewerRoleId).toBe('old');
  });
});

/**
 * Hiding and unhiding must give back exactly what was there. The member
 * overwrites a transition leaves behind (View and Connect for people who were
 * inside) are harmless, so the round trip is judged on `@everyone` and the roles.
 */
describe('round trips', () => {
  type Step = AccessMode;
  const paths: Step[][] = [
    ['locked', 'public'],
    ['hidden', 'public'],
    ['hidden', 'locked', 'public'],
    ['locked', 'hidden', 'public'],
    ['locked', 'hidden', 'locked', 'public'],
    ['hidden', 'locked', 'hidden', 'public'],
  ];
  const starts: [string, ResolvedOverwrite[]][] = [
    ['an open creator channel', []],
    ['an empty @everyone overwrite', [everyone()]],
    ['a role-gated creator channel', [everyone(0n, V), role(MEMBERS, VC), role(HELPERS, V)]],
    ['a role-gated one that also denies Connect', [everyone(0n, VC), role(MEMBERS, VC)]],
    ['an @everyone that allows Connect', [everyone(C), role(MEMBERS, V | SPEAK)]],
    ['a moderator role that already sees it', [role(MODS, V), role(MEMBERS, V)]],
  ];

  // Named rows: a bigint cannot be printed into a test title.
  it.each(starts.flatMap(([name]) => paths.map((path) => [name, path] as const)))(
    'puts back %s after %j',
    (name, path) => {
      const start = starts.find(([n]) => n === name)![1];
      let current = start.map((o) => ({ ...o }));
      let record: AccessPlanInput['record'] = null;
      let previousMode: AccessMode = 'public';
      for (const mode of path) {
        const p = plan({
          mode,
          previousMode,
          current,
          record,
          occupants: [ALICE],
          trusted: [BOB],
          viewerRoleId: MODS,
        });
        current = p.desired;
        record = recordOf(p.facts);
        previousMode = mode;
      }
      const roles = (list: readonly ResolvedOverwrite[]) =>
        view(list.filter((o) => o.type === OVERWRITE_ROLE && (o.allow !== 0n || o.deny !== 0n)));
      expect(roles(current)).toEqual(roles(start));
      expect(record?.baseline).toBeUndefined();
      expect(record?.neutralised).toEqual([]);
      expect(record?.viewerRoleId).toBeUndefined();
    },
  );
});

describe('idempotency', () => {
  const modes: AccessMode[] = ['public', 'locked', 'hidden'];
  const edges = modes.flatMap((from) => modes.map((to) => [from, to] as const));

  /** What a room that is already in `previousMode` looks like, record and all. */
  function start(previousMode: AccessMode): Pick<AccessPlanInput, 'current' | 'record'> {
    if (previousMode === 'public') {
      return {
        record: null,
        current: [
          member('foreign', SPEAK),
          member('knocker', C),
          member('kicked', 0n, C),
          member(BOT, SPEAK, MOVE_MEMBERS),
          role(MEMBERS, VC),
          role(HELPERS, V | SPEAK),
          everyone(),
        ],
      };
    }
    if (previousMode === 'locked') {
      return {
        record: { baseline: { view: 'none', connect: 'none' }, trusted: [BOB] },
        current: [
          member('foreign', SPEAK),
          member(BOT, BOT_ACCESS),
          member(OWNER, C),
          member(ALICE, C),
          member(BOB, VC),
          role(MEMBERS, VC),
          role(HELPERS, V | SPEAK),
          everyone(0n, C),
        ],
      };
    }
    return {
      record: {
        hidden: true,
        baseline: { view: 'none', connect: 'none' },
        neutralised: [
          { roleId: HELPERS, view: 'allow' },
          { roleId: MEMBERS, view: 'allow' },
        ],
        viewerRoleId: MODS,
        trusted: [BOB],
      },
      current: [
        member('foreign', SPEAK),
        member(BOT, BOT_ACCESS),
        member(OWNER, VC),
        member(ALICE, VC),
        member(BOB, VC),
        role(MEMBERS, C, V),
        role(HELPERS, SPEAK, V),
        role(MODS, V),
        everyone(0n, VC),
      ],
    };
  }

  const inputs = (previousMode: AccessMode, mode: AccessMode) => ({
    mode,
    previousMode,
    occupants: [ALICE],
    trusted: [BOB],
    admitted: [DAVE],
    blocked: [CAROL],
    viewerRoleId: MODS,
    ...start(previousMode),
  });

  it.each(edges)('planning the result of %s to %s again changes nothing', (from, to) => {
    const first = plan(inputs(from, to));
    const original = inputs(from, to).record;
    // A replay of the same transition, as a crashed apply would leave it: the
    // channel holds the result, and the record is the one the transition started
    // from plus the baseline the first attempt captured, which is persisted BEFORE
    // any write precisely so a replay does not read its own deny as the original.
    // A hide also records the roles it flipped and the moderator grant before it writes.
    const added =
      to === 'hidden'
        ? {
            neutralised: first.facts.neutralised,
            neutralisedConnect: first.facts.neutralisedConnect,
            ...(first.facts.viewerRoleId ? { viewerRoleId: first.facts.viewerRoleId } : {}),
          }
        : to === 'locked'
          ? { neutralisedConnect: first.facts.neutralisedConnect }
          : {};
    const replay = plan({
      ...inputs(from, to),
      current: first.desired,
      record: {
        ...original,
        ...added,
        ...(first.facts.baselineCaptured
          ? { baseline: { ...original?.baseline, ...first.facts.baselineCaptured } }
          : {}),
      },
    });
    expect(replay.diff).toEqual({ upserts: [], deletes: [] });
    expect(view(replay.desired)).toEqual(view(first.desired));
    // Set-if-absent: nothing is captured a second time.
    expect(replay.facts).toEqual({ ...first.facts, baselineCaptured: null });
  });

  it('reads its own deny as the original when the baseline was not persisted first', () => {
    // The hazard the ordering above exists for, pinned so it is not mistaken for a
    // bug in the planner: a replay with no stored baseline captures what it finds.
    const first = plan(inputs('public', 'locked'));
    const replay = plan({ ...inputs('public', 'locked'), current: first.desired });
    expect(replay.facts.baselineCaptured).toEqual({ view: 'none', connect: 'deny' });
  });

  it.each(edges)('converging on the result of %s to %s changes nothing', (from, to) => {
    const first = plan(inputs(from, to));
    const converge = plan({
      ...inputs(from, to),
      previousMode: to,
      current: first.desired,
      record: {
        ...(first.facts.baseline ? { baseline: first.facts.baseline } : {}),
        neutralised: first.facts.neutralised,
        neutralisedConnect: first.facts.neutralisedConnect,
        ...(first.facts.viewerRoleId ? { viewerRoleId: first.facts.viewerRoleId } : {}),
        trusted: first.facts.trusted,
        admitted: first.facts.admitted,
        blocked: first.facts.blocked,
      },
    });
    expect(converge.diff).toEqual({ upserts: [], deletes: [] });
    expect(converge.facts).toEqual({ ...first.facts, baselineCaptured: null });
    expect(converge.desired).toEqual(first.desired);
  });

  /**
   * The record written BEFORE a write has to be enough to finish the transition from
   * either side of it: the write never landed, or it landed and the process died
   * before the final record did.
   */
  it.each(edges)('finishes %s to %s from the record written before the write', (from, to) => {
    const first = plan(inputs(from, to));
    const before = recordOf(first.factsBeforeWrite);
    const expected = { ...first.facts, baselineCaptured: null };

    const neverLanded = plan({ ...inputs(from, to), record: before });
    expect(neverLanded.desired).toEqual(first.desired);
    expect(neverLanded.facts).toEqual(expected);

    const landed = plan({ ...inputs(from, to), current: first.desired, record: before });
    expect(landed.diff).toEqual({ upserts: [], deletes: [] });
    expect(landed.facts).toEqual(expected);
  });
});

describe('determinism', () => {
  const base = {
    mode: 'hidden' as const,
    previousMode: 'public' as const,
    viewerRoleId: MODS,
    current: [member('foreign', SPEAK), role(MEMBERS, V), role(HELPERS, V)],
  };

  it('orders what it adds by id, whatever order the sets arrive in', () => {
    const a = plan({
      ...base,
      occupants: ['300', '20', '1000'],
      trusted: ['9', '4000'],
      admitted: ['70'],
      blocked: ['5', '600'],
    });
    const b = plan({
      ...base,
      occupants: ['1000', '300', '20'],
      trusted: ['4000', '9'],
      admitted: ['70'],
      blocked: ['600', '5'],
    });
    expect(b.desired).toEqual(a.desired);
    expect(b.diff).toEqual(a.diff);
    expect(b.facts).toEqual(a.facts);
    // Grants first, then blocks, each in numeric order (snowflakes) and not in
    // string order, which would put '1000' before '20'.
    const added = a.desired.map((o) => o.id).filter((id) => /^\d+$/.test(id));
    expect(added).toEqual(['9', '20', '70', '300', '1000', '4000', '5', '600']);
    expect(a.facts.trusted).toEqual(['9', '4000']);
    expect(a.facts.blocked).toEqual(['5', '600']);
  });

  it('does not change what it was given', () => {
    const current = [member('foreign', SPEAK), role(MEMBERS, V), everyone(C)];
    const frozen = current.map((o) => ({ ...o }));
    const occupants = [ALICE];
    plan({ ...base, current, occupants });
    expect(current).toEqual(frozen);
    expect(occupants).toEqual([ALICE]);
  });

  it('collapses a member listed twice into one overwrite', () => {
    const p = plan({
      ...base,
      occupants: ['u1', 'u1'],
      trusted: ['u1', 'u2', 'u2'],
    });
    expect(p.desired.filter((o) => o.id === 'u1')).toHaveLength(1);
    expect(p.desired.filter((o) => o.id === 'u2')).toHaveLength(1);
    expect(p.facts.trusted).toEqual(['u1', 'u2']);
  });
});

describe('the size cap', () => {
  const foreign = (n: number): ResolvedOverwrite[] =>
    Array.from({ length: n }, (_, i) => member(`f${i}`, SPEAK));

  it('plans a set that fits, with the bot added', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'public',
      current: foreign(MAX_PLANNED_OVERWRITES - 1),
    });
    expect(p.desired).toHaveLength(MAX_PLANNED_OVERWRITES);
  });

  it('refuses a plan above 900 with a typed result rather than throwing', () => {
    const result = planAccess({
      guildId: GUILD,
      botId: BOT,
      current: foreign(MAX_PLANNED_OVERWRITES),
      mode: 'public',
      previousMode: 'public',
      record: null,
      ownerId: OWNER,
      occupants: [],
      trusted: [],
      admitted: [],
      blocked: [],
    });
    expect(result).toEqual({
      ok: false,
      reason: 'too_many_overwrites',
      count: MAX_PLANNED_OVERWRITES + 1,
      cap: MAX_PLANNED_OVERWRITES,
    });
  });

  it('refuses when the lists alone would take it over', () => {
    const result = planAccess({
      guildId: GUILD,
      botId: BOT,
      current: [],
      mode: 'locked',
      previousMode: 'public',
      record: null,
      ownerId: OWNER,
      occupants: [],
      trusted: Array.from({ length: MAX_PLANNED_OVERWRITES }, (_, i) => `t${i}`),
      admitted: [],
      blocked: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe('diffOverwrites', () => {
  it('reports nothing for identical sets, whatever the order', () => {
    const a = [member('x', V), role('y', 0n, C)];
    expect(diffOverwrites(a, [...a].reverse())).toEqual({ upserts: [], deletes: [] });
  });

  it('reports a changed overwrite, a new one and a removed one', () => {
    const diff = diffOverwrites(
      [member('x', V), member('gone', C), role('same', V)],
      [member('x', V | C), member('new', V), role('same', V)],
    );
    expect(diff.upserts.map((o) => o.id)).toEqual(['x', 'new']);
    expect(diff.deletes).toEqual([{ id: 'gone', type: OVERWRITE_MEMBER }]);
  });

  it('tells a member from a role that shares an id', () => {
    const diff = diffOverwrites([member('1', V)], [member('1', V), role('1', V)]);
    expect(diff.upserts).toEqual([role('1', V)]);
  });

  it('writes the bot first, grants, then denies, then @everyone last', () => {
    const diff = diffOverwrites(
      [],
      [
        everyone(0n, VC),
        member('blocked', 0n, VC),
        member('allowed', VC),
        role('neutral', 0n, V),
        member(BOT, BOT_ACCESS),
      ],
      { botId: BOT, guildId: GUILD },
    );
    expect(diff.upserts.map((o) => o.id)).toEqual([BOT, 'allowed', 'blocked', 'neutral', GUILD]);
  });

  it('counts a changed bit as a deny only when the deny is new', () => {
    // Already denied, so changing something else on it is not "adding a deny".
    const diff = diffOverwrites(
      [member('a', 0n, VC), member('b')],
      [member('a', SPEAK, VC), member('b', 0n, VC)],
    );
    expect(diff.upserts.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('a plan is a diff the adapter can apply', () => {
  it('reports the whole hide as upserts in write order', () => {
    const p = plan({
      mode: 'hidden',
      previousMode: 'public',
      occupants: [ALICE],
      blocked: [CAROL],
      current: [role(MEMBERS, V)],
    });
    const order = p.diff.upserts.map((o) => o.id);
    expect(order[0]).toBe(BOT);
    expect(order.at(-1)).toBe(GUILD);
    // The members who must keep seeing the room are written before the deny.
    expect(order.indexOf(ALICE)).toBeLessThan(order.indexOf(GUILD));
    expect(order.indexOf(OWNER)).toBeLessThan(order.indexOf(GUILD));
    expect(p.diff.deletes).toEqual([]);
  });

  it('reports an emptied overwrite as a delete', () => {
    const p = plan({
      mode: 'public',
      previousMode: 'locked',
      current: [member(BOT, BOT_ACCESS), everyone(0n, C)],
      record: { baseline: { connect: 'none' } },
    });
    expect(p.diff.deletes).toEqual([{ id: GUILD, type: OVERWRITE_ROLE }]);
    expect(p.diff.upserts).toEqual([]);
  });
});

describe('leaveOutMembers', () => {
  const ghost = new Set(['ghost']);

  it('drops what is asked of a member who is not in the server, when they had nothing', () => {
    const out = leaveOutMembers([member(BOT, BOT_ACCESS), member('ghost', VC)], [], ghost);
    expect(out).toEqual([member(BOT, BOT_ACCESS)]);
  });

  it('leaves the overwrite they already had exactly as it was, because a replacement would delete it', () => {
    const had = member('ghost', SPEAK);
    const out = leaveOutMembers([member('ghost', 0n, VC)], [had], ghost);
    expect(out).toEqual([had]);
    expect(out[0]).not.toBe(had);
  });

  it('leaves everybody else, and every role, alone, in the order given', () => {
    // A role that shares the member's id is a different overwrite.
    const desired = [role('ghost', V), member('alice', VC), member('ghost', VC), everyone(0n, C)];
    const kept = leaveOutMembers(desired, [], ghost).map((o) => o.type + ':' + o.id);
    expect(kept).toEqual(['0:ghost', '1:alice', '0:' + GUILD]);
  });

  it('copies, and changes nothing it was given', () => {
    const desired = [member('alice', VC)];
    const out = leaveOutMembers(desired, [], new Set());
    expect(out).toEqual(desired);
    expect(out[0]).not.toBe(desired[0]);
  });
});

describe('joinChannelOverwrites', () => {
  it('denies each blocked member Connect and leaves View alone', () => {
    const out = joinChannelOverwrites([], BOT, [CAROL, DAVE]);
    expect(view(out)).toEqual({
      [m(BOT)]: { allow: BOT_ACCESS, deny: 0n },
      [m(CAROL)]: { allow: 0n, deny: C },
      [m(DAVE)]: { allow: 0n, deny: C },
    });
  });

  it('keeps every overwrite already on the channel, and takes only Connect off an allow', () => {
    const out = joinChannelOverwrites(
      [role(MEMBERS, V), everyone(0n, SPEAK), member(CAROL, VC | SPEAK), member(ALICE, C)],
      BOT,
      [CAROL],
    );
    expect(view(out)).toEqual({
      [r(MEMBERS)]: { allow: V, deny: 0n },
      [r(GUILD)]: { allow: 0n, deny: SPEAK },
      [m(CAROL)]: { allow: V | SPEAK, deny: C },
      [m(ALICE)]: { allow: C, deny: 0n },
      [m(BOT)]: { allow: BOT_ACCESS, deny: 0n },
    });
  });

  it('gives the bot its own access, which the write seam insists on, and never blocks it', () => {
    const out = joinChannelOverwrites([member(BOT, 0n, C)], BOT, [BOT]);
    expect(view(out)[m(BOT)]).toEqual({ allow: BOT_ACCESS, deny: 0n });
  });

  it('is stable: a set it has already produced comes back unchanged, in the same order', () => {
    const once = joinChannelOverwrites([role(MEMBERS, V)], BOT, [DAVE, CAROL, CAROL]);
    const twice = joinChannelOverwrites(once, BOT, [CAROL, DAVE]);
    expect(twice).toEqual(once);
  });

  it('changes nothing it was given', () => {
    const current = [member(CAROL, VC)];
    const before = JSON.stringify(current, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    joinChannelOverwrites(current, BOT, [CAROL]);
    expect(JSON.stringify(current, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      before,
    );
  });
});
