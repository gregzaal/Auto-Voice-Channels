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

  it('creates at the bottom of the block once positions have drifted', async () => {
    // The reported guild: the primary and two rooms tied at 60, the rest given
    // unique positions by an earlier renumber. Creating at 60 would land the new
    // room above rooms 1 and 4, which is the bug.
    const { client, guild } = makeClient([
      ['100', 60],
      ['150', 60],
      ['160', 60],
      ['110', 62],
      ['140', 66],
      ['170', 67],
    ]);
    await create(client, ['110', '140', '150', '160']);
    expect(positionOf(guild)).toBe(66);
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
    expect(positionOf(guild)).toBe(61);
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

  it('ties with the last room only when the slot below it is taken', async () => {
    // Divider immediately under the block, so there is nowhere unique to land.
    // The tie is unavoidable here; positionCollides is what gets it undone.
    const { client, guild } = makeClient([
      ['100', 60],
      ['110', 61],
      ['170', 62],
    ]);
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

  it('still creates at the primary position for above, then reorders', async () => {
    // "Above" hops the new channel over the primary by sorted index, which is
    // drift-proof on its own, so the block bottom is not what it wants.
    const { client, guild, created } = makeClient([
      ['100', 60],
      ['110', 66],
    ]);
    await create(client, ['110'], true);
    expect(positionOf(guild)).toBe(60);
    expect(created.setPosition).toHaveBeenCalledWith(60);
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
    // Equal positions are the healthy steady state, and the id tie-break is what
    // makes it render creator-then-oldest-to-newest without any reorder.
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
  it('writes strictly increasing positions with a gap between each', async () => {
    // The gap is what lets the NEXT create take a free slot instead of tying.
    // Applied across the whole list, so the block never inverts against the
    // channels either side of it.
    const cache = new Map<string, unknown>();
    const add = (id: string, rawPosition: number) =>
      cache.set(id, { id, isVoiceBased: () => true, parentId: 'cat', rawPosition, name: id });
    add('top', 0);
    add('prim', 1);
    add('r1', 2);
    add('r2', 3);
    add('bottom', 4);
    const setPositions = vi.fn().mockResolvedValue(undefined);
    const guild = { channels: { cache, setPositions } };
    const client = {
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    } as unknown as Client;

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
    add('primA', 0);
    add('primB', 1);
    add('r1', 2);
    const setPositions = vi.fn().mockResolvedValue(undefined);
    const guild = { channels: { cache, setPositions } };
    const client = { guilds: { fetch: vi.fn().mockResolvedValue(guild) } } as unknown as Client;

    await new DiscordVoiceActions(client).repositionGroup('g1', ['primA', 'primB'], ['r1'], false);

    const written = setPositions.mock.calls[0][0] as { channel: string; position: number }[];
    const steps = written.slice(1).map((w, i) => w.position - written[i]!.position);
    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).toBeGreaterThan(4);
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
