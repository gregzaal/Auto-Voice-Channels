import { EventEmitter } from 'node:events';
import {
  JoinChannelRepository,
  MemberAccessListRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { MessageFlags } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { fakeLogger } from '../runtime/testUtils.js';
import { GuildDispatcher } from '../runtime/dispatcher.js';
import {
  BOT_ACCESS,
  CONNECT,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  type ResolvedOverwrite,
} from '../features/voice/accessPlan.js';
import { AccessCommands } from '../features/voice/accessCommands.js';
import { RecordingVoiceActions } from '../features/voice/actions.js';
import { PrivacyService } from '../features/voice/privacy.js';
import { FakeVoiceView, fakeMember as member } from '../features/voice/voiceTestUtils.js';
import { registerInteractionHandler, type InteractionDeps } from './interactions.js';

/**
 * The commands end to end through the interaction layer: a real router, the real privacy
 * service and saved list commands over Postgres, and the Discord writes recorded, so what
 * a member types and what Discord is told are held together in one place.
 *
 * The unit tests pin the router and the integration tests pin the services. This pins the
 * seam: that `/hide`, `/unhide` and `/public` leave a room as it was, and that `/access`
 * reaches the live rooms of the member who typed it.
 */
const GUILD = 'guild-e2e';
const ROOM = 'room-1';
const BOT = 'bot-1';
const ALICE = '111111111111111111';
const CAROL = '222222222222222222';
const MALLORY = '333333333333333333';
const ROLE = '444444444444444444';

const V = VIEW_CHANNEL;
const C = CONNECT;
const VC = V | C;

describe('/hide, /unhide, /public and /access, end to end', () => {
  let env: PgTestEnv;
  let secondaries: SecondaryChannelRepository;
  let joinChannels: JoinChannelRepository;
  let lists: MemberAccessListRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let client: EventEmitter;
  let dispose: (() => void) | undefined;
  /** The guild row's settings, which carry the `/restrict` rules. */
  let settings: Record<string, unknown>;
  let paused: boolean;

  beforeAll(async () => {
    env = await startPostgres();
    secondaries = new SecondaryChannelRepository(env.handle.db);
    joinChannels = new JoinChannelRepository(env.handle.db);
    lists = new MemberAccessListRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.memberAccessLists);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    settings = {};
    paused = false;
    client = new EventEmitter();
    const privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
      botUserId: () => BOT,
      memberAccessLists: lists,
      roomAccessDisabled: () => Promise.resolve(paused),
    });
    const access = new AccessCommands({
      lists,
      secondaries,
      privacy,
      voice,
      logger: fakeLogger(),
      roomAccessDisabled: () => Promise.resolve(paused),
    });
    const dispatcher = new GuildDispatcher({ logger: fakeLogger() });
    dispose = registerInteractionHandler({
      client,
      dispatcher,
      voiceCommands: {},
      settings: {},
      votekick: {},
      privacy,
      access,
      feature: {},
      guilds: { get: () => Promise.resolve({ authStatus: 'active', settings }) },
      managed: {},
      selfHosted: true,
      clientId: 'c1',
      logger: fakeLogger(),
    } as unknown as InteractionDeps);

    await secondaries.create({
      channelId: ROOM,
      guildId: GUILD,
      primaryChannelId: 'p',
      ownerId: ALICE,
      state: { name: 'Alice' },
    });
    voice.put(ROOM, member(ALICE));
    // The creator channel handed the room a role-gated @everyone, which a round trip must give back.
    actions.seedOverwrites(ROOM, [
      { id: BOT, type: OVERWRITE_MEMBER, allow: BOT_ACCESS, deny: 0n },
      { id: GUILD, type: OVERWRITE_ROLE, allow: C, deny: 0n },
    ]);
  });

  afterEach(() => dispose?.());

  const everyone = (): ResolvedOverwrite | undefined =>
    actions.overwritesOf(ROOM).find((o) => o.type === OVERWRITE_ROLE && o.id === GUILD);
  const held = (id: string) =>
    actions.overwritesOf(ROOM).find((o) => o.type === OVERWRITE_MEMBER && o.id === id);
  const bits = (o: ResolvedOverwrite | undefined) =>
    o ? { allow: o.allow, deny: o.deny } : undefined;

  /** One interaction as `userId`, sitting in `ROOM`, and what the router answered with. */
  async function type(
    commandName: string,
    over: {
      subcommand?: string;
      userId?: string;
      memberId?: string;
      memberIsBot?: boolean;
      list?: string;
      voiceChannelId?: string | null;
      roles?: string[];
    } = {},
  ): Promise<{ content: string; deferredEphemeral: boolean; mentions: unknown }> {
    const userId = over.userId ?? ALICE;
    const inVoice = over.voiceChannelId === null ? undefined : (over.voiceChannelId ?? ROOM);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      id: 'i1',
      guildId: GUILD,
      user: { id: userId },
      member: { roles: over.roles ?? [] },
      guild: {
        members: {
          cache: { get: () => (inVoice ? { voice: { channelId: inVoice } } : undefined) },
        },
      },
      commandName,
      memberPermissions: { has: () => false },
      replied: false,
      deferred: false,
      inGuild: () => true,
      isRepliable: () => true,
      isChatInputCommand: () => true,
      isButton: () => false,
      isChannelSelectMenu: () => false,
      isStringSelectMenu: () => false,
      isModalSubmit: () => false,
      reply,
      followUp: vi.fn().mockResolvedValue(undefined),
      editReply,
      deferReply: vi.fn().mockImplementation(() => {
        interaction.deferred = true;
        return Promise.resolve();
      }),
      options: {
        getSubcommand: () => over.subcommand ?? null,
        getString: (name: string) => (name === 'list' ? (over.list ?? null) : null),
        getInteger: () => null,
        get: (name: string) =>
          name === 'member' && over.memberId
            ? { name, user: { id: over.memberId, bot: over.memberIsBot === true }, member: {} }
            : null,
      },
    };
    client.emit('interactionCreate', interaction);
    // The router and the services await real Postgres, so give them until they answer.
    await vi.waitFor(() => {
      expect(editReply.mock.calls.length + reply.mock.calls.length).toBeGreaterThan(0);
    });
    const answered = (editReply.mock.calls[0] ?? reply.mock.calls[0])![0] as {
      content: string;
      allowedMentions?: unknown;
    };
    return {
      content: answered.content,
      deferredEphemeral:
        (interaction.deferReply.mock.calls[0]?.[0] as { flags?: number } | undefined)?.flags ===
        MessageFlags.Ephemeral,
      mentions: answered.allowedMentions,
    };
  }

  // -- /hide, /unhide, /public --------------------------------------------------------------

  it('/hide, /unhide and /public: each leaves Discord and the room as the next one expects, and /public gives the room back', async () => {
    const hidden = await type('hide');
    expect(hidden.content.startsWith('✅ 🙈 Your room is now hidden from the channel list.')).toBe(
      true,
    );
    expect(hidden.content).toContain('Administrators always see everything');
    // Hidden: the owner by id, the bot, and `@everyone` denied View and Connect. No Join channel.
    expect(bits(held(ALICE))).toEqual({ allow: VC, deny: 0n });
    expect(bits(held(BOT))).toEqual({ allow: BOT_ACCESS, deny: 0n });
    expect(bits(everyone())).toEqual({ allow: 0n, deny: VC });
    expect(actions.ofType('joinChannel')).toEqual([]);
    expect((await secondaries.get(ROOM))!.state.private).toBe(true);
    expect((await secondaries.getAccess(ROOM))?.hidden).toBe(true);

    const shown = await type('unhide');
    expect(shown.content.startsWith('✅ 👁 Your room shows in the channel list again')).toBe(true);
    // Shown again and still locked: `@everyone` can see it and cannot join, and there is a Join channel.
    expect(bits(everyone())?.deny).toBe(C);
    expect(everyone()!.allow & V).toBe(0n);
    expect(actions.ofType('joinChannel')).toHaveLength(1);
    expect((await secondaries.getAccess(ROOM))?.hidden).toBeUndefined();
    expect((await secondaries.get(ROOM))!.state.private).toBe(true);

    const opened = await type('public');
    expect(opened.content).toBe('✅ 🔓 Your channel is now public.');
    // The creator channel's `@everyone` Connect allow comes back exactly: not wiped to neutral.
    expect(bits(everyone())).toEqual({ allow: C, deny: 0n });
    expect(await joinChannels.getBySecondary(ROOM)).toBeUndefined();
    expect(actions.ofType('delete')).toHaveLength(1);
    expect((await secondaries.get(ROOM))!.state.private).toBeUndefined();
  });

  it('answers each of them as an ephemeral edit, and never twice', async () => {
    for (const name of ['hide', 'unhide', 'public']) {
      const answered = await type(name);
      expect(answered.deferredEphemeral, name).toBe(true);
    }
  });

  it('refuses /hide for somebody who is not in a room, and for one who does not own it', async () => {
    expect((await type('hide', { voiceChannelId: null })).content).toContain('You need to be in');
    voice.put(ROOM, member(CAROL));
    const notOwner = await type('hide', { userId: CAROL });
    expect(notOwner.content).toBe('⚠️ Only the room owner can hide it.');
    expect(actions.actions.filter((a) => a.type === 'overwrites')).toEqual([]);
  });

  it('refuses /hide on a room nobody owns, and says how to claim it', async () => {
    await env.handle.pool.query(
      'UPDATE secondary_channels SET owner_id = NULL WHERE channel_id = $1',
      [ROOM],
    );
    const refused = await type('hide');
    expect(refused.content).toContain('/reclaim');
    expect(actions.actions.filter((a) => a.type === 'overwrites')).toEqual([]);
  });

  it('refuses /hide for a member a rule denies, and lets /unhide through for them', async () => {
    settings = { command_access: { hide: { users: [ALICE] } } };
    const refused = await type('hide');
    expect(refused.content).toContain('A server admin has turned off **Hide** for you.');
    expect(actions.actions).toEqual([]);

    // Hidden before the rule, or by another route: undoing it is never restricted.
    paused = false;
    settings = {};
    await type('hide');
    settings = { command_access: { hide: { users: [ALICE] } } };
    const shown = await type('unhide');
    expect(shown.content.startsWith('✅')).toBe(true);
  });

  /** The lever refuses the way in and never the way out. */
  it('answers /hide with the switched-off notice while the lever is on, and /unhide and /public still work', async () => {
    const refused = await (async () => {
      paused = true;
      return type('hide');
    })();
    expect(refused.content).toContain('switched off for now');
    paused = false;
    await type('hide');
    paused = true;
    expect((await type('unhide')).content.startsWith('✅')).toBe(true);
    expect((await type('public')).content.startsWith('✅')).toBe(true);
  });

  // -- /access --------------------------------------------------------------------------------

  it('/access trust, block, list, remove and clear reach the live room of the member who typed them', async () => {
    await type('private');
    const trusted = await type('access', { subcommand: 'trust', memberId: CAROL });
    expect(trusted.content).toContain(`<@${CAROL}> is on your trusted list`);
    expect(trusted.content).toContain("I've applied it to your current room.");
    expect(trusted.mentions).toEqual({ parse: [] });
    expect(bits(held(CAROL))).toEqual({ allow: C, deny: 0n });

    voice.put(ROOM, member(MALLORY));
    const blocked = await type('access', { subcommand: 'block', memberId: MALLORY });
    expect(blocked.content).toContain('Administrators can still enter');
    expect(blocked.content).toContain('moved them out of it');
    expect(bits(held(MALLORY))).toEqual({ allow: 0n, deny: VC });
    expect(actions.ofType('move')).toContainEqual(
      expect.objectContaining({ memberId: MALLORY, channelId: null, onlyFrom: ROOM }),
    );
    // The recording fake notes the move but does not apply it, as the real one would have.
    voice.drop(ROOM, MALLORY);

    const listed = await type('access', { subcommand: 'list' });
    expect(listed.content).toContain(`**Trusted** (1 of 25): <@${CAROL}>`);
    expect(listed.content).toContain(`**Blocked** (1 of 25): <@${MALLORY}>`);
    expect(listed.mentions).toEqual({ parse: [] });

    const removed = await type('access', { subcommand: 'remove', memberId: CAROL });
    expect(removed.content).toContain(`<@${CAROL}> is off your trusted list.`);
    expect(held(CAROL)).toBeUndefined();

    const cleared = await type('access', { subcommand: 'clear', list: 'blocked' });
    expect(cleared.content).toContain('Emptied your blocked list (1 person).');
    expect(held(MALLORY)).toBeUndefined();
    expect(await lists.get(GUILD, ALICE)).toEqual({ trusted: [], blocked: [] });
  });

  it('/access admit lets one member into this room only, and refuses an open room and a stranger', async () => {
    const open = await type('access', { subcommand: 'admit', memberId: CAROL });
    expect(open.content).toContain('open to everyone');

    await type('hide');
    const admitted = await type('access', { subcommand: 'admit', memberId: CAROL });
    expect(admitted.content).toContain(`Let <@${CAROL}> into this room.`);
    expect(bits(held(CAROL))).toEqual({ allow: VC, deny: 0n });
    // This room only: nothing was saved on any list.
    expect(await lists.get(GUILD, ALICE)).toEqual({ trusted: [], blocked: [] });

    voice.put(ROOM, member(MALLORY));
    const stranger = await type('access', {
      subcommand: 'admit',
      memberId: CAROL,
      userId: MALLORY,
    });
    expect(stranger.content).toBe('⚠️ Only the room owner can let someone in.');
  });

  it('/access admit says it needs a room, when the member is in none', async () => {
    const none = await type('access', {
      subcommand: 'admit',
      memberId: CAROL,
      voiceChannelId: null,
    });
    expect(none.content).toContain('You need to be in');
  });

  it('refuses to put a bot, or yourself, on a list, and says so', async () => {
    const bot = await type('access', { subcommand: 'trust', memberId: CAROL, memberIsBot: true });
    expect(bot.content).toContain('is a bot');
    const self = await type('access', { subcommand: 'block', memberId: ALICE });
    expect(self.content).toContain("That's you.");
    expect(await lists.get(GUILD, ALICE)).toEqual({ trusted: [], blocked: [] });
  });

  it('refuses /access trust for a member a rule denies Saved lists, and still lets them list and clear', async () => {
    settings = { command_access: { access: { users: [ALICE] } } };
    const refused = await type('access', { subcommand: 'trust', memberId: CAROL });
    expect(refused.content).toContain('A server admin has turned off **Saved lists** for you.');
    expect(await lists.get(GUILD, ALICE)).toEqual({ trusted: [], blocked: [] });
    expect((await type('access', { subcommand: 'list' })).content).toContain('Your saved lists');
    expect((await type('access', { subcommand: 'clear' })).content).toContain('already empty');
  });

  it('a block saved by one member is not applied to a room somebody else created', async () => {
    await secondaries.create({
      channelId: 'room-2',
      guildId: GUILD,
      primaryChannelId: 'p',
      ownerId: CAROL,
      state: { name: 'Carol' },
    });
    await type('access', { subcommand: 'block', memberId: MALLORY });
    expect(
      actions.overwritesOf('room-2').find((o) => o.id === MALLORY && o.type === OVERWRITE_MEMBER),
    ).toBeUndefined();
  });

  it('keeps its role in the member shape the router actually receives', async () => {
    // A member whose roles are a plain list is the raw API shape; the guard must read it.
    settings = { command_access: { access: { roles: [ROLE] } } };
    const refused = await type('access', {
      subcommand: 'trust',
      memberId: CAROL,
      roles: [ROLE],
    });
    expect(refused.content).toContain('Saved lists');
  });
});
