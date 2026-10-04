import { describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  MAX_RESTRICTED_ROLES,
  MAX_RESTRICTED_USERS,
  MAX_RESTRICTIONS,
  readCommandAccess,
} from './commandAccess.js';
import { GuildSettingsService } from './settings.js';

const GUILD = '460459401086763010';
const USER = '111111111111111111';
const OTHER = '222222222222222222';
const ROLE = '333333333333333333';
const OTHER_ROLE = '444444444444444444';

/** `count` distinct snowflakes, offset so two calls never collide. */
const ids = (offset: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${offset}${String(i).padStart(17, '0')}`);

interface Write {
  patch: Record<string, unknown>;
  remove: readonly string[];
}

/**
 * The service over a `mergeSettings` that applies what `decide` returns to an
 * in-memory settings blob, the way the real one does under the row lock, so a
 * sequence of edits can be asserted end to end as well as one write at a time.
 */
function makeService(initial: Record<string, unknown> = {}, opts: { noRow?: boolean } = {}) {
  let settings: Record<string, unknown> = initial;
  const writes: Write[] = [];
  const mergeSettings = vi.fn(
    (
      _guildId: string,
      decide: (existing: { authStatus: string; settings: Record<string, unknown> } | undefined) => {
        patch: Record<string, unknown>;
        remove?: readonly string[];
        result: unknown;
      },
    ) => {
      const decided = decide(opts.noRow ? undefined : { authStatus: 'active', settings });
      writes.push({ patch: decided.patch, remove: decided.remove ?? [] });
      settings = { ...settings, ...decided.patch };
      for (const key of decided.remove ?? []) delete settings[key];
      return Promise.resolve(decided.result);
    },
  );
  const service = new GuildSettingsService({
    guilds: {
      ensure: vi.fn(() => Promise.resolve({ settings })),
      updateSettings: vi.fn(),
      mergeSettings,
    } as never,
    autoChannels: {} as never,
    secondaries: {} as never,
    actions: {} as never,
    logger: fakeLogger(),
  });
  return { service, writes, mergeSettings, stored: () => settings };
}

const user = (id: string) => ({ kind: 'user' as const, id });
const role = (id: string) => ({ kind: 'role' as const, id });

describe('addCommandRestriction to a deny list', () => {
  it('stores a user on the deny list of the feature, and nothing else', async () => {
    const { service, writes } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: false });
    expect(writes).toEqual([
      { patch: { command_access: { rename: { deny: { users: [USER] } } } }, remove: [] },
    ]);
  });

  it('stores a role beside the users of the same list, in the order added', async () => {
    const { service, stored } = makeService();
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    await service.addCommandRestriction(GUILD, 'rename', 'deny', role(ROLE));
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(OTHER));
    await service.addCommandRestriction(GUILD, 'limit', 'deny', role(OTHER_ROLE));
    expect(stored().command_access).toEqual({
      rename: { deny: { users: [USER, OTHER], roles: [ROLE] } },
      limit: { deny: { roles: [OTHER_ROLE] } },
    });
  });

  it('reads back through the same reader the guard will use', async () => {
    const { service, stored } = makeService();
    await service.addCommandRestriction(GUILD, 'transfer', 'deny', user(USER));
    expect(readCommandAccess(stored(), GUILD)).toEqual({
      transfer: { deny: { users: [USER], roles: [] } },
    });
  });

  it('says what the restriction covers', async () => {
    const { service } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(result.message).toContain(`<@${USER}> can no longer use **Name**`);
    expect(result.message).toContain('/name');
    expect(result.message).toContain('voice status');
  });

  it('names a role as a role mention', async () => {
    const { service } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', role(ROLE));
    expect(result.message).toContain(`<@&${ROLE}>`);
  });

  /** A retry or a double click must converge, not stack. */
  it('does nothing and writes nothing when the restriction is already there', async () => {
    const { service, writes } = makeService({
      command_access: { rename: { deny: { users: [USER] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.message).toContain('already restricted');
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual([]);
  });

  it('works for a guild that has no row yet', async () => {
    const { service, stored } = makeService({}, { noRow: true });
    const result = await service.addCommandRestriction(GUILD, 'limit', 'deny', user(USER));
    expect(result.ok).toBe(true);
    expect(stored().command_access).toEqual({ limit: { deny: { users: [USER] } } });
  });

  it('stores Kick and Claim like any other feature', async () => {
    const { service, stored } = makeService();
    await service.addCommandRestriction(GUILD, 'kick', 'deny', role(ROLE));
    await service.addCommandRestriction(GUILD, 'claim', 'deny', user(USER));
    expect(stored().command_access).toEqual({
      kick: { deny: { roles: [ROLE] } },
      claim: { deny: { users: [USER] } },
    });
  });
});

describe('addCommandRestriction to an allow list', () => {
  it('stores a role on the allow list, and says only it and managers can use the feature now', async () => {
    const { service, writes } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', role(ROLE));
    expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: false });
    expect(writes).toEqual([
      { patch: { command_access: { rename: { allow: { roles: [ROLE] } } } }, remove: [] },
    ]);
    expect(result.message).toContain(
      `From now on only <@&${ROLE}> and members who can manage channels can use **Name**.`,
    );
    expect(result.message).toContain('That covers the /name command');
  });

  it('says a later entry is on the list, not that the feature closed again', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { allow: { roles: [ROLE] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
    expect(stored().command_access).toEqual({
      rename: { allow: { roles: [ROLE], users: [USER] } },
    });
    expect(result.message).toContain(`<@${USER}> is on the allow list for **Name** now.`);
    expect(result.message).not.toContain('From now on');
  });

  /** "Allow Name to @Admins" is how a feature is kept to admins, so it is accepted. */
  it('words a target who can manage channels as the admins-only rule it is', async () => {
    const { service, stored } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', role(ROLE), {
      manager: true,
    });
    expect(result.ok).toBe(true);
    expect(stored().command_access).toEqual({ rename: { allow: { roles: [ROLE] } } });
    expect(result.message).toContain(
      `From now on only members who can manage channels, like <@&${ROLE}>, can use **Name**.`,
    );
  });

  /** An allow list never clears a nickname: the render path stops showing it instead. */
  it('does not touch the nickname map, even on Nickname', async () => {
    const { service, writes } = makeService({ custom_nicks: { [USER]: 'Kay', [OTHER]: 'Sam' } });
    const result = await service.addCommandRestriction(GUILD, 'nick', 'allow', user(OTHER));
    expect(result.nicknameCleared).toBe(false);
    expect(writes[0]!.patch.custom_nicks).toBeUndefined();
  });

  it('says a repeat changed nothing, and writes nothing', async () => {
    const { service, writes } = makeService({
      command_access: { rename: { allow: { users: [USER] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.message).toContain(
      'is already on the allow list for **Name**, so nothing changed',
    );
    expect(writes[0]!.patch).toEqual({});
  });
});

/**
 * The same id sits on one list of a feature at most: what an admin said last about
 * somebody is what they meant. Deny would win anyway, so the move matters for the
 * list an admin reads and for an allow list the move empties.
 */
describe('moving somebody between the lists', () => {
  it('takes a user off the deny list when they are allowed, in the same write', async () => {
    const { service, writes, stored } = makeService({
      command_access: { rename: { allow: { roles: [ROLE] }, deny: { users: [USER, OTHER] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
    expect(result.changed).toBe(true);
    expect(writes).toHaveLength(1);
    expect(stored().command_access).toEqual({
      rename: { allow: { roles: [ROLE], users: [USER] }, deny: { users: [OTHER] } },
    });
    expect(result.message).toContain(`<@${USER}> is no longer on its deny list.`);
  });

  it('takes a role off the allow list when it is denied, and says the list emptied', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { allow: { roles: [ROLE] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', role(ROLE));
    expect(stored().command_access).toEqual({ rename: { deny: { roles: [ROLE] } } });
    expect(result.message).toContain(`<@&${ROLE}> is no longer on its allow list.`);
    expect(result.message).toContain(
      'Its allow list is empty now, so everyone who is not denied can use it again.',
    );
  });

  it('does not say the allow list emptied when others are still on it', async () => {
    const { service } = makeService({
      command_access: { rename: { allow: { roles: [ROLE], users: [USER] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', role(ROLE));
    expect(result.message).toContain('is no longer on its allow list');
    expect(result.message).not.toContain('empty now');
  });

  /** A target on both lists (a hand edit or an import) is put on the one asked for. */
  it('takes somebody already on both lists off the other one, as a change', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { allow: { users: [USER] }, deny: { users: [USER] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(stored().command_access).toEqual({ rename: { allow: { users: [USER] } } });
    expect(result.message).toContain(
      'is no longer on the deny list for **Name**, and stays on its allow list',
    );
  });

  it('moves somebody at the whole-map cap, since the move frees the slot it fills', async () => {
    const { service, stored } = makeService({
      command_access: {
        privacy: { deny: { users: ids(1, 50), roles: ids(2, 25) } },
        limit: { deny: { users: ids(3, 49), roles: ids(4, 25) } },
        rename: { deny: { users: [USER] } },
      },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
    expect(result.ok).toBe(true);
    expect((stored().command_access as Record<string, unknown>).rename).toEqual({
      allow: { users: [USER] },
    });
  });
});

describe('the refusals of an add', () => {
  /** The everyone role's id IS the guild id: it would restrict the whole server, or be no rule. */
  it('refuses the everyone role on both lists, and does not even take the lock', async () => {
    const { service, mergeSettings } = makeService();
    const denied = await service.addCommandRestriction(GUILD, 'rename', 'deny', role(GUILD));
    expect(denied).toMatchObject({ ok: false, changed: false });
    expect(denied.message).toContain('would restrict the whole server');
    const allowed = await service.addCommandRestriction(GUILD, 'rename', 'allow', role(GUILD));
    expect(allowed).toMatchObject({ ok: false, changed: false });
    expect(allowed.message).toContain('allowing everyone is the same as having no rule');
    expect(mergeSettings).not.toHaveBeenCalled();
  });

  /** The same id as a USER is only an id: nobody has the guild id as a user id, but it is not special. */
  it('does not treat the guild id as special when it is named as a user', async () => {
    const { service } = makeService();
    expect((await service.addCommandRestriction(GUILD, 'rename', 'deny', user(GUILD))).ok).toBe(
      true,
    );
  });

  it('refuses an id that is not a snowflake', async () => {
    const { service, mergeSettings } = makeService();
    for (const id of ['', 'abc', '123', `${USER}\n`, '1'.repeat(25)]) {
      for (const list of ['allow', 'deny'] as const) {
        const result = await service.addCommandRestriction(GUILD, 'rename', list, user(id));
        expect(result.ok, `${list} ${id}`).toBe(false);
      }
    }
    expect(mergeSettings).not.toHaveBeenCalled();
  });

  it.each(['allow', 'deny'] as const)(
    'refuses the 51st user of the %s list of a feature, and writes nothing',
    async (list) => {
      const full = ids(1, MAX_RESTRICTED_USERS);
      const { service, writes } = makeService({
        command_access: { rename: { [list]: { users: full } } },
      });
      const result = await service.addCommandRestriction(GUILD, 'rename', list, user(USER));
      expect(result).toMatchObject({ ok: false, changed: false });
      expect(result.message).toContain(`The ${list} list for **Name** already holds 50 people`);
      expect(writes[0]!.patch).toEqual({});
    },
  );

  it('keeps the per-list cap to its own list', async () => {
    const full = ids(1, MAX_RESTRICTED_USERS);
    const { service } = makeService({ command_access: { rename: { deny: { users: full } } } });
    expect((await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER))).ok).toBe(
      true,
    );
  });

  it('accepts the 50th user of a list', async () => {
    const almost = ids(1, MAX_RESTRICTED_USERS - 1);
    const { service, stored } = makeService({
      command_access: { rename: { deny: { users: almost } } },
    });
    expect((await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER))).ok).toBe(
      true,
    );
    expect(readCommandAccess(stored(), GUILD).rename?.deny?.users).toHaveLength(
      MAX_RESTRICTED_USERS,
    );
  });

  it('refuses the 26th role of a list, and still takes a user', async () => {
    const full = ids(2, MAX_RESTRICTED_ROLES);
    const { service } = makeService({ command_access: { rename: { allow: { roles: full } } } });
    const refused = await service.addCommandRestriction(GUILD, 'rename', 'allow', role(ROLE));
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain(`already holds ${MAX_RESTRICTED_ROLES} roles`);
    expect((await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER))).ok).toBe(
      true,
    );
  });

  /** Each list inside its own caps, together at the whole-map one, allow and deny alike. */
  it('refuses the 151st entry in all, counting both lists, even when every list has room', async () => {
    const { service, writes } = makeService({
      command_access: {
        privacy: { allow: { users: ids(1, 50), roles: ids(2, 25) } },
        limit: { deny: { users: ids(3, 50), roles: ids(4, 25) } },
      },
    });
    expect(MAX_RESTRICTIONS).toBe(150);
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(result).toMatchObject({ ok: false, changed: false });
    expect(result.message).toContain(String(MAX_RESTRICTIONS));
    expect(writes[0]!.patch).toEqual({});
  });

  it('counts a feature this build does not know toward the whole-map cap', async () => {
    const { service } = makeService({
      command_access: {
        somethingnew: { deny: { users: ids(1, 50), roles: ids(2, 25) } },
        privacy: { allow: { users: ids(3, 50), roles: ids(4, 25) } },
      },
    });
    expect((await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER))).ok).toBe(
      false,
    );
  });

  it('lets a repeat through at the cap, since it adds nothing', async () => {
    const full = ids(1, MAX_RESTRICTED_USERS - 1);
    const { service } = makeService({
      command_access: { rename: { deny: { users: [...full, USER] } } },
    });
    const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false });
  });
});

/**
 * Golden rule 3: preserve unknown JSON fields on writes. An older instance
 * saving one admin's edit must not delete what a newer build or another
 * feature put in the map.
 */
describe('what an add leaves alone', () => {
  it('keeps a feature id this build does not know', async () => {
    const { service, stored } = makeService({
      command_access: { somethingnew: { deny: { users: [OTHER] }, extra: true } },
    });
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(stored().command_access).toEqual({
      somethingnew: { deny: { users: [OTHER] }, extra: true },
      rename: { deny: { users: [USER] } },
    });
  });

  it('keeps a field a newer build added to the entry, and to the list, being edited', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { deny: { users: [OTHER], note: 'x' }, until: 1800000000 } },
    });
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(stored().command_access).toEqual({
      rename: { deny: { users: [OTHER, USER], note: 'x' }, until: 1800000000 },
    });
  });

  it('keeps an element of the list that this build cannot read', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { deny: { users: [OTHER, 'junk', 42] } } },
    });
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(stored().command_access).toEqual({
      rename: { deny: { users: [OTHER, 'junk', 42, USER] } },
    });
  });

  it('keeps the entries of the other features, and the other list, byte for byte', async () => {
    const others = { limit: { deny: { users: [OTHER], roles: [ROLE] } }, nick: 'unreadable' };
    const { service, stored } = makeService({
      command_access: { ...others, rename: { allow: { roles: [OTHER_ROLE] } } },
    });
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    expect(stored().command_access).toEqual({
      ...others,
      rename: { allow: { roles: [OTHER_ROLE] }, deny: { users: [USER] } },
    });
  });

  /**
   * A shape this build does not write can only have come from a newer build, and
   * rewriting it would destroy what that build stored. So an add onto one is
   * refused with nothing written, and the other list, or the other kind of id, of
   * the same entry is not the one in the way.
   */
  describe('a shape it cannot read', () => {
    const newer = { [OTHER]: 1700000000 };

    it('refuses to add a user to an id list that is not a list, and writes nothing', async () => {
      const { service, writes, stored } = makeService({
        command_access: { rename: { deny: { users: newer } } },
      });
      const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
      expect(result).toMatchObject({ ok: false, changed: false, nicknameCleared: false });
      expect(result.message).toContain('cannot change');
      expect(writes).toEqual([{ patch: {}, remove: [] }]);
      expect(stored().command_access).toEqual({ rename: { deny: { users: newer } } });
    });

    it('refuses to add to a list that is not a map', async () => {
      for (const list of ['nope', ['nope'], 7, true]) {
        const { service, writes } = makeService({ command_access: { rename: { allow: list } } });
        const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
        expect(result.ok, JSON.stringify(list)).toBe(false);
        expect(writes[0]!.patch).toEqual({});
      }
    });

    it('refuses to add to an entry that is not a map', async () => {
      for (const entry of ['nope', ['nope'], 7, true]) {
        const { service, writes } = makeService({ command_access: { rename: entry } });
        const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
        expect(result.ok, JSON.stringify(entry)).toBe(false);
        expect(writes[0]!.patch).toEqual({});
      }
    });

    it('refuses to add when the whole stored value is not a map', async () => {
      for (const stored of ['nope', ['rename'], 7, true]) {
        const { service, writes } = makeService({ command_access: stored });
        const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
        expect(result.ok, JSON.stringify(stored)).toBe(false);
        expect(writes[0]!.patch).toEqual({});
      }
    });

    /** Null is the same as nothing stored, which is what a cleared key can look like. */
    it('treats null as nothing stored, at each level', async () => {
      for (const stored of [
        null,
        { rename: null },
        { rename: { deny: null } },
        { rename: { deny: { users: null } } },
      ]) {
        const { service } = makeService({ command_access: stored });
        const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
        expect(result.ok, JSON.stringify(stored)).toBe(true);
      }
    });

    it('does not refuse a role because the users of the same list are unreadable', async () => {
      const { service, stored } = makeService({
        command_access: { rename: { deny: { users: newer } } },
      });
      const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', role(ROLE));
      expect(result.ok).toBe(true);
      expect(stored().command_access).toEqual({
        rename: { deny: { users: newer, roles: [ROLE] } },
      });
    });

    it('does not refuse the allow list because the deny list is unreadable, and leaves it', async () => {
      const { service, stored } = makeService({
        command_access: { rename: { deny: 'unreadable' } },
      });
      const result = await service.addCommandRestriction(GUILD, 'rename', 'allow', user(USER));
      expect(result.ok).toBe(true);
      expect(stored().command_access).toEqual({
        rename: { deny: 'unreadable', allow: { users: [USER] } },
      });
    });

    it('does not refuse another feature because one entry is unreadable', async () => {
      const { service, stored } = makeService({ command_access: { nick: 'unreadable' } });
      const result = await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
      expect(result.ok).toBe(true);
      expect(stored().command_access).toEqual({
        nick: 'unreadable',
        rename: { deny: { users: [USER] } },
      });
    });

    it('has nothing to remove from it, and leaves it alone', async () => {
      const { service, writes } = makeService({
        command_access: { rename: { deny: { users: newer } } },
      });
      const result = await service.removeCommandRestriction(GUILD, 'rename', user(OTHER));
      expect(result).toMatchObject({ ok: true, changed: false });
      expect(writes[0]).toEqual({ patch: {}, remove: [] });
    });
  });

  /**
   * Only a value put in the database by hand can hold a `__proto__` key: the
   * importer's wire schema drops it. So this pins the precaution, not a path.
   */
  it('keeps a __proto__ entry as an entry, not as a prototype', async () => {
    const raw = JSON.parse(`{"__proto__":{"deny":{"users":["${OTHER}"]}}}`);
    const { service, writes } = makeService({ command_access: raw });
    await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER));
    const written = writes[0]!.patch.command_access as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['__proto__', 'rename']);
    expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
  });

  it('does not touch the nickname map for any other deny', async () => {
    const nicks = { [USER]: 'Kay' };
    for (const [feature, who] of [
      ['rename', user(USER)],
      ['nick', role(ROLE)],
    ] as const) {
      const { service, writes } = makeService({ custom_nicks: nicks });
      const result = await service.addCommandRestriction(GUILD, feature, 'deny', who);
      expect(result.nicknameCleared, feature).toBe(false);
      expect(writes[0]!.patch.custom_nicks, feature).toBeUndefined();
    }
  });
});

/**
 * Denying /nick while leaving the name somebody already chose in every room
 * they own would defeat the rule, so the two go in one write: there is no window
 * in which they are restricted and still named.
 */
describe('a Nickname deny on a user', () => {
  it("removes that user's saved nickname in the same write, and says so", async () => {
    const { service, writes } = makeService({
      custom_nicks: { [USER]: 'Kay', [OTHER]: 'Sam' },
    });
    const result = await service.addCommandRestriction(GUILD, 'nick', 'deny', user(USER));
    expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: true });
    expect(result.message).toContain('Their saved nickname was removed');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toEqual({
      command_access: { nick: { deny: { users: [USER] } } },
      custom_nicks: { [OTHER]: 'Sam' },
    });
  });

  it('says nothing about a nickname the user never had', async () => {
    const { service, writes } = makeService({ custom_nicks: { [OTHER]: 'Sam' } });
    const result = await service.addCommandRestriction(GUILD, 'nick', 'deny', user(USER));
    expect(result.nicknameCleared).toBe(false);
    expect(result.message).not.toContain('nickname was removed');
    expect(writes[0]!.patch.custom_nicks).toBeUndefined();
  });

  it('still clears the nickname when the restriction was already there', async () => {
    const { service, writes } = makeService({
      command_access: { nick: { deny: { users: [USER] } } },
      custom_nicks: { [USER]: 'Kay' },
    });
    const result = await service.addCommandRestriction(GUILD, 'nick', 'deny', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false, nicknameCleared: true });
    expect(writes[0]!.patch).toEqual({ custom_nicks: {} });
  });

  /** `/nick reset` writes the emptied map the same way, so the two agree. */
  it('leaves an empty map behind when it was the last nickname', async () => {
    const { service, stored } = makeService({ custom_nicks: { [USER]: 'Kay' } });
    await service.addCommandRestriction(GUILD, 'nick', 'deny', user(USER));
    expect(stored().custom_nicks).toEqual({});
  });

  it('does not remove a nickname when the restriction is refused', async () => {
    const full = ids(1, MAX_RESTRICTED_USERS);
    const { service, writes } = makeService({
      command_access: { nick: { deny: { users: full } } },
      custom_nicks: { [USER]: 'Kay' },
    });
    const result = await service.addCommandRestriction(GUILD, 'nick', 'deny', user(USER));
    expect(result.ok).toBe(false);
    expect(writes[0]!.patch).toEqual({});
  });

  it('does not remove a nickname when a role is restricted', async () => {
    const { service, writes } = makeService({ custom_nicks: { [USER]: 'Kay' } });
    await service.addCommandRestriction(GUILD, 'nick', 'deny', role(ROLE));
    expect(writes[0]!.patch.custom_nicks).toBeUndefined();
  });
});

describe('removeCommandRestriction', () => {
  it('lets the user use the feature again when there is no allow list', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { deny: { users: [USER, OTHER] } } },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.message).toBe(`<@${USER}> can use **Name** again.`);
    expect(stored().command_access).toEqual({ rename: { deny: { users: [OTHER] } } });
  });

  /** Off the deny list is not in, while an allow list still leaves them out. */
  it('does not say they can use it again while an allow list is in force', async () => {
    const { service } = makeService({
      command_access: { rename: { allow: { roles: [ROLE] }, deny: { users: [USER] } } },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(result.message).toBe(
      `<@${USER}> is off the deny list for **Name**. Only the people and roles on its allow list, and members who can manage channels, can use it.`,
    );
  });

  it('takes somebody off the allow list, and says when that empties it', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { allow: { roles: [ROLE] }, deny: { users: [OTHER] } } },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', role(ROLE));
    expect(result.changed).toBe(true);
    expect(stored().command_access).toEqual({ rename: { deny: { users: [OTHER] } } });
    expect(result.message).toBe(
      `<@&${ROLE}> is off the allow list for **Name**. Its allow list is empty now, so everyone who is not denied can use it again.`,
    );
  });

  it('says only who is left can use it when the allow list keeps others', async () => {
    const { service } = makeService({
      command_access: { rename: { allow: { roles: [ROLE], users: [OTHER] } } },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', role(ROLE));
    expect(result.message).toContain('Only the people and roles on its allow list');
  });

  /** On both lists only by a hand edit or an import, and `remove` takes them off both. */
  it('takes somebody off both lists at once', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { allow: { users: [USER, OTHER] }, deny: { users: [USER] } },
      },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(result.changed).toBe(true);
    expect(stored().command_access).toEqual({ rename: { allow: { users: [OTHER] } } });
    expect(result.message).toContain(`<@${USER}> is off both lists for **Name**.`);
  });

  /** "Nobody is restricted" is the absence of the key, so an export round trip is exact. */
  it('removes the id list, then the list, then the entry, then the key, as each one empties', async () => {
    const { service, stored, writes } = makeService({
      command_access: { rename: { deny: { users: [USER], roles: [ROLE] } } },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(stored().command_access).toEqual({ rename: { deny: { roles: [ROLE] } } });
    await service.removeCommandRestriction(GUILD, 'rename', role(ROLE));
    expect(stored()).not.toHaveProperty('command_access');
    expect(writes.at(-1)).toEqual({ patch: {}, remove: ['command_access'] });
  });

  it('keeps the key alive for an entry it cannot read, rather than sweeping it away', async () => {
    const { service, stored, writes } = makeService({
      command_access: { rename: { deny: { users: [USER] } }, somethingnew: { users: [OTHER] } },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(writes[0]!.remove).toEqual([]);
    expect(stored().command_access).toEqual({ somethingnew: { users: [OTHER] } });
  });

  it('keeps a field a newer build put on the entry or the list, even when the ids empty', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { deny: { users: [USER], note: 'x' }, until: 1800000000 } },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(stored().command_access).toEqual({ rename: { deny: { note: 'x' }, until: 1800000000 } });
  });

  it('reports success and writes nothing when there was nothing to remove', async () => {
    const { service, writes } = makeService({
      command_access: { rename: { deny: { users: [OTHER] } } },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false, nicknameCleared: false });
    expect(result.message).toContain('was not on the allow list or the deny list');
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual([]);
  });

  it('reports the same for a guild with no restrictions at all', async () => {
    const { service, writes } = makeService();
    const result = await service.removeCommandRestriction(GUILD, 'nick', role(ROLE));
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(writes[0]!.patch).toEqual({});
  });

  /**
   * Removing is the way out of a rule that no longer makes sense, so it never
   * refuses on who the target is: a role id equal to the guild id is simply not
   * there.
   */
  it('does not refuse the everyone role, and finds nothing to remove', async () => {
    const { service } = makeService();
    const result = await service.removeCommandRestriction(GUILD, 'rename', role(GUILD));
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  it('can clear a stored everyone rule that a hand edit put on either list', async () => {
    for (const list of ['allow', 'deny']) {
      const { service, stored } = makeService({
        command_access: { rename: { [list]: { roles: [GUILD] } } },
      });
      const result = await service.removeCommandRestriction(GUILD, 'rename', role(GUILD));
      expect(result.changed, list).toBe(true);
      expect(stored(), list).not.toHaveProperty('command_access');
    }
  });

  it('does not give a nickname back, or touch the nickname map at all', async () => {
    const { service, writes } = makeService({
      command_access: { nick: { deny: { users: [USER] } } },
      custom_nicks: { [OTHER]: 'Sam' },
    });
    await service.removeCommandRestriction(GUILD, 'nick', user(USER));
    expect(writes[0]!.patch.custom_nicks).toBeUndefined();
  });

  it('removes only the one id, whatever the feature and kind', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { deny: { users: [USER], roles: [ROLE] } },
        limit: { deny: { users: [USER] } },
      },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(stored().command_access).toEqual({
      rename: { deny: { roles: [ROLE] } },
      limit: { deny: { users: [USER] } },
    });
  });
});

/**
 * The way out of a list that has filled with people who left and roles that were
 * deleted: neither can be picked for `remove`, and both count toward the caps.
 */
describe('clearCommandRestrictions', () => {
  it('takes every user and role off both lists of the one feature, and says how many', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { allow: { roles: [OTHER_ROLE] }, deny: { users: [USER, OTHER], roles: [ROLE] } },
        limit: { deny: { users: [USER] } },
      },
    });
    const result = await service.clearCommandRestrictions(GUILD, 'rename');
    expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: false });
    expect(result.message).toBe('Removed 4 restrictions on **Name**. Everyone can use it again.');
    expect(stored().command_access).toEqual({ limit: { deny: { users: [USER] } } });
  });

  it('takes the key off the blob when it was the last feature', async () => {
    const { service, stored, writes } = makeService({
      command_access: { rename: { allow: { users: [USER] } } },
    });
    await service.clearCommandRestrictions(GUILD, 'rename');
    expect(stored()).not.toHaveProperty('command_access');
    expect(writes[0]).toEqual({ patch: {}, remove: ['command_access'] });
  });

  it('is what lets a full list take another name', async () => {
    const full = ids(1, MAX_RESTRICTED_USERS);
    const { service } = makeService({ command_access: { rename: { deny: { users: full } } } });
    expect((await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER))).ok).toBe(
      false,
    );
    await service.clearCommandRestrictions(GUILD, 'rename');
    expect((await service.addCommandRestriction(GUILD, 'rename', 'deny', user(USER))).ok).toBe(
      true,
    );
  });

  it('keeps a field a newer build put on the entry or a list, and a feature this build does not know', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { deny: { users: [USER], note: 'x' }, until: 1800000000 },
        somethingnew: { deny: { users: [OTHER] } },
      },
    });
    await service.clearCommandRestrictions(GUILD, 'rename');
    expect(stored().command_access).toEqual({
      rename: { deny: { note: 'x' }, until: 1800000000 },
      somethingnew: { deny: { users: [OTHER] } },
    });
  });

  it('reports success and writes nothing when the feature had nobody on it', async () => {
    const { service, writes } = makeService({
      command_access: { limit: { deny: { users: [USER] } } },
    });
    const result = await service.clearCommandRestrictions(GUILD, 'rename');
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.message).toBe('Nobody was restricted from **Name**, so nothing changed.');
    expect(writes[0]).toEqual({ patch: {}, remove: [] });
  });

  it('reports the same for a guild with nothing stored, or no row yet', async () => {
    for (const make of [() => makeService(), () => makeService({}, { noRow: true })]) {
      const { service, writes } = make();
      const result = await service.clearCommandRestrictions(GUILD, 'nick');
      expect(result).toMatchObject({ ok: true, changed: false });
      expect(writes[0]).toEqual({ patch: {}, remove: [] });
    }
  });

  /** A list this build cannot read is a newer build's, so a clear leaves it where it is. */
  it('leaves a list it cannot read alone', async () => {
    const newer = { [OTHER]: 1700000000 };
    const { service, stored, writes } = makeService({
      command_access: { rename: { deny: { users: newer, roles: [ROLE] }, allow: 'unreadable' } },
    });
    const result = await service.clearCommandRestrictions(GUILD, 'rename');
    expect(result.message).toContain('Removed 1 restriction on **Name**');
    expect(stored().command_access).toEqual({
      rename: { deny: { users: newer }, allow: 'unreadable' },
    });
    expect(writes).toHaveLength(1);
  });

  it('never touches the nickname map', async () => {
    const { service, writes } = makeService({
      command_access: { nick: { deny: { users: [USER] } } },
      custom_nicks: { [OTHER]: 'Sam' },
    });
    await service.clearCommandRestrictions(GUILD, 'nick');
    expect(writes[0]!.patch.custom_nicks).toBeUndefined();
  });
});

describe('getCommandAccess', () => {
  /** The reader is given the guild id so a stored `@everyone` can never deny a member. */
  it('drops the guild id from the roles it reads', async () => {
    const { service } = makeService({
      command_access: { rename: { deny: { users: [USER], roles: [GUILD, ROLE] } } },
    });
    expect(await service.getCommandAccess(GUILD)).toEqual({
      rename: { deny: { users: [USER], roles: [ROLE] } },
    });
  });

  it('reads what is stored, as fresh objects', async () => {
    const stored = { rename: { allow: { users: [USER], roles: [ROLE] } } };
    const { service } = makeService({ command_access: stored });
    const first = await service.getCommandAccess(GUILD);
    const second = await service.getCommandAccess(GUILD);
    expect(first).toEqual({ rename: { allow: { users: [USER], roles: [ROLE] } } });
    expect(first.rename).not.toBe(second.rename);
    expect(first.rename?.allow?.users).not.toBe(stored.rename.allow.users);
  });

  it('reads nobody restricted from a guild with nothing stored', async () => {
    expect(await makeService().service.getCommandAccess(GUILD)).toEqual({});
  });
});
