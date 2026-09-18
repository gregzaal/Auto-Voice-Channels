import { DiscordAPIError, OverwriteType, PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { DiscordVoiceActions } from './discordAdapter.js';

const UNKNOWN_CHANNEL = 10003;
const BOT = 'bot-id';
const VIEW = PermissionFlagsBits.ViewChannel;
const MANAGE = PermissionFlagsBits.ManageChannels;

function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: 'x' } as never,
    code,
    403,
    'PATCH',
    'https://discord.test',
    {} as never,
  );
}

/**
 * The companion ACL, which is where this feature's privacy actually lives.
 *
 * Its own file, and tested against a fake discord.js client rather than only
 * through `CompanionTextService`, because the service's recording fake models a
 * set of member ids and nothing else: no `@everyone` deny, no bot overwrite, no
 * role overwrite and no human-added overwrite. Three defects an adversarial
 * review found in this feature lived in these two methods and were invisible to
 * that fake, so a test that only drives the service proves the caller and not
 * the thing that decides who can read a private conversation.
 */
describe('DiscordVoiceActions companion channels', () => {
  const GUILD = 'guild-1';
  /** The `@everyone` role id IS the guild id, which is the whole trap below. */
  const EVERYONE = GUILD;
  const ROOM = 'room-1';

  type Row = { id: string; type: number; allow: bigint; deny: bigint };

  function makeClient(existing: Row[] = []) {
    const overwrites = new Map(existing.map((r) => [r.id, r]));
    const edit = vi.fn((id: string, perms: Record<string, boolean>, opts?: { type?: number }) => {
      overwrites.set(id, {
        id,
        type: opts?.type ?? OverwriteType.Role,
        allow: perms.ViewChannel ? VIEW : 0n,
        deny: 0n,
      });
      return Promise.resolve();
    });
    const del = vi.fn((id: string) => {
      overwrites.delete(id);
      return Promise.resolve();
    });
    // A real `Guild#roles.cache` is a Collection keyed by role id. The fake had
    // only `everyone`, which meant these tests could not distinguish "the role
    // exists" from "we never looked" -- the exact gap that let a deleted role
    // reach production and retry its grant every five minutes.
    const roleCache = new Map<string, { id: string }>([
      [EVERYONE, { id: EVERYONE }],
      ['mods-new', { id: 'mods-new' }],
      ['mods-old', { id: 'mods-old' }],
      // 'mods-gone' is deliberately absent: it is the deleted role.
    ]);
    const guild = {
      id: GUILD,
      roles: { everyone: { id: EVERYONE }, cache: roleCache },
      channels: { create: vi.fn().mockResolvedValue({ id: 'text-1' }) },
    };
    const text = {
      id: 'text-1',
      type: 0,
      guildId: GUILD,
      guild,
      permissionOverwrites: {
        cache: {
          values: () =>
            [...overwrites.values()]
              .map((r) => ({ ...r, allow: { bitfield: r.allow }, deny: { bitfield: r.deny } }))
              [Symbol.iterator](),
          // Wrapped exactly as `values()` wraps, because discord.js returns the
          // same object shape from both and the code reads `.bitfield` either way.
          get: (id: string) => {
            const r = overwrites.get(id);
            return r
              ? { ...r, allow: { bitfield: r.allow }, deny: { bitfield: r.deny } }
              : undefined;
          },
        },
        edit,
        delete: del,
      },
    };
    const room = { id: ROOM, isVoiceBased: () => true, parent: { id: 'cat' }, parentId: 'cat' };
    const client = {
      user: { id: BOT },
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
      channels: { fetch: vi.fn((id: string) => Promise.resolve(id === ROOM ? room : text)) },
    } as unknown as Client;
    return { client, guild, edit, del, overwrites };
  }

  const createArg = (guild: { channels: { create: ReturnType<typeof vi.fn> } }) =>
    guild.channels.create.mock.calls[0]![0] as {
      permissionOverwrites: { id: string; type?: number; allow?: bigint; deny?: bigint }[];
      topic?: string;
    };

  const sync = (
    client: Client,
    memberIds: string[],
    roleId: string | null = null,
  ): Promise<{ added: number; removed: number; channelGone: boolean }> =>
    new DiscordVoiceActions(client).syncCompanionMembers({
      guildId: GUILD,
      channelId: 'text-1',
      memberIds,
      roleId,
    });

  it('hides the channel from @everyone in the create payload itself', async () => {
    const { client, guild } = makeClient();
    await new DiscordVoiceActions(client).createCompanionChannel({
      guildId: GUILD,
      name: 'voice context',
      secondaryChannelId: ROOM,
      memberIds: ['u1'],
      roleId: null,
    });

    const payload = createArg(guild);
    // Inline, so there is no instant in which the server can read it.
    expect(payload.permissionOverwrites.find((o) => o.id === EVERYONE)?.deny).toBe(VIEW);
    expect(payload.permissionOverwrites.find((o) => o.id === 'u1')?.allow).toBe(VIEW);
    expect(payload.permissionOverwrites.find((o) => o.id === BOT)?.allow).toBeTruthy();
  });

  /**
   * A setting naming `@everyone` would grant View to the whole server and undo
   * the deny beside it, publishing every room's chat. Refused at the import
   * validator, at the settings service, and here, which is the one that writes.
   */
  it('refuses to grant @everyone the moderator view, at create', async () => {
    const { client, guild } = makeClient();
    await new DiscordVoiceActions(client).createCompanionChannel({
      guildId: GUILD,
      name: 'voice context',
      secondaryChannelId: ROOM,
      memberIds: [],
      roleId: EVERYONE,
    });

    expect(
      createArg(guild).permissionOverwrites.filter((o) => o.id === EVERYONE && o.allow === VIEW),
    ).toHaveLength(0);
  });

  it('refuses to grant @everyone the moderator view, at sync', async () => {
    const { client, edit } = makeClient([{ id: EVERYONE, type: 0, allow: 0n, deny: VIEW }]);
    await sync(client, [], EVERYONE);
    expect(edit).not.toHaveBeenCalled();
  });

  it('adds joiners, removes leavers, and writes nothing when nothing changed', async () => {
    const { client, edit, del } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: BOT, type: OverwriteType.Member, allow: VIEW | MANAGE, deny: 0n },
      { id: 'u1', type: OverwriteType.Member, allow: VIEW, deny: 0n },
    ]);

    expect(await sync(client, ['u1', 'u2'])).toMatchObject({ added: 1, removed: 0 });

    // Steady state costs no requests, which is what makes this safe per event.
    edit.mockClear();
    del.mockClear();
    expect(await sync(client, ['u1', 'u2'])).toMatchObject({ added: 0, removed: 0 });
    expect(edit).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();

    expect(await sync(client, ['u2'])).toMatchObject({ removed: 1 });
    expect(del).toHaveBeenCalledWith('u1');
  });

  it('never touches the @everyone deny or its own overwrite', async () => {
    const { client, del, overwrites } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: BOT, type: OverwriteType.Member, allow: VIEW | MANAGE, deny: 0n },
    ]);

    await sync(client, []);

    expect(del).not.toHaveBeenCalled();
    expect(overwrites.get(EVERYONE)?.deny).toBe(VIEW);
    expect(overwrites.get(BOT)).toBeDefined();
  });

  /**
   * An overwrite this bot wrote is ViewChannel alone, denying nothing. Anything
   * else is somebody's deliberate grant and is left alone, because Discord
   * records no author for an overwrite and guessing wrong removes a moderator's
   * decision on every voice event.
   */
  it('leaves overwrites a human wrote with different bits alone', async () => {
    const { client, del } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: 'helper', type: OverwriteType.Member, allow: VIEW | MANAGE, deny: 0n },
      { id: 'muted', type: OverwriteType.Member, allow: 0n, deny: VIEW },
    ]);

    await sync(client, []);

    expect(del).not.toHaveBeenCalled();
  });

  /**
   * Adding only was the first version: it left the previous role reading every
   * live room while the confirmation told the admin nobody outside the room
   * could, which is a privacy defect with a false receipt on top.
   */
  it('revokes the previous moderator role when the setting changes, and when it clears', async () => {
    const { client, del, overwrites } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: 'mods-old', type: OverwriteType.Role, allow: VIEW, deny: 0n },
    ]);
    const actions = new DiscordVoiceActions(client);
    const run = (roleId: string | null, previousRoleId: string | null) =>
      actions.syncCompanionMembers({
        guildId: GUILD,
        channelId: 'text-1',
        memberIds: [],
        roleId,
        previousRoleId,
      });

    const changed = await run('mods-new', 'mods-old');
    expect(del).toHaveBeenCalledWith('mods-old');
    expect(overwrites.get('mods-new')?.allow).toBe(VIEW);
    expect(changed.grantedRoleId).toBe('mods-new');

    del.mockClear();
    const cleared = await run(null, 'mods-new');
    expect(del).toHaveBeenCalledWith('mods-new');
    expect(cleared.grantedRoleId).toBeNull();
  });

  /**
   * Role attribution comes from the stored row, not from the permission bits.
   * The bot writes at most one role overwrite, so a bits heuristic would revoke
   * every role a moderator granted by hand, on every voice event.
   */
  it('leaves a role a human granted alone, and revokes only the one it recorded', async () => {
    const { client, del, overwrites } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: 'helpers', type: OverwriteType.Role, allow: VIEW, deny: 0n },
      { id: 'mods-old', type: OverwriteType.Role, allow: VIEW, deny: 0n },
    ]);

    const result = await new DiscordVoiceActions(client).syncCompanionMembers({
      guildId: GUILD,
      channelId: 'text-1',
      memberIds: [],
      roleId: 'mods-new',
      previousRoleId: 'mods-old',
    });

    expect(del).toHaveBeenCalledWith('mods-old');
    expect(del).not.toHaveBeenCalledWith('helpers');
    expect(overwrites.get('helpers')).toBeDefined();
    expect(result.grantedRoleId).toBe('mods-new');
  });

  /**
   * The deny is written once at create, so anyone clearing it, or clicking
   * "sync permissions with category", would publish the whole conversation
   * while every surface kept saying only the room could read it.
   */
  it('re-asserts the @everyone deny when it has been removed', async () => {
    const { client, edit } = makeClient([
      { id: BOT, type: OverwriteType.Member, allow: VIEW | MANAGE, deny: 0n },
    ]);

    await sync(client, []);

    expect(edit).toHaveBeenCalledWith(
      EVERYONE,
      { ViewChannel: false },
      { type: OverwriteType.Role },
    );
  });

  it('does not rewrite the @everyone deny when it is already there', async () => {
    const { client, edit } = makeClient([{ id: EVERYONE, type: 0, allow: 0n, deny: VIEW }]);
    await sync(client, []);
    expect(edit).not.toHaveBeenCalled();
  });

  /**
   * A role since deleted from the guild makes the grant throw. The revoke of
   * the PREVIOUS role runs first for that reason: ordered the other way, a
   * deleted new role would strand the old one with nothing able to remove it.
   */
  it('still revokes the old role when granting the new one fails', async () => {
    const { client, del, edit } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: 'mods-old', type: OverwriteType.Role, allow: VIEW, deny: 0n },
    ]);
    // 'mods-new' EXISTS in the guild, so the grant is attempted and fails for
    // a different reason (hierarchy, or Manage Roles lost on the category).
    // Using 'mods-gone' here would short-circuit at the resolver and never
    // reach the catch this test is about.
    edit.mockImplementation((id: string) =>
      id === 'mods-new' ? Promise.reject(apiError(50013)) : Promise.resolve(),
    );

    const result = await new DiscordVoiceActions(client).syncCompanionMembers({
      guildId: GUILD,
      channelId: 'text-1',
      memberIds: [],
      roleId: 'mods-new',
      previousRoleId: 'mods-old',
    });

    expect(del).toHaveBeenCalledWith('mods-old');
    // Never recorded as granted, or the next pass would try to revoke it.
    expect(result.grantedRoleId).toBeNull();
    // A role that exists but cannot be granted is NOT the deleted-role case.
    expect(result.roleMissing).toBeFalsy();
  });

  /**
   * The deleted-role case, at the adapter rather than through the fake.
   *
   * Production, 2026-09-18: a legacy `stct` value naming a role the guild had
   * deleted years earlier. Discord took it in the create payload and dropped it
   * silently, then answered `10009 Unknown Overwrite` to the equivalent PUT on
   * every sweep, forever.
   */
  it('never asks Discord for a role the guild no longer has', async () => {
    const { client, guild } = makeClient();
    const created = await new DiscordVoiceActions(client).createCompanionChannel({
      guildId: GUILD,
      name: 'voice context',
      secondaryChannelId: ROOM,
      memberIds: ['u1'],
      roleId: 'mods-gone',
    });

    // Not in the payload, so the row cannot claim a grant that never happened.
    const payload = createArg(guild);
    expect(payload.permissionOverwrites.find((o) => o.id === 'mods-gone')).toBeUndefined();
    expect(created).toMatchObject({ grantedRoleId: null, roleMissing: true });
  });

  it('issues no permission write for a deleted role, but still revokes the old one', async () => {
    const { client, edit, del } = makeClient([
      { id: EVERYONE, type: 0, allow: 0n, deny: VIEW },
      { id: 'mods-old', type: OverwriteType.Role, allow: VIEW, deny: 0n },
    ]);

    const result = await new DiscordVoiceActions(client).syncCompanionMembers({
      guildId: GUILD,
      channelId: 'text-1',
      memberIds: [],
      roleId: 'mods-gone',
      previousRoleId: 'mods-old',
    });

    // The 10009 loop was exactly this call being made every five minutes.
    expect(edit).not.toHaveBeenCalledWith('mods-gone', expect.anything(), expect.anything());
    // Changing to a dead role must not strand the role that WAS granted.
    expect(del).toHaveBeenCalledWith('mods-old');
    expect(result).toMatchObject({ grantedRoleId: null, roleMissing: true });
  });

  it('reports a deleted channel rather than throwing', async () => {
    const client = {
      user: { id: BOT },
      channels: { fetch: vi.fn().mockRejectedValue(apiError(UNKNOWN_CHANNEL)) },
    } as unknown as Client;

    await expect(sync(client, ['u1'])).resolves.toMatchObject({ channelGone: true });
  });
});
