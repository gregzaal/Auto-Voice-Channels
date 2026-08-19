import { EventEmitter } from 'node:events';
import { DiscordAPIError, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { registerInteractionHandler, type InteractionDeps } from './interactions.js';
import { LOGGING_MODAL_ID } from './loggingModal.js';
import { CREATE_MODAL_ID } from './createModal.js';

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
  kind: 'command' | 'button' | 'select' | 'modal';
  guildId?: string | null;
  commandName?: string;
  customId?: string;
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
    isModalSubmit: () => opts.kind === 'modal',
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
