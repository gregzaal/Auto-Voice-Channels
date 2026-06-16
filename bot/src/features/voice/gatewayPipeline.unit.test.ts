import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityType, type Client, type Presence, type VoiceState } from 'discord.js';
import { registerVoiceGateway } from './gateway.js';
import { GuildDispatcher } from '../../runtime/dispatcher.js';
import type { VoiceFeature } from './handler.js';
import { fakeLogger } from '../../runtime/testUtils.js';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function voiceState(guildId: string, userId: string, channelId: string | null): VoiceState {
  return {
    guild: { id: guildId },
    channelId,
    member: {
      id: userId,
      displayName: userId,
      user: { bot: false },
      presence: { activities: [] },
      roles: { cache: new Map<string, unknown>() },
      voice: { streaming: false },
    },
  } as unknown as VoiceState;
}

function presence(guildId: string, channelId: string | null, game: string | undefined): Presence {
  return {
    guild: { id: guildId },
    member: { voice: { channelId } },
    activities: game ? [{ type: ActivityType.Playing, name: game }] : [],
  } as unknown as Presence;
}

/** Wires the real gateway + real dispatcher to a spy feature, via a fake client. */
function harness() {
  const client = new EventEmitter();
  const handleVoiceStateUpdate = vi.fn(async () => ['sec-1']);
  const rerenderChannelName = vi.fn(async () => ({}));
  const feature = { handleVoiceStateUpdate, rerenderChannelName } as unknown as VoiceFeature;
  const dispose = registerVoiceGateway({
    client: client as unknown as Client,
    dispatcher: new GuildDispatcher({ logger: fakeLogger() }),
    feature,
    logger: fakeLogger(),
    renameDelayMs: 5,
  });
  return { client, handleVoiceStateUpdate, rerenderChannelName, dispose };
}

describe('registerVoiceGateway (gateway → dispatcher → feature pipeline)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('routes a voiceStateUpdate through the dispatcher to the feature, then rerenders the touched channel', async () => {
    const h = harness();
    dispose = h.dispose;

    h.client.emit(
      'voiceStateUpdate',
      voiceState('g1', 'u1', null), // was not in a channel
      voiceState('g1', 'u1', 'sec-1'), // joined sec-1
    );

    await tick(0);
    expect(h.handleVoiceStateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g1', afterChannelId: 'sec-1' }),
    );

    // The returned "touched" channel is scheduled for a debounced rerender.
    await tick(20);
    expect(h.rerenderChannelName).toHaveBeenCalledWith('g1', 'sec-1');
  });

  it('ignores a mute/unmute (same channel before and after)', async () => {
    const h = harness();
    dispose = h.dispose;
    h.client.emit(
      'voiceStateUpdate',
      voiceState('g1', 'u1', 'sec-1'),
      voiceState('g1', 'u1', 'sec-1'),
    );
    await tick(10);
    expect(h.handleVoiceStateUpdate).not.toHaveBeenCalled();
  });

  it('schedules a rerender when a member in voice changes game', async () => {
    const h = harness();
    dispose = h.dispose;
    h.client.emit(
      'presenceUpdate',
      presence('g1', 'sec-1', undefined),
      presence('g1', 'sec-1', 'Halo'),
    );
    await tick(20);
    expect(h.rerenderChannelName).toHaveBeenCalledWith('g1', 'sec-1');
  });

  it('ignores a presence change for a member not in a voice channel', async () => {
    const h = harness();
    dispose = h.dispose;
    h.client.emit('presenceUpdate', presence('g1', null, 'Halo'), presence('g1', null, 'Doom'));
    await tick(20);
    expect(h.rerenderChannelName).not.toHaveBeenCalled();
  });

  it('the disposer detaches listeners (no work after dispose)', async () => {
    const h = harness();
    h.dispose();
    h.client.emit(
      'voiceStateUpdate',
      voiceState('g1', 'u1', null),
      voiceState('g1', 'u1', 'sec-1'),
    );
    await tick(10);
    expect(h.handleVoiceStateUpdate).not.toHaveBeenCalled();
  });
});
