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

describe('addCommandRestriction', () => {
  it('stores a user under the feature, and nothing else', async () => {
    const { service, writes } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
    expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: false });
    expect(writes).toEqual([
      { patch: { command_access: { rename: { users: [USER] } } }, remove: [] },
    ]);
  });

  it('stores a role beside the users of the same feature, in the order added', async () => {
    const { service, stored } = makeService();
    await service.addCommandRestriction(GUILD, 'rename', user(USER));
    await service.addCommandRestriction(GUILD, 'rename', role(ROLE));
    await service.addCommandRestriction(GUILD, 'rename', user(OTHER));
    await service.addCommandRestriction(GUILD, 'limit', role(OTHER_ROLE));
    expect(stored().command_access).toEqual({
      rename: { users: [USER, OTHER], roles: [ROLE] },
      limit: { roles: [OTHER_ROLE] },
    });
  });

  it('reads back through the same reader the guard will use', async () => {
    const { service, stored } = makeService();
    await service.addCommandRestriction(GUILD, 'transfer', user(USER));
    expect(readCommandAccess(stored(), GUILD)).toEqual({ transfer: { users: [USER], roles: [] } });
  });

  it('says what the restriction covers', async () => {
    const { service } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
    expect(result.message).toContain(`<@${USER}> can no longer use **Name**`);
    expect(result.message).toContain('/name');
    expect(result.message).toContain('voice status');
  });

  it('names a role as a role mention', async () => {
    const { service } = makeService();
    const result = await service.addCommandRestriction(GUILD, 'rename', role(ROLE));
    expect(result.message).toContain(`<@&${ROLE}>`);
  });

  /** A retry or a double click must converge, not stack. */
  it('does nothing and writes nothing when the restriction is already there', async () => {
    const { service, writes } = makeService({ command_access: { rename: { users: [USER] } } });
    const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.message).toContain('already restricted');
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual([]);
  });

  it('works for a guild that has no row yet', async () => {
    const { service, stored } = makeService({}, { noRow: true });
    const result = await service.addCommandRestriction(GUILD, 'limit', user(USER));
    expect(result.ok).toBe(true);
    expect(stored().command_access).toEqual({ limit: { users: [USER] } });
  });

  describe('refusals', () => {
    /** The everyone role's id IS the guild id, and it would restrict the whole server. */
    it('refuses the everyone role, and does not even take the lock', async () => {
      const { service, mergeSettings } = makeService();
      const result = await service.addCommandRestriction(GUILD, 'rename', role(GUILD));
      expect(result).toMatchObject({ ok: false, changed: false });
      expect(result.message).toContain('everyone role');
      expect(mergeSettings).not.toHaveBeenCalled();
    });

    /** The same id as a USER is only an id: nobody has the guild id as a user id, but it is not special. */
    it('does not treat the guild id as special when it is named as a user', async () => {
      const { service } = makeService();
      expect((await service.addCommandRestriction(GUILD, 'rename', user(GUILD))).ok).toBe(true);
    });

    it('refuses an id that is not a snowflake', async () => {
      const { service, mergeSettings } = makeService();
      for (const id of ['', 'abc', '123', `${USER}\n`, '1'.repeat(25)]) {
        const result = await service.addCommandRestriction(GUILD, 'rename', user(id));
        expect(result.ok, id).toBe(false);
      }
      expect(mergeSettings).not.toHaveBeenCalled();
    });

    it('refuses the 51st user of a feature, and writes nothing', async () => {
      const full = ids(1, MAX_RESTRICTED_USERS);
      const { service, writes } = makeService({ command_access: { rename: { users: full } } });
      const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(result).toMatchObject({ ok: false, changed: false });
      expect(result.message).toContain(String(MAX_RESTRICTED_USERS));
      expect(writes[0]!.patch).toEqual({});
    });

    it('accepts the 50th user of a feature', async () => {
      const almost = ids(1, MAX_RESTRICTED_USERS - 1);
      const { service, stored } = makeService({ command_access: { rename: { users: almost } } });
      expect((await service.addCommandRestriction(GUILD, 'rename', user(USER))).ok).toBe(true);
      expect(readCommandAccess(stored(), GUILD).rename?.users).toHaveLength(MAX_RESTRICTED_USERS);
    });

    it('refuses the 26th role of a feature, and still takes a user', async () => {
      const full = ids(2, MAX_RESTRICTED_ROLES);
      const { service } = makeService({ command_access: { rename: { roles: full } } });
      const refused = await service.addCommandRestriction(GUILD, 'rename', role(ROLE));
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain(String(MAX_RESTRICTED_ROLES));
      expect((await service.addCommandRestriction(GUILD, 'rename', user(USER))).ok).toBe(true);
    });

    /** Each feature inside its own caps, together at the whole-map one. */
    it('refuses the 151st entry in all, even when every feature has room', async () => {
      const { service, writes } = makeService({
        command_access: {
          privacy: { users: ids(1, 50), roles: ids(2, 25) },
          limit: { users: ids(3, 50), roles: ids(4, 25) },
        },
      });
      expect(MAX_RESTRICTIONS).toBe(150);
      const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(result).toMatchObject({ ok: false, changed: false });
      expect(result.message).toContain(String(MAX_RESTRICTIONS));
      expect(writes[0]!.patch).toEqual({});
    });

    it('counts a feature this build does not know toward the whole-map cap', async () => {
      const { service } = makeService({
        command_access: {
          somethingnew: { users: ids(1, 50), roles: ids(2, 25) },
          privacy: { users: ids(3, 50), roles: ids(4, 25) },
        },
      });
      expect((await service.addCommandRestriction(GUILD, 'rename', user(USER))).ok).toBe(false);
    });

    it('lets a repeat through at the cap, since it adds nothing', async () => {
      const full = ids(1, MAX_RESTRICTED_USERS - 1);
      const { service } = makeService({ command_access: { rename: { users: [...full, USER] } } });
      const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(result).toMatchObject({ ok: true, changed: false });
    });
  });

  /**
   * Golden rule 3: preserve unknown JSON fields on writes. An older instance
   * saving one admin's edit must not delete what a newer build or another
   * feature put in the map.
   */
  describe('what it leaves alone', () => {
    it('keeps a feature id this build does not know', async () => {
      const { service, stored } = makeService({
        command_access: { somethingnew: { users: [OTHER], extra: true } },
      });
      await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(stored().command_access).toEqual({
        somethingnew: { users: [OTHER], extra: true },
        rename: { users: [USER] },
      });
    });

    it('keeps a field a newer build added to the entry being edited', async () => {
      const { service, stored } = makeService({
        command_access: { rename: { users: [OTHER], until: 1800000000 } },
      });
      await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(stored().command_access).toEqual({
        rename: { users: [OTHER, USER], until: 1800000000 },
      });
    });

    it('keeps an element of the list that this build cannot read', async () => {
      const { service, stored } = makeService({
        command_access: { rename: { users: [OTHER, 'junk', 42] } },
      });
      await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(stored().command_access).toEqual({ rename: { users: [OTHER, 'junk', 42, USER] } });
    });

    it('keeps the entries of the other features byte for byte', async () => {
      const others = { limit: { users: [OTHER], roles: [ROLE] }, nick: 'unreadable' };
      const { service, stored } = makeService({ command_access: others });
      await service.addCommandRestriction(GUILD, 'rename', user(USER));
      expect(stored().command_access).toEqual({ ...others, rename: { users: [USER] } });
    });

    /**
     * A shape this build does not write can only have come from a newer build, and
     * rewriting it would destroy what that build stored. So an add onto one is
     * refused with nothing written, and the other list of the same entry is not
     * the one in the way.
     */
    describe('a shape it cannot read', () => {
      const newer = { [OTHER]: 1700000000 };

      it('refuses to add a user to a list that is not a list, and writes nothing', async () => {
        const { service, writes, stored } = makeService({
          command_access: { rename: { users: newer } },
        });
        const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
        expect(result).toMatchObject({ ok: false, changed: false, nicknameCleared: false });
        expect(result.message).toContain('cannot change');
        expect(writes).toEqual([{ patch: {}, remove: [] }]);
        expect(stored().command_access).toEqual({ rename: { users: newer } });
      });

      it('refuses to add to an entry that is not a map', async () => {
        for (const entry of ['nope', ['nope'], 7, true]) {
          const { service, writes } = makeService({ command_access: { rename: entry } });
          const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
          expect(result.ok, JSON.stringify(entry)).toBe(false);
          expect(writes[0]!.patch).toEqual({});
        }
      });

      it('refuses to add when the whole stored value is not a map', async () => {
        for (const stored of ['nope', ['rename'], 7, true]) {
          const { service, writes } = makeService({ command_access: stored });
          const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
          expect(result.ok, JSON.stringify(stored)).toBe(false);
          expect(writes[0]!.patch).toEqual({});
        }
      });

      /** Null is the same as nothing stored, which is what a cleared key can look like. */
      it('treats null as nothing stored, at each level', async () => {
        for (const stored of [null, { rename: null }, { rename: { users: null } }]) {
          const { service } = makeService({ command_access: stored });
          const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
          expect(result.ok, JSON.stringify(stored)).toBe(true);
        }
      });

      it('does not refuse a role because the users of the same entry are unreadable', async () => {
        const { service, stored } = makeService({ command_access: { rename: { users: newer } } });
        const result = await service.addCommandRestriction(GUILD, 'rename', role(ROLE));
        expect(result.ok).toBe(true);
        expect(stored().command_access).toEqual({ rename: { users: newer, roles: [ROLE] } });
      });

      it('does not refuse another feature because one entry is unreadable', async () => {
        const { service, stored } = makeService({ command_access: { nick: 'unreadable' } });
        const result = await service.addCommandRestriction(GUILD, 'rename', user(USER));
        expect(result.ok).toBe(true);
        expect(stored().command_access).toEqual({ nick: 'unreadable', rename: { users: [USER] } });
      });

      it('has nothing to remove from it, and leaves it alone', async () => {
        const { service, writes } = makeService({ command_access: { rename: { users: newer } } });
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
      const raw = JSON.parse(`{"__proto__":{"users":["${OTHER}"]}}`);
      const { service, writes } = makeService({ command_access: raw });
      await service.addCommandRestriction(GUILD, 'rename', user(USER));
      const written = writes[0]!.patch.command_access as Record<string, unknown>;
      expect(Object.keys(written).sort()).toEqual(['__proto__', 'rename']);
      expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
    });

    it('does not touch the nickname map for any other restriction', async () => {
      const nicks = { [USER]: 'Kay' };
      for (const [feature, who] of [
        ['rename', user(USER)],
        ['nick', role(ROLE)],
      ] as const) {
        const { service, writes } = makeService({ custom_nicks: nicks });
        const result = await service.addCommandRestriction(GUILD, feature, who);
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
  describe('a Nickname restriction on a user', () => {
    it("removes that user's saved nickname in the same write, and says so", async () => {
      const { service, writes } = makeService({
        custom_nicks: { [USER]: 'Kay', [OTHER]: 'Sam' },
      });
      const result = await service.addCommandRestriction(GUILD, 'nick', user(USER));
      expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: true });
      expect(result.message).toContain('Their saved nickname was removed');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.patch).toEqual({
        command_access: { nick: { users: [USER] } },
        custom_nicks: { [OTHER]: 'Sam' },
      });
    });

    it('says nothing about a nickname the user never had', async () => {
      const { service, writes } = makeService({ custom_nicks: { [OTHER]: 'Sam' } });
      const result = await service.addCommandRestriction(GUILD, 'nick', user(USER));
      expect(result.nicknameCleared).toBe(false);
      expect(result.message).not.toContain('nickname was removed');
      expect(writes[0]!.patch.custom_nicks).toBeUndefined();
    });

    it('still clears the nickname when the restriction was already there', async () => {
      const { service, writes } = makeService({
        command_access: { nick: { users: [USER] } },
        custom_nicks: { [USER]: 'Kay' },
      });
      const result = await service.addCommandRestriction(GUILD, 'nick', user(USER));
      expect(result).toMatchObject({ ok: true, changed: false, nicknameCleared: true });
      expect(writes[0]!.patch).toEqual({ custom_nicks: {} });
    });

    /** `/nick reset` writes the emptied map the same way, so the two agree. */
    it('leaves an empty map behind when it was the last nickname', async () => {
      const { service, stored } = makeService({ custom_nicks: { [USER]: 'Kay' } });
      await service.addCommandRestriction(GUILD, 'nick', user(USER));
      expect(stored().custom_nicks).toEqual({});
    });

    it('does not remove a nickname when the restriction is refused', async () => {
      const full = ids(1, MAX_RESTRICTED_USERS);
      const { service, writes } = makeService({
        command_access: { nick: { users: full } },
        custom_nicks: { [USER]: 'Kay' },
      });
      const result = await service.addCommandRestriction(GUILD, 'nick', user(USER));
      expect(result.ok).toBe(false);
      expect(writes[0]!.patch).toEqual({});
    });

    it('does not remove a nickname when a role is restricted', async () => {
      const { service, writes } = makeService({ custom_nicks: { [USER]: 'Kay' } });
      await service.addCommandRestriction(GUILD, 'nick', role(ROLE));
      expect(writes[0]!.patch.custom_nicks).toBeUndefined();
    });
  });
});

describe('removeCommandRestriction', () => {
  it('lets the user use the feature again', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { users: [USER, OTHER] } },
    });
    const result = await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(result).toMatchObject({ ok: true, changed: true });
    expect(result.message).toContain(`<@${USER}> can use **Name** again`);
    expect(stored().command_access).toEqual({ rename: { users: [OTHER] } });
  });

  /** "Nobody is restricted" is the absence of the key, so an export round trip is exact. */
  it('removes the list, then the entry, then the key, as each one empties', async () => {
    const { service, stored, writes } = makeService({
      command_access: { rename: { users: [USER], roles: [ROLE] } },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(stored().command_access).toEqual({ rename: { roles: [ROLE] } });
    await service.removeCommandRestriction(GUILD, 'rename', role(ROLE));
    expect(stored()).not.toHaveProperty('command_access');
    expect(writes.at(-1)).toEqual({ patch: {}, remove: ['command_access'] });
  });

  it('keeps the key alive for an entry it cannot read, rather than sweeping it away', async () => {
    const { service, stored, writes } = makeService({
      command_access: { rename: { users: [USER] }, somethingnew: { users: [OTHER] } },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(writes[0]!.remove).toEqual([]);
    expect(stored().command_access).toEqual({ somethingnew: { users: [OTHER] } });
  });

  it('keeps a field a newer build put on the entry, even when the lists empty', async () => {
    const { service, stored } = makeService({
      command_access: { rename: { users: [USER], until: 1800000000 } },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(stored().command_access).toEqual({ rename: { until: 1800000000 } });
  });

  it('reports success and writes nothing when there was nothing to remove', async () => {
    const { service, writes } = makeService({ command_access: { rename: { users: [OTHER] } } });
    const result = await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(result).toMatchObject({ ok: true, changed: false, nicknameCleared: false });
    expect(result.message).toContain('was not restricted');
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

  it('can clear a stored everyone rule that a hand edit put there', async () => {
    const { service, stored } = makeService({ command_access: { rename: { roles: [GUILD] } } });
    const result = await service.removeCommandRestriction(GUILD, 'rename', role(GUILD));
    expect(result.changed).toBe(true);
    expect(stored()).not.toHaveProperty('command_access');
  });

  it('does not give a nickname back, or touch the nickname map at all', async () => {
    const { service, writes } = makeService({
      command_access: { nick: { users: [USER] } },
      custom_nicks: { [OTHER]: 'Sam' },
    });
    await service.removeCommandRestriction(GUILD, 'nick', user(USER));
    expect(writes[0]!.patch.custom_nicks).toBeUndefined();
  });

  it('removes only the one id, whatever the feature and kind', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { users: [USER], roles: [ROLE] },
        limit: { users: [USER] },
      },
    });
    await service.removeCommandRestriction(GUILD, 'rename', user(USER));
    expect(stored().command_access).toEqual({
      rename: { roles: [ROLE] },
      limit: { users: [USER] },
    });
  });
});

/**
 * The way out of a list that has filled with people who left and roles that were
 * deleted: neither can be picked for `remove`, and both count toward the caps.
 */
describe('clearCommandRestrictions', () => {
  it('takes every user and role off the one feature, and says how many', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { users: [USER, OTHER], roles: [ROLE] },
        limit: { users: [USER] },
      },
    });
    const result = await service.clearCommandRestrictions(GUILD, 'rename');
    expect(result).toMatchObject({ ok: true, changed: true, nicknameCleared: false });
    expect(result.message).toBe('Removed 3 restrictions on **Name**. Everyone can use it again.');
    expect(stored().command_access).toEqual({ limit: { users: [USER] } });
  });

  it('takes the key off the blob when it was the last feature', async () => {
    const { service, stored, writes } = makeService({
      command_access: { rename: { users: [USER] } },
    });
    await service.clearCommandRestrictions(GUILD, 'rename');
    expect(stored()).not.toHaveProperty('command_access');
    expect(writes[0]).toEqual({ patch: {}, remove: ['command_access'] });
  });

  it('is what lets a full list take another name', async () => {
    const full = ids(1, MAX_RESTRICTED_USERS);
    const { service } = makeService({ command_access: { rename: { users: full } } });
    expect((await service.addCommandRestriction(GUILD, 'rename', user(USER))).ok).toBe(false);
    await service.clearCommandRestrictions(GUILD, 'rename');
    expect((await service.addCommandRestriction(GUILD, 'rename', user(USER))).ok).toBe(true);
  });

  it('keeps a field a newer build put on the entry, and a feature this build does not know', async () => {
    const { service, stored } = makeService({
      command_access: {
        rename: { users: [USER], until: 1800000000 },
        somethingnew: { users: [OTHER] },
      },
    });
    await service.clearCommandRestrictions(GUILD, 'rename');
    expect(stored().command_access).toEqual({
      rename: { until: 1800000000 },
      somethingnew: { users: [OTHER] },
    });
  });

  it('reports success and writes nothing when the feature had nobody on it', async () => {
    const { service, writes } = makeService({ command_access: { limit: { users: [USER] } } });
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
      command_access: { rename: { users: newer, roles: [ROLE] } },
    });
    const result = await service.clearCommandRestrictions(GUILD, 'rename');
    expect(result.message).toContain('Removed 1 restriction on **Name**');
    expect(stored().command_access).toEqual({ rename: { users: newer } });
    expect(writes).toHaveLength(1);
  });

  it('never touches the nickname map', async () => {
    const { service, writes } = makeService({
      command_access: { nick: { users: [USER] } },
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
      command_access: { rename: { users: [USER], roles: [GUILD, ROLE] } },
    });
    expect(await service.getCommandAccess(GUILD)).toEqual({
      rename: { users: [USER], roles: [ROLE] },
    });
  });

  it('reads what is stored, as fresh objects', async () => {
    const stored = { rename: { users: [USER], roles: [ROLE] } };
    const { service } = makeService({ command_access: stored });
    const first = await service.getCommandAccess(GUILD);
    const second = await service.getCommandAccess(GUILD);
    expect(first).toEqual({ rename: { users: [USER], roles: [ROLE] } });
    expect(first.rename).not.toBe(second.rename);
    expect(first.rename?.users).not.toBe(stored.rename.users);
  });

  it('reads nobody restricted from a guild with nothing stored', async () => {
    expect(await makeService().service.getCommandAccess(GUILD)).toEqual({});
  });
});
