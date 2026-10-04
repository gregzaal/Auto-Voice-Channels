import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  MemberRoomPrefsRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { DiscordAPIError } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  BOT_ACCESS,
  CONNECT,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  type ResolvedOverwrite,
} from './accessPlan.js';
import { RecordingVoiceActions } from './actions.js';
import { VoiceCommands } from './commands.js';
import { VoiceFeature, type CreationGate, type VoiceFeatureDeps } from './handler.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { PrivacyService } from './privacy.js';
import type { VoiceMember } from './types.js';
import { FakeVoiceView, fakeMember } from './voiceTestUtils.js';

const GUILD = 'guild-remembered';
const PRIMARY = 'primary-1';
const BOT = 'bot-1';
/** Snowflakes, because a `/restrict` rule only stores ids that look like one. */
const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const ABOVE = '555555555555555555';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;

/** A member as the gateway snapshots them: named, with the roles they hold. */
const member = (id: string, over: Partial<VoiceMember> = {}): VoiceMember => ({
  ...fakeMember(id),
  displayName: id === ALICE ? 'Alice' : id === BOB ? 'Bob' : id,
  roleIds: [GUILD],
  canManage: false,
  ...over,
});
const alice = (over: Partial<VoiceMember> = {}) => member(ALICE, over);

const bits = (o: ResolvedOverwrite | undefined) =>
  o ? { allow: o.allow, deny: o.deny } : undefined;

const apiError = (code: number, status = 403) =>
  new DiscordAPIError(
    { code, message: `code ${code}` } as never,
    code,
    status,
    'PUT',
    'https://discord.test',
    {} as never,
  );

/** How a creator channel starts its rooms, as the template stores it. */
const STARTS = {
  public: {},
  locked: { defaultPrivate: true },
  hidden: { defaultPrivate: true, defaultHidden: true },
} as const;

/**
 * A member's remembered room settings coming back, end to end: a member joins a creator channel
 * that remembers, the room is made with what they saved, and the member is moved in. Real
 * repositories, the real privacy service and the real commands, over the recording Discord seam.
 *
 * What is asserted of a restore is asserted of the create call and the first panel and never of
 * an edit after them, because a remembered name that arrived as a follow-up rename would spend
 * one of the two renames a room gets per ten minutes.
 */
describe('remembered room settings (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let joinChannels: JoinChannelRepository;
  let prefs: MemberRoomPrefsRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let problems: PermissionProblemTracker;
  let privacy: PrivacyService;
  let feature: VoiceFeature;
  let commands: VoiceCommands;
  /** `member_prefs.disabled` and `room_access.disabled`, as the gate's snapshot answers them. */
  let prefsPaused: boolean;
  let accessPaused: boolean;
  /** What the first panel of each room was told. */
  let views: { isPrivate: boolean; isHidden: boolean | 'unknown'; userLimit: number }[];
  let warn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
    joinChannels = new JoinChannelRepository(env.handle.db);
    prefs = new MemberRoomPrefsRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  const gateOf = (): CreationGate => ({
    allowCreate: () => Promise.resolve({ allowed: true }),
    memberPrefsDisabled: () => Promise.resolve(prefsPaused),
    roomAccessDisabled: () => Promise.resolve(accessPaused),
  });

  /** The privacy service as `index.ts` wires it, saves and lever included. */
  const buildPrivacy = (): PrivacyService =>
    new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => BOT,
      permissionProblems: problems,
      memberPrefs: prefs,
      memberPrefsDisabled: () => Promise.resolve(prefsPaused),
    });

  /** The feature as `index.ts` wires it, with the pieces a test changes. */
  const buildFeature = (over: Partial<VoiceFeatureDeps> = {}, answeringHook = true): VoiceFeature =>
    new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: { ...fakeLogger(), warn } as never,
      permissionProblems: problems,
      gate: gateOf(),
      memberPrefs: prefs,
      makePrivateOnCreate: (g, c, ownerId, ownerName, mode) =>
        privacy.makePrivateForCreation(g, c, ownerId, ownerName, mode),
      ...(answeringHook
        ? {
            tryMakePrivateOnCreate: (
              g: string,
              c: string,
              ownerId: string,
              ownerName: string,
              mode: 'locked' | 'hidden',
              opts?: { quiet?: boolean },
            ) => privacy.tryMakePrivateForCreation(g, c, ownerId, ownerName, mode, opts),
          }
        : {}),
      controlPanel: {
        postForRoom: (_g, _room, _primary, _destination, view) => {
          views.push({
            isPrivate: view.isPrivate,
            isHidden: view.isHidden,
            userLimit: view.userLimit,
          });
          return Promise.resolve();
        },
        refreshForRoom: () => Promise.resolve(),
      },
      ...over,
    });

  /** A new Discord, a new voice cache and new services over the same database. */
  const freshWorld = () => {
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    problems = new PermissionProblemTracker();
    views = [];
    warn = vi.fn();
    privacy = buildPrivacy();
    feature = buildFeature();
    commands = new VoiceCommands({
      secondaries,
      actions,
      voice,
      feature,
      logger: fakeLogger(),
      memberPrefs: prefs,
      memberPrefsDisabled: () => Promise.resolve(prefsPaused),
    });
  };

  /** Forgets every room, as if the creator channel had never been joined. */
  const forgetRooms = async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
  };

  beforeEach(async () => {
    await forgetRooms();
    await env.handle.db.delete(db.schema.memberRoomPrefs);
    await env.handle.db.delete(db.schema.autoChannels);
    prefsPaused = false;
    accessPaused = false;
    freshWorld();
    await guilds.ensure(GUILD);
    await guilds.updateSettings(GUILD, { command_access: {} });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- helpers ----------------------------------------------------------------------

  /** Turns remembering on for the creator channel, as its editor does, over what it starts rooms as. */
  const optIn = async (
    starts: keyof typeof STARTS = 'public',
    extra: { limit?: number; name?: string } = {},
  ) => {
    await autoChannels.upsert(GUILD, PRIMARY, {
      name: extra.name ?? "@@creator@@'s room",
      ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
      ...STARTS[starts],
    });
    await autoChannels.setRememberPrefs(GUILD, PRIMARY, true);
  };

  /** A member joins the creator channel and is moved into the room that was made for them. */
  const join = async (f: VoiceFeature, who: VoiceMember = alice()): Promise<string> => {
    voice.put(PRIMARY, who);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: who, afterChannelId: PRIMARY });
    const room = actions.ofType('create').at(-1)!.channelId;
    voice.drop(PRIMARY, who.id);
    voice.put(room, who);
    return room;
  };

  /**
   * Everything a join to the creator channel did and left behind, less the one thing that is
   * random: for comparing two runs that are meant to be the same room.
   */
  const joinAndSnapshot = async () => {
    const room = await join(feature);
    const row = (await secondaries.get(room))!;
    return {
      actions: structuredClone(actions.actions),
      state: { ...row.state, seed: undefined },
      access: row.access,
      views: structuredClone(views),
    };
  };

  /** A member with no roles in their snapshot, which says nothing about who they are. */
  const unresolved = (): VoiceMember => ({ ...fakeMember(ALICE), displayName: 'Alice' });

  /** How open a room is, from what is stored for it. */
  const modeOf = async (room: string) => {
    const row = (await secondaries.get(room))!;
    return row.access?.hidden === true
      ? 'hidden'
      : row.state.private === true
        ? 'locked'
        : 'public';
  };
  const held = (room: string, id: string) => actions.overwritesOf(room).find((o) => o.id === id);
  const everyone = (room: string) =>
    actions.overwritesOf(room).find((o) => o.id === GUILD && o.type === OVERWRITE_ROLE);
  const createdLimit = () => actions.ofType('create').at(-1)?.userLimit;
  const restrict = (feat: 'rename' | 'limit' | 'privacy' | 'hide', rule: { users?: string[] }) =>
    guilds.updateSettings(GUILD, {
      command_access: { [feat]: { deny: { users: rule.users ?? [], roles: [] } } },
    });

  // -- name ---------------------------------------------------------------------------

  describe('a remembered name', () => {
    it('starts the room with it, in the create and the row, and costs no rename', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, "@@creator@@'s lounge");

      const room = await join(feature);

      expect(actions.ofType('create')[0]!.name).toBe("Alice's lounge");
      const row = (await secondaries.get(room))!;
      expect(row.state.template).toBe("@@creator@@'s lounge");
      expect(row.state.name).toBe("Alice's lounge");
      // The room as it stands with Alice in it, re-rendered the way every sweep does.
      expect(await feature.rerenderSecondary(GUILD, room)).toEqual({});
      expect(actions.ofType('rename')).toEqual([]);
    });

    it('is not what the next member gets, who is made the creator channel’s own room', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, "@@creator@@'s lounge");

      const room = await join(feature, member(BOB));

      expect(actions.ofType('create')[0]!.name).toBe("Bob's room");
      expect((await secondaries.get(room))!.state.template).toBeUndefined();
    });

    it('is remembered for one creator channel and not another', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, "@@creator@@'s lounge");
      await autoChannels.upsert(GUILD, 'primary-2', { name: 'Elsewhere' });

      voice.put('primary-2', alice());
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice(),
        afterChannelId: 'primary-2',
      });

      expect(actions.ofType('create')[0]!.name).toBe('Elsewhere');
    });

    /** The tokens read the room being made, so a name that mentions the limit shows the restored one. */
    it('is rendered against the other settings that were restored with it', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Room of @@limit@@ {{PRIVATE ?? 🔒 // 🔓}}');
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 4);
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');

      const room = await join(feature);

      expect(actions.ofType('create')[0]!.name.replace(/\s+/g, ' ').trim()).toBe('Room of 4 🔒');
      voice.setUserLimit(room, 4);
      expect(await feature.rerenderSecondary(GUILD, room)).toEqual({});
      expect(actions.ofType('rename')).toEqual([]);
    });
  });

  // -- limit --------------------------------------------------------------------------

  describe('a remembered limit', () => {
    it('is the limit the room is created with, and the one its panel starts with', async () => {
      await optIn();
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 4);

      await join(feature);

      expect(createdLimit()).toBe(4);
      expect(views).toEqual([{ isPrivate: false, isHidden: false, userLimit: 4 }]);
    });

    it('wins over the creator channel’s default limit, which is the member’s own earlier choice', async () => {
      await optIn('public', { limit: 6 });
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 3);

      await join(feature);

      expect(createdLimit()).toBe(3);
      expect(views[0]!.userLimit).toBe(3);
    });

    /** 0 is "no limit", a choice like any other, and it overrides a default of 6. */
    it('can be a remembered 0, which overrides the creator channel’s default limit', async () => {
      await optIn('public', { limit: 6 });
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 0);

      await join(feature);

      expect(createdLimit()).toBe(0);
      expect(views[0]!.userLimit).toBe(0);
    });

    it('leaves the creator channel’s default limit alone when nothing is remembered', async () => {
      await optIn('public', { limit: 6 });
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');

      await join(feature);

      expect(createdLimit()).toBe(6);
      expect(views[0]!.userLimit).toBe(6);
    });
  });

  // -- privacy ------------------------------------------------------------------------

  describe('a remembered privacy', () => {
    it('makes a private room locked from the start: a reserved slot, a Join channel, the owner in', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');

      const room = await join(feature);

      expect(actions.ofType('create')[0]!.reserveSlotAbove).toBe(true);
      expect(actions.ofType('joinChannel')).toHaveLength(1);
      expect(bits(held(room, ALICE))).toEqual({ allow: C, deny: 0n });
      expect(bits(everyone(room))).toEqual({ allow: 0n, deny: C });
      expect(await modeOf(room)).toBe('locked');
      expect(views).toEqual([{ isPrivate: true, isHidden: false, userLimit: 0 }]);
      expect(actions.ofType('delete')).toEqual([]);
    });

    it('makes a hidden room hidden from the start: the owner by id, no Join channel, no reserved slot', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');

      const room = await join(feature);

      expect(bits(held(room, ALICE))).toEqual({ allow: VC, deny: 0n });
      expect(bits(held(room, BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
      expect(bits(everyone(room))).toEqual({ allow: 0n, deny: VC });
      expect(actions.ofType('joinChannel')).toEqual([]);
      expect(actions.ofType('create')[0]!.reserveSlotAbove).toBeUndefined();
      expect(await joinChannels.getBySecondary(room)).toBeUndefined();
      expect(await modeOf(room)).toBe('hidden');
      expect(views).toEqual([{ isPrivate: true, isHidden: true, userLimit: 0 }]);
      // The owner was moved in, after the room was hidden from everyone else.
      const order = actions.actions.map((a) => a.type);
      expect(order.indexOf('overwrites')).toBeLessThan(order.indexOf('move'));
    });

    it('names the room private and costs no rename, as a default-private room does', async () => {
      await optIn('public', { name: '{{HIDDEN ?? 🙈 // 👁}}{{PRIVATE ?? 🔒 // 🔓}} @@creator@@' });
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');

      const room = await join(feature);

      expect(actions.ofType('create')[0]!.name.replace(/\s+/g, ' ').trim()).toBe('🙈 🔒 Alice');
      expect(await feature.rerenderSecondary(GUILD, room)).toEqual({});
      expect(actions.ofType('rename')).toEqual([]);
    });

    /**
     * The stricter wins, and a remembered mode is never a way to a LESS private room. A
     * remembered private over a creator channel that already starts locked or hidden adds
     * nothing, and a remembered hidden adds nothing only over one that starts hidden.
     */
    it.each([
      ['private', 'public', 'locked'],
      ['private', 'locked', 'locked'],
      ['private', 'hidden', 'hidden'],
      ['hidden', 'public', 'hidden'],
      ['hidden', 'locked', 'hidden'],
      ['hidden', 'hidden', 'hidden'],
    ] as const)(
      'a remembered %s over a %s creator channel makes a %s room',
      async (saved, starts, expected) => {
        await optIn(starts);
        await prefs.savePrivacy(GUILD, PRIMARY, ALICE, saved);

        const room = await join(feature);

        expect(await modeOf(room)).toBe(expected);
      },
    );

    /** Where it adds nothing, the room is exactly what the creator channel would have made. */
    it.each([
      ['private', 'locked'],
      ['private', 'hidden'],
      ['hidden', 'hidden'],
    ] as const)(
      'adds nothing of its own to a remembered %s over a %s creator channel',
      async (saved, starts) => {
        await optIn(starts);
        const without = await joinAndSnapshot();

        await forgetRooms();
        freshWorld();
        await prefs.savePrivacy(GUILD, PRIMARY, ALICE, saved);
        const withIt = await joinAndSnapshot();

        expect(withIt).toEqual(without);
      },
    );
  });

  // -- who may have it -----------------------------------------------------------------

  describe('a field the member may no longer use', () => {
    const SAVED = async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 5);
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');
    };

    it.each(['rename', 'limit', 'privacy'] as const)(
      'is withheld alone when Alice is denied %s',
      async (feat) => {
        await SAVED();
        await restrict(feat, { users: [ALICE] });

        const room = await join(feature);

        const row = (await secondaries.get(room))!;
        expect(row.state.template === 'Den').toBe(feat !== 'rename');
        expect(createdLimit() === 5).toBe(feat !== 'limit');
        expect((await modeOf(room)) === 'locked').toBe(feat !== 'privacy');
      },
    );

    it('is a denied Hide that withholds a hidden room, and does not lock it in its place', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      await restrict('hide', { users: [ALICE] });

      expect(await modeOf(await join(feature))).toBe('public');
    });

    it('is not withheld from a member who can manage channels, whom no rule can stop', async () => {
      await SAVED();
      await restrict('rename', { users: [ALICE] });

      const room = await join(feature, alice({ canManage: true }));

      expect((await secondaries.get(room))!.state.template).toBe('Den');
    });

    /**
     * The guards fail open on a standing they cannot read, because somebody is there to be
     * refused. A restore has nobody clicking, so where a rule names the feature it fails closed.
     */
    it('is withheld where a rule names the field and the snapshot says nothing of their roles', async () => {
      await SAVED();
      await restrict('rename', { users: [BOB] });

      const room = await join(feature, unresolved());

      const row = (await secondaries.get(room))!;
      expect(row.state.template).toBeUndefined();
      // The fields no rule names are still restored.
      expect(createdLimit()).toBe(5);
      expect(await modeOf(room)).toBe('locked');
    });

    /** `command_access.disabled` withdraws every rule, and what a withdrawn rule denied is restored again. */
    it('is restored while command_access.disabled withdraws the rules', async () => {
      await SAVED();
      await restrict('rename', { users: [ALICE] });
      const withdrawn = buildFeature({
        gate: { ...gateOf(), commandAccessDisabled: () => Promise.resolve(true) },
      });

      const room = await join(withdrawn);

      expect((await secondaries.get(room))!.state.template).toBe('Den');
    });

    it('is restored for a snapshot with no roles when no rule names the field', async () => {
      await SAVED();

      const room = await join(feature, unresolved());

      expect((await secondaries.get(room))!.state.template).toBe('Den');
    });
  });

  // -- off ----------------------------------------------------------------------------

  describe('a creator channel that does not remember', () => {
    /**
     * With the switch off the room is today's room, byte for byte, whatever rows are lying
     * there dormant, and nothing is read: not the rows, and not the lever.
     */
    it('makes the room it always did, and reads nothing, however much was saved', async () => {
      const baseline = await joinAndSnapshot();

      await forgetRooms();
      freshWorld();
      const asked = vi.fn(() => Promise.resolve(false));
      const get = vi.spyOn(prefs, 'get');
      feature = buildFeature({ gate: { ...gateOf(), memberPrefsDisabled: asked } });
      await optIn('public');
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 5);
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      // Turned off again: the rows are dormant and kept.
      await autoChannels.setRememberPrefs(GUILD, PRIMARY, false);
      expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(1);

      const again = await joinAndSnapshot();

      expect(again).toEqual(baseline);
      expect(get).not.toHaveBeenCalled();
      expect(asked).not.toHaveBeenCalled();
    });

    it('is restored again the moment it is turned back on', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      await autoChannels.setRememberPrefs(GUILD, PRIMARY, false);
      await autoChannels.setRememberPrefs(GUILD, PRIMARY, true);

      expect((await secondaries.get(await join(feature)))!.state.template).toBe('Den');
    });

    it('makes the room it always did when the feature has nothing to read with', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');

      const room = await join(
        buildFeature({ memberPrefs: { countByPrimary: () => Promise.resolve(0) } }),
      );

      expect((await secondaries.get(room))!.state.template).toBeUndefined();
    });

    /** Without the hook that answers, a remembered privacy is not restored, rather than made the throwing way. */
    it('does not restore a privacy when the feature has only the hook that deletes the room', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');
      const makePrivateOnCreate = vi.fn(() => Promise.resolve());

      const room = await join(buildFeature({ makePrivateOnCreate }, false));

      expect(makePrivateOnCreate).not.toHaveBeenCalled();
      expect(await modeOf(room)).toBe('public');
    });
  });

  // -- the lever -----------------------------------------------------------------------

  describe('while member_prefs.disabled is on', () => {
    it('restores nothing and reads nothing, and makes the creator channel’s own room', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 5);
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      prefsPaused = true;
      const get = vi.spyOn(prefs, 'get');

      const room = await join(feature);

      expect(get).not.toHaveBeenCalled();
      expect((await secondaries.get(room))!.state.template).toBeUndefined();
      expect(createdLimit()).toBe(0);
      expect(await modeOf(room)).toBe('public');
      expect(actions.ofType('create')[0]!.name).toBe("Alice's room");
    });

    it('restores again once it is lifted, from rows that were never touched', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      prefsPaused = true;
      await join(feature);
      prefsPaused = false;

      const room = await join(feature, member(BOB));
      expect((await secondaries.get(room))!.state.template).toBeUndefined();
      const again = await join(feature, alice());
      expect((await secondaries.get(again))!.state.template).toBe('Den');
    });

    /** The lever is asked only of a creator channel that remembers, so it costs everyone else nothing. */
    it('is not asked of a creator channel that does not remember', async () => {
      const asked = vi.fn(() => Promise.resolve(true));

      await join(buildFeature({ gate: { ...gateOf(), memberPrefsDisabled: asked } }));

      expect(asked).not.toHaveBeenCalled();
    });

    it('fails open: a gate that cannot answer restores what was saved', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      const failing = buildFeature({
        gate: { ...gateOf(), memberPrefsDisabled: () => Promise.reject(new Error('flags down')) },
      });

      expect((await secondaries.get(await join(failing)))!.state.template).toBe('Den');
    });
  });

  describe('while room_access.disabled is on', () => {
    /** The lever stops new hides, and a remembered hidden is one. A lock is never what the member asked for. */
    it('skips a remembered hidden, and does not make a locked room in its place', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      accessPaused = true;

      const room = await join(feature);

      expect(await modeOf(room)).toBe('public');
      expect(actions.ofType('joinChannel')).toEqual([]);
    });

    it('hides the room once it is lifted', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      accessPaused = true;
      await join(feature, alice());
      accessPaused = false;

      expect(await modeOf(await join(feature, member(ALICE)))).toBe('hidden');
    });

    it('does not stop a remembered private, which is a lock and not a hide', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');
      accessPaused = true;

      expect(await modeOf(await join(feature))).toBe('locked');
    });

    it('falls back to the creator channel’s own mode for a hidden room it skipped over a locked one', async () => {
      await optIn('locked');
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      accessPaused = true;

      expect(await modeOf(await join(feature))).toBe('locked');
    });
  });

  // -- when it goes wrong ---------------------------------------------------------------

  describe('a prefs read that fails', () => {
    it('makes the room from the creator channel’s defaults, and the join does not fail', async () => {
      await optIn();
      const failing = buildFeature({
        memberPrefs: {
          countByPrimary: () => Promise.resolve(0),
          get: () => Promise.reject(new Error('db down')),
        },
      });

      const room = await join(failing);

      expect(actions.ofType('create')[0]!.name).toBe("Alice's room");
      expect((await secondaries.get(room))!.state.template).toBeUndefined();
      expect(actions.ofType('move')).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const [fields] = warn.mock.calls[0]!;
      expect(Object.keys(fields as object).sort()).toEqual([
        'err',
        'guildId',
        'memberId',
        'primaryId',
      ]);
    });

    /**
     * The read is started early and awaited late, with reads of the creator channel's rooms
     * between the two. A step there that throws leaves the room uncreated and the read
     * unawaited, and a rejection nobody has attached a handler to is an unhandled one, so
     * the handler has to be there from the moment the read starts.
     */
    it('is never an unhandled rejection, even when a step before it is awaited throws first', async () => {
      await optIn();
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
        const slow = buildFeature({
          memberPrefs: {
            countByPrimary: () => Promise.resolve(0),
            get: () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error('db down, late')), 20);
              }),
          },
        });
        vi.spyOn(secondaries, 'listIdsByPrimary').mockRejectedValue(new Error('rooms unreadable'));
        voice.put(PRIMARY, alice());

        await expect(
          slow.handleVoiceStateUpdate({ guildId: GUILD, member: alice(), afterChannelId: PRIMARY }),
        ).rejects.toThrow('rooms unreadable');
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(unhandled).toEqual([]);
        // It was caught where it was made, and said so.
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        process.off('unhandledRejection', listener);
      }
    });
  });

  /**
   * A remembered privacy is a preference, and a preference that cannot be honoured makes a
   * plain room. Only the admin's own default deletes a room it cannot finish locking down.
   */
  describe('a remembered privacy that cannot be made', () => {
    it.each(['private', 'hidden'] as const)(
      'makes a plain public room for a remembered %s, and does not delete or throw',
      async (saved) => {
        await optIn();
        await prefs.savePrivacy(GUILD, PRIMARY, ALICE, saved);
        actions.failOverwrites = true;

        const room = await join(feature);

        expect(actions.ofType('delete')).toEqual([]);
        expect(await secondaries.get(room)).toBeDefined();
        expect(await modeOf(room)).toBe('public');
        // The member was moved in, to the room they asked for less one setting.
        expect(actions.ofType('move')).toEqual([
          expect.objectContaining({ memberId: ALICE, channelId: room }),
        ]);
        expect(views).toEqual([{ isPrivate: false, isHidden: false, userLimit: 0 }]);
        // Told to the guild once, against the room that is still there, and logged by id.
        expect(problems.recent(GUILD)).toEqual([
          expect.objectContaining({ channelId: room, operation: 'access' }),
        ]);
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain(room);
        expect(logged).not.toContain('Alice');
      },
    );

    it('still restores the name and limit beside a privacy that failed', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 4);
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      actions.failOverwrites = true;

      const room = await join(feature);

      expect((await secondaries.get(room))!.state.template).toBe('Den');
      expect(createdLimit()).toBe(4);
    });

    /** A hide a role above the bot would defeat is refused, which is not a Discord error. */
    it('makes a plain room for a hide the plan refuses, and does not delete it', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
      voice.setBotRoleAccess({ uneditableRoleIds: [ABOVE] });
      actions.seedOverwrites('sec-1', [
        { id: ABOVE, type: OVERWRITE_ROLE, allow: VIEW_CHANNEL, deny: 0n },
      ]);

      const room = await join(feature);

      expect(room).toBe('sec-1');
      expect(actions.ofType('delete')).toEqual([]);
      expect(await modeOf(room)).toBe('public');
    });

    /** Only the Join channel failed, so the lock landed: the room is locked and says so. */
    it('keeps the room locked when only its Join channel could not be made', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');
      actions.createJoinChannel = () => Promise.reject(apiError(50013));

      const room = await join(feature);

      expect(actions.ofType('delete')).toEqual([]);
      expect(await modeOf(room)).toBe('locked');
      expect(views).toEqual([{ isPrivate: true, isHidden: false, userLimit: 0 }]);
    });

    it('survives a hook that throws anyway, because a preference must never fail a room', async () => {
      await optIn();
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');
      const throwing = buildFeature({
        tryMakePrivateOnCreate: () => Promise.reject(new Error('should have answered')),
      });

      const room = await join(throwing);

      expect(await modeOf(room)).toBe('public');
      expect(actions.ofType('delete')).toEqual([]);
    });

    /**
     * The creator channel's own default is the admin's, and it keeps its rollback. A member
     * who remembered hidden over a locked creator channel gets the lock the admin asked for
     * when the hide cannot be made, never an open room.
     */
    describe('over a creator channel that starts its rooms locked', () => {
      it('falls back to the admin’s lock when only the hide is refused', async () => {
        await optIn('locked');
        await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
        voice.setBotRoleAccess({ uneditableRoleIds: [ABOVE] });
        actions.seedOverwrites('sec-1', [
          { id: ABOVE, type: OVERWRITE_ROLE, allow: VIEW_CHANNEL, deny: 0n },
        ]);

        const room = await join(feature);

        expect(await modeOf(room)).toBe('locked');
        expect(actions.ofType('joinChannel')).toHaveLength(1);
        expect(actions.ofType('delete')).toEqual([]);
        expect(views).toEqual([{ isPrivate: true, isHidden: false, userLimit: 0 }]);
      });

      it('deletes the room by the admin’s rollback when nothing can be locked, and says so once', async () => {
        await optIn('locked');
        await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'hidden');
        actions.failOverwrites = true;

        voice.put(PRIMARY, alice());
        await feature.handleVoiceStateUpdate({
          guildId: GUILD,
          member: alice(),
          afterChannelId: PRIMARY,
        });

        const room = actions.ofType('create')[0]!.channelId;
        expect(actions.ofType('delete')).toContainEqual(
          expect.objectContaining({ channelId: room }),
        );
        expect(await secondaries.get(room)).toBeUndefined();
        // One notice, against the creator channel, and none for the room that is gone.
        expect(problems.recent(GUILD)).toEqual([
          expect.objectContaining({ channelId: PRIMARY, operation: 'privacy' }),
        ]);
      });
    });
  });

  // -- replays --------------------------------------------------------------------------

  describe('a catch-up that finds a member sitting in the creator channel', () => {
    it('makes the restored room once, saves nothing, and a second pass makes nothing', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, "@@creator@@'s lounge");
      await prefs.saveLimit(GUILD, PRIMARY, ALICE, 4);
      await prefs.savePrivacy(GUILD, PRIMARY, ALICE, 'private');
      const before = await env.handle.pool.query(
        'SELECT user_id, name_template, user_limit, privacy, updated_at FROM member_room_prefs',
      );
      const saves = [
        vi.spyOn(prefs, 'saveName'),
        vi.spyOn(prefs, 'saveLimit'),
        vi.spyOn(prefs, 'savePrivacy'),
      ];
      const get = vi.spyOn(prefs, 'get');
      voice.put(PRIMARY, alice());
      voice.ensureChannel(PRIMARY);

      const first = await feature.reconcileGuild(GUILD);

      expect(first.created).toHaveLength(1);
      const room = first.created[0]!.secondaryId!;
      expect(actions.ofType('create')[0]!.name).toBe("Alice's lounge");
      expect(createdLimit()).toBe(4);
      expect(await modeOf(room)).toBe('locked');
      expect(get).toHaveBeenCalledTimes(1);

      // The move lands, and the next pass finds her in the room and not the creator channel.
      voice.drop(PRIMARY, ALICE);
      voice.put(room, alice());
      const second = await feature.reconcileGuild(GUILD);

      expect(second.created).toEqual([]);
      expect(actions.ofType('create')).toHaveLength(1);
      expect(get).toHaveBeenCalledTimes(1);
      // The restore is read-only: it never reached a save path, and no row moved.
      for (const save of saves) expect(save).not.toHaveBeenCalled();
      const after = await env.handle.pool.query(
        'SELECT user_id, name_template, user_limit, privacy, updated_at FROM member_room_prefs',
      );
      expect(after.rows).toEqual(before.rows);
    });

    it('reads nothing at all under a dry run, which only reports what it would make', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      const get = vi.spyOn(prefs, 'get');
      voice.put(PRIMARY, alice());
      voice.ensureChannel(PRIMARY);

      const drift = await feature.reconcileGuild(GUILD, { dryRun: true });

      expect(drift.created).toEqual([{ primaryChannelId: PRIMARY, memberId: ALICE }]);
      expect(get).not.toHaveBeenCalled();
      expect(actions.ofType('create')).toEqual([]);
    });

    it('is not read for a member who is no longer in the creator channel, which is a replayed event', async () => {
      await optIn();
      await prefs.saveName(GUILD, PRIMARY, ALICE, 'Den');
      const get = vi.spyOn(prefs, 'get');

      // The event arrives after she has already moved on.
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice(),
        afterChannelId: PRIMARY,
      });

      expect(get).not.toHaveBeenCalled();
      expect(actions.ofType('create')).toEqual([]);
    });
  });

  // -- the whole round trip ---------------------------------------------------------------

  describe('what a member sets in one room comes back in the next', () => {
    it('saves a name, a size and a hide, restores all three, and a public room forgets the privacy', async () => {
      await optIn();
      const first = await join(feature);

      expect((await commands.setName(GUILD, first, ALICE, "@@creator@@'s lounge")).ok).toBe(true);
      expect((await commands.setLimit(GUILD, first, ALICE, 5)).ok).toBe(true);
      expect((await privacy.hide(GUILD, first, ALICE)).ok).toBe(true);
      expect(await prefs.get(PRIMARY, ALICE)).toEqual({
        name: "@@creator@@'s lounge",
        limit: 5,
        privacy: 'hidden',
      });

      // She leaves, the empty room goes, and she joins again.
      voice.drop(first, ALICE);
      await feature.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice(),
        beforeChannelId: first,
      });
      expect(await secondaries.get(first)).toBeUndefined();
      actions.actions.length = 0;
      views.length = 0;

      const second = await join(feature);

      expect(actions.ofType('create')[0]!.name).toBe("Alice's lounge");
      expect(createdLimit()).toBe(5);
      expect(await modeOf(second)).toBe('hidden');
      expect(views).toEqual([{ isPrivate: true, isHidden: true, userLimit: 5 }]);
      // Nobody else is given her room.
      const bobs = await join(feature, member(BOB));
      expect(await modeOf(bobs)).toBe('public');
      expect((await secondaries.get(bobs))!.state.template).toBeUndefined();

      // Going public takes the privacy back out, and the name and size stay.
      expect((await privacy.makePublic(GUILD, second, ALICE)).ok).toBe(true);
      expect(await prefs.get(PRIMARY, ALICE)).toEqual({
        name: "@@creator@@'s lounge",
        limit: 5,
        privacy: null,
      });
    });

    it('remembers nothing for a creator channel that was never opted in', async () => {
      const room = await join(feature);

      await commands.setName(GUILD, room, ALICE, 'Den');
      await commands.setLimit(GUILD, room, ALICE, 5);
      await privacy.makePrivate(GUILD, room, ALICE);

      expect(await prefs.get(PRIMARY, ALICE)).toBeUndefined();
      expect(await prefs.countByPrimary(GUILD, PRIMARY)).toBe(0);
    });
  });
});
