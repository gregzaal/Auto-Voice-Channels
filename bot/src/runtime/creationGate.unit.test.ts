import { RUNTIME_FLAGS, type Logger, type RuntimeFlagsRepository } from '@avc/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from './testUtils.js';
import { RuntimeCreationGate } from './creationGate.js';

/** Minimal in-memory stand-in for the flags repo (only getAll is used). */
function fakeFlags(values: Record<string, unknown> = {}): RuntimeFlagsRepository {
  return {
    getAll: () => Promise.resolve(values),
  } as unknown as RuntimeFlagsRepository;
}

describe('RuntimeCreationGate', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('allows creation when no flags are set', async () => {
    const gate = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
  });

  it('denies creation under global pause', async () => {
    const gate = new RuntimeCreationGate({
      flags: fakeFlags({ [RUNTIME_FLAGS.GLOBAL_PAUSE]: true }),
      logger: fakeLogger(),
    });
    const decision = await gate.allowCreate('g1');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/pause/);
  });

  it('throttles per guild once the rate limit is hit, isolating other guilds', async () => {
    const gate = new RuntimeCreationGate({
      flags: fakeFlags({ [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 2 }),
      logger: fakeLogger(),
      flagCacheMs: 0,
    });
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
    expect((await gate.allowCreate('g1')).allowed).toBe(false); // 3rd within window

    // A different guild is unaffected.
    expect((await gate.allowCreate('g2')).allowed).toBe(true);
  });

  it('lets the window slide so creation resumes after it passes', async () => {
    vi.useFakeTimers();
    const gate = new RuntimeCreationGate({
      flags: fakeFlags({ [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1 }),
      logger: fakeLogger(),
      flagCacheMs: 0,
      windowMs: 1000,
    });
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
    expect((await gate.allowCreate('g1')).allowed).toBe(false);
    vi.advanceTimersByTime(1100);
    expect((await gate.allowCreate('g1')).allowed).toBe(true);
  });

  it('caches the flag snapshot to avoid a read per create', async () => {
    const getAll = vi.fn().mockResolvedValue({});
    const gate = new RuntimeCreationGate({
      flags: { getAll } as unknown as RuntimeFlagsRepository,
      logger: fakeLogger(),
      flagCacheMs: 10_000,
    });
    await gate.allowCreate('g1');
    await gate.allowCreate('g1');
    expect(getAll).toHaveBeenCalledTimes(1);
  });
  /**
   * Guard live room creation as well as the reconcile paths using `ownsGuild`.
   *
   * `ownsGuild` is consulted by the reconcile sweep and by nothing on the join
   * path, so an instance whose lease had aged out stopped pruning rows and
   * carried on creating them. Discord delivers the same VOICE_STATE_UPDATE to
   * every open session for a shard, so once a peer claims the same shard both
   * instances create a room on the same join.
   */
  describe('the shard lease', () => {
    it('declines creation when the lease cannot be proven', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({}),
        logger: fakeLogger(),
        leasesProven: () => false,
      });
      const decision = await gate.allowCreate('g1');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('lease');
    });

    it('allows creation once the lease is provable again', async () => {
      let proven = false;
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({}),
        logger: fakeLogger(),
        leasesProven: () => proven,
      });
      expect((await gate.allowCreate('g1')).allowed).toBe(false);
      proven = true;
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /** Absent means one instance holding every shard, where it is never in doubt. */
    it('is unaffected when no lease check is supplied', async () => {
      const gate = new RuntimeCreationGate({ flags: fakeFlags({}), logger: fakeLogger() });
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /**
     * Checked before the flag read, so an unprovable lease needs no database
     * round trip to decline. That matters because the likeliest reason the lease
     * cannot be refreshed is the database being unreachable.
     */
    it('declines without reading the flags at all', async () => {
      const flags = fakeFlags({});
      const spy = vi.spyOn(flags, 'getAll');
      const gate = new RuntimeCreationGate({
        flags,
        logger: fakeLogger(),
        leasesProven: () => false,
      });
      await gate.allowCreate('g1');
      expect(spy).not.toHaveBeenCalled();
    });
  });
  describe('the companion text lever', () => {
    it('rides the allowed decision so the create path reads one snapshot', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.COMPANION_TEXT_DISABLED]: true }),
        logger: fakeLogger(),
      });
      const decision = await gate.allowCreate('g1');
      // The room is still created: this lever gates the text channel alone.
      expect(decision.allowed).toBe(true);
      expect(decision.companionTextDisabled).toBe(true);
    });

    it('is absent from the decision when unset', async () => {
      const gate = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
      expect((await gate.allowCreate('g1')).companionTextDisabled).toBeUndefined();
      expect(await gate.companionTextDisabled()).toBe(false);
    });

    /**
     * The reconciler asks separately, because allowCreate() also spends a slot
     * of the per-guild creation throttle and a repair must not.
     */
    it('answers the reconciler without consuming a throttle slot', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({
          [RUNTIME_FLAGS.COMPANION_TEXT_DISABLED]: true,
          [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1,
        }),
        logger: fakeLogger(),
      });
      expect(await gate.companionTextDisabled()).toBe(true);
      expect(await gate.companionTextDisabled()).toBe(true);
      // The one slot is still available, so the asking cost nothing.
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /**
     * Fails OPEN, unlike allowCreate(), whose job is refusing. A database blip
     * must not silently withdraw a feature a server switched on.
     */
    it('treats a failed flag read as not disabled', async () => {
      const flags = { getAll: () => Promise.reject(new Error('db down')) };
      const gate = new RuntimeCreationGate({
        flags: flags as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      expect(await gate.companionTextDisabled()).toBe(false);
    });
  });

  describe('the control panel lever', () => {
    /**
     * Its own flag rather than a share of the companion one: freezing
     * companion text channels fleet-wide must not silently stop posting the
     * buttons into the rooms that still have a built-in chat.
     */
    it('rides the allowed decision, independently of the companion lever', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.CONTROL_PANEL_DISABLED]: true }),
        logger: fakeLogger(),
      });
      const decision = await gate.allowCreate('g1');
      expect(decision.allowed).toBe(true);
      expect(decision.controlPanelDisabled).toBe(true);
      expect(decision.companionTextDisabled).toBeUndefined();
    });

    it('is absent from the decision when unset', async () => {
      const gate = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
      expect((await gate.allowCreate('g1')).controlPanelDisabled).toBeUndefined();
      expect(await gate.controlPanelDisabled()).toBe(false);
    });

    /**
     * The re-render path asks separately, and far more often than a create, so
     * it must not spend a slot of the per-guild creation throttle to ask.
     */
    it('answers the re-render path without consuming a throttle slot', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({
          [RUNTIME_FLAGS.CONTROL_PANEL_DISABLED]: true,
          [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1,
        }),
        logger: fakeLogger(),
      });
      expect(await gate.controlPanelDisabled()).toBe(true);
      expect(await gate.controlPanelDisabled()).toBe(true);
      // The one slot is still available, so the asking cost nothing.
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /** Fails OPEN: a database blip must not withdraw a feature that is on by default. */
    it('treats a failed flag read as not disabled', async () => {
      const flags = { getAll: () => Promise.reject(new Error('db down')) };
      const gate = new RuntimeCreationGate({
        flags: flags as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      expect(await gate.controlPanelDisabled()).toBe(false);
    });
  });

  describe('the command access lever', () => {
    it('is off unless the flag is exactly true', async () => {
      const unset = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
      expect(await unset.commandAccessDisabled()).toBe(false);
      const truthy = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED]: 'yes' }),
        logger: fakeLogger(),
      });
      expect(await truthy.commandAccessDisabled()).toBe(false);
    });

    /**
     * Its own flag: freezing the panel or the companions must not quietly switch
     * restrictions off, and the reverse. Each decision is read from one snapshot.
     */
    it('is independent of the other levers, and never rides a creation decision', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED]: true }),
        logger: fakeLogger(),
      });
      expect(await gate.commandAccessDisabled()).toBe(true);
      expect(await gate.controlPanelDisabled()).toBe(false);
      expect(await gate.companionTextDisabled()).toBe(false);
      const other = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.CONTROL_PANEL_DISABLED]: true }),
        logger: fakeLogger(),
      });
      expect(await other.commandAccessDisabled()).toBe(false);
    });

    /**
     * The whole point of reading it through the snapshot: a guard asks on every
     * interaction that would otherwise be refused, and `getAll` is a SELECT.
     */
    it('reads through the cached snapshot, one query for many asks', async () => {
      const getAll = vi.fn().mockResolvedValue({ [RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED]: true });
      const gate = new RuntimeCreationGate({
        flags: { getAll } as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      for (let i = 0; i < 5; i += 1) expect(await gate.commandAccessDisabled()).toBe(true);
      expect(getAll).toHaveBeenCalledTimes(1);
    });

    it('does not spend a throttle slot to answer', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({
          [RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED]: true,
          [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1,
        }),
        logger: fakeLogger(),
      });
      expect(await gate.commandAccessDisabled()).toBe(true);
      expect(await gate.commandAccessDisabled()).toBe(true);
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /** A blip must not quietly withdraw a rule an admin wrote. */
    it('treats a failed flag read as not disabled, so the rules stay in force', async () => {
      const flags = { getAll: () => Promise.reject(new Error('db down')) };
      const gate = new RuntimeCreationGate({
        flags: flags as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      expect(await gate.commandAccessDisabled()).toBe(false);
    });
  });

  describe('the room access lever', () => {
    it('is off unless the flag is exactly true', async () => {
      const unset = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
      expect(await unset.roomAccessDisabled()).toBe(false);
      const truthy = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.ROOM_ACCESS_DISABLED]: 'yes' }),
        logger: fakeLogger(),
      });
      expect(await truthy.roomAccessDisabled()).toBe(false);
    });

    /** Its own flag: neither the panel nor `/restrict` lever may switch hiding off, or the reverse. */
    it('is independent of the other levers, and never rides a creation decision', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.ROOM_ACCESS_DISABLED]: true }),
        logger: fakeLogger(),
      });
      expect(await gate.roomAccessDisabled()).toBe(true);
      expect(await gate.commandAccessDisabled()).toBe(false);
      expect(await gate.controlPanelDisabled()).toBe(false);
      expect(await gate.companionTextDisabled()).toBe(false);
      // A room can still be created: this is not a creation lever.
      expect(await gate.allowCreate('g1')).toEqual({ allowed: true });
      for (const other of [
        RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED,
        RUNTIME_FLAGS.CONTROL_PANEL_DISABLED,
        RUNTIME_FLAGS.COMPANION_TEXT_DISABLED,
      ]) {
        const unrelated = new RuntimeCreationGate({
          flags: fakeFlags({ [other]: true }),
          logger: fakeLogger(),
        });
        expect(await unrelated.roomAccessDisabled()).toBe(false);
      }
    });

    /** A command, a knock card and a saved-list apply can all ask, and `getAll` is a SELECT. */
    it('reads through the cached snapshot, one query for many asks', async () => {
      const getAll = vi.fn().mockResolvedValue({ [RUNTIME_FLAGS.ROOM_ACCESS_DISABLED]: true });
      const gate = new RuntimeCreationGate({
        flags: { getAll } as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      for (let i = 0; i < 5; i += 1) expect(await gate.roomAccessDisabled()).toBe(true);
      expect(getAll).toHaveBeenCalledTimes(1);
    });

    it('does not spend a throttle slot to answer', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({
          [RUNTIME_FLAGS.ROOM_ACCESS_DISABLED]: true,
          [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1,
        }),
        logger: fakeLogger(),
      });
      expect(await gate.roomAccessDisabled()).toBe(true);
      expect(await gate.roomAccessDisabled()).toBe(true);
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /** A blip must not quietly withdraw a feature that is on by default. */
    it('treats a failed flag read as not disabled', async () => {
      const flags = { getAll: () => Promise.reject(new Error('db down')) };
      const warn = vi.fn();
      const gate = new RuntimeCreationGate({
        flags: flags as unknown as RuntimeFlagsRepository,
        logger: { ...fakeLogger(), warn } as unknown as Logger,
      });
      expect(await gate.roomAccessDisabled()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('the remembered room settings lever', () => {
    it('is off unless the flag is exactly true', async () => {
      const unset = new RuntimeCreationGate({ flags: fakeFlags(), logger: fakeLogger() });
      expect(await unset.memberPrefsDisabled()).toBe(false);
      const truthy = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.MEMBER_PREFS_DISABLED]: 'yes' }),
        logger: fakeLogger(),
      });
      expect(await truthy.memberPrefsDisabled()).toBe(false);
      const on = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.MEMBER_PREFS_DISABLED]: true }),
        logger: fakeLogger(),
      });
      expect(await on.memberPrefsDisabled()).toBe(true);
    });

    /**
     * Its own flag: hiding rooms, the panel and the restriction guard each have a lever, and
     * throwing one must not switch remembering off, or the reverse.
     */
    it('is independent of the other levers, and never rides a creation decision', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({ [RUNTIME_FLAGS.MEMBER_PREFS_DISABLED]: true }),
        logger: fakeLogger(),
      });
      expect(await gate.memberPrefsDisabled()).toBe(true);
      expect(await gate.roomAccessDisabled()).toBe(false);
      expect(await gate.commandAccessDisabled()).toBe(false);
      expect(await gate.controlPanelDisabled()).toBe(false);
      expect(await gate.companionTextDisabled()).toBe(false);
      // A room can still be created: this is not a creation lever.
      expect(await gate.allowCreate('g1')).toEqual({ allowed: true });
      for (const other of [
        RUNTIME_FLAGS.ROOM_ACCESS_DISABLED,
        RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED,
        RUNTIME_FLAGS.CONTROL_PANEL_DISABLED,
        RUNTIME_FLAGS.COMPANION_TEXT_DISABLED,
      ]) {
        const unrelated = new RuntimeCreationGate({
          flags: fakeFlags({ [other]: true }),
          logger: fakeLogger(),
        });
        expect(await unrelated.memberPrefsDisabled()).toBe(false);
      }
    });

    /** A save follows every command a member types, and `getAll` is a SELECT. */
    it('reads through the cached snapshot, one query for many asks', async () => {
      const getAll = vi.fn().mockResolvedValue({ [RUNTIME_FLAGS.MEMBER_PREFS_DISABLED]: true });
      const gate = new RuntimeCreationGate({
        flags: { getAll } as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      for (let i = 0; i < 5; i += 1) expect(await gate.memberPrefsDisabled()).toBe(true);
      expect(getAll).toHaveBeenCalledTimes(1);
    });

    it('shares the snapshot the other levers read, so asking after one of them costs no query', async () => {
      const getAll = vi.fn().mockResolvedValue({ [RUNTIME_FLAGS.MEMBER_PREFS_DISABLED]: true });
      const gate = new RuntimeCreationGate({
        flags: { getAll } as unknown as RuntimeFlagsRepository,
        logger: fakeLogger(),
      });
      await gate.roomAccessDisabled();
      expect(await gate.memberPrefsDisabled()).toBe(true);
      expect(getAll).toHaveBeenCalledTimes(1);
    });

    it('does not spend a throttle slot to answer', async () => {
      const gate = new RuntimeCreationGate({
        flags: fakeFlags({
          [RUNTIME_FLAGS.MEMBER_PREFS_DISABLED]: true,
          [RUNTIME_FLAGS.CREATE_RATE_LIMIT]: 1,
        }),
        logger: fakeLogger(),
      });
      expect(await gate.memberPrefsDisabled()).toBe(true);
      expect(await gate.memberPrefsDisabled()).toBe(true);
      expect((await gate.allowCreate('g1')).allowed).toBe(true);
    });

    /** A blip must not quietly withdraw something an admin opted a creator channel into. */
    it('treats a failed flag read as not disabled', async () => {
      const flags = { getAll: () => Promise.reject(new Error('db down')) };
      const warn = vi.fn();
      const gate = new RuntimeCreationGate({
        flags: flags as unknown as RuntimeFlagsRepository,
        logger: { ...fakeLogger(), warn } as unknown as Logger,
      });
      expect(await gate.memberPrefsDisabled()).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
