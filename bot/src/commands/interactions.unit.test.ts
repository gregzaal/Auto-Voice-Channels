import { EventEmitter } from 'node:events';
import { PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { registerInteractionHandler, type InteractionDeps } from './interactions.js';
import { LOGGING_MODAL_ID } from './loggingModal.js';

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
}

/** Builds a minimal interaction with the methods/getters the router touches. */
function fakeInteraction(opts: FakeInteractionOpts) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    guildId: opts.guildId ?? 'g1',
    user: { id: 'u1' },
    member: null,
    guild: { members: { cache: { get: () => undefined } } },
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
    fields: { getStringSelectValues: () => [], getSelectedChannels: () => null },
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
  const guilds = { get: vi.fn().mockResolvedValue({ authStatus: 'active' }) };
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
      expect.objectContaining({ content: '⚠️ Something went wrong handling that.' }),
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
});
