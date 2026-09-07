import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { registerInteractionHandler, type InteractionDeps } from './interactions.js';
import { LOGGING_MODAL_ID } from './loggingModal.js';
import { CREATE_FROM_SETUP_MODAL_ID, CREATE_MODAL_ID } from './createModal.js';
import { GENERAL_MODAL_ID, SETUP_SETTINGS_ID, setupId } from './setupPanel.js';
import { listsId, LISTS_SELECT_ID } from './listsPanel.js';
import { TIMEZONE_MODAL_ID } from './timezoneModal.js';
import { editorId } from './templatePanel.js';
import { ALIAS_MODAL_ID } from './aliasModal.js';
import { ALIAS_SELECT_ID, aliasHash, aliasId } from './aliasPanel.js';

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
  privacy?: 'open' | 'private';
  /** Any other modal string-select values, by custom id (e.g. logging's `level`). */
  selectValues?: Record<string, string[]>;
  /** The category chosen in the modal's channel-select. */
  selectedChannelId?: string;
  /** Permission flags the bot member holds guild-wide. */
  botPerms?: bigint[];
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
  /**
   * Voice channels in the guild cache, and whether the CALLER can see each.
   *
   * Separate from {@link category} because the two questions differ: that one
   * asks what the BOT holds on a category, this one asks what the caller can
   * see, which is what binds a channel id somebody typed to what they may look
   * at.
   */
  voiceChannels?: Record<string, { name: string; callerCanSee: boolean }>;
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
    user: { id: 'u1', username: 'kay', displayName: 'Kay' },
    member: null,
    locale: opts.locale,
    guild: {
      members: {
        cache: {
          get: () =>
            opts.voiceChannelId ? { voice: { channelId: opts.voiceChannelId } } : undefined,
        },
        me: { permissions: { has: (p: bigint) => holds(opts.botPerms, p) } },
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
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    values: opts.values ?? [],
    options: {
      getInteger: () => opts.optionInteger ?? 2,
      getString: () => opts.optionString ?? 'x',
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
   * Decision 3 and decision 15, which are a pair and are the reason both are
   * asserted here rather than left to the allow-list reading correctly.
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
   * this in-code check is the only thing enforcing decision 1.
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

  function submitFailingCreate(env: ReturnType<typeof setup>) {
    const { interaction, reply } = fakeInteraction({
      kind: 'modal',
      customId: CREATE_MODAL_ID,
      manageChannels: true,
      id: 'modal-1',
      textInputs: { name: 'Lobby', nameTemplate: 'T', statusTemplate: 'S' },
      privacy: 'private',
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
 * `/templateassistant` routing (`plans/assisted_templates.md` §2 and §5).
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

  // Admin-gated exactly like /template, and that is the *only* gate (§5).
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
  const deferring = ['limit', 'unlimit', 'private', 'public', 'reclaim', 'transfer', 'nick'];

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
        } as never,
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
    expect(env.deps.feature.channelInfo).toHaveBeenCalledWith('g1', OTHER);
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
