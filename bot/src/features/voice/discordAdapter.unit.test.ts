import { DiscordAPIError, OverwriteType, PermissionFlagsBits } from 'discord.js';
import type { Client, GuildMember, VoiceState } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordVoiceActions,
  DiscordVoiceView,
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
      // bottomOfBlock reads the category off the channel's own guild, so this
      // has to be present even for cases that pass no rooms.
      guild,
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
  // room's owner fails with Missing Access -- see AGENTS.md's privacy section.
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
