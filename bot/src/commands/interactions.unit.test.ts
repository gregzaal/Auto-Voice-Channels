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
}

/** Builds a minimal interaction with the methods/getters the router touches. */
function fakeInteraction(opts: FakeInteractionOpts) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const holds = (flags: bigint[] | undefined, p: bigint): boolean => (flags ?? []).includes(p);
  const interaction = {
    id: opts.id ?? 'i1',
    guildId: opts.guildId ?? 'g1',
    user: { id: 'u1' },
    member: null,
    guild: {
      members: {
        cache: { get: () => undefined },
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
  return { interaction, reply, followUp };
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
