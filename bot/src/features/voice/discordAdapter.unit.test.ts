import { DiscordAPIError, OverwriteType, PermissionFlagsBits } from 'discord.js';
import type { Client, GuildMember, VoiceState } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordVoiceActions,
  everyoneViewDenied,
  maskOverwrites,
  normalizeVoiceState,
  withBotAccess,
} from './discordAdapter.js';

const UNKNOWN_CHANNEL = 10003;
const BOT = 'bot-id';
const VIEW = PermissionFlagsBits.ViewChannel;
const MANAGE = PermissionFlagsBits.ManageChannels;
const CONNECT = PermissionFlagsBits.Connect;
const MOVE = PermissionFlagsBits.MoveMembers;
const MANAGE_ROLES = PermissionFlagsBits.ManageRoles;
// A bot with the perms it needs to set overwrites (incl. Manage Roles).
const FULL_BOT_PERMS = VIEW | CONNECT | MANAGE | MOVE | MANAGE_ROLES;

function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: 'x' } as never,
    code,
    code === UNKNOWN_CHANNEL ? 404 : 403,
    'DELETE',
    'https://discord.test',
    {} as never,
  );
}

const fakeMember = (id = 'u1'): GuildMember =>
  ({
    id,
    displayName: 'Greg',
    user: { bot: false },
    presence: null,
    roles: { cache: new Map() },
    voice: { streaming: false },
  }) as unknown as GuildMember;

const voiceState = (over: Partial<Record<string, unknown>>): VoiceState =>
  ({
    guild: { id: 'g1' },
    member: fakeMember(),
    channelId: null,
    ...over,
  }) as unknown as VoiceState;

function clientWith(channel: unknown): Client {
  return { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;
}

describe('normalizeVoiceState', () => {
  it('returns undefined without a guild or without a member', () => {
    expect(
      normalizeVoiceState(voiceState({ guild: null }), voiceState({ guild: null })),
    ).toBeUndefined();
    expect(
      normalizeVoiceState(voiceState({ member: null }), voiceState({ member: null })),
    ).toBeUndefined();
  });

  it('maps before/after channel ids and builds the member', () => {
    const event = normalizeVoiceState(
      voiceState({ channelId: 'a' }),
      voiceState({ channelId: 'b' }),
    );
    expect(event).toMatchObject({
      guildId: 'g1',
      beforeChannelId: 'a',
      afterChannelId: 'b',
      member: { id: 'u1', displayName: 'Greg', bot: false },
    });
  });

  it('omits a channel id that is null (join-only / leave-only)', () => {
    const join = normalizeVoiceState(
      voiceState({ channelId: null }),
      voiceState({ channelId: 'b' }),
    );
    expect(join).not.toHaveProperty('beforeChannelId');
    expect(join).toMatchObject({ afterChannelId: 'b' });
  });
});

describe('withBotAccess', () => {
  it('adds a bot member overwrite that grants the perms needed to manage the channel', () => {
    // A "private" category: @everyone denied View — would lock the bot out.
    const inherited = [{ id: 'everyone', type: OverwriteType.Role, allow: 0n, deny: VIEW }];
    const result = withBotAccess(inherited, BOT);
    const botRule = result.find((o) => o.id === BOT && o.type === OverwriteType.Member);
    expect(botRule).toBeDefined();
    expect(botRule!.allow & VIEW).toBe(VIEW);
    expect(botRule!.allow & MANAGE).toBe(MANAGE);
    expect(botRule!.deny & VIEW).toBe(0n);
    // The inherited @everyone deny is preserved (channel stays private to others).
    expect(result.find((o) => o.id === 'everyone')!.deny & VIEW).toBe(VIEW);
  });

  it('amends an existing bot overwrite rather than duplicating it', () => {
    const inherited = [{ id: BOT, type: OverwriteType.Member, allow: 0n, deny: VIEW | MANAGE }];
    const result = withBotAccess(inherited, BOT);
    expect(result.filter((o) => o.id === BOT)).toHaveLength(1);
    expect(result[0]!.allow & VIEW).toBe(VIEW);
    expect(result[0]!.deny & VIEW).toBe(0n); // the View deny is cleared
  });
});

describe('everyoneViewDenied', () => {
  it('detects an @everyone (role id == guild id) View deny', () => {
    expect(everyoneViewDenied([{ id: 'g1', type: 0, allow: 0n, deny: VIEW }], 'g1')).toBe(true);
    expect(everyoneViewDenied([{ id: 'g1', type: 0, allow: 0n, deny: MANAGE }], 'g1')).toBe(false);
    expect(everyoneViewDenied([{ id: 'role', type: 0, allow: 0n, deny: VIEW }], 'g1')).toBe(false);
    expect(everyoneViewDenied([], 'g1')).toBe(false);
  });
});

describe('DiscordVoiceActions.createVoiceChannel', () => {
  const overwriteCache = (rows: { id: string; type: number; allow: bigint; deny: bigint }[]) => ({
    cache: {
      values: () =>
        rows
          .map((r) => ({ ...r, allow: { bitfield: r.allow }, deny: { bitfield: r.deny } }))
          [Symbol.iterator](),
    },
  });

  type Row = { id: string; type: number; allow: bigint; deny: bigint };
  function makeClient(
    categoryOverwrites: Row[],
    primaryOverwrites: Row[] = [],
    botPerms = FULL_BOT_PERMS,
  ) {
    const created = { id: 'new', setPosition: vi.fn() };
    const guild = {
      channels: { create: vi.fn().mockResolvedValue(created) },
      members: { me: { permissions: { bitfield: botPerms } } },
    };
    const primary = {
      isVoiceBased: () => true,
      parent: { id: 'cat' },
      rawPosition: 0,
      position: 0,
      permissionOverwrites: overwriteCache(primaryOverwrites),
    };
    const category = { permissionOverwrites: overwriteCache(categoryOverwrites) };
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
      channels: {
        fetch: vi.fn((id: string) => Promise.resolve(id === 'cat' ? category : primary)),
      },
    } as unknown as Client;
    return { client, guild };
  }
  const createArg = (guild: { channels: { create: ReturnType<typeof vi.fn> } }) =>
    guild.channels.create.mock.calls[0][0] as {
      permissionOverwrites?: { id: string; allow: bigint; deny: bigint }[];
    };

  it('inherits a hidden primary by default and keeps bot access', async () => {
    // No inheritFrom passed by the handler historically meant "category sync"; now
    // the handler defaults to 'primary'. A hidden primary → bot must keep access.
    const hide: Row[] = [{ id: 'g1', type: 0, allow: 0n, deny: VIEW }];
    const { client, guild } = makeClient([], hide);
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: 'prim',
      inheritFrom: 'primary',
    });
    const ow = createArg(guild).permissionOverwrites!;
    expect(ow.find((o) => o.id === BOT)!.allow & VIEW).toBe(VIEW);
    expect(ow.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW);
  });

  it('inherits a public primary with no extra bot overwrite (clean perms)', async () => {
    const { client, guild } = makeClient([], []); // primary has no overwrites
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: 'prim',
      inheritFrom: 'primary',
    });
    expect(createArg(guild).permissionOverwrites).toBeUndefined();
  });

  it('snapshots a hidden category for a no-inherit channel (e.g. a primary)', async () => {
    const { client, guild } = makeClient([{ id: 'g1', type: 0, allow: 0n, deny: VIEW }]);
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({ guildId: 'g1', name: 'x', nearChannelId: 'prim' });

    const ow = createArg(guild).permissionOverwrites!;
    expect(ow.find((o) => o.id === BOT)!.allow & VIEW).toBe(VIEW); // bot can see/manage
    expect(ow.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW); // others still hidden
  });

  it('leaves a public category alone (Discord sync, no explicit overwrites)', async () => {
    const { client, guild } = makeClient([]); // category does not hide itself
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({ guildId: 'g1', name: 'x', nearChannelId: 'prim' });

    expect(createArg(guild).permissionOverwrites).toBeUndefined();
  });

  it('masks exotic overwrite bits the bot lacks but keeps View/Connect + bot access', async () => {
    const exotic = 1n << 40n; // a permission the bot does not hold
    const primaryOverwrites: Row[] = [
      { id: 'g1', type: 0, allow: 0n, deny: VIEW }, // @everyone hidden
      { id: 'muted', type: 0, allow: 0n, deny: exotic | CONNECT }, // exotic + Connect deny
    ];
    const { client, guild } = makeClient([], primaryOverwrites);
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: 'prim',
      inheritFrom: 'primary',
    });
    const ow = createArg(guild).permissionOverwrites!;
    expect(ow.find((o) => o.id === BOT)!.allow & VIEW).toBe(VIEW); // bot kept
    expect(ow.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW); // hidden kept
    const muted = ow.find((o) => o.id === 'muted')!;
    expect(muted.deny & exotic).toBe(0n); // exotic bit the bot lacks is dropped
    expect(muted.deny & CONNECT).toBe(CONNECT); // Connect (the bot has) survives
  });

  it('skips explicit overwrites entirely when the bot lacks Manage Roles', async () => {
    // Without Manage Roles the create can't carry any overwrites (50013); fall back
    // to Discord's sync rather than failing the whole creation.
    const hide: Row[] = [{ id: 'g1', type: 0, allow: 0n, deny: VIEW }];
    const { client, guild } = makeClient([], hide, VIEW | CONNECT | MANAGE | MOVE); // no Manage Roles
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: 'prim',
      inheritFrom: 'primary',
    });
    expect(createArg(guild).permissionOverwrites).toBeUndefined();
  });
});

describe('maskOverwrites', () => {
  it('keeps only bits the bot holds and drops empties', () => {
    const botPerms = VIEW | CONNECT;
    const out = maskOverwrites(
      [
        { id: 'a', type: 0, allow: VIEW | MANAGE, deny: CONNECT },
        { id: 'b', type: 0, allow: MANAGE, deny: 0n }, // becomes empty → dropped
      ],
      botPerms,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', allow: VIEW, deny: CONNECT });
  });
});

describe('DiscordVoiceActions.deleteChannel', () => {
  it('swallows an Unknown Channel error (idempotent)', async () => {
    const channel = {
      isVoiceBased: () => true,
      delete: vi.fn().mockRejectedValue(apiError(UNKNOWN_CHANNEL)),
    };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.deleteChannel('g1', 'c1')).resolves.toBeUndefined();
  });

  it('rethrows any other API error', async () => {
    const channel = {
      isVoiceBased: () => true,
      delete: vi.fn().mockRejectedValue(apiError(50013)),
    };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.deleteChannel('g1', 'c1')).rejects.toBeInstanceOf(DiscordAPIError);
  });
});

describe('DiscordVoiceActions.renameChannel (rate-limit probe)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports rateLimited when the rename outlives the probe window', async () => {
    vi.useFakeTimers();
    const channel = {
      isVoiceBased: () => true,
      setName: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const actions = new DiscordVoiceActions(clientWith(channel));
    const pending = actions.renameChannel('g1', 'c1', 'New name');
    await vi.advanceTimersByTimeAsync(2600); // past RENAME_PROBE_MS (2500)
    await expect(pending).resolves.toEqual({ rateLimited: true });
  });

  it('reports not rate-limited when the rename applies promptly', async () => {
    vi.useFakeTimers();
    const channel = { isVoiceBased: () => true, setName: vi.fn().mockResolvedValue(undefined) };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.renameChannel('g1', 'c1', 'New name')).resolves.toEqual({
      rateLimited: false,
    });
  });

  it('is a no-op for a non-voice channel', async () => {
    const channel = { isVoiceBased: () => false };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.renameChannel('g1', 'c1', 'x')).resolves.toEqual({ rateLimited: false });
  });
});
