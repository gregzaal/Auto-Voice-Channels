import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscordAPIError, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { GuildDispatcher } from '../runtime/dispatcher.js';
import { readControlPanel } from '../features/voice/guildSettings.js';
import { GuildSettingsService } from '../features/voice/settings.js';
import { registerInteractionHandler, type InteractionDeps } from './interactions.js';
import { LOGGING_MODAL_ID } from './loggingModal.js';
import { CREATE_FROM_SETUP_MODAL_ID, CREATE_MODAL_ID } from './createModal.js';
import { GENERAL_MODAL_ID, SETUP_SETTINGS_ID, setupId } from './setupPanel.js';
import { listsId, LISTS_SELECT_ID } from './listsPanel.js';
import { TIMEZONE_MODAL_ID } from './timezoneModal.js';
import { editorId } from './templatePanel.js';
import { ALIAS_MODAL_ID } from './aliasModal.js';
import { ALIAS_SELECT_ID, aliasHash, aliasId } from './aliasPanel.js';
import { controlPanelId } from '../features/voice/controlPanel.js';
import { controlAppearanceId, controlSettingsId, controlToggleId } from './controlPanelSettings.js';
import { botProfileResetId, botProfileSetId } from './botProfilePanel.js';
import { alwaysId, joinId } from '../features/voice/joinPanel.js';

/** A Discord "Missing Permissions" (50013) rejection, as thrown by a failed create. */
function missingPermissions(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 50013, message: 'Missing Permissions' } as never,
    50013,
    403,
    'POST',
    'https://discord.test',
    {} as never,
  );
}

/** A fake discord.js Client: just the event emitter surface the router uses. */
function fakeClient(): EventEmitter {
  return new EventEmitter();
}

interface FakeInteractionOpts {
  kind: 'command' | 'button' | 'select' | 'stringSelect' | 'modal';
  guildId?: string | null;
  commandName?: string;
  customId?: string;
  /** Channel ids the guild's cache holds. Absent = an empty (unpopulated) cache. */
  existingChannels?: string[];
  manageChannels?: boolean;
  /** The higher tier, for /export and /import. */
  manageGuild?: boolean;
  values?: string[];
  /** The interaction id (the retry token is keyed off it). */
  id?: string;
  /** Modal text inputs by custom id (name/nameTemplate/statusTemplate). */
  textInputs?: Record<string, string>;
  /** The `privacy` string-select value. */
  privacy?: 'open' | 'private' | 'hidden';
  /** Any other modal string-select values, by custom id (e.g. logging's `level`). */
  selectValues?: Record<string, string[]>;
  /** The category chosen in the modal's channel-select. */
  selectedChannelId?: string;
  /** Permission flags the bot member holds guild-wide. */
  botPerms?: bigint[];
  /** The caller's user id. Defaults to `u1`, which is not a snowflake and so cannot be named by a rule. */
  userId?: string;
  /**
   * The caller's role ids, which also decides whether there is a member at all:
   * absent leaves `member` null, which is what most of these tests need.
   */
  memberRoles?: string[];
  /**
   * Which member shape discord.js hands over. `guildMember` (the default) keeps
   * its roles in `roles.cache` AND includes the guild id as @everyone, as the
   * real class does, and `raw` is the API member with a plain role id list.
   */
  memberShape?: 'guildMember' | 'raw';
  /** Whether the caller holds Administrator, which the guard treats like Manage Channels. */
  administrator?: boolean;
  /** A category present in the guild cache: name + the flags the bot holds there. */
  category?: { id: string; name: string; perms: bigint[] };
  /** The voice channel the caller is sitting in (drives the "act on it" path). */
  voiceChannelId?: string;
  /** Discord interaction locale, passed to the assistant as the reply language. */
  locale?: string;
  /** True when a modal was opened from a component, so it can edit that message. */
  fromMessage?: boolean;
  /** Slash-command option values, for the commands that take one. */
  optionInteger?: number;
  optionString?: string;
  optionUserId?: string;
  /** The `channel` option's value, for `/channelinfo` and `/debug`. */
  optionChannelId?: string;
  /** The subcommand a command with subcommands was invoked with. */
  subcommand?: string;
  /** `/restrict`'s `feature` choice. */
  optionFeature?: string;
  /**
   * `/access`'s `member` option, as Discord resolves it: the user, and the member only
   * when they are in the server (a user picked by id alone has none).
   */
  optionMember?: { user: { id: string; bot?: boolean }; member?: object | null };
  /** `/access clear`'s optional `list` choice. */
  optionList?: string;
  /**
   * `/restrict`'s `who` option, as the mentionable picker resolves it: the
   * `role`, or the `user` and the `member` the guild cache would add to it.
   */
  optionWho?: {
    role?: { id: string; permissions: unknown };
    user?: { id: string; bot?: boolean };
    member?: { permissions: unknown };
  };
  /**
   * Voice channels in the guild cache, and whether the CALLER can see each.
   *
   * Separate from {@link category} because the two questions differ: that one
   * asks what the BOT holds on a category, this one asks what the caller can
   * see, which is what binds a channel id somebody typed to what they may look
   * at.
   */
  voiceChannels?: Record<string, { name: string; callerCanSee: boolean }>;
  /** The bot's own member as `fetchMe` returns it, for `/botprofile`. */
  fetchMe?: ReturnType<typeof vi.fn>;
  /** `guild.members.editMe`, for `/botprofile`'s writes. */
  editMe?: ReturnType<typeof vi.fn>;
  /** The file a modal upload field carries. */
  uploadedFile?: { url: string; size: number };
  /** The cached bot member's nickname, which the name modal prefills from. */
  botNickname?: string;
  /** `guild.ownerId`, which the guild always knows, cached members or not. */
  guildOwnerId?: string;
}

/** The bot's own guild member, with only what `/botprofile` reads. */
function fakeBotMember(
  over: { nickname?: string | null; avatar?: string | null; canRename?: boolean } = {},
) {
  return {
    nickname: over.nickname ?? null,
    avatar: over.avatar ?? null,
    banner: null,
    user: { username: 'AVC', globalName: null },
    permissions: {
      has: (p: bigint) => p !== PermissionFlagsBits.ChangeNickname || (over.canRename ?? true),
    },
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png',
    bannerURL: () => null,
  };
}

/** Builds a minimal interaction with the methods/getters the router touches. */
function fakeInteraction(opts: FakeInteractionOpts) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const holds = (flags: bigint[] | undefined, p: bigint): boolean => (flags ?? []).includes(p);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: opts.id ?? 'i1',
    guildId: opts.guildId ?? 'g1',
    user: { id: opts.userId ?? 'u1', username: 'kay', displayName: 'Kay' },
    member:
      opts.memberRoles === undefined
        ? null
        : opts.memberShape === 'raw'
          ? { roles: [...opts.memberRoles] }
          : {
              roles: {
                cache: new Map([
                  [opts.guildId ?? 'g1', {}],
                  ...opts.memberRoles.map((id) => [id, {}] as const),
                ]),
              },
            },
    locale: opts.locale,
    guild: {
      ownerId: opts.guildOwnerId,
      members: {
        cache: {
          get: () =>
            opts.voiceChannelId ? { voice: { channelId: opts.voiceChannelId } } : undefined,
        },
        // The cached bot member: its permissions are `botPerms`, and the rest
        // is what `/botprofile` prefills from.
        me: {
          ...fakeBotMember({ nickname: opts.botNickname ?? null }),
          permissions: { has: (p: bigint) => holds(opts.botPerms, p) },
        },
        fetchMe: opts.fetchMe ?? vi.fn().mockResolvedValue(fakeBotMember()),
        editMe: opts.editMe ?? vi.fn().mockResolvedValue(fakeBotMember()),
      },
      channels: {
        cache: {
          get: (id: string) => {
            if (opts.category && opts.category.id === id) {
              return {
                name: opts.category.name,
                permissionsFor: () => ({ has: (p: bigint) => holds(opts.category!.perms, p) }),
              };
            }
            const vc = opts.voiceChannels?.[id];
            if (!vc) return undefined;
            return {
              name: vc.name,
              // The subject matters here: the caller's view and the bot's are
              // different questions asked of the same channel.
              permissionsFor: (subject: unknown) => ({
                has: (p: bigint) =>
                  subject === interaction.user ? vc.callerCanSee : holds(opts.botPerms, p),
              }),
            };
          },
          // A real ChannelManager cache. `size` 0 (the default) is what an
          // unpopulated cache looks like, which callers must fail open on.
          has: (id: string) => (opts.existingChannels ?? []).includes(id),
          size: (opts.existingChannels ?? []).length,
        },
      },
    },
    commandName: opts.commandName,
    customId: opts.customId,
    memberPermissions: {
      has: (p: bigint) =>
        (p === PermissionFlagsBits.ManageChannels && (opts.manageChannels ?? false)) ||
        (p === PermissionFlagsBits.Administrator && (opts.administrator ?? false)) ||
        (p === PermissionFlagsBits.ManageGuild && (opts.manageGuild ?? false)),
    },
    replied: false,
    deferred: false,
    type: 1,
    inGuild: () => opts.guildId !== null,
    isRepliable: () => true,
    isChatInputCommand: () => opts.kind === 'command',
    isButton: () => opts.kind === 'button',
    isChannelSelectMenu: () => opts.kind === 'select',
    isStringSelectMenu: () => opts.kind === 'stringSelect',
    isModalSubmit: () => opts.kind === 'modal',
    isFromMessage: () => opts.fromMessage ?? false,
    reply,
    followUp,
    editReply,
    // Flips `deferred`, because that is what `replyResult` branches on: a
    // deferred interaction must be answered with `editReply`, and replying to
    // one throws. A fake that never set it hid that distinction entirely.
    deferReply: vi.fn().mockImplementation(() => {
      interaction.deferred = true;
      return Promise.resolve(undefined);
    }),
    // Flips `deferred` for the same reason `deferReply` above does: once a
    // handler has deferred, `reply` throws and the code must reach for
    // `followUp` or `editReply`. A fake that left this false let a test pass
    // against a path production never takes.
    deferUpdate: vi.fn().mockImplementation(() => {
      interaction.deferred = true;
      return Promise.resolve(undefined);
    }),
    deleteReply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    values: opts.values ?? [],
    options: {
      getInteger: () => opts.optionInteger ?? 2,
      getString: (name?: string) =>
        name === 'feature' && opts.optionFeature
          ? opts.optionFeature
          : name === 'list'
            ? (opts.optionList ?? null)
            : (opts.optionString ?? 'x'),
      // `null` when there is none, which is what discord.js answers for `false`.
      getSubcommand: () => opts.subcommand ?? null,
      get: (name: string) =>
        name === 'who' && opts.optionWho
          ? { name, ...opts.optionWho }
          : name === 'member' && opts.optionMember
            ? { name, user: opts.optionMember.user, member: opts.optionMember.member ?? null }
            : null,
      getUser: () => ({ id: opts.optionUserId ?? 'u2' }),
      getChannel: () => (opts.optionChannelId ? { id: opts.optionChannelId } : null),
      getBoolean: () => null,
      getAttachment: () => null,
    },
    fields: {
      getStringSelectValues: (k: string) =>
        k === 'privacy' && opts.privacy ? [opts.privacy] : (opts.selectValues?.[k] ?? []),
      getSelectedChannels: () =>
        opts.selectedChannelId ? { first: () => ({ id: opts.selectedChannelId }) } : null,
      getTextInputValue: (k: string) => opts.textInputs?.[k] ?? '',
      getUploadedFiles: () => (opts.uploadedFile ? { first: () => opts.uploadedFile } : null),
    },
    channelId: 'text1',
  };
  return { interaction, reply, followUp, editReply };
}

function setup(overrides: Partial<InteractionDeps> = {}) {
  const client = fakeClient();
  const settings = {
    // `lists` is always present on a real `GuildConfig`, so the fake carries it
    // too: an empty map is what a guild with no named lists returns, and a fake
    // that omitted it would let a caller reading it pass here and throw live.
    getConfig: vi.fn().mockResolvedValue({ enabled: true, primaries: [], aliases: {}, lists: {} }),
    setLogging: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    getLogging: vi.fn().mockResolvedValue({ enabled: false, level: 1, channelId: null }),
    listAliases: vi.fn().mockResolvedValue({}),
    addAlias: vi.fn().mockResolvedValue({ ok: true, message: 'added' }),
    removeAlias: vi.fn().mockResolvedValue({ ok: true, message: 'removed' }),
    replaceAlias: vi.fn().mockResolvedValue({ ok: true, message: 'saved' }),
    setTextChannelName: vi.fn().mockResolvedValue({ ok: true, message: 'named' }),
    setTextChannelRole: vi.fn().mockResolvedValue({ ok: true, message: 'role set' }),
    toggleTextChannel: vi.fn().mockResolvedValue({ ok: true, message: 'toggled' }),
    /**
     * Built by the real reader rather than by hand.
     *
     * A literal here drifts the moment the config grows a field, and the
     * symptom is not an obviously wrong fixture: the panel builder throws deep
     * inside a render and the handler answers "something went wrong".
     */
    getControlPanel: vi
      .fn()
      .mockResolvedValue(readControlPanel({ control_panel: { panel: true } })),
    setControlPanelEntry: vi.fn().mockResolvedValue({ ok: true, message: 'switched' }),
    setControlPanelAppearance: vi.fn().mockResolvedValue({ ok: true, message: 'saved' }),
  };
  const guilds = {
    get: vi.fn().mockResolvedValue({ authStatus: 'active' }),
    isEntitled: vi.fn().mockResolvedValue(true),
  };
  const managed = { listByGuild: vi.fn().mockResolvedValue([]) };
  const reportError = vi.fn();
  const deps = {
    client,
    dispatcher: { dispatch: (_g: string, _n: string, task: () => Promise<unknown>) => task() },
    voiceCommands: {},
    settings,
    votekick: {},
    privacy: {},
    feature: {},
    guilds,
    managed,
    selfHosted: true,
    clientId: 'c1',
    logger: fakeLogger(),
    reportError,
    ...overrides,
  } as unknown as InteractionDeps;
  const dispose = registerInteractionHandler(deps);
  return { client, deps, settings, guilds, reportError, dispose };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('registerInteractionHandler (router)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  it('short-circuits a blocked guild and does no command work', async () => {
    const env = setup({
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'blocked' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({ kind: 'command', commandName: 'setup' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'This server is currently blocked.' }),
    );
    expect(env.settings.getConfig).not.toHaveBeenCalled();
  });

  it('an expired guild gets the reactivation message for normal commands', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({ kind: 'command', commandName: 'limit' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
  });

  /**
   * Export stays available while gated, but import cannot mutate configuration.
   * Test both paths rather than relying on the allow-list looking correct.
   *
   * Refusing to let somebody take their own configuration with them because
   * they stopped paying is exactly what the AGPL positioning rules out, so
   * `/export` works while gated. `/import` is a write path, and the hard gate is
   * non-destructive by design: it stops writes and destroys nothing.
   */
  it('an expired guild can still run /export, and gets no reactivation message', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'export',
      manageGuild: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).not.toContain('auto-voice.io');
  });

  it('an expired guild cannot run /import', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'import',
      manageGuild: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
  });

  /**
   * The registration default is a DEFAULT, not a gate: a server admin can
   * re-open either command to any role in Server Settings > Integrations, so
   * this in-code check must enforce the Manage Server requirement.
   */
  it.each(['export', 'import'])('refuses /%s without Manage Server', async (commandName) => {
    const env = setup({});
    dispose = env.dispose;
    // ManageChannels alone, which is the bar the tier exists to clear.
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName,
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Manage Server');
  });

  it('an expired guild can still open /setup (shows the gated state)', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({ kind: 'command', commandName: 'setup' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.getConfig).toHaveBeenCalled();
  });

  it('an expired guild can still run /source (AGPL-3.0 network-use notice)', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({ kind: 'command', commandName: 'source' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain(
      'github.com/GregZaal/Auto-Voice-Channels',
    );
  });

  /**
   * `/setup` acknowledges before it works.
   *
   * It reads the database through the per-guild queue, so it cannot promise
   * Discord's three-second budget: a guild busy retrying failed channel
   * creations holds that queue, and the database is a region away. A real
   * `/setup` blew the budget during the beta switch and died with 10062
   * "Unknown interaction", which the admin sees as "The application did not
   * respond". The panel must arrive by editReply, not reply.
   */
  it('defers /setup and delivers the panel by editReply', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'setup',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('embeds');
  });

  it('grace guilds are fully entitled (no gating)', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'grace' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({ kind: 'command', commandName: 'bogus' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Unknown command.' }));
  });

  it('replies "Unknown command." for an unrecognised command', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({ kind: 'command', commandName: 'bogus' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Unknown command.' }));
  });

  it('routes a thrown handler to reportError + a single safeReply', async () => {
    const settings = {
      getConfig: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, reply, followUp } = fakeInteraction({
      kind: 'command',
      commandName: 'setup',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.reportError).toHaveBeenCalled();
    /**
     * `followUp`, not `reply`: `openSetup` defers before it does any work, so a
     * handler that throws afterwards finds the interaction acknowledged and
     * `safeReply` takes its deferred branch. This asserted `reply` only because
     * the fake never set `deferred`, i.e. it pinned an unreachable branch.
     */
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ Something went wrong handling that: boom' }),
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it('offers a channel picker when a config command is used outside a voice channel', async () => {
    const env = setup();
    dispose = env.dispose;
    // /position with no current voice channel → reply with the pick-a-channel menu.
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'position',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('avc:setup:pick:position');
  });

  it('gates the manage channel-select on Manage Channels', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'select',
      customId: 'avc:setup:pick:manage',
      manageChannels: false,
      values: ['vc1'],
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
  });

  it('rejects an admin modal submit without Manage Channels and runs no mutation', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: LOGGING_MODAL_ID,
      manageChannels: false,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
    expect(env.settings.setLogging).not.toHaveBeenCalled();
  });

  /** A `/create` modal submit that fails on missing category permissions. */
  function createSettings() {
    return {
      getConfig: vi.fn().mockResolvedValue({
        enabled: true,
        primaries: [],
        defaultTemplate: 'T',
        defaultStatus: 'S',
      }),
      createPrimary: vi.fn().mockRejectedValue(missingPermissions()),
    };
  }

  /**
   * A creator channel whose Discord channel is gone must not be named in the
   * panel. The ROW is deliberately kept (owner, 2026-08-27): cache absence is
   * not proof of deletion, so this hides, it never deletes.
   */
  it('hides a creator channel that no longer exists from the setup panel', async () => {
    const settings = createSettings();
    settings.getConfig.mockResolvedValue({
      enabled: true,
      primaries: [{ channelId: 'p-live' }, { channelId: 'p-gone' }],
      defaultTemplate: 'T',
      defaultStatus: 'S',
      lists: {},
    });
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'setup',
      manageChannels: true,
      existingChannels: ['p-live'],
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    const panel = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(panel).toContain('p-live');
    expect(panel).not.toContain('p-gone');
    expect(panel).toContain('Creator channels (1)');
  });

  /**
   * Fail open. An empty channel cache means we know nothing about this guild,
   * not that it has no creator channels, and telling an admin their setup has
   * vanished is worse than naming a channel that has.
   */
  it('shows every creator channel when the guild channel cache is empty', async () => {
    const settings = createSettings();
    settings.getConfig.mockResolvedValue({
      enabled: true,
      primaries: [{ channelId: 'p-live' }, { channelId: 'p-gone' }],
      defaultTemplate: 'T',
      defaultStatus: 'S',
      lists: {},
    });
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'setup',
      manageChannels: true,
      // No `existingChannels` → cache size 0.
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    const panel = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(panel).toContain('Creator channels (2)');
  });

  function submitFailingCreate(
    env: ReturnType<typeof setup>,
    privacy: 'open' | 'private' | 'hidden' = 'private',
  ) {
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: CREATE_MODAL_ID,
      manageChannels: true,
      id: 'modal-1',
      textInputs: { name: 'Lobby', nameTemplate: 'T', statusTemplate: 'S' },
      privacy,
      selectedChannelId: 'cat1',
      category: {
        id: 'cat1',
        name: 'Staff',
        perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
      },
    });
    env.client.emit('interactionCreate', interaction);
    return reply;
  }

  it('names the missing/held permissions and offers a Retry on a create permission failure', async () => {
    const settings = createSettings();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const reply = submitFailingCreate(env);
    await flush();

    expect(settings.createPrimary).toHaveBeenCalled();
    // Handled gracefully, not via the top-level "something went wrong" path.
    expect(env.reportError).not.toHaveBeenCalled();
    const payload = reply.mock.calls[0]?.[0];
    expect(payload.content).toContain('Staff'); // the chosen category, by name
    expect(payload.content).toContain('Manage Channels'); // missing there
    expect(payload.content).toContain('View Channels'); // already held
    expect(JSON.stringify(payload.components)).toContain('avc:create:retry:modal-1');
  });

  it('re-opens the modal with the saved selections when Retry is clicked', async () => {
    const env = setup({ settings: createSettings() as never });
    dispose = env.dispose;
    submitFailingCreate(env);
    await flush();

    const { interaction: btn } = fakeInteraction({
      kind: 'button',
      customId: 'avc:create:retry:modal-1',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', btn);
    await flush();

    expect(btn.showModal).toHaveBeenCalledTimes(1);
    const modal = JSON.stringify(btn.showModal.mock.calls[0]?.[0]);
    expect(modal).toContain('Lobby'); // saved channel name
    expect(modal).toContain('cat1'); // saved category re-selected
  });

  /**
   * The modal's third privacy choice has to survive a failed create: the retry stash keeps
   * what was picked, and a retry that re-opened on Private would quietly turn a hidden
   * creator channel into a locked one on the admin's second try.
   */
  it('re-opens the modal on Hidden when a create that asked for it failed', async () => {
    const env = setup({ settings: createSettings() as never });
    dispose = env.dispose;
    submitFailingCreate(env, 'hidden');
    await flush();

    const { interaction: btn } = fakeInteraction({
      kind: 'button',
      customId: 'avc:create:retry:modal-1',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', btn);
    await flush();

    const modal = JSON.parse(JSON.stringify(btn.showModal.mock.calls[0]?.[0])) as {
      components: { component: { custom_id?: string; options?: unknown[] } }[];
    };
    const privacy = modal.components.map((c) => c.component).find((c) => c.custom_id === 'privacy');
    const options = privacy?.options as { value: string; default?: boolean }[];
    expect(options.filter((o) => o.default).map((o) => o.value)).toEqual(['hidden']);
  });

  it('falls back to a blank modal when the saved create selections have expired', async () => {
    const env = setup({ settings: createSettings() as never });
    dispose = env.dispose;
    // No prior failure stored this token → no prefill, but Retry still opens a modal.
    const { interaction: btn } = fakeInteraction({
      kind: 'button',
      customId: 'avc:create:retry:gone',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', btn);
    await flush();
    expect(btn.showModal).toHaveBeenCalledTimes(1);
  });

  /**
   * `handleButton` used to be a chain of prefix tests that fell off the end, so
   * an id no branch claimed produced no reply at all and Discord showed the
   * member a bare "This interaction failed". Reachable during a rolling deploy,
   * where commands register globally and instantly while machines are still
   * cycling, so a button from a new build can land on an old one.
   */
  it('answers a button whose custom id no handler recognises', async () => {
    const env = setup({ settings: createSettings() as never });
    dispose = env.dispose;
    const { interaction: btn } = fakeInteraction({
      kind: 'button',
      customId: 'avc:notathing:42',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', btn);
    await flush();

    expect(btn.reply).toHaveBeenCalledTimes(1);
    const reply = btn.reply.mock.calls[0]?.[0] as { content: string; ephemeral: boolean };
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toMatch(/out of date|no longer/i);
  });
});

/**
 * `/templateassistant` routing.
 *
 * The behaviours worth pinning here are the ones that are easy to get subtly
 * wrong: the command is admin-gated and nothing else gates it, an expired guild
 * still cannot reach it (it is a write path), and the `/setup` panel's blanket
 * exemption must not smuggle it past that.
 */
describe('registerInteractionHandler (/templateassistant)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const editorState = {
    found: true,
    scope: 'primary',
    name: { currentTemplate: '## room', effectiveTemplate: '## room', preview: '#1 room' },
    status: { effectiveTemplate: '', preview: '' },
  };

  function assistantEnv(overrides: Partial<InteractionDeps> = {}) {
    return setup({
      feature: {
        getEditorState: vi.fn().mockResolvedValue(editorState),
        getManagedEditorState: vi.fn().mockResolvedValue({ found: false }),
      } as never,
      assistant: { propose: vi.fn() } as never,
      ...overrides,
    });
  }

  it('opens the describe-it modal for an admin in a managed channel', async () => {
    const env = assistantEnv();
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(interaction.showModal.mock.calls[0]?.[0])).toContain('avc:ai:ask:');
  });

  it('offers a channel picker when the caller is not in a voice channel', async () => {
    const env = assistantEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('avc:setup:pick:templateassistant');
  });

  // Admin-gated exactly like /template, and that is the *only* gate.
  it('refuses a caller without Manage Channels', async () => {
    const env = assistantEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('explains itself when no model endpoint is configured', async () => {
    const env = setup({
      feature: { getEditorState: vi.fn().mockResolvedValue(editorState) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('AVC_AI_API_KEY');
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('offers adoption when the channel is not managed yet', async () => {
    const env = assistantEnv({
      feature: {
        getEditorState: vi.fn().mockResolvedValue({ found: false }),
        getManagedEditorState: vi.fn().mockResolvedValue({ found: false }),
      } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('avc:adopt:confirm:vc1');
  });

  it('is not reachable in an expired guild', async () => {
    const env = assistantEnv({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  // The `/setup` panel is exempt from the hard gate so an admin can see the
  // gated state. The assistant button on it must not inherit that.
  it('the /setup assistant button is not exempt from the hard gate', async () => {
    const env = assistantEnv({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: 'avc:setup:assistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
  });

  it('proposes on modal submit, passing the locale through as the reply language', async () => {
    const propose = vi.fn().mockResolvedValue({
      ok: true,
      proposal: {
        name: '## - @@game_name@@',
        status: null,
        explanation: 'Numbered plus the game.',
        fields: [
          {
            field: 'name',
            template: '## - @@game_name@@',
            previews: [{ label: 'one person, nothing playing', rendered: '#1 - General' }],
          },
        ],
        notes: [],
      },
    });
    const env = assistantEnv({ assistant: { propose } as never });
    dispose = env.dispose;

    // Open a session so the modal id resolves to one.
    const { interaction: cmd } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', cmd);
    await flush();
    const modalId = (cmd.showModal.mock.calls[0]?.[0] as { data: { custom_id: string } }).data
      .custom_id;

    const { interaction: submit, editReply } = fakeInteraction({
      kind: 'modal',
      customId: modalId,
      manageChannels: true,
      locale: 'es-ES',
      textInputs: { request: 'numera las salas y muestra el juego' },
    });
    env.client.emit('interactionCreate', submit);
    await flush();

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0]?.[0]).toMatchObject({
      guildId: 'g1',
      standalone: false,
      locale: 'es-ES',
      currentName: '## room',
    });
    expect(propose.mock.calls[0]?.[1]).toBe('numera las salas y muestra el juego');
    const panel = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(panel).toContain('#1 - General');
    expect(panel).toContain('avc:ai:apply:');
  });

  it('surfaces a refusal instead of a proposal, and offers no Apply', async () => {
    const propose = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'capped', message: 'all 200 AI builds' });
    const env = assistantEnv({ assistant: { propose } as never });
    dispose = env.dispose;

    const { interaction: cmd } = fakeInteraction({
      kind: 'command',
      commandName: 'templateassistant',
      manageChannels: true,
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', cmd);
    await flush();
    const modalId = (cmd.showModal.mock.calls[0]?.[0] as { data: { custom_id: string } }).data
      .custom_id;

    const { interaction: submit, editReply } = fakeInteraction({
      kind: 'modal',
      customId: modalId,
      manageChannels: true,
      textInputs: { request: 'anything' },
    });
    env.client.emit('interactionCreate', submit);
    await flush();

    const shown = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(shown).toContain('all 200 AI builds');
    expect(shown).not.toContain('avc:ai:apply:');
  });

  it('tells the admin to start over when the session has expired', async () => {
    const env = assistantEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: 'avc:ai:ask:gone',
      manageChannels: true,
      textInputs: { request: 'anything' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('session has expired');
  });
});

describe('registerInteractionHandler (/alias panel)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const CS2 = aliasHash('Counter-Strike 2');
  // Configure the spies setup() already wired into deps. Passing a fresh
  // `settings` override instead would leave `env.settings` pointing at the
  // original object, so every assertion would read a spy nothing ever called.
  const withAliases = (aliases: Record<string, string>) => {
    const env = setup();
    env.settings.listAliases.mockResolvedValue(aliases);
    env.settings.getConfig.mockResolvedValue({ enabled: true, primaries: [], aliases, lists: {} });
    return env;
  };

  it('opens the list panel for /alias instead of a modal', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'alias',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Counter-Strike 2');
  });

  it('routes the picker to the detail view for the chosen alias', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'stringSelect',
      customId: ALIAS_SELECT_ID,
      manageChannels: true,
      values: [CS2],
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const shown = JSON.stringify(interaction.update.mock.calls[0]?.[0]);
    expect(shown).toContain('Counter-Strike 2');
    expect(shown).toContain(aliasId('remove', CS2));
  });

  it('gates the picker on Manage Channels', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'stringSelect',
      customId: ALIAS_SELECT_ID,
      manageChannels: false,
      values: [CS2],
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('removes an alias and re-renders the list', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: aliasId('remove', CS2),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.removeAlias).toHaveBeenCalledWith('g1', 'Counter-Strike 2');
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('removed');
  });

  it('runs no mutation for a remove without Manage Channels', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: aliasId('remove', CS2),
      manageChannels: false,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.removeAlias).not.toHaveBeenCalled();
  });

  it('says so and mutates nothing when the alias vanished while the panel was open', async () => {
    const env = withAliases({});
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: aliasId('remove', CS2),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.removeAlias).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('no longer there');
  });

  it('opens the edit modal prefilled, and saves against the previous name', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const open = fakeInteraction({
      kind: 'button',
      customId: aliasId('edit', CS2),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', open.interaction);
    await flush();
    expect(JSON.stringify(open.interaction.showModal.mock.calls[0]?.[0])).toContain('CS2');

    const save = fakeInteraction({
      kind: 'modal',
      customId: aliasId('save', CS2),
      manageChannels: true,
      textInputs: { game: 'Counter-Strike 2', alias: 'CS' },
      fromMessage: true,
    });
    env.client.emit('interactionCreate', save.interaction);
    await flush();
    expect(env.settings.replaceAlias).toHaveBeenCalledWith(
      'g1',
      'Counter-Strike 2',
      'Counter-Strike 2',
      'CS',
    );
  });

  it('adds through the panel and re-renders rather than replying', async () => {
    const env = withAliases({});
    dispose = env.dispose;
    const { interaction, editReply, reply } = fakeInteraction({
      kind: 'modal',
      customId: ALIAS_MODAL_ID,
      manageChannels: true,
      textInputs: { game: 'Apex Legends', alias: 'Apex' },
      fromMessage: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.addAlias).toHaveBeenCalledWith('g1', 'Apex Legends', 'Apex');
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
  });

  it('still accepts the retired bare modal id with a plain reply', async () => {
    // A modal opened just before a rolling deploy submits against the new build.
    const env = withAliases({});
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: 'avc:alias',
      manageChannels: true,
      textInputs: { game: 'Apex Legends', alias: 'Apex' },
      fromMessage: false,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.addAlias).toHaveBeenCalledWith('g1', 'Apex Legends', 'Apex');
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('added');
  });
});

describe('registerInteractionHandler (/alias panel buttons)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const many = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`Game ${i}`, `G${i}`]));

  const withAliases = (aliases: Record<string, string>) => {
    const env = setup();
    env.settings.listAliases.mockResolvedValue(aliases);
    return env;
  };

  it('opens the add modal without deferring first', async () => {
    // showModal must be the FIRST response, so a defer here is a hard failure
    // in production that no other test would catch.
    const env = withAliases({});
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: aliasId('add'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('gates the add button on Manage Channels', async () => {
    const env = withAliases({});
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: aliasId('add'),
      manageChannels: false,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
  });

  it('collapses the panel on close', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: aliasId('close'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Closed.', embeds: [], components: [] }),
    );
  });

  it('goes back to the list from the detail view', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: aliasId('back'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Counter-Strike 2');
  });

  it('renders the requested page, not always the first', async () => {
    const env = withAliases(many(30));
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: aliasId('page', '1'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Page 2 of 2');
  });

  it('answers rather than dying when the edit modal has no panel behind it', async () => {
    const env = withAliases({ 'Counter-Strike 2': 'CS2' });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: aliasId('save', aliasHash('Counter-Strike 2')),
      manageChannels: true,
      textInputs: { game: 'Counter-Strike 2', alias: 'CS' },
      fromMessage: false,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.replaceAlias).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('/alias');
  });

  it('does not read a truncated prefill back as a rename', async () => {
    // A modal input caps at 100 characters; an imported game name does not.
    // Reading the prefill back unchanged must keep the real key.
    const long = `${'g'.repeat(102)}`;
    const env = withAliases({ [long]: 'Short' });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: aliasId('save', aliasHash(long)),
      manageChannels: true,
      textInputs: { game: long.slice(0, 100), alias: 'Shorter' },
      fromMessage: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.replaceAlias).toHaveBeenCalledWith('g1', long, long, 'Shorter');
  });
});

/**
 * Discord kills an interaction token after **3 seconds**, and these commands
 * spend that budget on REST calls against the channel's bucket, which is the
 * same one a rename uses (`PATCH /channels/{id}`). So AVC's own queued rename
 * delays the next command's call and the reply lands on a dead token: the work
 * succeeds and the user sees "The application did not respond".
 *
 * That was observed live on `/limit` sitting behind a rate-limited rename, and
 * it is a feedback loop, because `/limit` is now one of the commands that
 * causes a rename. Detaching the re-render was not enough: the blocking call
 * was the command's OWN `setUserLimit`.
 */
describe('commands that talk to Discord acknowledge first', () => {
  const deferring = [
    'limit',
    'unlimit',
    'private',
    'public',
    'hide',
    'unhide',
    'access',
    'reclaim',
    'transfer',
    'nick',
  ];

  it('defers, then answers with editReply rather than reply', async () => {
    for (const commandName of deferring) {
      const env = setup({
        voiceCommands: {
          setLimit: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
          unlimit: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
          claim: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
          transfer: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
        } as never,
        privacy: {
          makePrivate: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
          makePublic: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
          hide: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
          unhide: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
        } as never,
        access: { list: vi.fn().mockResolvedValue({ ok: true, message: 'done' }) } as never,
        settings: {
          setNick: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
        } as never,
        feature: {
          rerenderByOwner: vi.fn().mockResolvedValue({ considered: 0, renamed: 0, rateLimited: 0 }),
        } as never,
      });
      const { interaction, reply, editReply } = fakeInteraction({
        kind: 'command',
        commandName,
        voiceChannelId: 'v1',
      });
      env.client.emit('interactionCreate', interaction);
      await flush();
      expect(interaction.deferReply, `${commandName} did not defer`).toHaveBeenCalled();
      expect(editReply, `${commandName} did not answer via editReply`).toHaveBeenCalled();
      expect(
        reply,
        `${commandName} replied to an already-deferred interaction`,
      ).not.toHaveBeenCalled();
      env.dispose();
    }
  });

  /**
   * The list above is a claim about the router, so it is checked against the
   * router's own source: any command answered with `replyResult` after awaiting
   * `run(...)` has done REST work and must be in it. Without this, a new command
   * added in the same shape gets the 3-second budget back by accident.
   */
  it('covers every command that awaits work before replying', async () => {
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'interactions.ts'),
      'utf8',
    );
    const switchBody = source.slice(
      source.indexOf('switch (interaction.commandName) {'),
      source.indexOf("case 'setup':"),
    );
    // Count guard: a scan that silently matches nothing passes every assertion.
    const cases = [...switchBody.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]!);
    expect(cases.length).toBeGreaterThan(6);

    for (const name of cases) {
      const from = switchBody.indexOf(`case '${name}':`);
      const next = switchBody.indexOf('case ', from + 6);
      const branch = switchBody.slice(from, next === -1 ? undefined : next);
      if (!branch.includes('replyResult') || !branch.includes('await run(')) continue;
      expect(deferring, `${name} awaits work then replies, so it must defer`).toContain(name);
    }
  });
});

/**
 * `/access`: a member's saved trusted and blocked lists. The commands are the service's,
 * so what is pinned here is the router: which service call each subcommand makes with
 * what, that every answer is an edit over the router's deferral with no mention able to
 * ping, what a `/restrict` rule stops and what it never does, and the hard gate.
 */
describe('registerInteractionHandler (/access)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const KAY = '111111111111111111';
  const BOB = '222222222222222222';
  const ROOM = 'room-1';
  const EPHEMERAL = MessageFlags.Ephemeral;

  const ok = (message: string) => vi.fn().mockResolvedValue({ ok: true, message });
  function accessEnv(rules?: Record<string, unknown>, extra: Partial<InteractionDeps> = {}) {
    const access = {
      save: ok('saved'),
      remove: ok('removed'),
      clear: ok('cleared'),
      list: ok('listed'),
    };
    const privacy = { admit: ok('admitted') };
    const env = setup({
      access: access as never,
      privacy: privacy as never,
      guilds: {
        get: vi.fn().mockResolvedValue({
          authStatus: 'active',
          ...(rules ? { settings: { command_access: rules } } : {}),
        }),
        isEntitled: vi.fn().mockResolvedValue(true),
      } as never,
      ...extra,
    });
    dispose = env.dispose;
    return { env, access, privacy };
  }
  type AccessEnv = ReturnType<typeof accessEnv>;

  async function run(e: AccessEnv, opts: Partial<FakeInteractionOpts>) {
    const fake = fakeInteraction({
      kind: 'command',
      commandName: 'access',
      userId: KAY,
      voiceChannelId: ROOM,
      ...opts,
    });
    e.env.client.emit('interactionCreate', fake.interaction);
    await flush();
    return fake;
  }
  const member = (over: { bot?: boolean; member?: object | null } = {}) => ({
    optionMember: {
      user: { id: BOB, ...(over.bot ? { bot: true } : {}) },
      member: 'member' in over ? over.member : {},
    },
  });
  /** The one edit the member's reply is. */
  const answer = (f: ReturnType<typeof fakeInteraction>) =>
    f.editReply.mock.calls[0]?.[0] as { content: string; allowedMentions?: unknown };

  describe('routes each subcommand to the right call', () => {
    it.each([
      ['trust', 'trusted'],
      ['block', 'blocked'],
    ] as const)(
      '/access %s saves them as %s, with what Discord resolved about them',
      async (sub, kind) => {
        const e = accessEnv();
        await run(e, { subcommand: sub, ...member() });
        expect(e.access.save).toHaveBeenCalledWith(
          'g1',
          KAY,
          { id: BOB, bot: false, inServer: true },
          kind,
        );
      },
    );

    /**
     * A member the bot has not cached is not in `guild.members.cache`, so the service
     * cannot tell it an Administrator or the owner is one. What Discord resolved with
     * the interaction (the member's permissions, in either shape it arrives in) and the
     * guild's owner id (known with no member cache at all) are what the refusal reads.
     */
    it.each([
      ['a cached member with Administrator', { permissions: { has: () => true } }],
      ['a raw API member with Administrator', { permissions: '8' }],
    ] as const)('tells the service the member holds Administrator: %s', async (_name, who) => {
      const e = accessEnv();
      await run(e, { subcommand: 'block', ...member({ member: who }) });
      expect(e.access.save).toHaveBeenCalledWith(
        'g1',
        KAY,
        { id: BOB, bot: false, inServer: true, administrator: true },
        'blocked',
      );
    });

    it('does not call a member an Administrator for permissions that are not', async () => {
      const e = accessEnv();
      await run(e, { subcommand: 'block', ...member({ member: { permissions: '1024' } }) });
      expect(e.access.save).toHaveBeenCalledWith(
        'g1',
        KAY,
        { id: BOB, bot: false, inServer: true },
        'blocked',
      );
    });

    it("tells the service when the user is the guild's owner, from the guild and not the member cache", async () => {
      const e = accessEnv();
      await run(e, { subcommand: 'block', guildOwnerId: BOB, ...member() });
      expect(e.access.save).toHaveBeenCalledWith(
        'g1',
        KAY,
        { id: BOB, bot: false, inServer: true, guildOwner: true },
        'blocked',
      );
    });

    it('tells the service when the user is a bot, and when Discord resolved no member', async () => {
      const e = accessEnv();
      await run(e, { subcommand: 'trust', ...member({ bot: true }) });
      expect(e.access.save).toHaveBeenLastCalledWith(
        'g1',
        KAY,
        { id: BOB, bot: true, inServer: true },
        'trusted',
      );
      dispose?.();
      const stranger = accessEnv();
      await run(stranger, { subcommand: 'block', ...member({ member: null }) });
      expect(stranger.access.save).toHaveBeenCalledWith(
        'g1',
        KAY,
        { id: BOB, bot: false, inServer: false },
        'blocked',
      );
    });

    it('/access admit lets them into the room the caller is in, through the privacy service', async () => {
      const e = accessEnv();
      await run(e, { subcommand: 'admit', ...member() });
      expect(e.privacy.admit).toHaveBeenCalledWith('g1', ROOM, KAY, BOB);
      expect(e.access.save).not.toHaveBeenCalled();
    });

    it('/access admit passes no channel on when the caller is in none, and leaves the refusal to the service', async () => {
      const e = accessEnv();
      const f = fakeInteraction({
        kind: 'command',
        commandName: 'access',
        userId: KAY,
        subcommand: 'admit',
        ...member(),
      });
      e.env.client.emit('interactionCreate', f.interaction);
      await flush();
      expect(e.privacy.admit).toHaveBeenCalledWith('g1', undefined, KAY, BOB);
    });

    it('/access remove takes the member off', async () => {
      const e = accessEnv();
      await run(e, { subcommand: 'remove', ...member() });
      expect(e.access.remove).toHaveBeenCalledWith('g1', KAY, BOB);
    });

    it("/access list reads the caller's own lists, with no member option", async () => {
      const e = accessEnv();
      await run(e, { subcommand: 'list' });
      expect(e.access.list).toHaveBeenCalledWith('g1', KAY, { inert: false });
    });

    it.each([
      ['trusted', 'trusted'],
      ['blocked', 'blocked'],
      [undefined, undefined],
      ['everything', undefined],
    ] as const)('/access clear with %j empties %j', async (choice, kind) => {
      const e = accessEnv();
      await run(e, { subcommand: 'clear', ...(choice ? { optionList: choice } : {}) });
      expect(e.access.clear).toHaveBeenCalledWith('g1', KAY, kind);
    });

    it('refuses a request with no user to put on a list, and an unknown subcommand', async () => {
      const e = accessEnv();
      const none = await run(e, { subcommand: 'trust' });
      expect(answer(none).content).toContain("That isn't someone I can put on a list.");
      expect(e.access.save).not.toHaveBeenCalled();
      const unknown = await run(e, { subcommand: 'purge' });
      expect(answer(unknown).content).toBe('Unknown command.');
    });
  });

  /**
   * A reply names the people on a list, and looking at it must never notify any of them.
   * The router has already deferred, so the answer is an edit, and the deferral itself
   * is ephemeral.
   */
  describe('answers privately', () => {
    it.each(['trust', 'block', 'admit', 'remove', 'list', 'clear'])(
      '/access %s defers ephemerally, then edits with mentions suppressed',
      async (sub) => {
        const e = accessEnv();
        const f = await run(e, { subcommand: sub, ...member() });
        expect(f.interaction.deferReply).toHaveBeenCalledWith({ flags: EPHEMERAL });
        expect(f.reply).not.toHaveBeenCalled();
        expect(f.editReply).toHaveBeenCalledTimes(1);
        expect(answer(f).allowedMentions).toEqual({ parse: [] });
        expect(answer(f).content.startsWith('✅ ')).toBe(true);
      },
    );

    it('puts a service refusal behind the warning sign, and still counts the command, which ran', async () => {
      const countCommand = vi.fn();
      const e = accessEnv(undefined, {
        access: {
          save: vi.fn().mockResolvedValue({ ok: false, message: 'That is you.' }),
        } as never,
        countCommand,
      });
      const f = await run(e, { subcommand: 'trust', ...member() });
      expect(answer(f).content).toBe('⚠️ That is you.');
      expect(countCommand).toHaveBeenCalledWith('access');
    });
  });

  // -- /restrict --------------------------------------------------------------

  /**
   * A rule on Saved lists stops the three subcommands that put somebody on a list or let
   * them in, and never the three that take back or show: a denied member can still empty a
   * list they filled before the rule, and read it.
   */
  describe('and /restrict', () => {
    const DENY = { access: { users: [KAY] } };
    const REFUSAL = 'A server admin has turned off **Saved lists** for you.';

    it.each(['trust', 'block', 'admit'])(
      'refuses /access %s for a member denied Saved lists, before it defers, and does nothing',
      async (sub) => {
        const e = accessEnv(DENY);
        const f = await run(e, { subcommand: sub, ...member() });
        expect(JSON.stringify(f.reply.mock.calls[0]?.[0])).toContain(REFUSAL);
        expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
        expect(f.interaction.deferReply).not.toHaveBeenCalled();
        expect(e.access.save).not.toHaveBeenCalled();
        expect(e.privacy.admit).not.toHaveBeenCalled();
      },
    );

    it.each(['remove', 'clear', 'list'])(
      'never refuses /access %s, which is how a member erases or checks what they saved',
      async (sub) => {
        const e = accessEnv(DENY);
        const f = await run(e, { subcommand: sub, ...member() });
        expect(JSON.stringify(f.editReply.mock.calls)).not.toContain(
          'A server admin has turned off',
        );
        expect(f.interaction.deferReply).toHaveBeenCalled();
      },
    );

    /**
     * `/access list` stays open to them, and its reply says their lists apply to their rooms,
     * which is false while the rule stands. The interaction layer is the only place that knows
     * who they are, so it says so, and says it only for a member the rule reaches.
     */
    it('tells /access list a member denied Saved lists has lists that apply to nothing', async () => {
      const e = accessEnv(DENY);
      await run(e, { subcommand: 'list' });
      expect(e.access.list).toHaveBeenCalledWith('g1', KAY, { inert: true });
    });

    it.each([
      ['a rule that names somebody else', { access: { users: [BOB] } }, {}],
      ['a member who can manage channels', DENY, { manageChannels: true }],
      ['no rules at all', undefined, {}],
    ] as const)('does not for %s', async (_what, rules, opts) => {
      const e = accessEnv(rules);
      await run(e, { subcommand: 'list', ...opts });
      expect(e.access.list).toHaveBeenCalledWith('g1', KAY, { inert: false });
    });

    it('does not while enforcement is paused, which withdraws every rule', async () => {
      const e = accessEnv(DENY, { commandAccessDisabled: () => Promise.resolve(true) });
      await run(e, { subcommand: 'list' });
      expect(e.access.list).toHaveBeenCalledWith('g1', KAY, { inert: false });
    });

    it('is told by role too, in both shapes the member arrives in', async () => {
      const ROLE = '333333333333333333';
      for (const shape of ['guildMember', 'raw'] as const) {
        const e = accessEnv({ access: { roles: [ROLE] } });
        await run(e, { subcommand: 'list', memberRoles: [ROLE], memberShape: shape });
        expect(e.access.list, shape).toHaveBeenCalledWith('g1', KAY, { inert: true });
        dispose?.();
      }
    });

    it('lets a member through who is not denied, and one who can manage channels', async () => {
      const e = accessEnv({ access: { users: [BOB] } });
      await run(e, { subcommand: 'trust', ...member() });
      expect(e.access.save).toHaveBeenCalledTimes(1);
      dispose?.();
      const manager = accessEnv(DENY);
      await run(manager, { subcommand: 'trust', manageChannels: true, ...member() });
      expect(manager.access.save).toHaveBeenCalledTimes(1);
    });

    it('applies to the command in the role shape too', async () => {
      const ROLE = '333333333333333333';
      for (const shape of ['guildMember', 'raw'] as const) {
        const e = accessEnv({ access: { roles: [ROLE] } });
        const f = await run(e, {
          subcommand: 'block',
          memberRoles: [ROLE],
          memberShape: shape,
          ...member(),
        });
        expect(JSON.stringify(f.reply.mock.calls[0]?.[0]), shape).toContain(REFUSAL);
        dispose?.();
      }
    });

    it('is not counted when refused, and is when it ran', async () => {
      const countCommand = vi.fn();
      const refused = accessEnv(DENY, { countCommand });
      await run(refused, { subcommand: 'trust', ...member() });
      expect(countCommand).not.toHaveBeenCalled();
      dispose?.();
      const ran = accessEnv(undefined, { countCommand });
      await run(ran, { subcommand: 'list' });
      expect(countCommand).toHaveBeenCalledWith('access');
    });
  });

  // -- the hard gate ------------------------------------------------------------------

  /**
   * The hard gate stops writes and destroys nothing, so what only removes or shows stays
   * open, as `/restrict`'s and `/botprofile`'s resets do, and what puts somebody on a list
   * or lets them in is refused with the reactivation notice.
   */
  describe('in a hard-gated guild', () => {
    const gated = () =>
      accessEnv(undefined, {
        guilds: {
          get: vi.fn().mockResolvedValue({ authStatus: 'expired' }),
          isEntitled: vi.fn().mockResolvedValue(false),
        } as never,
        selfHosted: false,
      });

    it.each(['trust', 'block', 'admit'])('refuses /access %s', async (sub) => {
      const e = gated();
      const f = await run(e, { subcommand: sub, ...member() });
      expect(JSON.stringify(f.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
      expect(e.access.save).not.toHaveBeenCalled();
      expect(e.privacy.admit).not.toHaveBeenCalled();
    });

    it.each(['remove', 'clear', 'list'])('still answers /access %s', async (sub) => {
      const e = gated();
      const f = await run(e, { subcommand: sub, ...member() });
      expect(JSON.stringify(f.editReply.mock.calls[0]?.[0])).not.toContain('auto-voice.io');
      expect(f.editReply).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * The knock card and the two ways to kick answer after work that is no longer a
 * pair of REST calls: a block saves to the owner's list, applies it to the room and
 * moves the requester out, and a kick records itself, writes the room's overwrites
 * and disconnects the member. None of them used to defer, and a token that lives
 * 3 seconds is then the whole budget, so each acknowledges first and answers by
 * editing or following up.
 */
describe('registerInteractionHandler (the knock card and the kick vote)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const OWNER = 'alice';
  const joinContext = {
    channelId: 'join-1',
    guildId: 'g1',
    secondaryChannelId: 'room-1',
    creatorId: OWNER,
  };

  /** One knock-card click, with the service call and the acknowledgement put in order. */
  async function click(
    action: 'approve' | 'always' | 'deny' | 'block',
    over: {
      userId?: string;
      context?: typeof joinContext | undefined;
      result?: object;
      /** The guild's `command_access` rules, which Always allow is guarded by. */
      rules?: Record<string, unknown>;
      /** The guild row's status, for a hard-gated guild. */
      authStatus?: string;
      manageChannels?: boolean;
    } = {},
  ) {
    // Posting the rejection to the lobby's chat goes through the client, so it is a spy.
    const fetchChannel = vi.fn().mockResolvedValue(null);
    const client = Object.assign(new EventEmitter(), { channels: { fetch: fetchChannel } });
    const fake = fakeInteraction({
      kind: 'button',
      customId: action === 'always' ? alwaysId('join-1', 'bob') : joinId(action, 'join-1', 'bob'),
      userId: over.userId ?? OWNER,
      ...(over.manageChannels ? { manageChannels: true } : {}),
    });
    const order: string[] = [];
    let finish: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => (finish = resolve));
    const decide = vi.fn().mockImplementation(async () => {
      order.push(fake.interaction.deferred ? 'service after defer' : 'service before defer');
      await settled;
      return over.result ?? { ok: true, message: 'Done.' };
    });
    const env = setup({
      client: client as never,
      privacy: {
        getJoinContext: vi.fn().mockResolvedValue('context' in over ? over.context : joinContext),
        approveJoin: decide,
        denyJoin: decide,
      } as never,
      ...(over.rules || over.authStatus
        ? {
            guilds: {
              get: vi.fn().mockResolvedValue({
                authStatus: over.authStatus ?? 'active',
                ...(over.rules ? { settings: { command_access: over.rules } } : {}),
              }),
              isEntitled: vi.fn().mockResolvedValue(over.authStatus === undefined),
            } as never,
            ...(over.authStatus ? { selfHosted: false } : {}),
          }
        : {}),
    });
    dispose = env.dispose;
    client.emit('interactionCreate', fake.interaction);
    await flush();
    return { ...fake, order, decide, fetchChannel, finish: () => finish?.() };
  }

  it.each(['approve', 'always', 'deny', 'block'] as const)(
    'acknowledges %s before it does the work, then edits the card',
    async (action) => {
      const c = await click(action);
      // The work is still running and the token is already answered.
      expect(c.interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(c.order).toEqual(['service after defer']);
      expect(c.interaction.update).not.toHaveBeenCalled();
      expect(c.editReply).not.toHaveBeenCalled();

      c.finish();
      await flush();
      expect(c.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining('Done.'),
        components: [],
      });
      expect(c.interaction.update).not.toHaveBeenCalled();
      expect(c.reply).not.toHaveBeenCalled();
    },
  );

  it('passes the choice on: a block blocks, a deny does not', async () => {
    const block = await click('block');
    block.finish();
    expect(block.decide).toHaveBeenCalledWith('join-1', 'bob', true);
    dispose?.();
    const deny = await click('deny');
    deny.finish();
    expect(deny.decide).toHaveBeenCalledWith('join-1', 'bob', false);
  });

  /** A plain approval takes exactly the two arguments it always did. */
  it('passes Approve on as it always was, and Always allow as an approval that saves', async () => {
    const approve = await click('approve');
    approve.finish();
    expect(approve.decide).toHaveBeenCalledWith('join-1', 'bob');
    dispose?.();
    const always = await click('always');
    always.finish();
    expect(always.decide).toHaveBeenCalledWith('join-1', 'bob', true);
  });

  it('puts the result of Always allow on the card with the buttons gone, and tells nobody else', async () => {
    const c = await click('always', { result: { ok: true, message: 'Admitted <@bob>.' } });
    c.finish();
    await flush();
    expect(c.editReply).toHaveBeenCalledWith({
      content: '✅ Admitted <@bob>.',
      components: [],
    });
    expect(c.interaction.update).not.toHaveBeenCalled();
    // Approving is not a rejection, so nothing is posted to the join channel's chat, where
    // the same message would otherwise tell somebody who was just let in they were declined.
    expect(c.fetchChannel).not.toHaveBeenCalled();
  });

  it('still tells the lobby when a request was declined or blocked', async () => {
    for (const action of ['deny', 'block'] as const) {
      const c = await click(action);
      c.finish();
      await flush();
      expect(c.fetchChannel, action).toHaveBeenCalledWith('join-1');
      dispose?.();
    }
  });

  it('turns away Always allow from anyone but the owner, and an expired card, like the others', async () => {
    const stranger = await click('always', { userId: 'mallory' });
    expect(stranger.decide).not.toHaveBeenCalled();
    expect(stranger.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(stranger.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Only the channel owner can answer this request.',
        ephemeral: true,
      }),
    );
    dispose?.();
    const expired = await click('always', { context: undefined });
    expect(expired.decide).not.toHaveBeenCalled();
    expect(expired.interaction.update).toHaveBeenCalledWith({
      content: 'This request has expired.',
      components: [],
    });
  });

  describe('Always allow and /restrict', () => {
    const KAY = '111111111111111111';
    const DENY_SAVED = { access: { users: [KAY] } };

    /** It saves to the owner's trusted list, so the rule that stops `/access trust` stops it. */
    it('is refused for an owner denied Saved lists, before it is acknowledged, and nothing is done', async () => {
      const c = await click('always', {
        userId: KAY,
        context: { ...joinContext, creatorId: KAY },
        rules: DENY_SAVED,
      });
      expect(c.decide).not.toHaveBeenCalled();
      expect(c.interaction.deferUpdate).not.toHaveBeenCalled();
      expect(c.interaction.update).not.toHaveBeenCalled();
      expect(JSON.stringify(c.reply.mock.calls[0]?.[0])).toContain(
        'A server admin has turned off **Saved lists** for you.',
      );
      expect(c.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    });

    it('leaves a plain Approve, Deny and Block open to the same owner', async () => {
      for (const action of ['approve', 'deny', 'block'] as const) {
        const c = await click(action, {
          userId: KAY,
          context: { ...joinContext, creatorId: KAY },
          rules: DENY_SAVED,
        });
        expect(c.decide, action).toHaveBeenCalled();
        dispose?.();
      }
    });

    it('lets an owner who can manage channels use it whatever the rule says', async () => {
      const c = await click('always', {
        userId: KAY,
        context: { ...joinContext, creatorId: KAY },
        rules: DENY_SAVED,
        manageChannels: true,
      });
      expect(c.decide).toHaveBeenCalledWith('join-1', 'bob', true);
    });

    it('is not refused for an owner the rule does not name', async () => {
      const c = await click('always', { rules: DENY_SAVED });
      expect(c.decide).toHaveBeenCalledWith('join-1', 'bob', true);
    });
  });

  /**
   * Every write is refused in a hard-gated guild, the three older buttons included, and
   * Always allow is one: a knock card left over from before the gate does nothing.
   */
  it('refuses Always allow in a hard-gated guild with the reactivation notice', async () => {
    const c = await click('always', { authStatus: 'expired' });
    expect(c.decide).not.toHaveBeenCalled();
    expect(JSON.stringify(c.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
  });

  it('puts a failure on the card too, with the buttons gone', async () => {
    const c = await click('block', { result: { ok: false, message: 'Could not block <@bob>.' } });
    c.finish();
    await flush();
    expect(c.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('Could not block <@bob>.'),
      components: [],
    });
  });

  /**
   * `room_access.disabled` refuses an Always allow and says to use Approve. The card was
   * already acknowledged, and turning it into the refusal would take Approve off it, so
   * the owner would be told to press a button that no longer exists while the requester
   * waits in the lobby. The refusal is for the owner alone and the card stays as it was.
   */
  it('keeps every button on the card when Always allow is refused and nothing was decided', async () => {
    const refusal = {
      ok: false,
      message: 'Always allow is switched off for now. Use **Approve** to let them in this time.',
      keepCard: true,
    };
    const c = await click('always', { result: refusal });
    c.finish();
    await flush();
    expect(c.editReply).not.toHaveBeenCalled();
    expect(c.interaction.update).not.toHaveBeenCalled();
    expect(c.followUp).toHaveBeenCalledTimes(1);
    expect(c.followUp).toHaveBeenCalledWith({
      content: `⚠️ ${refusal.message}`,
      flags: MessageFlags.Ephemeral,
    });
    // Nothing is posted to the lobby either: nobody was turned away.
    expect(c.fetchChannel).not.toHaveBeenCalled();
  });

  it('still takes the buttons off the card for a failure that did decide something', async () => {
    const c = await click('always', {
      result: { ok: false, message: '<@bob> is on your blocked list, so I did not let them in.' },
    });
    c.finish();
    await flush();
    expect(c.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('is on your blocked list'),
      components: [],
    });
    expect(c.followUp).not.toHaveBeenCalled();
  });

  it('turns away a click from anyone but the owner without deferring or doing anything', async () => {
    const c = await click('block', { userId: 'mallory' });
    expect(c.decide).not.toHaveBeenCalled();
    expect(c.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Only the channel owner can answer this request.',
        ephemeral: true,
      }),
    );
  });

  it('says an expired request has expired, on the card, without doing anything', async () => {
    const c = await click('approve', { context: undefined });
    expect(c.decide).not.toHaveBeenCalled();
    expect(c.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(c.interaction.update).toHaveBeenCalledWith({
      content: 'This request has expired.',
      components: [],
    });
  });

  // -- /kick -----------------------------------------------------------------------

  async function kick(
    over: {
      start?: object;
      hasSession?: boolean;
      startImpl?: () => Promise<object>;
    } = {},
  ) {
    const order: string[] = [];
    const start = vi.fn().mockImplementation(() => {
      order.push('start');
      return (
        over.startImpl?.() ??
        Promise.resolve(over.start ?? { ok: true, message: 'Vote started.', required: 2, epoch: 1 })
      );
    });
    const env = setup({
      votekick: {
        start,
        hasSession: vi.fn().mockReturnValue(over.hasSession ?? true),
        cancel: vi.fn(),
      } as never,
    });
    dispose = env.dispose;
    const fake = fakeInteraction({
      kind: 'command',
      commandName: 'kick',
      voiceChannelId: 'room-1',
    });
    fake.interaction.deferReply.mockImplementation(() => {
      order.push('defer');
      fake.interaction.deferred = true;
      return Promise.resolve(undefined);
    });
    env.client.emit('interactionCreate', fake.interaction);
    await flush();
    return { ...fake, order, start };
  }

  it('/kick defers publicly before it starts the vote, and posts the vote by editing', async () => {
    const k = await kick();
    expect(k.order).toEqual(['defer', 'start']);
    // Public: the vote is this message, so nothing makes it ephemeral.
    expect(k.interaction.deferReply).toHaveBeenCalledWith();
    expect(k.reply).not.toHaveBeenCalled();
    const posted = k.editReply.mock.calls[0]?.[0] as { content: string; components: unknown[] };
    expect(posted.content).toContain('started a vote to kick');
    expect(posted.components).toHaveLength(1);
  });

  it('/kick answers a vote that resolved at once by editing, and arms no timer for it', async () => {
    const k = await kick({
      start: { ok: true, message: '<@u2> was kicked.', required: 1, epoch: 1 },
      hasSession: false,
    });
    expect(k.order).toEqual(['defer', 'start']);
    expect(k.editReply).toHaveBeenCalledWith({ content: '✅ <@u2> was kicked.' });
  });

  it('/kick takes the public acknowledgement back and tells only the caller about a refusal', async () => {
    const k = await kick({ start: { ok: false, message: "That member isn't in this channel." } });
    expect(k.order).toEqual(['defer', 'start']);
    expect(k.interaction.deleteReply).toHaveBeenCalledTimes(1);
    expect(k.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "That member isn't in this channel.",
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(k.editReply).not.toHaveBeenCalled();
  });

  it('/kick takes the public acknowledgement back when starting the vote throws', async () => {
    const k = await kick({ startImpl: () => Promise.reject(new Error('boom')) });
    expect(k.interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  // -- the vote button -----------------------------------------------------------------

  async function vote(result: object) {
    const fake = fakeInteraction({ kind: 'button', customId: 'avc:kick:room-1' });
    const order: string[] = [];
    const cast = vi.fn().mockImplementation(() => {
      order.push(fake.interaction.deferred ? 'vote after defer' : 'vote before defer');
      return Promise.resolve(result);
    });
    const env = setup({ votekick: { vote: cast, cancel: vi.fn() } as never });
    dispose = env.dispose;
    env.client.emit('interactionCreate', fake.interaction);
    await flush();
    return { ...fake, order, cast };
  }

  it('the deciding vote defers before it kicks, then edits the vote message', async () => {
    const v = await vote({ ok: true, resolved: true, kicked: true, message: '<@u2> was kicked.' });
    expect(v.order).toEqual(['vote after defer']);
    expect(v.editReply).toHaveBeenCalledWith({ content: '✅ <@u2> was kicked.', components: [] });
    expect(v.interaction.update).not.toHaveBeenCalled();
  });

  it('a vote that does not decide it is acknowledged first and answered privately', async () => {
    const v = await vote({
      ok: true,
      resolved: false,
      kicked: false,
      message: 'Vote recorded (2/3).',
    });
    expect(v.order).toEqual(['vote after defer']);
    expect(v.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Vote recorded (2/3).', flags: MessageFlags.Ephemeral }),
    );
    expect(v.reply).not.toHaveBeenCalled();
    expect(v.editReply).not.toHaveBeenCalled();
  });

  it('a refused vote is acknowledged first and answered privately', async () => {
    const v = await vote({
      ok: false,
      resolved: false,
      kicked: false,
      message: "You're not eligible to vote in this channel.",
    });
    expect(v.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You're not eligible to vote in this channel.",
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(v.editReply).not.toHaveBeenCalled();
  });
});

/**
 * The panel's "More settings" select, and the modal submits that refresh the
 * panel they were opened from.
 *
 * Both are places where an action could quietly become reachable to someone who
 * should not have it, or stop being reachable at all.
 */
describe('registerInteractionHandler (/setup panel)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const settingsSelect = (values: string[], opts: { manageChannels?: boolean } = {}) =>
    fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values,
      manageChannels: opts.manageChannels ?? true,
    });

  it('routes a chosen setting to the action its option names', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = settingsSelect([setupId('logging')]);
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('toggles automation from the select and refreshes the panel in place', async () => {
    const base = setup();
    base.dispose();
    const setEnabled = vi.fn().mockResolvedValue({ ok: true, message: 'paused' });
    const env = setup({ settings: { ...base.settings, setEnabled } as never });
    dispose = env.dispose;
    const { interaction, editReply } = settingsSelect([setupId('toggle')]);
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(setEnabled).toHaveBeenCalledWith('g1', false);
    expect(editReply).toHaveBeenCalled();
  });

  /**
   * Re-reads rather than trusting the panel it was clicked from: two admins
   * with the panel open would otherwise flip each other's change back.
   */
  it('flips the tied-games mode from the freshly-read value', async () => {
    const base = setup();
    base.dispose();
    const setGameNameMode = vi.fn().mockResolvedValue({ ok: true, message: 'one game' });
    const getConfig = vi.fn().mockResolvedValue({
      enabled: true,
      primaries: [],
      aliases: {},
      lists: {},
      gameNameMode: 'top',
    });
    const env = setup({
      settings: { ...base.settings, getConfig, setGameNameMode } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = settingsSelect([setupId('gamemode')]);
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(setGameNameMode).toHaveBeenCalledWith('g1', 'shared');
    // The note is the only feedback: the new value lives inside a closed
    // select's option description, so a silent refresh tells the admin nothing.
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('one game');
  });

  it('refuses the select to someone without Manage Channels', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = settingsSelect([setupId('logging')], { manageChannels: false });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Manage Channels');
  });

  /**
   * The same carve-out the assistant BUTTON has. The panel hides this option in
   * an expired guild, but the option is chosen client-side, so the route gate is
   * the half that enforces it.
   */
  it('refuses the assistant through the select in an expired guild', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = settingsSelect([setupId('assistant')]);
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
  });

  /** Logging and the label are why the panel is exempt from the hard gate. */
  it('still allows logging through the select in an expired guild', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction } = settingsSelect([setupId('logging')]);
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).toHaveBeenCalled();
  });

  it('runs nothing for a select value that is not a panel action', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = settingsSelect(['avc:tpl:edit:primary:name:1']);
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(env.settings.setLogging).not.toHaveBeenCalled();
  });

  /**
   * The picker sets message content ("Pick a voice channel to manage:"). An
   * omitted `content` is dropped from the edit rather than cleared, so the panel
   * would render underneath that stranded prompt.
   */
  it('returns to the panel from a picker, clearing the picker prompt', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: setupId('open'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const payload = editReply.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).toContain('embeds');
    expect(payload.content).toBeNull();
  });

  /**
   * Reachable during a rolling deploy: a panel rendered by a new machine, and an
   * older one still owning the shard. Falling off the end silently is what
   * Discord shows as "This interaction failed".
   */
  it('answers a panel control it does not recognise', async () => {
    const env = setup();
    dispose = env.dispose;
    const button = fakeInteraction({
      kind: 'button',
      customId: setupId('nonesuch'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', button.interaction);
    await flush();
    expect(JSON.stringify(button.reply.mock.calls[0]?.[0])).toContain('out of date');

    const select = settingsSelect(['avc:tpl:edit:primary:name:1']);
    env.client.emit('interactionCreate', select.interaction);
    await flush();
    expect(JSON.stringify(select.reply.mock.calls[0]?.[0])).toContain('out of date');
  });

  /**
   * A create from the panel updates the panel, rather than leaving it showing a
   * creator channel count that is now one short.
   */
  it('refreshes the panel after a create started from it', async () => {
    const settings = {
      getConfig: vi.fn().mockResolvedValue({
        enabled: true,
        primaries: [{ channelId: 'p1' }],
        defaultTemplate: 'T',
        defaultStatus: 'S',
        lists: {},
      }),
      createPrimary: vi.fn().mockResolvedValue({ ok: true, message: 'Created <#new1>.' }),
      recordContact: vi.fn().mockResolvedValue(undefined),
    };
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, reply, editReply } = fakeInteraction({
      kind: 'modal',
      customId: CREATE_FROM_SETUP_MODAL_ID,
      manageChannels: true,
      fromMessage: true,
      textInputs: { name: 'Lobby', nameTemplate: 'T', statusTemplate: 'S' },
      selectedChannelId: 'cat1',
      existingChannels: ['p1'],
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(settings.createPrimary).toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    const panel = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(panel).toContain('Creator channels (1)');
    expect(panel).toContain('Created <#new1>.');
    // The panel carries its own create button, so the result needs no second one.
    expect(panel).not.toContain('avc:create:again');
  });

  /**
   * The failure path has already deferred, so `reply` would throw. Nothing was
   * created, so the panel behind it is still accurate and is left alone.
   */
  it('follows up rather than replying when a panel create fails', async () => {
    const settings = {
      getConfig: vi.fn().mockResolvedValue({
        enabled: true,
        primaries: [],
        defaultTemplate: 'T',
        defaultStatus: 'S',
      }),
      createPrimary: vi.fn().mockRejectedValue(missingPermissions()),
    };
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, reply, followUp } = fakeInteraction({
      kind: 'modal',
      customId: CREATE_FROM_SETUP_MODAL_ID,
      manageChannels: true,
      fromMessage: true,
      id: 'modal-9',
      textInputs: { name: 'Lobby', nameTemplate: 'T', statusTemplate: 'S' },
      selectedChannelId: 'cat1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalled();
    expect(env.reportError).not.toHaveBeenCalled();
    expect(JSON.stringify(followUp.mock.calls[0]?.[0])).toContain('avc:create:retry:modal-9');
  });

  /**
   * The slash command has no panel behind it, so it keeps the plain reply. Same
   * modal either way, so only the origin can tell the two apart.
   */
  it('replies plainly to a create from the slash command', async () => {
    const settings = {
      getConfig: vi.fn().mockResolvedValue({
        enabled: true,
        primaries: [],
        defaultTemplate: 'T',
        defaultStatus: 'S',
      }),
      createPrimary: vi.fn().mockResolvedValue({ ok: true, message: 'Created <#new1>.' }),
      recordContact: vi.fn().mockResolvedValue(undefined),
    };
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, reply, editReply } = fakeInteraction({
      kind: 'modal',
      customId: CREATE_MODAL_ID,
      manageChannels: true,
      textInputs: { name: 'Lobby', nameTemplate: 'T', statusTemplate: 'S' },
      selectedChannelId: 'cat1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(editReply).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('avc:create:again');
  });

  /**
   * The modal's privacy choice reaches `createPrimary` as the stored pair. `parseCreateModal`
   * and `createPrimary` are each tested on their own, and `handleCreateSubmit` hands the one
   * to the other with nothing but a type between them, which does not cover a test file.
   */
  it.each([
    ['open', {}],
    ['private', { defaultPrivate: true }],
    ['hidden', { defaultPrivate: true, defaultHidden: true }],
  ] as const)(
    'creates a creator channel from a %s choice in the /create modal',
    async (privacy, stored) => {
      const settings = {
        getConfig: vi.fn().mockResolvedValue({
          enabled: true,
          primaries: [],
          defaultTemplate: 'T',
          defaultStatus: 'S',
        }),
        createPrimary: vi.fn().mockResolvedValue({ ok: true, message: 'Created <#new1>.' }),
        recordContact: vi.fn().mockResolvedValue(undefined),
      };
      const env = setup({ settings: settings as never });
      dispose = env.dispose;
      const { interaction } = fakeInteraction({
        kind: 'modal',
        customId: CREATE_MODAL_ID,
        manageChannels: true,
        textInputs: { name: 'Lobby', nameTemplate: 'T', statusTemplate: 'S' },
        selectedChannelId: 'cat1',
        privacy,
      });
      env.client.emit('interactionCreate', interaction);
      await flush();

      expect(settings.createPrimary).toHaveBeenCalledTimes(1);
      const sent = settings.createPrimary.mock.calls[0]![1] as Record<string, unknown>;
      expect(sent).toMatchObject({ name: 'Lobby', parentId: 'cat1', ...stored });
      // Only the keys the choice stores: a private choice carries no `defaultHidden` and an open
      // one carries neither, so a stored `false` never stands in for an absent key.
      expect('defaultPrivate' in sent).toBe(privacy !== 'open');
      expect('defaultHidden' in sent).toBe(privacy === 'hidden');
    },
  );

  it('refreshes the panel after logging saved from it, and replies from /logging', async () => {
    const env = setup();
    dispose = env.dispose;
    // `off`, so the save skips the "can I post there" check, which needs a
    // channel this fake's cache does not carry. The branch under test is which
    // way the result is delivered, not what was saved.
    const level = { level: ['off'] };
    const fromPanel = fakeInteraction({
      kind: 'modal',
      customId: LOGGING_MODAL_ID,
      manageChannels: true,
      fromMessage: true,
      selectValues: level,
    });
    env.client.emit('interactionCreate', fromPanel.interaction);
    await flush();
    expect(env.settings.setLogging).toHaveBeenCalled();
    expect(fromPanel.reply).not.toHaveBeenCalled();
    expect(fromPanel.editReply).toHaveBeenCalled();

    const fromCommand = fakeInteraction({
      kind: 'modal',
      customId: LOGGING_MODAL_ID,
      manageChannels: true,
      selectValues: level,
    });
    env.client.emit('interactionCreate', fromCommand.interaction);
    await flush();
    expect(fromCommand.reply).toHaveBeenCalled();
    expect(fromCommand.editReply).not.toHaveBeenCalled();
  });

  /**
   * The label modal is the other panel-borne write, and shares the branch.
   */
  it('refreshes the panel after the label is saved from it', async () => {
    const base = setup();
    base.dispose();
    const setGeneral = vi.fn().mockResolvedValue({ ok: true, message: 'Set to Chatting.' });
    const env = setup({ settings: { ...base.settings, setGeneral } as never });
    dispose = env.dispose;
    const { interaction, reply, editReply } = fakeInteraction({
      kind: 'modal',
      customId: GENERAL_MODAL_ID,
      manageChannels: true,
      fromMessage: true,
      textInputs: { label: 'Chatting' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(setGeneral).toHaveBeenCalledWith('g1', 'Chatting');
    expect(reply).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Set to Chatting.');
  });
});

/**
 * `/channelinfo`, whose gating is the interesting part.
 *
 * It is the one command open to every member that can be pointed at a channel
 * by id, so the tests below are mostly about that seam: who may use the option,
 * and whether the id they supply is bound to what they can already see.
 */
describe('/channelinfo', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const ROOM = 'vc1';
  const OTHER = 'vc2';

  /** A `ChannelInfo` thin enough for the router, thick enough for the panel. */
  const channelInfo = {
    channelId: ROOM,
    kind: 'room' as const,
    render: {
      ctx: { index: 0, members: [], aliases: {}, general: 'General', userLimit: 0 },
      synthetic: false,
      nameTemplate: 'Room ##',
      nameSource: 'creator' as const,
      statusTemplate: '',
      statusSource: 'server' as const,
    },
    ownerId: null,
    originalCreator: null,
    userLimit: 0,
    isPrivate: false,
    members: { total: 0, bots: 0 },
    game: 'General',
    rawGames: ['General'],
    general: 'General',
    enabled: true,
    aliasCount: 0,
  };

  function infoEnv(overrides: Partial<InteractionDeps> = {}) {
    return setup({
      feature: { channelInfo: vi.fn().mockResolvedValue(channelInfo) } as never,
      ...overrides,
    });
  }

  const visible = { [ROOM]: { name: 'Room #1', callerCanSee: true } };

  it('answers a member standing in a voice channel', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      voiceChannelId: ROOM,
      voiceChannels: visible,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Channel info');
  });

  /**
   * The count of members with saved settings is read for the admin section and shown nowhere
   * else, so a member who will never see it must not cause the read, on the one command any
   * member can run. The command and every view button repeat it, so both are pinned.
   */
  it('asks for the saved-settings count only when the viewer is an admin', async () => {
    for (const [manageChannels, savedCount] of [
      [false, false],
      [true, true],
    ] as const) {
      const env = infoEnv();
      const { interaction } = fakeInteraction({
        kind: 'command',
        commandName: 'channelinfo',
        manageChannels,
        voiceChannelId: ROOM,
        voiceChannels: visible,
      });
      env.client.emit('interactionCreate', interaction);
      await flush();
      expect(env.deps.feature.channelInfo).toHaveBeenCalledWith('g1', ROOM, { savedCount });
      env.dispose();
    }
  });

  it('asks for it on a view button by the same rule', async () => {
    for (const [manageChannels, savedCount] of [
      [false, false],
      [true, true],
    ] as const) {
      const env = infoEnv();
      const { interaction } = fakeInteraction({
        kind: 'button',
        customId: `avc:info:tokens:${ROOM}`,
        manageChannels,
        voiceChannels: visible,
      });
      env.client.emit('interactionCreate', interaction);
      await flush();
      expect(env.deps.feature.channelInfo).toHaveBeenCalledWith('g1', ROOM, { savedCount });
      env.dispose();
    }
  });

  it('asks a member with no voice channel to join one', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Join a voice channel');
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('refuses the channel option to a member without Manage Channels', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      optionChannelId: OTHER,
      voiceChannels: { [OTHER]: { name: 'Secret', callerCanSee: true } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Manage Channels');
    expect(env.deps.feature.channelInfo).not.toHaveBeenCalled();
  });

  /**
   * The leak this check exists to close. Discord's picker only offers channels
   * the member can see, but the API does not enforce it, so without binding the
   * id to the caller an admin could read who is sitting in a private voice
   * channel they were never admitted to.
   */
  it('refuses a channel the caller cannot see, even with Manage Channels', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      manageChannels: true,
      optionChannelId: OTHER,
      voiceChannels: { [OTHER]: { name: 'Secret', callerCanSee: false } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("can't show you");
    expect(env.deps.feature.channelInfo).not.toHaveBeenCalled();
  });

  it('refuses a channel that is not in the cache at all (fails closed)', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      manageChannels: true,
      optionChannelId: 'never-heard-of-it',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("can't show you");
  });

  it('lets an admin inspect a creator channel they can see', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      manageChannels: true,
      optionChannelId: OTHER,
      voiceChannels: { [OTHER]: { name: 'Join to create', callerCanSee: true } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.deps.feature.channelInfo).toHaveBeenCalledWith('g1', OTHER, { savedCount: true });
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Channel info');
  });

  /**
   * The guild whose breaker is tripped is exactly the guild somebody is running
   * this command on to find out what is wrong, so a refused dispatch has to say
   * that rather than fall into the router's generic catch.
   */
  it('explains a refused dispatch instead of erroring', async () => {
    const env = infoEnv({
      dispatcher: {
        dispatch: () => Promise.reject(new Error('circuit open')),
      } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      voiceChannelId: ROOM,
      voiceChannels: visible,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('backing off');
    expect(env.reportError).not.toHaveBeenCalled();
  });

  /**
   * The switch is read AFTER the defer, deliberately: it is a load lever, and
   * spending an uncached flag read on the three-second budget during the
   * incident it exists for is how the member gets "The application did not
   * respond" instead of the notice. So this answers by `editReply`.
   */
  it('answers politely while the kill-switch is set, after deferring', async () => {
    const env = infoEnv({
      flags: { getBool: vi.fn().mockResolvedValue(true) } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      voiceChannelId: ROOM,
      voiceChannels: visible,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('switched off');
    expect(env.deps.feature.channelInfo).not.toHaveBeenCalled();
  });

  /**
   * The ordering the lever depends on: nothing that needs the database may run
   * before the interaction is acknowledged.
   */
  it('defers before reading the kill-switch, not after', async () => {
    const order: string[] = [];
    const env = infoEnv({
      flags: {
        getBool: vi.fn().mockImplementation(() => {
          order.push('flag');
          return Promise.resolve(false);
        }),
      } as never,
    });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      voiceChannelId: ROOM,
      voiceChannels: visible,
    });
    interaction.deferReply = vi.fn().mockImplementation(() => {
      order.push('defer');
      interaction.deferred = true;
      return Promise.resolve(undefined);
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(order).toEqual(['defer', 'flag']);
  });

  /** A flag read that fails must not take the command with it. */
  it('stays available when the flag read fails', async () => {
    const env = infoEnv({
      flags: { getBool: vi.fn().mockRejectedValue(new Error('db down')) } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      voiceChannelId: ROOM,
      voiceChannels: visible,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Channel info');
  });

  it('still answers in a hard-gated guild, saying the server is paused', async () => {
    const env = infoEnv({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'channelinfo',
      voiceChannelId: ROOM,
      voiceChannels: visible,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const body = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(body).toContain('Channel info');
    expect(body).toContain('paused');
  });

  it('re-checks the caller on a view button, not just on the command', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: `avc:info:tokens:${OTHER}`,
      voiceChannels: { [OTHER]: { name: 'Secret', callerCanSee: false } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("can't show you");
    expect(env.deps.feature.channelInfo).not.toHaveBeenCalled();
  });

  it('renders the requested view from a button', async () => {
    const env = infoEnv();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: `avc:info:tokens:${ROOM}`,
      voiceChannels: visible,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Why this name');
  });
});

/** The two holes that made "just open `/debug` up" the wrong move. */
describe('/debug gating', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  it('refuses a caller without Manage Channels, not just the Discord default', async () => {
    const env = setup({ feature: { debugChannel: vi.fn() } as never });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'debug',
      voiceChannelId: 'vc1',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Manage Channels');
    expect(env.deps.feature.debugChannel).not.toHaveBeenCalled();
  });

  it('refuses a channel the caller cannot see', async () => {
    const env = setup({ feature: { debugChannel: vi.fn() } as never });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'debug',
      manageChannels: true,
      optionChannelId: 'vc2',
      voiceChannels: { vc2: { name: 'Secret', callerCanSee: false } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("can't show you");
    expect(env.deps.feature.debugChannel).not.toHaveBeenCalled();
  });
});

describe('registerInteractionHandler (time zone and named lists)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  /** Everything the two settings surfaces touch, with nothing else stubbed. */
  function settingsFake(over: Record<string, unknown> = {}) {
    return {
      getConfig: vi.fn().mockResolvedValue({
        enabled: true,
        primaries: [],
        aliases: {},
        lists: {},
        timezone: 'Europe/Amsterdam',
      }),
      setTimeZone: vi.fn().mockResolvedValue({ ok: true, message: 'Time zone set.' }),
      listNamedLists: vi.fn().mockResolvedValue({ animals: ['otter', 'badger'] }),
      setNamedList: vi.fn().mockResolvedValue({ ok: true, message: 'Added.' }),
      removeNamedList: vi.fn().mockResolvedValue({ ok: true, message: 'Removed.' }),
      ...over,
    };
  }

  it('opens the time zone modal prefilled from the settings select', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values: [setupId('timezone')],
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    const modal = JSON.stringify(interaction.showModal.mock.calls[0]?.[0]);
    expect(modal).toContain(TIMEZONE_MODAL_ID);
    expect(modal).toContain('Europe/Amsterdam');
  });

  it('saves the submitted zone and refreshes the panel in place', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, reply, editReply } = fakeInteraction({
      kind: 'modal',
      customId: TIMEZONE_MODAL_ID,
      manageChannels: true,
      fromMessage: true,
      textInputs: { zone: 'Asia/Tokyo' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(settings.setTimeZone).toHaveBeenCalledWith('g1', 'Asia/Tokyo');
    expect(reply).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Time zone set.');
  });

  /** A blank submit is how the setting is cleared, so it must reach the service. */
  it('passes a blank zone through rather than treating it as a no-op', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: TIMEZONE_MODAL_ID,
      manageChannels: true,
      fromMessage: true,
      textInputs: { zone: '' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(settings.setTimeZone).toHaveBeenCalledWith('g1', '');
  });

  it('refuses the zone modal without Manage Channels, and writes nothing', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: TIMEZONE_MODAL_ID,
      manageChannels: false,
      fromMessage: true,
      textInputs: { zone: 'Asia/Tokyo' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(settings.setTimeZone).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('Manage Channels');
  });

  it('opens the named-lists panel from the settings select', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values: [setupId('lists')],
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    const panel = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(panel).toContain('Named lists');
    expect(panel).toContain('animals');
  });

  it('opens one list from the picker, then its edit modal prefilled', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const picked = fakeInteraction({
      kind: 'stringSelect',
      customId: LISTS_SELECT_ID,
      values: ['animals'],
      manageChannels: true,
    });
    env.client.emit('interactionCreate', picked.interaction);
    await flush();
    // `respond` edits the message in place for a component interaction, so the
    // detail view arrives through `update`, not `editReply`.
    expect(JSON.stringify(picked.interaction.update.mock.calls[0]?.[0])).toContain(
      '[[list:animals]]',
    );

    const edit = fakeInteraction({
      kind: 'button',
      customId: listsId('edit', 'animals'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', edit.interaction);
    await flush();
    const modal = JSON.stringify(edit.interaction.showModal.mock.calls[0]?.[0]);
    expect(modal).toContain('avc:lists:save:animals');
    expect(modal).toContain('otter');
  });

  /**
   * The name in the custom id is what makes a name change a rename: without it
   * the service would add a second list and leave the first behind.
   */
  it('saves an edit as a rename, carrying the name the modal opened on', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: listsId('save', 'animals'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { name: 'beasts', options: 'otter\nbadger' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(settings.setNamedList).toHaveBeenCalledWith(
      'g1',
      'beasts',
      ['otter', 'badger'],
      'animals',
    );
  });

  it('saves a new list with no previous name', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: listsId('save'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { name: 'animals', options: 'otter' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(settings.setNamedList).toHaveBeenCalledWith('g1', 'animals', ['otter']);
  });

  it('removes a list and reports it on the refreshed panel', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: listsId('remove', 'animals'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(settings.removeNamedList).toHaveBeenCalledWith('g1', 'animals');
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Removed.');
  });

  it('refuses every list action without Manage Channels', async () => {
    const settings = settingsFake();
    const env = setup({ settings: settings as never });
    dispose = env.dispose;
    for (const customId of [listsId('remove', 'animals'), listsId('add')]) {
      const { interaction } = fakeInteraction({ kind: 'button', customId, manageChannels: false });
      env.client.emit('interactionCreate', interaction);
      await flush();
    }
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: listsId('save', 'animals'),
      manageChannels: false,
      fromMessage: true,
      textInputs: { name: 'beasts', options: 'otter' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(settings.removeNamedList).not.toHaveBeenCalled();
    expect(settings.setNamedList).not.toHaveBeenCalled();
  });
});

describe('registerInteractionHandler (the expired-guild carve-out)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  /**
   * `/hide` is a write and is refused like every other, and `/unhide` is open because
   * it is an undo, as is the panel button that does the same thing. Hide's own button
   * is a write and stays refused with the rest of the panel.
   */
  describe('hiding and showing a room', () => {
    const gated = () => {
      const hide = vi.fn().mockResolvedValue({ ok: true, message: 'hidden' });
      const unhide = vi.fn().mockResolvedValue({ ok: true, message: 'shown' });
      const env = setup({
        privacy: { hide, unhide } as never,
        guilds: {
          get: vi.fn().mockResolvedValue({ authStatus: 'expired' }),
          isEntitled: vi.fn().mockResolvedValue(false),
        } as never,
        selfHosted: false,
      });
      dispose = env.dispose;
      return { env, hide, unhide };
    };
    const fire = async (
      env: ReturnType<typeof gated>['env'],
      opts: Parameters<typeof fakeInteraction>[0],
    ) => {
      const fake = fakeInteraction(opts);
      env.client.emit('interactionCreate', fake.interaction);
      await flush();
      return fake;
    };

    it('refuses /hide and the Hide button with the reactivation notice, and does nothing', async () => {
      const g = gated();
      const command = await fire(g.env, {
        kind: 'command',
        commandName: 'hide',
        voiceChannelId: 'v1',
      });
      expect(JSON.stringify(command.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
      const button = await fire(g.env, { kind: 'button', customId: controlPanelId('hide', 'r1') });
      expect(JSON.stringify(button.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
      expect(g.hide).not.toHaveBeenCalled();
    });

    it('lets /unhide and the Unhide button through, since showing a room again is an undo', async () => {
      const g = gated();
      const command = await fire(g.env, {
        kind: 'command',
        commandName: 'unhide',
        voiceChannelId: 'v1',
      });
      expect(JSON.stringify(command.editReply.mock.calls[0]?.[0])).toContain('shown');
      const button = await fire(g.env, {
        kind: 'button',
        customId: controlPanelId('unhide', 'r1'),
      });
      expect(JSON.stringify(button.editReply.mock.calls[0]?.[0])).toContain('shown');
      expect(g.unhide).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * `/unhide` leaves a room LOCKED, with a "⇩ Join" channel nobody can knock on in a guild
   * that is gated, so an owner has to be able to open it. `/public` and the Unlock button
   * only ever remove, which the hard gate allows, and `/private` and its Lock button are
   * writes that stay refused. Without this a guild that lapses with a locked room in it
   * strands the room.
   */
  describe('opening a locked or hidden room', () => {
    const gated = () => {
      const makePublic = vi.fn().mockResolvedValue({ ok: true, message: 'opened' });
      const makePrivate = vi.fn().mockResolvedValue({ ok: true, message: 'locked' });
      const env = setup({
        privacy: { makePublic, makePrivate } as never,
        guilds: {
          get: vi.fn().mockResolvedValue({ authStatus: 'expired' }),
          isEntitled: vi.fn().mockResolvedValue(false),
        } as never,
        selfHosted: false,
      });
      dispose = env.dispose;
      return { env, makePublic, makePrivate };
    };
    const fire = async (
      env: ReturnType<typeof gated>['env'],
      opts: Parameters<typeof fakeInteraction>[0],
    ) => {
      const fake = fakeInteraction(opts);
      env.client.emit('interactionCreate', fake.interaction);
      await flush();
      return fake;
    };

    it('lets /public and the Unlock button through, and does the work', async () => {
      const g = gated();
      const command = await fire(g.env, {
        kind: 'command',
        commandName: 'public',
        voiceChannelId: 'v1',
      });
      expect(JSON.stringify(command.editReply.mock.calls[0]?.[0])).toContain('opened');
      const button = await fire(g.env, {
        kind: 'button',
        customId: controlPanelId('unlock', 'r1'),
      });
      expect(JSON.stringify(button.editReply.mock.calls[0]?.[0])).toContain('opened');
      expect(g.makePublic).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(command.reply.mock.calls)).not.toContain('auto-voice.io');
    });

    it('still refuses /private and the Lock button with the reactivation notice', async () => {
      const g = gated();
      const command = await fire(g.env, {
        kind: 'command',
        commandName: 'private',
        voiceChannelId: 'v1',
      });
      expect(JSON.stringify(command.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
      const button = await fire(g.env, { kind: 'button', customId: controlPanelId('lock', 'r1') });
      expect(JSON.stringify(button.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
      expect(g.makePrivate).not.toHaveBeenCalled();
    });
  });

  /**
   * `/setup` and its settings modals are the exemption that lets a gated admin
   * see and fix their state, and the named-lists PANEL is reachable from the
   * exempt settings select. Its buttons therefore have to be exempt too:
   * otherwise a gated admin is shown a panel whose every button, Close
   * included, answers with the reactivation notice.
   */
  it('lets a gated admin use the named-lists panel it just showed them', async () => {
    const settings = {
      getConfig: vi.fn().mockResolvedValue({ enabled: true, primaries: [], lists: {} }),
      listNamedLists: vi.fn().mockResolvedValue({ animals: ['otter'] }),
      removeNamedList: vi.fn().mockResolvedValue({ ok: true, message: 'Removed.' }),
    };
    const env = setup({
      settings: settings as never,
      guilds: {
        get: vi.fn().mockResolvedValue({ authStatus: 'expired' }),
        isEntitled: vi.fn().mockResolvedValue(false),
      } as never,
      selfHosted: false,
    });
    dispose = env.dispose;

    const opened = fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values: [setupId('lists')],
      manageChannels: true,
    });
    env.client.emit('interactionCreate', opened.interaction);
    await flush();
    expect(JSON.stringify(opened.editReply.mock.calls[0]?.[0])).toContain('Named lists');

    const removed = fakeInteraction({
      kind: 'button',
      customId: listsId('remove', 'animals'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', removed.interaction);
    await flush();
    expect(settings.removeNamedList).toHaveBeenCalledWith('g1', 'animals');
  });
});

describe('registerInteractionHandler (template advice)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const editorState = {
    found: true,
    scope: 'primary' as const,
    name: { effectiveTemplate: 'T', preview: 'T' },
    status: { effectiveTemplate: 'S', preview: 'S' },
  };

  function editorEnv(config: Record<string, unknown>) {
    const settings = {
      getConfig: vi.fn().mockResolvedValue({ enabled: true, primaries: [], lists: {}, ...config }),
      setTemplate: vi.fn().mockResolvedValue({ ok: true, message: 'Saved.' }),
      recordContact: vi.fn().mockResolvedValue(undefined),
    };
    const feature = {
      getEditorState: vi.fn().mockResolvedValue(editorState),
      rerenderSiblings: vi.fn().mockResolvedValue({ rateLimited: [] }),
    };
    return setup({ settings: settings as never, feature: feature as never });
  }

  async function save(env: ReturnType<typeof setup>, template: string): Promise<string> {
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: editorId('save', 'primary', 'name', 'p1'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { template },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    return JSON.stringify(editReply.mock.calls[0]?.[0]);
  }

  /**
   * The structural half. `/template` accepted anything before this was wired up,
   * so an unknown variable rendered the false branch with nothing said.
   */
  it('advises on a hand-typed template the lint can fault', async () => {
    const env = editorEnv({});
    dispose = env.dispose;
    expect(await save(env, '{{NONSENSE ?? a // b}}')).toContain('not a conditional variable');
  });

  /** The guild-shaped half: true of the template only because of what is not set. */
  it('says a date token renders in UTC while no zone is set', async () => {
    const env = editorEnv({});
    dispose = env.dispose;
    const withoutZone = await save(env, '@@weekday@@ room');
    expect(withoutZone).toContain('UTC');

    const zoned = editorEnv({ timezone: 'Europe/Amsterdam' });
    dispose = zoned.dispose;
    expect(await save(zoned, '@@weekday@@ room')).not.toContain('UTC');
  });

  it('names a list the guild does not have, since it would print as written', async () => {
    const env = editorEnv({});
    dispose = env.dispose;
    expect(await save(env, 'The [[list:animals]] room')).toContain('no list called');

    const withList = editorEnv({ lists: { animals: ['otter'] } });
    dispose = withList.dispose;
    const advised = await save(withList, 'The [[list:animals]] room');
    expect(advised).not.toContain('no list called');
    // And a real list is not faulted for having no `/` in it either.
    expect(advised).not.toContain('random picker');
  });

  it('saves the template either way, since advice never refuses', async () => {
    const env = editorEnv({});
    dispose = env.dispose;
    const panel = await save(env, '@@weekday@@ [[list:nope]]');
    expect(panel).toContain('Saved.');
  });
});

/**
 * The room control panel, which is unlike every other panel here in one way
 * that governs the whole design: it is a PERSISTENT, PUBLIC message, posted
 * into a channel many people can read and left there for the life of the room.
 *
 * So the two failure modes worth pinning are the two an ephemeral panel cannot
 * have. A handler that answered with `update()` would replace the panel for
 * everybody on the first press, and a handler that resolved the room from
 * `interaction.channelId` would be wrong in exactly the servers that have
 * companion text channels switched on, where the panel does not sit in the room
 * it controls.
 */
describe('registerInteractionHandler (room control panel)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const voiceCommands = () => ({
    setLimit: vi.fn().mockResolvedValue({ ok: true, message: 'limit set' }),
    setName: vi.fn().mockResolvedValue({ ok: true, message: 'renamed' }),
    claim: vi.fn().mockResolvedValue({ ok: true, message: 'claimed' }),
    transfer: vi.fn().mockResolvedValue({ ok: true, message: 'transferred' }),
  });
  const privacy = () => ({
    makePrivate: vi.fn().mockResolvedValue({ ok: false, message: 'Only the channel owner can.' }),
    makePublic: vi.fn().mockResolvedValue({ ok: true, message: 'opened' }),
    hide: vi.fn().mockResolvedValue({ ok: true, message: 'hidden' }),
    unhide: vi.fn().mockResolvedValue({ ok: true, message: 'shown' }),
  });
  const feature = (overrides: Record<string, unknown> = {}) => ({
    getRoomPanelState: vi.fn().mockResolvedValue({
      ownerId: 'u1',
      members: [
        { id: 'u1', displayName: 'Kay', bot: false },
        { id: 'u2', displayName: 'Ana', bot: false },
        { id: 'bot', displayName: 'AVC', bot: true },
      ],
      userLimit: 4,
      nameOverride: 'den',
    }),
    ...overrides,
  });

  it('acts on the room named in the custom id, not the channel it was clicked in', async () => {
    const p = privacy();
    const env = setup({ privacy: p as never, voiceCommands: voiceCommands() as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('unlock', 'room-9'),
      // The clicker is somewhere else entirely, which is what a moderator
      // reading a companion text channel looks like.
      voiceChannelId: 'some-other-room',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(p.makePublic).toHaveBeenCalledWith('g1', 'room-9', 'u1');
  });

  /**
   * Hide and Unhide are the privacy pair's twin: the same service call as the slash
   * command, answered ephemerally with the service's own words, and never an edit of
   * the shared panel.
   */
  it.each([
    ['hide', 'hide', 'hidden'],
    ['unhide', 'unhide', 'shown'],
  ] as const)(
    'the %s button calls %s on the room in the id and answers privately',
    async (action, method, said) => {
      const p = privacy();
      const env = setup({ privacy: p as never, voiceCommands: voiceCommands() as never });
      dispose = env.dispose;
      const { interaction, editReply } = fakeInteraction({
        kind: 'button',
        customId: controlPanelId(action, 'room-9'),
        voiceChannelId: 'some-other-room',
      });
      env.client.emit('interactionCreate', interaction);
      await flush();
      expect(p[method]).toHaveBeenCalledWith('g1', 'room-9', 'u1');
      expect(interaction.update).not.toHaveBeenCalled();
      expect(interaction.deferReply).toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: `✅ ${said}` }));
    },
  );

  it('never edits the panel it was pressed on', async () => {
    const env = setup({ privacy: privacy() as never, voiceCommands: voiceCommands() as never });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('unlock', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
  });

  /**
   * "The same ephemeral refusal /private gives them" is only satisfied by
   * passing the service's own message through: the four ownership refusals are
   * deliberately worded differently from each other.
   */
  it('passes an ownership refusal through verbatim', async () => {
    const p = privacy();
    const env = setup({ privacy: p as never, voiceCommands: voiceCommands() as never });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('lock', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ Only the channel owner can.' }),
    );
  });

  /**
   * The interaction is already DEFERRED by the time the work runs, and
   * `route`'s catch reaches for `safeReply`, which follows up on a deferred
   * interaction and leaves the member looking at a spinner that never resolves
   * above the answer. So a rejected dispatch has to be answered here.
   */
  it('answers a rejected dispatch itself, over the deferred reply', async () => {
    const env = setup({
      privacy: privacy() as never,
      voiceCommands: voiceCommands() as never,
      dispatcher: { dispatch: () => Promise.reject(new Error('circuit open')) } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply, followUp } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('unlock', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const answered = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(answered).toContain('circuit open');
    expect(answered).toContain('backing off');
    expect(followUp).not.toHaveBeenCalled();
    // Still reported, because the other reason a dispatch rejects is the task
    // simply failing, and that is a real error somebody has to see.
    expect(env.reportError).toHaveBeenCalled();
  });

  it('opens the limit modal without deferring, prefilled from the live limit', async () => {
    const env = setup({ feature: feature() as never, voiceCommands: voiceCommands() as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('limit', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    // showModal IS the acknowledgement, so a defer before it would throw.
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.showModal.mock.calls[0]?.[0])).toContain('"value":"4"');
  });

  it('turns a blank limit into no limit rather than refusing it', async () => {
    const vc = voiceCommands();
    const env = setup({ voiceCommands: vc as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: controlPanelId('limitset', 'room-9'),
      textInputs: { input: '  ' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(vc.setLimit).toHaveBeenCalledWith('g1', 'room-9', 'u1', 0);
  });

  it('refuses a limit that is not a number, without calling the service', async () => {
    const vc = voiceCommands();
    const env = setup({ voiceCommands: vc as never });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: controlPanelId('limitset', 'room-9'),
      textInputs: { input: 'lots' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(vc.setLimit).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('whole number');
  });

  it('turns a blank rename into a reset', async () => {
    const vc = voiceCommands();
    const env = setup({ voiceCommands: vc as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: controlPanelId('renameset', 'room-9'),
      textInputs: { input: '' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(vc.setName).toHaveBeenCalledWith('g1', 'room-9', 'u1', 'reset', {
      admin: false,
      fromPanel: true,
    });
  });

  /**
   * The owner is left out because `VoteKickManager.start` refuses to target
   * them, and offering a name that is always refused is worse than not
   * offering it. The CLICKER here is deliberately not the owner: with the
   * two being the same person, the "not me" filter alone would pass this
   * and the owner rule would never be exercised.
   */
  it('offers the room members, without bots, the clicker, or the owner', async () => {
    const env = setup({
      feature: feature({
        getRoomPanelState: vi.fn().mockResolvedValue({
          ownerId: 'owner',
          members: [
            { id: 'u1', displayName: 'Kay', bot: false },
            { id: 'owner', displayName: 'Ana', bot: false },
            { id: 'u3', displayName: 'Sam', bot: false },
            { id: 'bot', displayName: 'AVC', bot: true },
          ],
          userLimit: 0,
        }),
      }) as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('kick', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const rendered = JSON.stringify(reply.mock.calls[0]?.[0]);
    expect(rendered).toContain('"value":"u3"');
    expect(rendered).not.toContain('"value":"owner"');
    expect(rendered).not.toContain('"value":"u1"');
    expect(rendered).not.toContain('"value":"bot"');
  });

  /** Transfer has no owner rule: handing it to the current owner is simply refused later. */
  it('offers the owner when transferring, unlike a kick', async () => {
    const env = setup({
      feature: feature({
        getRoomPanelState: vi.fn().mockResolvedValue({
          ownerId: 'owner',
          members: [
            { id: 'u1', displayName: 'Kay', bot: false },
            { id: 'owner', displayName: 'Ana', bot: false },
          ],
          userLimit: 0,
        }),
      }) as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('transfer', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('"value":"owner"');
  });

  it('says so plainly when there is nobody to pick', async () => {
    const env = setup({
      feature: feature({
        getRoomPanelState: vi.fn().mockResolvedValue({
          ownerId: 'u1',
          members: [{ id: 'u1', displayName: 'Kay', bot: false }],
          userLimit: 0,
        }),
      }) as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('transfer', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('nobody else in the room');
  });

  it('transfers to the member chosen in the picker', async () => {
    const vc = voiceCommands();
    const env = setup({ voiceCommands: vc as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'stringSelect',
      customId: controlPanelId('transferpick', 'room-9'),
      values: ['u2'],
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(vc.transfer).toHaveBeenCalledWith('g1', 'room-9', 'u1', 'u2');
  });

  /**
   * The one place the panel cannot be ephemeral: the people who have to vote
   * are the ones who need to see it. Matches `/kick`, whose reply is public.
   */
  it('posts the kick vote publicly, in the channel the panel is in', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'm1' });
    const client = fakeClient() as EventEmitter & { channels: unknown };
    client.channels = {
      fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send }),
    };
    const env = setup({
      client: client as never,
      votekick: {
        start: vi.fn().mockResolvedValue({ ok: true, required: 2, epoch: 1, message: 'started' }),
        hasSession: () => true,
        cancel: vi.fn(),
      } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'stringSelect',
      customId: controlPanelId('kickpick', 'room-9'),
      values: ['u2'],
    });
    // On this one the handler listens on the client we supplied, not on the
    // one `setup` builds, so the event has to be emitted there.
    client.emit('interactionCreate', interaction);
    await flush();
    expect(send).toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain('avc:kick:room-9');
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('everyone to see');
  });

  /**
   * An unanswered modal submit shows a bare "This interaction failed" over
   * whatever the member just typed, with no hint that the text was never
   * going to be saved. Reachable mid-deploy: a modal opened by a new
   * instance, submitted while an old one owns the shard.
   */
  it('answers a modal submit it cannot route rather than dropping it', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: 'avc:panel:somethingnew:room-9',
      textInputs: { input: 'a name they typed' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('older version');
  });

  /**
   * A read that THREW is a database problem. Telling a member their room is
   * not managed when it plainly is sends them to an admin with the wrong
   * story, which is the one outcome worse than saying nothing.
   */
  it('tells a member the read failed rather than that their room is gone', async () => {
    const env = setup({
      feature: {
        getRoomPanelState: vi.fn().mockRejectedValue(new Error('db down')),
      } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('limit', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const answered = JSON.stringify(reply.mock.calls[0]?.[0]);
    expect(answered).toContain("couldn't read that room");
    expect(answered).not.toContain('any more');
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  /**
   * Info answers with a NEW ephemeral message rather than an `avc:info:`
   * custom id, whose handler edits the message it was pressed on: that would
   * put the channel-info panel over the shared control panel for everyone.
   */
  it('answers Info without touching the panel it was pressed on', async () => {
    const env = setup({
      feature: {
        channelInfo: vi.fn().mockResolvedValue({
          channelId: 'room-9',
          isSecondary: true,
          members: [],
        }),
      } as never,
    });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('info', 'room-9'),
      voiceChannels: { 'room-9': { name: 'Room', callerCanSee: true } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.anything() }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('refuses Info for a room the caller cannot see', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('info', 'room-9'),
      voiceChannels: { 'room-9': { name: 'Room', callerCanSee: false } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("can't show you");
  });

  it('honours the /channelinfo kill switch, so the button is no way around it', async () => {
    const env = setup({
      flags: { getBool: vi.fn().mockResolvedValue(true) } as never,
    });
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('info', 'room-9'),
      voiceChannels: { 'room-9': { name: 'Room', callerCanSee: true } },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('switched off');
  });

  /**
   * `/channelinfo` is on the hard gate's exemption list because refusing to
   * tell somebody how their own server is configured over a lapsed payment is
   * not what the gate is for. The button does the same thing, so it is exempt
   * too. Unhide and Unlock are exempt as the buttons of the two commands that only open
   * a room (tested with `/public`, further up), and every OTHER panel button is a write
   * and stays refused (the Lock button, in a test just below).
   */
  it('lets Info through in an expired guild', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
      feature: {
        channelInfo: vi
          .fn()
          .mockResolvedValue({ channelId: 'room-9', isSecondary: true, members: [] }),
      } as never,
    });
    dispose = env.dispose;
    const info = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('info', 'room-9'),
      voiceChannels: { 'room-9': { name: 'Room', callerCanSee: true } },
    });
    env.client.emit('interactionCreate', info.interaction);
    await flush();
    expect(JSON.stringify(info.reply.mock.calls[0]?.[0] ?? '')).not.toContain('auto-voice.io');
  });

  /**
   * A panel outlives a deploy, so this is the one out-of-date path that is
   * genuinely likely, and it must not tell a member to run a command that does
   * not exist.
   */
  it('answers an unrecognised panel id rather than leaving it hanging', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: 'avc:panel:somethingnew:room-9',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('older version');
  });

  /**
   * Panel buttons are write paths, like every other write path, so a hard-gated
   * guild gets the reactivation notice rather than a working Lock button.
   */
  it('refuses panel buttons in an expired guild', async () => {
    const env = setup({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlPanelId('lock', 'room-9'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
  });
});

describe('registerInteractionHandler (/controlpanel)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  it('refuses a caller without Manage Channels', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'controlpanel',
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
    expect(env.settings.getControlPanel).not.toHaveBeenCalled();
  });

  it('opens the configuration panel for an admin', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'controlpanel',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain(controlToggleId('kick'));
  });

  it('toggles the control whose button was pressed, and re-renders in place', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: controlToggleId('kick'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelEntry).toHaveBeenCalledWith('g1', 'kick', false);
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
  });

  /** Claim is off by default, so its button switches it ON. */
  it('toggles in the other direction for a control that is off', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlToggleId('claim'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelEntry).toHaveBeenCalledWith('g1', 'claim', true);
  });

  /**
   * The promise the reply makes is that the rooms already open are updated too,
   * so the fan-out has to actually be fired. Detached, so the admin's answer
   * does not wait on one edit per room.
   */
  it('refreshes the panels of rooms that are already open', async () => {
    const refreshGuildPanels = vi.fn().mockResolvedValue({ considered: 3 });
    const env = setup({ feature: { refreshGuildPanels } as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlToggleId('kick'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(refreshGuildPanels).toHaveBeenCalledWith('g1');
  });

  /**
   * The appearance buttons open a modal, which has to be the FIRST response to
   * the interaction: a `deferUpdate` above it makes the modal unopenable and
   * the admin gets a spinner that resolves into nothing.
   */
  it('opens a prefilled modal rather than deferring, for an appearance button', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlAppearanceId('title'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.showModal).toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.showModal.mock.calls[0]?.[0])).toContain('Control your room');
  });

  it('refuses an appearance button without Manage Channels, and opens nothing', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlAppearanceId('color'),
      manageChannels: false,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('saves a submitted title and re-renders the panel in place', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: controlAppearanceId('title'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { value: 'Your room, your rules' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelAppearance).toHaveBeenCalledWith(
      'g1',
      'title',
      'Your room, your rules',
    );
    expect(editReply).toHaveBeenCalled();
  });

  /** Blank is the reset, which is why the modal input is not required. */
  it('reads a blank submit as a reset rather than as an empty title', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: controlAppearanceId('description'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { value: '   ' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelAppearance).toHaveBeenCalledWith('g1', 'description', null);
  });

  it('parses a hex colour into the integer Discord wants', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: controlAppearanceId('color'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { value: '#00ff00' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelAppearance).toHaveBeenCalledWith('g1', 'color', 0x00ff00);
  });

  /**
   * A typo gets a sentence about hex codes and changes nothing. Re-rendering
   * every panel in the guild to prove a refusal would be traffic for nothing.
   */
  it('refuses a colour it cannot parse, writes nothing and refreshes nothing', async () => {
    const refreshGuildPanels = vi.fn().mockResolvedValue({ considered: 0 });
    const env = setup({ feature: { refreshGuildPanels } as never });
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: controlAppearanceId('color'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { value: 'purple' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelAppearance).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('hex code');
    expect(refreshGuildPanels).not.toHaveBeenCalled();
  });

  it('refreshes the panels already posted after an appearance change', async () => {
    const refreshGuildPanels = vi.fn().mockResolvedValue({ considered: 3 });
    const env = setup({ feature: { refreshGuildPanels } as never });
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'modal',
      customId: controlAppearanceId('title'),
      manageChannels: true,
      fromMessage: true,
      textInputs: { value: 'Yours' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(refreshGuildPanels).toHaveBeenCalledWith('g1');
  });

  /**
   * A custom id comes back from a message we posted, but it is still client
   * input on the wire and it goes straight into a settings key.
   */
  it('refuses a toggle that is not a known control', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: 'avc:cp:t:somethingnew',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelEntry).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('out of date');
  });

  it('refuses a non-admin pressing a control toggle', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlToggleId('kick'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelEntry).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
  });

  it('switches the whole panel off through the same key', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: controlSettingsId('off'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelEntry).toHaveBeenCalledWith('g1', 'panel', false);
  });

  it('refuses a non-admin pressing a configuration button', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: controlSettingsId('off'),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.settings.setControlPanelEntry).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
  });
});

describe('registerInteractionHandler (/botprofile)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    vi.unstubAllGlobals();
  });

  const MANAGE_SERVER = 'You need the Manage Server permission to use that.';
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

  /** Expired and not self-hosted, which is the only way to be hard-gated. */
  const expired = () => ({
    guilds: {
      get: vi.fn().mockResolvedValue({ authStatus: 'expired' }),
      isEntitled: vi.fn().mockResolvedValue(false),
    } as never,
    selfHosted: false,
  });

  /**
   * Manage Channels is not enough: this changes how the bot looks to the whole
   * server, which is `/import`'s reach.
   */
  it('refuses a caller with only Manage Channels, before reading anything', async () => {
    const env = setup();
    dispose = env.dispose;
    const fetchMe = vi.fn();
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'botprofile',
      manageChannels: true,
      fetchMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: MANAGE_SERVER }));
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(fetchMe).not.toHaveBeenCalled();
  });

  /**
   * `force`, because `editMe` leaves the cached member alone and `fetchMe`
   * without it answers from that cache: the panel would report the profile
   * from before the last change.
   */
  it('opens the panel from a fresh read of the bot, not the cache', async () => {
    const env = setup();
    dispose = env.dispose;
    const fetchMe = vi.fn().mockResolvedValue(fakeBotMember({ nickname: 'Roomie' }));
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'botprofile',
      manageGuild: true,
      fetchMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(fetchMe).toHaveBeenCalledWith({ force: true });
    expect(interaction.deferReply).toHaveBeenCalled();
    const json = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(json).toContain(botProfileSetId('avatar'));
    expect(json).toContain('Roomie');
  });

  it('says so rather than showing a blank panel when the bot cannot be read', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'command',
      commandName: 'botprofile',
      manageGuild: true,
      fetchMe: vi.fn().mockRejectedValue(new Error('503')),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain("can't read my profile");
  });

  /**
   * `showModal` has to be the first response inside three seconds, so nothing
   * may defer before it and nothing may wait on Discord: the prefill comes from
   * the cached member, not a fetch.
   */
  it('opens the name modal prefilled from the cache, without deferring or fetching', async () => {
    const env = setup();
    dispose = env.dispose;
    const fetchMe = vi.fn();
    const { interaction } = fakeInteraction({
      kind: 'button',
      customId: botProfileSetId('name'),
      manageGuild: true,
      botNickname: 'Roomie',
      fetchMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(fetchMe).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.showModal.mock.calls[0]?.[0])).toContain('"value":"Roomie"');
  });

  it('refuses a set button without Manage Server, and opens nothing', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'button',
      customId: botProfileSetId('avatar'),
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: MANAGE_SERVER }));
    expect(interaction.showModal).not.toHaveBeenCalled();
  });

  it('resets one field with null, names the admin in the audit log, and re-renders', async () => {
    const env = setup();
    dispose = env.dispose;
    const editMe = vi.fn().mockResolvedValue(fakeBotMember());
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: botProfileResetId('avatar'),
      manageGuild: true,
      editMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(editMe).toHaveBeenCalledWith({ avatar: null, reason: '/botprofile, by kay (u1)' });
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Avatar reset to the default.');
    // Discord clients cache a profile, so the admin is told how to see it now.
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain(
      'This may take some time for everyone to see it. Press Ctrl-R to reload now.',
    );
  });

  it('sets the name from the modal', async () => {
    const env = setup();
    dispose = env.dispose;
    const editMe = vi.fn().mockResolvedValue(fakeBotMember({ nickname: 'Bob' }));
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('name'),
      manageGuild: true,
      fromMessage: true,
      textInputs: { value: '  Bob  ' },
      editMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(editMe).toHaveBeenCalledWith(expect.objectContaining({ nick: 'Bob' }));
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain('Name updated.');
  });

  /**
   * The invite does not ask for Change Nickname, so a server that took it off
   * @everyone refuses the rename. That is the admin's to fix and not an
   * incident, so it is told to them and not reported.
   */
  it('tells the admin how to grant Change Nickname when the rename is refused', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('name'),
      manageGuild: true,
      fromMessage: true,
      textInputs: { value: 'Bob' },
      editMe: vi.fn().mockRejectedValue(missingPermissions()),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const json = JSON.stringify(editReply.mock.calls.at(-1)?.[0]);
    expect(json).toContain('Change Nickname');
    expect(json).toContain(botProfileSetId('name'));
    expect(env.reportError).not.toHaveBeenCalled();
  });

  it('uploads an image as a data URI typed by its bytes', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(PNG.buffer.slice(0)),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const env = setup();
    dispose = env.dispose;
    const editMe = vi.fn().mockResolvedValue(fakeBotMember({ avatar: 'abc' }));
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('avatar'),
      manageGuild: true,
      fromMessage: true,
      uploadedFile: { url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/a.jpg', size: 10 },
      editMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    await flush();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(editMe).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
      }),
    );
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain('Avatar updated.');
  });

  /**
   * A discord.js API error carries the request body, and pino's error
   * serializer copies it, so a refused upload logged as `{ err }` would write
   * the whole image into the logs. The privacy policy says we keep no copy.
   *
   * Through a REAL dispatcher and every log level, because the leak this
   * caught in review was not in the handler at all: the guild queue logs a
   * failed task as `{ err }` before the handler's own catch runs, and a
   * pass-through dispatcher hid it.
   */
  it('never logs the uploaded image when Discord refuses it, at any level', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(PNG.buffer.slice(0)) }),
    );
    const logged = vi.fn();
    const logger: Record<string, unknown> = {};
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      logger[level] = logged;
    logger.child = () => logger;
    const env = setup({
      logger: logger as never,
      dispatcher: new GuildDispatcher({ logger: logger as never }),
    });
    dispose = env.dispose;
    const refused = new DiscordAPIError(
      {
        code: 50035,
        message: 'Invalid Form Body',
        errors: {
          avatar: { _errors: [{ code: 'X', message: 'File cannot be larger than 10240.0 kb.' }] },
        },
      } as never,
      50035,
      400,
      'PATCH',
      'https://discord.test',
      { body: { avatar: 'data:image/png;base64,THEIMAGEBYTES' } } as never,
    );
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('avatar'),
      manageGuild: true,
      fromMessage: true,
      uploadedFile: { url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/a.png', size: 10 },
      editMe: vi.fn().mockRejectedValue(refused),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    await flush();
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain('THEIMAGEBYTES');
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain('10240.0 kb');
    expect(env.reportError).not.toHaveBeenCalled();
  });

  /** Anything that is not the admin's to fix is an operator's to hear about. */
  it('reports an unexpected failure, and still re-renders the panel', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'button',
      customId: botProfileResetId('bio'),
      manageGuild: true,
      editMe: vi.fn().mockRejectedValue(new Error('socket hang up')),
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.reportError).toHaveBeenCalledWith(
      'Bot profile change failed',
      expect.objectContaining({ field: 'bio' }),
    );
    const json = JSON.stringify(editReply.mock.calls.at(-1)?.[0]);
    expect(json).toContain('socket hang up');
    expect(json).toContain(botProfileResetId('bio'));
  });

  it('refuses a blank name rather than sending one', async () => {
    const env = setup();
    dispose = env.dispose;
    const editMe = vi.fn();
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('name'),
      manageGuild: true,
      fromMessage: true,
      textInputs: { value: '   ' },
      editMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(editMe).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain('blank');
  });

  it('asks for an image when an upload modal arrives without one', async () => {
    const env = setup();
    dispose = env.dispose;
    const editMe = vi.fn();
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('avatar'),
      manageGuild: true,
      fromMessage: true,
      editMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(editMe).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain('Attach an image first');
  });

  /**
   * A submit from an older build, or a forged one, whose modal lacks the field:
   * discord.js throws on the read, and it must be answered before any defer
   * rather than reaching `route`'s generic catch.
   */
  it('answers a modal missing its field as out of date, without deferring', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('bio'),
      manageGuild: true,
      fromMessage: true,
    });
    interaction.fields.getTextInputValue = () => {
      throw new Error('Required field "value" not found.');
    };
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('out of date');
  });

  /** A modal with no message behind it cannot be answered with an update. */
  it('answers a modal that did not come from the panel with a fresh reply', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('bio'),
      manageGuild: true,
      fromMessage: false,
      textInputs: { value: 'Rooms that name themselves.' },
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain('Bio updated.');
  });

  /**
   * Each upload in flight holds the file and its base64 copy, so an instance
   * takes two at a time and says so to the third rather than finding the
   * memory ceiling.
   */
  it('refuses a third concurrent upload on one instance, before downloading', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const fetchSpy = vi.fn().mockImplementation(async () => {
      await held;
      return { ok: true, arrayBuffer: () => Promise.resolve(PNG.buffer.slice(0)) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    const env = setup();
    dispose = env.dispose;
    const upload = () =>
      fakeInteraction({
        kind: 'modal',
        customId: botProfileSetId('avatar'),
        manageGuild: true,
        fromMessage: true,
        uploadedFile: {
          url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/a.png',
          size: 10,
        },
      });
    const first = upload();
    const second = upload();
    const third = upload();
    env.client.emit('interactionCreate', first.interaction);
    env.client.emit('interactionCreate', second.interaction);
    await flush();
    env.client.emit('interactionCreate', third.interaction);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(third.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(third.reply.mock.calls[0]?.[0])).toContain('Try again in a minute');
    release();
    await flush();
    await flush();
    // Both slots are free again once the first two finish.
    const fourth = upload();
    env.client.emit('interactionCreate', fourth.interaction);
    await flush();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('never fetches an upload from a host that is not Discord', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = setup();
    dispose = env.dispose;
    const editMe = vi.fn();
    const { interaction, editReply } = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('banner'),
      manageGuild: true,
      fromMessage: true,
      uploadedFile: { url: 'https://evil.example/b.png', size: 10 },
      editMe,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(editMe).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).toContain('not hosted by Discord');
  });

  it('opens from the /setup settings select, replacing that panel', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values: [setupId('botprofile')],
      manageChannels: true,
      manageGuild: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]?.[0])).toContain(botProfileResetId('bio'));
  });

  /** The option is hidden from these admins, but option values are client input. */
  it('refuses the /setup option to an admin without Manage Server', async () => {
    const env = setup();
    dispose = env.dispose;
    const { interaction, reply } = fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values: [setupId('botprofile')],
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: MANAGE_SERVER }));
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  /**
   * A gated admin can still take the bot's custom face off their server, since
   * a reset only removes, but cannot put anything new up.
   */
  it('lets a gated admin open the panel and reset, with no set buttons offered', async () => {
    const env = setup(expired());
    dispose = env.dispose;
    const opened = fakeInteraction({
      kind: 'command',
      commandName: 'botprofile',
      manageGuild: true,
    });
    env.client.emit('interactionCreate', opened.interaction);
    await flush();
    const json = JSON.stringify(opened.editReply.mock.calls[0]?.[0]);
    expect(json).toContain(botProfileResetId('avatar'));
    expect(json).not.toContain(botProfileSetId('avatar'));

    const editMe = vi.fn().mockResolvedValue(fakeBotMember());
    const reset = fakeInteraction({
      kind: 'button',
      customId: botProfileResetId('banner'),
      manageGuild: true,
      editMe,
    });
    env.client.emit('interactionCreate', reset.interaction);
    await flush();
    expect(editMe).toHaveBeenCalledWith(expect.objectContaining({ banner: null }));
  });

  it('opens the resets-only panel from /setup in a gated server', async () => {
    const env = setup(expired());
    dispose = env.dispose;
    const { interaction, editReply } = fakeInteraction({
      kind: 'stringSelect',
      customId: SETUP_SETTINGS_ID,
      values: [setupId('botprofile')],
      manageChannels: true,
      manageGuild: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    const json = JSON.stringify(editReply.mock.calls[0]?.[0]);
    expect(json).toContain(botProfileResetId('name'));
    expect(json).not.toContain(botProfileSetId('name'));
  });

  it('refuses a gated admin a set button and its modal', async () => {
    const env = setup(expired());
    dispose = env.dispose;
    const button = fakeInteraction({
      kind: 'button',
      customId: botProfileSetId('avatar'),
      manageGuild: true,
    });
    env.client.emit('interactionCreate', button.interaction);
    await flush();
    expect(button.interaction.showModal).not.toHaveBeenCalled();
    expect(button.reply).toHaveBeenCalled();

    const editMe = vi.fn();
    const modal = fakeInteraction({
      kind: 'modal',
      customId: botProfileSetId('bio'),
      manageGuild: true,
      fromMessage: true,
      textInputs: { value: 'hello' },
      editMe,
    });
    env.client.emit('interactionCreate', modal.interaction);
    await flush();
    expect(editMe).not.toHaveBeenCalled();
  });
});

/**
 * `/restrict`: who may not use which room command.
 *
 * Driven through the real `GuildSettingsService` over an in-memory settings store,
 * so what an admin reads and what lands in the blob are both the real thing, and
 * the router around them is the real router. This command only edits the map, and
 * enforcing it is the guard's job (see the restriction guard tests below).
 */
describe('registerInteractionHandler (/restrict)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const GUILD = '460459401086763010';
  const TARGET = '111111111111111111';
  const OTHER = '222222222222222222';
  const ROLE = '333333333333333333';
  const ADMIN = 'u1';
  const MANAGE = PermissionFlagsBits.ManageChannels;
  const ADMINISTRATOR = PermissionFlagsBits.Administrator;
  const EPHEMERAL = 64;

  /** What `PermissionsBitField` answers, for the two permissions the check asks about. */
  const holds = (...flags: bigint[]) => ({ has: (p: bigint) => flags.includes(p) });

  /** A real service over a store that applies `mergeSettings` the way the database does. */
  function restrictEnv(
    initial: Record<string, unknown> = {},
    overrides: Partial<InteractionDeps> = {},
  ) {
    let blob: Record<string, unknown> = initial;
    const serverLog = vi.fn();
    const rerenderByOwner = vi
      .fn()
      .mockResolvedValue({ considered: 1, renamed: 1, rateLimited: 0 });
    const refreshGuildPanels = vi.fn().mockResolvedValue({ considered: 0 });
    const warn = vi.fn();
    const mergeSettings = vi.fn(
      (
        _g: string,
        decide: (existing: unknown) => {
          patch: Record<string, unknown>;
          remove?: readonly string[];
          result: unknown;
        },
      ) => {
        const decided = decide({ authStatus: 'active', settings: blob });
        blob = { ...blob, ...decided.patch };
        for (const key of decided.remove ?? []) delete blob[key];
        return Promise.resolve(decided.result);
      },
    );
    const settings = new GuildSettingsService({
      guilds: { ensure: () => Promise.resolve({ settings: blob }), mergeSettings } as never,
      autoChannels: {} as never,
      secondaries: {} as never,
      actions: {} as never,
      logger: fakeLogger(),
    });
    const env = setup({
      settings: settings as never,
      serverLog,
      feature: { rerenderByOwner, refreshGuildPanels } as never,
      logger: { ...fakeLogger(), warn } as never,
      ...overrides,
    });
    dispose = env.dispose;
    return {
      env,
      blob: () => blob,
      serverLog,
      rerenderByOwner,
      refreshGuildPanels,
      warn,
      mergeSettings,
    };
  }

  /** Runs one `/restrict` interaction and returns what the admin was sent. */
  async function restrict(
    e: ReturnType<typeof restrictEnv>,
    opts: Partial<FakeInteractionOpts> & { subcommand: string },
  ) {
    const fake = fakeInteraction({
      kind: 'command',
      commandName: 'restrict',
      guildId: GUILD,
      manageChannels: true,
      ...opts,
    });
    e.env.client.emit('interactionCreate', fake.interaction);
    await flush();
    const payload = fake.reply.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    return { ...fake, payload, content: (payload?.content as string | undefined) ?? '' };
  }

  const addUser = (feature: string, id = TARGET, extra: Record<string, unknown> = {}) => ({
    subcommand: 'add',
    optionFeature: feature,
    optionWho: { user: { id }, ...extra },
  });
  const addRole = (feature: string, id: string, permissions: unknown = '0') => ({
    subcommand: 'add',
    optionFeature: feature,
    optionWho: { role: { id, permissions } },
  });
  const removeUser = (
    feature: string,
    optionWho: FakeInteractionOpts['optionWho'] = {
      user: { id: TARGET },
    },
  ) => ({ subcommand: 'remove', optionFeature: feature, optionWho });

  it('adds a restriction, and answers only the admin and pings nobody', async () => {
    const e = restrictEnv();
    const { content, payload, interaction } = await restrict(e, addUser('rename'));

    expect(e.blob().command_access).toEqual({ rename: { users: [TARGET] } });
    expect(content).toContain(`✅ <@${TARGET}> can no longer use **Name**`);
    expect(payload?.flags).toBe(EPHEMERAL);
    expect(payload?.allowedMentions).toEqual({ parse: [] });
    // A settings write, so no acknowledgement first: it is not on the deferred list.
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('tells an admin what a restriction does not cover, on add', async () => {
    const e = restrictEnv();
    const { content } = await restrict(e, addUser('rename'));
    expect(content).toContain('Restrictions only apply on versions of AVC that include them.');
    expect(content).toContain("Discord's own Integrations settings still apply to slash commands");
    expect(content).toContain('room panel buttons ignore those settings');
  });

  it('resolves a picked role as a role, and stores it as one', async () => {
    const e = restrictEnv();
    const { content } = await restrict(e, addRole('limit', ROLE));
    expect(e.blob().command_access).toEqual({ limit: { roles: [ROLE] } });
    expect(content).toContain(`<@&${ROLE}> can no longer use **Size**`);
  });

  /**
   * The log channel is read by whoever the admin chose, so the line names the admin
   * and the feature, as planned, and never the person or the role: `/restrict list`
   * is where an admin looks that up.
   */
  it('posts a line to the server log naming the admin and the feature, and nobody else', async () => {
    for (const [initial, opts] of [
      [{}, addUser('transfer')],
      [{}, addRole('transfer', ROLE)],
    ] as const) {
      const e = restrictEnv(initial);
      await restrict(e, opts);
      expect(e.serverLog).toHaveBeenCalledOnce();
      expect(e.serverLog).toHaveBeenCalledWith(
        GUILD,
        1,
        `🔒 <@${ADMIN}> added a restriction on **Transfer**.`,
      );
      const line = e.serverLog.mock.calls[0]![2] as string;
      expect(line).not.toContain(TARGET);
      expect(line).not.toContain(ROLE);
      dispose?.();
    }
  });

  /**
   * The write has landed by the time the reply goes out, and the reply can still
   * throw: the write waits in the guild's queue and the token lasts three seconds.
   * The audit line is the only record of who changed the rules, so it must not
   * depend on the reply.
   */
  it('posts the audit line even when the reply throws, since the write already landed', async () => {
    const e = restrictEnv();
    const fake = fakeInteraction({
      kind: 'command',
      commandName: 'restrict',
      guildId: GUILD,
      manageChannels: true,
      ...addUser('transfer'),
    });
    fake.reply.mockRejectedValue(new Error('Unknown interaction'));
    e.env.client.emit('interactionCreate', fake.interaction);
    await flush();

    expect(e.blob().command_access).toEqual({ transfer: { users: [TARGET] } });
    expect(e.serverLog).toHaveBeenCalledWith(
      GUILD,
      1,
      `🔒 <@${ADMIN}> added a restriction on **Transfer**.`,
    );
  });

  it('writes no ops_audit row, which this command has no way to reach', async () => {
    const record = vi.fn();
    const e = restrictEnv({}, { configTransfer: { opsAudit: { record } } as never });
    await restrict(e, addUser('rename'));
    expect(record).not.toHaveBeenCalled();
  });

  describe('refuses anyone who cannot manage channels', () => {
    /**
     * The registration default is a DEFAULT: a server admin can re-open this
     * command to any role in Server Settings > Integrations, so the in-code check
     * is what stops a role that was handed the command from deciding who may use
     * every room command.
     */
    it.each([
      ['add', addUser('rename')],
      ['remove', removeUser('rename')],
      ['list', { subcommand: 'list' }],
    ])('on %s', async (_name, opts) => {
      const e = restrictEnv({ command_access: { rename: { users: [OTHER] } } });
      const { content } = await restrict(e, { ...opts, manageChannels: false });
      expect(content).toBe('You need the Manage Channels permission.');
      expect(e.mergeSettings).not.toHaveBeenCalled();
      expect(e.serverLog).not.toHaveBeenCalled();
      expect(e.blob().command_access).toEqual({ rename: { users: [OTHER] } });
    });
  });

  describe('refuses a target that would do nothing, or everything', () => {
    it('refuses the everyone role, whose id is the guild id', async () => {
      const e = restrictEnv();
      const { content } = await restrict(e, addRole('rename', GUILD));
      expect(content).toContain('⚠️ That is the everyone role');
      expect(e.blob()).not.toHaveProperty('command_access');
      expect(e.serverLog).not.toHaveBeenCalled();
    });

    it('refuses a bot', async () => {
      const e = restrictEnv();
      const { content } = await restrict(
        e,
        addUser('rename', TARGET, { user: { id: TARGET, bot: true } }),
      );
      expect(content).toContain(`<@${TARGET}> is a bot`);
      expect(e.blob()).not.toHaveProperty('command_access');
    });

    it.each([
      ['Manage Channels', holds(MANAGE)],
      ['Administrator', holds(ADMINISTRATOR)],
      ['Manage Channels as the string the raw API sends', String(MANAGE)],
      ['Administrator as the string the raw API sends', String(ADMINISTRATOR)],
      ['Manage Channels among others', String(MANAGE | PermissionFlagsBits.KickMembers)],
    ])('refuses a user who has %s, and says why', async (_name, permissions) => {
      const e = restrictEnv();
      const { content } = await restrict(e, addUser('rename', TARGET, { member: { permissions } }));
      expect(content).toContain(
        `⚠️ <@${TARGET}> has the Manage Channels or Administrator permission`,
      );
      expect(content).toContain('would do nothing');
      expect(e.blob()).not.toHaveProperty('command_access');
      expect(e.serverLog).not.toHaveBeenCalled();
    });

    it.each([
      ['Manage Channels', String(MANAGE)],
      ['Administrator', String(ADMINISTRATOR)],
      ['Manage Channels as a bit field', holds(MANAGE)],
    ])('refuses a role that has %s', async (_name, permissions) => {
      const e = restrictEnv();
      const { content } = await restrict(e, addRole('rename', ROLE, permissions));
      expect(content).toContain(`<@&${ROLE}> has the Manage Channels or Administrator permission`);
      expect(e.blob()).not.toHaveProperty('command_access');
    });

    it('accepts a user and a role with neither permission', async () => {
      const e = restrictEnv();
      const kick = String(PermissionFlagsBits.KickMembers);
      await restrict(e, addUser('rename', TARGET, { member: { permissions: kick } }));
      await restrict(e, addRole('rename', ROLE, kick));
      expect(e.blob().command_access).toEqual({ rename: { users: [TARGET], roles: [ROLE] } });
    });

    /** A rule on a manager is harmless, since the guard skips them, and refusing on a guess is not. */
    it('lets a user through when nothing can say what they hold', async () => {
      const e = restrictEnv();
      await restrict(e, addUser('rename'));
      expect(e.blob().command_access).toEqual({ rename: { users: [TARGET] } });
    });
  });

  /**
   * Removing is the way out of a rule that no longer makes sense, so it is never
   * refused on who the target is: the person may since have become a manager, or
   * a bot, or the role the everyone role.
   */
  describe('remove', () => {
    it('lets the person use the feature again, without the note', async () => {
      const e = restrictEnv({ command_access: { rename: { users: [TARGET, OTHER] } } });
      const { content } = await restrict(e, removeUser('rename'));
      expect(content).toBe(`✅ <@${TARGET}> can use **Name** again.`);
      expect(e.blob().command_access).toEqual({ rename: { users: [OTHER] } });
      expect(e.serverLog).toHaveBeenCalledWith(
        GUILD,
        1,
        `🔓 <@${ADMIN}> lifted a restriction on **Name**.`,
      );
      expect(e.serverLog.mock.calls[0]![2]).not.toContain(TARGET);
    });

    it('takes the key off the blob when the last restriction goes', async () => {
      const e = restrictEnv({ general: 'Voice', command_access: { rename: { users: [TARGET] } } });
      await restrict(e, removeUser('rename'));
      expect(e.blob()).toEqual({ general: 'Voice' });
    });

    it('is not refused for a manager, a bot or the everyone role', async () => {
      const e = restrictEnv();
      for (const who of [
        { user: { id: TARGET }, member: { permissions: holds(MANAGE) } },
        { user: { id: OTHER, bot: true } },
        { role: { id: GUILD, permissions: String(ADMINISTRATOR) } },
      ]) {
        const { content } = await restrict(e, removeUser('rename', who));
        expect(content).toContain('was not restricted from **Name**, so nothing changed');
      }
    });

    it('can clear a stored everyone rule that a hand edit put there', async () => {
      const e = restrictEnv({ command_access: { rename: { roles: [GUILD] } } });
      await restrict(e, removeUser('rename', { role: { id: GUILD, permissions: '0' } }));
      expect(e.blob()).not.toHaveProperty('command_access');
    });

    it('logs nothing when there was nothing to remove', async () => {
      const e = restrictEnv();
      await restrict(e, removeUser('rename'));
      expect(e.serverLog).not.toHaveBeenCalled();
    });
  });

  /**
   * The way out of a list that has filled with people who left and roles that were
   * deleted: `remove` needs the picker, and the picker cannot offer either.
   */
  describe('clear', () => {
    const clear = (feature: string) => ({ subcommand: 'clear', optionFeature: feature });
    const stored = {
      command_access: {
        rename: { users: [TARGET, OTHER], roles: [ROLE] },
        limit: { users: [TARGET] },
      },
    };

    it('takes everyone off the one feature, says how many, and takes no who', async () => {
      const e = restrictEnv(stored);
      const { content, payload } = await restrict(e, clear('rename'));
      expect(content).toBe('✅ Removed 3 restrictions on **Name**. Everyone can use it again.');
      expect(e.blob().command_access).toEqual({ limit: { users: [TARGET] } });
      expect(payload?.flags).toBe(EPHEMERAL);
      expect(payload?.allowedMentions).toEqual({ parse: [] });
    });

    it('logs the admin and the feature, and not who was on the list', async () => {
      const e = restrictEnv(stored);
      await restrict(e, clear('rename'));
      expect(e.serverLog).toHaveBeenCalledOnce();
      expect(e.serverLog).toHaveBeenCalledWith(
        GUILD,
        1,
        `🔓 <@${ADMIN}> lifted every restriction on **Name**.`,
      );
    });

    it('reports success and logs nothing when the feature had nobody on it', async () => {
      const e = restrictEnv(stored);
      const { content } = await restrict(e, clear('transfer'));
      expect(content).toBe('✅ Nobody was restricted from **Transfer**, so nothing changed.');
      expect(e.serverLog).not.toHaveBeenCalled();
      expect(e.blob()).toEqual(stored);
    });

    it('refuses anyone who cannot manage channels, and a feature it does not offer', async () => {
      const denied = restrictEnv(stored);
      const { content } = await restrict(denied, { ...clear('rename'), manageChannels: false });
      expect(content).toContain('Manage Channels');
      expect(denied.blob()).toEqual(stored);

      const hand = restrictEnv(stored);
      const refused = await restrict(hand, clear('claim'));
      expect(refused.content).toContain('Pick one of the room commands from the list.');
      expect(hand.blob()).toEqual(stored);
    });
  });

  it('answers a repeat add as a success that changed nothing, and logs nothing', async () => {
    const e = restrictEnv({ command_access: { rename: { users: [TARGET] } } });
    const { content } = await restrict(e, addUser('rename'));
    expect(content).toContain('is already restricted from **Name**, so nothing changed');
    expect(e.serverLog).not.toHaveBeenCalled();
  });

  it("refuses past the cap in the writer's words, with no note and no log line", async () => {
    const full = Array.from({ length: 50 }, (_, i) => `4${String(i).padStart(17, '0')}`);
    const e = restrictEnv({ command_access: { rename: { users: full } } });
    const { content } = await restrict(e, addUser('rename'));
    expect(content).toContain('⚠️ **Name** already restricts 50 people');
    expect(content).not.toContain('Restrictions only apply');
    expect(e.serverLog).not.toHaveBeenCalled();
  });

  describe('treats its options as client input', () => {
    it.each(['claim', 'kick', 'constructor'])(
      'refuses the feature %j, which /restrict does not offer',
      async (feature) => {
        const e = restrictEnv();
        const { content } = await restrict(e, addUser(feature));
        expect(content).toContain('⚠️ Pick one of the room commands from the list.');
        expect(e.mergeSettings).not.toHaveBeenCalled();
      },
    );

    it('refuses an option that is neither a user nor a role', async () => {
      const e = restrictEnv();
      const { content } = await restrict(e, {
        subcommand: 'add',
        optionFeature: 'rename',
        optionWho: {},
      });
      expect(content).toContain('⚠️ That is not something I can restrict.');
      expect(e.mergeSettings).not.toHaveBeenCalled();
    });

    it('answers an unknown subcommand as an unknown command', async () => {
      const e = restrictEnv();
      const { content } = await restrict(e, { subcommand: 'purge' });
      expect(content).toBe('Unknown command.');
      expect(e.mergeSettings).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('says nobody is restricted for every feature when nothing is stored', async () => {
      const e = restrictEnv();
      const { content, payload } = await restrict(e, { subcommand: 'list' });
      for (const label of [
        'Private and Public',
        'Hide',
        'Size',
        'Name',
        'Transfer',
        'Saved lists',
        'Nickname',
      ]) {
        expect(content).toContain(`**${label}**: nobody is restricted`);
      }
      expect(payload?.flags).toBe(EPHEMERAL);
      expect(payload?.allowedMentions).toEqual({ parse: [] });
      expect(e.mergeSettings).not.toHaveBeenCalled();
      expect(e.serverLog).not.toHaveBeenCalled();
    });

    it('shows who is restricted from what, as mentions, with the note', async () => {
      const e = restrictEnv({
        command_access: { rename: { users: [TARGET], roles: [ROLE] }, nick: { users: [OTHER] } },
      });
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content).toContain(`**Name**: <@&${ROLE}>, <@${TARGET}>`);
      expect(content).toContain(`**Nickname**: <@${OTHER}>`);
      expect(content).toContain('Restrictions only apply on versions of AVC that include them.');
      expect(content.length).toBeLessThanOrEqual(2000);
    });

    it('does not show a feature that has no restriction, whatever is stored', async () => {
      const e = restrictEnv({ command_access: { claim: { users: [TARGET] } } });
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content).not.toContain(TARGET);
      expect(content).not.toContain('Claim');
    });

    it('shows Hide and Saved lists, which have commands now', async () => {
      const e = restrictEnv({
        command_access: { hide: { users: [TARGET] }, access: { roles: [ROLE] } },
      });
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content).toContain(`**Hide**: <@${TARGET}>`);
      expect(content).toContain(`**Saved lists**: <@&${ROLE}>`);
    });
  });

  /**
   * Denying /nick and leaving the name somebody chose in every room they own would
   * defeat the rule, so the saved nickname goes with it, and their rooms are
   * re-rendered so the old name stops showing.
   */
  describe('a Nickname restriction on a user', () => {
    it('removes the saved nickname, says so, and re-renders their rooms after replying', async () => {
      const e = restrictEnv({ custom_nicks: { [TARGET]: 'Kay', [OTHER]: 'Sam' } });
      const order: string[] = [];
      e.rerenderByOwner.mockImplementation(() => {
        order.push('render');
        return Promise.resolve({ considered: 1, renamed: 1, rateLimited: 0 });
      });
      const fake = fakeInteraction({
        kind: 'command',
        commandName: 'restrict',
        guildId: GUILD,
        manageChannels: true,
        ...addUser('nick'),
      });
      fake.reply.mockImplementation(() => {
        order.push('reply');
        return Promise.resolve(undefined);
      });
      e.env.client.emit('interactionCreate', fake.interaction);
      await flush();

      expect((fake.reply.mock.calls[0]![0] as { content: string }).content).toContain(
        'Their saved nickname was removed.',
      );
      expect(e.blob().custom_nicks).toEqual({ [OTHER]: 'Sam' });
      expect(e.blob().command_access).toEqual({ nick: { users: [TARGET] } });
      expect(e.rerenderByOwner).toHaveBeenCalledWith(GUILD, TARGET);
      expect(order).toEqual(['reply', 'render']);
    });

    it('does not fail the command when the re-render does, since the restriction landed', async () => {
      const e = restrictEnv({ custom_nicks: { [TARGET]: 'Kay' } });
      e.rerenderByOwner.mockRejectedValue(new Error('discord is down'));
      const { content, followUp } = await restrict(e, addUser('nick'));
      expect(content).toContain('Their saved nickname was removed.');
      expect(e.blob().command_access).toEqual({ nick: { users: [TARGET] } });
      expect(e.warn).toHaveBeenCalledOnce();
      expect(followUp).not.toHaveBeenCalled();
      expect(e.env.reportError).not.toHaveBeenCalled();
    });

    /**
     * A repeat add that still removed a saved nickname changed stored data, so it
     * is told so in one sentence that does not contradict itself, and it is logged.
     */
    it('says so, and logs it, on a repeat that still removed a saved nickname', async () => {
      const e = restrictEnv({
        command_access: { nick: { users: [TARGET] } },
        custom_nicks: { [TARGET]: 'Kay' },
      });
      const { content } = await restrict(e, addUser('nick'));
      expect(content).toContain(
        `<@${TARGET}> is already restricted from **Nickname**. Their saved nickname was removed.`,
      );
      expect(content).not.toContain('nothing changed');
      expect(e.blob().custom_nicks).toEqual({});
      expect(e.serverLog).toHaveBeenCalledOnce();
      expect(e.rerenderByOwner).toHaveBeenCalledWith(GUILD, TARGET);
    });

    /**
     * The re-render is what makes the removed name stop showing in the person's
     * rooms, and it follows the write, not the reply.
     */
    it('still re-renders their rooms when the reply throws', async () => {
      const e = restrictEnv({ custom_nicks: { [TARGET]: 'Kay' } });
      const fake = fakeInteraction({
        kind: 'command',
        commandName: 'restrict',
        guildId: GUILD,
        manageChannels: true,
        ...addUser('nick'),
      });
      fake.reply.mockRejectedValue(new Error('Unknown interaction'));
      e.env.client.emit('interactionCreate', fake.interaction);
      await flush();

      expect(e.blob().custom_nicks).toEqual({});
      expect(e.rerenderByOwner).toHaveBeenCalledWith(GUILD, TARGET);
    });

    it('does not re-render when there was no nickname to remove', async () => {
      const e = restrictEnv({ custom_nicks: { [OTHER]: 'Sam' } });
      await restrict(e, addUser('nick'));
      expect(e.rerenderByOwner).not.toHaveBeenCalled();
    });

    it('does not re-render for a role, or for another feature', async () => {
      const e = restrictEnv({ custom_nicks: { [TARGET]: 'Kay' } });
      await restrict(e, addRole('nick', ROLE));
      await restrict(e, addUser('rename'));
      expect(e.rerenderByOwner).not.toHaveBeenCalled();
      expect(e.blob().custom_nicks).toEqual({ [TARGET]: 'Kay' });
    });
  });

  /**
   * The hard gate stops writes and destroys nothing, so a gated admin can still see
   * who is restricted and lift a restriction, and cannot put a new one up. The
   * same split `/botprofile`'s resets and sets make.
   */
  /**
   * Every write that changes who is restricted brings the posted panels into line,
   * as `/controlpanel` edits do: a room whose owner a rule now covers loses the
   * button, and one it no longer covers gets it back. A write that changed nothing
   * re-renders nothing, since proving it to every room in the server is traffic.
   */
  describe('refreshes the room panels', () => {
    it.each([
      ['an add', {}, addUser('rename')],
      ['a remove', { command_access: { rename: { users: [TARGET] } } }, removeUser('rename')],
      [
        'a clear',
        { command_access: { rename: { users: [TARGET] } } },
        { subcommand: 'clear', optionFeature: 'rename' },
      ],
    ] as const)('after %s that changed something', async (_what, initial, opts) => {
      const e = restrictEnv(initial as never);
      await restrict(e, opts as never);
      expect(e.refreshGuildPanels).toHaveBeenCalledTimes(1);
      expect(e.refreshGuildPanels).toHaveBeenCalledWith(GUILD);
    });

    it.each([
      ['a repeat add', { command_access: { rename: { users: [TARGET] } } }, addUser('rename')],
      ['removing somebody who was not restricted', {}, removeUser('rename')],
      [
        'clearing a feature nobody was restricted from',
        {},
        { subcommand: 'clear', optionFeature: 'rename' },
      ],
    ] as const)('not after %s', async (_what, initial, opts) => {
      const e = restrictEnv(initial as never);
      await restrict(e, opts as never);
      expect(e.refreshGuildPanels).not.toHaveBeenCalled();
    });

    it('not after a refused add', async () => {
      const e = restrictEnv();
      await restrict(e, addUser('rename', TARGET, { member: { permissions: holds(MANAGE) } }));
      expect(e.refreshGuildPanels).not.toHaveBeenCalled();
    });

    it('and a refresh that fails does not fail the command', async () => {
      const e = restrictEnv();
      e.refreshGuildPanels.mockRejectedValue(new Error('discord is down'));
      const { content } = await restrict(e, addUser('rename'));
      await flush();
      expect(content).toContain('can no longer use **Name**');
      expect(e.env.reportError).not.toHaveBeenCalled();
    });
  });

  /**
   * While `command_access.disabled` is set the rules are kept and nothing is
   * refused, and an admin reading a list or adding a rule has to be told, or "can
   * no longer use" would be untrue in the sentence above it.
   */
  describe('while enforcement is paused', () => {
    const paused = { commandAccessDisabled: vi.fn().mockResolvedValue(true) };

    it('says so at the top of the list, above the rules it qualifies', async () => {
      const e = restrictEnv({ command_access: { rename: { users: [TARGET] } } }, paused);
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content.startsWith('Enforcement is paused right now')).toBe(true);
      expect(content).toContain(`**Name**: <@${TARGET}>`);
      expect(content.length).toBeLessThanOrEqual(2000);
    });

    it('does not say so when enforcement is on', async () => {
      const e = restrictEnv({}, { commandAccessDisabled: vi.fn().mockResolvedValue(false) });
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content).not.toContain('Enforcement is paused');
    });

    it('does not say so when the lever is not wired at all', async () => {
      const e = restrictEnv();
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content).not.toContain('Enforcement is paused');
    });

    it('still lists, adds and removes, which the lever never blocks', async () => {
      const e = restrictEnv({}, paused);
      const added = await restrict(e, addUser('rename'));
      expect(e.blob().command_access).toEqual({ rename: { users: [TARGET] } });
      expect(added.content).toContain('Enforcement is paused right now');
      expect(added.content).toContain('can no longer use **Name**');
      const removed = await restrict(e, removeUser('rename'));
      expect(e.blob().command_access).toBeUndefined();
      expect(removed.content).not.toContain('Enforcement is paused');
    });
  });

  describe('in a hard-gated guild', () => {
    const gated = () => ({
      guilds: {
        get: vi.fn().mockResolvedValue({ authStatus: 'expired' }),
        isEntitled: vi.fn().mockResolvedValue(false),
      } as never,
      selfHosted: false,
    });

    it('refuses add with the reactivation notice, and writes nothing', async () => {
      const e = restrictEnv({}, gated());
      const { content } = await restrict(e, addUser('rename'));
      expect(content).toContain('auto-voice.io');
      expect(e.mergeSettings).not.toHaveBeenCalled();
    });

    it('still lists', async () => {
      const e = restrictEnv({ command_access: { rename: { users: [TARGET] } } }, gated());
      const { content } = await restrict(e, { subcommand: 'list' });
      expect(content).not.toContain('auto-voice.io');
      expect(content).toContain(`**Name**: <@${TARGET}>`);
    });

    it('still removes', async () => {
      const e = restrictEnv({ command_access: { rename: { users: [TARGET] } } }, gated());
      const { content } = await restrict(e, removeUser('rename'));
      expect(content).toBe(`✅ <@${TARGET}> can use **Name** again.`);
      expect(e.blob()).not.toHaveProperty('command_access');
    });

    it('still clears, which is a removal too', async () => {
      const e = restrictEnv({ command_access: { rename: { users: [TARGET] } } }, gated());
      const { content } = await restrict(e, { subcommand: 'clear', optionFeature: 'rename' });
      expect(content).not.toContain('auto-voice.io');
      expect(content).toContain('Removed 1 restriction on **Name**');
      expect(e.blob()).not.toHaveProperty('command_access');
    });
  });

  /**
   * Rendered replies, not source text: a source scan only ever catches a curly
   * quote, and every reply here is assembled from a mention, a label and a clause.
   */
  it('follows the copy rules in every reply it gives', async () => {
    const stored = { command_access: { rename: { users: [TARGET] } } };
    const scenarios: [
      Record<string, unknown>,
      Partial<FakeInteractionOpts> & { subcommand: string },
    ][] = [
      [{}, addUser('privacy')],
      [{}, addUser('limit')],
      [{}, addUser('rename')],
      [{}, addUser('transfer')],
      [{ custom_nicks: { [TARGET]: 'Kay' } }, addUser('nick')],
      [{}, addRole('rename', ROLE)],
      [{}, addRole('rename', GUILD)],
      [{}, addRole('rename', ROLE, String(MANAGE))],
      [{}, addUser('rename', TARGET, { user: { id: TARGET, bot: true } })],
      [{}, addUser('rename', TARGET, { member: { permissions: holds(MANAGE) } })],
      [{}, addUser('claim')],
      [stored, addUser('rename')],
      [stored, removeUser('rename')],
      [{}, removeUser('rename')],
      [
        { command_access: { rename: { roles: [ROLE] } } },
        removeUser('rename', { role: { id: ROLE, permissions: '0' } }),
      ],
      [stored, { subcommand: 'clear', optionFeature: 'rename' }],
      [{}, { subcommand: 'clear', optionFeature: 'rename' }],
      [
        { command_access: { nick: { users: [TARGET] } }, custom_nicks: { [TARGET]: 'Kay' } },
        addUser('nick'),
      ],
      [{}, { subcommand: 'list' }],
      [{ command_access: { rename: { users: [TARGET], roles: [ROLE] } } }, { subcommand: 'list' }],
      [{}, { ...addUser('rename'), manageChannels: false }],
    ];
    const replies: string[] = [];
    const logLines: string[] = [];
    for (const [initial, opts] of scenarios) {
      const e = restrictEnv(initial);
      replies.push((await restrict(e, opts)).content);
      logLines.push(...e.serverLog.mock.calls.map((call) => call[2] as string));
      dispose?.();
    }
    expect(replies.every((r) => r.length > 0)).toBe(true);
    // Add, remove and clear, for a person and for a role: the lines go to a channel
    // other people read, so they are held to the same rules as the replies.
    expect(logLines.length).toBeGreaterThanOrEqual(8);
    expect(new Set(logLines.map((l) => l.replace(/\*\*.*\*\*/, '**X**'))).size).toBe(3);
    for (const text of [...replies, ...logLines]) {
      expect(text, 'no em or en dashes').not.toMatch(/[—–]/);
      expect(text, 'straight quotes only').not.toMatch(/[‘’“”]/);
      expect(text, 'no prose semicolons').not.toContain(';');
      expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
      expect(text.length).toBeLessThanOrEqual(2000);
    }
  });
});

/**
 * The restriction guard: one policy on every path that does what a restricted
 * command does, so a rule that stops `/name` also stops the Name button, the
 * `/template` channel editor `/name` opens, and the voice status.
 *
 * Driven through the real router with a settings blob on the guild row, because
 * that row is where the guard reads the rules from. The things worth pinning are
 * the ones a unit test of the policy cannot see: which doors exist, that none of
 * them can edit the shared panel, that `showModal` is still the first response,
 * that undo directions stay open, and that every read problem fails open.
 */
describe('registerInteractionHandler (the restriction guard)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const KAY = '111111111111111111';
  const OTHER = '222222222222222222';
  const DENIED_ROLE = '333333333333333333';
  const OTHER_ROLE = '444444444444444444';
  const EVERYONE = '460459401086763010';

  /** Every feature `/restrict` offers, denied to Kay by id. */
  const DENY_KAY = {
    privacy: { users: [KAY] },
    hide: { users: [KAY] },
    limit: { users: [KAY] },
    rename: { users: [KAY] },
    transfer: { users: [KAY] },
    nick: { users: [KAY] },
  };

  /** The words a refusal uses, for the five features a command or a button can be stopped on. */
  const REFUSAL = (label: string) => `A server admin has turned off **${label}** for you.`;

  /** Spies for everything a restricted door would reach. */
  function services() {
    const ok = () => vi.fn().mockResolvedValue({ ok: true, message: 'done' });
    return {
      setLimit: ok(),
      unlimit: ok(),
      setName: ok(),
      setStatus: ok(),
      claim: ok(),
      transfer: ok(),
      makePrivate: ok(),
      makePublic: ok(),
      hide: ok(),
      unhide: ok(),
      setNick: ok(),
      getEditorState: vi.fn().mockResolvedValue({ found: false, scope: 'channel' }),
      getRoomPanelState: vi.fn().mockResolvedValue({
        ownerId: KAY,
        members: [
          { id: KAY, displayName: 'Kay', bot: false },
          { id: OTHER, displayName: 'Ana', bot: false },
        ],
        userLimit: 4,
      }),
      rerenderByOwner: vi.fn().mockResolvedValue({ considered: 0, renamed: 0, rateLimited: 0 }),
    };
  }

  function guardEnv(
    rules: Record<string, unknown> | string | undefined,
    overrides: Partial<InteractionDeps> = {},
    row: Record<string, unknown> = {},
  ) {
    const s = services();
    const countCommand = vi.fn();
    const commandAccessDisabled = vi.fn().mockResolvedValue(false);
    const warn = vi.fn();
    const info = vi.fn();
    const get = vi.fn().mockResolvedValue({
      authStatus: 'active',
      ...(rules === undefined ? {} : { settings: { command_access: rules } }),
      ...row,
    });
    const env = setup({
      guilds: { get, isEntitled: vi.fn().mockResolvedValue(true) } as never,
      voiceCommands: {
        setLimit: s.setLimit,
        unlimit: s.unlimit,
        setName: s.setName,
        setStatus: s.setStatus,
        claim: s.claim,
        transfer: s.transfer,
      } as never,
      privacy: {
        makePrivate: s.makePrivate,
        makePublic: s.makePublic,
        hide: s.hide,
        unhide: s.unhide,
      } as never,
      settings: {
        setNick: s.setNick,
        getConfig: vi
          .fn()
          .mockResolvedValue({ enabled: true, primaries: [], aliases: {}, lists: {} }),
        recordContact: vi.fn().mockResolvedValue(undefined),
      } as never,
      feature: {
        getEditorState: s.getEditorState,
        getRoomPanelState: s.getRoomPanelState,
        rerenderByOwner: s.rerenderByOwner,
      } as never,
      logger: { ...fakeLogger(), warn, info } as never,
      countCommand,
      commandAccessDisabled,
      ...overrides,
    });
    dispose = env.dispose;
    return { env, s, countCommand, commandAccessDisabled, warn, info, get };
  }

  type Env = ReturnType<typeof guardEnv>;

  /** Emits one interaction as Kay (by default) and waits for the router to settle. */
  async function fire(env: Env, opts: FakeInteractionOpts) {
    const fake = fakeInteraction({ userId: KAY, ...opts });
    env.env.client.emit('interactionCreate', fake.interaction);
    await flush();
    return fake;
  }

  /** Everything the caller was sent, whichever way it was delivered. */
  const sent = (f: ReturnType<typeof fakeInteraction>): string =>
    [...f.reply.mock.calls, ...f.followUp.mock.calls, ...f.editReply.mock.calls]
      .map((call) => JSON.stringify(call[0]))
      .join('\n');

  /**
   * A refusal, and nothing else: an ephemeral answer that names the feature, and
   * never an edit of the message the interaction came from, which on the room
   * panel is the one public message every occupant reads.
   */
  function expectRefused(f: ReturnType<typeof fakeInteraction>, label: string): void {
    expect(sent(f)).toContain(REFUSAL(label));
    expect(f.interaction.update).not.toHaveBeenCalled();
    expect(f.interaction.showModal).not.toHaveBeenCalled();
    expect(f.interaction.deferUpdate).not.toHaveBeenCalled();
    if (f.reply.mock.calls.length > 0) {
      expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    }
  }

  const notRefused = (f: ReturnType<typeof fakeInteraction>): boolean =>
    !sent(f).includes('A server admin has turned off');

  // -- slash commands --------------------------------------------------------

  const COMMANDS = [
    { name: 'limit', label: 'Size', acted: (s: ReturnType<typeof services>) => s.setLimit },
    {
      name: 'private',
      label: 'Private',
      acted: (s: ReturnType<typeof services>) => s.makePrivate,
    },
    { name: 'hide', label: 'Hide', acted: (s: ReturnType<typeof services>) => s.hide },
    { name: 'name', label: 'Name', acted: (s: ReturnType<typeof services>) => s.getEditorState },
    { name: 'transfer', label: 'Transfer', acted: (s: ReturnType<typeof services>) => s.transfer },
    { name: 'nick', label: 'Nickname', acted: (s: ReturnType<typeof services>) => s.setNick },
  ] as const;

  describe.each(COMMANDS)('/$name', ({ name, label, acted }) => {
    it('refuses a member who is denied it, ephemerally, before anything is done', async () => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, { kind: 'command', commandName: name, voiceChannelId: 'room-1' });
      expectRefused(f, label);
      expect(acted(e.s)).not.toHaveBeenCalled();
      // Not deferred: a refusal is a plain reply and a deferred one would have
      // to be edited into one, and nothing was going to take three seconds.
      expect(f.interaction.deferReply).not.toHaveBeenCalled();
      // And not counted: the number means "commands that ran".
      expect(e.countCommand).not.toHaveBeenCalled();
    });

    it('lets a member through who is not named by the rule', async () => {
      const e = guardEnv({
        privacy: { users: [OTHER] },
        hide: { users: [OTHER] },
        limit: { users: [OTHER] },
        rename: { users: [OTHER] },
        transfer: { users: [OTHER] },
        nick: { users: [OTHER] },
      });
      const f = await fire(e, { kind: 'command', commandName: name, voiceChannelId: 'room-1' });
      expect(notRefused(f)).toBe(true);
      expect(acted(e.s)).toHaveBeenCalled();
      expect(e.countCommand).toHaveBeenCalledWith(name);
    });

    it('never restricts a member who can manage channels, or an administrator', async () => {
      for (const holds of [{ manageChannels: true }, { administrator: true }]) {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, {
          kind: 'command',
          commandName: name,
          voiceChannelId: 'room-1',
          ...holds,
        });
        expect(notRefused(f)).toBe(true);
        expect(acted(e.s)).toHaveBeenCalled();
        dispose?.();
      }
    });
  });

  /** A rule on a ROLE reaches a member through whichever shape discord.js gave us. */
  describe('a rule that names a role', () => {
    const RULES = { limit: { roles: [DENIED_ROLE] } };

    it.each(['guildMember', 'raw'] as const)(
      'refuses a member holding it (%s shape)',
      async (shape) => {
        const e = guardEnv(RULES);
        const f = await fire(e, {
          kind: 'command',
          commandName: 'limit',
          voiceChannelId: 'room-1',
          memberRoles: [OTHER_ROLE, DENIED_ROLE],
          memberShape: shape,
        });
        expectRefused(f, 'Size');
        expect(e.s.setLimit).not.toHaveBeenCalled();
      },
    );

    it.each(['guildMember', 'raw'] as const)(
      'lets a member without it through (%s shape)',
      async (shape) => {
        const e = guardEnv(RULES);
        const f = await fire(e, {
          kind: 'command',
          commandName: 'limit',
          voiceChannelId: 'room-1',
          memberRoles: [OTHER_ROLE],
          memberShape: shape,
        });
        expect(notRefused(f)).toBe(true);
        expect(e.s.setLimit).toHaveBeenCalled();
      },
    );

    it('has no roles to match when there is no member, so a role rule cannot refuse', async () => {
      const e = guardEnv(RULES);
      const f = await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalled();
    });

    /**
     * A member's own role list includes `@everyone`, whose id is the guild id.
     * A stored rule naming it would deny the whole server, so it is dropped both
     * where it is read and where the caller's roles are built, and each shape
     * is checked because the real class includes it and the raw one does not.
     */
    it.each(['guildMember', 'raw'] as const)(
      'is not tripped by a stored @everyone rule (%s shape)',
      async (shape) => {
        const e = guardEnv({ limit: { roles: [EVERYONE] } });
        const f = await fire(e, {
          kind: 'command',
          commandName: 'limit',
          guildId: EVERYONE,
          voiceChannelId: 'room-1',
          memberRoles: [OTHER_ROLE],
          memberShape: shape,
        });
        expect(notRefused(f)).toBe(true);
        expect(e.s.setLimit).toHaveBeenCalled();
      },
    );
  });

  /**
   * Undo directions are never restricted. An owner whose creator channel starts
   * rooms private must always be able to open one, and a limit of 0 is what
   * `/unlimit` does by another name.
   */
  describe('the undo directions', () => {
    it('leaves /public, /unhide, /unlimit and /reclaim open to a member denied everything', async () => {
      for (const commandName of ['public', 'unhide', 'unlimit', 'reclaim']) {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, { kind: 'command', commandName, voiceChannelId: 'room-1' });
        expect(notRefused(f), commandName).toBe(true);
        dispose?.();
      }
      const e = guardEnv(DENY_KAY);
      await fire(e, { kind: 'command', commandName: 'public', voiceChannelId: 'room-1' });
      expect(e.s.makePublic).toHaveBeenCalled();
      const shown = guardEnv(DENY_KAY);
      await fire(shown, { kind: 'command', commandName: 'unhide', voiceChannelId: 'room-1' });
      expect(shown.s.unhide).toHaveBeenCalledWith('g1', 'room-1', KAY);
    });

    it('treats /limit 0 as removing a limit, so it is never restricted', async () => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, {
        kind: 'command',
        commandName: 'limit',
        voiceChannelId: 'room-1',
        optionInteger: 0,
      });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalledWith('g1', 'room-1', KAY, 0);
    });

    it('still refuses /limit with a real count', async () => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, {
        kind: 'command',
        commandName: 'limit',
        voiceChannelId: 'room-1',
        optionInteger: 5,
      });
      expectRefused(f, 'Size');
    });

    /**
     * `/restrict add` clears the saved nickname of a USER it names but cannot list
     * a ROLE's members, so a member under a role rule holds saved text that only
     * they can remove. The guard must leave them that way out.
     */
    it.each(['reset', 'RESET', '  Reset  ', '', '   '])(
      'treats /nick %j as removing the nickname, so it is never restricted',
      async (optionString) => {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, {
          kind: 'command',
          commandName: 'nick',
          voiceChannelId: 'room-1',
          optionString,
        });
        expect(notRefused(f)).toBe(true);
        expect(e.s.setNick).toHaveBeenCalledWith('g1', KAY, optionString);
        expect(e.countCommand).toHaveBeenCalledWith('nick');
      },
    );

    it('still refuses /nick with a name, including one that only starts with reset', async () => {
      for (const optionString of ['Big Kay', 'resets']) {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, {
          kind: 'command',
          commandName: 'nick',
          voiceChannelId: 'room-1',
          optionString,
        });
        expectRefused(f, 'Nickname');
        expect(e.s.setNick).not.toHaveBeenCalled();
        dispose?.();
      }
    });
  });

  // -- the trace a refusal leaves ---------------------------------------------

  /**
   * A refusal is seen only from the member's side, so the log line is the one
   * thing an operator has when a rule is refusing people it was not meant to. Ids
   * only: never what the member typed.
   */
  describe('what an operator can see of a refusal', () => {
    it('logs the guild, the member and the feature, and nothing they typed', async () => {
      const e = guardEnv(DENY_KAY);
      await fire(e, {
        kind: 'command',
        commandName: 'nick',
        voiceChannelId: 'room-1',
        optionString: 'a secret nickname',
      });
      expect(e.info).toHaveBeenCalledWith(
        { guildId: 'g1', userId: KAY, feature: 'nick' },
        'refused by a restriction',
      );
      expect(JSON.stringify(e.info.mock.calls)).not.toContain('secret');
    });

    it('logs nothing when the member is let through, or while enforcement is off', async () => {
      const allowed = guardEnv({ limit: { users: [OTHER] } });
      await fire(allowed, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(allowed.info).not.toHaveBeenCalled();
      dispose?.();

      const paused = guardEnv(DENY_KAY, { commandAccessDisabled: vi.fn().mockResolvedValue(true) });
      await fire(paused, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(paused.info).not.toHaveBeenCalled();
    });
  });

  // -- fail open -------------------------------------------------------------

  describe('on any read problem it lets the member through', () => {
    it.each([
      ['a row with no settings at all', undefined],
      ['a command_access that is not a map', 'garbage'],
      ['an entry that is not a map', { limit: 'nope' }],
      ['an entry whose lists are not lists', { limit: { users: 'u', roles: 5 } }],
      ['ids that are not snowflakes', { limit: { users: ['kay'], roles: ['admins'] } }],
    ])('%s', async (_what, rules) => {
      const e = guardEnv(rules as never);
      const f = await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalled();
    });

    it('when reading the settings throws, and says so by id', async () => {
      const poisoned = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      );
      const e = guardEnv(undefined, {}, { settings: poisoned });
      const f = await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalled();
      expect(e.warn).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1', feature: 'limit' }),
        expect.stringContaining('allowing it'),
      );
    });

    it('when asking the lever throws', async () => {
      const e = guardEnv(DENY_KAY, {
        commandAccessDisabled: vi.fn().mockRejectedValue(new Error('db down')),
      });
      const f = await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalled();
    });
  });

  // -- the lever -------------------------------------------------------------

  describe('command_access.disabled', () => {
    it('refuses nobody while it is on', async () => {
      const e = guardEnv(DENY_KAY, { commandAccessDisabled: vi.fn().mockResolvedValue(true) });
      const f = await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalled();
    });

    it('is asked once when a refusal is about to happen', async () => {
      const e = guardEnv(DENY_KAY);
      await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(e.commandAccessDisabled).toHaveBeenCalledTimes(1);
    });

    /** A server with no rules, and a member no rule names, never pays for the read. */
    it.each([
      ['a server with no rules', undefined],
      ['a member no rule names', { limit: { users: [OTHER] } }],
      ['a feature nobody is denied', { rename: { users: [KAY] } }],
    ])('is never read for %s', async (_what, rules) => {
      const e = guardEnv(rules as never);
      await fire(e, { kind: 'command', commandName: 'limit', voiceChannelId: 'room-1' });
      expect(e.commandAccessDisabled).not.toHaveBeenCalled();
    });

    it('is never read for a member who can manage channels', async () => {
      const e = guardEnv(DENY_KAY);
      await fire(e, {
        kind: 'command',
        commandName: 'limit',
        voiceChannelId: 'room-1',
        manageChannels: true,
      });
      expect(e.commandAccessDisabled).not.toHaveBeenCalled();
    });
  });

  // -- the room panel --------------------------------------------------------

  describe('the room panel', () => {
    const ROOM = 'room-9';

    it.each([
      ['lock', 'Private', (s: ReturnType<typeof services>) => s.makePrivate],
      ['hide', 'Hide', (s: ReturnType<typeof services>) => s.hide],
      ['limit', 'Size', (s: ReturnType<typeof services>) => s.getRoomPanelState],
      ['rename', 'Name', (s: ReturnType<typeof services>) => s.getRoomPanelState],
      ['transfer', 'Transfer', (s: ReturnType<typeof services>) => s.getRoomPanelState],
    ] as const)(
      'refuses the %s button for a denied member, without editing the panel',
      async (action, label, acted) => {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, { kind: 'button', customId: controlPanelId(action, ROOM) });
        expectRefused(f, label);
        // Not even the room is read: the refusal comes first, so a modal is never
        // opened for somebody who cannot use it and a picker never offered.
        expect(acted(e.s)).not.toHaveBeenCalled();
        expect(f.interaction.deferReply).not.toHaveBeenCalled();
      },
    );

    it('leaves Public, Unhide, Claim and Kick open to a member denied everything', async () => {
      for (const action of ['unlock', 'unhide', 'claim', 'kick'] as const) {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, { kind: 'button', customId: controlPanelId(action, ROOM) });
        expect(notRefused(f), action).toBe(true);
        dispose?.();
      }
      const e = guardEnv(DENY_KAY);
      await fire(e, { kind: 'button', customId: controlPanelId('unlock', ROOM) });
      expect(e.s.makePublic).toHaveBeenCalledWith('g1', ROOM, KAY);
      const shown = guardEnv(DENY_KAY);
      await fire(shown, { kind: 'button', customId: controlPanelId('unhide', ROOM) });
      expect(shown.s.unhide).toHaveBeenCalledWith('g1', ROOM, KAY);
    });

    it('lets a member who is not denied Hide press it', async () => {
      const e = guardEnv({ hide: { users: [OTHER] } });
      await fire(e, { kind: 'button', customId: controlPanelId('hide', ROOM) });
      expect(e.s.hide).toHaveBeenCalledWith('g1', ROOM, KAY);
    });

    it('opens the modals and the picker for a member who is not denied', async () => {
      const e = guardEnv({ limit: { users: [OTHER] } });
      const limit = await fire(e, { kind: 'button', customId: controlPanelId('limit', ROOM) });
      expect(limit.interaction.showModal).toHaveBeenCalled();
      const rename = await fire(e, { kind: 'button', customId: controlPanelId('rename', ROOM) });
      expect(rename.interaction.showModal).toHaveBeenCalled();
      const transfer = await fire(e, {
        kind: 'button',
        customId: controlPanelId('transfer', ROOM),
      });
      expect(JSON.stringify(transfer.reply.mock.calls[0]?.[0])).toContain('transferpick');
    });

    it('never restricts a member who can manage channels', async () => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, {
        kind: 'button',
        customId: controlPanelId('rename', ROOM),
        manageChannels: true,
      });
      expect(f.interaction.showModal).toHaveBeenCalled();
    });

    /** A modal outlives the rule that was added after it opened. */
    it('refuses a stale Size modal and a stale Name modal', async () => {
      const e = guardEnv(DENY_KAY);
      const size = await fire(e, {
        kind: 'modal',
        customId: controlPanelId('limitset', ROOM),
        textInputs: { input: '5' },
      });
      expectRefused(size, 'Size');
      expect(e.s.setLimit).not.toHaveBeenCalled();

      const name = await fire(e, {
        kind: 'modal',
        customId: controlPanelId('renameset', ROOM),
        textInputs: { input: 'my room' },
      });
      expectRefused(name, 'Name');
      expect(e.s.setName).not.toHaveBeenCalled();
    });

    /**
     * A blank box and a 0 both remove the limit, which is the undo direction, so
     * a denied member whose Size modal was already open can still take one off.
     */
    it.each([
      ['blank', '  '],
      ['zero', '0'],
    ])('lets a %s Size box through, since it only removes a limit', async (_what, input) => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, {
        kind: 'modal',
        customId: controlPanelId('limitset', ROOM),
        textInputs: { input },
      });
      expect(notRefused(f)).toBe(true);
      expect(e.s.setLimit).toHaveBeenCalledWith('g1', ROOM, KAY, 0);
    });

    it('refuses a stale Transfer picker, and leaves the Kick picker alone', async () => {
      const e = guardEnv(DENY_KAY);
      const transfer = await fire(e, {
        kind: 'stringSelect',
        customId: controlPanelId('transferpick', ROOM),
        values: [OTHER],
      });
      expectRefused(transfer, 'Transfer');
      expect(e.s.transfer).not.toHaveBeenCalled();

      const kick = await fire(e, {
        kind: 'stringSelect',
        customId: controlPanelId('kickpick', ROOM),
        values: [OTHER],
      });
      expect(notRefused(kick)).toBe(true);
    });

    it('does not stop a member who is not denied from picking', async () => {
      const e = guardEnv({ transfer: { users: [OTHER] } });
      await fire(e, {
        kind: 'stringSelect',
        customId: controlPanelId('transferpick', ROOM),
        values: [OTHER],
      });
      expect(e.s.transfer).toHaveBeenCalledWith('g1', ROOM, KAY, OTHER);
    });
  });

  // -- /name and the /template channel editor --------------------------------

  describe('the /name editor', () => {
    const ROOM = 'room-9';

    /**
     * `/name` out of a voice channel answers with a picker, and the chosen
     * channel arrives as a separate select interaction that never passes the
     * command's guard.
     */
    it('refuses the out-of-voice-channel picker', async () => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, { kind: 'select', customId: 'avc:setup:pick:name', values: [ROOM] });
      expectRefused(f, 'Name');
      expect(e.s.getEditorState).not.toHaveBeenCalled();
    });

    it('turns a denied member away from the editor before its modal opens', async () => {
      const e = guardEnv(DENY_KAY);
      const f = await fire(e, {
        kind: 'button',
        customId: editorId('edit', 'channel', 'name', ROOM),
      });
      expectRefused(f, 'Name');
    });

    it.each(['name', 'status'] as const)(
      'refuses a submitted %s, which shares one write path, and a reset',
      async (field) => {
        const e = guardEnv(DENY_KAY);
        const save = await fire(e, {
          kind: 'modal',
          customId: editorId('save', 'channel', field, ROOM),
          fromMessage: true,
          textInputs: { template: 'my room' },
        });
        expect(sent(save)).toContain(REFUSAL('Name'));
        // The editor message is the member's own, but nothing was written.
        expect(e.s.setName).not.toHaveBeenCalled();
        expect(e.s.setStatus).not.toHaveBeenCalled();

        const reset = await fire(e, {
          kind: 'button',
          customId: editorId('reset', 'channel', field, ROOM),
        });
        expect(sent(reset)).toContain(REFUSAL('Name'));
        expect(e.s.setName).not.toHaveBeenCalled();
        expect(e.s.setStatus).not.toHaveBeenCalled();
      },
    );

    it('lets a member who is not denied save a name', async () => {
      const e = guardEnv({ rename: { users: [OTHER] } });
      e.s.getEditorState.mockResolvedValue({
        found: true,
        scope: 'channel',
        ownerId: KAY,
        name: { effectiveTemplate: 'T', preview: 'T' },
        status: { effectiveTemplate: 'S', preview: 'S' },
      });
      await fire(e, {
        kind: 'modal',
        customId: editorId('save', 'channel', 'name', ROOM),
        fromMessage: true,
        textInputs: { template: 'my room' },
      });
      expect(e.s.setName).toHaveBeenCalledWith('g1', ROOM, KAY, 'my room', { admin: false });
    });

    it('never restricts a member who can manage channels', async () => {
      const e = guardEnv(DENY_KAY);
      await fire(e, {
        kind: 'modal',
        customId: editorId('save', 'channel', 'name', ROOM),
        fromMessage: true,
        manageChannels: true,
        textInputs: { template: 'my room' },
      });
      expect(e.s.setName).toHaveBeenCalledWith('g1', ROOM, KAY, 'my room', { admin: true });
    });
  });

  /**
   * Nothing a member is told here may say why, or who else is restricted, and it
   * is held to the same punctuation rules as every other reply, rendered rather
   * than scanned out of the source.
   */
  describe('what a refused member reads', () => {
    it('is the same plain sentence on every path, and names nobody', async () => {
      const lines: string[] = [];
      for (const [kind, extra] of [
        ['command', { commandName: 'limit', voiceChannelId: 'room-1' }],
        ['command', { commandName: 'private', voiceChannelId: 'room-1' }],
        ['command', { commandName: 'hide', voiceChannelId: 'room-1' }],
        ['command', { commandName: 'name', voiceChannelId: 'room-1' }],
        ['command', { commandName: 'transfer', voiceChannelId: 'room-1' }],
        ['command', { commandName: 'nick', voiceChannelId: 'room-1' }],
        ['button', { customId: controlPanelId('lock', 'room-9') }],
        ['button', { customId: controlPanelId('hide', 'room-9') }],
        ['modal', { customId: controlPanelId('renameset', 'room-9'), textInputs: { input: 'x' } }],
      ] as const) {
        const e = guardEnv(DENY_KAY);
        const f = await fire(e, { kind, ...extra } as FakeInteractionOpts);
        lines.push(sent(f));
        dispose?.();
      }
      const text = lines.join('\n');
      expect(text.match(/A server admin has turned off/g)).toHaveLength(lines.length);
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/[‘’“”]/);
      expect(text).not.toMatch(/;/);
      expect(text.toLowerCase()).not.toMatch(/primary|secondary|restrict/);
      expect(text).not.toContain('<@');
      expect(text).not.toContain(KAY);
    });
  });
});

/**
 * `/alwayshidden`: the sibling of `/alwaysprivate` that starts a creator channel's rooms hidden.
 * The toggle is the settings service's, so what is pinned here is the router: the in-code
 * Manage Channels gate on the slash command AND on the picker it opens, the channel it acts
 * on, what it answers with, and the hard gate.
 */
describe('registerInteractionHandler (/alwayshidden)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const toggle = () => vi.fn().mockResolvedValue({ ok: true, message: 'Now hidden.' });

  function envWith(over: Partial<InteractionDeps> = {}, toggleDefaultHidden = toggle()) {
    const env = setup({
      settings: { toggleDefaultHidden } as never,
      ...over,
    });
    dispose = env.dispose;
    return { env, toggleDefaultHidden };
  }

  it('toggles the creator channel the admin is in, and says what the service says', async () => {
    const { env, toggleDefaultHidden } = envWith();
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'alwayshidden',
      voiceChannelId: 'v1',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();

    expect(toggleDefaultHidden).toHaveBeenCalledWith('g1', 'v1');
    expect(reply).toHaveBeenCalledWith({ content: '✅ Now hidden.', ephemeral: true });
  });

  it('answers a refusal from the service as a warning, not a success', async () => {
    const { env } = envWith(
      {},
      vi.fn().mockResolvedValue({
        ok: false,
        message: 'You need to be in a bot-managed voice channel.',
      }),
    );
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'alwayshidden',
      voiceChannelId: 'v1',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('⚠️');
  });

  /**
   * Gated in code as well as by the command's default permission. That default is only a
   * DEFAULT: a server admin can re-open the command to any role in Integrations, and it
   * writes a creator channel's settings.
   */
  it('refuses a member without Manage Channels, and offers them no picker either', async () => {
    const { env, toggleDefaultHidden } = envWith();
    for (const voiceChannelId of ['v1', undefined]) {
      const { interaction, reply } = fakeInteraction({
        kind: 'command',
        commandName: 'alwayshidden',
        manageChannels: false,
        ...(voiceChannelId ? { voiceChannelId } : {}),
      });
      env.client.emit('interactionCreate', interaction);
      await flush();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
      );
      expect(JSON.stringify(reply.mock.calls[0]?.[0])).not.toContain('avc:setup:pick');
    }
    expect(toggleDefaultHidden).not.toHaveBeenCalled();
  });

  it('offers a channel picker outside a voice channel, which comes back to the same command', async () => {
    const { env, toggleDefaultHidden } = envWith();
    const { interaction, reply } = fakeInteraction({
      kind: 'command',
      commandName: 'alwayshidden',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain('avc:setup:pick:alwayshidden');
    expect(toggleDefaultHidden).not.toHaveBeenCalled();
    // The prompt a member reads, rendered, held to the copy rules.
    const prompt = (reply.mock.calls[0]?.[0] as { content: string }).content;
    expect(prompt).toContain('creator channel');
    expect(prompt).not.toMatch(/[—–‘’“”;]/);
    expect(prompt.toLowerCase()).not.toMatch(/primary|secondary/);
  });

  it('toggles the channel chosen in the picker, and gates the picker on Manage Channels as well', async () => {
    const { env, toggleDefaultHidden } = envWith();
    const admin = fakeInteraction({
      kind: 'select',
      customId: 'avc:setup:pick:alwayshidden',
      manageChannels: true,
      values: ['vc9'],
    });
    env.client.emit('interactionCreate', admin.interaction);
    await flush();
    expect(toggleDefaultHidden).toHaveBeenCalledWith('g1', 'vc9');
    expect(admin.interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: '✅ Now hidden.' }),
    );

    toggleDefaultHidden.mockClear();
    const member = fakeInteraction({
      kind: 'select',
      customId: 'avc:setup:pick:alwayshidden',
      manageChannels: false,
      values: ['vc9'],
    });
    env.client.emit('interactionCreate', member.interaction);
    await flush();
    expect(member.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
    );
    expect(toggleDefaultHidden).not.toHaveBeenCalled();
  });

  /**
   * It writes a creator channel's settings, so a guild that has lapsed gets the
   * reactivation notice and nothing is toggled. Nothing lists it as allowed while expired:
   * the picker's select is not one of the carve-outs either, so both routes are refused.
   */
  it('is a write, refused in a hard-gated guild by the command and by its picker', async () => {
    const { env, toggleDefaultHidden } = envWith({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });
    const command = fakeInteraction({
      kind: 'command',
      commandName: 'alwayshidden',
      voiceChannelId: 'v1',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', command.interaction);
    await flush();
    expect(JSON.stringify(command.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');

    const picked = fakeInteraction({
      kind: 'select',
      customId: 'avc:setup:pick:alwayshidden',
      manageChannels: true,
      values: ['vc9'],
    });
    env.client.emit('interactionCreate', picked.interaction);
    await flush();
    expect(JSON.stringify(picked.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
    expect(toggleDefaultHidden).not.toHaveBeenCalled();
  });

  /**
   * Counted once, as the command that ran, and routed through the guild's queue like every
   * other settings write, so a failing guild trips only its own breaker.
   */
  it('runs through the guild dispatcher under its own name', async () => {
    const names: string[] = [];
    const { env } = envWith({
      dispatcher: {
        dispatch: (_g: string, name: string, task: () => Promise<unknown>) => {
          names.push(name);
          return task();
        },
      } as never,
    });
    const { interaction } = fakeInteraction({
      kind: 'command',
      commandName: 'alwayshidden',
      voiceChannelId: 'v1',
      manageChannels: true,
    });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(names).toContain('cmd:alwayshidden');
  });
});

/**
 * The creator channel editor's two buttons for remembered room settings: the switch, and
 * "Clear saved settings". The writes are the settings service's, so what is pinned here is the
 * router: which id asks for what, who may press it, what a lapsed server gets, and that the
 * panel is edited in place with what was stored and not stacked or left stale.
 */
describe('registerInteractionHandler (remembered room settings)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  const CHANNEL = 'creator-9';
  const IDS = ['remember_on', 'remember_off', 'forget'] as const;
  const idFor = (action: string, scope: 'primary' | 'channel' = 'primary') =>
    editorId(action, scope, 'name', CHANNEL);

  const primaryState = (over: Record<string, unknown> = {}) => ({
    found: true,
    scope: 'primary',
    name: { effectiveTemplate: 'T', preview: 'T' },
    status: { effectiveTemplate: 'S', preview: 'S' },
    ownerId: null,
    primaryChannelId: CHANNEL,
    rememberPrefs: false,
    savedSettings: 0,
    ...over,
  });

  function envWith(
    opts: {
      set?: { ok: boolean; message: string };
      clear?: { ok: boolean; message: string };
      state?: Record<string, unknown>;
      over?: Partial<InteractionDeps>;
    } = {},
  ) {
    const setRememberPrefs = vi
      .fn()
      .mockResolvedValue(opts.set ?? { ok: true, message: 'Remembering is on.' });
    const clearRememberedPrefs = vi
      .fn()
      .mockResolvedValue(opts.clear ?? { ok: true, message: 'Removed 2 members.' });
    const getEditorState = vi.fn().mockResolvedValue(opts.state ?? primaryState());
    const env = setup({
      settings: { setRememberPrefs, clearRememberedPrefs } as never,
      feature: { getEditorState } as never,
      ...opts.over,
    });
    dispose = env.dispose;
    return { env, setRememberPrefs, clearRememberedPrefs, getEditorState };
  }

  async function press(
    env: ReturnType<typeof setup>,
    customId: string,
    over: Partial<FakeInteractionOpts> = {},
  ) {
    const fake = fakeInteraction({ kind: 'button', customId, manageChannels: true, ...over });
    env.client.emit('interactionCreate', fake.interaction);
    await flush();
    return fake;
  }

  const labelsOf = (payload: {
    components: { toJSON: () => { components: { label: string }[] } }[];
  }) => payload.components.map((row) => row.toJSON().components.map((b) => b.label));

  it.each([
    ['remember_on', true],
    ['remember_off', false],
  ] as const)('%s asks the service for exactly that state', async (action, enabled) => {
    const { env, setRememberPrefs, clearRememberedPrefs } = envWith();
    await press(env, idFor(action));
    expect(setRememberPrefs).toHaveBeenCalledWith('g1', CHANNEL, enabled);
    expect(clearRememberedPrefs).not.toHaveBeenCalled();
  });

  it('forget clears the creator channel and does not touch the switch', async () => {
    const { env, setRememberPrefs, clearRememberedPrefs } = envWith();
    await press(env, idFor('forget'));
    expect(clearRememberedPrefs).toHaveBeenCalledWith('g1', CHANNEL);
    expect(setRememberPrefs).not.toHaveBeenCalled();
  });

  /**
   * The target is in the id, not decided at click time, so a click on a stale panel, a
   * double click and a retry all end in what the click asked for.
   */
  it('is idempotent: pressing the same id twice asks for the same state twice', async () => {
    const { env, setRememberPrefs } = envWith();
    await press(env, idFor('remember_on'));
    await press(env, idFor('remember_on'));
    expect(setRememberPrefs.mock.calls).toEqual([
      ['g1', CHANNEL, true],
      ['g1', CHANNEL, true],
    ]);
  });

  /** Edited in place: acknowledged first, then the SAME message is edited, never a new one. */
  it.each(IDS)(
    '%s defers, then edits the panel in place with the service reply as its note',
    async (action) => {
      const { env, getEditorState } = envWith();
      const fake = await press(env, idFor(action));

      expect(fake.interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(fake.editReply).toHaveBeenCalledTimes(1);
      expect(fake.followUp).not.toHaveBeenCalled();
      expect(fake.reply).not.toHaveBeenCalled();
      expect(fake.interaction.update).not.toHaveBeenCalled();
      // The panel is re-read after the write, so it shows what is stored.
      expect(getEditorState).toHaveBeenCalledWith('primary', 'g1', CHANNEL);

      const payload = JSON.stringify(fake.editReply.mock.calls[0]?.[0]);
      expect(payload).toContain(action === 'forget' ? 'Removed 2 members.' : 'Remembering is on.');
      expect(payload).toContain('Saved');
      // And it is the editor again, not a bare confirmation.
      expect(payload).toContain('Edit name template');
    },
  );

  it('draws the switch from what is stored, not from what the click asked for', async () => {
    const { env } = envWith({ state: primaryState({ rememberPrefs: true, savedSettings: 4 }) });
    const fake = await press(env, idFor('remember_on'));
    const payload = fake.editReply.mock.calls[0]?.[0];
    expect(labelsOf(payload)[2]).toEqual(['Remembered settings: on', 'Clear saved settings']);
    expect(JSON.stringify(payload)).toContain('4 members have saved settings.');
    expect(JSON.stringify(payload)).toContain(idFor('remember_off'));
  });

  /**
   * The note for turning it on says members get their settings back, and the field beside it
   * says "switched off for now" while member_prefs.disabled is on. An admin must not read both.
   */
  describe('while remembering is switched off for now', () => {
    const paused = () =>
      envWith({
        state: primaryState({ rememberPrefs: true, rememberPaused: true, savedSettings: 2 }),
      });

    it('adds that to the note for turning it on', async () => {
      const { env } = paused();
      const fake = await press(env, idFor('remember_on'));
      const payload = JSON.stringify(fake.editReply.mock.calls[0]?.[0]);
      expect(payload).toContain('Remembering is on.');
      expect(payload).toContain('Remembering is switched off for now, so nothing is saved');
      expect(payload).toContain('On, but switched off for now.');
    });

    it('adds nothing to the note for turning it off or for clearing', async () => {
      const { env } = paused();
      for (const action of ['remember_off', 'forget'] as const) {
        const fake = await press(env, idFor(action));
        const payload = JSON.stringify(fake.editReply.mock.calls[0]?.[0]);
        expect(payload).not.toContain('Remembering is switched off for now');
      }
    });

    it('adds nothing to the note for turning it on when the lever is not on', async () => {
      const { env } = envWith({ state: primaryState({ rememberPrefs: true, savedSettings: 2 }) });
      const fake = await press(env, idFor('remember_on'));
      expect(JSON.stringify(fake.editReply.mock.calls[0]?.[0])).not.toContain(
        'Remembering is switched off for now',
      );
    });
  });

  it('keeps the editor at three rows after every press', async () => {
    const { env } = envWith();
    for (const action of IDS) {
      const fake = await press(env, idFor(action));
      expect(fake.editReply.mock.calls[0]?.[0].components).toHaveLength(3);
    }
  });

  describe('who may press them', () => {
    it.each(IDS)(
      'refuses %s from a member without Manage Channels, and writes nothing',
      async (action) => {
        const { env, setRememberPrefs, clearRememberedPrefs, getEditorState } = envWith();
        const fake = await press(env, idFor(action), { manageChannels: false });

        expect(fake.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
        );
        expect(setRememberPrefs).not.toHaveBeenCalled();
        expect(clearRememberedPrefs).not.toHaveBeenCalled();
        expect(getEditorState).not.toHaveBeenCalled();
        // Refused before it is acknowledged, so the panel is not left spinning.
        expect(fake.interaction.deferUpdate).not.toHaveBeenCalled();
      },
    );
  });

  /**
   * The hard gate stops writes and destroys nothing, and leaves removals open (the `/access`
   * erasures, the `/botprofile` resets). So the switch is a write and gets the reactivation
   * notice, and "Clear saved settings" only removes and works: it is how an admin takes back
   * what their members saved once the server is no longer paying. Only a panel that was
   * already open when the server lapsed can press either, since the editor's commands are not
   * on the list of what still opens.
   */
  describe('in a hard-gated guild', () => {
    const expired = () => ({
      selfHosted: false,
      guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'expired' }) } as never,
    });

    it.each(['remember_on', 'remember_off'] as const)(
      'refuses %s with the reactivation notice and writes nothing',
      async (action) => {
        const { env, setRememberPrefs, clearRememberedPrefs, getEditorState } = envWith({
          over: expired(),
        });
        const fake = await press(env, idFor(action));

        expect(JSON.stringify(fake.reply.mock.calls[0]?.[0])).toContain('auto-voice.io');
        expect(setRememberPrefs).not.toHaveBeenCalled();
        expect(clearRememberedPrefs).not.toHaveBeenCalled();
        expect(getEditorState).not.toHaveBeenCalled();
        expect(fake.interaction.deferUpdate).not.toHaveBeenCalled();
      },
    );

    it('lets "Clear saved settings" through, since it only removes, and edits the panel in place', async () => {
      const { env, setRememberPrefs, clearRememberedPrefs } = envWith({ over: expired() });
      const fake = await press(env, idFor('forget'));

      expect(clearRememberedPrefs).toHaveBeenCalledWith('g1', CHANNEL);
      expect(setRememberPrefs).not.toHaveBeenCalled();
      expect(fake.interaction.deferUpdate).toHaveBeenCalledTimes(1);
      expect(fake.editReply).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(fake.editReply.mock.calls[0]?.[0])).toContain('Removed 2 members.');
      expect(fake.reply).not.toHaveBeenCalled();
    });

    /** The exemption is the one id on the creator channel's editor, and Manage Channels still decides who. */
    it('still needs Manage Channels to clear', async () => {
      const { env, clearRememberedPrefs } = envWith({ over: expired() });
      const fake = await press(env, idFor('forget'), { manageChannels: false });

      expect(fake.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'You need the Manage Channels permission.' }),
      );
      expect(clearRememberedPrefs).not.toHaveBeenCalled();
    });

    /** Only the creator channel's editor draws it, so the same action under a room scope is not exempt. */
    it('does not exempt the same action under a room scope, and no other editor button', async () => {
      for (const customId of [
        idFor('forget', 'channel'),
        idFor('reset'),
        idFor('save'),
        idFor('edit'),
      ]) {
        const { env, clearRememberedPrefs } = envWith({ over: expired() });
        const fake = await press(env, customId);

        expect(JSON.stringify(fake.reply.mock.calls[0]?.[0]), customId).toContain('auto-voice.io');
        expect(clearRememberedPrefs).not.toHaveBeenCalled();
        env.dispose();
      }
    });

    /** The same ids, from an active server, work: the refusal above is the gate and nothing else. */
    it('lets the same ids through for an entitled server', async () => {
      const { env, setRememberPrefs } = envWith({
        over: {
          selfHosted: false,
          guilds: { get: vi.fn().mockResolvedValue({ authStatus: 'active' }) } as never,
        },
      });
      await press(env, idFor('remember_on'));
      expect(setRememberPrefs).toHaveBeenCalledTimes(1);
    });
  });

  describe('when something is wrong', () => {
    it.each(IDS)(
      'answers a refused %s privately and leaves the panel as it was',
      async (action) => {
        const { env } = envWith({
          set: { ok: false, message: 'That creator channel no longer exists.' },
          clear: { ok: false, message: 'That creator channel no longer exists.' },
        });
        const fake = await press(env, idFor(action));

        expect(fake.followUp).toHaveBeenCalledWith({
          content: '⚠️ That creator channel no longer exists.',
          ephemeral: true,
        });
        expect(fake.editReply).not.toHaveBeenCalled();
      },
    );

    it('says so, and edits nothing, when the creator channel is gone by the time it re-reads', async () => {
      const { env } = envWith({ state: { found: false, scope: 'primary' } });
      const fake = await press(env, idFor('remember_on'));
      expect(fake.followUp).toHaveBeenCalledWith({
        content: 'That channel is no longer bot-managed.',
        ephemeral: true,
      });
      expect(fake.editReply).not.toHaveBeenCalled();
    });

    /** Only a creator channel's editor draws these, so any other scope is not from this build. */
    it.each(IDS)(
      'treats %s under a room scope as out of date and writes nothing',
      async (action) => {
        const { env, setRememberPrefs, clearRememberedPrefs } = envWith();
        const fake = await press(env, idFor(action, 'channel'));
        expect(JSON.stringify(fake.reply.mock.calls[0]?.[0])).toContain('out of date');
        expect(setRememberPrefs).not.toHaveBeenCalled();
        expect(clearRememberedPrefs).not.toHaveBeenCalled();
      },
    );
  });

  /** Routed through the guild's queue like every other settings write, so one guild's breaker is its own. */
  it('runs through the guild dispatcher under its own names', async () => {
    const names: string[] = [];
    const { env } = envWith({
      over: {
        dispatcher: {
          dispatch: (_g: string, name: string, task: () => Promise<unknown>) => {
            names.push(name);
            return task();
          },
        } as never,
      },
    });
    await press(env, idFor('remember_on'));
    await press(env, idFor('forget'));
    expect(names).toContain('editor:primary:remember_on');
    expect(names).toContain('editor:primary:forget');
    expect(names).toContain('editor:refresh');
  });

  /** What the admin reads, rendered, held to the copy rules like every other reply. */
  it('answers in words that keep to the copy rules', async () => {
    const real = new GuildSettingsService({
      guilds: {} as never,
      autoChannels: {
        get: vi.fn().mockResolvedValue({ channelId: CHANNEL, guildId: 'g1', template: {} }),
        setRememberPrefs: vi.fn().mockResolvedValue({ channelId: CHANNEL }),
      } as never,
      secondaries: { get: vi.fn().mockResolvedValue(undefined) } as never,
      actions: {} as never,
      logger: fakeLogger(),
      memberPrefs: { clearByPrimary: vi.fn().mockResolvedValue(3) } as never,
    });
    const { env } = envWith({ over: { settings: real as never } });
    // Only what a member can read: a custom id says `primary` for the scope and is never shown.
    const visible = (payload: {
      embeds: { description?: string; fields: { name: string; value: string }[] }[];
      components: { toJSON: () => { components: { label: string }[] } }[];
    }): string[] => [
      payload.embeds[0]!.description ?? '',
      ...payload.embeds[0]!.fields.flatMap((f) => [f.name, f.value]),
      ...payload.components.flatMap((row) => row.toJSON().components.map((b) => b.label)),
    ];
    const lines: string[] = [];
    for (const action of IDS) {
      const fake = await press(env, idFor(action));
      lines.push(...visible(fake.editReply.mock.calls[0]?.[0]));
    }
    const text = lines.join('\n');
    expect(text).toContain('Privacy page');
    expect(text).toContain('Removed the saved settings of 3 members');
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/[‘’“”]/);
    expect(text).not.toMatch(/;/);
    expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
  });
});
