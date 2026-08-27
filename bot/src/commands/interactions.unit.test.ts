import { EventEmitter } from 'node:events';
import { DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { registerInteractionHandler, type InteractionDeps } from './interactions.js';
import { LOGGING_MODAL_ID } from './loggingModal.js';
import { CREATE_MODAL_ID } from './createModal.js';
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
  values?: string[];
  /** The interaction id (the retry token is keyed off it). */
  id?: string;
  /** Modal text inputs by custom id (name/nameTemplate/statusTemplate). */
  textInputs?: Record<string, string>;
  /** The `privacy` string-select value. */
  privacy?: 'open' | 'private';
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
          get: (id: string) =>
            opts.category && opts.category.id === id
              ? {
                  name: opts.category.name,
                  permissionsFor: () => ({ has: (p: bigint) => holds(opts.category!.perms, p) }),
                }
              : undefined,
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
        (opts.manageChannels ?? false) && p === PermissionFlagsBits.ManageChannels,
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
    deferReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    values: opts.values ?? [],
    fields: {
      getStringSelectValues: (k: string) => (k === 'privacy' && opts.privacy ? [opts.privacy] : []),
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
    getConfig: vi.fn().mockResolvedValue({ enabled: true, primaries: [], aliases: {} }),
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
    const { interaction, reply } = fakeInteraction({ kind: 'command', commandName: 'setup' });
    env.client.emit('interactionCreate', interaction);
    await flush();
    expect(env.reportError).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '⚠️ Something went wrong handling that: boom' }),
    );
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
    env.settings.getConfig.mockResolvedValue({ enabled: true, primaries: [], aliases });
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
