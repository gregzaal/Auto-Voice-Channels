import { describe, expect, it, vi } from 'vitest';
import { Collection, DiscordAPIError } from 'discord.js';
import type { RuntimeFlagsRepository, TierId } from '@avc/core';
import { SupporterRoles, planRoleChange } from './supporterRoles.js';

const ROLES = { s: 'role-s', m: 'role-m', l: 'role-l', xl: 'role-xl', xxl: 'role-xxl' } as const;
const MANAGED = Object.values(ROLES);

describe('planRoleChange', () => {
  it('adds the badge someone has just earned', () => {
    expect(planRoleChange({ managed: MANAGED, currentRoles: [], desired: 'role-m' })).toEqual({
      add: ['role-m'],
      remove: [],
    });
  });

  it('is a no-op when the badge already matches', () => {
    expect(
      planRoleChange({ managed: MANAGED, currentRoles: ['role-m'], desired: 'role-m' }),
    ).toEqual({ add: [], remove: [] });
  });

  it('removes the badge when nothing is owed', () => {
    expect(
      planRoleChange({ managed: MANAGED, currentRoles: ['role-l'], desired: undefined }),
    ).toEqual({ add: [], remove: ['role-l'] });
  });

  it('swaps on an upgrade rather than stacking', () => {
    expect(
      planRoleChange({ managed: MANAGED, currentRoles: ['role-s'], desired: 'role-xl' }),
    ).toEqual({ add: ['role-xl'], remove: ['role-s'] });
  });

  /**
   * The whole reason this is add/remove rather than a wholesale role set. The
   * people most likely to hold a supporter badge in the support guild are also
   * the ones most likely to hold a moderator role.
   */
  it('never touches a role it does not manage', () => {
    const plan = planRoleChange({
      managed: MANAGED,
      currentRoles: ['moderator', 'role-s', 'some-colour'],
      desired: 'role-l',
    });
    expect(plan).toEqual({ add: ['role-l'], remove: ['role-s'] });
  });

  /** A member who somehow accumulated several badges converges to exactly one. */
  it('collapses duplicates to the desired badge', () => {
    const plan = planRoleChange({
      managed: MANAGED,
      currentRoles: ['role-s', 'role-m', 'role-xxl'],
      desired: 'role-m',
    });
    expect(plan.add).toEqual([]);
    expect(plan.remove.sort()).toEqual(['role-s', 'role-xxl']);
  });

  /** An unmapped tier resolves to no role id, which must not be added blindly. */
  it('ignores a desired role that is not managed', () => {
    expect(
      planRoleChange({ managed: MANAGED, currentRoles: ['role-s'], desired: 'role-unknown' }),
    ).toEqual({ add: [], remove: ['role-s'] });
  });
});

// ---------------------------------------------------------------------------

interface FakeMember {
  id: string;
  user: { bot: boolean };
  guild: { id: string };
  partial: boolean;
  permissions: { has: (bit: bigint) => boolean };
  /** What Discord actually holds. Ground truth, invisible to the code. */
  serverRoles: Set<string>;
  roles: {
    /** discord.js's view, which its own writes do NOT update. */
    cache: Map<string, unknown>;
    highest: { id: string; comparePositionTo: (other: unknown) => number };
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

/**
 * A member modelled on what discord.js actually does, not on what it looks like
 * it does. Two properties matter and the first version of this file had neither.
 *
 * **A write does not move `roles.cache`.** `GuildMemberRoleManager.add`/`remove`
 * patch a *clone* and return it, so the member you are holding keeps its
 * pre-write roles until Discord echoes GUILD_MEMBER_UPDATE back or you re-fetch.
 * A fake that helpfully updated the cache would make an entire class of bug
 * invisible, and would have hidden the "second decision reads stale state"
 * defect this models. So writes land in `serverRoles`, which only a bulk
 * `members.fetch()` copies back into the cache.
 *
 * **Arrays and Collections are refused.** Both route through
 * `GuildMemberRoleManager.set()`, which PATCHes the whole role list from that
 * same stale cache. `member.roles.cache` IS a Collection, so
 * `roles.remove(cache.filter(...))` is a natural-looking refactor that
 * reintroduces the worst bug this feature has had. Reproducing both overloads
 * faithfully would be a lot of machinery, so the fake refuses the dangerous one
 * and the production code stays bound to the singular form by this test.
 */
function member(id: string, roleIds: string[] = [], bot = false): FakeMember {
  const serverRoles = new Set(roleIds);
  const refuseBulk = (roleOrRoles: unknown): string => {
    if (Array.isArray(roleOrRoles) || roleOrRoles instanceof Collection) {
      throw new Error(
        'roles.add/remove was called with an array or Collection. discord.js routes both ' +
          'through GuildMemberRoleManager.set(), which PATCHes the whole role list from a stale ' +
          'cache. Pass a single role id.',
      );
    }
    return roleOrRoles as string;
  };
  return {
    id,
    user: { bot },
    guild: { id: 'support' },
    partial: false,
    permissions: { has: () => true },
    serverRoles,
    roles: {
      cache: new Map<string, unknown>(roleIds.map((r) => [r, {}])),
      highest: { id: 'bot-top', comparePositionTo: () => 1 },
      add: vi.fn(async (roleOrRoles: unknown) => {
        serverRoles.add(refuseBulk(roleOrRoles));
      }),
      remove: vi.fn(async (roleOrRoles: unknown) => {
        serverRoles.delete(refuseBulk(roleOrRoles));
      }),
    },
  };
}

/** The managed badges the member actually holds ON DISCORD. The assertion that matters. */
function badges(m: FakeMember): string[] {
  return [...m.serverRoles].filter((r) => (MANAGED as readonly string[]).includes(r)).sort();
}

function flags(values: Record<string, boolean> = {}): RuntimeFlagsRepository {
  return {
    getBool: async (key: string) => values[key] ?? false,
  } as unknown as RuntimeFlagsRepository;
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as SupporterRolesDepsLogger;
type SupporterRolesDepsLogger = Parameters<typeof buildSut>[0]['logger'];

function buildSut(opts: {
  members: FakeMember[];
  tiers: Map<string, TierId>;
  guildPresent?: boolean;
  flagValues?: Record<string, boolean>;
  logger?: unknown;
  canManageRoles?: boolean;
  me?: unknown;
  onBulkLookup?: () => Promise<void>;
  onSingleLookup?: () => Promise<void>;
}) {
  /**
   * A real discord.js `Collection`, not a hand-rolled stand-in. The reconcile
   * chains `filter().keys()` and `filter().values()` off what `members.fetch()`
   * returns, and a fake that models those loosely is a fake that would pass
   * against broken code.
   */
  const byId = new Collection<string, FakeMember>(opts.members.map((m) => [m.id, m]));
  const guild = {
    id: 'support',
    memberCount: opts.members.length,
    members: {
      /**
       * Never null, because `Partials.GuildMember` is enabled on the real
       * client: discord.js fabricates a partial member rather than answering
       * "not cached", and a fabricated one has no roles and no permissions.
       */
      me: opts.me ?? {
        partial: false,
        permissions: { has: () => opts.canManageRoles !== false },
        roles: { highest: { id: 'bot-top' } },
      },
      /**
       * Mirrors discord.js: a string fetches ONE member from cache and throws a
       * 404 for a non-member, anything else fetches the collection. Only the
       * bulk fetch repatches the members' role caches from what Discord holds,
       * which is exactly the asymmetry `_fetchSingle` has.
       */
      fetch: vi.fn(async (options?: unknown) => {
        if (typeof options === 'string') {
          const found = byId.get(options);
          if (!found) throw new DiscordAPIError({ code: 10007 }, 10007, 404, 'GET', '', {});
          return found;
        }
        for (const m of byId.values()) {
          m.roles.cache = new Map([...m.serverRoles].map((r) => [r, {}]));
        }
        return byId;
      }),
    },
    roles: {
      cache: new Map(
        MANAGED.map((r) => [r, { id: r, name: r, managed: false, comparePositionTo: () => -1 }]),
      ),
    },
  };

  const handlers = new Map<string, (...args: never[]) => void>();
  const client = {
    on: vi.fn((event: string, fn: (...args: never[]) => void) => {
      handlers.set(event, fn);
    }),
    guilds: { cache: { get: () => (opts.guildPresent === false ? undefined : guild) } },
  };
  const lookup = vi.fn(async (ids: readonly string[]) => {
    // Gated so a test can hold a pass open and land a live event inside it.
    const gate = ids.length === 1 ? opts.onSingleLookup : opts.onBulkLookup;
    if (gate) await gate();
    const out = new Map<string, TierId>();
    for (const id of ids) {
      const tier = opts.tiers.get(id);
      if (tier) out.set(id, tier);
    }
    return out;
  });
  const report = vi.fn();

  const sut = new SupporterRoles({
    client: client as never,
    guildId: 'support',
    byTier: ROLES,
    lookup,
    flags: flags(opts.flagValues),
    logger: (opts.logger ?? logger) as never,
    report,
    writeSpacingMs: 0,
    reconcileIntervalHours: 24,
  });
  return { sut, byId, lookup, report, client, guild, handlers };
}

describe('SupporterRoles.reconcile', () => {
  it('adds, swaps and removes in one pass, and leaves matching members alone', async () => {
    const needsAdd = member('u-add');
    const needsSwap = member('u-swap', ['role-s']);
    const needsRemove = member('u-remove', ['role-xl']);
    const correct = member('u-ok', ['role-m']);
    const { sut } = buildSut({
      members: [needsAdd, needsSwap, needsRemove, correct],
      tiers: new Map<string, TierId>([
        ['u-add', 'l'],
        ['u-swap', 'xxl'],
        ['u-ok', 'm'],
      ]),
    });

    await sut.reconcile();

    expect(badges(needsAdd)).toEqual(['role-l']);
    expect(badges(needsSwap)).toEqual(['role-xxl']);
    expect(badges(needsRemove)).toEqual([]);
    expect(badges(correct)).toEqual(['role-m']);
    expect(correct.roles.add).not.toHaveBeenCalled();
    expect(correct.roles.remove).not.toHaveBeenCalled();
    expect(sut.stats.lastReconcileAttempts).toBe(3);
    expect(sut.stats.errors).toBe(0);
  });

  /**
   * The regression test for the bug this feature shipped with in review: a
   * swap left the member holding BOTH badges, because the second write rebuilt
   * the role list from a cache the first write had not updated. Exactly one
   * badge is the whole rule.
   */
  it('leaves exactly one badge after an upgrade and after a downgrade', async () => {
    const up = member('u-up', ['role-s', 'moderator']);
    const down = member('u-down', ['role-xxl', 'moderator']);
    const { sut } = buildSut({
      members: [up, down],
      tiers: new Map<string, TierId>([
        ['u-up', 'xxl'],
        ['u-down', 's'],
      ]),
    });

    await sut.reconcile();

    expect(badges(up)).toEqual(['role-xxl']);
    expect(badges(down)).toEqual(['role-s']);
    // And the unmanaged role survived both.
    expect(up.roles.cache.has('moderator')).toBe(true);
    expect(down.roles.cache.has('moderator')).toBe(true);
  });

  /** Convergence: a second pass over the state the first produced writes nothing. */
  it('is idempotent', async () => {
    const m = member('u-1');
    const { sut } = buildSut({ members: [m], tiers: new Map<string, TierId>([['u-1', 'm']]) });

    await sut.reconcile();
    expect(m.roles.add).toHaveBeenCalledTimes(1);
    expect(badges(m)).toEqual(['role-m']);

    // No hand-patching of the cache: the first pass already moved it, exactly
    // as a real write would have.
    await sut.reconcile();
    expect(m.roles.add).toHaveBeenCalledTimes(1);
    expect(sut.stats.lastReconcileAttempts).toBe(0);
  });

  it('does nothing on an instance that does not serve the support guild', async () => {
    const m = member('u-1');
    const { sut, lookup } = buildSut({
      members: [m],
      tiers: new Map<string, TierId>([['u-1', 'm']]),
      guildPresent: false,
    });

    await sut.reconcile();
    expect(lookup).not.toHaveBeenCalled();
    expect(m.roles.add).not.toHaveBeenCalled();
    expect(sut.stats.owned).toBe(false);
  });

  /**
   * The kill switch freezes, it does not strip. A mass unbadging is a louder
   * event than whatever prompted an operator to reach for the switch.
   */
  it.each(['support.roles_disabled', 'global.pause'])(
    '%s freezes without stripping',
    async (flag) => {
      const holder = member('u-1', ['role-xl']);
      const { sut } = buildSut({
        members: [holder],
        tiers: new Map(),
        flagValues: { [flag]: true },
      });

      await sut.reconcile();
      expect(holder.roles.remove).not.toHaveBeenCalled();
      expect(holder.roles.add).not.toHaveBeenCalled();
    },
  );

  it('skips bots', async () => {
    const bot = member('bot-1', ['role-s'], true);
    const { sut, lookup } = buildSut({ members: [bot], tiers: new Map() });

    await sut.reconcile();
    expect(bot.roles.remove).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith([]);
  });

  it('reports a role it cannot assign, once per change of state', async () => {
    const { sut, report, guild } = buildSut({ members: [member('u-1')], tiers: new Map() });
    guild.roles.cache.set('role-xl', {
      id: 'role-xl',
      name: 'XL',
      comparePositionTo: () => 1,
    } as never);

    await sut.reconcile();
    expect(report).toHaveBeenCalledTimes(1);
    expect(sut.stats.unusableRoles).toHaveLength(1);

    await sut.reconcile();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports a configured role that does not exist', async () => {
    const { sut, report, guild } = buildSut({ members: [member('u-1')], tiers: new Map() });
    guild.roles.cache.delete('role-l');

    await sut.reconcile();
    expect(report).toHaveBeenCalledTimes(1);
    expect(sut.stats.unusableRoles[0]).toContain('no such role');
  });

  /** One member's failed write must not stop the pass. */
  it('carries on past a failed write', async () => {
    const bad = member('u-bad');
    bad.roles.add.mockRejectedValue(new Error('403'));
    const good = member('u-good');
    const { sut } = buildSut({
      members: [bad, good],
      tiers: new Map<string, TierId>([
        ['u-bad', 'm'],
        ['u-good', 'l'],
      ]),
    });

    await sut.reconcile();
    expect(badges(good)).toEqual(['role-l']);
    expect(sut.stats.errors).toBe(1);
  });
});

describe('SupporterRoles.syncMember', () => {
  it('badges a purchaser who is in the guild', async () => {
    const m = member('u-1');
    const { sut } = buildSut({ members: [m], tiers: new Map<string, TierId>([['u-1', 'xl']]) });

    await sut.syncMember('u-1');
    expect(badges(m)).toEqual(['role-xl']);
    expect(sut.stats.eventsReceived).toBe(1);
    expect(sut.stats.eventsApplied).toBe(1);
  });

  it('un-badges a purchaser whose subscription has lapsed', async () => {
    const m = member('u-1', ['role-xl']);
    const { sut } = buildSut({ members: [m], tiers: new Map() });

    await sut.syncMember('u-1');
    expect(badges(m)).toEqual([]);
  });

  /**
   * Most purchasers are not in the support guild, and Discord answers that with
   * a 404, not an empty result. Counted as received but not applied, so
   * "the NOTIFY path is dead" stays distinguishable from "nobody who bought is
   * in the server".
   */
  it('is a quiet no-op for someone who is not a member', async () => {
    const { sut } = buildSut({ members: [], tiers: new Map<string, TierId>([['u-1', 'm']]) });

    await sut.syncMember('u-1');
    expect(sut.stats.errors).toBe(0);
    expect(sut.stats.eventsReceived).toBe(1);
    expect(sut.stats.eventsApplied).toBe(0);
  });

  /** Any other Discord failure is a real error and must not be swallowed. */
  it('records a fetch failure that is not Unknown Member', async () => {
    const { sut, guild } = buildSut({ members: [], tiers: new Map() });
    guild.members.fetch = vi.fn(async () => {
      throw new DiscordAPIError({ code: 50001 }, 50001, 403, 'GET', '', {});
    }) as never;

    await sut.syncMember('u-1');
    expect(sut.stats.errors).toBe(1);
  });
});

describe('SupporterRoles.reconcileAfterReconnect', () => {
  /**
   * The notifier can reconnect dozens of times an hour, and each reconcile is a
   * gateway member request plus a query per 2000 members. Without the floor the
   * safety net becomes the load.
   */
  it('declines a second pass inside the floor, and counts it', async () => {
    const m = member('u-1');
    const { sut, lookup } = buildSut({
      members: [m],
      tiers: new Map<string, TierId>([['u-1', 'm']]),
    });

    await sut.reconcile();
    expect(lookup).toHaveBeenCalledTimes(1);

    await sut.reconcileAfterReconnect();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(sut.stats.skippedReconciles).toBe(1);
  });

  /** The floor is opt-in per caller: a boot or a daily tick always runs. */
  it('does not floor the ordinary reconcile', async () => {
    const { sut, lookup } = buildSut({ members: [member('u-1')], tiers: new Map() });

    await sut.reconcile();
    await sut.reconcile();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(sut.stats.skippedReconciles).toBe(0);
  });

  it('runs when nothing has reconciled yet', async () => {
    const m = member('u-1');
    const { sut } = buildSut({ members: [m], tiers: new Map<string, TierId>([['u-1', 'l']]) });

    await sut.reconcileAfterReconnect();
    expect(badges(m)).toEqual(['role-l']);
  });
});

// ---------------------------------------------------------------------------
// Round-two regressions. Each of these failed before the fix it guards.
// ---------------------------------------------------------------------------

describe('stale-cache hazards', () => {
  /**
   * discord.js does not update the member you are holding when you write to it,
   * so a second decision taken before Discord echoes the first reads pre-write
   * state. The dangerous outcome is not a duplicate write (those are
   * idempotent) but a decision that concludes "nothing to do".
   *
   * A refund approved and then reversed is the real sequence: the first sync
   * strips the badge, the second has to put it back.
   */
  it('restores a badge stripped by an earlier sync in the same echo window', async () => {
    const m = member('u-1', ['role-m']);
    const tiers = new Map<string, TierId>([['u-1', 'm']]);
    const { sut } = buildSut({ members: [m], tiers });

    tiers.delete('u-1'); // refund approved
    await sut.syncMember('u-1');
    expect(badges(m)).toEqual([]);
    // The role cache is deliberately still stale here, exactly as discord.js
    // leaves it until GUILD_MEMBER_UPDATE arrives.
    expect(m.roles.cache.has('role-m')).toBe(true);

    tiers.set('u-1', 'm'); // refund reversed
    await sut.syncMember('u-1');
    expect(badges(m)).toEqual(['role-m']);
  });

  /** The same hazard through a swap: two writes, one member, one decision each. */
  it('does not undo a swap it has just made', async () => {
    const m = member('u-1', ['role-s']);
    const tiers = new Map<string, TierId>([['u-1', 'xl']]);
    const { sut } = buildSut({ members: [m], tiers });

    await sut.syncMember('u-1');
    expect(badges(m)).toEqual(['role-xl']);

    await sut.syncMember('u-1');
    expect(badges(m)).toEqual(['role-xl']);
  });
});

describe('reconcile versus the live path', () => {
  /**
   * A pass snapshots every member's tier once and then walks the guild paced at
   * `writeSpacingMs`, so on a large guild the snapshot is minutes old by the
   * end. A customer who upgrades mid-pass must not be reverted to the tier they
   * held when it started.
   */
  it('defers to a member the live path synced mid-pass', async () => {
    const m = member('u-1', ['role-s']);
    // A second member so the pass's bulk lookup is distinguishable from the
    // live path's single-id one, which is how the gate below picks its target.
    const other = member('u-2');
    const tiers = new Map<string, TierId>([['u-1', 's']]);
    let releaseBulk: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseBulk = resolve;
    });
    const { sut } = buildSut({
      members: [m, other],
      tiers,
      // Hold the bulk lookup open so the live path can land inside the pass.
      onBulkLookup: () => gate,
    });

    const pass = sut.reconcile();
    await Promise.resolve();

    tiers.set('u-1', 'xl'); // they upgrade while the pass is mid-flight
    await sut.syncMember('u-1');
    expect(badges(m)).toEqual(['role-xl']);

    releaseBulk();
    await pass;

    // The pass still believed 's'. It must not have acted on that.
    expect(badges(m)).toEqual(['role-xl']);
    expect(sut.stats.deferredToLivePath).toBe(1);
  });
});

describe('the reconnect floor', () => {
  /**
   * The floor stamps on ATTEMPT, not on success. Stamping on success would let
   * a failing pass disarm it, and the condition that makes passes fail is the
   * same one that drives repeated reconnects: it would fail open in the only
   * situation it exists for.
   */
  it('still engages after a pass that threw', async () => {
    const { sut, guild } = buildSut({ members: [member('u-1')], tiers: new Map() });
    guild.members.fetch = vi.fn(async () => {
      throw new Error('gateway member request timed out');
    }) as never;

    await sut.reconcile().catch(() => undefined);
    await sut.reconcileAfterReconnect();
    expect(sut.stats.skippedReconciles).toBe(1);
  });
});

describe('role usability', () => {
  /**
   * Missing Manage Roles and being positioned too low fail identically from
   * outside: every write 403s and the feature looks switched off. This is the
   * likelier of the two on a first deploy, and the diagnostic that exists to
   * answer that question used to confirm the wrong branch.
   */
  it('reports missing Manage Roles', async () => {
    const { sut, report } = buildSut({
      members: [member('u-1')],
      tiers: new Map(),
      canManageRoles: false,
    });

    await sut.reconcile();
    expect(sut.stats.unusableRoles.join(' ')).toContain('Manage Roles');
    expect(report).toHaveBeenCalled();
  });

  /** A role owned by an integration cannot be assigned by anyone. */
  it('reports a managed role, and never attempts it', async () => {
    const m = member('u-1');
    const { sut, guild } = buildSut({
      members: [m],
      tiers: new Map<string, TierId>([['u-1', 'l']]),
    });
    guild.roles.cache.set('role-l', {
      id: 'role-l',
      name: 'L',
      managed: true,
      comparePositionTo: () => -1,
    } as never);

    await sut.reconcile();
    expect(sut.stats.unusableRoles.join(' ')).toContain('managed by an integration');
    expect(m.roles.add).not.toHaveBeenCalled();
    expect(sut.stats.errors).toBe(0);
  });

  /**
   * A known-unusable role attempted once per owed member, every pass, forever,
   * would climb `errors` linearly with membership while changing nothing.
   */
  it('does not attempt a role it knows sits too high', async () => {
    const m = member('u-1');
    const { sut, guild } = buildSut({
      members: [m],
      tiers: new Map<string, TierId>([['u-1', 'xl']]),
    });
    guild.roles.cache.set('role-xl', {
      id: 'role-xl',
      name: 'XL',
      managed: false,
      comparePositionTo: () => 1,
    } as never);

    await sut.reconcile();
    expect(m.roles.add).not.toHaveBeenCalled();
  });

  /**
   * `members.me` never returns null: Partials.GuildMember makes discord.js
   * fabricate a partial rather than admit it is not cached, and a fabricated one
   * has no roles, which would report every configured role as mis-positioned.
   */
  it('says what is true when its own member is only a partial', async () => {
    const { sut } = buildSut({
      members: [member('u-1')],
      tiers: new Map(),
      me: { partial: true, permissions: { has: () => false }, roles: { highest: undefined } },
    });

    await sut.reconcile();
    expect(sut.stats.unusableRoles).toHaveLength(1);
    expect(sut.stats.unusableRoles[0]).toContain('not cached as a member');
  });
});

describe('churn and shutdown', () => {
  /** A member leaving mid-pass is ordinary, not a fault to count. */
  it('does not count a member who left as an error', async () => {
    const m = member('u-1');
    m.roles.add.mockRejectedValue(new DiscordAPIError({ code: 10007 }, 10007, 404, 'PUT', '', {}));
    const { sut } = buildSut({ members: [m], tiers: new Map<string, TierId>([['u-1', 'm']]) });

    await sut.reconcile();
    expect(sut.stats.errors).toBe(0);
  });

  /**
   * `stop()` used to await only the reconcile, which is idle almost all the
   * time, and drop the live path, which is the only thing that runs. Without
   * this a sync that began one millisecond before SIGTERM kept issuing role
   * writes through the whole drain, into a client that was being destroyed.
   *
   * Two guarantees, and the second is the one that keeps a member whole: the
   * drain waits for the sync to settle, and a sync that has not started writing
   * bails at its last checkpoint rather than starting a swap it cannot finish.
   */
  it('waits for an in-flight live sync, and that sync does not write after stop', async () => {
    const m = member('u-1', ['role-s']);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sut } = buildSut({
      members: [m],
      tiers: new Map<string, TierId>([['u-1', 'xl']]),
      onSingleLookup: () => gate,
    });

    const sync = sut.syncMember('u-1');
    await Promise.resolve();

    let stopResolved = false;
    const stopped = sut.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    // Still blocked on the sync it must not abandon.
    expect(stopResolved).toBe(false);

    release();
    await Promise.all([sync, stopped]);
    expect(stopResolved).toBe(true);
    // It reached its checkpoint after the stop, so it wrote nothing and left
    // the member exactly as it found them.
    expect(m.roles.add).not.toHaveBeenCalled();
    expect(m.roles.remove).not.toHaveBeenCalled();
    expect(badges(m)).toEqual(['role-s']);
  });
});

/**
 * The counter split exists to tell "the NOTIFY path is dead" from "nobody who
 * bought is in this server". Counting after the kill switch reports the first
 * when the second is true.
 */
describe('event counters', () => {
  it('counts a NOTIFY received even while suppressed', async () => {
    const { sut } = buildSut({
      members: [member('u-1')],
      tiers: new Map<string, TierId>([['u-1', 'm']]),
      flagValues: { 'support.roles_disabled': true },
    });

    await sut.syncMember('u-1');
    expect(sut.stats.eventsReceived).toBe(1);
    expect(sut.stats.eventsApplied).toBe(0);
  });
});

/**
 * `start()` registers one of the two live triggers, and nothing exercised it.
 * The round-one defect that survived every gate lived in wiring exactly like
 * this, so the handler is called here rather than assumed.
 */
describe('SupporterRoles.start', () => {
  it('badges someone on joining the support guild', async () => {
    const m = member('u-1');
    const { sut, handlers } = buildSut({
      members: [m],
      tiers: new Map<string, TierId>([['u-1', 'l']]),
    });
    sut.start();
    handlers.get('guildMemberAdd')?.({ ...m, guild: { id: 'support' } } as never);
    await vi.waitFor(() => expect(badges(m)).toEqual(['role-l']));
    await sut.stop();
  });

  it('ignores a join in some other guild, and a bot joining', async () => {
    const m = member('u-1');
    const bot = member('bot-1', [], true);
    const { sut, handlers } = buildSut({
      members: [m, bot],
      tiers: new Map<string, TierId>([
        ['u-1', 'l'],
        ['bot-1', 'l'],
      ]),
    });
    sut.start();
    handlers.get('guildMemberAdd')?.({ ...m, guild: { id: 'somewhere-else' } } as never);
    handlers.get('guildMemberAdd')?.({ ...bot, guild: { id: 'support' } } as never);
    await new Promise((r) => setTimeout(r, 5));
    expect(m.roles.add).not.toHaveBeenCalled();
    expect(bot.roles.add).not.toHaveBeenCalled();
    await sut.stop();
  });
});
