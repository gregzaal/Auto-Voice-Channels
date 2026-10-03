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
import { CONNECT, OVERWRITE_MEMBER, VIEW_CHANNEL, type ResolvedOverwrite } from './accessPlan.js';
import { AccessCommands, type AccessTarget } from './accessCommands.js';
import { ACCESS_REFUSALS } from './accessListsCopy.js';
import { RecordingVoiceActions } from './actions.js';
import type { CommandResult } from './commands.js';
import { PrivacyService } from './privacy.js';
import { ROOM_ACCESS_REPLIES } from './roomAccessCopy.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-access-test';
const BOT = 'bot-1';
const ALICE_ROOM = 'sec-alice';
const ALICE_SECOND = 'sec-alice-2';
const BOB_ROOM = 'sec-bob';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;

const bits = (o: ResolvedOverwrite | undefined) =>
  o ? { allow: o.allow, deny: o.deny } : undefined;

/** A user the command was pointed at, who is a member of the server and is no bot. */
const target = (id: string, over: Partial<AccessTarget> = {}): AccessTarget => ({
  id,
  bot: false,
  inServer: true,
  ...over,
});

const apiError = (code: number) =>
  new DiscordAPIError(
    { code, message: `code ${code}` } as never,
    code,
    403,
    'PATCH',
    'https://discord.test',
    {} as never,
  );

describe('AccessCommands (integration)', () => {
  let env: PgTestEnv;
  let secondaries: SecondaryChannelRepository;
  let joinChannels: JoinChannelRepository;
  let lists: MemberAccessListRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let privacy: PrivacyService;
  let access: AccessCommands;
  /** Whether `room_access.disabled` is on, for the service and the commands alike. */
  let paused: boolean;
  /** Every reply, for the copy-rules check at the end. */
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

  const build = (over: { lists?: MemberAccessListRepository } = {}): AccessCommands => {
    const repo = over.lists ?? lists;
    privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => BOT,
      memberAccessLists: repo,
      roomAccessDisabled: () => Promise.resolve(paused),
    });
    const commands = new AccessCommands({
      lists: repo,
      secondaries,
      privacy,
      voice,
      logger: fakeLogger(),
      roomAccessDisabled: () => Promise.resolve(paused),
    });
    // Every reply a command gives, so the last test holds them all to the copy rules.
    return new Proxy(commands, {
      get(obj, prop, receiver) {
        const value: unknown = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const result = (await value.apply(obj, args)) as CommandResult;
          replies.push(result.message);
          return result;
        };
      },
    });
  };

  const room = async (channelId: string, ownerId: string) => {
    await secondaries.create({
      channelId,
      guildId: GUILD,
      primaryChannelId: 'p',
      ownerId,
      state: { name: `${ownerId}'s room` },
    });
    voice.put(channelId, member(ownerId));
  };

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.memberAccessLists);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    paused = false;
    access = build();
    await room(ALICE_ROOM, 'alice');
    await room(BOB_ROOM, 'bob');
  });

  const held = (id: string, channel = ALICE_ROOM) =>
    actions.overwritesOf(channel).find((o) => o.id === id && o.type === OVERWRITE_MEMBER);
  const saved = (ownerId = 'alice') => lists.get(GUILD, ownerId);
  const lock = (channel = ALICE_ROOM, owner = 'alice') =>
    privacy.makePrivate(GUILD, channel, owner);

  // -- trust ----------------------------------------------------------------------------

  describe('trust', () => {
    it('saves them, lets them into the creator’s locked room, and says so', async () => {
      await lock();

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res.ok).toBe(true);
      expect(res.message).toContain('<@carol> is on your trusted list');
      expect(res.message).toContain('rooms you create in this server');
      expect(res.message).toContain("I've applied it to your current room.");
      expect(await saved()).toEqual({ trusted: ['carol'], blocked: [] });
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });

    it('applies to every room the member created, and to no one else’s', async () => {
      await room(ALICE_SECOND, 'alice');
      await lock(ALICE_ROOM);
      await lock(ALICE_SECOND);
      await lock(BOB_ROOM, 'bob');

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res.message).toContain('2 of your current rooms');
      expect(held('carol', ALICE_ROOM)).toBeDefined();
      expect(held('carol', ALICE_SECOND)).toBeDefined();
      expect(held('carol', BOB_ROOM)).toBeUndefined();
    });

    /** Trusted entries spend an overwrite only where they matter: a public room is open anyway. */
    it('writes nothing to a public room, and still saves them', async () => {
      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');
      expect(res.ok).toBe(true);
      expect(await saved()).toEqual({ trusted: ['carol'], blocked: [] });
      expect(held('carol')).toBeUndefined();
    });

    it('lets them into a hidden room with View and Connect', async () => {
      await privacy.hide(GUILD, ALICE_ROOM, 'alice');
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      expect(bits(held('carol'))).toEqual({ allow: VC, deny: 0n });
    });

    it('moves a member from the blocked list and takes their deny back', async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'blocked');
      expect(bits(held('carol'))).toEqual({ allow: 0n, deny: VC });

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res.message).toContain('moved from your blocked list to your trusted list');
      expect(await saved()).toEqual({ trusted: ['carol'], blocked: [] });
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });
  });

  // -- block ----------------------------------------------------------------------------

  describe('block', () => {
    it.each(['public', 'locked', 'hidden'] as const)(
      'denies them View and Connect in a %s room, and says Administrators can still enter',
      async (mode) => {
        if (mode === 'locked') await lock();
        if (mode === 'hidden') await privacy.hide(GUILD, ALICE_ROOM, 'alice');

        const res = await access.save(GUILD, 'alice', target('mallory'), 'blocked');

        expect(res.ok).toBe(true);
        expect(res.message).toContain('<@mallory> is on your blocked list');
        expect(res.message).toContain('Administrators can still enter');
        expect(await saved()).toEqual({ trusted: [], blocked: ['mallory'] });
        expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      },
    );

    it('moves them out of the room they are in, last, and says so', async () => {
      voice.put(ALICE_ROOM, member('mallory'));

      const res = await access.save(GUILD, 'alice', target('mallory'), 'blocked');

      expect(res.message).toContain('moved them out of it');
      const log = actions.actions.map((a) => a.type);
      expect(log.indexOf('overwrites')).toBeLessThan(log.indexOf('move'));
      expect(actions.ofType('move')).toContainEqual(
        expect.objectContaining({ memberId: 'mallory', channelId: null, onlyFrom: ALICE_ROOM }),
      );
    });

    it('does not touch a room whose creator is somebody else', async () => {
      voice.put(BOB_ROOM, member('mallory'));
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
      expect(held('mallory', BOB_ROOM)).toBeUndefined();
      expect(actions.ofType('move').filter((a) => a.onlyFrom === BOB_ROOM)).toEqual([]);
    });

    /** A block never reaches the owner, who is let in by id, or the bot. */
    it('never blocks the owner of the room out of it', async () => {
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
      expect(held('alice')).toBeUndefined();
    });
  });

  // -- who cannot go on a list ------------------------------------------------------------

  describe('refuses', () => {
    const nothingHappened = async () => {
      expect(await saved()).toEqual({ trusted: [], blocked: [] });
      expect(actions.actions).toEqual([]);
    };

    it.each(['trusted', 'blocked'] as const)('yourself, for %s', async (kind) => {
      const res = await access.save(GUILD, 'alice', target('alice'), kind);
      expect(res).toEqual({ ok: false, message: ACCESS_REFUSALS.self });
      await nothingHappened();
    });

    it.each(['trusted', 'blocked'] as const)(
      'a bot, from what Discord resolved or what the cache knows, for %s',
      async (kind) => {
        expect(await access.save(GUILD, 'alice', target('bot-2', { bot: true }), kind)).toEqual({
          ok: false,
          message: ACCESS_REFUSALS.bot('bot-2'),
        });
        voice.setMemberFacts('bot-3', { bot: true });
        expect(await access.save(GUILD, 'alice', target('bot-3'), kind)).toEqual({
          ok: false,
          message: ACCESS_REFUSALS.bot('bot-3'),
        });
        await nothingHappened();
      },
    );

    it.each(['trusted', 'blocked'] as const)(
      'a user who is not in this server, for %s',
      async (kind) => {
        const res = await access.save(GUILD, 'alice', target('gone', { inServer: false }), kind);
        expect(res).toEqual({ ok: false, message: ACCESS_REFUSALS.notInServer('gone') });
        await nothingHappened();
      },
    );

    it.each([
      ['an Administrator', { administrator: true }],
      ['the server owner', { guildOwner: true }],
    ])('to block %s, and says Administrators can still enter', async (_who, facts) => {
      voice.setMemberFacts('boss', facts);
      const res = await access.save(GUILD, 'alice', target('boss'), 'blocked');
      expect(res).toEqual({ ok: false, message: ACCESS_REFUSALS.unblockable('boss') });
      expect(res.message).toContain('Administrators can still enter');
      await nothingHappened();
    });

    it('but lets an Administrator be trusted, which is harmless', async () => {
      voice.setMemberFacts('boss', { administrator: true });
      expect((await access.save(GUILD, 'alice', target('boss'), 'trusted')).ok).toBe(true);
      expect(await saved()).toEqual({ trusted: ['boss'], blocked: [] });
    });

    it('nobody who was saved before they became an Administrator, which applying skips', async () => {
      // A member who is not cached passes the refusal, which is a courtesy: the overwrite
      // is the authority, and a block of an Administrator is skipped when it is applied.
      voice.put(ALICE_ROOM, member('boss'));
      voice.setMemberFacts('boss', { administrator: true });
      await lists.add(GUILD, 'alice', 'boss', 'blocked');
      await privacy.applyAccessLists(GUILD, ALICE_ROOM);
      expect(held('boss')).toBeUndefined();
      expect(actions.ofType('move')).toEqual([]);
    });
  });

  // -- the caps ---------------------------------------------------------------------------

  describe('a full list', () => {
    it('is refused with how to make room, and nothing changes', async () => {
      await lock();
      for (let i = 0; i < 25; i++) await lists.add(GUILD, 'alice', `filler-${i}`, 'trusted');
      const before = actions.actions.length;

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res).toEqual({ ok: false, message: ACCESS_REFUSALS.full('trusted') });
      expect((await saved()).trusted).not.toContain('carol');
      expect(actions.actions).toHaveLength(before);
    });

    it('does not count against the other list, and refuses a member moving onto a full one', async () => {
      for (let i = 0; i < 25; i++) await lists.add(GUILD, 'alice', `filler-${i}`, 'blocked');
      await lists.add(GUILD, 'alice', 'carol', 'trusted');

      const res = await access.save(GUILD, 'alice', target('carol'), 'blocked');

      expect(res.ok).toBe(false);
      expect((await saved()).trusted).toContain('carol');
    });
  });

  // -- repeats converge ------------------------------------------------------------------

  describe('a repeat', () => {
    it('says they are already on the list, and changes nothing the second time', async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      const before = actions.actions.length;

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res).toEqual({
        ok: true,
        message: "<@carol> is already on your trusted list. I've applied it to your current room.",
      });
      // Nothing to write: the room already holds it, so the apply is a read.
      expect(actions.actions.slice(before).filter((a) => a.type === 'overwrites')).toEqual([]);
    });

    /**
     * The table commits before Discord is touched, so a crash between the two leaves a row
     * and no overwrite. The retry answers "already" and must still write it.
     */
    it('still applies a list entry whose first apply never happened', async () => {
      await lock();
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      expect(held('carol')).toBeUndefined();

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res.message).toContain('already on your trusted list');
      expect(bits(held('carol'))).toEqual({ allow: C, deny: 0n });
    });
  });

  // -- remove and clear ---------------------------------------------------------------------

  describe('remove', () => {
    it('takes a trusted member off the list and the live room', async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'trusted');

      const res = await access.remove(GUILD, 'alice', 'carol');

      expect(res.ok).toBe(true);
      expect(res.message).toContain('<@carol> is off your trusted list.');
      expect(await saved()).toEqual({ trusted: [], blocked: [] });
      expect(held('carol')).toBeUndefined();
      expect((await secondaries.getAccess(ALICE_ROOM))?.trusted).toBeUndefined();
    });

    it('takes a block back off the live room too, which is the Discord half of an undo', async () => {
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
      expect(held('mallory')).toBeDefined();

      const res = await access.remove(GUILD, 'alice', 'mallory');

      expect(res.message).toContain('<@mallory> is off your blocked list.');
      expect(held('mallory')).toBeUndefined();
    });

    it('says they were on neither list, and still converges a room that kept their overwrite', async () => {
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
      // The row went but the room did not: a retry after a crash.
      await lists.remove(GUILD, 'alice', 'mallory');
      expect(held('mallory')).toBeDefined();

      const res = await access.remove(GUILD, 'alice', 'mallory');

      expect(res.message).toContain("wasn't on either of your lists");
      expect(held('mallory')).toBeUndefined();
    });

    it('works for a member who has since left the server, since removing needs no lookup', async () => {
      await lists.add(GUILD, 'alice', 'left-server', 'blocked');
      const res = await access.remove(GUILD, 'alice', 'left-server');
      expect(res.message).toContain('is off your blocked list');
    });

    it('leaves another member’s entry, and another owner’s list, alone', async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      await access.save(GUILD, 'alice', target('dave'), 'trusted');
      await lists.add(GUILD, 'bob', 'carol', 'trusted');

      await access.remove(GUILD, 'alice', 'carol');

      expect((await saved()).trusted).toEqual(['dave']);
      expect((await saved('bob')).trusted).toEqual(['carol']);
      expect(held('dave')).toBeDefined();
    });
  });

  describe('clear', () => {
    const fill = async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      await access.save(GUILD, 'alice', target('dave'), 'trusted');
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
    };

    it('empties both lists and takes every entry off the live rooms', async () => {
      await fill();

      const res = await access.clear(GUILD, 'alice');

      expect(res.message).toBe(
        "Emptied both your lists (3 people). I've applied it to your current room.",
      );
      expect(await saved()).toEqual({ trusted: [], blocked: [] });
      for (const id of ['carol', 'dave', 'mallory']) expect(held(id), id).toBeUndefined();
    });

    it('empties one list and leaves the other and its overwrites as they were', async () => {
      await fill();

      const res = await access.clear(GUILD, 'alice', 'blocked');

      expect(res.message).toContain('Emptied your blocked list (1 person).');
      expect(await saved()).toEqual({ trusted: ['carol', 'dave'], blocked: [] });
      expect(held('mallory')).toBeUndefined();
      expect(held('carol')).toBeDefined();
    });

    it('says a list was already empty, and still converges the rooms', async () => {
      await fill();
      await lists.clear(GUILD, 'alice');
      const res = await access.clear(GUILD, 'alice', 'trusted');
      expect(res.message).toContain('Your trusted list was already empty.');
      expect(held('carol')).toBeUndefined();
    });
  });

  // -- list ---------------------------------------------------------------------------------

  describe('list', () => {
    it('shows the member’s own lists with how full each is, as mentions', async () => {
      await lists.add(GUILD, 'alice', 'carol', 'trusted');
      await lists.add(GUILD, 'alice', 'mallory', 'blocked');
      await lists.add(GUILD, 'bob', 'eve', 'blocked');

      const res = await access.list(GUILD, 'alice');

      expect(res.ok).toBe(true);
      expect(res.message).toContain('**Trusted** (1 of 25): <@carol>');
      expect(res.message).toContain('**Blocked** (1 of 25): <@mallory>');
      expect(res.message).not.toContain('eve');
    });

    it('reads nothing from Discord', async () => {
      await access.list(GUILD, 'alice');
      expect(actions.actions).toEqual([]);
    });

    it('is per server: the same member’s list in another server is not shown', async () => {
      await lists.add('another-guild', 'alice', 'zed', 'blocked');
      expect((await access.list(GUILD, 'alice')).message).not.toContain('zed');
    });
  });

  // -- handover ---------------------------------------------------------------------------

  describe('rooms the member no longer controls', () => {
    it('does not touch a room the member handed over, and does not undo what the recipient has', async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      // A deliberate /transfer re-points the room's creator, so it is Bob's list that applies.
      await secondaries.setOwnerAndCreator(ALICE_ROOM, 'bob', 'Bob');
      await privacy.handleOwnerChanged(GUILD, ALICE_ROOM, 'bob', 'Bob', { handover: true });
      expect(held('carol')).toBeUndefined();
      const before = actions.actions.length;

      const res = await access.save(GUILD, 'alice', target('mallory'), 'blocked');

      expect(res.ok).toBe(true);
      expect(held('mallory')).toBeUndefined();
      expect(actions.actions.slice(before)).toEqual([]);
      // And no room of hers is open, so the reply has nothing to say about rooms.
      expect(res.message).not.toContain('current room');
    });

    it('still reaches a room whose owner left and a caretaker inherited, which the creator made', async () => {
      await secondaries.setOwner(ALICE_ROOM, 'bob');
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
    });
  });

  // -- the lever -----------------------------------------------------------------------------

  describe('room_access.disabled', () => {
    it('refuses trust and block, saving nothing and writing nothing', async () => {
      paused = true;
      for (const kind of ['trusted', 'blocked'] as const) {
        const res = await access.save(GUILD, 'alice', target('carol'), kind);
        expect(res).toEqual({ ok: false, message: ROOM_ACCESS_REPLIES.paused });
      }
      expect(await saved()).toEqual({ trusted: [], blocked: [] });
      expect(actions.actions).toEqual([]);
    });

    /** A removal is an undo, so it works, and takes entries back without adding any. */
    it('never stops remove, clear or list, and they take entries off live rooms', async () => {
      await lock();
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      await access.save(GUILD, 'alice', target('mallory'), 'blocked');
      await lists.add(GUILD, 'alice', 'dave', 'trusted');
      paused = true;

      const listed = await access.list(GUILD, 'alice');
      const removed = await access.remove(GUILD, 'alice', 'carol');

      expect(listed.ok && removed.ok).toBe(true);
      expect(held('carol')).toBeUndefined();
      // Still listed and recorded, so it stays. Listed but never applied, so the lever keeps it so.
      expect(bits(held('mallory'))).toEqual({ allow: 0n, deny: VC });
      expect(held('dave')).toBeUndefined();

      const cleared = await access.clear(GUILD, 'alice');
      expect(cleared.ok).toBe(true);
      expect(held('mallory')).toBeUndefined();
      expect(await saved()).toEqual({ trusted: [], blocked: [] });
    });

    it('says applying is off when the lever is thrown between the save and the apply', async () => {
      await lock();
      // Off for the check at the top, on by the time the service applies.
      let asked = 0;
      const flipping = new AccessCommands({
        lists,
        secondaries,
        privacy,
        voice,
        logger: fakeLogger(),
        roomAccessDisabled: () => Promise.resolve(++asked > 1),
      });
      // The service reads the flag through `paused`, which is now on.
      paused = true;

      const res = await flipping.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res.ok).toBe(true);
      expect(res.message).toContain('switched off for now');
      expect(res.message).toContain('were not changed');
      expect(held('carol')).toBeUndefined();
    });

    it('treats a failed flag read as not disabled', async () => {
      const broken = new AccessCommands({
        lists,
        secondaries,
        privacy,
        voice,
        logger: fakeLogger(),
        roomAccessDisabled: () => Promise.reject(new Error('db down')),
      });
      expect((await broken.save(GUILD, 'alice', target('carol'), 'trusted')).ok).toBe(true);
    });
  });

  // -- failures ------------------------------------------------------------------------------

  describe('when Discord is not cooperating', () => {
    it('keeps the entry, tells the member, and says to run it again, for the rooms that failed only', async () => {
      await room(ALICE_SECOND, 'alice');
      await lock(ALICE_ROOM);
      await lock(ALICE_SECOND);
      const real = actions.applyOverwrites.bind(actions);
      actions.applyOverwrites = (guildId, channelId, desired, previous) =>
        channelId === ALICE_SECOND
          ? Promise.reject(apiError(50013))
          : real(guildId, channelId, desired, previous);

      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

      expect(res.ok).toBe(true);
      expect(res.message).toContain('I could not update one room');
      expect(res.message).toContain('Run the command again to retry');
      expect(res.message).toContain("I've applied it to your current room.");
      expect((await saved()).trusted).toEqual(['carol']);
      expect(held('carol', ALICE_ROOM)).toBeDefined();
      expect(held('carol', ALICE_SECOND)).toBeUndefined();

      // The retry: the entry is "already" saved and the room that failed now takes it.
      actions.applyOverwrites = real;
      const retry = await access.save(GUILD, 'alice', target('carol'), 'trusted');
      expect(retry.message).not.toContain('could not');
      expect(held('carol', ALICE_SECOND)).toBeDefined();
    });

    it('does not say a queued write has happened', async () => {
      await lock();
      actions.simulateOverwriteRateLimit = true;
      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');
      expect(res.message).toContain('queued');
      expect(res.message).not.toContain("I've applied");
    });

    it('does not count a room that has gone from Discord', async () => {
      await lock();
      actions.overwritesGoneForChannel = ALICE_ROOM;
      const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');
      expect(res.ok).toBe(true);
      expect(res.message).not.toContain('current room');
      expect(res.message).not.toContain('could not');
    });

    it('answers instead of throwing when the lists cannot be read or written', async () => {
      const broken = build({
        lists: {
          add: () => Promise.reject(new Error('db down')),
          remove: () => Promise.reject(new Error('db down')),
          clear: () => Promise.reject(new Error('db down')),
          get: () => Promise.reject(new Error('db down')),
        } as unknown as MemberAccessListRepository,
      });
      for (const result of await Promise.all([
        broken.save(GUILD, 'alice', target('carol'), 'trusted'),
        broken.remove(GUILD, 'alice', 'carol'),
        broken.clear(GUILD, 'alice'),
        broken.list(GUILD, 'alice'),
      ])) {
        expect(result).toEqual({ ok: false, message: ACCESS_REFUSALS.failed });
      }
    });
  });

  // -- the cap on rooms ------------------------------------------------------------------------

  it('stops at 25 rooms, and says how many it left', async () => {
    await lock();
    for (let i = 0; i < 27; i++) {
      const id = `bulk-${String(i).padStart(2, '0')}`;
      await room(id, 'alice');
      await lock(id);
    }
    // The two rooms of the fixture are alice's too.
    const total = (await secondaries.listByOriginalCreator(GUILD, 'alice')).length;

    const res = await access.save(GUILD, 'alice', target('carol'), 'trusted');

    expect(total).toBe(28);
    expect(res.message).toContain('I only updated the first 25 of your 28 rooms.');
    // And it did stop: twenty-five rooms hold the overwrite and three do not.
    const rooms = await secondaries.listByOriginalCreator(GUILD, 'alice');
    const updated = rooms.filter((r) => held('carol', r.channelId) !== undefined);
    expect(updated).toHaveLength(25);
  });

  // -- copy rules ---------------------------------------------------------------------------------

  /** The replies this file made, rendered, held to AGENTS.md's punctuation and vocabulary rules. */
  describe('copy rules', () => {
    it('has replies to check', async () => {
      await lock();
      voice.setMemberFacts('boss', { administrator: true });
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      await access.save(GUILD, 'alice', target('carol'), 'trusted');
      await access.save(GUILD, 'alice', target('carol'), 'blocked');
      await access.save(GUILD, 'alice', target('alice'), 'blocked');
      await access.save(GUILD, 'alice', target('boss'), 'blocked');
      await access.list(GUILD, 'alice');
      await access.remove(GUILD, 'alice', 'carol');
      await access.remove(GUILD, 'alice', 'carol');
      await access.clear(GUILD, 'alice');
      expect(replies.length).toBeGreaterThan(20);
    });

    it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
      const text = replies.join('\n');
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/[‘’“”]/);
      expect(text).not.toMatch(/;/);
    });

    it('never says primary or secondary, and makes no claim of generative AI', () => {
      const text = replies.join('\n').toLowerCase();
      expect(text).not.toContain('primary');
      expect(text).not.toContain('secondary');
      expect(text).not.toMatch(/\b(ai|generated|llm)\b/);
    });

    it('stays inside one Discord message', () => {
      for (const reply of replies) expect(reply.length).toBeLessThanOrEqual(2000);
    });
  });
});
