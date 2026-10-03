import {
  JoinChannelRepository,
  MemberAccessListRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { DiscordAPIError } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { PermissionProblemTracker } from './permissionProblems.js';
import { PrivacyService, type PrivacyServiceDeps } from './privacy.js';
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
        'This room has no owner right now. Use `/claim` to take it, then try again.',
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
            "I can't read this room's access settings, so I have left the room exactly as it is. A newer version of AVC probably wrote them. Try again in a few minutes.",
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
      expect((await privacy.unhide(GUILD, SEC, 'alice')).ok).toBe(false);
      // Not finalised: still recorded as hidden, because the queued write has not been seen to land.
      expect((await access())?.hidden).toBe(true);
      // The lock gets its Join channel all the same.
      expect(await joinRow()).toBeDefined();

      actions.simulateOverwriteRateLimit = false;
      const again = await privacy.unhide(GUILD, SEC, 'alice');

      expect(again.ok).toBe(true);
      expect((await access())?.hidden).toBeUndefined();
      // And the repeat does not make a second one.
      expect(liveJoinChannels()).toHaveLength(1);
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
      expect(res.message).toContain('nobody else sees it unless you let them in');
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

      await privacy.unhide(GUILD, SEC, 'alice').catch(() => undefined);
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

        expect(res).toEqual({ ok: true, message: 'Blocked <@carol>.' });
        expect((await lists.get(GUILD, 'alice')).blocked).toEqual(['carol']);
        expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });
        expect(actions.ofType('connect')).toContainEqual(
          expect.objectContaining({ channelId: joinId, memberId: 'carol', allow: false }),
        );
        expect(actions.ofType('move')).toContainEqual(
          expect.objectContaining({ memberId: 'carol', channelId: null, onlyFrom: joinId }),
        );
      });

      it('persists before it touches Discord, and moves them out last', async () => {
        const joinId = await lock();
        await privacy.denyJoin(joinId, 'carol', true);
        const log = actions.actions.slice(
          actions.actions.findIndex((a) => a.type === 'joinChannel') + 1,
        );
        const types = log.map((a) => a.type);
        expect(types.at(-1)).toBe('move');
        expect(types.indexOf('overwrites')).toBeLessThan(types.indexOf('move'));
      });

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

        expect(res).toEqual({ ok: true, message: 'Admitted <@bob>.' });
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

    describe('a blocked requester', () => {
      const ctxOf = async (joinId: string) => (await privacy.getJoinContext(joinId))!;

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

  // -- copy rules -----------------------------------------------------------------------------

  /**
   * AGENTS.md's copy rules over every reply this file made a command give, rendered,
   * because a source scan only catches a curly quote. Last, so it sees them all.
   */
  describe('copy rules', () => {
    it('has replies to check', () => {
      expect(replies.length).toBeGreaterThan(40);
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
