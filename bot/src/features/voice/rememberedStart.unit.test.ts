import type { MemberRoomPrefs, StartMode } from '@avc/core';
import { describe, expect, it } from 'vitest';
import type { CommandAccess, CommandCaller } from './commandAccess.js';
import { restoreRemembered, standingOf } from './rememberedStart.js';

const GUILD = 'guild-1';
const ALICE = 'alice';

const prefs = (over: Partial<MemberRoomPrefs> = {}): MemberRoomPrefs => ({
  name: null,
  limit: null,
  privacy: null,
  ...over,
});

const standing = (over: Partial<CommandCaller> = {}): CommandCaller => ({
  userId: ALICE,
  roleIds: [],
  canManage: false,
  ...over,
});

const NO_RULES: CommandAccess = {};

describe('restoreRemembered', () => {
  const restore = (
    saved: MemberRoomPrefs | undefined,
    over: {
      access?: CommandAccess;
      standing?: CommandCaller | undefined;
      defaultMode?: StartMode;
    } = {},
  ) =>
    restoreRemembered(saved, {
      access: over.access ?? NO_RULES,
      standing: 'standing' in over ? over.standing : standing(),
      defaultMode: over.defaultMode ?? 'public',
    });

  describe('with nothing to restore', () => {
    it('changes nothing for a member who saved nothing', () => {
      expect(restore(undefined)).toEqual({});
      expect(restore(prefs())).toEqual({});
    });
  });

  describe('each saved setting', () => {
    it('restores a name, a limit and a privacy when no rule names them', () => {
      expect(restore(prefs({ name: "@@creator@@'s den", limit: 4, privacy: 'private' }))).toEqual({
        name: "@@creator@@'s den",
        limit: 4,
        privacy: 'locked',
      });
    });

    it('restores only what was saved, and leaves the rest to the creator channel', () => {
      expect(restore(prefs({ name: 'Den' }))).toEqual({ name: 'Den' });
      expect(restore(prefs({ limit: 6 }))).toEqual({ limit: 6 });
      expect(restore(prefs({ privacy: 'hidden' }))).toEqual({ privacy: 'hidden' });
    });

    /** A remembered "no limit" is a choice, and it is what overrides a default limit. */
    it('restores a limit of 0, which is a remembered "no limit" and not nothing', () => {
      const out = restore(prefs({ limit: 0 }));
      expect(out).toEqual({ limit: 0 });
      expect(out.limit).toBe(0);
    });

    it('does not need to know who the member is when no rule names the feature', () => {
      expect(
        restore(prefs({ name: 'Den', limit: 3, privacy: 'private' }), { standing: undefined }),
      ).toEqual({ name: 'Den', limit: 3, privacy: 'locked' });
    });
  });

  /**
   * A restricted feature is inert for a denied member, saved data included, so a member who was
   * denied Name after they saved one does not get it back, and Name is the only field that goes.
   */
  describe('a restriction on the feature a field belongs to', () => {
    const SAVED = prefs({ name: 'Den', limit: 5, privacy: 'private' });

    it.each([
      ['rename', 'name'],
      ['limit', 'limit'],
      ['privacy', 'privacy'],
    ] as const)('withholds only the field for %s from a denied member', (feature, field) => {
      const out = restore(SAVED, {
        access: { [feature]: { deny: { users: [ALICE], roles: [] } } },
      });
      expect(out).not.toHaveProperty(field);
      const kept = ['name', 'limit', 'privacy'].filter((f) => f !== field);
      for (const f of kept) expect(out).toHaveProperty(f);
    });

    it('denies by role as well as by member', () => {
      const access: CommandAccess = { rename: { deny: { users: [], roles: ['muted'] } } };
      expect(
        restore(SAVED, { access, standing: standing({ roleIds: ['muted'] }) }),
      ).not.toHaveProperty('name');
      expect(restore(SAVED, { access, standing: standing({ roleIds: ['other'] }) })).toHaveProperty(
        'name',
        'Den',
      );
    });

    /** Members who can manage channels can already rename any room, so no rule applies to them. */
    it('lets a member who can manage channels keep all of it', () => {
      const access: CommandAccess = {
        rename: { deny: { users: [ALICE], roles: [] } },
        limit: { deny: { users: [ALICE], roles: [] } },
        privacy: { deny: { users: [ALICE], roles: [] } },
      };
      expect(restore(SAVED, { access, standing: standing({ canManage: true }) })).toEqual({
        name: 'Den',
        limit: 5,
        privacy: 'locked',
      });
    });

    /**
     * 0 is `/unlimit`, which no rule stops, so a rule on Size withholds a limit and never the
     * member's own "no limit". Their room would otherwise start with the default limit and be
     * undone by a command they are always allowed.
     */
    it('still restores a remembered limit of 0 for a member denied Size', () => {
      const access: CommandAccess = { limit: { deny: { users: [ALICE], roles: [] } } };
      expect(restore(prefs({ limit: 0 }), { access })).toEqual({ limit: 0 });
      expect(restore(prefs({ limit: 5 }), { access })).toEqual({});
    });

    it('restores a remembered limit of 0 under a Size rule even when the member cannot be resolved', () => {
      const access: CommandAccess = { limit: { deny: { users: [ALICE], roles: [] } } };
      expect(restore(prefs({ limit: 0 }), { access, standing: undefined })).toEqual({ limit: 0 });
    });

    it('is not affected by a rule on a feature the field does not belong to', () => {
      const access: CommandAccess = {
        transfer: { deny: { users: [ALICE], roles: [] } },
        nick: { deny: { users: [ALICE], roles: [] } },
        access: { deny: { users: [ALICE], roles: [] } },
      };
      expect(restore(SAVED, { access })).toEqual({ name: 'Den', limit: 5, privacy: 'locked' });
    });

    it('does not read a rule about somebody else as a rule about this member', () => {
      const access: CommandAccess = { rename: { deny: { users: ['bob'], roles: ['other-role'] } } };
      expect(restore(SAVED, { access })).toHaveProperty('name', 'Den');
    });

    /** An allow list withholds the field from a member it leaves out, and keeps it for one it names. */
    it('withholds the field from a member an allow list leaves out', () => {
      const access: CommandAccess = { rename: { allow: { users: [], roles: ['mods'] } } };
      expect(
        restore(SAVED, { access, standing: standing({ roleIds: ['other'] }) }),
      ).not.toHaveProperty('name');
      expect(restore(SAVED, { access, standing: standing({ roleIds: ['mods'] }) })).toHaveProperty(
        'name',
        'Den',
      );
      const byId: CommandAccess = { rename: { allow: { users: [ALICE], roles: [] } } };
      expect(restore(SAVED, { access: byId })).toHaveProperty('name', 'Den');
    });
  });

  /**
   * The guards fail OPEN on a standing they cannot read, because somebody is there to be
   * refused. A restore has nobody clicking, so where a rule names the feature it fails CLOSED.
   */
  describe('a member whose standing cannot be resolved', () => {
    const SAVED = prefs({ name: 'Den', limit: 5, privacy: 'private' });

    it('is skipped for a field a rule names, and still restored for one no rule names', () => {
      const access: CommandAccess = { rename: { deny: { users: ['somebody-else'], roles: [] } } };
      expect(restore(SAVED, { access, standing: undefined })).toEqual({
        limit: 5,
        privacy: 'locked',
      });
    });

    it('is skipped for every field when a rule names every feature', () => {
      const access: CommandAccess = {
        rename: { deny: { users: ['x'], roles: [] } },
        limit: { deny: { users: ['x'], roles: [] } },
        privacy: { deny: { users: ['x'], roles: [] } },
      };
      expect(restore(SAVED, { access, standing: undefined })).toEqual({});
    });
  });

  /**
   * Hidden is a kind of private, and the stricter wins: a remembered mode only ever tightens
   * what the creator channel starts rooms in, and is never a way to a LESS private room.
   */
  describe('privacy against the creator channel start mode', () => {
    it.each([
      // remembered, creator channel default, restored mode
      ['private', 'public', 'locked'],
      ['private', 'locked', undefined],
      ['private', 'hidden', undefined],
      ['hidden', 'public', 'hidden'],
      ['hidden', 'locked', 'hidden'],
      ['hidden', 'hidden', undefined],
    ] as const)('a remembered %s over a %s creator channel gives %s', (saved, def, expected) => {
      const out = restore(prefs({ privacy: saved }), { defaultMode: def });
      expect(out.privacy).toBe(expected);
    });

    it('applies a remembered privacy only when the member may use that mode', () => {
      const denyHide: CommandAccess = { hide: { deny: { users: [ALICE], roles: [] } } };
      const denyPrivate: CommandAccess = { privacy: { deny: { users: [ALICE], roles: [] } } };
      // Hide is its own feature: a member denied it is not given a hidden room...
      expect(restore(prefs({ privacy: 'hidden' }), { access: denyHide }).privacy).toBeUndefined();
      // ...and is not quietly given a locked one in its place.
      expect(restore(prefs({ privacy: 'private' }), { access: denyHide }).privacy).toBe('locked');
      expect(restore(prefs({ privacy: 'hidden' }), { access: denyPrivate }).privacy).toBe('hidden');
      expect(restore(prefs({ privacy: 'private' }), { access: denyPrivate }).privacy).toBe(
        undefined,
      );
    });
  });

  it('never returns a field it was not asked about', () => {
    const out = restore(prefs({ name: 'Den' }), { defaultMode: 'hidden' });
    expect(Object.keys(out)).toEqual(['name']);
  });
});

describe('standingOf', () => {
  const member = { id: ALICE, displayName: 'Alice', bot: false, playing: [] };

  it('is who the snapshot says, with the roles it carries', () => {
    expect(standingOf({ ...member, roleIds: ['r1', GUILD] })).toEqual({
      userId: ALICE,
      roleIds: ['r1', GUILD],
      canManage: false,
    });
    expect(standingOf({ ...member, roleIds: [], canManage: true })?.canManage).toBe(true);
  });

  /** A snapshot with no roles was not built from a live member, so it says nothing about them. */
  it('is unresolved when the snapshot carries no roles', () => {
    expect(standingOf(member)).toBeUndefined();
    expect(standingOf({ ...member, canManage: true })).toBeUndefined();
  });

  it('reads an absent Manage Channels as not exempt', () => {
    expect(standingOf({ ...member, roleIds: [] })?.canManage).toBe(false);
  });
});
