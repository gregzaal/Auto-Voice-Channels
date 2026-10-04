import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  MemberAccessListRepository,
  MemberRoomPrefsRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { DiscordAPIError } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  BOT_ACCESS,
  CONNECT,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  type ResolvedOverwrite,
} from './accessPlan.js';
import { RecordingVoiceActions, type VoiceActions } from './actions.js';
import type { CommandResult } from './commands.js';
import type { CommandAccess } from './commandAccess.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { CreationRefusedError, PrivacyService, type PrivacyServiceDeps } from './privacy.js';
import { BLOCK_NOT_SAVED_PAUSED, ROOM_ACCESS_REPLIES, savedNote } from './roomAccessCopy.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-privacy-test';
const SEC = 'sec-1';
const BOT = 'bot-1';
const MODS = 'role-mods';
const GATE = 'role-gate';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;

const ow = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_MEMBER,
  allow,
  deny,
});
const roleOw = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_ROLE,
  allow,
  deny,
});

/** What a member's overwrite is, spelled so a failing assertion reads as bits. */
const bits = (o: ResolvedOverwrite | undefined) =>
  o ? { allow: o.allow, deny: o.deny } : undefined;

/** The calls that answer a member, whose replies the last test holds to the copy rules. */
const COMMANDS = new Set([
  'makePrivate',
  'makePublic',
  'hide',
  'unhide',
  'admit',
  'approveJoin',
  'denyJoin',
]);

describe('PrivacyService (integration)', () => {
  let env: PgTestEnv;
  let secondaries: SecondaryChannelRepository;
  let joinChannels: JoinChannelRepository;
  let lists: MemberAccessListRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let privacy: PrivacyService;
  let problems: PermissionProblemTracker;
  let serverLogs: string[];
  /** The guild's moderator role setting, which a test changes like an admin would. */
  let moderatorRole: string | null;
  /** A `/nick` per member id. */
  let nicks: Map<string, string>;
  /** Every reply a command gave, for the copy-rules check at the end. */
  const replies: string[] = [];

  beforeAll(async () => {
    env = await startPostgres();
    secondaries = new SecondaryChannelRepository(env.handle.db);
    joinChannels = new JoinChannelRepository(env.handle.db);
    lists = new MemberAccessListRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  /** A service whose command replies are collected, whatever deps a test changes. */
  const build = (over: Partial<PrivacyServiceDeps> = {}): PrivacyService => {
    const service = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => BOT,
      memberAccessLists: lists,
      moderatorRoleId: () => Promise.resolve(moderatorRole),
      ownerName: (_guildId, m) => Promise.resolve(nicks.get(m.id) ?? m.displayName),
      permissionProblems: problems,
      serverLog: (_guildId, _level, message) => serverLogs.push(message),
      ...over,
    });
    return new Proxy(service, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        if (!COMMANDS.has(String(prop))) return value.bind(target);
        return async (...args: unknown[]) => {
          const result = (await value.apply(target, args)) as CommandResult;
          replies.push(result.message);
          return result;
        };
      },
    });
  };

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.memberAccessLists);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    problems = new PermissionProblemTracker();
    serverLogs = [];
    moderatorRole = null;
    nicks = new Map();
    privacy = build();
    await secondaries.create({
      channelId: SEC,
      guildId: GUILD,
      primaryChannelId: 'p',
      ownerId: 'alice',
      state: { name: 'Alice’s den' },
    });
    voice.put(SEC, member('alice'));
  });

  // -- helpers --------------------------------------------------------------------

  const held = (id: string, type = OVERWRITE_MEMBER, channel = SEC) =>
    actions.overwritesOf(channel).find((o) => o.id === id && o.type === type);
  const everyone = (channel = SEC) => held(GUILD, OVERWRITE_ROLE, channel);
  const row = async () => (await secondaries.get(SEC))!;
  const access = () => secondaries.getAccess(SEC);
  const joinRow = () => joinChannels.getBySecondary(SEC);
  /** The Join channels the fake has created and not deleted. */
  const liveJoinChannels = () => {
    const deleted = new Set(actions.ofType('delete').map((a) => a.channelId));
    return actions.ofType('joinChannel').filter((a) => !deleted.has(a.channelId));
  };
  /** Writes the column verbatim, to stage a blob this build would never write. */
  const stageAccess = (blob: unknown) =>
    env.handle.pool.query(
      'UPDATE secondary_channels SET access = $1::jsonb WHERE channel_id = $2',
      [JSON.stringify(blob), SEC],
    );

  /** A room an older instance locked: private in state, an `@everyone` Connect deny, no record. */
  const lockedByOlderInstance = async (inherited: ResolvedOverwrite[] = []) => {
    actions.seedOverwrites(SEC, [
      ow(BOT, BOT_ACCESS),
      ow('alice', C),
      roleOw(GUILD, 0n, C),
      ...inherited,
    ]);
    await secondaries.updateState(SEC, { ...(await row()).state, private: true });
    await joinChannels.create({
      channelId: 'old-join',
      guildId: GUILD,
      secondaryChannelId: SEC,
      creatorId: 'alice',
    });
  };

  const apiError = (code: number, status = 403) =>
    new DiscordAPIError(
      { code, message: `code ${code}` } as never,
      code,
      status,
      'PUT',
      'https://discord.test',
      {} as never,
    );

  // -- the existing behaviour ---------------------------------------------------

  it('makes a channel private and spawns a "⇩ Join" companion', async () => {
    const res = await privacy.makePrivate(GUILD, SEC, 'alice');
    expect(res.ok).toBe(true);

    // The bot's allow, the owner's Connect and the `@everyone` deny, in one write.
    expect(actions.ofType('overwrites')).toHaveLength(1);
    expect(bits(held(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
    expect(bits(held('alice'))).toEqual({ allow: C, deny: 0n });
    expect(bits(everyone())).toEqual({ allow: 0n, deny: C });
    const join = actions.ofType('joinChannel');
    expect(join).toHaveLength(1);
    expect(join[0]!.name).toBe('⇩ Join alice');
    expect(join[0]!.nearChannelId).toBe(SEC);

    expect((await row()).state.private).toBe(true);
    expect(await joinRow()).toMatchObject({
      channelId: join[0]!.channelId,
      secondaryChannelId: SEC,
      creatorId: 'alice',
    });
  });

  it('rejects a non-owner and a double-private', async () => {
    expect((await privacy.makePrivate(GUILD, SEC, 'mallory')).ok).toBe(false);
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const again = await privacy.makePrivate(GUILD, SEC, 'alice');
    expect(again).toEqual({ ok: false, message: 'This channel is already private.' });
  });

  it('resolves a join channel back to its request context', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;
    const ctx = await privacy.getJoinContext(joinId);
    expect(ctx).toMatchObject({
      secondaryChannelId: SEC,
      creatorId: 'alice',
    });
    expect(await privacy.getJoinContext('not-a-join-channel')).toBeUndefined();
  });

  it('approves a requester: grants Connect and pulls them in', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    const res = await privacy.approveJoin(joinId, 'bob');
    expect(res.ok).toBe(true);
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ channelId: SEC, memberId: 'bob', allow: true }),
    );
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: 'bob', channelId: SEC }),
    );
  });

  it('denies a requester, and blocks them on the join channel when asked', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    await privacy.denyJoin(joinId, 'bob', false);
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: 'bob', channelId: null }),
    );

    await privacy.denyJoin(joinId, 'carol', true);
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
    );
  });

  /**
   * `moveMember` swallows 40032 (the member is not in voice), for every caller. A
   * requester who left voice while the card sat there is the ordinary case.
   */
  describe('a requester who has left voice', () => {
    it('is still admitted: the grant stands and nobody is told it failed', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const joinId = actions.ofType('joinChannel')[0]!.channelId;
      actions.notConnectedMemberIds.add('bob');

      const res = await privacy.approveJoin(joinId, 'bob');
      expect(res.ok).toBe(true);
      expect(res.message).toContain('Admitted');
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ channelId: SEC, memberId: 'bob', allow: true }),
      );
      expect(actions.ofType('move')).not.toContainEqual(
        expect.objectContaining({ memberId: 'bob' }),
      );
    });

    it('is still blocked when the owner denies with a block', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const joinId = actions.ofType('joinChannel')[0]!.channelId;
      actions.notConnectedMemberIds.add('carol');

      // The disconnect used to throw before the block was applied, so the block was lost.
      const res = await privacy.denyJoin(joinId, 'carol', true);
      expect(res.ok).toBe(true);
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
      );
      expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['carol']);
    });

    it('is simply denied when the owner denies without a block', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const joinId = actions.ofType('joinChannel')[0]!.channelId;
      actions.notConnectedMemberIds.add('carol');
      await expect(privacy.denyJoin(joinId, 'carol', false)).resolves.toMatchObject({ ok: true });
    });
  });

  it('makes a channel public again: deletes the join channel and clears state', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    const res = await privacy.makePublic(GUILD, SEC, 'alice');
    expect(res.ok).toBe(true);
    // The `@everyone` overwrite is gone, because it held nothing but the lock.
    expect(everyone()).toBeUndefined();
    expect(actions.ofType('delete').map((a) => a.channelId)).toContain(joinId);
    expect((await row()).state.private).toBeUndefined();
    expect(await joinRow()).toBeUndefined();
  });

  it('reports failure (not "Admitted") when the admit action throws', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;
    const throwing: VoiceActions = {
      createVoiceChannel: () => Promise.resolve('x'),
      deleteChannel: () => Promise.resolve(),
      renameChannel: () => Promise.resolve({ rateLimited: false }),
      moveMember: () => Promise.reject(new Error('member gone')),
      setUserLimit: () => Promise.resolve(),
      setPrivacy: () => Promise.resolve(),
      setMemberConnect: () => Promise.resolve(),
      createJoinChannel: () => Promise.resolve('j'),
      setVoiceStatus: () => Promise.resolve(),
      repositionSecondaries: () => Promise.resolve(),
      repositionGroup: () => Promise.resolve(),
      // The rest of the interface. This literal is not type-checked, so it had been
      // missing the companion methods for as long as they existed and only ever
      // worked because this one test never reaches them.
      readOverwrites: () => Promise.resolve([]),
      applyOverwrites: () =>
        Promise.resolve({
          written: [],
          droppedMemberIds: [],
          requests: 0,
          deferred: false,
          channelGone: false,
        }),
      roleExists: () => Promise.resolve(true),
      createCompanionChannel: () =>
        Promise.resolve({ channelId: 't', grantedRoleId: null, roleMissing: false }),
      syncCompanionMembers: () =>
        Promise.resolve({ added: 0, removed: 0, channelGone: false, grantedRoleId: null }),
      deleteCompanionChannel: () => Promise.resolve(),
    };
    const p2 = build({ actions: throwing });
    const res = await p2.approveJoin(joinId, 'bob');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Could not admit');
  });

  it('handleOwnerChanged renames the join channel and re-points its creator', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob');

    expect(actions.ofType('rename')).toContainEqual(
      expect.objectContaining({ channelId: joinId, name: '⇩ Join Bob' }),
    );
    expect((await joinChannels.getBySecondary(SEC))!.creatorId).toBe('bob');
  });

  it('handleOwnerChanged is a no-op for a public channel (no join companion)', async () => {
    await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob');
    expect(actions.ofType('rename')).toHaveLength(0);
  });

  it('cleanupForSecondary removes the join channel when the private channel is deleted', async () => {
    await privacy.makePrivate(GUILD, SEC, 'alice');
    const joinId = actions.ofType('joinChannel')[0]!.channelId;

    await privacy.cleanupForSecondary(GUILD, SEC);
    expect(actions.ofType('delete').map((a) => a.channelId)).toContain(joinId);
    expect(await joinRow()).toBeUndefined();
  });

  describe('makePrivateForCreation (default-private primaries)', () => {
    const FRESH = 'sec-fresh';

    beforeEach(async () => {
      // A just-spawned secondary whose creator's move hasn't landed in the voice
      // cache yet — so the channel reads as empty.
      await secondaries.create({
        channelId: FRESH,
        guildId: GUILD,
        primaryChannelId: 'p',
        ownerId: 'dave',
        state: { name: 'Dave’s den', roster: ['dave'] },
      });
    });

    it('grants Connect to the creator by id even when the voice cache is empty', async () => {
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');

      expect(bits(held(BOT, OVERWRITE_MEMBER, FRESH))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      expect(bits(held('dave', OVERWRITE_MEMBER, FRESH))).toEqual({ allow: C, deny: 0n });
      expect(bits(everyone(FRESH))).toEqual({ allow: 0n, deny: C });
      const join = actions.ofType('joinChannel').filter((a) => a.nearChannelId === FRESH);
      expect(join).toHaveLength(1);
      expect(join[0]!.name).toBe('⇩ Join Dave');

      const created = (await secondaries.get(FRESH))!;
      expect(created.state.private).toBe(true);
      // It preserves the rest of the freshly-created state (roster, name).
      expect(created.state.roster).toEqual(['dave']);
      expect(await joinChannels.getBySecondary(FRESH)).toMatchObject({ creatorId: 'dave' });
    });

    it('is idempotent: a replay does not spawn a second companion', async () => {
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');
      expect(actions.ofType('joinChannel').filter((a) => a.nearChannelId === FRESH)).toHaveLength(
        1,
      );
      expect(actions.ofType('overwrites')).toHaveLength(1);
    });

    it('no-ops for an unknown secondary', async () => {
      await privacy.makePrivateForCreation(GUILD, 'ghost', 'dave', 'Dave');
      expect(actions.ofType('joinChannel').filter((a) => a.nearChannelId === 'ghost')).toHaveLength(
        0,
      );
    });
  });

  // -- what every transition refuses ---------------------------------------------

  describe('refusals', () => {
    type Call = (
      guildId: string,
      channelId: string | undefined,
      userId: string,
    ) => Promise<CommandResult>;
    const calls: Record<string, Call> = {
      private: (g, c, u) => privacy.makePrivate(g, c, u),
      public: (g, c, u) => privacy.makePublic(g, c, u),
      hide: (g, c, u) => privacy.hide(g, c, u),
      unhide: (g, c, u) => privacy.unhide(g, c, u),
      admit: (g, c, u) => privacy.admit(g, c, u, 'bob'),
    };
    const rawAccess = async () =>
      (
        await env.handle.pool.query<{ access: unknown }>(
          'SELECT access FROM secondary_channels WHERE channel_id = $1',
          [SEC],
        )
      ).rows[0]!.access;

    /** Nothing was written anywhere, whatever was refused. */
    const untouched = async () => {
      expect(actions.ofType('overwrites')).toEqual([]);
      expect(actions.ofType('joinChannel')).toEqual([]);
      expect(actions.ofType('delete')).toEqual([]);
      expect((await row()).state.private).toBeUndefined();
    };

    it.each(Object.keys(calls))(
      '%s refuses a missing room, another guild and no channel',
      async (name) => {
        const call = calls[name]!;
        const notManaged = { ok: false, message: "This isn't a bot-managed voice channel." };
        expect(await call(GUILD, 'ghost', 'alice')).toEqual(notManaged);
        expect(await call('other-guild', SEC, 'alice')).toEqual(notManaged);
        expect(await call(GUILD, undefined, 'alice')).toEqual({
          ok: false,
          message: "You need to be in one of this server's voice channels.",
        });
        await untouched();
      },
    );

    /** Ownerless rooms pass every owner check, so each transition has to say no itself. */
    it.each(Object.keys(calls))('%s refuses an ownerless room', async (name) => {
      await env.handle.pool.query(
        'UPDATE secondary_channels SET owner_id = NULL WHERE channel_id = $1',
        [SEC],
      );
      const res = await calls[name]!(GUILD, SEC, 'mallory');
      expect(res.ok).toBe(false);
      expect(res.message).toBe(
        'This room has no owner right now. Use `/reclaim` to take it, then try again.',
      );
      await untouched();
    });

    it.each(Object.keys(calls))('%s refuses somebody who does not own the room', async (name) => {
      const res = await calls[name]!(GUILD, SEC, 'mallory');
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/^Only the (channel|room) owner can /);
      await untouched();
    });

    it.each(Object.keys(calls))(
      '%s refuses a record it cannot read, and leaves it as it was',
      async (name) => {
        const blob = { hidden: 'sideways', creatorId: 'alice', trusted: ['carol'] };
        await stageAccess(blob);
        const res = await calls[name]!(GUILD, SEC, 'alice');
        expect(res).toEqual({
          ok: false,
          message:
            "I can't read this room's access settings right now, so I have left the room exactly as it is. Try again later, and tell an admin if it keeps happening.",
        });
        expect(await rawAccess()).toEqual(blob);
        await untouched();
      },
    );

    it('never creates a Join channel on the strength of a missing record alone', async () => {
      // Private in state and a record this build cannot read: the shape a hidden room
      // has when a newer build wrote it. Looks exactly like a plain locked room.
      await stageAccess({ hidden: 'sideways' });
      await secondaries.updateState(SEC, { ...(await row()).state, private: true });
      for (const name of ['private', 'public', 'hide', 'unhide']) {
        expect((await calls[name]!(GUILD, SEC, 'alice')).ok).toBe(false);
      }
      expect(actions.ofType('joinChannel')).toEqual([]);
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('refuses when the bot cannot say who it is, rather than planning without it', async () => {
      const notReady = build({ botUserId: () => undefined });
      for (const call of [
        () => notReady.makePrivate(GUILD, SEC, 'alice'),
        () => notReady.hide(GUILD, SEC, 'alice'),
      ]) {
        expect(await call()).toEqual({
          ok: false,
          message: "I'm not ready to change this room yet. Try again in a moment.",
        });
      }
      expect((await row()).state.private).toBeUndefined();
      expect(actions.ofType('overwrites')).toEqual([]);
    });

    it('refuses /private on a hidden room with a pointer to /unhide and /public', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      const res = await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(res.ok).toBe(false);
      expect(res.message).toContain('`/unhide`');
      expect(res.message).toContain('`/public`');
      expect(liveJoinChannels()).toEqual([]);
    });

    it('answers a repeat with what the room already is', async () => {
      expect((await privacy.makePublic(GUILD, SEC, 'alice')).message).toBe(
        'This channel is already public.',
      );
      expect((await privacy.unhide(GUILD, SEC, 'alice')).message).toBe("This room isn't hidden.");
      await privacy.hide(GUILD, SEC, 'alice');
      expect((await privacy.hide(GUILD, SEC, 'alice')).message).toBe(
        'This room is already hidden.',
      );
    });
  });

  // -- the transition matrix -------------------------------------------------------

  /**
   * One row per edge, over two kinds of creator channel: an open one (nothing on
   * `@everyone`) and a role-gated one (View denied to `@everyone`, a role allowed it),
   * because the second is where the baseline and the neutralised role matter.
   *
   * What is asserted is what Discord ends up holding (the fake keeps the last bulk
   * write), the stored state, the access record and the Join channel, all together.
   */
  describe('the transition matrix', () => {
    type Mode = 'public' | 'locked' | 'hidden';
    type Seed = 'open' | 'gated';
    type Bits = { allow: bigint; deny: bigint } | undefined;
    const b = (allow: bigint, deny: bigint): Bits => ({ allow, deny });
    interface Expected {
      hidden: boolean;
      join: boolean;
      everyone: Bits;
      gate: Bits;
      mods: Bits;
      baseline: { view: string; connect: string } | undefined;
      neutralised: { roleId: string; view: string }[] | undefined;
    }
    const seeds: Record<Seed, ResolvedOverwrite[]> = {
      open: [],
      gated: [roleOw(GUILD, 0n, V), roleOw(GATE, V)],
    };
    const baselineOf = (seed: Seed) => ({
      view: seed === 'open' ? 'none' : 'deny',
      connect: 'none',
    });

    const enter = (seed: Seed, to: 'locked' | 'hidden'): Expected => ({
      hidden: to === 'hidden',
      join: to === 'locked',
      everyone: to === 'hidden' ? b(0n, VC) : b(0n, seed === 'open' ? C : VC),
      gate: seed === 'open' ? undefined : to === 'hidden' ? b(0n, V) : b(V, 0n),
      mods: to === 'hidden' ? b(V, 0n) : undefined,
      baseline: baselineOf(seed),
      neutralised:
        to === 'hidden' && seed === 'gated' ? [{ roleId: GATE, view: 'allow' }] : undefined,
    });
    const toPublic = (seed: Seed): Expected => ({
      hidden: false,
      join: false,
      // Exactly what the creator channel gave it: nothing, or the View deny.
      everyone: seed === 'open' ? undefined : b(0n, V),
      gate: seed === 'open' ? undefined : b(V, 0n),
      mods: undefined,
      baseline: undefined,
      neutralised: undefined,
    });

    const edges: { edge: string; from: Mode; to: Mode; seed: Seed; expected: Expected }[] = [];
    for (const seed of ['open', 'gated'] as const) {
      edges.push(
        {
          edge: 'public to locked',
          from: 'public',
          to: 'locked',
          seed,
          expected: enter(seed, 'locked'),
        },
        {
          edge: 'public to hidden',
          from: 'public',
          to: 'hidden',
          seed,
          expected: enter(seed, 'hidden'),
        },
        {
          edge: 'locked to hidden',
          from: 'locked',
          to: 'hidden',
          seed,
          expected: enter(seed, 'hidden'),
        },
        {
          edge: 'hidden to locked',
          from: 'hidden',
          to: 'locked',
          seed,
          expected: enter(seed, 'locked'),
        },
        { edge: 'locked to public', from: 'locked', to: 'public', seed, expected: toPublic(seed) },
        { edge: 'hidden to public', from: 'hidden', to: 'public', seed, expected: toPublic(seed) },
      );
    }

    /** Gets the room to `mode` the way a member would. */
    const bringTo = async (mode: Mode) => {
      if (mode === 'locked') expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
      if (mode === 'hidden') expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
    };
    const go = (from: Mode, to: Mode) =>
      to === 'public'
        ? privacy.makePublic(GUILD, SEC, 'alice')
        : to === 'hidden'
          ? privacy.hide(GUILD, SEC, 'alice')
          : from === 'hidden'
            ? privacy.unhide(GUILD, SEC, 'alice')
            : privacy.makePrivate(GUILD, SEC, 'alice');

    it.each(edges)('$edge ($seed creator channel)', async ({ from, to, seed, expected }) => {
      moderatorRole = MODS;
      actions.seedOverwrites(SEC, seeds[seed]);
      voice.put(SEC, member('bob'));
      await bringTo(from);
      const before = actions.ofType('joinChannel').length;

      const res = await go(from, to);
      expect(res.ok, res.message).toBe(true);

      // What Discord holds.
      expect(bits(everyone())).toEqual(expected.everyone);
      expect(bits(held(GATE, OVERWRITE_ROLE))).toEqual(expected.gate);
      expect(bits(held(MODS, OVERWRITE_ROLE))).toEqual(expected.mods);
      expect(bits(held(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      // The owner and an occupant keep a way in, in the two modes that need one.
      if (to !== 'public') {
        expect(held('alice')!.allow & C).toBe(C);
        expect(held('bob')!.allow & C).toBe(C);
      }
      if (to === 'hidden') {
        expect(held('alice')!.allow & V).toBe(V);
        expect(held('bob')!.allow & V).toBe(V);
      }

      // What is stored.
      expect((await row()).state.private).toBe(to === 'public' ? undefined : true);
      const record = await access();
      expect(record?.hidden).toBe(expected.hidden ? true : undefined);
      expect(record?.baseline).toEqual(expected.baseline);
      expect(record?.neutralised).toEqual(expected.neutralised);
      expect(record?.viewerRoleId).toBe(expected.mods ? MODS : undefined);
      expect(record?.creatorId).toBe('alice');

      // The Join channel, which a hide deletes first and an unhide makes again.
      expect(Boolean(await joinRow())).toBe(expected.join);
      expect(liveJoinChannels()).toHaveLength(expected.join ? 1 : 0);
      if (from === 'public' && to === 'locked')
        expect(actions.ofType('joinChannel')).toHaveLength(before + 1);
      if (from === 'hidden' && to === 'locked')
        expect(actions.ofType('joinChannel')).toHaveLength(before + 1);
      if (from === 'locked' && to === 'hidden') {
        expect(actions.ofType('delete').length).toBeGreaterThan(0);
      }
    });

    /**
     * A music bot is in the room because somebody put it there. Left out of the grants it kept
     * only its role's base View, which `@everyone`'s deny beats, so a hide took the room out of
     * the bot's list, and a role overwrite that allowed View was flipped to a deny as well.
     */
    it('keeps a bot that is in the room, whichever way the room is closed', async () => {
      voice.put(SEC, { ...member('musicbot'), bot: true });
      actions.seedOverwrites(SEC, [roleOw('role-music', V | C)]);

      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
      expect(bits(held('musicbot'))).toEqual({ allow: C, deny: 0n });

      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
      expect(bits(held('musicbot'))).toEqual({ allow: VC, deny: 0n });
      // Its own role's overwrite was flipped like any other, and the bot still sees the room.
      expect(bits(held('role-music', OVERWRITE_ROLE))).toEqual({ allow: C, deny: V });
      // The AVC bot has its own allow and is never granted as an occupant.
      expect(bits(held(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
    });

    /** The whole point of a baseline: out and back is the room the creator channel made. */
    it('hide, unhide and public give a role-gated room back exactly as it came', async () => {
      moderatorRole = MODS;
      actions.seedOverwrites(SEC, seeds.gated);
      voice.put(SEC, member('bob'));
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      await privacy.hide(GUILD, SEC, 'alice');
      await privacy.unhide(GUILD, SEC, 'alice');
      await privacy.makePublic(GUILD, SEC, 'alice');

      expect(bits(everyone())).toEqual({ allow: 0n, deny: V });
      expect(bits(held(GATE, OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      // A public room keeps its saved trusted overwrite (harmless) and its block (not).
      expect(bits(held('carol'))).toEqual({ allow: VC, deny: 0n });
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(await access()).toEqual({
        creatorId: 'alice',
        trusted: ['carol'],
        blocked: ['mallory'],
      });
    });

    /** A Connect deny the creator channel gave `@everyone` is not the lock, and `/public` must not wipe it. */
    it('/public keeps a Connect deny the creator channel gave @everyone', async () => {
      actions.seedOverwrites(SEC, [roleOw(GUILD, 0n, C), roleOw(GATE, C)]);
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect((await access())?.baseline).toEqual({ view: 'none', connect: 'deny' });

      await privacy.makePublic(GUILD, SEC, 'alice');

      expect(bits(everyone())).toEqual({ allow: 0n, deny: C });
    });
  });

  // -- a room an older instance locked ------------------------------------------

  /**
   * An older instance locks with an `@everyone` Connect deny and `state.private`, and
   * records no baseline. The live values of such a room ARE the lock, so recording
   * them as the original would restore the lock as the original.
   */
  describe('a room an older instance locked', () => {
    it('/public clears the Connect deny, as it always has, and never records the lock as a baseline', async () => {
      await lockedByOlderInstance();

      const res = await privacy.makePublic(GUILD, SEC, 'alice');
      expect(res.ok).toBe(true);

      expect(everyone()).toBeUndefined();
      expect((await access())?.baseline).toBeUndefined();
      expect((await row()).state.private).toBeUndefined();
      expect(await joinRow()).toBeUndefined();
    });

    it('/hide captures the View it finds and not the Connect, so /public still clears the lock', async () => {
      await lockedByOlderInstance([roleOw(GATE, V)]);
      actions.seedOverwrites(SEC, [
        ...actions.overwritesOf(SEC).filter((o) => o.id !== GUILD),
        roleOw(GUILD, V, C),
      ]);

      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
      expect((await access())?.baseline).toEqual({ view: 'allow' });
      expect(await joinRow()).toBeUndefined();
      expect(actions.ofType('delete').map((a) => a.channelId)).toContain('old-join');

      expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
      // View goes back to the allow it was, and Connect to no overwrite at all.
      expect(bits(everyone())).toEqual({ allow: V, deny: 0n });
    });

    it('/unhide of such a room restores View and leaves Connect denied', async () => {
      await lockedByOlderInstance();
      await privacy.hide(GUILD, SEC, 'alice');
      expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(true);
      expect(bits(everyone())).toEqual({ allow: 0n, deny: C });
      expect(await joinRow()).toBeDefined();
    });
  });

  // -- a write that does not land ------------------------------------------------

  describe('a write that does not land', () => {
    it('puts the room back, says so, and tells the guild when Discord refuses', async () => {
      actions.failOverwrites = true;

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain("I couldn't change who can see or join this room");
      expect(res.message).toContain('missing the permissions');
      expect((await row()).state.private).toBeUndefined();
      expect((await access())?.hidden).toBeUndefined();
      expect(await joinRow()).toBeUndefined();
      expect(actions.ofType('joinChannel')).toEqual([]);
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: SEC, operation: 'access' }),
      ]);
      expect(serverLogs).toHaveLength(1);
    });

    it('goes through on the retry, and the problem clears', async () => {
      actions.failOverwrites = true;
      await privacy.hide(GUILD, SEC, 'alice');
      expect(problems.recent(GUILD)).toHaveLength(1);

      actions.failOverwrites = false;
      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect((await access())?.hidden).toBe(true);
      expect(problems.recent(GUILD)).toEqual([]);
    });

    /**
     * The defect: a replay reads its own `@everyone` deny back as the original and
     * restores a lock as the baseline. The baseline is persisted BEFORE the first write,
     * so the retry finds it.
     */
    it('keeps the baseline it recorded before the write, so a retry never reads its own deny as the original', async () => {
      actions.failOverwrites = true;
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect((await access())?.baseline).toEqual({ view: 'none', connect: 'none' });

      // The write landed the deny, though the answer was an error.
      actions.failOverwrites = false;
      actions.seedOverwrites(SEC, [roleOw(GUILD, 0n, C)]);
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect((await access())?.baseline).toEqual({ view: 'none', connect: 'none' });

      await privacy.makePublic(GUILD, SEC, 'alice');
      expect(everyone()).toBeUndefined();
    });

    it('puts the Join channel back when a hide fails after taking it away', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      actions.failOverwrites = true;

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect((await row()).state.private).toBe(true);
      expect((await access())?.hidden).toBeUndefined();
      expect(liveJoinChannels()).toHaveLength(1);
      expect(await joinRow()).toBeDefined();
    });

    /** A failed channel create carries the name it was given, and a Join channel is named for its owner. */
    it('logs a Join channel that could not be put back without the name it was given', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      actions.failOverwrites = true;
      actions.createJoinChannel = () =>
        Promise.reject(
          new DiscordAPIError(
            { code: 50013, message: 'Missing Permissions' } as never,
            50013,
            403,
            'POST',
            'https://discord.test',
            { body: { name: '⇩ Join alice' } } as never,
          ),
        );
      const warn = vi.fn();
      privacy = build({ logger: { ...fakeLogger(), warn } as never });

      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(false);

      const logged = warn.mock.calls.filter(
        ([, message]) => message === 'could not put the join channel back after a failed hide',
      );
      expect(logged).toHaveLength(1);
      const { err } = logged[0]![0] as { err: { requestBody: unknown } };
      expect(JSON.stringify(err.requestBody)).not.toContain('alice');
    });

    it('leaves a room as it was, Join channel and all, when an exit fails', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      actions.failOverwrites = true;

      expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(false);

      expect((await row()).state.private).toBe(true);
      expect(await joinRow()).toBeDefined();
      expect(actions.ofType('delete')).toEqual([]);
    });

    it('is a failed change, with nothing written, when the channel cannot be read', async () => {
      actions.failReadOverwrites = true;
      const res = await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(res.ok).toBe(false);
      expect(await access()).toBeNull();
      expect((await row()).state.private).toBeUndefined();
    });

    it('answers a channel that is gone, which is not a failure to fix', async () => {
      actions.overwritesGoneForChannel = SEC;
      expect(await privacy.makePrivate(GUILD, SEC, 'alice')).toEqual({
        ok: false,
        message: 'That room no longer exists.',
      });
      expect(problems.recent(GUILD)).toEqual([]);
    });

    /** 30060, a deleted role and a role above the bot each need their own wording, not Manage Roles. */
    it('does not record a missing-permission problem for the limit of 1000 overrides', async () => {
      actions.applyOverwrites = () => Promise.reject(apiError(30060, 400));

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain('limit of 1000 permission overrides');
      expect(problems.recent(GUILD)).toEqual([]);
      expect((await row()).state.private).toBeUndefined();
    });

    it('records a lost-access problem, not an access one, for a channel the bot can no longer see', async () => {
      const { ChannelObfuscatedError } = await import('./discordAdapter.js');
      actions.readOverwrites = () => Promise.reject(new ChannelObfuscatedError(SEC));

      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(false);

      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: SEC, operation: 'delete' }),
      ]);
    });

    it('stops without writing when the record becomes unreadable between the read and the intent', async () => {
      const read = actions.readOverwrites.bind(actions);
      actions.readOverwrites = async (guildId, channelId) => {
        await stageAccess({ hidden: 'sideways' });
        return read(guildId, channelId);
      };

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain("can't read this room's access settings");
      expect(actions.ofType('overwrites')).toEqual([]);
      expect(actions.ofType('joinChannel')).toEqual([]);
    });

    it('stops without writing when the room is deleted between the read and the intent', async () => {
      const read = actions.readOverwrites.bind(actions);
      actions.readOverwrites = async (guildId, channelId) => {
        await secondaries.remove(SEC);
        return read(guildId, channelId);
      };

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res).toEqual({ ok: false, message: "This isn't a bot-managed voice channel." });
      expect(actions.ofType('overwrites')).toEqual([]);
    });
  });

  // -- a write Discord has only queued -------------------------------------------

  describe('a write Discord has queued behind its rate limit', () => {
    it('is not confirmed, and the intent stands because the write will land', async () => {
      actions.simulateOverwriteRateLimit = true;

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain('queued');
      expect(res.message).not.toContain('is now hidden');
      expect((await row()).state.private).toBe(true);
      expect((await access())?.hidden).toBe(true);
      expect((await access())?.baseline).toEqual({ view: 'none', connect: 'none' });
    });

    it('still makes a lock its Join channel, which does no harm ahead of the lock', async () => {
      actions.simulateOverwriteRateLimit = true;

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain('queued');
      expect(liveJoinChannels()).toHaveLength(1);
      expect((await row()).state.private).toBe(true);
    });

    it('finishes when the same exit is asked for again once the limit has cleared', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      actions.simulateOverwriteRateLimit = true;
      const queued = await privacy.unhide(GUILD, SEC, 'alice');
      expect(queued.ok).toBe(false);
      // It says what finishes it, because nothing watches the write land.
      expect(queued.message).toContain('run `/unhide` again to finish');
      // Not finalised: still recorded as hidden, because the queued write has not been seen to land.
      expect((await access())?.hidden).toBe(true);
      // And no Join channel beside it: it names the owner, and the room has not been
      // seen to open. A hidden room that has one is the leak the hide exists to prevent.
      expect(await joinRow()).toBeUndefined();
      expect(liveJoinChannels()).toHaveLength(0);

      actions.simulateOverwriteRateLimit = false;
      const again = await privacy.unhide(GUILD, SEC, 'alice');

      expect(again.ok).toBe(true);
      expect((await access())?.hidden).toBeUndefined();
      // The repeat makes it, once the write is known to have landed.
      expect(liveJoinChannels()).toHaveLength(1);
    });

    /**
     * The record of a room whose opening is queued still names the mode it is leaving, so
     * the sweep needs to be told the opening is on its way, or it would close the room again.
     */
    describe('is marked pending, for the sweep to carry through', () => {
      it('when an unhide is queued, naming the mode it is heading for', async () => {
        await privacy.hide(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = true;
        const before = Date.now();

        await privacy.unhide(GUILD, SEC, 'alice');

        const pending = (await access())?.pending;
        expect(pending?.mode).toBe('locked');
        expect(pending?.at).toBeGreaterThanOrEqual(before);
        // Still recorded as hidden, because the write has not been seen to land.
        expect((await access())?.hidden).toBe(true);
      });

      it('when a /public is queued', async () => {
        await privacy.makePrivate(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = true;

        await privacy.makePublic(GUILD, SEC, 'alice');

        expect((await access())?.pending?.mode).toBe('public');
        expect((await row()).state.private).toBe(true);
      });

      it('and not when an entry is queued, whose record already says where it is going', async () => {
        actions.simulateOverwriteRateLimit = true;

        await privacy.hide(GUILD, SEC, 'alice');

        expect((await access())?.hidden).toBe(true);
        expect((await access())?.pending).toBeUndefined();
      });

      it('and the repeat that lands takes the marker off with the rest of what it settles', async () => {
        await privacy.hide(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = true;
        await privacy.unhide(GUILD, SEC, 'alice');
        expect((await access())?.pending).toBeDefined();
        actions.simulateOverwriteRateLimit = false;

        expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(true);

        expect((await access())?.pending).toBeUndefined();
        expect((await access())?.hidden).toBeUndefined();
      });

      it('and a different change made meanwhile settles it, whichever way that goes', async () => {
        await privacy.hide(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = true;
        await privacy.unhide(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = false;

        expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);

        expect((await access())?.pending).toBeUndefined();
        expect((await row()).state.private).toBeUndefined();
      });
    });

    it('says to run /public again, not that it is on its way, for a queued opening', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      actions.simulateOverwriteRateLimit = true;

      const res = await privacy.makePublic(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain('run `/public` again to finish');
    });

    it('says how to take a queued lock back if it never arrives', async () => {
      actions.simulateOverwriteRateLimit = true;

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res.message).toContain('run `/public` and try again');
    });
  });

  // -- replay ---------------------------------------------------------------------

  describe('a repeat changes nothing', () => {
    const snapshot = async () => ({
      state: (await row()).state,
      access: await access(),
      overwrites: actions.overwritesOf(SEC),
      actions: actions.actions.length,
      join: (await joinRow())?.channelId,
    });

    it.each([
      ['private', () => privacy.makePrivate(GUILD, SEC, 'alice')],
      ['hide', () => privacy.hide(GUILD, SEC, 'alice')],
    ])('/%s twice', async (_name, run) => {
      expect((await run()).ok).toBe(true);
      const once = await snapshot();
      expect((await run()).ok).toBe(false);
      expect(await snapshot()).toEqual(once);
    });

    it('/unhide twice', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(true);
      const once = await snapshot();
      expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(false);
      expect(await snapshot()).toEqual(once);
    });

    it('/public twice', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
      const once = await snapshot();
      expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(false);
      expect(await snapshot()).toEqual(once);
    });

    it.each(['private', 'hide', 'unhide', 'public'] as const)(
      'applying the lists right after /%s finds nothing to write',
      async (command) => {
        if (command === 'unhide') await privacy.hide(GUILD, SEC, 'alice');
        if (command === 'public') await privacy.makePrivate(GUILD, SEC, 'alice');
        const run = {
          private: () => privacy.makePrivate(GUILD, SEC, 'alice'),
          hide: () => privacy.hide(GUILD, SEC, 'alice'),
          unhide: () => privacy.unhide(GUILD, SEC, 'alice'),
          public: () => privacy.makePublic(GUILD, SEC, 'alice'),
        }[command];
        expect((await run()).ok).toBe(true);
        const once = await snapshot();

        const applied = await privacy.applyAccessLists(GUILD, SEC);

        expect(applied.status).toBe('unchanged');
        expect(await snapshot()).toEqual(once);
      },
    );

    it('completes a transition that was recorded and never written', async () => {
      // What a crash between the intent and the write leaves: the mode flags and
      // the record, and a channel Discord has not been told about.
      await secondaries.transitionAccess(SEC, {
        statePatch: { private: true },
        access: () => ({ hidden: true, baseline: { view: 'none', connect: 'none' } }),
      });

      const applied = await privacy.applyAccessLists(GUILD, SEC);

      expect(applied.status).toBe('applied');
      expect(bits(everyone())).toEqual({ allow: 0n, deny: VC });
      expect(bits(held('alice'))).toEqual({ allow: VC, deny: 0n });
      expect((await access())?.hidden).toBe(true);
    });
  });

  // -- the re-render after a change ---------------------------------------------------

  /**
   * `{{PRIVATE}}` and `{{HIDDEN}}` follow the room, so every change that happened, or is
   * queued to, asks for the name to be worked out again. Detached, because the reply
   * is already waiting on a read, a bulk write and a channel, and a failed rename must
   * never fail a change that landed.
   */
  describe('the re-render after a change', () => {
    const rerender = vi.fn(
      (_guildId: string, _channelId: string): Promise<unknown> => Promise.resolve(),
    );
    beforeEach(() => {
      rerender.mockClear();
      rerender.mockImplementation(() => Promise.resolve());
      privacy = build({ rerender });
    });

    it.each([
      ['private', () => privacy.makePrivate(GUILD, SEC, 'alice')],
      ['hide', () => privacy.hide(GUILD, SEC, 'alice')],
    ] as const)('asks for it once after %s', async (_name, run) => {
      expect((await run()).ok).toBe(true);
      expect(rerender).toHaveBeenCalledTimes(1);
      expect(rerender).toHaveBeenCalledWith(GUILD, SEC);
    });

    it.each([
      ['unhide', () => privacy.unhide(GUILD, SEC, 'alice')],
      ['public', () => privacy.makePublic(GUILD, SEC, 'alice')],
    ] as const)('asks for it once after %s', async (_name, run) => {
      await privacy.hide(GUILD, SEC, 'alice');
      rerender.mockClear();
      expect((await run()).ok).toBe(true);
      expect(rerender).toHaveBeenCalledTimes(1);
      expect(rerender).toHaveBeenCalledWith(GUILD, SEC);
    });

    it('asks for it when the write is only queued, since the intent is recorded and will land', async () => {
      actions.simulateOverwriteRateLimit = true;
      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(false);
      expect(rerender).toHaveBeenCalledTimes(1);
    });

    it('does not ask for it when nothing changed: a refusal, or a write that failed', async () => {
      await privacy.makePrivate(GUILD, SEC, 'bob');
      await privacy.makePublic(GUILD, SEC, 'alice');
      await privacy.unhide(GUILD, SEC, 'alice');
      actions.failOverwrites = true;
      await privacy.hide(GUILD, SEC, 'alice');
      expect(rerender).not.toHaveBeenCalled();
    });

    it('never fails a change that landed because the name could not be worked out', async () => {
      rerender.mockImplementation(() => Promise.reject(new Error('rename failed')));
      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
      await Promise.resolve();
      expect(rerender).toHaveBeenCalledTimes(1);
    });
  });

  // -- a stale snapshot --------------------------------------------------------------

  /**
   * `updateState` replaces the whole `state` column from an older snapshot, which
   * drops `private` from a hidden room. The access record is its own column, so the
   * hide itself survives, and every reader has to derive the mode from it.
   */
  describe('a stale whole-state write racing a hide', () => {
    it('cannot make a hidden room public: the mode is derived from the record', async () => {
      const stale = await row();
      await privacy.hide(GUILD, SEC, 'alice');

      await secondaries.updateState(SEC, { ...stale.state, name: 'renamed' });

      expect((await row()).state.private).toBeUndefined();
      expect((await access())?.hidden).toBe(true);
      const res = await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(res.ok).toBe(false);
      expect(res.message).toContain('`/unhide`');
      expect(liveJoinChannels()).toEqual([]);
    });

    it('is healed by the next apply, which puts private back', async () => {
      const stale = await row();
      await privacy.hide(GUILD, SEC, 'alice');
      await secondaries.updateState(SEC, { ...stale.state, name: 'renamed' });

      const applied = await privacy.applyAccessLists(GUILD, SEC);

      expect(applied.status).toBe('applied');
      expect((await row()).state.private).toBe(true);
      expect((await row()).state.name).toBe('renamed');
    });

    it('can still be unhidden from the stale state', async () => {
      const stale = await row();
      await privacy.hide(GUILD, SEC, 'alice');
      await secondaries.updateState(SEC, { ...stale.state });

      expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(true);
      expect((await row()).state.private).toBe(true);
      expect((await access())?.hidden).toBeUndefined();
    });

    it('leaves the record intact when the replace lands during the hide', async () => {
      const stale = await row();
      await Promise.all([
        privacy.hide(GUILD, SEC, 'alice'),
        secondaries.updateState(SEC, { ...stale.state, name: 'racing' }),
      ]);
      expect((await access())?.hidden).toBe(true);
      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).message).toContain('`/unhide`');
    });

    /**
     * The defect: a LOCKED room that lost `private` reads as public, the next apply
     * (a handover, a knock decision) planned it public to public and cleared the baseline
     * the lock had captured, and the next lock then recorded its own `@everyone` deny as
     * the original, so opening the room gave that deny back and it never opened.
     */
    it('keeps the baseline of a locked room that lost private, so it can still be opened', async () => {
      // An explicit `@everyone` Connect allow before anything was locked.
      actions.seedOverwrites(SEC, [roleOw(GUILD, C)]);
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect((await access())?.baseline).toEqual({ view: 'none', connect: 'allow' });
      const { private: _lost, ...stripped } = (await row()).state;
      await secondaries.updateState(SEC, stripped);

      const applied = await privacy.applyAccessLists(GUILD, SEC);

      expect(applied.status).toBe('unchanged');
      expect((await access())?.baseline).toEqual({ view: 'none', connect: 'allow' });
      // The owner locks and opens it again, as a room that reads as public.
      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
      expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
      expect(bits(everyone())).toEqual({ allow: C, deny: 0n });
    });
  });

  // -- roles -------------------------------------------------------------------------

  describe('a role that would defeat a hide', () => {
    it('is refused, naming the roles and how to fix it, with nothing written', async () => {
      actions.seedOverwrites(SEC, [roleOw(GATE, V), roleOw('role-b', V)]);
      voice.setBotRoleAccess({ uneditableRoleIds: [GATE, 'role-b'] });

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(false);
      expect(res.message).toContain('<@&role-b> and <@&role-gate>');
      expect(res.message).toContain('Move my role above them');
      expect(actions.ofType('overwrites')).toEqual([]);
      expect((await row()).state.private).toBeUndefined();
      expect(await access()).toBeNull();
    });

    it('is not asked about when the bot can edit it: the hide neutralises it', async () => {
      actions.seedOverwrites(SEC, [roleOw(GATE, V)]);
      voice.setBotRoleAccess({ uneditableRoleIds: [] });
      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
      expect(bits(held(GATE, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
    });

    it('leaves the bot’s own managed role alone and does not count it against the hide', async () => {
      actions.seedOverwrites(SEC, [roleOw('bot-role', V)]);
      voice.setBotRoleAccess({ leaveRoleId: 'bot-role', uneditableRoleIds: ['bot-role'] });

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect(bits(held('bot-role', OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
    });

    it('reports a role it could not restore on the way out, and keeps it recorded', async () => {
      actions.seedOverwrites(SEC, [roleOw(GATE, V)]);
      await privacy.hide(GUILD, SEC, 'alice');
      voice.setBotRoleAccess({ uneditableRoleIds: [GATE] });

      const res = await privacy.unhide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect(res.message).toContain('<@&role-gate>');
      expect(res.message).toContain('sits above my role');
      expect(bits(held(GATE, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
      expect((await access())?.neutralised).toEqual([{ roleId: GATE, view: 'allow' }]);
    });
  });

  describe('the moderator role', () => {
    it('sees a hidden room (View only, never Connect), and the reply says who sees it', async () => {
      moderatorRole = MODS;

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(bits(held(MODS, OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect((await access())?.viewerRoleId).toBe(MODS);
      expect(res.message).toContain('hidden from the channel list');
      expect(res.message).toContain('Administrators always see everything');
      expect(res.message).toContain('<@&role-mods>');
    });

    it('says only Administrators see it when none is set', async () => {
      const res = await privacy.hide(GUILD, SEC, 'alice');
      expect(res.message).toContain('Administrators always see everything');
      expect(res.message).toContain('Everyone else sees it only if you let them in');
      expect(res.message).not.toContain('<@&');
    });

    it('is not granted on a locked room, where Manage Channels was never what hid it', async () => {
      moderatorRole = MODS;
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
    });

    it('is taken off when the room is unhidden or made public', async () => {
      moderatorRole = MODS;
      await privacy.hide(GUILD, SEC, 'alice');
      await privacy.unhide(GUILD, SEC, 'alice');
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect((await access())?.viewerRoleId).toBeUndefined();
    });

    it('moves with the setting: the old role loses View, the new one gains it', async () => {
      moderatorRole = MODS;
      await privacy.hide(GUILD, SEC, 'alice');

      moderatorRole = 'role-mods-2';
      const applied = await privacy.applyAccessLists(GUILD, SEC);

      expect(applied.status).toBe('applied');
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect(bits(held('role-mods-2', OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect((await access())?.viewerRoleId).toBe('role-mods-2');
    });

    /**
     * `revokeOnly` is the caller that takes entries away (`/access remove`, a handover under
     * the lever), and the lever's promise is that it adds nothing. A moderator role the
     * server set after the room was hidden is an addition, so the room keeps the one it
     * recorded and the new one is left for a change that is allowed to add.
     */
    it('is not granted to the setting’s new role by a call that only takes entries away', async () => {
      moderatorRole = MODS;
      await privacy.hide(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(held('carol')).toBeDefined();
      await lists.remove(GUILD, 'alice', 'carol');
      moderatorRole = 'role-mods-2';

      const res = await privacy.applyAccessLists(GUILD, SEC, { revokeOnly: true });

      expect(res.status).toBe('applied');
      expect(held('carol')).toBeUndefined();
      expect(held('role-mods-2', OVERWRITE_ROLE)).toBeUndefined();
      expect(bits(held(MODS, OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect((await access())?.viewerRoleId).toBe(MODS);
    });

    it('is not granted to a role set after the hide by a call that only takes entries away', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      await lists.remove(GUILD, 'alice', 'carol');
      moderatorRole = MODS;

      await privacy.applyAccessLists(GUILD, SEC, { revokeOnly: true });

      expect(held('carol')).toBeUndefined();
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect((await access())?.viewerRoleId).toBeUndefined();
    });

    it('is revoked when the setting is cleared', async () => {
      moderatorRole = MODS;
      await privacy.hide(GUILD, SEC, 'alice');

      moderatorRole = null;
      await privacy.applyAccessLists(GUILD, SEC);

      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect((await access())?.viewerRoleId).toBeUndefined();
    });

    it('is skipped when the role no longer exists, and the reply does not claim it sees the room', async () => {
      moderatorRole = MODS;
      actions.missingRoleIds.add(MODS);

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect(res.message).not.toContain('<@&');
      expect((await access())?.viewerRoleId).toBeUndefined();
    });

    it('is taken off when it is deleted after being granted', async () => {
      moderatorRole = MODS;
      await privacy.hide(GUILD, SEC, 'alice');

      actions.missingRoleIds.add(MODS);
      await privacy.applyAccessLists(GUILD, SEC);

      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect((await access())?.viewerRoleId).toBeUndefined();
    });

    it('is never @everyone, which would publish the room to the server', async () => {
      moderatorRole = GUILD;
      await privacy.hide(GUILD, SEC, 'alice');
      expect(bits(everyone())).toEqual({ allow: 0n, deny: VC });
      expect((await access())?.viewerRoleId).toBeUndefined();
    });

    it('keeps an inherited View allow the role already had when it stops being the moderator role', async () => {
      actions.seedOverwrites(SEC, [roleOw(MODS, V)]);
      moderatorRole = MODS;
      await privacy.hide(GUILD, SEC, 'alice');
      moderatorRole = null;
      await privacy.applyAccessLists(GUILD, SEC);
      // Neutralised now that it is no longer the moderator role, and restored on the way out.
      expect(bits(held(MODS, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
      await privacy.makePublic(GUILD, SEC, 'alice');
      expect(bits(held(MODS, OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
    });
  });

  // -- saved lists ------------------------------------------------------------------

  describe('applyAccessLists', () => {
    const modes = ['public', 'locked', 'hidden'] as const;
    const bringTo = async (mode: (typeof modes)[number]) => {
      if (mode === 'locked') await privacy.makePrivate(GUILD, SEC, 'alice');
      if (mode === 'hidden') await privacy.hide(GUILD, SEC, 'alice');
    };

    it.each(modes)('denies a blocked member View and Connect in a %s room', async (mode) => {
      await bringTo(mode);
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      const res = await privacy.applyAccessLists(GUILD, SEC);

      expect(res.status).toBe('applied');
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      expect((await access())?.blocked).toEqual(['mallory']);
    });

    it('lets a trusted member in only while the room is locked or hidden', async () => {
      await lists.add(GUILD, 'alice', 'carol', 'trusted');

      await privacy.applyAccessLists(GUILD, SEC);
      expect(held('carol')).toBeUndefined();

      await privacy.makePrivate(GUILD, SEC, 'alice');
      // Connect alone: a lock never touches what a member can see.
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });

      await privacy.hide(GUILD, SEC, 'alice');
      expect(bits(held('carol'))).toEqual({ allow: VC, deny: 0n });
    });

    it('applies the lists of the room’s original creator, not of whoever owns it now', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect((await access())?.creatorId).toBe('alice');
      // The owner leaves and a caretaker inherits the room: the column and the record stay put.
      await secondaries.setOwner(SEC, 'bob');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'eve', 'blocked');

      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(held('eve')).toBeUndefined();
    });

    it('falls back to the original_creator column for a room that has no record yet', async () => {
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      expect(await access()).toBeNull();

      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      expect((await access())?.creatorId).toBe('alice');
    });

    it('reads nothing from Discord for a public room that never had a record and has no lists', async () => {
      const res = await privacy.applyAccessLists(GUILD, SEC);
      expect(res).toEqual({ status: 'unchanged', movedOut: [], skippedRoleIds: [] });
      expect(actions.actions).toEqual([]);
      expect(await access()).toBeNull();
    });

    /**
     * The create path starts the read while the room is being made and hands the result over, so
     * the service does not read them again after the move, ahead of the panel.
     */
    describe('for a room that has just been made', () => {
      it('uses the lists its creator hands it, and does not read them again', async () => {
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');
        const saved = await privacy.readSavedLists(GUILD, 'alice');
        const get = vi.spyOn(lists, 'get');

        const res = await privacy.applyAccessLists(GUILD, SEC, {
          creator: { id: 'alice', saved },
        });

        expect(res.status).toBe('applied');
        expect(get).not.toHaveBeenCalled();
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      });

      it('ends the run for a creator who has blocked nobody, from the lists it was handed', async () => {
        await lists.add(GUILD, 'alice', 'carol', 'trusted');
        const saved = await privacy.readSavedLists(GUILD, 'alice');
        const get = vi.spyOn(lists, 'get');
        const read = vi.spyOn(actions, 'readOverwrites');

        const res = await privacy.applyAccessLists(GUILD, SEC, {
          creator: { id: 'alice', saved },
        });

        expect(res.status).toBe('unchanged');
        expect(get).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      });

      it('still reads them itself when the creator hands it none', async () => {
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');
        const get = vi.spyOn(lists, 'get');

        const res = await privacy.applyAccessLists(GUILD, SEC, { creator: { id: 'alice' } });

        expect(res.status).toBe('applied');
        expect(get).toHaveBeenCalledTimes(1);
      });

      it('answers nothing for the early read when it has no repository', async () => {
        const unwired = build({ memberAccessLists: undefined });
        expect(await unwired.readSavedLists(GUILD, 'alice')).toBeUndefined();
      });
    });

    it('takes back what a list granted when the member comes off it', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(held('carol')).toBeDefined();
      expect(held('mallory')).toBeDefined();

      await lists.remove(GUILD, 'alice', 'carol');
      await lists.remove(GUILD, 'alice', 'mallory');
      const res = await privacy.applyAccessLists(GUILD, SEC);

      expect(res.status).toBe('applied');
      expect(held('carol')).toBeUndefined();
      expect(held('mallory')).toBeUndefined();
      expect((await access())?.trusted).toBeUndefined();
      expect((await access())?.blocked).toBeUndefined();
    });

    it('lets a member who moves from blocked to trusted end up allowed', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'blocked');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });

      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });

    it('never takes the way back from the owner or an occupant who is dropped from a list', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      voice.put(SEC, member('bob'));
      await lists.add(GUILD, 'alice', 'bob', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);

      await lists.remove(GUILD, 'alice', 'bob');
      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('bob'))).toEqual({ allow: C, deny: 0n });
      expect(bits(held('alice'))).toEqual({ allow: C, deny: 0n });
    });

    describe('blocked members who are in the room', () => {
      it('are moved out last, from this room only, once the block is applied', async () => {
        voice.put(SEC, member('mallory'));
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');

        const res = await privacy.applyAccessLists(GUILD, SEC);

        expect(res.movedOut).toEqual(['mallory']);
        const log = actions.actions;
        const wrote = log.findIndex((a) => a.type === 'overwrites');
        const moved = log.findIndex((a) => a.type === 'move');
        expect(wrote).toBeGreaterThanOrEqual(0);
        expect(moved).toBeGreaterThan(wrote);
        expect(log[moved]).toMatchObject({
          memberId: 'mallory',
          channelId: null,
          onlyFrom: SEC,
        });
      });

      it('are left where they are when they have gone to another channel', async () => {
        voice.put(SEC, member('mallory'));
        actions.setMemberChannel('mallory', 'somewhere-else');
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');

        await privacy.applyAccessLists(GUILD, SEC);

        expect(actions.ofType('move')).toEqual([]);
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      });

      it('cost nothing when they have already left voice', async () => {
        voice.put(SEC, member('mallory'));
        actions.notConnectedMemberIds.add('mallory');
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');

        const res = await privacy.applyAccessLists(GUILD, SEC);

        expect(res.status).toBe('applied');
        expect((await access())?.blocked).toEqual(['mallory']);
      });

      it('lose nothing when the bot cannot move them: the block is already in place', async () => {
        voice.put(SEC, member('mallory'));
        actions.failMove = true;
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');

        const res = await privacy.applyAccessLists(GUILD, SEC);

        expect(res.status).toBe('applied');
        expect(res.movedOut).toEqual([]);
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      });

      it('are never the room’s owner, however the lists name them', async () => {
        await lists.add(GUILD, 'alice', 'alice', 'blocked');

        await privacy.applyAccessLists(GUILD, SEC);

        expect(held('alice')?.deny ?? 0n).toBe(0n);
        expect(actions.ofType('move')).toEqual([]);
      });

      it('are never Administrators or the server owner, who no overwrite can stop', async () => {
        voice.put(SEC, member('admin'));
        voice.put(SEC, member('boss'));
        voice.put(SEC, member('mallory'));
        voice.setMemberFacts('admin', { administrator: true });
        voice.setMemberFacts('boss', { guildOwner: true });
        await lists.add(GUILD, 'alice', 'admin', 'blocked');
        await lists.add(GUILD, 'alice', 'boss', 'blocked');
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');

        const res = await privacy.applyAccessLists(GUILD, SEC);

        expect(res.movedOut).toEqual(['mallory']);
        expect(held('admin')).toBeUndefined();
        expect(held('boss')).toBeUndefined();
        expect((await access())?.blocked).toEqual(['mallory']);
      });

      it('who become Administrators later are let off, and their deny comes off', async () => {
        voice.put(SEC, member('mallory'));
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');
        await privacy.applyAccessLists(GUILD, SEC);
        expect(held('mallory')).toBeDefined();

        voice.setMemberFacts('mallory', { administrator: true });
        await privacy.applyAccessLists(GUILD, SEC);

        expect(held('mallory')).toBeUndefined();
      });
    });

    it('is idempotent: a second run reads the room as the first left it and writes nothing', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      expect((await privacy.applyAccessLists(GUILD, SEC)).status).toBe('applied');
      const before = actions.actions.length;
      const stored = await access();

      const again = await privacy.applyAccessLists(GUILD, SEC);

      expect(again.status).toBe('unchanged');
      expect(actions.actions.length).toBe(before);
      expect(await access()).toEqual(stored);
    });

    it('leaves what is recorded alone when the repository is not wired in', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      const unwired = build({ memberAccessLists: undefined });

      expect(await unwired.applyAccessLists(GUILD, SEC)).toMatchObject({
        status: 'skipped',
        reason: 'no_lists',
      });
      // A transition planned without the lists must not read "no entries" as "all removed".
      await unwired.hide(GUILD, SEC, 'alice');
      expect(bits(held('carol'))).toEqual({ allow: VC, deny: 0n });
      expect((await access())?.trusted).toEqual(['carol']);
    });

    it('does not record a member Discord does not have as holding an overwrite', async () => {
      actions.unknownMemberIds.add('ghost');
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'ghost', 'trusted');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');

      await privacy.applyAccessLists(GUILD, SEC);

      expect(held('ghost')).toBeUndefined();
      expect((await access())?.trusted).toEqual(['carol']);
    });

    it('records a missing-permission problem and fails soft, then clears it when it works', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      actions.failOverwrites = true;

      const failed = await privacy.applyAccessLists(GUILD, SEC);

      expect(failed.status).toBe('failed');
      expect(failed.error).toBeDefined();
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: SEC, operation: 'access' }),
      ]);
      // The room is untouched and still works.
      expect((await row()).state.private).toBe(true);

      actions.failOverwrites = false;
      await privacy.applyAccessLists(GUILD, SEC);
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('does not record that problem for a failure it is not true for', async () => {
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      actions.applyOverwrites = () => Promise.reject(apiError(30060, 400));

      const res = await privacy.applyAccessLists(GUILD, SEC);

      expect(res.status).toBe('failed');
      expect(problems.recent(GUILD)).toEqual([]);
    });

    it('never throws, whatever it meets', async () => {
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      actions.readOverwrites = () => Promise.reject(new Error('socket hang up'));
      await expect(privacy.applyAccessLists(GUILD, SEC)).resolves.toMatchObject({
        status: 'failed',
      });
      const broken = build({
        memberAccessLists: {
          get: () => Promise.reject(new Error('db down')),
        } as unknown as MemberAccessListRepository,
      });
      await expect(broken.applyAccessLists(GUILD, SEC)).resolves.toMatchObject({
        status: 'failed',
      });
    });

    it('skips a record it cannot read, a missing room and another guild’s room', async () => {
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      expect(await privacy.applyAccessLists(GUILD, 'ghost')).toMatchObject({
        status: 'skipped',
        reason: 'no_room',
      });
      expect(await privacy.applyAccessLists('other-guild', SEC)).toMatchObject({
        status: 'skipped',
        reason: 'no_room',
      });
      await stageAccess({ hidden: 'sideways' });
      expect(await privacy.applyAccessLists(GUILD, SEC)).toMatchObject({
        status: 'skipped',
        reason: 'unreadable',
      });
      expect(actions.actions).toEqual([]);
    });

    it('reports the roles it could not edit, and does the rest', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      // The setting now names a role the bot sits below, so it cannot be granted View.
      moderatorRole = MODS;
      voice.setBotRoleAccess({ uneditableRoleIds: [MODS] });
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      const res = await privacy.applyAccessLists(GUILD, SEC);

      expect(res.status).toBe('applied');
      expect(res.skippedRoleIds).toEqual([MODS]);
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
    });
  });

  // -- admit --------------------------------------------------------------------------

  describe('admit', () => {
    it('lets a member into a locked room with Connect, recorded for this room only', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');

      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');

      expect(res).toEqual({
        ok: true,
        message: 'Let <@carol> into this room. They can join it until the room is deleted.',
      });
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
      expect((await access())?.admitted).toEqual(['carol']);
      // Not on the saved list: it dies with the room.
      expect((await lists.get(GUILD, 'alice')).trusted).toEqual([]);
    });

    it('lets a member into a hidden room with View and Connect', async () => {
      await privacy.hide(GUILD, SEC, 'alice');

      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');

      expect(res.message).toContain('They can see it and join it');
      expect(bits(held('carol'))).toEqual({ allow: VC, deny: 0n });
    });

    /**
     * The defect: a member Discord has not got in the server was left out of the write,
     * and the reply still said they could join, with their id kept in the record.
     */
    it.each(['locked', 'hidden'] as const)(
      'says so, and records nothing, when Discord has nobody by that id in a %s room',
      async (mode) => {
        if (mode === 'locked') await privacy.makePrivate(GUILD, SEC, 'alice');
        else await privacy.hide(GUILD, SEC, 'alice');
        await privacy.admit(GUILD, SEC, 'alice', 'dave');
        actions.unknownMemberIds.add('carol');

        const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');

        expect(res).toEqual({
          ok: false,
          message: "<@carol> isn't in this server, so I couldn't let them in.",
        });
        expect(held('carol')).toBeUndefined();
        // Only the one who is not there comes back out, and the member who is stays.
        expect((await access())?.admitted).toEqual(['dave']);
        expect(held('dave')).toBeDefined();
      },
    );

    it('says an open room has nothing to admit anyone to', async () => {
      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/^It is open to everyone/);
      expect(await access()).toBeNull();
    });

    it('refuses the owner and the bot, who always have access', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect((await privacy.admit(GUILD, SEC, 'alice', 'alice')).message).toBe(
        'You already have access to your own room.',
      );
      expect((await privacy.admit(GUILD, SEC, 'alice', BOT)).message).toBe(
        'I always have access to this room.',
      );
    });

    it('refuses a member on the owner’s blocked list, and one a vote removed, rather than doing nothing', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const blocked = await privacy.admit(GUILD, SEC, 'alice', 'mallory');
      expect(blocked.ok).toBe(false);
      expect(blocked.message).toContain('is on your blocked list');

      await privacy.denyKicked(GUILD, SEC, 'eve');
      const kicked = await privacy.admit(GUILD, SEC, 'alice', 'eve');
      expect(kicked.ok).toBe(false);
      expect(kicked.message).toContain('was voted out of this room');
      expect(held('eve')?.allow ?? 0n).toBe(0n);
    });

    it('is a replay: the second admission writes nothing and says the same', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const first = await privacy.admit(GUILD, SEC, 'alice', 'carol');
      const before = actions.actions.length;

      const second = await privacy.admit(GUILD, SEC, 'alice', 'carol');

      expect(second).toEqual(first);
      expect(actions.actions.length).toBe(before);
      expect((await access())?.admitted).toEqual(['carol']);
    });

    it('survives a /public, harmless, and is gone with the room', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await privacy.admit(GUILD, SEC, 'alice', 'carol');
      await privacy.makePublic(GUILD, SEC, 'alice');
      expect((await access())?.admitted).toEqual(['carol']);

      await secondaries.remove(SEC);
      expect(await access()).toBeNull();
    });

    it('does not say it worked when the write did not, and keeps the request for the next apply', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      actions.failOverwrites = true;

      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');

      expect(res.ok).toBe(false);
      expect(res.message).toContain("I couldn't let <@carol> in");
      expect((await access())?.admitted).toEqual(['carol']);
      actions.failOverwrites = false;
      await privacy.applyAccessLists(GUILD, SEC);
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });

    it('does not say it worked when Discord has only queued it', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      actions.simulateOverwriteRateLimit = true;
      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');
      expect(res.ok).toBe(false);
      expect(res.message).toContain('queued');
    });
  });

  // -- a vote ---------------------------------------------------------------------------

  describe('denyKicked', () => {
    it('records the member and denies View and Connect in a room that has no record yet', async () => {
      const done = await privacy.denyKicked(GUILD, SEC, 'carol');

      expect(done).toBe(true);
      expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
      // Holding only the creator and the member.
      expect(await access()).toEqual({ creatorId: 'alice', kicked: ['carol'] });
      expect((await row()).state.private).toBeUndefined();
    });

    it.each(['public', 'locked', 'hidden'] as const)('does it in a %s room', async (mode) => {
      if (mode === 'locked') await privacy.makePrivate(GUILD, SEC, 'alice');
      if (mode === 'hidden') await privacy.hide(GUILD, SEC, 'alice');

      expect(await privacy.denyKicked(GUILD, SEC, 'carol')).toBe(true);

      expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
      expect((await access())?.kicked).toEqual(['carol']);
    });

    /** The defect: a trusted member's grant replaced the unrecorded deny a kick left. */
    it('stays in force against a trusted member, however many times the lists are applied', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });

      await privacy.denyKicked(GUILD, SEC, 'carol');
      await privacy.applyAccessLists(GUILD, SEC);
      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
    });

    it('is not undone by a change to the saved list, which only takes back what it wrote', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'blocked');
      await privacy.applyAccessLists(GUILD, SEC);
      await privacy.denyKicked(GUILD, SEC, 'carol');

      await lists.remove(GUILD, 'alice', 'carol');
      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
      expect((await access())?.blocked).toBeUndefined();
      expect((await access())?.kicked).toEqual(['carol']);
    });

    it('is a replay: a second kick of the same member records them once', async () => {
      await privacy.denyKicked(GUILD, SEC, 'carol');
      const before = actions.actions.length;
      expect(await privacy.denyKicked(GUILD, SEC, 'carol')).toBe(true);
      expect((await access())?.kicked).toEqual(['carol']);
      expect(actions.actions.length).toBe(before);
    });

    it('says it could not when the record cannot be read, so the caller bars them another way', async () => {
      await stageAccess({ hidden: 'sideways' });
      expect(await privacy.denyKicked(GUILD, SEC, 'carol')).toBe(false);
      expect(held('carol')).toBeUndefined();
    });

    it('says it could not when Discord refuses, and never throws', async () => {
      actions.failOverwrites = true;
      expect(await privacy.denyKicked(GUILD, SEC, 'carol')).toBe(false);
      // Still recorded, which is the safe direction.
      expect((await access())?.kicked).toEqual(['carol']);
    });

    it('moves the voted-out member out of the room, from this room only', async () => {
      voice.put(SEC, member('carol'));
      await privacy.denyKicked(GUILD, SEC, 'carol');
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'carol', channelId: null, onlyFrom: SEC }),
      );
    });
  });

  // -- the knock card -----------------------------------------------------------------

  describe('the knock card', () => {
    const lock = async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      return actions.ofType('joinChannel')[0]!.channelId;
    };

    describe('Block', () => {
      it('saves the block, denies the requester the room, and keeps the join channel deny', async () => {
        const joinId = await lock();

        const res = await privacy.denyJoin(joinId, 'carol', true);

        // Says what was saved and where it applies, and how to undo it.
        expect(res).toEqual({ ok: true, message: `Blocked <@carol>.${savedNote('blocked')}` });
        expect(res.message).toContain('rooms you create in this server');
        expect(res.message).toContain('`/access remove`');
        expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['carol']);
        expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
        expect(actions.ofType('connect')).toContainEqual(
          expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
        );
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'carol', channelId: null, onlyFrom: joinId }),
        );
      });

      it('applies the block to the room first, and moves them out last', async () => {
        const joinId = await lock();
        await privacy.denyJoin(joinId, 'carol', true);
        const log = actions.actions.slice(
          actions.actions.findIndex((a) => a.type === 'joinChannel') + 1,
        );
        const types = log.map((a) => a.type);
        expect(types.at(-1)).toBe('move');
        expect(types.indexOf('overwrites')).toBeLessThan(types.indexOf('move'));
      });

      /**
       * The defect: a failed deny on the join channel returned "could not block" before
       * the requester was moved, although the block was saved and applied, and the card's
       * buttons were already gone, so they sat in the lobby with no way to be removed.
       */
      it('is a note, not a failure, when only the join channel deny fails, and they are still moved out', async () => {
        const joinId = await lock();
        actions.setMemberConnect = () => Promise.reject(apiError(50013));

        const res = await privacy.denyJoin(joinId, 'carol', true);

        expect(res.ok).toBe(true);
        expect(res.message).toContain('Blocked <@carol>.');
        expect(res.message).toContain(
          'I could not stop them knocking on the **⇩ Join** channel again.',
        );
        expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['carol']);
        expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'carol', channelId: null, onlyFrom: joinId }),
        );
      });

      it('fails when the join channel deny fails and nothing was saved, because that was the whole block', async () => {
        const joinId = await lock();
        actions.setMemberConnect = () => Promise.reject(apiError(50013));
        const plain = build({ memberAccessLists: undefined });

        const res = await plain.denyJoin(joinId, 'carol', true);

        expect(res.ok).toBe(false);
        expect(res.message).toContain('Could not block <@carol>');
        expect(actions.ofType('move').filter((a) => a.memberId === 'carol')).toEqual([]);
      });

      it.each([
        ['an Administrator', () => voice.setMemberFacts('admin', { administrator: true }), 'admin'],
        ['the server owner', () => voice.setMemberFacts('boss', { guildOwner: true }), 'boss'],
        ['the bot', () => undefined, BOT],
      ])(
        'only denies %s, says no block can stop them, and saves nothing',
        async (_who, stage, id) => {
          const joinId = await lock();
          stage();

          const res = await privacy.denyJoin(joinId, id, true);

          expect(res.ok).toBe(true);
          expect(res.message).toMatch(/^Denied /);
          expect(res.message).not.toContain('Blocked');
          expect(res.message).toContain('permissions that override any block');
          expect((await lists.get(GUILD, 'alice')).blocked).toEqual([]);
          expect(actions.ofType('connect').filter((a) => a.memberId === id)).toEqual([]);
          // The bot always holds its own allow on the room.
          if (id !== BOT) expect(held(id)).toBeUndefined();
        },
      );

      it('does not lose the block when the requester has already left voice', async () => {
        const joinId = await lock();
        actions.notConnectedMemberIds.add('carol');
        const res = await privacy.denyJoin(joinId, 'carol', true);
        expect(res.ok).toBe(true);
        expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['carol']);
        expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
      });

      it('does not lose the block when the bot cannot move them, and says so', async () => {
        const joinId = await lock();
        actions.failMove = true;
        const res = await privacy.denyJoin(joinId, 'carol', true);
        expect(res.ok).toBe(true);
        expect(res.message).toContain('I could not move them out of the voice channel.');
        expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['carol']);
      });

      it('says the list is full when it is, and still blocks them here', async () => {
        const joinId = await lock();
        for (let i = 0; i < 25; i++) await lists.add(GUILD, 'alice', `filler-${i}`, 'blocked');

        const res = await privacy.denyJoin(joinId, 'carol', true);

        expect(res.ok).toBe(true);
        expect(res.message).toContain('Your blocked list is full (25)');
        expect(actions.ofType('connect')).toContainEqual(
          expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
        );
        expect((await lists.get(GUILD, 'alice')).blocked).not.toContain('carol');
      });

      it('takes a trusted member off that list, and denies them', async () => {
        const joinId = await lock();
        await lists.add(GUILD, 'alice', 'carol', 'trusted');
        await privacy.applyAccessLists(GUILD, SEC);

        await privacy.denyJoin(joinId, 'carol', true);

        expect(await lists.get(GUILD, 'alice')).toEqual({ trusted: [], blocked: ['carol'] });
        expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
      });

      it('works as it always did when there is nowhere to save', async () => {
        const joinId = await lock();
        const plain = build({ memberAccessLists: undefined });
        const res = await plain.denyJoin(joinId, 'carol', true);
        expect(res).toEqual({ ok: true, message: 'Blocked <@carol>.' });
        expect(actions.ofType('connect')).toContainEqual(
          expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
        );
      });

      it('still fails a plain deny when the move fails, as before', async () => {
        const joinId = await lock();
        actions.failMove = true;
        const res = await privacy.denyJoin(joinId, 'carol', false);
        expect(res.ok).toBe(false);
        expect(res.message).toContain('Could not deny <@carol>');
      });

      it('survives the list failing, which costs the saving and not the decision', async () => {
        const joinId = await lock();
        const broken = build({
          memberAccessLists: {
            add: () => Promise.reject(new Error('db down')),
            get: () => Promise.reject(new Error('db down')),
          } as unknown as MemberAccessListRepository,
        });
        const res = await broken.denyJoin(joinId, 'carol', true);
        expect(res.ok).toBe(true);
        expect(res.message).toContain('I could not save them to your blocked list.');
        expect(actions.ofType('connect')).toContainEqual(
          expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
        );
      });
    });

    describe('Always allow', () => {
      it('admits them, and saves them to the trusted list so every room lets them in', async () => {
        const joinId = await lock();

        const res = await privacy.approveJoin(joinId, 'bob', true);

        expect(res).toEqual({ ok: true, message: `Admitted <@bob>.${savedNote('trusted')}` });
        expect(res.message).toContain('rooms you create in this server');
        expect(res.message).toContain('`/access remove`');
        expect((await lists.get(GUILD, 'alice')).trusted).toEqual(['bob']);
        expect(bits(held('bob'))).toEqual({ allow: C, deny: 0n });
        expect((await access())?.trusted).toEqual(['bob']);
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'bob', channelId: SEC }),
        );
      });

      it('is a plain approval without the flag, saving nobody', async () => {
        const joinId = await lock();
        await privacy.approveJoin(joinId, 'bob');
        expect((await lists.get(GUILD, 'alice')).trusted).toEqual([]);
        expect((await access())?.trusted).toBeUndefined();
      });

      it('admits them all the same when the list is full, and says so', async () => {
        const joinId = await lock();
        for (let i = 0; i < 25; i++) await lists.add(GUILD, 'alice', `filler-${i}`, 'trusted');

        const res = await privacy.approveJoin(joinId, 'bob', true);

        expect(res.ok).toBe(true);
        expect(res.message).toContain('Your trusted list is full (25)');
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'bob', channelId: SEC }),
        );
      });

      it('admits them all the same when there is nowhere to save', async () => {
        const joinId = await lock();
        const plain = build({ memberAccessLists: undefined });
        expect(await plain.approveJoin(joinId, 'bob', true)).toEqual({
          ok: true,
          message: 'Admitted <@bob>.',
        });
      });
    });

    /**
     * A card outlives the decision that made it stale. The owner blocks a knock, the
     * same person knocks again, and the older card's Approve is pressed: a grant would
     * replace the deny the block left and the bot would move them straight in.
     */
    describe('Approve on a card that has gone stale', () => {
      it('refuses a requester the owner has since blocked, and grants them nothing', async () => {
        const joinId = await lock();
        await privacy.denyJoin(joinId, 'carol', true);
        const before = actions.actions.length;

        const res = await privacy.approveJoin(joinId, 'carol');

        expect(res).toEqual({
          ok: false,
          message:
            '<@carol> is on your blocked list, so I did not let them in. Take them off it first if you want them in.',
        });
        expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
        expect(actions.actions).toHaveLength(before);
      });

      it('refuses one a vote has since removed from the room', async () => {
        const joinId = await lock();
        await privacy.denyKicked(GUILD, SEC, 'eve');
        const before = actions.actions.length;

        const res = await privacy.approveJoin(joinId, 'eve', true);

        expect(res).toEqual({
          ok: false,
          message: '<@eve> was voted out of this room, so I did not let them in.',
        });
        expect(bits(held('eve'))).toEqual({ allow: 0n, deny: VC });
        expect(actions.actions).toHaveLength(before);
        expect((await lists.get(GUILD, 'alice')).trusted).toEqual([]);
      });

      it('still admits an Administrator who is on the list, since nothing written keeps them out', async () => {
        const joinId = await lock();
        await lists.add(GUILD, 'alice', 'admin', 'blocked');
        voice.setMemberFacts('admin', { administrator: true });

        expect((await privacy.approveJoin(joinId, 'admin')).ok).toBe(true);
      });

      it('admits when the list cannot be read, as a knock is let through', async () => {
        const joinId = await lock();
        const broken = build({
          memberAccessLists: {
            get: () => Promise.reject(new Error('db down')),
          } as unknown as MemberAccessListRepository,
        });

        expect(await broken.approveJoin(joinId, 'bob')).toEqual({
          ok: true,
          message: 'Admitted <@bob>.',
        });
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'bob', channelId: SEC }),
        );
      });
    });

    describe('a blocked requester', () => {
      const ctxOf = async (joinId: string) => (await privacy.getJoinContext(joinId))!;

      it('is not turned away when nothing written could keep them out of the room anyway', async () => {
        const joinId = await lock();
        await lists.add(GUILD, 'alice', 'admin', 'blocked');
        voice.setMemberFacts('admin', { administrator: true });

        expect(await privacy.refuseBlockedKnock(await ctxOf(joinId), 'admin')).toBe(false);

        expect(actions.ofType('move')).toEqual([]);
      });

      it('is turned away: moved out of the join channel, and the caller posts nothing', async () => {
        const joinId = await lock();
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');

        expect(await privacy.refuseBlockedKnock(await ctxOf(joinId), 'mallory')).toBe(true);

        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'mallory', channelId: null, onlyFrom: joinId }),
        );
      });

      it('is turned away when it is the current owner who blocked them, not the creator', async () => {
        const joinId = await lock();
        await secondaries.setOwner(SEC, 'bob');
        await joinChannels.setCreatorBySecondary(SEC, 'bob');
        await lists.add(GUILD, 'bob', 'mallory', 'blocked');

        expect(await privacy.refuseBlockedKnock(await ctxOf(joinId), 'mallory')).toBe(true);
      });

      it('is turned away when a vote removed them from the room', async () => {
        const joinId = await lock();
        await privacy.denyKicked(GUILD, SEC, 'eve');
        expect(await privacy.refuseBlockedKnock(await ctxOf(joinId), 'eve')).toBe(true);
      });

      it('leaves everybody else to knock, and moves nobody', async () => {
        const joinId = await lock();
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');
        const before = actions.ofType('move').length;

        expect(await privacy.refuseBlockedKnock(await ctxOf(joinId), 'bob')).toBe(false);

        expect(actions.ofType('move')).toHaveLength(before);
      });

      it('still counts as turned away when the move fails or they have already left', async () => {
        const joinId = await lock();
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');
        actions.failMove = true;
        expect(await privacy.refuseBlockedKnock(await ctxOf(joinId), 'mallory')).toBe(true);
      });

      it('fails open when the list cannot be read: a card that was not needed beats a guess', async () => {
        const joinId = await lock();
        const broken = build({
          memberAccessLists: {
            get: () => Promise.reject(new Error('db down')),
          } as unknown as MemberAccessListRepository,
        });
        expect(await broken.refuseBlockedKnock(await ctxOf(joinId), 'mallory')).toBe(false);
        expect(actions.ofType('move')).toEqual([]);
      });
    });
  });

  // -- the Join channel ----------------------------------------------------------------

  describe('the "⇩ Join" channel', () => {
    it('is named with the owner’s /nick, as the other two sites name it', async () => {
      nicks.set('alice', 'Ally');
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(actions.ofType('joinChannel')[0]!.name).toBe('⇩ Join Ally');

      await privacy.hide(GUILD, SEC, 'alice');
      await privacy.unhide(GUILD, SEC, 'alice');
      expect(actions.ofType('joinChannel').at(-1)!.name).toBe('⇩ Join Ally');
    });

    it('denies the owner’s saved blocked members Connect when it is made, and nothing else on it', async () => {
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'alice', 'eve', 'blocked');

      await privacy.makePrivate(GUILD, SEC, 'alice');

      const joinId = actions.ofType('joinChannel')[0]!.channelId;
      expect(bits(held('mallory', OVERWRITE_MEMBER, joinId))).toEqual({ allow: 0n, deny: C });
      expect(bits(held('eve', OVERWRITE_MEMBER, joinId))).toEqual({ allow: 0n, deny: C });
      expect(bits(held(BOT, OVERWRITE_MEMBER, joinId))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      expect(actions.overwritesOf(joinId)).toHaveLength(3);
    });

    it('is not touched, and not made again, when the room already has one', async () => {
      await joinChannels.create({
        channelId: 'stray-join',
        guildId: GUILD,
        secondaryChannelId: SEC,
        creatorId: 'alice',
      });
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(actions.ofType('joinChannel')).toEqual([]);
      expect(actions.overwritesOf('stray-join')).toEqual([]);
      expect((await joinRow())?.channelId).toBe('stray-join');
    });

    it('keeps only the oldest when two creators race, and the loser deletes its own', async () => {
      const make = actions.createJoinChannel.bind(actions);
      actions.createJoinChannel = async (guildId, name, near) => {
        const id = await make(guildId, name, near);
        // Somebody else's lock got its row in first.
        await joinChannels.create({
          channelId: 'aaa-first',
          guildId,
          secondaryChannelId: near,
          creatorId: 'alice',
        });
        await env.handle.pool.query(
          "UPDATE join_channels SET created_at = now() - interval '1 minute' WHERE channel_id = 'aaa-first'",
        );
        return id;
      };

      const res = await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect((await joinRow())?.channelId).toBe('aaa-first');
      const mine = actions.ofType('joinChannel')[0]!.channelId;
      expect(actions.ofType('delete').map((a) => a.channelId)).toContain(mine);
      expect(await joinChannels.get(mine)).toBeUndefined();
    });

    /**
     * The defect: only the oldest channel was deleted while every row was forgotten, so a
     * second one, left by a replay, stayed visible beside a hidden room and named its owner.
     */
    it.each(['hide', 'public'] as const)(
      'deletes every Join channel the room has when it %s, and forgets each',
      async (leave) => {
        await privacy.makePrivate(GUILD, SEC, 'alice');
        const first = actions.ofType('joinChannel')[0]!.channelId;
        await joinChannels.create({
          channelId: 'second-join',
          guildId: GUILD,
          secondaryChannelId: SEC,
          creatorId: 'alice',
        });

        const res =
          leave === 'hide'
            ? await privacy.hide(GUILD, SEC, 'alice')
            : await privacy.makePublic(GUILD, SEC, 'alice');

        expect(res.ok).toBe(true);
        expect(actions.ofType('delete').map((a) => a.channelId)).toEqual(
          expect.arrayContaining([first, 'second-join']),
        );
        expect(await joinRow()).toBeUndefined();
      },
    );

    it('is one channel when the same unhide runs twice at once', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      await Promise.all([privacy.unhide(GUILD, SEC, 'alice'), privacy.unhide(GUILD, SEC, 'alice')]);
      expect(liveJoinChannels()).toHaveLength(1);
      expect((await joinRow())?.channelId).toBe(liveJoinChannels()[0]!.channelId);
    });

    it('is reported, not thrown, when it cannot be made, and the room is still locked', async () => {
      actions.createJoinChannel = () => Promise.reject(apiError(50013));
      const res = await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(res.ok).toBe(false);
      expect(res.message).toContain("I couldn't create its **⇩ Join** channel");
      expect((await row()).state.private).toBe(true);
      expect(bits(everyone())).toEqual({ allow: 0n, deny: C });
    });
  });

  // -- creation --------------------------------------------------------------------------

  describe('a room made private as it is created', () => {
    const FRESH = 'sec-fresh';
    beforeEach(async () => {
      await secondaries.create({
        channelId: FRESH,
        guildId: GUILD,
        primaryChannelId: 'p',
        ownerId: 'dave',
        state: { name: 'Dave’s den', roster: ['dave'] },
      });
    });
    const inFresh = (id: string, type = OVERWRITE_MEMBER) => held(id, type, FRESH);
    const recordOfFresh = () => secondaries.getAccess(FRESH);

    it('takes its baseline from the channel as it was created, so /public gives back the inherited deny', async () => {
      // A role-gated creator channel: `@everyone` Connect denied before anyone locked anything.
      actions.seedOverwrites(FRESH, [roleOw(GUILD, 0n, C)]);

      expect(await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave')).toEqual({
        ok: true,
        applied: true,
      });
      expect((await recordOfFresh())?.baseline).toEqual({ view: 'none', connect: 'deny' });

      await privacy.makePublic(GUILD, FRESH, 'dave');
      expect(bits(inFresh(GUILD, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: C });
    });

    it('can be born hidden: the owner by id, the bot, the deny, and no Join channel', async () => {
      moderatorRole = MODS;
      actions.seedOverwrites(FRESH, [roleOw(GATE, V)]);

      expect(
        await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden'),
      ).toEqual({ ok: true, applied: true });

      expect(bits(inFresh('dave'))).toEqual({ allow: VC, deny: 0n });
      expect(bits(inFresh(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      expect(bits(inFresh(GUILD, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: VC });
      expect(bits(inFresh(GATE, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: V });
      expect(bits(inFresh(MODS, OVERWRITE_ROLE))).toEqual({ allow: V, deny: 0n });
      expect(actions.ofType('joinChannel').filter((a) => a.nearChannelId === FRESH)).toEqual([]);
      expect(await joinChannels.getBySecondary(FRESH)).toBeUndefined();
      const created = (await secondaries.get(FRESH))!;
      expect(created.state.private).toBe(true);
      expect(created.state.roster).toEqual(['dave']);
      expect((await recordOfFresh())?.hidden).toBe(true);
    });

    it('is idempotent in either mode', async () => {
      await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden');
      const before = actions.actions.length;
      expect(
        await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden'),
      ).toEqual({ ok: true, applied: false });
      expect(await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave')).toEqual({
        ok: true,
        applied: false,
      });
      expect(actions.actions.length).toBe(before);
    });

    it('fails soft: a typed failure, the room put back, and nothing thrown', async () => {
      actions.failOverwrites = true;

      const res = await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden');

      expect(res).toMatchObject({ ok: false, reason: 'failed' });
      expect((res as { error?: unknown }).error).toBeInstanceOf(DiscordAPIError);
      const after = (await secondaries.get(FRESH))!;
      expect(after.state.private).toBeUndefined();
      expect((await recordOfFresh())?.hidden).toBeUndefined();
      expect(await joinChannels.getBySecondary(FRESH)).toBeUndefined();
    });

    it('still throws from makePrivateForCreation, which the admin default’s rollback reads', async () => {
      actions.failOverwrites = true;
      await expect(
        privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave'),
      ).rejects.toMatchObject({
        code: 50013,
      });
    });

    /** The defect: a mode the throwing method dropped made every admin default a lock. */
    it('makes a hidden room from makePrivateForCreation when it is told to', async () => {
      await privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden');

      expect(bits(inFresh(GUILD, OVERWRITE_ROLE))).toEqual({ allow: 0n, deny: VC });
      expect((await recordOfFresh())?.hidden).toBe(true);
      expect(await joinChannels.getBySecondary(FRESH)).toBeUndefined();
    });

    /**
     * A refusal carries no Discord error, so the throwing method gives it a type of its own
     * for the rollback to recognise: a hide a role above the bot would defeat is a room that
     * cannot be made hidden, and the create path deletes it. A plain Error would escape the
     * create path with the room still open to everyone.
     */
    it('throws a CreationRefusedError when the plan refuses, and tryMake says refused', async () => {
      voice.setBotRoleAccess({ uneditableRoleIds: [GATE] });
      actions.seedOverwrites(FRESH, [roleOw(GATE, V)]);

      expect(
        await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden'),
      ).toEqual({ ok: false, reason: 'refused' });
      // Nothing was written, so the room is exactly as it was created.
      expect((await secondaries.get(FRESH))!.state.private).toBeUndefined();
      expect(actions.ofType('overwrites')).toEqual([]);

      await expect(
        privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden'),
      ).rejects.toBeInstanceOf(CreationRefusedError);
      // And not for a failure that is not a refusal.
      actions.failOverwrites = true;
      voice.setBotRoleAccess({ uneditableRoleIds: [] });
      await expect(
        privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden'),
      ).rejects.not.toBeInstanceOf(CreationRefusedError);
    });

    it('throws what a failed Join channel threw, so the rollback can read it, and tryMake says it', async () => {
      actions.createJoinChannel = () => Promise.reject(apiError(50013));

      const typed = await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');
      expect(typed).toMatchObject({ ok: false, reason: 'failed' });
      expect((typed as { error?: unknown }).error).toBeInstanceOf(DiscordAPIError);
      // The lock itself landed: only the way for others to knock is missing.
      expect((await secondaries.get(FRESH))!.state.private).toBe(true);

      await secondaries.create({
        channelId: 'sec-fresh-2',
        guildId: GUILD,
        primaryChannelId: 'p',
        ownerId: 'erin',
        state: { name: 'Erin’s den', roster: ['erin'] },
      });
      await expect(
        privacy.makePrivateForCreation(GUILD, 'sec-fresh-2', 'erin', 'Erin'),
      ).rejects.toMatchObject({ code: 50013 });
    });

    it('is applied, and says it is only queued, behind a rate limit', async () => {
      actions.simulateOverwriteRateLimit = true;

      expect(await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave')).toEqual({
        ok: true,
        applied: true,
        deferred: true,
      });
      // The create path treats a queued lock as done, so it must not roll the room back.
      await secondaries.create({
        channelId: 'sec-fresh-3',
        guildId: GUILD,
        primaryChannelId: 'p',
        ownerId: 'erin',
        state: { name: 'Erin’s den', roster: ['erin'] },
      });
      await expect(
        privacy.makePrivateForCreation(GUILD, 'sec-fresh-3', 'erin', 'Erin'),
      ).resolves.toBeUndefined();
    });

    it('is not attempted before the bot knows who it is, and throws that from makePrivateForCreation', async () => {
      const early = build({ botUserId: () => undefined });

      expect(await early.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave')).toEqual({
        ok: false,
        reason: 'not_ready',
      });
      await expect(early.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave')).rejects.toThrow(
        /not_ready/,
      );
      expect(actions.actions).toEqual([]);
    });

    /**
     * The defect: the service recorded the failure against the room, then the create
     * path's rollback deleted the room and recorded it against the creator channel, so
     * the guild was told twice and one of the two named a channel that no longer exists.
     */
    it('leaves the problem to the rollback when the throwing method fails, and records it when a remembered preference fails', async () => {
      actions.failOverwrites = true;

      await expect(
        privacy.makePrivateForCreation(GUILD, FRESH, 'dave', 'Dave'),
      ).rejects.toMatchObject({ code: 50013 });
      expect(problems.recent(GUILD)).toEqual([]);
      expect(serverLogs).toEqual([]);

      // A remembered preference keeps its room, so the guild does hear about this one.
      const res = await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave');
      expect(res).toMatchObject({ ok: false, reason: 'failed' });
      expect(problems.recent(GUILD)).toHaveLength(1);
      expect(problems.recent(GUILD)[0]).toMatchObject({ channelId: FRESH, operation: 'access' });
      expect(serverLogs).toHaveLength(1);
    });

    it('says a hide a role would defeat is refused, and writes nothing', async () => {
      actions.seedOverwrites(FRESH, [roleOw(GATE, V)]);
      voice.setBotRoleAccess({ uneditableRoleIds: [GATE] });

      const res = await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave', 'hidden');

      expect(res).toEqual({ ok: false, reason: 'refused' });
      expect(actions.ofType('overwrites')).toEqual([]);
      expect((await secondaries.get(FRESH))!.state.private).toBeUndefined();
    });

    it('says a record it cannot read is unreadable, and writes nothing', async () => {
      await env.handle.pool.query(
        'UPDATE secondary_channels SET access = \'{"hidden":"sideways"}\'::jsonb WHERE channel_id = $1',
        [FRESH],
      );
      expect(await privacy.tryMakePrivateForCreation(GUILD, FRESH, 'dave', 'Dave')).toEqual({
        ok: false,
        reason: 'unreadable',
      });
      expect(actions.actions).toEqual([]);
    });
  });

  // -- a handover ---------------------------------------------------------------------------

  /**
   * The owner LEAVING is the caretaker flow and never changes whose lists apply. A
   * deliberate `/transfer`, or a claim of an ownerless room, does: the repository
   * re-points the record's creator, and the hook applies the new creator's lists.
   */
  describe('a handover', () => {
    const arrange = async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(held('carol')).toBeDefined();
      expect(held('mallory')).toBeDefined();
    };

    it('keeps the creator’s guests and blocks when the owner merely leaves', async () => {
      await arrange();
      await secondaries.setOwner(SEC, 'bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob');

      expect((await access())?.creatorId).toBe('alice');
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('revokes the giver’s entries and applies the recipient’s lists after a /transfer', async () => {
      await arrange();
      await lists.add(GUILD, 'bob', 'dave', 'trusted');
      await lists.add(GUILD, 'bob', 'eve', 'blocked');
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });

      expect((await access())?.creatorId).toBe('bob');
      expect(held('carol')).toBeUndefined();
      expect(held('mallory')).toBeUndefined();
      expect(bits(held('dave'))).toEqual({ allow: C, deny: 0n });
      expect(bits(held('eve'))).toEqual({ allow: 0n, deny: VC });
      expect((await access())?.trusted).toEqual(['dave']);
      expect((await access())?.blocked).toEqual(['eve']);
    });

    it('leaves the room with no saved entries when the recipient has no lists', async () => {
      await arrange();
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });

      expect(held('carol')).toBeUndefined();
      expect(held('mallory')).toBeUndefined();
      expect((await access())?.trusted).toBeUndefined();
      expect((await access())?.blocked).toBeUndefined();
    });

    it('lets the original creator take it back with /reclaim, which restores their lists', async () => {
      await arrange();
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');
      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });
      expect(held('carol')).toBeUndefined();

      await secondaries.setOwnerAndCreator(SEC, 'alice', 'Alice');
      await privacy.handleOwnerChanged(GUILD, SEC, 'alice', 'Alice', { handover: true });

      expect((await access())?.creatorId).toBe('alice');
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('also applies the lists of a public room that has no join channel to re-point', async () => {
      await lists.add(GUILD, 'bob', 'eve', 'blocked');
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });

      expect(bits(held('eve'))).toEqual({ allow: 0n, deny: VC });
    });

    it('moves the new creator’s blocked members out of the room', async () => {
      await arrange();
      voice.put(SEC, member('eve'));
      await lists.add(GUILD, 'bob', 'eve', 'blocked');
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });

      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'eve', channelId: null, onlyFrom: SEC }),
      );
    });
  });

  // -- edges a first pass of mutation testing found uncovered -------------------------------

  describe('edges', () => {
    it('does not say a moderator role sees the room when the bot could not grant it', async () => {
      moderatorRole = MODS;
      voice.setBotRoleAccess({ uneditableRoleIds: [MODS] });

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res.ok).toBe(true);
      expect(held(MODS, OVERWRITE_ROLE)).toBeUndefined();
      expect(res.message).toContain('Everyone else sees it only if you let them in');
      expect(res.message).not.toContain('and so do members with');
      // And it says which role it could not change, and why.
      expect(res.message).toContain('<@&role-mods>');
      expect(res.message).toContain('sits above my role');
    });

    it('applies the creator the record names when the column names somebody else', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await env.handle.pool.query(
        "UPDATE secondary_channels SET original_creator = 'bob' WHERE channel_id = $1",
        [SEC],
      );
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'eve', 'blocked');

      await privacy.applyAccessLists(GUILD, SEC);

      expect(held('mallory')).toBeDefined();
      expect(held('eve')).toBeUndefined();
    });

    it('plans a locked room that has no record, which is not the room it skips for being public', async () => {
      // An older instance's lock: private, `@everyone` Connect denied, nobody granted.
      actions.seedOverwrites(SEC, [roleOw(GUILD, 0n, C)]);
      await secondaries.updateState(SEC, { ...(await row()).state, private: true });

      const res = await privacy.applyAccessLists(GUILD, SEC);

      expect(res.status).toBe('applied');
      expect(bits(held('alice'))).toEqual({ allow: C, deny: 0n });
      expect(bits(held(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
    });

    it('counts the roster, which the voice cache lags, as who is in the room', async () => {
      await secondaries.updateState(SEC, { ...(await row()).state, roster: ['alice', 'bob'] });
      expect(voice.membersInChannel(SEC).map((m) => m.id)).toEqual(['alice']);

      await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(bits(held('bob'))).toEqual({ allow: C, deny: 0n });
    });

    it('keeps the way back for a recorded member who has left the server, so nothing is left unrevocable', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });

      // The hide would add View for her, and Discord has no such member any more.
      actions.unknownMemberIds.add('carol');
      await privacy.hide(GUILD, SEC, 'alice');

      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
      expect((await access())?.trusted).toEqual(['carol']);
    });

    it('does not move the owner or an Administrator a vote removed: that is for the vote to do', async () => {
      voice.put(SEC, member('admin'));
      voice.setMemberFacts('admin', { administrator: true });

      expect(await privacy.denyKicked(GUILD, SEC, 'admin')).toBe(true);
      expect(await privacy.denyKicked(GUILD, SEC, 'alice')).toBe(true);

      expect(actions.ofType('move')).toEqual([]);
      // Whatever a vote says, the owner is never locked out of their own room.
      expect(held('alice')?.deny ?? 0n).toBe(0n);
    });

    it('returns a failure and does not throw when something unexpected breaks under a command', async () => {
      const broken = build({
        secondaries: {
          get: () => Promise.reject(new Error('db down')),
        } as unknown as SecondaryChannelRepository,
      });
      for (const call of [
        () => broken.makePrivate(GUILD, SEC, 'alice'),
        () => broken.makePublic(GUILD, SEC, 'alice'),
        () => broken.hide(GUILD, SEC, 'alice'),
        () => broken.unhide(GUILD, SEC, 'alice'),
        () => broken.admit(GUILD, SEC, 'alice', 'bob'),
      ]) {
        const res = await call();
        expect(res.ok).toBe(false);
        expect(res.message).toContain('db down');
      }
    });

    it('turns a blocked knock away on the creator’s list even when a caretaker owns the room', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const joinId = actions.ofType('joinChannel')[0]!.channelId;
      await secondaries.setOwner(SEC, 'bob');
      await joinChannels.setCreatorBySecondary(SEC, 'bob');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');

      expect(
        await privacy.refuseBlockedKnock((await privacy.getJoinContext(joinId))!, 'mallory'),
      ).toBe(true);
    });

    it('does not apply any lists when the owner merely leaves, however they have changed', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      await lists.remove(GUILD, 'alice', 'carol');
      await secondaries.setOwner(SEC, 'bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob');

      // Nothing has been applied, so her overwrite is still there for the next apply to take back.
      expect(held('carol')).toBeDefined();
    });

    it('applies the new creator’s lists after a handover even when the join channel cannot be renamed', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await privacy.applyAccessLists(GUILD, SEC);
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');
      actions.renameChannel = () => Promise.reject(apiError(50013));

      await expect(
        privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true }),
      ).rejects.toBeDefined();

      expect(held('carol')).toBeUndefined();
      expect((await access())?.creatorId).toBe('bob');
    });
  });

  // -- the room_access.disabled lever ----------------------------------------------------------

  /**
   * The lever stops the ENTRY directions and never an undo, and says which. Each test
   * builds its own service so the flag is whatever the test says it is.
   */
  describe('room_access.disabled', () => {
    let off: boolean | 'throws';
    beforeEach(() => {
      off = true;
      privacy = build({
        roomAccessDisabled: () =>
          off === 'throws' ? Promise.reject(new Error('db down')) : Promise.resolve(off),
      });
    });
    /** Runs `body` with the lever off, for the setup a test needs before it throws it. */
    const withLeverOff = async (body: () => Promise<unknown>): Promise<void> => {
      const was = off;
      off = false;
      await body();
      off = was;
    };

    it('refuses /hide with nothing read, written or recorded', async () => {
      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.paused });
      expect(actions.actions).toEqual([]);
      expect(await access()).toBeNull();
      expect((await row()).state.private).toBeUndefined();
    });

    it('refuses admit, for the same reason', async () => {
      await withLeverOff(() => privacy.makePrivate(GUILD, SEC, 'alice'));
      const before = actions.actions.length;

      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');

      expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.paused });
      expect(actions.actions).toHaveLength(before);
      expect((await access())?.admitted).toBeUndefined();
    });

    it('refuses Always allow, admits nobody and saves nobody, and says to use Approve', async () => {
      await withLeverOff(() => privacy.makePrivate(GUILD, SEC, 'alice'));
      const joinId = actions.ofType('joinChannel')[0]!.channelId;
      const before = actions.actions.length;

      const res = await privacy.approveJoin(joinId, 'bob', true);

      // `keepCard` is what tells the router nothing was decided: the reply sends the owner
      // to Approve, so the card has to still have it.
      expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.alwaysPaused, keepCard: true });
      expect(res.message).toContain('Approve');
      expect(actions.actions).toHaveLength(before);
      expect((await lists.get(GUILD, 'alice')).trusted).toEqual([]);
    });

    it('leaves a plain Approve alone: one person, this room, and it dies with the room', async () => {
      await withLeverOff(() => privacy.makePrivate(GUILD, SEC, 'alice'));
      const joinId = actions.ofType('joinChannel')[0]!.channelId;

      const res = await privacy.approveJoin(joinId, 'bob');

      expect(res).toEqual({ ok: true, message: 'Admitted <@bob>.' });
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ channelId: SEC, memberId: 'bob', allow: true }),
      );
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'bob', channelId: SEC }),
      );
    });

    it('still turns a blocked requester away, and says it saved nothing', async () => {
      await withLeverOff(() => privacy.makePrivate(GUILD, SEC, 'alice'));
      const joinId = actions.ofType('joinChannel')[0]!.channelId;

      const res = await privacy.denyJoin(joinId, 'carol', true);

      expect(res).toEqual({ ok: true, message: `Blocked <@carol>.${BLOCK_NOT_SAVED_PAUSED}` });
      expect(await lists.get(GUILD, 'alice')).toEqual({ trusted: [], blocked: [] });
      // What a block did before saved lists existed: the join channel deny and the move.
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
      );
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'carol', channelId: null, onlyFrom: joinId }),
      );
      expect(held('carol')).toBeUndefined();
    });

    it('applies no saved list to a room, whoever asks', async () => {
      await withLeverOff(() => privacy.makePrivate(GUILD, SEC, 'alice'));
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      const before = actions.actions.length;

      const res = await privacy.applyAccessLists(GUILD, SEC);

      expect(res).toEqual({
        status: 'skipped',
        reason: 'disabled',
        movedOut: [],
        skippedRoleIds: [],
      });
      expect(actions.actions).toHaveLength(before);
      expect(held('mallory')).toBeUndefined();
    });

    /**
     * A handover is both directions at once: the recipient's lists go on, and the giver's
     * entries come off. The lever holds back the first and never the second, or the
     * giver's guests keep a room the giver gave away until somebody next edits a list.
     */
    it('takes the giver’s entries off on a handover, and applies none of the recipient’s', async () => {
      await withLeverOff(async () => {
        await privacy.makePrivate(GUILD, SEC, 'alice');
        await lists.add(GUILD, 'alice', 'carol', 'trusted');
        await lists.add(GUILD, 'alice', 'mallory', 'blocked');
        await privacy.applyAccessLists(GUILD, SEC);
      });
      expect(held('carol')).toBeDefined();
      expect(held('mallory')).toBeDefined();
      await lists.add(GUILD, 'bob', 'dave', 'trusted');
      await lists.add(GUILD, 'bob', 'erin', 'blocked');
      await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');

      await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });

      expect(held('carol')).toBeUndefined();
      expect(held('mallory')).toBeUndefined();
      // The recipient's lists wait for the lever to be lifted.
      expect(held('dave')).toBeUndefined();
      expect(held('erin')).toBeUndefined();
      expect((await access())?.trusted).toBeUndefined();
      expect((await access())?.blocked).toBeUndefined();
    });

    it('applies the recipient’s lists on a handover once the lever is lifted', async () => {
      await withLeverOff(async () => {
        await privacy.makePrivate(GUILD, SEC, 'alice');
        await lists.add(GUILD, 'alice', 'carol', 'trusted');
        await privacy.applyAccessLists(GUILD, SEC);
        await lists.add(GUILD, 'bob', 'dave', 'trusted');
        await secondaries.setOwnerAndCreator(SEC, 'bob', 'Bob');
        await privacy.handleOwnerChanged(GUILD, SEC, 'bob', 'Bob', { handover: true });
      });

      expect(held('carol')).toBeUndefined();
      expect(bits(held('dave'))).toEqual({ allow: C, deny: 0n });
    });

    describe('never stands between a member and an undo', () => {
      it('/unhide still works', async () => {
        await withLeverOff(() => privacy.hide(GUILD, SEC, 'alice'));

        const res = await privacy.unhide(GUILD, SEC, 'alice');

        expect(res.ok).toBe(true);
        expect((await access())?.hidden).toBeUndefined();
        expect(await joinRow()).toBeDefined();
      });

      it('/public still works, from a hidden room and from a locked one', async () => {
        await withLeverOff(() => privacy.hide(GUILD, SEC, 'alice'));
        expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
        await withLeverOff(() => privacy.makePrivate(GUILD, SEC, 'alice'));
        expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
        expect((await row()).state.private).toBeUndefined();
      });

      /**
       * Taking an entry back off a live room is `revokeOnly`: it is never skipped, and
       * it adds nothing, so the lever never makes an undo apply a list.
       */
      it('takes an entry back off a live room, and adds none that the room does not hold', async () => {
        await withLeverOff(async () => {
          await privacy.makePrivate(GUILD, SEC, 'alice');
          await lists.add(GUILD, 'alice', 'carol', 'trusted');
          await lists.add(GUILD, 'alice', 'mallory', 'blocked');
          await privacy.applyAccessLists(GUILD, SEC);
        });
        await lists.add(GUILD, 'alice', 'dave', 'trusted');
        await lists.remove(GUILD, 'alice', 'carol');

        const res = await privacy.applyAccessLists(GUILD, SEC, { revokeOnly: true });

        expect(res.status).toBe('applied');
        expect(held('carol')).toBeUndefined();
        // Still listed and still recorded: kept, not revoked.
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
        // Listed but never applied: the lever keeps it that way.
        expect(held('dave')).toBeUndefined();
        expect((await access())?.trusted).toBeUndefined();
        expect((await access())?.blocked).toEqual(['mallory']);
      });

      it('takes a block back off a live room', async () => {
        await withLeverOff(async () => {
          await lists.add(GUILD, 'alice', 'mallory', 'blocked');
          await privacy.applyAccessLists(GUILD, SEC);
        });
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
        await lists.remove(GUILD, 'alice', 'mallory');

        await privacy.applyAccessLists(GUILD, SEC, { revokeOnly: true });

        expect(held('mallory')).toBeUndefined();
      });

      it('costs a public room with no record and nothing recorded no call to Discord', async () => {
        const res = await privacy.applyAccessLists(GUILD, SEC, { revokeOnly: true });
        expect(res.status).toBe('unchanged');
        expect(actions.actions).toEqual([]);
      });
    });

    /**
     * Existing features that now run through the planner. The lever cannot route them
     * around it, and the doc says the rollback for them is a deploy.
     */
    describe('does not stop /private, /public, votekick or a creation', () => {
      it('still locks a room, and still opens it', async () => {
        expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(bits(everyone())).toEqual({ allow: 0n, deny: C });
        expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
      });

      it('still records a vote’s kick', async () => {
        expect(await privacy.denyKicked(GUILD, SEC, 'mallory')).toBe(true);
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      });

      it('still makes a room private as it is created, hidden or locked', async () => {
        const result = await privacy.tryMakePrivateForCreation(GUILD, SEC, 'alice', 'Alice');
        expect(result).toEqual({ ok: true, applied: true });
      });
    });

    it('treats a failed flag read as not disabled', async () => {
      off = 'throws';
      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
    });

    it('is not asked at all by the commands it does not stop', async () => {
      const asked = vi.fn().mockResolvedValue(true);
      const watched = build({ roomAccessDisabled: asked });
      await watched.makePrivate(GUILD, SEC, 'alice');
      await watched.makePublic(GUILD, SEC, 'alice');
      await watched.unhide(GUILD, SEC, 'alice');
      await watched.denyKicked(GUILD, SEC, 'mallory');
      expect(asked).not.toHaveBeenCalled();
    });
  });

  // -- a creator who is denied saved lists ---------------------------------------------------------

  /**
   * A restricted feature is inert for a denied member, saved data included, and the one
   * rule is asked wherever a list is applied. The rows stay (the rule can be lifted), and
   * a member the cache cannot show is not restricted: a saved block protects the people it
   * names, so the unknown direction keeps it.
   */
  describe('a creator who is denied Saved lists', () => {
    const DENIED = { access: { deny: { users: ['alice'], roles: [] } } };
    let rules: CommandAccess;

    beforeEach(async () => {
      rules = DENIED;
      privacy = build({ commandAccess: () => Promise.resolve(rules) });
      voice.setOwnerAccess('alice', { roleIds: [] });
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
    });

    it('locks a room without their trusted or blocked entries, and keeps the rows', async () => {
      expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);

      expect(held('carol')).toBeUndefined();
      expect(held('mallory')).toBeUndefined();
      expect(bits(everyone())).toEqual({ allow: 0n, deny: C });
      expect(await lists.get(GUILD, 'alice')).toEqual({ trusted: ['carol'], blocked: ['mallory'] });
    });

    it('hides a room the same way, and the entries return once the rule is lifted', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      expect(held('carol')).toBeUndefined();

      rules = {};
      await privacy.applyAccessLists(GUILD, SEC);

      expect(bits(held('carol'))).toEqual({ allow: VC, deny: 0n });
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
    });

    it('takes back what an earlier plan wrote for them, when the rule arrives', async () => {
      rules = {};
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(held('carol')).toBeDefined();
      expect(held('mallory')).toBeDefined();

      rules = DENIED;
      const applied = await privacy.applyAccessLists(GUILD, SEC);

      expect(applied.status).toBe('applied');
      expect(held('carol')).toBeUndefined();
      expect(held('mallory')).toBeUndefined();
    });

    it('turns nobody away at the door: their blocked list bars no knocker', async () => {
      rules = {};
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const ctx = (await privacy.getJoinContext(actions.ofType('joinChannel')[0]!.channelId))!;
      expect(await privacy.refuseBlockedKnock(ctx, 'mallory')).toBe(true);

      rules = DENIED;

      expect(await privacy.refuseBlockedKnock(ctx, 'mallory')).toBe(false);
      // A vote's removal is the room's, and no rule about a member's lists reaches it.
      await privacy.denyKicked(GUILD, SEC, 'eve');
      expect(await privacy.refuseBlockedKnock(ctx, 'eve')).toBe(true);
    });

    it('saves nothing from the card’s Block, which still turns the requester away', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const joinId = actions.ofType('joinChannel')[0]!.channelId;

      const res = await privacy.denyJoin(joinId, 'dave', true);

      expect(res).toEqual({ ok: true, message: 'Blocked <@dave>.' });
      expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['mallory']);
      expect(actions.ofType('connect')).toContainEqual(
        expect.objectContaining({ channelId: joinId, memberId: 'dave', allow: false }),
      );
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'dave', channelId: null, onlyFrom: joinId }),
      );
    });

    it('is not restricted when the cache cannot say who they are, or when they can manage channels', async () => {
      voice.clearOwnerAccess('alice');
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(held('carol')).toBeDefined();

      await privacy.makePublic(GUILD, SEC, 'alice');
      voice.setOwnerAccess('alice', { roleIds: [], canManage: true });
      await privacy.makePrivate(GUILD, SEC, 'alice');
      expect(held('mallory')).toBeDefined();
    });

    it('is not restricted for anybody the rule does not name', async () => {
      rules = { access: { deny: { users: ['bob'], roles: [] } } };

      await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });

    it('fails open when the rules cannot be read', async () => {
      privacy = build({ commandAccess: () => Promise.reject(new Error('settings down')) });

      await privacy.makePrivate(GUILD, SEC, 'alice');

      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });
  });

  // -- the Manage Roles preflight --------------------------------------------------------------

  /**
   * A hide from a locked room deletes the Join channel before its write, and a write the
   * bot cannot make would put it back under a new id, which expires every open knock
   * card. A cache check up front refuses before any of that, and it is a preflight and
   * not the authority: "cannot say" goes ahead.
   */
  describe('the Manage Roles preflight', () => {
    const noManageRoles = () => voice.setBotPermissions(SEC, { manageRoles: false });

    it('refuses a hide from a locked room with the Join channel and everything else untouched', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      const joinBefore = await joinRow();
      const before = actions.actions.length;
      noManageRoles();

      const res = await privacy.hide(GUILD, SEC, 'alice');

      expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.needsManageRoles });
      expect(res.message).toContain('**Manage Roles**');
      expect(actions.actions).toHaveLength(before);
      expect(await joinRow()).toEqual(joinBefore);
      expect((await access())?.hidden).toBeUndefined();
    });

    it('still tells the admin, as the write that was bound to fail would have', async () => {
      noManageRoles();
      await privacy.hide(GUILD, SEC, 'alice');
      expect(problems.recent(GUILD)).toEqual([
        expect.objectContaining({ channelId: SEC, operation: 'access' }),
      ]);
      expect(serverLogs).toHaveLength(1);
    });

    it('tells the guild once for a room, however often its owner presses the button', async () => {
      noManageRoles();
      for (let press = 0; press < 5; press += 1) {
        const res = await privacy.hide(GUILD, SEC, 'alice');
        expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.needsManageRoles });
      }
      await privacy.admit(GUILD, SEC, 'alice', 'carol');
      expect(problems.recent(GUILD)).toHaveLength(1);
      expect(serverLogs).toHaveLength(1);
    });

    it('refuses an admit too, since it writes the same overwrites', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      noManageRoles();
      const res = await privacy.admit(GUILD, SEC, 'alice', 'carol');
      expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.needsManageRoles });
      expect((await access())?.admitted).toBeUndefined();
    });

    it('goes ahead when the cache cannot say, or says the bot can', async () => {
      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
      await privacy.unhide(GUILD, SEC, 'alice');
      await privacy.makePublic(GUILD, SEC, 'alice');
      voice.setBotPermissions(SEC, { manageRoles: true });
      expect((await privacy.hide(GUILD, SEC, 'alice')).ok).toBe(true);
    });

    it('is never asked before an undo, so a stale cache cannot keep somebody’s room hidden', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      noManageRoles();
      expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(true);
      expect((await privacy.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
    });

    it('never gets in the way of a room that is already as asked', async () => {
      await privacy.hide(GUILD, SEC, 'alice');
      noManageRoles();
      expect(await privacy.hide(GUILD, SEC, 'alice')).toEqual({
        ok: false,
        message: ROOM_ACCESS_REPLIES.alreadyHidden,
      });
    });
  });

  // -- remembered settings ---------------------------------------------------------------------

  /**
   * What an owner's `/private`, `/hide`, `/unhide` and `/public` leave behind for their next
   * room from this creator channel. Saved only once the change has taken effect, for the owner
   * by equality, stopped by `member_prefs.disabled` for a value and never for a clear, and never
   * able to fail the command it follows.
   */
  describe('remembering what the owner chose', () => {
    const PRIMARY = 'p';
    let prefs: MemberRoomPrefsRepository;
    let autoChannels: AutoChannelRepository;
    let paused: boolean;
    let remembering: PrivacyService;

    const saved = () => prefs.get(PRIMARY, 'alice');

    beforeAll(async () => {
      autoChannels = new AutoChannelRepository(env.handle.db);
      prefs = new MemberRoomPrefsRepository(env.handle.db);
      await new GuildRepository(env.handle.db).ensure(GUILD);
    });

    beforeEach(async () => {
      await env.handle.db.delete(db.schema.memberRoomPrefs);
      await env.handle.db.delete(db.schema.autoChannels);
      paused = false;
      await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
      await autoChannels.setRememberPrefs(GUILD, PRIMARY, true);
      remembering = build({
        memberPrefs: prefs,
        memberPrefsDisabled: () => Promise.resolve(paused),
      });
    });

    describe('what each change remembers', () => {
      it('saves private for /private', async () => {
        expect((await remembering.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(await saved()).toEqual({
          name: null,
          limit: null,
          privacy: 'private',
          status: null,
        });
      });

      it('saves hidden for /hide', async () => {
        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(await saved()).toEqual({ name: null, limit: null, privacy: 'hidden', status: null });
      });

      /** A room shown again is still locked, so a hide then a show must not leave a hidden room behind. */
      it('saves private for /unhide, which replaces a remembered hidden', async () => {
        await remembering.hide(GUILD, SEC, 'alice');
        expect((await saved())!.privacy).toBe('hidden');

        expect((await remembering.unhide(GUILD, SEC, 'alice')).ok).toBe(true);

        expect((await saved())!.privacy).toBe('private');
      });

      /**
       * For a member denied Private the router asks for `open`: a hidden room is a locked one, so
       * showing it must not leave a locked room with a Join channel. It is an undo that only
       * removes, so what they remember goes the way `/public` takes it, and is never set to private.
       */
      it('opens a hidden room to everyone for /unhide with open, and remembers nothing for it', async () => {
        await remembering.hide(GUILD, SEC, 'alice');
        expect((await saved())!.privacy).toBe('hidden');

        const res = await remembering.unhide(GUILD, SEC, 'alice', { open: true });

        expect(res.ok).toBe(true);
        expect(res.message).toBe('🔓 Your channel is now public.');
        expect((await row()).state.private).toBeUndefined();
        expect((await access())?.hidden).toBeUndefined();
        expect(await joinRow()).toBeUndefined();
        expect(liveJoinChannels()).toHaveLength(0);
        expect(everyone()).toBeUndefined();
        expect(await saved()).toBeUndefined();
      });

      it('still refuses /unhide with open on a room that is not hidden', async () => {
        await remembering.makePrivate(GUILD, SEC, 'alice');
        const res = await remembering.unhide(GUILD, SEC, 'alice', { open: true });
        expect(res).toEqual({ ok: false, message: "This room isn't hidden." });
        expect((await row()).state.private).toBe(true);
      });

      it('takes the privacy back out for /public, from a locked room and from a hidden one', async () => {
        await remembering.makePrivate(GUILD, SEC, 'alice');
        expect((await remembering.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(await saved()).toBeUndefined();

        await remembering.hide(GUILD, SEC, 'alice');
        expect((await remembering.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(await saved()).toBeUndefined();
      });

      it('leaves a remembered name and size alone when it takes the privacy out', async () => {
        await prefs.saveName(GUILD, PRIMARY, 'alice', 'Den');
        await prefs.saveLimit(GUILD, PRIMARY, 'alice', 4);
        await remembering.makePrivate(GUILD, SEC, 'alice');
        await remembering.makePublic(GUILD, SEC, 'alice');
        expect(await saved()).toEqual({ name: 'Den', limit: 4, privacy: null, status: null });
      });

      /**
       * The lock is what the member chose, and only the way for others to knock is missing,
       * which the sweep makes. The command tells them it could not, and the room is still locked.
       */
      it('saves private for a lock whose Join channel could not be made, which still locked the room', async () => {
        actions.createJoinChannel = () => Promise.reject(apiError(50013));

        const res = await remembering.makePrivate(GUILD, SEC, 'alice');

        expect(res.ok).toBe(false);
        expect(res.message).toContain("I couldn't create its **⇩ Join** channel");
        expect((await row()).state.private).toBe(true);
        expect(await saved()).toEqual({
          name: null,
          limit: null,
          privacy: 'private',
          status: null,
        });
      });

      it('saves private for a /unhide whose Join channel could not be made, the same way', async () => {
        await remembering.hide(GUILD, SEC, 'alice');
        actions.createJoinChannel = () => Promise.reject(apiError(50013));

        const res = await remembering.unhide(GUILD, SEC, 'alice');

        expect(res.ok).toBe(false);
        expect(res.message).toContain("I couldn't create its **⇩ Join** channel");
        expect((await saved())!.privacy).toBe('private');
      });

      it('is for the creator channel the room came from, and for no other', async () => {
        await autoChannels.upsert(GUILD, 'another-primary', { name: 'x' });
        await autoChannels.setRememberPrefs(GUILD, 'another-primary', true);

        await remembering.makePrivate(GUILD, SEC, 'alice');

        expect(await prefs.get('another-primary', 'alice')).toBeUndefined();
        expect((await saved())!.privacy).toBe('private');
      });
    });

    /** Anything that left the room as it was, or only queued the change, is not a choice that took effect. */
    describe('what it does not remember', () => {
      it('saves nothing when somebody else asks, or the room has no owner', async () => {
        expect((await remembering.makePrivate(GUILD, SEC, 'bob')).ok).toBe(false);
        expect((await remembering.hide(GUILD, SEC, 'bob')).ok).toBe(false);
        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);

        await env.handle.pool.query(
          'UPDATE secondary_channels SET owner_id = NULL WHERE channel_id = $1',
          [SEC],
        );
        expect((await remembering.makePrivate(GUILD, SEC, 'bob')).ok).toBe(false);
        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(false);
        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
      });

      it('saves nothing when the room was already as asked, or the change is the wrong way round', async () => {
        await remembering.hide(GUILD, SEC, 'alice');
        // Already hidden, and /private on a hidden room is refused: neither is a new choice.
        expect((await remembering.makePrivate(GUILD, SEC, 'alice')).ok).toBe(false);
        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(false);
        expect((await saved())!.privacy).toBe('hidden');
      });

      it('saves nothing when a role the bot cannot edit defeats the hide', async () => {
        actions.seedOverwrites(SEC, [roleOw(GATE, V)]);
        voice.setBotRoleAccess({ uneditableRoleIds: [GATE] });

        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(false);

        expect(await saved()).toBeUndefined();
      });

      it('saves nothing when the write failed', async () => {
        actions.failOverwrites = true;

        expect((await remembering.makePrivate(GUILD, SEC, 'alice')).ok).toBe(false);
        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(false);

        expect(await saved()).toBeUndefined();
      });

      it('saves nothing when Discord only queued the change behind its rate limit', async () => {
        actions.simulateOverwriteRateLimit = true;

        expect((await remembering.makePrivate(GUILD, SEC, 'alice')).ok).toBe(false);
        expect(await saved()).toBeUndefined();
        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(false);
        expect(await saved()).toBeUndefined();
      });

      it('does not replace a remembered hidden for an /unhide that was only queued', async () => {
        await remembering.hide(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = true;

        expect((await remembering.unhide(GUILD, SEC, 'alice')).ok).toBe(false);

        expect((await saved())!.privacy).toBe('hidden');
      });

      it('does not clear a remembered privacy for a /public that was only queued', async () => {
        await remembering.makePrivate(GUILD, SEC, 'alice');
        actions.simulateOverwriteRateLimit = true;

        expect((await remembering.makePublic(GUILD, SEC, 'alice')).ok).toBe(false);

        expect((await saved())!.privacy).toBe('private');
      });

      it('stores nothing for a creator channel that does not remember', async () => {
        await autoChannels.setRememberPrefs(GUILD, PRIMARY, false);

        expect((await remembering.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
        expect((await remembering.hide(GUILD, SEC, 'alice')).ok).toBe(true);

        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
      });
    });

    describe('when saving goes wrong', () => {
      it('never fails the command: the room is changed and the reply is the usual one', async () => {
        const failing = build({
          memberPrefs: { savePrivacy: () => Promise.reject(new Error('db down')) },
        });

        const locked = await failing.makePrivate(GUILD, SEC, 'alice');
        expect(locked.ok).toBe(true);
        expect(locked.message).toBe(ROOM_ACCESS_REPLIES.locked);
        expect((await row()).state.private).toBe(true);

        const hidden = await failing.hide(GUILD, SEC, 'alice');
        expect(hidden.ok).toBe(true);
        expect((await access())?.hidden).toBe(true);
        expect((await failing.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);
        expect((await row()).state.private).toBeUndefined();
      });

      it('logs ids and what failed, and never the owner’s name', async () => {
        const warn = vi.fn();
        const failing = build({
          memberPrefs: { savePrivacy: () => Promise.reject(new Error('db down')) },
          logger: { ...fakeLogger(), warn } as never,
        });
        nicks.set('alice', 'Alice the Secret');

        await failing.makePrivate(GUILD, SEC, 'alice');

        const saveFailures = warn.mock.calls.filter(
          ([, message]) => message === 'could not remember a room setting',
        );
        expect(saveFailures).toHaveLength(1);
        expect(saveFailures[0]![0]).toMatchObject({
          guildId: GUILD,
          channelId: SEC,
          userId: 'alice',
          field: 'privacy',
        });
        expect(JSON.stringify(saveFailures)).not.toContain('Secret');
      });

      it('does not need a repository at all, and a construction without one is unchanged', async () => {
        expect((await privacy.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
        expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
      });
    });

    /** The lever stops a privacy being stored, and never one being taken back out. */
    describe('while member_prefs.disabled is on', () => {
      it('stores nothing for a lock, a hide or a show', async () => {
        paused = true;

        await remembering.makePrivate(GUILD, SEC, 'alice');
        await remembering.hide(GUILD, SEC, 'alice');
        await remembering.unhide(GUILD, SEC, 'alice');

        expect(await saved()).toBeUndefined();
      });

      it('still takes a remembered privacy out for /public', async () => {
        await remembering.makePrivate(GUILD, SEC, 'alice');
        paused = true;

        expect((await remembering.makePublic(GUILD, SEC, 'alice')).ok).toBe(true);

        expect(await saved()).toBeUndefined();
      });

      it('saves again once it is lifted', async () => {
        paused = true;
        await remembering.makePrivate(GUILD, SEC, 'alice');
        paused = false;
        await remembering.makePublic(GUILD, SEC, 'alice');
        await remembering.hide(GUILD, SEC, 'alice');
        expect((await saved())!.privacy).toBe('hidden');
      });

      it('does not get in the way of a lock, which it never stopped', async () => {
        paused = true;
        expect((await remembering.makePrivate(GUILD, SEC, 'alice')).ok).toBe(true);
        expect((await row()).state.private).toBe(true);
      });
    });
  });

  // -- copy rules -----------------------------------------------------------------------------

  /**
   * AGENTS.md's copy rules over every reply this file made a command give, rendered,
   * because a source scan only catches a curly quote. Last, so it sees them all.
   */
  describe('copy rules', () => {
    /**
     * The rules below read what earlier tests collected, so a run of this block alone
     * would check nothing. It makes its own: one pass through every command a member
     * can give, refusals included.
     */
    it('has replies to check', async () => {
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await privacy.makePrivate(GUILD, SEC, 'alice');
      await privacy.makePrivate(GUILD, SEC, 'bob');
      await privacy.admit(GUILD, SEC, 'alice', 'carol');
      await privacy.hide(GUILD, SEC, 'alice');
      await privacy.hide(GUILD, SEC, 'alice');
      await privacy.unhide(GUILD, SEC, 'alice');
      await privacy.unhide(GUILD, SEC, 'alice');
      await privacy.makePublic(GUILD, SEC, 'alice');
      await privacy.makePublic(GUILD, SEC, 'alice');
      await privacy.admit(GUILD, SEC, 'alice', 'carol');
      expect(replies.length).toBeGreaterThan(10);
    });

    it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
      const text = replies.join('\n');
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/[‘’“”]/);
      expect(text).not.toMatch(/;/);
    });

    it('never says primary or secondary to a member', () => {
      const text = replies.join('\n').toLowerCase();
      expect(text).not.toContain('primary');
      expect(text).not.toContain('secondary');
    });

    it('says nothing about what a profile or an activity feed shows', () => {
      const text = replies.join('\n').toLowerCase();
      expect(text).not.toContain('profile');
      expect(text).not.toContain('activity');
    });

    it('makes no claim of generative AI', () => {
      expect(replies.join('\n').toLowerCase()).not.toMatch(/\b(ai|generated|llm)\b/);
    });
  });
});
