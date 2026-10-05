import {
  DiscordAPIError,
  OverwriteType,
  REST,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import type { Client, GuildMember, VoiceState } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedOverwrite } from './accessPlan.js';
import {
  CHANNEL_OBFUSCATED,
  ChannelObfuscatedError,
  DiscordVoiceActions,
  DiscordVoiceView,
  everyoneViewDenied,
  isPermissionError,
  maskOverwrites,
  normalizeVoiceState,
  withBotAccess,
} from './discordAdapter.js';

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MEMBER = 10007;
const BOT = 'bot-id';
const VIEW = PermissionFlagsBits.ViewChannel;
const MANAGE = PermissionFlagsBits.ManageChannels;
const CONNECT = PermissionFlagsBits.Connect;
const MOVE = PermissionFlagsBits.MoveMembers;
const MANAGE_ROLES = PermissionFlagsBits.ManageRoles;
// A bot with the perms it needs to set overwrites (incl. Manage Roles).
const FULL_BOT_PERMS = VIEW | CONNECT | MANAGE | MOVE | MANAGE_ROLES;

function apiError(code: number, status?: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: 'x' } as never,
    code,
    status ?? (code === UNKNOWN_CHANNEL ? 404 : 403),
    'DELETE',
    'https://discord.test',
    {} as never,
  );
}

const fakeMember = (id = 'u1', permissions = 0n): GuildMember =>
  ({
    id,
    displayName: 'Greg',
    user: { bot: false },
    presence: null,
    roles: { cache: new Map() },
    permissions: new PermissionsBitField(permissions),
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

  /**
   * Whether a rule can apply to them rides in the snapshot, because a saved
   * nickname is judged at render time, where only the snapshot is in hand.
   */
  it('records whether the member can manage channels, which no restriction can stop', () => {
    const memberOf = (permissions: bigint) =>
      normalizeVoiceState(
        voiceState({ channelId: null }),
        voiceState({ channelId: 'b', member: fakeMember('u1', permissions) }),
      )!.member;
    expect(memberOf(MANAGE).canManage).toBe(true);
    expect(memberOf(PermissionFlagsBits.Administrator).canManage).toBe(true);
    expect(memberOf(VIEW).canManage).toBe(false);
    expect(memberOf(0n).canManage).toBe(false);
  });

  /** This runs for every voice state event, so a member it cannot read must not drop one. */
  it('still maps the event, as not exempt, when the member permissions cannot be read', () => {
    const unreadable = { ...fakeMember(), permissions: undefined } as unknown as GuildMember;
    const event = normalizeVoiceState(
      voiceState({ channelId: null }),
      voiceState({ channelId: 'b', member: unreadable }),
    );
    expect(event?.member).toMatchObject({ id: 'u1', canManage: false });
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
    /** Channels Discord shows as the obfuscated shell, because the bot cannot View them. */
    obfuscated: { primary?: boolean; category?: boolean } = {},
  ) {
    const created = { id: 'new', setPosition: vi.fn() };
    const guild = {
      channels: { create: vi.fn().mockResolvedValue(created), cache: new Map() },
      members: { me: { permissions: { bitfield: botPerms } } },
    };
    const primary = {
      id: 'prim',
      isVoiceBased: () => true,
      parent: { id: 'cat' },
      parentId: 'cat',
      rawPosition: 0,
      position: 0,
      permissionOverwrites: overwriteCache(primaryOverwrites),
      ...(obfuscated.primary ? { flags: { bitfield: CHANNEL_OBFUSCATED } } : {}),
      // bottomOfBlock reads the category off the channel's own guild, so this
      // has to be present even for cases that pass no rooms.
      guild,
    };
    const category = {
      permissionOverwrites: overwriteCache(categoryOverwrites),
      ...(obfuscated.category ? { flags: { bitfield: CHANNEL_OBFUSCATED } } : {}),
    };
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

  /**
   * `inheritperms` pointing at a specific channel (`/inheritpermissions <id>`,
   * and 23 auto-channels imported from the legacy dump).
   *
   * The failure this guards is quiet and it is the bad direction: returning no
   * overwrites makes Discord sync the new channel to its category, so a locked
   * primary inside an open category produces an **open** room. Legacy started
   * from the primary's overwrites and only replaced them when the id resolved.
   * 11 of the 23 imported ids are already dead, so the fallback is the common
   * path for them rather than an edge case.
   */
  describe('inheriting from a specific channel id', () => {
    const LOCKED: Row[] = [{ id: 'g1', type: 0, allow: 0n, deny: VIEW }];
    const SOURCE: Row[] = [{ id: 'roleX', type: 0, allow: VIEW, deny: 0n }];

    function clientWithSource(source: unknown) {
      const created = { id: 'new', setPosition: vi.fn() };
      const guild = {
        channels: { create: vi.fn().mockResolvedValue(created), cache: new Map() },
        members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
      };
      const primary = {
        id: 'prim',
        isVoiceBased: () => true,
        guildId: 'g1',
        parent: { id: 'cat' },
        parentId: 'cat',
        rawPosition: 0,
        position: 0,
        permissionOverwrites: overwriteCache(LOCKED),
        // bottomOfBlock reads the category off the channel's own guild.
        guild,
      };
      const client = {
        user: { id: BOT },
        guilds: { fetch: vi.fn().mockResolvedValue(guild) },
        channels: {
          fetch: vi.fn((id: string) => {
            if (id === 'prim') return Promise.resolve(primary);
            if (id === 'cat') return Promise.resolve({ permissionOverwrites: overwriteCache([]) });
            return Promise.resolve(source);
          }),
        },
      } as unknown as Client;
      return { client, guild };
    }

    const create = async (
      client: Client,
      guild: { channels: { create: ReturnType<typeof vi.fn> } },
    ) => {
      await new DiscordVoiceActions(client).createVoiceChannel({
        guildId: 'g1',
        name: 'x',
        nearChannelId: 'prim',
        inheritFrom: '999888777666555444',
      });
      return createArg(guild).permissionOverwrites;
    };

    it('copies the named channel when it resolves in the same guild', async () => {
      const { client, guild } = clientWithSource({
        guildId: 'g1',
        permissionOverwrites: overwriteCache(SOURCE),
      });
      const ow = await create(client, guild);
      expect(ow!.find((o) => o.id === 'roleX')).toBeDefined();
      expect(ow!.find((o) => o.id === 'g1')).toBeUndefined();
    });

    /**
     * A channel id the bot cannot View arrives as a shell, and `/inheritpermissions` takes any
     * id. It is an id that no longer resolves for this purpose, so the primary's own are copied.
     */
    it('falls back to the primary when the channel is an obfuscated shell', async () => {
      const { client, guild } = clientWithSource({
        guildId: 'g1',
        flags: { bitfield: CHANNEL_OBFUSCATED },
        permissionOverwrites: overwriteCache(SOURCE),
      });
      const ow = await create(client, guild);
      expect(ow!.find((o) => o.id === 'roleX')).toBeUndefined();
      expect(ow!.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW);
      expect(ow!.find((o) => o.id === BOT)!.allow & VIEW).toBe(VIEW);
    });

    it('falls back to the primary when the channel is gone', async () => {
      const { client, guild } = clientWithSource(null);
      const ow = await create(client, guild);
      // The primary's @everyone deny, not category sync.
      expect(ow!.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW);
      expect(ow!.find((o) => o.id === BOT)!.allow & VIEW).toBe(VIEW);
    });

    /**
     * Discord, on Create Guild Channel: "Setting MANAGE_ROLES permission in
     * channels is only possible for guild administrators."
     *
     * Not "only if you hold Manage Roles" - only if you are an administrator,
     * which AVC is not and should not be. Copying an overwrite that carries
     * the bit makes Discord reject the ENTIRE create with a bare 403, so one
     * ordinary moderator overwrite silently breaks every room creation in the
     * guild. Dropping the bit degrades one permission on the new room;
     * keeping it means no room at all.
     */
    it('drops Manage Roles from a copied allow, and still creates the channel', async () => {
      const { client, guild } = clientWithSource({
        guildId: 'g1',
        permissionOverwrites: overwriteCache([
          { id: 'mod', type: 0, allow: MANAGE | MANAGE_ROLES, deny: 0n },
        ]),
      });
      const ow = await create(client, guild);
      const mod = ow!.find((o) => o.id === 'mod')!;
      expect(mod.allow & MANAGE_ROLES).toBe(0n);
      expect(mod.allow & MANAGE).toBe(MANAGE); // everything else survives
    });

    /**
     * Deny carries the same restriction, so it gets the same treatment.
     *
     * Note this one fails OPEN: a role denied Manage Permissions on the source
     * keeps whatever it has guild-wide on the new room. Accepted, because the
     * alternative is no room at all, and recorded so it is a known divergence
     * rather than a surprise.
     */
    it('drops Manage Roles from a copied deny', async () => {
      const { client, guild } = clientWithSource({
        guildId: 'g1',
        permissionOverwrites: overwriteCache([
          { id: 'mod', type: 0, allow: 0n, deny: VIEW | MANAGE_ROLES },
        ]),
      });
      const ow = await create(client, guild);
      const mod = ow!.find((o) => o.id === 'mod')!;
      expect(mod.deny & MANAGE_ROLES).toBe(0n);
      expect(mod.deny & VIEW).toBe(VIEW);
    });

    /**
     * The administrator exception, which is the whole reason this is
     * conditional rather than an unconditional strip.
     *
     * Discord allows setting MANAGE_ROLES in an overwrite when the bot is an
     * administrator. A server that has given AVC admin can carry the bit, and
     * dropping it there would quietly remove an inherited permission Discord
     * was willing to grant.
     */
    it('keeps Manage Roles when the bot is an administrator', async () => {
      const { client, guild } = clientWithSource({
        guildId: 'g1',
        permissionOverwrites: overwriteCache([
          { id: 'mod', type: 0, allow: MANAGE | MANAGE_ROLES, deny: 0n },
        ]),
      });
      guild.members.me.permissions.bitfield = FULL_BOT_PERMS | PermissionFlagsBits.Administrator;
      const ow = await create(client, guild);
      expect(ow!.find((o) => o.id === 'mod')!.allow & MANAGE_ROLES).toBe(MANAGE_ROLES);
    });

    /** `client.channels.fetch` is global; legacy used `guild.get_channel`. */
    it('refuses a channel in another guild and falls back to the primary', async () => {
      const { client, guild } = clientWithSource({
        guildId: 'someone-elses-server',
        permissionOverwrites: overwriteCache(SOURCE),
      });
      const ow = await create(client, guild);
      expect(ow!.find((o) => o.id === 'roleX')).toBeUndefined();
      expect(ow!.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW);
    });
  });

  it('snapshots a hidden category for a no-inherit channel (e.g. a primary)', async () => {
    const { client, guild } = makeClient([{ id: 'g1', type: 0, allow: 0n, deny: VIEW }]);
    const actions = new DiscordVoiceActions(client);
    await actions.createVoiceChannel({ guildId: 'g1', name: 'x', nearChannelId: 'prim' });

    const ow = createArg(guild).permissionOverwrites!;
    expect(ow.find((o) => o.id === BOT)!.allow & VIEW).toBe(VIEW); // bot can see/manage
    expect(ow.find((o) => o.id === 'g1')!.deny & VIEW).toBe(VIEW); // others still hidden
  });

  /**
   * Discord's obfuscation (mandatory 2026-11-16) hands the bot a channel it cannot View as a shell
   * whose overwrites are one `@everyone` View deny. Copied, that deny is on every room the creator
   * channel makes: born invisible to everyone, with no error anywhere.
   */
  describe('copying permissions from a channel Discord shows only as an obfuscated shell', () => {
    const SHELL: Row[] = [{ id: 'g1', type: 0, allow: 0n, deny: VIEW }];

    it('does not copy a creator channel that is a shell, and leaves the room to sync', async () => {
      const { client, guild } = makeClient([], SHELL, FULL_BOT_PERMS, { primary: true });
      const logger = { warn: vi.fn() };
      const actions = new DiscordVoiceActions(client, logger as never);
      for (let room = 0; room < 2; room += 1) {
        guild.channels.create.mockClear();
        await actions.createVoiceChannel({
          guildId: 'g1',
          name: 'x',
          nearChannelId: 'prim',
          inheritFrom: 'primary',
        });
        expect(createArg(guild).permissionOverwrites).toBeUndefined();
      }
      // Said once for the channel, not once per room.
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { channelId: 'prim' },
        expect.stringContaining('cannot copy permissions'),
      );
    });

    it('does not snapshot a category that is a shell either', async () => {
      const { client, guild } = makeClient(SHELL, [], FULL_BOT_PERMS, { category: true });
      await new DiscordVoiceActions(client).createVoiceChannel({
        guildId: 'g1',
        name: 'x',
        nearChannelId: 'prim',
      });
      expect(createArg(guild).permissionOverwrites).toBeUndefined();
    });

    it('still copies a creator channel and a category that are not', async () => {
      const { client, guild } = makeClient(SHELL, SHELL);
      await new DiscordVoiceActions(client).createVoiceChannel({
        guildId: 'g1',
        name: 'x',
        nearChannelId: 'prim',
        inheritFrom: 'primary',
      });
      expect(createArg(guild).permissionOverwrites!.find((o) => o.id === 'g1')!.deny & VIEW).toBe(
        VIEW,
      );
    });
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

describe('DiscordVoiceActions.setVoiceStatus (rate-limit probe)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const clientWithRest = (put: unknown): Client => ({ rest: { put } }) as unknown as Client;

  /**
   * The same guard the rename has, applied before Discord needs it to. This
   * runs inside the guild's serial queue, so an unbounded await here is the
   * defect that stalled three guilds on 2026-09-16 (`guildQueue.ts`).
   */
  it('returns rather than waiting when the write outlives the probe window', async () => {
    vi.useFakeTimers();
    const actions = new DiscordVoiceActions(clientWithRest(vi.fn(() => new Promise(() => {}))));
    const pending = actions.setVoiceStatus('g1', 'c1', 'Playing something');
    await vi.advanceTimersByTimeAsync(2600); // past STATUS_PROBE_MS (2500)
    await expect(pending).resolves.toBeUndefined();
  });

  it('waits for a write that lands promptly', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const actions = new DiscordVoiceActions(clientWithRest(put));
    await expect(actions.setVoiceStatus('g1', 'c1', 'x')).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith('/channels/c1/voice-status', { body: { status: 'x' } });
  });

  /**
   * The point of handling the rejection before the race: once the write is
   * deferred this method has returned, so nothing else is left to report a
   * failure that lands minutes later. Asserts the WARNING, which is the part
   * that carries information - `Promise.race` would contain the rejection
   * either way.
   */
  it('still reports a failure that lands after it has returned', async () => {
    vi.useFakeTimers();
    let fail: ((err: unknown) => void) | undefined;
    const warn = vi.fn();
    const logger = { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const actions = new DiscordVoiceActions(
      clientWithRest(vi.fn(() => new Promise((_resolve, reject) => (fail = reject)))),
      logger as never,
    );
    const pending = actions.setVoiceStatus('g1', 'c1', 'x');
    await vi.advanceTimersByTimeAsync(2600);
    await expect(pending).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    fail?.(new Error('429 later'));
    await vi.advanceTimersByTimeAsync(10);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g1', channelId: 'c1' }),
      'failed to set voice channel status',
    );
  });

  it('swallows an unknown channel rather than warning about it', async () => {
    const err = new DiscordAPIError(
      { code: UNKNOWN_CHANNEL, message: 'Unknown Channel' },
      UNKNOWN_CHANNEL,
      404,
      'PUT',
      '',
      {},
    );
    const actions = new DiscordVoiceActions(clientWithRest(vi.fn().mockRejectedValue(err)));
    await expect(actions.setVoiceStatus('g1', 'c1', 'x')).resolves.toBeUndefined();
  });
});

describe('DiscordVoiceActions.renameChannel (deleted vs merely hidden)', () => {
  /**
   * A client that serves the cached fetch from `channel` (as discord.js does) but
   * routes the forced, cache-bypassing re-fetch to `onForce`.
   */
  function clientWithForce(channel: unknown, onForce: () => Promise<unknown>): Client {
    return {
      channels: {
        fetch: vi.fn((_id: string, opts?: { force?: boolean }) =>
          opts?.force ? onForce() : Promise.resolve(channel),
        ),
      },
    } as unknown as Client;
  }

  // Discord answers 50001 for a channel it won't confirm exists, so the edit alone
  // cannot tell "deleted" from "hidden" — only the forced re-fetch can.
  const missingAccess = () => Promise.reject(apiError(50001));

  it('reports channelGone when a forced re-fetch proves the channel is deleted', async () => {
    const channel = { isVoiceBased: () => true, setName: vi.fn(missingAccess) };
    const actions = new DiscordVoiceActions(
      clientWithForce(channel, () => Promise.reject(apiError(UNKNOWN_CHANNEL))),
    );
    await expect(actions.renameChannel('g1', 'c1', 'x')).resolves.toEqual({
      rateLimited: false,
      channelGone: true,
    });
  });

  it('rethrows when the channel is still there — hidden, not deleted', async () => {
    const channel = { isVoiceBased: () => true, setName: vi.fn(missingAccess) };
    const actions = new DiscordVoiceActions(
      clientWithForce(channel, () => Promise.resolve(channel)),
    );
    await expect(actions.renameChannel('g1', 'c1', 'x')).rejects.toBeInstanceOf(DiscordAPIError);
  });

  it('does NOT claim the channel is gone when the re-fetch itself fails', async () => {
    // A timeout or 5xx during an outage is not evidence of deletion. Claiming it
    // would drop a live channel's row, which is much worse than one more retry.
    const channel = { isVoiceBased: () => true, setName: vi.fn(missingAccess) };
    const actions = new DiscordVoiceActions(
      clientWithForce(channel, () => Promise.reject(new Error('ETIMEDOUT'))),
    );
    await expect(actions.renameChannel('g1', 'c1', 'x')).rejects.toBeInstanceOf(DiscordAPIError);
  });
});

describe('DiscordVoiceActions.setPrivacy', () => {
  const everyone = { id: 'g1' };

  function clientWithChannel() {
    const edit = vi.fn().mockResolvedValue(undefined);
    const channel = {
      isVoiceBased: () => true,
      guild: { roles: { everyone } },
      permissionOverwrites: { edit },
    };
    const client = {
      user: { id: BOT },
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
    return { client, edit };
  }

  // Reproduces the prod incident: without this, denying @everyone Connect also
  // denies it to the bot (a member of @everyone), and the very next grant to the
  // room's owner fails with Missing Access.
  it('grants the bot its own access before denying @everyone Connect', async () => {
    const { client, edit } = clientWithChannel();
    await new DiscordVoiceActions(client).setPrivacy('g1', 'c1', true);
    expect(edit).toHaveBeenNthCalledWith(
      1,
      BOT,
      { ViewChannel: true, Connect: true, ManageChannels: true, MoveMembers: true },
      { type: OverwriteType.Member },
    );
    expect(edit).toHaveBeenNthCalledWith(2, everyone, { Connect: false });
  });

  it('going public clears @everyone without touching the bot overwrite', async () => {
    const { client, edit } = clientWithChannel();
    await new DiscordVoiceActions(client).setPrivacy('g1', 'c1', false);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(everyone, { Connect: null });
  });

  it('swallows an Unknown Channel error (idempotent)', async () => {
    const channel = {
      isVoiceBased: () => true,
      guild: { roles: { everyone } },
      permissionOverwrites: { edit: vi.fn().mockRejectedValue(apiError(UNKNOWN_CHANNEL)) },
    };
    const client = {
      user: { id: BOT },
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
    await expect(
      new DiscordVoiceActions(client).setPrivacy('g1', 'c1', true),
    ).resolves.toBeUndefined();
  });
});

/**
 * Discord's CHANNEL_OBFUSCATED flag becomes mandatory on 2026-11-16: a channel the
 * bot cannot View arrives named `___hidden___` with this flag set and a single
 * `@everyone` View deny as its overwrites. Acting on it would target a name that
 * is not real and merge an edit onto an overwrite cache that is a falsehood.
 */
describe('DiscordVoiceActions on an obfuscated channel', () => {
  const obfuscated = (extra: Record<string, unknown> = {}) => ({
    isVoiceBased: () => true,
    flags: { bitfield: CHANNEL_OBFUSCATED },
    name: '___hidden___',
    guild: { roles: { everyone: { id: 'g1' } } },
    ...extra,
  });

  it('counts as a permission error, so lost access is reported not retried', () => {
    expect(isPermissionError(new ChannelObfuscatedError('c1'))).toBe(true);
    expect(isPermissionError(new Error('anything else'))).toBe(false);
  });

  it('refuses to rename it and never calls setName', async () => {
    const setName = vi.fn();
    const actions = new DiscordVoiceActions(clientWith(obfuscated({ setName })));
    await expect(actions.renameChannel('g1', 'c1', 'x')).rejects.toBeInstanceOf(
      ChannelObfuscatedError,
    );
    expect(setName).not.toHaveBeenCalled();
  });

  it('refuses to edit its limit or its overwrites', async () => {
    const edit = vi.fn();
    const setUserLimit = vi.fn();
    const channel = obfuscated({ permissionOverwrites: { edit }, setUserLimit });
    const client = {
      user: { id: BOT },
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as unknown as Client;
    const actions = new DiscordVoiceActions(client);
    await expect(actions.setUserLimit('g1', 'c1', 4)).rejects.toBeInstanceOf(
      ChannelObfuscatedError,
    );
    await expect(actions.setPrivacy('g1', 'c1', true)).rejects.toBeInstanceOf(
      ChannelObfuscatedError,
    );
    await expect(actions.setMemberConnect('g1', 'c1', 'u1', true)).rejects.toBeInstanceOf(
      ChannelObfuscatedError,
    );
    expect(edit).not.toHaveBeenCalled();
    expect(setUserLimit).not.toHaveBeenCalled();
  });

  it('leaves an ordinary channel alone', async () => {
    const setName = vi.fn().mockResolvedValue(undefined);
    const channel = { isVoiceBased: () => true, flags: { bitfield: 0 }, setName };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.renameChannel('g1', 'c1', 'x')).resolves.toEqual({ rateLimited: false });
    expect(setName).toHaveBeenCalledWith('x');
  });
});

describe('DiscordVoiceActions create-time placement', () => {
  /**
   * A category whose voice channels are given in display order. Each entry is
   * `[id, rawPosition]`, and `100` is the primary. `parent` lets a case put a
   * channel in another category.
   *
   * Ids are snowflake-shaped on purpose: the position tie-break is a real
   * `BigInt(id)` comparison, so a readable id like `prim` does not merely read
   * oddly, it throws.
   */
  function makeClient(entries: [string, number, string?][]) {
    const created = { id: 'new', setPosition: vi.fn() };
    const cache = new Map<string, unknown>();
    const guild = {
      channels: {
        // Models the half of Discord that matters here: the new channel really
        // does land on the position the create asked for. Without this the cache
        // never gains the created channel, and `positionCollides` would answer
        // "no collision" for every case regardless of whether one happened.
        create: vi.fn((opts: { position?: number }) => {
          cache.set('new', {
            id: 'new',
            isVoiceBased: () => true,
            parentId: 'cat',
            rawPosition: opts.position ?? 0,
          });
          return Promise.resolve(created);
        }),
        // The other half Discord really does: a bulk reorder writes back the
        // positions it was given, and discord.js patches its own cache from the
        // request it sent (`GuildChannelsPositionUpdate`). Without this, a case
        // that has to make room reads stale positions afterwards.
        setPositions: vi.fn((list: { channel: string; position: number }[]) => {
          for (const { channel, position } of list) {
            const c = cache.get(channel) as { rawPosition: number } | undefined;
            if (c) c.rawPosition = position;
          }
          return Promise.resolve(undefined);
        }),
        cache,
      },
      members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
    };
    for (const [id, rawPosition, parent] of entries) {
      cache.set(id, {
        id,
        isVoiceBased: () => true,
        parentId: parent ?? 'cat',
        parent: { id: parent ?? 'cat' },
        rawPosition,
        position: rawPosition,
        guild,
      });
    }
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild), cache: new Map([['g1', guild]]) },
      channels: {
        fetch: vi.fn((id: string) => Promise.resolve(cache.get(id) ?? null)),
        cache,
      },
    } as unknown as Client;
    return { client, guild, created };
  }
  const positionOf = (guild: { channels: { create: ReturnType<typeof vi.fn> } }) =>
    (guild.channels.create.mock.calls[0][0] as { position?: number }).position;
  /** The one bulk reorder a create had to make to open a slot for itself. */
  const reorderOf = (guild: { channels: { setPositions: ReturnType<typeof vi.fn> } }) =>
    guild.channels.setPositions.mock.calls[0][0] as { channel: string; position: number }[];
  const positionIn = (written: { channel: string; position: number }[], id: string) =>
    written.find((w) => w.channel === id)!.position;

  const create = async (client: Client, afterChannelIds?: string[], above?: boolean) =>
    new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: '100',
      ...(afterChannelIds ? { afterChannelIds } : {}),
      ...(above ? { above } : {}),
    });

  it('takes the free slot below the primary when it has no rooms yet', async () => {
    const { client, guild } = makeClient([['100', 60]]);
    await create(client);
    expect(positionOf(guild)).toBe(61);
  });

  it('makes room rather than tying when the block has drifted shut', async () => {
    // The reported guild: the primary and two rooms tied at 60, the rest given
    // unique positions by an earlier renumber. The slot under the block is taken,
    // so this used to tie at 66 and buy a reorder AFTER the create. Now the
    // category is re-spaced first, in the order it already renders in, and the
    // create lands in the freed slot.
    const { client, guild } = makeClient([
      ['100', 60],
      ['150', 60],
      ['160', 60],
      ['110', 62],
      ['140', 66],
      ['170', 67],
    ]);
    await create(client, ['110', '140', '150', '160']);
    const reorder = reorderOf(guild);
    // Order preserved exactly, which is what makes the re-space invisible.
    expect(reorder.map((r) => r.channel)).toEqual(['100', '150', '160', '110', '140', '170']);
    // The new room lands between the block and the channel that follows it.
    expect(positionOf(guild)).toBeGreaterThan(positionIn(reorder, '140'));
    expect(positionOf(guild)).toBeLessThan(positionIn(reorder, '170'));
  });

  it('stops at a foreign channel instead of anchoring below it', async () => {
    // A room dragged to the bottom of the category, past another creator channel
    // and ITS room. Taking the largest position any room holds would create every
    // future room below that whole block, and nothing would ever undo it.
    const { client, guild } = makeClient([
      ['100', 60],
      ['110', 61],
      ['130', 62],
      ['135', 63],
      ['120', 64],
    ]);
    await create(client, ['110', '120']);
    const reorder = reorderOf(guild);
    expect(reorder.map((r) => r.channel)).toEqual(['100', '110', '130', '135', '120']);
    // Directly under room 110, and still above the foreign channel 130.
    expect(positionOf(guild)).toBeGreaterThan(positionIn(reorder, '110'));
    expect(positionOf(guild)).toBeLessThan(positionIn(reorder, '130'));
  });

  it('walks past a join companion, which is not one of the rooms', async () => {
    // A private room's companion sits directly above it and is not in the list.
    // Stopping there would fall back to the primary position on every join for
    // any guild using private rooms.
    const { client, guild } = makeClient([
      ['100', 60],
      ['115', 61],
      ['110', 62],
      ['120', 63],
    ]);
    await create(client, ['110', '120']);
    expect(positionOf(guild)).toBe(64);
  });

  it('ignores a room that has been moved to another category', async () => {
    const { client, guild } = makeClient([
      ['100', 60],
      ['110', 99, 'other'],
    ]);
    await create(client, ['110']);
    expect(positionOf(guild)).toBe(61);
  });

  it('ignores a room that is no longer in cache', async () => {
    const { client, guild } = makeClient([['100', 60]]);
    await create(client, ['gone']);
    expect(positionOf(guild)).toBe(61);
  });

  it('ties with the last room only when it cannot make room either', async () => {
    // Divider immediately under the block, so there is nowhere unique to land AND
    // the re-space that would open one fails. Falling back to a tie with the room
    // above is what this always did, and positionCollides gets it undone.
    const { client, guild } = makeClient([
      ['100', 60],
      ['110', 61],
      ['170', 62],
    ]);
    guild.channels.setPositions.mockRejectedValueOnce(new Error('nope'));
    await create(client, ['110']);
    expect(positionOf(guild)).toBe(61);
  });

  it('takes the gap a deleted room left rather than tying', async () => {
    const { client, guild } = makeClient([
      ['100', 60],
      ['110', 61],
      ['170', 64],
    ]);
    await create(client, ['110']);
    expect(positionOf(guild)).toBe(62);
  });

  it('creates an above-mode room over the primary, with no reorder at all', async () => {
    // This used to create at the primary's own position - a tie, which renders
    // BELOW it - and then hop the channel up, which is the jump anyone joining an
    // above-mode creator channel could watch happen. Discord honours a free
    // position above an existing channel at create time, so one call does it.
    const { client, guild, created } = makeClient([
      ['090', 30],
      ['100', 60],
    ]);
    await create(client, [], true);
    expect(positionOf(guild)).toBeGreaterThan(30);
    expect(positionOf(guild)).toBeLessThan(60);
    expect(created.setPosition).not.toHaveBeenCalled();
    expect(guild.channels.setPositions).not.toHaveBeenCalled();
  });

  it('takes the middle of an above-mode gap, so the next room still fits', async () => {
    // Every above-mode room inserts into the same shrinking gap between the
    // newest room and the primary. Hugging the primary would leave the next one
    // nowhere at all; the midpoint is what buys more than one.
    const { client, guild } = makeClient([['100', 64]]);
    await create(client, [], true);
    expect(positionOf(guild)).toBe(32);
  });

  it('makes room for an above-mode room when the primary sits at the top', async () => {
    // Discord refuses a negative position outright (400, NUMBER_TYPE_MIN), so a
    // primary at 0 has nowhere above it. Re-spacing first is what opens the slot.
    const { client, guild } = makeClient([['100', 0]]);
    await create(client, [], true);
    expect(guild.channels.setPositions).toHaveBeenCalled();
    expect(positionOf(guild)).toBeGreaterThanOrEqual(0);
    expect(positionOf(guild)).toBeLessThan(positionIn(reorderOf(guild), '100'));
  });

  it('ties with the room above, never with the primary, when it cannot make room', async () => {
    // The degraded above-mode path, and the one assertion that matters on it. The
    // new channel always has the largest snowflake in the guild, so a tie sorts it
    // BELOW its partner: tying with the primary would render the room on the wrong
    // side of its own creator channel, which is the frame this work removes. Tying
    // with the channel above renders correctly, and positionCollides still repairs
    // it either way.
    const { client, guild } = makeClient([
      ['090', 59],
      ['100', 60],
    ]);
    guild.channels.setPositions.mockRejectedValueOnce(new Error('nope'));
    await create(client, [], true);
    expect(positionOf(guild)).toBe(59);
  });

  it('falls back to the primary position when the category cannot be seen', async () => {
    // An unhydrated guild has an empty channel cache, so the primary is not in its
    // own sibling list. Reading that as index 0 would assert the room belongs at
    // the very top of a category we know nothing about, and positionCollides reads
    // the same blind cache so it would not notice.
    const { client, guild } = makeClient([]);
    // `near` resolves (a REST fetch would), but the guild's channel cache is empty.
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: '100',
      isVoiceBased: () => true,
      parentId: 'cat',
      parent: { id: 'cat' },
      rawPosition: 60,
      position: 60,
      guild,
    });
    await create(client, [], true);
    expect(positionOf(guild)).toBe(60);
    expect(guild.channels.setPositions).not.toHaveBeenCalled();
  });

  it('reserves the companion slot on the room ABOVE it when it has to make room', async () => {
    // The private-room case with no gap anywhere. The reserved slot is only any
    // use to the companion if it is on the companion's side of the room.
    const { client, guild } = makeClient([
      ['100', 60],
      ['170', 61],
    ]);
    await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: '100',
      reserveSlotAbove: true,
    });
    const written = reorderOf(guild);
    expect(written.map((w) => w.channel)).toEqual(['100', '170']);
    // Room below the primary, with a clear slot between the two for the companion.
    expect(positionOf(guild)).toBeGreaterThan(positionIn(written, '100') + 1);
    expect(positionOf(guild)).toBeLessThan(positionIn(written, '170'));
  });

  it('leaves the slot above free when a join companion is coming', async () => {
    const { client, guild } = makeClient([
      ['100', 60],
      ['170', 80],
    ]);
    await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: '100',
      reserveSlotAbove: true,
    });
    // One clear position between the primary and the room, for the companion.
    expect(positionOf(guild)).toBeGreaterThan(61);
  });
});

describe('DiscordVoiceActions anchor and inheritance are different channels', () => {
  /**
   * A grouped category positions a room against the group's end creator channel,
   * which is usually not the one the member joined. `nearChannelId` also picks the
   * source for `inheritFrom: 'primary'`, so the two have to be separate inputs:
   * with one field, a room spawned from creator channel B copied A's overwrites,
   * and no test could see it.
   */
  it('positions against the anchor and inherits from the primary', async () => {
    const ROLE = 'role-1';
    const mkChannel = (id: string, rawPosition: number, deny: bigint) => ({
      id,
      isVoiceBased: () => true,
      parentId: 'cat',
      parent: { id: 'cat' },
      rawPosition,
      position: rawPosition,
      permissionOverwrites: {
        cache: new Map([
          [ROLE, { id: ROLE, type: 0, allow: { bitfield: 0n }, deny: { bitfield: deny } }],
        ]),
      },
    });
    const cache = new Map<string, unknown>();
    const guild = {
      channels: {
        create: vi.fn(() => Promise.resolve({ id: 'new' })),
        setPositions: vi.fn().mockResolvedValue(undefined),
        cache,
      },
      members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
    };
    // The joined primary denies Connect; the group's anchor denies View. If the
    // room ends up with the View deny, it inherited from the wrong channel.
    const joined = { ...mkChannel('200', 48, CONNECT), guild };
    const anchor = { ...mkChannel('100', 16, VIEW), guild };
    cache.set('200', joined);
    cache.set('100', anchor);
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild), cache: new Map([['g1', guild]]) },
      channels: { fetch: vi.fn((id: string) => Promise.resolve(cache.get(id) ?? null)), cache },
    } as unknown as Client;

    await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: '200',
      anchorChannelId: '100',
      above: true,
      inheritFrom: 'primary',
    });

    const opts = guild.channels.create.mock.calls[0][0] as {
      position?: number;
      permissionOverwrites?: { id: string; deny: bigint }[];
    };
    // Positioned against the ANCHOR at 16, not the primary at 48.
    expect(opts.position).toBeLessThan(16);
    // ...and carrying the PRIMARY's Connect deny, not the anchor's View deny.
    const rule = opts.permissionOverwrites!.find((o) => o.id === ROLE)!;
    expect(rule.deny & CONNECT).toBe(CONNECT);
    expect(rule.deny & VIEW).toBe(0n);
  });

  it('falls back to the primary when no anchor is given', async () => {
    const { client, guild } = makeClientForAnchorless();
    await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: '100',
    });
    expect((guild.channels.create.mock.calls[0][0] as { position?: number }).position).toBe(17);
  });

  function makeClientForAnchorless() {
    const cache = new Map<string, unknown>();
    const guild = {
      channels: {
        create: vi.fn(() => Promise.resolve({ id: 'new' })),
        setPositions: vi.fn().mockResolvedValue(undefined),
        cache,
      },
      members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
    };
    const chan = {
      id: '100',
      isVoiceBased: () => true,
      parentId: 'cat',
      parent: { id: 'cat' },
      rawPosition: 16,
      position: 16,
      guild,
    };
    cache.set('100', chan);
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild), cache: new Map([['g1', guild]]) },
      channels: { fetch: vi.fn((id: string) => Promise.resolve(cache.get(id) ?? null)), cache },
    } as unknown as Client;
    return { client, guild };
  }
});

describe('DiscordVoiceActions.createJoinChannel', () => {
  /**
   * The companion mover had no test at any level, which is how it kept the
   * create-then-hop shape long after the room's own create stopped needing it.
   */
  const makeClient = (entries: [string, number][]) => {
    const cache = new Map<string, unknown>();
    const guild = {
      id: 'g1',
      channels: {
        create: vi.fn((opts: { position?: number }) =>
          Promise.resolve({ id: 'join', rawPosition: opts.position ?? 0 }),
        ),
        setPositions: vi.fn((list: { channel: string; position: number }[]) => {
          for (const { channel, position } of list) {
            const c = cache.get(channel) as { rawPosition: number } | undefined;
            if (c) c.rawPosition = position;
          }
          return Promise.resolve(undefined);
        }),
        cache,
      },
    };
    for (const [id, rawPosition] of entries) {
      cache.set(id, {
        id,
        isVoiceBased: () => true,
        parentId: 'cat',
        parent: { id: 'cat' },
        rawPosition,
        position: rawPosition,
        guild,
      });
    }
    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
      channels: { fetch: vi.fn((id: string) => Promise.resolve(cache.get(id) ?? null)) },
    } as unknown as Client;
    return { client, guild };
  };
  const positionOf = (guild: { channels: { create: ReturnType<typeof vi.fn> } }) =>
    (guild.channels.create.mock.calls[0][0] as { position?: number }).position;

  it('lands strictly above the room it fronts', async () => {
    const { client, guild } = makeClient([
      ['100', 16],
      ['110', 32],
    ]);
    await new DiscordVoiceActions(client).createJoinChannel('g1', 'join', '110');
    expect(positionOf(guild)).toBeGreaterThan(16);
    expect(positionOf(guild)).toBeLessThan(32);
  });

  it('takes a slot the room reserved for it, with no reorder', async () => {
    // The room was created with `reserveSlotAbove`, so 62 is free and the
    // companion costs one call.
    const { client, guild } = makeClient([
      ['100', 61],
      ['110', 63],
    ]);
    await new DiscordVoiceActions(client).createJoinChannel('g1', 'join', '110');
    expect(positionOf(guild)).toBe(62);
    expect(guild.channels.setPositions).not.toHaveBeenCalled();
  });

  it('makes room when the slot above the room is taken', async () => {
    const { client, guild } = makeClient([
      ['100', 61],
      ['110', 62],
    ]);
    await new DiscordVoiceActions(client).createJoinChannel('g1', 'join', '110');
    expect(guild.channels.setPositions).toHaveBeenCalled();
    const written = guild.channels.setPositions.mock.calls[0][0] as {
      channel: string;
      position: number;
    }[];
    // Order preserved, so the re-space itself is invisible.
    expect(written.map((w) => w.channel)).toEqual(['100', '110']);
    expect(positionOf(guild)).toBeGreaterThan(written[0]!.position);
    expect(positionOf(guild)).toBeLessThan(written[1]!.position);
  });

  it('works for a room in the middle of a block', async () => {
    // `/private` on a room with elders above it and younger rooms below.
    const { client, guild } = makeClient([
      ['100', 16],
      ['110', 32],
      ['120', 48],
      ['130', 64],
    ]);
    await new DiscordVoiceActions(client).createJoinChannel('g1', 'join', '120');
    expect(positionOf(guild)).toBeGreaterThan(32);
    expect(positionOf(guild)).toBeLessThan(48);
  });
});

describe('DiscordVoiceView.displayOrderOf', () => {
  const view = (entries: [string, number][]) => {
    const cache = new Map<string, unknown>();
    for (const [id, rawPosition] of entries) {
      cache.set(id, { id, isVoiceBased: () => true, rawPosition });
    }
    return new DiscordVoiceView({ channels: { cache } } as unknown as Client);
  };

  it('sorts by position, then by id', async () => {
    // This is the sort Discord documents and the one our own reasoning uses. It is
    // NOT what a client was measured doing with a tie (a tied trio rendered 10, 9,
    // 11), which is why placement goes out of its way to avoid ties rather than
    // relying on this, and why `positionCollides` is a separate question.
    const v = view([
      ['300', 60],
      ['100', 60],
      ['200', 59],
    ]);
    expect(v.displayOrderOf(['300', '100', '200'])).toEqual(['200', '100', '300']);
  });

  it('drops ids it cannot see rather than guessing at them', async () => {
    const v = view([['100', 1]]);
    expect(v.displayOrderOf(['100', 'missing'])).toEqual(['100']);
  });

  it('answers undefined when it knows none of them', async () => {
    expect(view([]).displayOrderOf(['a', 'b'])).toBeUndefined();
  });
});

describe('DiscordVoiceView.voicePropertiesOf', () => {
  it('reads bitrate/region/video-quality/nsfw off a cached voice channel', () => {
    const cache = new Map<string, unknown>([
      [
        '100',
        {
          id: '100',
          isVoiceBased: () => true,
          bitrate: 96000,
          rtcRegion: 'us-east',
          videoQualityMode: 2,
          nsfw: true,
        },
      ],
    ]);
    const v = new DiscordVoiceView({ channels: { cache } } as unknown as Client);
    expect(v.voicePropertiesOf('100')).toEqual({
      bitrate: 96000,
      rtcRegion: 'us-east',
      videoQualityMode: 2,
      nsfw: true,
    });
  });

  it('answers undefined for an unknown or non-voice channel', () => {
    const cache = new Map<string, unknown>([['t1', { id: 't1', isVoiceBased: () => false }]]);
    const v = new DiscordVoiceView({ channels: { cache } } as unknown as Client);
    expect(v.voicePropertiesOf('t1')).toBeUndefined();
    expect(v.voicePropertiesOf('missing')).toBeUndefined();
  });
});

describe('DiscordVoiceView.ownerAccessOf', () => {
  const GUILD = '900';
  const member = (roleIds: string[], permissions: bigint) => ({
    roles: { cache: new Map(roleIds.map((id) => [id, {}])) },
    permissions: new PermissionsBitField(permissions),
  });
  // `roomPermissions` is what the room's own overwrites give a member, which is
  // what `GuildChannel.permissionsFor` answers and which can differ from the
  // member's guild-wide permissions. It answers null for a member it cannot resolve.
  const viewWith = (
    members: Record<string, unknown>,
    roomPermissions: (id: string) => bigint | null = () => null,
  ) => {
    const guild = { id: GUILD, members: { cache: new Map(Object.entries(members)) } };
    const room = {
      id: 'room',
      guild,
      permissionsFor: (m: { id: string }) => {
        const bits = roomPermissions(m.id);
        return bits === null ? null : new PermissionsBitField(bits);
      },
    };
    const cache = new Map<string, unknown>([['room', room]]);
    return new DiscordVoiceView({ channels: { cache } } as unknown as Client);
  };

  /**
   * `@everyone`'s id is the guild id and is in every member's `roles.cache`, so a
   * stored rule naming it would deny the whole server. It is dropped here as well
   * as in the reader.
   */
  it("reads the owner's roles without @everyone, and whether they can manage channels", () => {
    const v = viewWith({ u1: member([GUILD, 'r1', 'r2'], VIEW) });
    expect(v.ownerAccessOf('room', 'u1')).toEqual({
      userId: 'u1',
      roleIds: ['r1', 'r2'],
      canManage: false,
    });
  });

  it('reports Manage Channels and Administrator as able to manage', () => {
    const v = viewWith({
      mod: member([GUILD], MANAGE),
      admin: member([GUILD], PermissionFlagsBits.Administrator),
    });
    expect(v.ownerAccessOf('room', 'mod')!.canManage).toBe(true);
    expect(v.ownerAccessOf('room', 'admin')!.canManage).toBe(true);
  });

  /**
   * A moderator whose Manage Channels comes from the voice category or a room
   * overwrite has it only at channel level, and the command guard (which reads the
   * interaction's own channel-level permissions) lets them through, so the panel
   * has to agree and keep their buttons.
   */
  it('counts Manage Channels held only through the room, as the guard does', () => {
    const v = viewWith(
      {
        mod: { id: 'mod', ...member([GUILD], VIEW) },
        plain: { id: 'plain', ...member([GUILD], VIEW) },
      },
      (id) => (id === 'mod' ? MANAGE : VIEW),
    );
    expect(v.ownerAccessOf('room', 'mod')!.canManage).toBe(true);
    expect(v.ownerAccessOf('room', 'plain')!.canManage).toBe(false);
  });

  it('falls back to the guild-wide permissions when the room cannot resolve the member', () => {
    const v = viewWith({ mod: { id: 'mod', ...member([GUILD], MANAGE) } }, () => null);
    expect(v.ownerAccessOf('room', 'mod')!.canManage).toBe(true);
  });

  it('answers undefined, which the panel reads as "cannot say", when it cannot find them', () => {
    const v = viewWith({});
    expect(v.ownerAccessOf('room', 'nobody')).toBeUndefined();
    expect(v.ownerAccessOf('missing-room', 'u1')).toBeUndefined();
    const noGuild = new DiscordVoiceView({
      channels: { cache: new Map([['room', { id: 'room' }]]) },
    } as unknown as Client);
    expect(noGuild.ownerAccessOf('room', 'u1')).toBeUndefined();
  });
});

describe('DiscordVoiceView.memberFacts', () => {
  const GUILD = '900';
  const viewWith = (members: Record<string, unknown>, ownerId = 'the-owner') =>
    new DiscordVoiceView({
      guilds: {
        cache: new Map([
          [GUILD, { id: GUILD, ownerId, members: { cache: new Map(Object.entries(members)) } }],
        ]),
      },
    } as unknown as Client);
  const member = (bot: boolean, permissions: bigint) => ({
    user: { bot },
    permissions: new PermissionsBitField(permissions),
  });

  it('reports a bot, an Administrator and the server owner, each on its own', () => {
    const v = viewWith({
      plain: member(false, VIEW),
      bot: member(true, VIEW),
      admin: member(false, PermissionFlagsBits.Administrator),
      'the-owner': member(false, VIEW),
    });
    expect(v.memberFacts(GUILD, 'plain')).toEqual({
      bot: false,
      administrator: false,
      guildOwner: false,
    });
    expect(v.memberFacts(GUILD, 'bot')).toMatchObject({ bot: true, administrator: false });
    expect(v.memberFacts(GUILD, 'admin')).toMatchObject({ administrator: true, guildOwner: false });
    // The server owner holds every permission without holding the bit, so it is its own fact.
    expect(v.memberFacts(GUILD, 'the-owner')).toMatchObject({
      administrator: false,
      guildOwner: true,
    });
  });

  it('answers undefined, which is "cannot say", for a member or a guild it does not hold', () => {
    const v = viewWith({});
    expect(v.memberFacts(GUILD, 'nobody')).toBeUndefined();
    expect(v.memberFacts('other-guild', 'nobody')).toBeUndefined();
  });
});

describe('DiscordVoiceView.botRoleAccess', () => {
  const GUILD = '900';
  /** Roles by id and position, with the bot holding `held` and the managed one named. */
  const viewWith = (
    positions: Record<string, number>,
    held: string[],
    botRoleId: string | null,
  ) => {
    const roles = new Map(
      Object.entries(positions).map(([id, position]) => [
        id,
        {
          id,
          position,
          comparePositionTo: (other: { position: number }) => position - other.position,
        },
      ]),
    );
    const highest = [...held.map((id) => roles.get(id)!)].sort(
      (a, b) => b.position - a.position,
    )[0];
    const guild = {
      id: GUILD,
      roles: { cache: roles },
      members: {
        me: { roles: { highest, botRole: botRoleId ? roles.get(botRoleId) : null } },
      },
    };
    return new DiscordVoiceView({
      guilds: { cache: new Map([[GUILD, guild]]) },
    } as unknown as Client);
  };

  /**
   * Measured on the dev application on 2026-10-05: a bot with only Manage Channels and
   * Manage Roles wrote View allow and View deny overwrites for a role above its top role
   * and Discord answered 204. A server that gives all its bots one shared role, which
   * is then the bot's own top role, was refused a hide on the strength of the old rule.
   */
  it('reports no role as one it cannot edit, whatever its position', () => {
    const v = viewWith({ low: 1, bots: 5, same: 5, high: 9 }, ['bots'], 'bots');
    expect(v.botRoleAccess(GUILD, ['low', 'same', 'high'])?.uneditableRoleIds).toEqual([]);
  });

  it('reports no role as uneditable when the bot holds a shared role as its top role', () => {
    // The bot's managed role (2) sits below the role every bot in the server shares (7).
    const v = viewWith({ managed: 2, sharedBots: 7 }, ['managed', 'sharedBots'], 'managed');
    expect(v.botRoleAccess(GUILD, ['sharedBots'])).toEqual({
      leaveRoleId: 'managed',
      uneditableRoleIds: [],
    });
  });

  it("names the bot's own managed role, and never calls it uneditable", () => {
    const v = viewWith({ low: 1, bots: 5 }, ['bots'], 'bots');
    expect(v.botRoleAccess(GUILD, ['bots', 'low'])).toEqual({
      leaveRoleId: 'bots',
      uneditableRoleIds: [],
    });
  });

  it('never calls @everyone uneditable, and skips a role it has no record of', () => {
    const v = viewWith({ [GUILD]: 0, bots: 5 }, ['bots'], 'bots');
    expect(v.botRoleAccess(GUILD, [GUILD, 'ghost'])?.uneditableRoleIds).toEqual([]);
  });

  it('answers undefined, which is "cannot say", when the guild or the bot is not cached', () => {
    const v = viewWith({ bots: 5 }, ['bots'], 'bots');
    expect(v.botRoleAccess('other-guild', ['bots'])).toBeUndefined();
    const noMe = new DiscordVoiceView({
      guilds: { cache: new Map([[GUILD, { id: GUILD, members: { me: null } }]]) },
    } as unknown as Client);
    expect(noMe.botRoleAccess(GUILD, ['bots'])).toBeUndefined();
  });
});

describe('DiscordVoiceView.botPermissionsIn', () => {
  const me = { id: 'bot' };
  /** A room whose `permissionsFor` answers what the bot holds there, or null when it cannot. */
  const viewWith = (bits: bigint | null, opts: { voice?: boolean; hasMe?: boolean } = {}) => {
    const room = {
      id: 'room',
      isVoiceBased: () => opts.voice ?? true,
      guild: { members: { me: opts.hasMe === false ? null : me } },
      permissionsFor: (member: unknown) =>
        member === me && bits !== null ? new PermissionsBitField(bits) : null,
    };
    return new DiscordVoiceView({
      channels: { cache: new Map<string, unknown>([['room', room]]) },
    } as unknown as Client);
  };

  it('says whether the bot can edit the room overwrites, as the room resolves it', () => {
    expect(viewWith(VIEW | MANAGE_ROLES).botPermissionsIn('room')).toEqual({ manageRoles: true });
    expect(viewWith(VIEW | MANAGE).botPermissionsIn('room')).toEqual({ manageRoles: false });
  });

  /** Administrator holds every permission, so the check cannot hinge on the bit alone. */
  it('counts Administrator as able to', () => {
    expect(viewWith(PermissionFlagsBits.Administrator).botPermissionsIn('room')).toEqual({
      manageRoles: true,
    });
  });

  it('answers undefined, which is "cannot say", rather than a no it does not know', () => {
    expect(viewWith(null).botPermissionsIn('room')).toBeUndefined();
    expect(viewWith(MANAGE_ROLES, { hasMe: false }).botPermissionsIn('room')).toBeUndefined();
    expect(viewWith(MANAGE_ROLES, { voice: false }).botPermissionsIn('room')).toBeUndefined();
    expect(viewWith(MANAGE_ROLES).botPermissionsIn('missing')).toBeUndefined();
  });

  it('never throws, because it sits in front of a command', () => {
    const throwing = new DiscordVoiceView({
      channels: {
        cache: new Map<string, unknown>([
          [
            'room',
            {
              isVoiceBased: () => true,
              guild: { members: { me } },
              permissionsFor: () => {
                throw new Error('boom');
              },
            },
          ],
        ]),
      },
    } as unknown as Client);
    expect(throwing.botPermissionsIn('room')).toBeUndefined();
  });
});

describe('DiscordVoiceActions.createVoiceChannel bitrate/region/video-quality/nsfw', () => {
  function makeClient(maximumBitrate = 384_000) {
    const created = { id: 'new', setPosition: vi.fn() };
    const guild = {
      maximumBitrate,
      channels: { create: vi.fn().mockResolvedValue(created) },
      members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
    };
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
      channels: { fetch: vi.fn().mockResolvedValue(null) },
    } as unknown as Client;
    return { client, guild };
  }

  it('passes bitrate, region, video-quality and nsfw through to Discord', async () => {
    const { client, guild } = makeClient();
    await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      bitrate: 96000,
      rtcRegion: 'us-east',
      videoQualityMode: 2,
      nsfw: true,
    });
    const arg = guild.channels.create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.bitrate).toBe(96000);
    expect(arg.rtcRegion).toBe('us-east');
    expect(arg.videoQualityMode).toBe(2);
    expect(arg.nsfw).toBe(true);
  });

  it('omits them entirely when unset, so Discord applies its own defaults', async () => {
    const { client, guild } = makeClient();
    await new DiscordVoiceActions(client).createVoiceChannel({ guildId: 'g1', name: 'x' });
    const arg = guild.channels.create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('bitrate');
    expect(arg).not.toHaveProperty('rtcRegion');
    expect(arg).not.toHaveProperty('videoQualityMode');
    expect(arg).not.toHaveProperty('nsfw');
  });

  /**
   * Discord never retroactively clamps an EXISTING channel's bitrate when the
   * guild's boost tier drops, so a primary set to 256kbps while boosted can
   * keep reporting that forever. Copying it verbatim onto a FRESH create
   * would get rejected the moment boosts lapse — silently and permanently,
   * since there is no bot command to fix a primary's bitrate.
   */
  it("clamps a copied bitrate to the guild's current maximum", async () => {
    const { client, guild } = makeClient(96_000); // guild has since dropped to no boost tier
    await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      bitrate: 256_000, // stale value from when the guild was boosted
    });
    const arg = guild.channels.create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.bitrate).toBe(96_000);
  });

  it('retries without the copied properties when they make Discord reject the create', async () => {
    const { client, guild } = makeClient();
    const created = { id: 'new', setPosition: vi.fn() };
    guild.channels.create
      .mockReset()
      .mockRejectedValueOnce(apiError(50035)) // Invalid Form Body, not a permission error
      .mockResolvedValueOnce(created);
    const id = await new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      rtcRegion: 'deprecated-region',
    });
    expect(id).toBe('new');
    expect(guild.channels.create).toHaveBeenCalledTimes(2);
    const secondArg = guild.channels.create.mock.calls[1]![0] as Record<string, unknown>;
    expect(secondArg).not.toHaveProperty('rtcRegion');
    expect(secondArg.name).toBe('x');
  });

  it('does not retry a permission error, and does not retry when nothing was copied', async () => {
    const { client: permClient, guild: permGuild } = makeClient();
    permGuild.channels.create.mockReset().mockRejectedValueOnce(apiError(50013));
    await expect(
      new DiscordVoiceActions(permClient).createVoiceChannel({ guildId: 'g1', name: 'x' }),
    ).rejects.toThrow();
    expect(permGuild.channels.create).toHaveBeenCalledTimes(1);

    const { client: plainClient, guild: plainGuild } = makeClient();
    plainGuild.channels.create.mockReset().mockRejectedValueOnce(apiError(50035));
    await expect(
      new DiscordVoiceActions(plainClient).createVoiceChannel({ guildId: 'g1', name: 'x' }),
    ).rejects.toThrow();
    expect(plainGuild.channels.create).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordVoiceActions.positionCollides', () => {
  const clientWith = (entries: [string, number, string?][]) => {
    const cache = new Map<string, unknown>();
    for (const [id, rawPosition, parent] of entries) {
      cache.set(id, {
        id,
        isVoiceBased: () => true,
        parentId: parent ?? 'cat',
        rawPosition,
      });
    }
    const guild = { channels: { cache } };
    // Cache, not `fetch`: this must answer without any call that could fail.
    return { guilds: { cache: new Map([['g1', guild]]) } } as unknown as Client;
  };

  it('reports a shared position', async () => {
    const client = clientWith([
      ['100', 5],
      ['110', 5],
    ]);
    await expect(new DiscordVoiceActions(client).positionCollides('g1', '110')).resolves.toBe(true);
  });

  it('does not report a position of its own', async () => {
    const client = clientWith([
      ['100', 5],
      ['110', 6],
    ]);
    await expect(new DiscordVoiceActions(client).positionCollides('g1', '110')).resolves.toBe(
      false,
    );
  });

  it('ignores a channel in another category sharing the number', async () => {
    // Positions in two categories are separate number spaces, so an equal value
    // across them is not a collision and must not buy a reorder.
    const client = clientWith([
      ['100', 5, 'other'],
      ['110', 5],
    ]);
    await expect(new DiscordVoiceActions(client).positionCollides('g1', '110')).resolves.toBe(
      false,
    );
  });

  it('answers false for a channel it cannot see', async () => {
    await expect(
      new DiscordVoiceActions(clientWith([])).positionCollides('g1', 'gone'),
    ).resolves.toBe(false);
  });
});

describe('DiscordVoiceActions.repositionSecondaries', () => {
  const guildWith = (entries: [string, number][]) => {
    const cache = new Map<string, unknown>();
    for (const [id, rawPosition] of entries) {
      cache.set(id, { id, isVoiceBased: () => true, parentId: 'cat', rawPosition, name: id });
    }
    const setPositions = vi.fn().mockResolvedValue(undefined);
    const guild = { channels: { cache, setPositions } };
    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;
    return { client, setPositions };
  };

  it('writes strictly increasing positions with a gap between each', async () => {
    // The gap is what lets the NEXT create take a free slot instead of tying.
    // Applied across the whole list, so the block never inverts against the
    // channels either side of it. The rooms start ABOVE the primary here, which
    // is the below-mode block being wrong, so the reorder has work to do.
    const { client, setPositions } = guildWith([
      ['top', 0],
      ['r1', 1],
      ['r2', 2],
      ['prim', 3],
      ['bottom', 4],
    ]);

    await new DiscordVoiceActions(client).repositionSecondaries('g1', 'prim', ['r1', 'r2'], false);

    const written = setPositions.mock.calls[0][0] as { channel: string; position: number }[];
    expect(written.map((w) => w.channel)).toEqual(['top', 'prim', 'r1', 'r2', 'bottom']);
    // The gap has to be wide enough to absorb several creates, not one: at a step
    // of 2 a block with anything below it reorders every other join.
    const gap = written[3]!.position - written[2]!.position;
    expect(gap).toBeGreaterThan(4);
    for (let i = 1; i < written.length; i += 1) {
      expect(written[i]!.position).toBeGreaterThan(written[i - 1]!.position + 1);
    }
    // Never zero, so an above-mode room always has somewhere to be created into.
    expect(written[0]!.position).toBeGreaterThan(0);
  });

  it('writes nothing when the channels already render in this order', async () => {
    // A create lands in its final slot now, so the repair that follows one is
    // usually asking for the order that already holds. Issuing it anyway would
    // spend a REST call per join to change nothing - and, in a grouped category,
    // it is exactly the reorder that used to move the room the member was
    // watching. Spacing is re-established on demand by the next create that
    // actually needs a slot, not by a call on every join.
    const { client, setPositions } = guildWith([
      ['top', 0],
      ['prim', 1],
      ['r1', 2],
      ['r2', 3],
    ]);

    await new DiscordVoiceActions(client).repositionSecondaries('g1', 'prim', ['r1', 'r2'], false);

    expect(setPositions).not.toHaveBeenCalled();
  });

  it('still writes when two channels share a position', async () => {
    // A tie is never "already correct" however close it looks: the client
    // resolves one in an order of its own and Discord eventually makes that
    // resolution permanent.
    const { client, setPositions } = guildWith([
      ['prim', 1],
      ['r1', 2],
      ['r2', 2],
    ]);

    await new DiscordVoiceActions(client).repositionSecondaries('g1', 'prim', ['r1', 'r2'], false);

    expect(setPositions).toHaveBeenCalled();
  });
});

describe('DiscordVoiceActions placement and collision agree', () => {
  /**
   * The two halves of the fix are useless apart: placement avoids a tie where it
   * can, and the collision check is what buys a reorder for the ties it cannot.
   * Each was covered alone, so nothing proved a tie one produces is a tie the
   * other reports. These drive the real class end to end over one cache.
   */
  const clientFor = (entries: [string, number][]) => {
    const cache = new Map<string, unknown>();
    const guild = {
      channels: {
        create: vi.fn((opts: { position?: number }) => {
          const created = {
            id: 'new',
            isVoiceBased: () => true,
            parentId: 'cat',
            rawPosition: opts.position ?? 0,
            setPosition: vi.fn(),
          };
          cache.set('new', created);
          return Promise.resolve(created);
        }),
        cache,
      },
      members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
    };
    for (const [id, rawPosition] of entries) {
      cache.set(id, {
        id,
        isVoiceBased: () => true,
        parentId: 'cat',
        parent: { id: 'cat' },
        rawPosition,
        position: rawPosition,
        guild,
      });
    }
    return {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild), cache: new Map([['g1', guild]]) },
      channels: { fetch: vi.fn((id: string) => Promise.resolve(cache.get(id) ?? null)), cache },
    } as unknown as Client;
  };
  const spawn = (client: Client) =>
    new DiscordVoiceActions(client).createVoiceChannel({
      guildId: 'g1',
      name: 'x',
      nearChannelId: '100',
      afterChannelIds: ['110'],
    });

  it('reports the tie when the category had no free slot', async () => {
    // Divider immediately below the only room, so the create has to tie with it.
    const client = clientFor([
      ['100', 60],
      ['110', 61],
      ['170', 62],
    ]);
    const id = await spawn(client);
    await expect(new DiscordVoiceActions(client).positionCollides('g1', id)).resolves.toBe(true);
  });

  it('reports no tie when the create found a free slot', async () => {
    const client = clientFor([
      ['100', 60],
      ['110', 61],
      ['170', 64],
    ]);
    const id = await spawn(client);
    await expect(new DiscordVoiceActions(client).positionCollides('g1', id)).resolves.toBe(false);
  });
});

describe('DiscordVoiceActions.repositionGroup', () => {
  it('spaces positions the same way repositionSecondaries does', async () => {
    // The same one-line change, on a path whose reorder runs unconditionally.
    const cache = new Map<string, unknown>();
    const add = (id: string, rawPosition: number) =>
      cache.set(id, { id, isVoiceBased: () => true, parentId: 'cat', rawPosition });
    // The room sits above both primaries, which is the group block on the wrong
    // side of them, so the reorder has work to do.
    add('r1', 0);
    add('primA', 1);
    add('primB', 2);
    const setPositions = vi.fn().mockResolvedValue(undefined);
    const guild = { channels: { cache, setPositions } };
    const client = { guilds: { fetch: vi.fn().mockResolvedValue(guild) } } as unknown as Client;

    await new DiscordVoiceActions(client).repositionGroup('g1', ['primA', 'primB'], ['r1'], false);

    const written = setPositions.mock.calls[0][0] as { channel: string; position: number }[];
    expect(written.map((w) => w.channel)).toEqual(['primA', 'primB', 'r1']);
    const steps = written.slice(1).map((w, i) => w.position - written[i]!.position);
    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).toBeGreaterThan(4);
    expect(written[0]!.position).toBeGreaterThan(0);
  });

  it('writes nothing when the group block is already where it belongs', async () => {
    // The third jump in the recording: a grouped create reordered the whole
    // category after the member had been moved in. The create places the room
    // correctly now, so there is nothing left for this to do.
    const cache = new Map<string, unknown>();
    const add = (id: string, rawPosition: number) =>
      cache.set(id, { id, isVoiceBased: () => true, parentId: 'cat', rawPosition });
    add('primA', 16);
    add('primB', 32);
    add('r1', 48);
    const setPositions = vi.fn().mockResolvedValue(undefined);
    const guild = { channels: { cache, setPositions } };
    const client = { guilds: { fetch: vi.fn().mockResolvedValue(guild) } } as unknown as Client;

    await new DiscordVoiceActions(client).repositionGroup('g1', ['primA', 'primB'], ['r1'], false);

    expect(setPositions).not.toHaveBeenCalled();
  });
});

describe('DiscordVoiceActions spacing headroom', () => {
  /**
   * The point of spacing is how many creates a category absorbs before it has to
   * reorder again, so this drives the REAL reorder and then creates into what it
   * wrote. A fixture with hand-picked positions would pass at any step and prove
   * nothing about the value actually shipped.
   */
  it('a reorder leaves room for several creates before the next tie', async () => {
    const cache = new Map<string, unknown>();
    let seq = 0;
    const guild = {
      channels: {
        create: vi.fn((opts: { position?: number }) => {
          const id = `900${(seq += 1)}`;
          const created = {
            id,
            isVoiceBased: () => true,
            parentId: 'cat',
            rawPosition: opts.position ?? 0,
            position: opts.position ?? 0,
          };
          cache.set(id, created);
          return Promise.resolve(created);
        }),
        setPositions: vi.fn((list: { channel: string; position: number }[]) => {
          for (const { channel, position } of list) {
            const c = cache.get(channel) as { rawPosition: number; position: number };
            c.rawPosition = position;
            c.position = position;
          }
          return Promise.resolve(undefined);
        }),
        cache,
      },
      members: { me: { permissions: { bitfield: FULL_BOT_PERMS } } },
    };
    const put = (id: string, rawPosition: number) =>
      cache.set(id, {
        id,
        isVoiceBased: () => true,
        parentId: 'cat',
        parent: { id: 'cat' },
        rawPosition,
        position: rawPosition,
        guild,
      });
    // Dense, which is how a category looks after discord.js renumbers one.
    put('100', 0);
    put('110', 1);
    put('170', 2);
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild), cache: new Map([['g1', guild]]) },
      channels: { fetch: vi.fn((id: string) => Promise.resolve(cache.get(id) ?? null)), cache },
    } as unknown as Client;

    const actions = new DiscordVoiceActions(client);
    await actions.repositionSecondaries('g1', '100', ['110'], false);

    const rooms = ['110'];
    let free = 0;
    for (let i = 0; i < 20; i += 1) {
      const id = await actions.createVoiceChannel({
        guildId: 'g1',
        name: 'x',
        nearChannelId: '100',
        afterChannelIds: [...rooms],
      });
      if (await actions.positionCollides('g1', id)) break;
      rooms.push(id);
      free += 1;
    }
    // A step of 2 would absorb exactly one, which is barely better than none.
    expect(free).toBeGreaterThanOrEqual(5);
  });
});

/**
 * A voice room's overwrites on the Map-backed fake the companion tests use: the
 * writes land in a Map, and the cache the adapter reads is built from it, so what
 * the adapter wrote is what it reads back rather than whatever a mock says.
 */
describe('DiscordVoiceActions room overwrites', () => {
  const GUILD = 'g1';
  const ROOM = 'room-1';
  const SPEAK = PermissionFlagsBits.Speak;
  const VC = VIEW | CONNECT;

  const role = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
    id,
    type: OverwriteType.Role,
    allow,
    deny,
  });
  const person = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
    id,
    type: OverwriteType.Member,
    allow,
    deny,
  });
  const botOverwrite = person(BOT, VIEW | CONNECT | MANAGE | MOVE);
  const everyone = (allow = 0n, deny = 0n) => role(GUILD, allow, deny);

  const keyOf = (o: { id: string; type: number }) => `${o.type}:${o.id}`;
  const asMap = (list: readonly ResolvedOverwrite[]) =>
    Object.fromEntries(list.map((o) => [keyOf(o), { allow: o.allow, deny: o.deny }]));

  function makeRoom(
    initial: ResolvedOverwrite[] = [],
    opts: {
      /** Who Discord says is in the server. */
      inServer?: string[];
      /** Who the guild's member cache holds. */
      cached?: string[];
      flags?: number;
      logger?: unknown;
      /**
       * Members Discord refuses an overwrite for, as the real API would if it
       * refuses ones for somebody who has left. A bulk write is refused when its set
       * NAMES one of them (it resends every overwrite, changed or not), a single
       * write only when it is for one.
       */
      refuses?: string[];
      /** The code those refusals answer with. */
      refusal?: number;
    } = {},
  ) {
    const overwrites = new Map(initial.map((o) => [keyOf(o), { ...o }]));
    const inServer = new Set(opts.inServer ?? ['alice', 'bob', 'carol', 'dave', 'owner']);
    const memberCache = new Map((opts.cached ?? []).map((id) => [id, { id }]));
    const refused = new Set(opts.refuses ?? []);
    const refusal = opts.refusal ?? UNKNOWN_MEMBER;
    const set = vi.fn((list: ResolvedOverwrite[]) => {
      if (list.some((o) => o.type === OverwriteType.Member && refused.has(o.id))) {
        return Promise.reject(apiError(refusal));
      }
      overwrites.clear();
      for (const o of list) overwrites.set(keyOf(o), { ...o });
      return Promise.resolve(undefined);
    });
    const put = vi.fn(
      (
        _route: string,
        options: { body: { id: string; type: number; allow: string; deny: string } },
      ) => {
        const { id, type, allow, deny } = options.body;
        if (type === OverwriteType.Member && refused.has(id)) {
          return Promise.reject(apiError(refusal));
        }
        overwrites.set(`${type}:${id}`, { id, type, allow: BigInt(allow), deny: BigInt(deny) });
        return Promise.resolve(undefined);
      },
    );
    /** The bulk write is a raw PATCH of `permission_overwrites`, answered by the same `set` it always was. */
    const patch = vi.fn(
      (
        _route: string,
        options: {
          body: {
            permission_overwrites: { id: string; type: number; allow: string; deny: string }[];
          };
        },
      ) =>
        set(
          options.body.permission_overwrites.map((o) => ({
            id: o.id,
            type: o.type,
            allow: BigInt(o.allow),
            deny: BigInt(o.deny),
          })),
        ),
    );
    const del = vi.fn((route: string) => {
      const id = route.split('/').pop()!;
      for (const k of [...overwrites.keys()]) if (k.endsWith(`:${id}`)) overwrites.delete(k);
      return Promise.resolve(undefined);
    });
    const lookup = vi.fn((options: { user: string[]; time?: number }) =>
      Promise.resolve(
        new Map(options.user.filter((id) => inServer.has(id)).map((id) => [id, { id }])),
      ),
    );
    const roleCache = new Map([
      [GUILD, { id: GUILD }],
      ['mods', { id: 'mods' }],
    ]);
    const guild = {
      id: GUILD,
      members: { cache: memberCache, fetch: lookup },
      roles: { cache: roleCache },
    };
    const cacheShape = (o: ResolvedOverwrite) => ({
      ...o,
      allow: { bitfield: o.allow },
      deny: { bitfield: o.deny },
    });
    const channel = {
      id: ROOM,
      guildId: GUILD,
      guild,
      flags: { bitfield: opts.flags ?? 0 },
      isVoiceBased: () => true,
      permissionOverwrites: {
        cache: { values: () => [...overwrites.values()].map(cacheShape)[Symbol.iterator]() },
        set,
      },
    };
    const fetch = vi.fn((_id: string, _options?: { force?: boolean }) => Promise.resolve(channel));
    const client = {
      user: { id: BOT },
      channels: { fetch, cache: new Map([[ROOM, channel]]) },
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
      rest: { put, delete: del, patch },
    } as unknown as Client;
    return {
      actions: new DiscordVoiceActions(client, opts.logger as never),
      client,
      overwrites,
      set,
      patch,
      put,
      del,
      lookup,
      fetch,
      memberCache,
      guild,
      channel,
    };
  }

  const apply = (
    room: ReturnType<typeof makeRoom>,
    desired: ResolvedOverwrite[],
    previous: ResolvedOverwrite[],
  ) => room.actions.applyOverwrites(GUILD, ROOM, desired, previous);

  describe('readOverwrites', () => {
    it('forces a fresh fetch, because the overwrite cache can lag a channel update', async () => {
      const stale = { ...makeRoom([everyone()]).channel };
      const room = makeRoom([everyone(0n, CONNECT), person('alice', VC)]);
      room.fetch.mockImplementation((_id, options) =>
        Promise.resolve(options?.force ? room.channel : stale),
      );
      const read = await room.actions.readOverwrites(GUILD, ROOM);
      expect(room.fetch).toHaveBeenCalledWith(ROOM, { force: true });
      expect(asMap(read!)).toEqual({
        [`0:${GUILD}`]: { allow: 0n, deny: CONNECT },
        '1:alice': { allow: VC, deny: 0n },
      });
    });

    it('answers with the shape the planner reads: id, type and bigint bits', async () => {
      const room = makeRoom([role('r', VIEW, CONNECT), person('m', SPEAK)]);
      expect(await room.actions.readOverwrites(GUILD, ROOM)).toEqual([
        { id: 'r', type: OverwriteType.Role, allow: VIEW, deny: CONNECT },
        { id: 'm', type: OverwriteType.Member, allow: SPEAK, deny: 0n },
      ]);
    });

    it('answers null for a channel that is gone, rather than an empty set', async () => {
      const room = makeRoom();
      room.fetch.mockRejectedValue(apiError(UNKNOWN_CHANNEL));
      await expect(room.actions.readOverwrites(GUILD, ROOM)).resolves.toBeNull();
    });

    it('answers null for a channel that is not a voice channel', async () => {
      const room = makeRoom();
      room.fetch.mockResolvedValue({ isVoiceBased: () => false } as never);
      await expect(room.actions.readOverwrites(GUILD, ROOM)).resolves.toBeNull();
    });

    it('lets any other failure through, so a room it cannot see is reported and not read as empty', async () => {
      const room = makeRoom();
      room.fetch.mockRejectedValue(apiError(50001));
      await expect(room.actions.readOverwrites(GUILD, ROOM)).rejects.toBeInstanceOf(
        DiscordAPIError,
      );
    });

    it('refuses an obfuscated channel, whose overwrites are a single @everyone deny', async () => {
      const room = makeRoom([everyone(0n, VIEW)], { flags: CHANNEL_OBFUSCATED });
      await expect(room.actions.readOverwrites(GUILD, ROOM)).rejects.toBeInstanceOf(
        ChannelObfuscatedError,
      );
    });

    /**
     * The gateway keeps the cache current, so a cached shell is what Discord last said the bot can
     * see. Asking REST first spends a request, and may answer 403 where the shell would have been
     * recognised, which no caller treats as a room it has lost.
     */
    it('recognises a cached shell without a request, and without waiting for REST to say 403', async () => {
      const room = makeRoom([everyone(0n, VIEW)], { flags: CHANNEL_OBFUSCATED });
      room.fetch.mockRejectedValue(apiError(50001));

      await expect(room.actions.readOverwrites(GUILD, ROOM)).rejects.toBeInstanceOf(
        ChannelObfuscatedError,
      );

      expect(room.fetch).not.toHaveBeenCalled();
    });

    /**
     * discord.js yields no channel for one whose guild it does not hold, after Discord
     * has just confirmed the channel exists. That is not "gone": the caller that
     * drops a room's record on null would drop a live room's.
     */
    it('does not answer null for a channel that exists but whose guild is not held', async () => {
      const room = makeRoom();
      room.fetch.mockResolvedValue(null as never);
      await expect(room.actions.readOverwrites(GUILD, ROOM)).rejects.toThrow(/not held/);
    });

    it("refuses a channel of another guild, whose overwrites are not this room's to plan", async () => {
      const room = makeRoom([everyone()]);
      room.fetch.mockResolvedValue({ ...room.channel, guildId: 'other' } as never);
      await expect(room.actions.readOverwrites(GUILD, ROOM)).rejects.toThrow(/not in/);
    });
  });

  /**
   * What the sweep asks before it asks Discord, so a room that holds what it should costs no
   * request. It must never answer from a cache it cannot trust, because "nothing differs"
   * read from a falsehood would skip a repair.
   */
  describe('cachedOverwrites', () => {
    it('answers from the cache in the planner shape, without a request', () => {
      const room = makeRoom([role('r', VIEW, CONNECT), person('m', SPEAK)]);
      expect(room.actions.cachedOverwrites(GUILD, ROOM)).toEqual([
        { id: 'r', type: OverwriteType.Role, allow: VIEW, deny: CONNECT },
        { id: 'm', type: OverwriteType.Member, allow: SPEAK, deny: 0n },
      ]);
      expect(room.fetch).not.toHaveBeenCalled();
    });

    it('cannot say for a channel that is not cached', () => {
      const room = makeRoom([everyone()]);
      (room.client.channels.cache as unknown as Map<string, unknown>).clear();
      expect(room.actions.cachedOverwrites(GUILD, ROOM)).toBeUndefined();
    });

    it('cannot say for a channel that is not a voice channel', () => {
      const room = makeRoom([everyone()]);
      (room.channel as { isVoiceBased: () => boolean }).isVoiceBased = () => false;
      expect(room.actions.cachedOverwrites(GUILD, ROOM)).toBeUndefined();
    });

    it("cannot say for another guild's channel", () => {
      const room = makeRoom([everyone()]);
      expect(room.actions.cachedOverwrites('other', ROOM)).toBeUndefined();
    });

    it('cannot say for the obfuscated shell, whose overwrites are a single @everyone deny', () => {
      const room = makeRoom([everyone(0n, VIEW)], { flags: CHANNEL_OBFUSCATED });
      expect(room.actions.cachedOverwrites(GUILD, ROOM)).toBeUndefined();
    });
  });

  describe('applyOverwrites', () => {
    const before = [botOverwrite, everyone(), person('owner', CONNECT)];

    it('writes nothing, and asks nobody anything, when nothing differs', async () => {
      const room = makeRoom(before);
      const result = await apply(room, before, before);
      expect(result).toMatchObject({ requests: 0, deferred: false, channelGone: false });
      expect(room.set).not.toHaveBeenCalled();
      expect(room.put).not.toHaveBeenCalled();
      expect(room.del).not.toHaveBeenCalled();
      expect(room.lookup).not.toHaveBeenCalled();
    });

    it('writes ONE change as one request, with the exact bits and not a merge', async () => {
      const room = makeRoom(before);
      const desired = [...before.slice(0, 2), person('owner', VC | SPEAK)];
      const result = await apply(room, desired, before);
      expect(room.put).toHaveBeenCalledTimes(1);
      expect(room.put).toHaveBeenCalledWith(`/channels/${ROOM}/permissions/owner`, {
        body: {
          id: 'owner',
          type: OverwriteType.Member,
          allow: (VC | SPEAK).toString(),
          deny: '0',
        },
      });
      expect(room.set).not.toHaveBeenCalled();
      expect(result.requests).toBe(1);
    });

    it('writes TWO changes as two requests, the bot first', async () => {
      const room = makeRoom([everyone(), person('owner', CONNECT)]);
      const desired = [everyone(0n, CONNECT), person('owner', CONNECT), botOverwrite];
      const result = await apply(room, desired, [everyone(), person('owner', CONNECT)]);
      expect(room.put.mock.calls.map(([route]) => route)).toEqual([
        `/channels/${ROOM}/permissions/${BOT}`,
        `/channels/${ROOM}/permissions/${GUILD}`,
      ]);
      expect(room.set).not.toHaveBeenCalled();
      expect(result.requests).toBe(2);
    });

    it('writes MANY changes as ONE bulk request carrying the whole set, and no single write', async () => {
      const previous = [everyone(), person('human', SPEAK)];
      const desired = [
        everyone(0n, VC),
        person('human', SPEAK),
        botOverwrite,
        person('owner', VC),
        person('alice', VC),
        person('bob', VC),
      ];
      const room = makeRoom(previous);
      const result = await apply(room, desired, previous);
      expect(room.set).toHaveBeenCalledTimes(1);
      // The WHOLE set, so a human's overwrite on the channel is not dropped.
      expect(asMap(room.set.mock.calls[0]![0])).toEqual(asMap(desired));
      expect(room.put).not.toHaveBeenCalled();
      expect(result.requests).toBe(1);
      expect(asMap([...room.overwrites.values()])).toEqual(asMap(desired));
    });

    it('leaves the channel as it was when Discord refuses every write', async () => {
      const previous = [everyone()];
      const room = makeRoom(previous);
      room.set.mockRejectedValue(apiError(50013));
      room.put.mockRejectedValue(apiError(50013));
      const desired = [everyone(0n, VC), botOverwrite, person('owner', VC), person('alice', VC)];
      await expect(apply(room, desired, previous)).rejects.toBeInstanceOf(DiscordAPIError);
      expect(room.set).toHaveBeenCalledTimes(1);
      // The fallback stops at the first refusal, which is the bot's own overwrite.
      expect(room.put).toHaveBeenCalledTimes(1);
      expect(asMap([...room.overwrites.values()])).toEqual(asMap(previous));
    });

    /** Three is the first count that is a bulk write: one or two are single requests. */
    it.each([
      ['three upserts', [person('a', VC), person('b', VC), person('c', VC)], []],
      ['two upserts and a delete', [person('a', VC), person('b', VC)], [person('old', SPEAK)]],
      [
        'an upsert and two deletes',
        [person('a', VC)],
        [person('old', SPEAK), person('older', SPEAK)],
      ],
    ])('sends %s as one bulk request and no single write', async (_name, adds, removes) => {
      const previous = [botOverwrite, ...removes];
      const room = makeRoom(previous, { inServer: ['a', 'b', 'c'] });
      const result = await apply(room, [botOverwrite, ...adds], previous);
      expect(room.set).toHaveBeenCalledTimes(1);
      expect(room.put).not.toHaveBeenCalled();
      expect(room.del).not.toHaveBeenCalled();
      expect(result.requests).toBe(1);
    });

    /**
     * @discordjs/rest decides a request belongs behind a rate-limited rename by whether its body
     * HAS a `name` or `topic` key, and discord.js builds every channel edit from a literal that
     * holds both. So `permissionOverwrites.set` waited out a rename's 429, for as long as ten
     * minutes, and a hide sat there while the room stayed visible. The bulk write is a raw PATCH
     * of `permission_overwrites` alone.
     */
    describe('the bulk write and a rename that is rate limited', () => {
      const CHANNEL = '123456789012345678';
      const MEMBERS = ['223456789012345678', '323456789012345678', '423456789012345678'];

      it('is one raw PATCH with only the overwrites in its body, and never a discord.js edit', async () => {
        const previous = [botOverwrite];
        const room = makeRoom(previous, { inServer: MEMBERS });
        const desired = [botOverwrite, ...MEMBERS.map((id) => person(id, VC))];

        await apply(room, desired, previous);

        expect(room.patch).toHaveBeenCalledTimes(1);
        const [route, options] = room.patch.mock.calls[0]!;
        expect(route).toBe(`/channels/${ROOM}`);
        expect(Object.keys(options.body)).toEqual(['permission_overwrites']);
        expect(options.body.permission_overwrites).toHaveLength(desired.length);
        for (const o of options.body.permission_overwrites) {
          expect(typeof o.allow).toBe('string');
          expect(typeof o.deny).toBe('string');
        }
      });

      /**
       * Against the real request handler, with a rename answered by a 429 and nothing mocked of
       * the queueing. The control is the other shape: if a library upgrade stops parking it, the
       * reason for the raw call is gone and this should say so.
       */
      it('goes straight through while a rename waits out its 429, and the shape discord.js sends does not', async () => {
        const headers = {
          'content-type': 'application/json',
          'x-ratelimit-limit': '10',
          'x-ratelimit-remaining': '9',
          'x-ratelimit-reset-after': '10',
          'x-ratelimit-bucket': 'channel-edit',
        };
        const sentAt = new Map<string, number>();
        let renames = 0;
        const started = Date.now();
        const rest = new REST({
          version: '10',
          makeRequest: ((_url: string, init: { method: string; body?: string }) => {
            const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
            const kind =
              typeof body.name === 'string'
                ? 'rename'
                : 'permission_overwrites' in body
                  ? 'overwrites'
                  : 'other';
            if (kind !== 'other') sentAt.set(`${kind}${sentAt.size}`, Date.now() - started);
            if (kind === 'rename' && ++renames === 2) {
              return Promise.resolve(
                new Response('{"message":"You are being rate limited.","retry_after":0.4}', {
                  status: 429,
                  headers: { ...headers, 'retry-after': '0.4' },
                }),
              );
            }
            return Promise.resolve(new Response('{}', { status: 200, headers }));
          }) as never,
        });
        rest.setToken('token');
        const route = `/channels/${CHANNEL}` as const;
        await rest.patch(route, { body: { name: 'warm' } });

        const previous = [botOverwrite];
        const room = makeRoom(previous, { inServer: MEMBERS });
        room.channel.id = CHANNEL;
        (room.client as unknown as { rest: unknown }).rest = rest;
        const desired = [botOverwrite, ...MEMBERS.map((id) => person(id, VC))];

        // The second rename draws the 429 and the library sleeps on it.
        const rename = rest.patch(route, { body: { name: 'x' } });
        await new Promise((resolve) => setTimeout(resolve, 40));
        const before = Date.now();
        await room.actions.applyOverwrites(GUILD, CHANNEL, desired, previous);
        const applied = Date.now() - before;
        const control = rest.patch(route, { body: { name: undefined, permission_overwrites: [] } });
        const controlStarted = Date.now();
        await Promise.all([rename, control]);

        expect(applied).toBeLessThan(250);
        // The overwrites were sent at once, ahead of the rename that retried after its wait.
        const sent = [...sentAt.entries()];
        const first = sent.find(([key]) => key.startsWith('overwrites'))!;
        const retried = sent.filter(([key]) => key.startsWith('rename')).at(-1)!;
        expect(first[1]).toBeLessThan(retried[1]);
        // And the shape discord.js builds waited for it.
        expect(Date.now() - controlStarted).toBeGreaterThan(150);
      });
    });

    it('sends two changes one by one, whichever kind they are', async () => {
      const previous = [botOverwrite, person('old', SPEAK)];
      const room = makeRoom(previous, { inServer: ['a'] });
      const result = await apply(room, [botOverwrite, person('a', VC)], previous);
      expect(room.set).not.toHaveBeenCalled();
      expect(room.put).toHaveBeenCalledTimes(1);
      expect(room.del).toHaveBeenCalledTimes(1);
      expect(result.requests).toBe(2);
    });

    it('treats an unknown member on a delete as done, as an unknown overwrite is', async () => {
      const previous = [botOverwrite, person('bob', VC)];
      const room = makeRoom(previous);
      room.del.mockRejectedValueOnce(apiError(UNKNOWN_MEMBER));
      await expect(apply(room, [botOverwrite], previous)).resolves.toMatchObject({ requests: 1 });
    });

    /**
     * What Discord checks in an overwrite nobody changed is unverified, and a bulk
     * set resends every one. Writing only what differs checks only that.
     */
    describe('when Discord refuses a bulk write', () => {
      const previous = [botOverwrite, person('departed', 0n, VC)];
      const desired = [
        botOverwrite,
        person('departed', 0n, VC),
        person('owner', VC),
        person('alice', VC),
        person('bob', VC),
      ];

      it('writes the changes one at a time instead, and leaves an unchanged overwrite alone', async () => {
        const room = makeRoom(previous, { refuses: ['departed'] });
        const result = await apply(room, desired, previous);
        expect(room.set).toHaveBeenCalledTimes(1);
        expect(room.put.mock.calls.map(([route]) => route)).toEqual([
          `/channels/${ROOM}/permissions/owner`,
          `/channels/${ROOM}/permissions/alice`,
          `/channels/${ROOM}/permissions/bob`,
        ]);
        expect(room.del).not.toHaveBeenCalled();
        // The departed member's overwrite is still there, as it was.
        expect(asMap([...room.overwrites.values()])).toEqual(asMap(desired));
        expect(result.droppedMemberIds).toEqual([]);
        expect(result.written).toHaveLength(desired.length);
        // Nobody had to be asked: nobody was missing from what was changed.
        expect(room.lookup).toHaveBeenCalledTimes(1);
      });

      it.each([50013, 50035, UNKNOWN_MEMBER, 10013])('does so for a %s too', async (code) => {
        const room = makeRoom(previous, { refuses: ['departed'], refusal: code });
        await expect(apply(room, desired, previous)).resolves.toMatchObject({ channelGone: false });
        expect(room.put).toHaveBeenCalledTimes(3);
      });

      it('is not tried for an error that is not a refusal', async () => {
        const room = makeRoom(previous);
        room.set.mockRejectedValue(new Error('socket hang up'));
        await expect(apply(room, desired, previous)).rejects.toThrow('socket hang up');
        expect(room.put).not.toHaveBeenCalled();
      });

      it('is not tried for a rate limit, which discord.js would have queued', async () => {
        const room = makeRoom(previous);
        room.set.mockRejectedValue(apiError(0, 429));
        await expect(apply(room, desired, previous)).rejects.toBeInstanceOf(DiscordAPIError);
        expect(room.put).not.toHaveBeenCalled();
      });

      it('is not tried for a server error', async () => {
        const room = makeRoom(previous);
        room.set.mockRejectedValue(apiError(0, 502));
        await expect(apply(room, desired, previous)).rejects.toBeInstanceOf(DiscordAPIError);
        expect(room.put).not.toHaveBeenCalled();
      });

      it('still drops a changed member who has gone, when the single write refuses them too', async () => {
        // Cached, so the first check skips them: only the refusal gives them away.
        const room = makeRoom(previous, { refuses: ['ghost'], cached: ['ghost'] });
        const result = await apply(room, [...desired, person('ghost', VC)], previous);
        expect(result.droppedMemberIds).toEqual(['ghost']);
        expect(result.written.map((o) => o.id)).not.toContain('ghost');
        // And the departed member's overwrite, which nobody changed, is not deleted.
        expect(room.del).not.toHaveBeenCalled();
        expect(room.overwrites.has(`1:departed`)).toBe(true);
      });
    });

    it('removes an overwrite with a delete, and treats one that is already gone as done', async () => {
      const previous = [botOverwrite, person('bob', VC)];
      const room = makeRoom(previous);
      room.del.mockRejectedValueOnce(apiError(10009));
      const result = await apply(room, [botOverwrite], previous);
      expect(room.del).toHaveBeenCalledWith(`/channels/${ROOM}/permissions/bob`);
      expect(result.requests).toBe(1);
    });

    it('never sends the obfuscated shell back', async () => {
      const room = makeRoom([everyone(0n, VIEW)], { flags: CHANNEL_OBFUSCATED });
      await expect(
        apply(room, [everyone(0n, VC), botOverwrite], [everyone(0n, VIEW)]),
      ).rejects.toBeInstanceOf(ChannelObfuscatedError);
      expect(room.set).not.toHaveBeenCalled();
      expect(room.put).not.toHaveBeenCalled();
      expect(room.lookup).not.toHaveBeenCalled();
    });

    it('reports a channel that is gone instead of throwing', async () => {
      const room = makeRoom();
      room.fetch.mockRejectedValue(apiError(UNKNOWN_CHANNEL));
      const result = await apply(room, [botOverwrite], []);
      expect(result).toMatchObject({ channelGone: true, requests: 0, written: [] });
    });

    it('reports a channel that is gone when the write itself says so', async () => {
      const room = makeRoom();
      room.put.mockRejectedValue(apiError(UNKNOWN_CHANNEL));
      const result = await apply(room, [botOverwrite], []);
      expect(result.channelGone).toBe(true);
    });

    it('lets any other failure through when it lands inside the probe window', async () => {
      const room = makeRoom();
      room.put.mockRejectedValue(apiError(50013));
      await expect(apply(room, [botOverwrite], [])).rejects.toBeInstanceOf(DiscordAPIError);
    });

    it('does not report a channel that exists, but whose guild is not held, as gone', async () => {
      const room = makeRoom();
      room.fetch.mockResolvedValue(null as never);
      await expect(apply(room, [botOverwrite], [])).rejects.toThrow(/not held/);
    });

    it('refuses to replace the overwrites of a channel in another guild', async () => {
      const room = makeRoom();
      room.fetch.mockResolvedValue({ ...room.channel, guildId: 'other' } as never);
      await expect(apply(room, [botOverwrite], [])).rejects.toThrow(/not in/);
      expect(room.set).not.toHaveBeenCalled();
      expect(room.put).not.toHaveBeenCalled();
    });

    /**
     * A 50001 from a channel read out of the cache may mean deleted as easily as
     * hidden, so Discord is asked before either is believed (as a rename does).
     */
    it('reports a channel gone when a permission error turns out to be a deleted channel', async () => {
      const room = makeRoom();
      room.put.mockRejectedValue(apiError(50001));
      room.fetch.mockImplementation((_id, options) =>
        options?.force ? Promise.reject(apiError(UNKNOWN_CHANNEL)) : Promise.resolve(room.channel),
      );
      await expect(apply(room, [botOverwrite], [])).resolves.toMatchObject({ channelGone: true });
    });

    it('still reports a permission error when the channel is confirmed to exist', async () => {
      const room = makeRoom();
      room.put.mockRejectedValue(apiError(50013));
      await expect(apply(room, [botOverwrite], [])).rejects.toBeInstanceOf(DiscordAPIError);
      expect(room.fetch).toHaveBeenCalledWith(ROOM, { force: true });
    });

    /**
     * The planner always gives the bot its own overwrite, but this is a public seam,
     * and a bulk set that denies @everyone without one shuts the bot out of the room.
     */
    it.each([
      ['no overwrite for the bot', [person('alice', VC)]],
      ['an overwrite that does not give the bot what it needs', [person(BOT, VIEW | CONNECT)]],
      ['one that denies it', [person(BOT, 0n, VIEW)]],
    ])('refuses a set with %s, before it touches Discord', async (_name, desired) => {
      const room = makeRoom();
      await expect(apply(room, desired, [])).rejects.toThrow(/leave the bot out/);
      expect(room.fetch).not.toHaveBeenCalled();
      expect(room.lookup).not.toHaveBeenCalled();
      expect(room.set).not.toHaveBeenCalled();
      expect(room.put).not.toHaveBeenCalled();
    });

    /** The request body is the whole set: a hidden room's guest list and an owner's block list. */
    it('does not let the overwrite set travel in the error it throws', async () => {
      const room = makeRoom();
      const secret = new DiscordAPIError(
        { code: 50013, message: 'x' } as never,
        50013,
        403,
        'PUT',
        'https://discord.test',
        { body: { permission_overwrites: [{ id: 'blocked-user-9999' }] } } as never,
      );
      expect(JSON.stringify(secret)).toContain('blocked-user-9999');
      room.put.mockRejectedValue(secret);
      const thrown = await apply(room, [botOverwrite], []).catch((err: unknown) => err);
      expect(thrown).toBe(secret);
      expect(JSON.stringify(thrown)).not.toContain('blocked-user-9999');
    });

    describe('members who are not in the server', () => {
      const desired = [
        botOverwrite,
        person('owner', VC),
        person('alice', VC),
        person('ghost', VC),
        person('ghost2', 0n, VC),
      ];

      it('asks once about the members the write would add, and leaves out whoever is gone', async () => {
        const room = makeRoom([]);
        const result = await apply(room, desired, []);
        expect(room.lookup).toHaveBeenCalledTimes(1);
        expect(room.lookup.mock.calls[0]![0].user.sort()).toEqual([
          'alice',
          'ghost',
          'ghost2',
          'owner',
        ]);
        expect(result.droppedMemberIds.sort()).toEqual(['ghost', 'ghost2']);
        expect(result.written.map((o) => o.id)).toEqual([BOT, 'owner', 'alice']);
        // Never written, in the bulk set or anywhere else.
        expect(room.set.mock.calls[0]![0].map((o: ResolvedOverwrite) => o.id)).toEqual([
          BOT,
          'owner',
          'alice',
        ]);
      });

      it('bounds the lookup, because discord.js waits two minutes by default', async () => {
        const room = makeRoom([]);
        await apply(room, desired, []);
        expect(room.lookup.mock.calls[0]![0].time).toBeLessThanOrEqual(5000);
      });

      /**
       * A bound per batch is three seconds per hundred members, which at the cap of
       * 900 overwrites is most of half a minute held inside the guild's queue.
       */
      it('bounds every batch together, not each one', async () => {
        vi.useFakeTimers();
        try {
          const many = Array.from({ length: 450 }, (_, i) => person(`m${i}`, VC));
          const room = makeRoom([], { inServer: many.map((o) => o.id) });
          // A gateway that answers, slowly.
          room.lookup.mockImplementation(async (options: { user: string[]; time?: number }) => {
            await vi.advanceTimersByTimeAsync(2000);
            return new Map(options.user.map((id) => [id, { id }]));
          });
          const result = await apply(room, [botOverwrite, ...many], []);
          // The first batch gets all of it, the second what is left, and the rest none.
          expect(room.lookup.mock.calls.map(([o]) => o.time)).toEqual([3000, 1000]);
          // Not asking is not the same as missing: nobody is dropped for it.
          expect(result.droppedMemberIds).toEqual([]);
          expect(result.written).toHaveLength(many.length + 1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('says so, with counts and no ids, when it leaves members out', async () => {
        const info = vi.fn();
        const room = makeRoom([], {
          logger: { warn: vi.fn(), debug: vi.fn(), info, error: vi.fn() },
        });
        await apply(room, desired, []);
        expect(info).toHaveBeenCalledWith(
          { guildId: GUILD, channelId: ROOM, dropped: 2, checked: 4 },
          'leaving out overwrites for members no longer in the server',
        );
        expect(JSON.stringify(info.mock.calls)).not.toContain('ghost');
      });

      it('does not ask about a member the guild cache already holds', async () => {
        const room = makeRoom([], { cached: ['owner', 'alice'] });
        await apply(room, desired, []);
        expect(room.lookup.mock.calls[0]![0].user.sort()).toEqual(['ghost', 'ghost2']);

        const allCached = makeRoom([], { cached: ['owner', 'alice', 'ghost', 'ghost2'] });
        await apply(allCached, desired, []);
        expect(allCached.lookup).not.toHaveBeenCalled();
      });

      it('does not ask about an overwrite that is already there and unchanged', async () => {
        // Discord already accepted it, and a human's overwrite for somebody who has
        // since left is not ours to delete.
        const previous = [person('departed', SPEAK)];
        const room = makeRoom(previous);
        const result = await apply(room, [...previous, botOverwrite], previous);
        expect(room.lookup).not.toHaveBeenCalled();
        expect(result.written.map((o) => o.id)).toEqual(['departed', BOT]);
      });

      it('never asks about, or drops, the bot', async () => {
        // The bot is not in the member list here, as when it has no member record yet.
        const room = makeRoom([], { inServer: [] });
        const result = await apply(room, [botOverwrite], []);
        expect(room.lookup).not.toHaveBeenCalled();
        expect(result.written).toEqual([botOverwrite]);
        expect(result.droppedMemberIds).toEqual([]);
        expect(room.put).toHaveBeenCalledWith(`/channels/${ROOM}/permissions/${BOT}`, {
          body: expect.objectContaining({ id: BOT }),
        });
      });

      it('writes everyone when the lookup itself fails, rather than dropping anyone on a hiccup', async () => {
        const room = makeRoom([]);
        room.lookup.mockRejectedValue(new Error('GuildMembersTimeout'));
        const result = await apply(room, desired, []);
        expect(result.droppedMemberIds).toEqual([]);
        expect(result.written).toHaveLength(desired.length);
      });

      // The cache vouches for the ghosts, so the first check skips them: the stale
      // cache case the refusal exists for. Discord refuses a bulk write that names
      // one, then a single write for one, and only then is anybody asked about.
      const stale = { cached: ['owner', 'alice', 'ghost', 'ghost2'], refuses: ['ghost', 'ghost2'] };

      it('retries once without the member Discord says is gone, when the write answers Unknown Member', async () => {
        const room = makeRoom([], stale);
        const result = await apply(room, desired, []);
        expect(room.set).toHaveBeenCalledTimes(1);
        // The check verifies the members the write changed against Discord, not the cache.
        expect(room.lookup).toHaveBeenCalledTimes(1);
        expect(room.lookup.mock.calls[0]![0].user.sort()).toEqual([
          'alice',
          'ghost',
          'ghost2',
          'owner',
        ]);
        expect(result.droppedMemberIds.sort()).toEqual(['ghost', 'ghost2']);
        expect(result.written.map((o) => o.id)).toEqual([BOT, 'owner', 'alice']);
        // What landed is the set without them.
        expect([...room.overwrites.keys()].sort()).toEqual(
          [`1:${BOT}`, '1:owner', '1:alice'].sort(),
        );
      });

      it('retries on Unknown User too', async () => {
        const room = makeRoom([], { ...stale, refusal: 10013 });
        const result = await apply(room, desired, []);
        expect(result.droppedMemberIds.sort()).toEqual(['ghost', 'ghost2']);
      });

      it('retries on an Invalid Form Body, but takes the cache at its word', async () => {
        // A less specific refusal: the members the cache holds are not asked about,
        // so this one finds nobody missing and the refusal stands.
        const room = makeRoom([], { ...stale, refusal: 50035 });
        await expect(apply(room, desired, [])).rejects.toBeInstanceOf(DiscordAPIError);
        expect(room.lookup).not.toHaveBeenCalled();
      });

      it('finds, on an Invalid Form Body, a member the first check could not', async () => {
        // The first check failed open (a gateway hiccup), so ghost3 was written.
        const room = makeRoom([], { refuses: ['ghost3'], refusal: 50035 });
        room.lookup.mockRejectedValueOnce(new Error('GuildMembersTimeout'));
        const result = await apply(room, [...desired.slice(0, 3), person('ghost3', VC)], []);
        expect(result.droppedMemberIds).toEqual(['ghost3']);
        expect(room.lookup).toHaveBeenCalledTimes(2);
      });

      it('retries a single write too', async () => {
        const room = makeRoom([botOverwrite], { cached: ['ghost'], refuses: ['ghost'] });
        const result = await apply(room, [botOverwrite, person('ghost', VC)], [botOverwrite]);
        expect(result.droppedMemberIds).toEqual(['ghost']);
        expect(result.written).toEqual([botOverwrite]);
      });

      it('leaves alone an overwrite the departed member already had, when its change is refused', async () => {
        // A block on somebody who has left still blocks them if they come back, and
        // the set is a replacement, so leaving it out would delete it.
        const previous = [botOverwrite, person('ghost', SPEAK)];
        const room = makeRoom(previous, { cached: ['ghost'], refuses: ['ghost'] });
        const result = await apply(room, [botOverwrite, person('ghost', 0n, VC)], previous);
        expect(result.droppedMemberIds).toEqual(['ghost']);
        expect(result.written).toEqual(previous);
        expect(room.del).not.toHaveBeenCalled();
        expect(room.overwrites.get('1:ghost')).toMatchObject({ allow: SPEAK, deny: 0n });
      });

      it('leaves alone an overwrite the departed member already had, when the check finds them', async () => {
        const previous = [botOverwrite, person('ghost', SPEAK)];
        const room = makeRoom(previous);
        const result = await apply(room, [botOverwrite, person('ghost', 0n, VC)], previous);
        expect(result.droppedMemberIds).toEqual(['ghost']);
        expect(result.written).toEqual(previous);
        expect(room.put).not.toHaveBeenCalled();
        expect(room.del).not.toHaveBeenCalled();
      });

      it('checks only once, even when another member has gone by the time it would check again', async () => {
        const room = makeRoom([], stale);
        // ghost is missing on the first check and ghost2 would be on the second: a
        // retry that looped would chase them one at a time.
        const without = (gone: string) => (options: { user: string[] }) =>
          Promise.resolve(
            new Map(options.user.filter((id) => id !== gone).map((id) => [id, { id }])),
          );
        room.lookup
          .mockImplementationOnce(without('ghost'))
          .mockImplementationOnce(without('ghost2'));
        await expect(apply(room, desired, [])).rejects.toBeInstanceOf(DiscordAPIError);
        expect(room.lookup).toHaveBeenCalledTimes(1);
      });

      it('rethrows when every member checks out, because then it was not them', async () => {
        const room = makeRoom([], {
          ...stale,
          inServer: ['owner', 'alice', 'ghost', 'ghost2'],
        });
        await expect(apply(room, desired, [])).rejects.toBeInstanceOf(DiscordAPIError);
        expect(room.lookup).toHaveBeenCalledTimes(1);
      });

      it('does not ask anybody about a different error', async () => {
        const room = makeRoom([]);
        room.set.mockRejectedValue(apiError(50013));
        room.put.mockRejectedValue(apiError(50013));
        await expect(apply(room, desired, [])).rejects.toBeInstanceOf(DiscordAPIError);
        expect(room.set).toHaveBeenCalledTimes(1);
        // Only the pre-check asked.
        expect(room.lookup).toHaveBeenCalledTimes(1);
      });

      it('asks in batches of a hundred, the most the gateway accepts', async () => {
        const many = Array.from({ length: 250 }, (_, i) => person(`m${i}`, VC));
        const room = makeRoom([], { inServer: many.map((o) => o.id) });
        await apply(room, [botOverwrite, ...many], []);
        expect(room.lookup.mock.calls.map(([o]) => o.user.length)).toEqual([100, 100, 50]);
      });
    });

    describe('when Discord is rate limiting the channel', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /**
       * Overwrite writes are 10 per 10 seconds per channel and discord.js queues a
       * 429 rather than rejecting it, so an unbounded await here holds the guild's
       * queue for as long as Discord says.
       */
      it('returns deferred rather than waiting when the write outlives the probe window', async () => {
        vi.useFakeTimers();
        const room = makeRoom([]);
        room.set.mockReturnValue(new Promise(() => {}));
        const pending = apply(room, [botOverwrite, person('alice', VC), person('bob', VC)], []);
        await vi.advanceTimersByTimeAsync(2600);
        await expect(pending).resolves.toMatchObject({ deferred: true, requests: 1 });
      });

      it('does not report deferred for a write that lands promptly', async () => {
        vi.useFakeTimers();
        const room = makeRoom([]);
        await expect(apply(room, [botOverwrite], [])).resolves.toMatchObject({ deferred: false });
      });

      it('still reports a failure that lands after it has returned', async () => {
        vi.useFakeTimers();
        let fail: ((err: unknown) => void) | undefined;
        const warn = vi.fn();
        const room = makeRoom([], {
          logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        });
        room.put.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
        const pending = apply(room, [botOverwrite], []);
        await vi.advanceTimersByTimeAsync(2600);
        await expect(pending).resolves.toMatchObject({ deferred: true });
        expect(warn).not.toHaveBeenCalled();

        fail?.(new Error('429 later'));
        await vi.advanceTimersByTimeAsync(10);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ guildId: GUILD, channelId: ROOM }),
          'deferred overwrite write failed',
        );
      });

      it('logs a deferred failure without the overwrite set it carried', async () => {
        vi.useFakeTimers();
        let fail: ((err: unknown) => void) | undefined;
        const warn = vi.fn();
        const room = makeRoom([], {
          logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        });
        room.put.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
        const pending = apply(room, [botOverwrite], []);
        await vi.advanceTimersByTimeAsync(2600);
        await pending;
        fail?.(
          new DiscordAPIError(
            { code: 50013, message: 'x' } as never,
            50013,
            403,
            'PUT',
            'https://discord.test',
            { body: { permission_overwrites: [{ id: 'blocked-user-9999' }] } } as never,
          ),
        );
        await vi.advanceTimersByTimeAsync(10);
        expect(warn).toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('blocked-user-9999');
      });

      it('does not warn about a channel that was deleted while it waited', async () => {
        vi.useFakeTimers();
        let fail: ((err: unknown) => void) | undefined;
        const warn = vi.fn();
        const room = makeRoom([], {
          logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
        });
        room.put.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
        const pending = apply(room, [botOverwrite], []);
        await vi.advanceTimersByTimeAsync(2600);
        await pending;
        fail?.(apiError(UNKNOWN_CHANNEL));
        await vi.advanceTimersByTimeAsync(10);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('roleExists', () => {
    it('is true for a role the guild has', async () => {
      await expect(makeRoom().actions.roleExists(GUILD, 'mods')).resolves.toBe(true);
    });

    it('is false for a role the guild no longer has', async () => {
      await expect(makeRoom().actions.roleExists(GUILD, 'deleted')).resolves.toBe(false);
    });

    it('is false for @everyone, which is never a moderator role', async () => {
      await expect(makeRoom().actions.roleExists(GUILD, GUILD)).resolves.toBe(false);
    });

    it('is true while the role cache is empty, because not knowing is not a reason to withhold a grant', async () => {
      const room = makeRoom();
      room.guild.roles.cache.clear();
      await expect(room.actions.roleExists(GUILD, 'mods')).resolves.toBe(true);
    });
  });
});

describe('DiscordVoiceActions.moveMember', () => {
  function clientFor(
    voice: { channelId: string | null; setChannel: ReturnType<typeof vi.fn> },
    fetchMember?: () => void,
  ): Client {
    const guild = {
      members: {
        fetch: vi.fn(() => {
          fetchMember?.();
          return Promise.resolve({ voice });
        }),
      },
    };
    return { guilds: { fetch: vi.fn().mockResolvedValue(guild) } } as unknown as Client;
  }

  const inVoice = (channelId: string | null) => ({
    channelId,
    setChannel: vi.fn().mockResolvedValue(undefined),
  });

  it('moves a member as it always has when no options are given, and says it did', async () => {
    const voice = inVoice('anywhere');
    const moved = await new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', 'room');
    expect(voice.setChannel).toHaveBeenCalledWith('room');
    expect(moved).toBe(true);
  });

  it('disconnects a member who is still in the room it was told to take them out of', async () => {
    const voice = inVoice('room');
    await new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', null, {
      onlyFrom: 'room',
    });
    expect(voice.setChannel).toHaveBeenCalledWith(null);
  });

  /**
   * A disconnect takes the member out of whichever channel they are in NOW. The
   * block picked them from a cache read that may be seconds old.
   */
  it('does nothing to a member who has moved to another channel, and says nobody was moved', async () => {
    const voice = inVoice('somewhere-else');
    const moved = await new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', null, {
      onlyFrom: 'room',
    });
    expect(voice.setChannel).not.toHaveBeenCalled();
    expect(moved).toBe(false);
  });

  it('does nothing to a member who is not in voice at all', async () => {
    const voice = inVoice(null);
    await new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', null, {
      onlyFrom: 'room',
    });
    expect(voice.setChannel).not.toHaveBeenCalled();
  });

  it('reads their channel after fetching them, not before, so a move that lands meanwhile is seen', async () => {
    const voice = inVoice('room');
    // The gateway updates the voice state while the member fetch is in flight.
    const client = clientFor(voice, () => {
      voice.channelId = 'somewhere-else';
    });
    await new DiscordVoiceActions(client).moveMember('g1', 'u1', null, { onlyFrom: 'room' });
    expect(voice.setChannel).not.toHaveBeenCalled();
  });

  it('swallows 40032, a member who left voice between the check and the move', async () => {
    const voice = inVoice('room');
    voice.setChannel.mockRejectedValue(apiError(40032));
    await expect(
      new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', null, { onlyFrom: 'room' }),
    ).resolves.toBe(false);
    // And for a plain move too: the old callers are not made to throw by it, and the one that
    // cares (a room being made) is told that nobody was moved.
    await expect(
      new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', 'room'),
    ).resolves.toBe(false);
  });

  it('still swallows an unknown member and an unknown channel', async () => {
    for (const code of [10007, UNKNOWN_CHANNEL]) {
      const voice = inVoice('room');
      voice.setChannel.mockRejectedValue(apiError(code));
      await expect(
        new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', 'x'),
      ).resolves.toBe(false);
    }
  });

  it('rethrows anything else, such as a missing permission', async () => {
    const voice = inVoice('room');
    voice.setChannel.mockRejectedValue(apiError(50013));
    await expect(
      new DiscordVoiceActions(clientFor(voice)).moveMember('g1', 'u1', null, { onlyFrom: 'room' }),
    ).rejects.toBeInstanceOf(DiscordAPIError);
  });
});
