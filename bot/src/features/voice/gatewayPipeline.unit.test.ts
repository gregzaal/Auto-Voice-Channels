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
function harness(opts: { entitled?: (guildId: string) => boolean; serving?: () => boolean } = {}) {
  const client = new EventEmitter();
  const handleVoiceStateUpdate = vi.fn(async () => ['sec-1']);
  const rerenderChannelName = vi.fn(async () => ({}));
  const onGatedJoin = vi.fn();
  const feature = { handleVoiceStateUpdate, rerenderChannelName } as unknown as VoiceFeature;
  const dispose = registerVoiceGateway({
    client: client as unknown as Client,
    dispatcher: new GuildDispatcher({ logger: fakeLogger() }),
    feature,
    logger: fakeLogger(),
    renameDelayMs: 5,
    ...(opts.entitled ? { entitled: opts.entitled, onGatedJoin } : {}),
    ...(opts.serving ? { serving: opts.serving } : {}),
  });
  return { client, handleVoiceStateUpdate, rerenderChannelName, onGatedJoin, dispose };
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
    // `abandon`: nobody is waiting on a background re-render, so an unmanageable
    // channel must stop being tracked rather than be retried forever.
    await tick(20);
    expect(h.rerenderChannelName).toHaveBeenCalledWith('g1', 'sec-1', {
      onUnmanageable: 'abandon',
    });
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
    expect(h.rerenderChannelName).toHaveBeenCalledWith('g1', 'sec-1', {
      onUnmanageable: 'abandon',
    });
  });

  it('ignores a presence change for a member not in a voice channel', async () => {
    const h = harness();
    dispose = h.dispose;
    h.client.emit('presenceUpdate', presence('g1', null, 'Halo'), presence('g1', null, 'Doom'));
    await tick(20);
    expect(h.rerenderChannelName).not.toHaveBeenCalled();
  });

  it('short-circuits voice events for non-entitled guilds before the dispatcher', async () => {
    const h = harness({ entitled: (guildId) => guildId !== 'gated' });
    dispose = h.dispose;

    h.client.emit(
      'voiceStateUpdate',
      voiceState('gated', 'u1', null),
      voiceState('gated', 'u1', 'creator-1'),
    );
    await tick(10);
    expect(h.handleVoiceStateUpdate).not.toHaveBeenCalled();
    // The join is handed to the gated-join hook (creator-channel notice path).
    expect(h.onGatedJoin).toHaveBeenCalledWith('gated', 'creator-1');

    // An entitled guild still flows through untouched.
    h.client.emit(
      'voiceStateUpdate',
      voiceState('ok', 'u1', null),
      voiceState('ok', 'u1', 'sec-1'),
    );
    await tick(10);
    expect(h.handleVoiceStateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'ok' }),
    );
  });

  it('short-circuits presence churn for non-entitled guilds (no rerender scheduled)', async () => {
    const h = harness({ entitled: () => false });
    dispose = h.dispose;
    h.client.emit(
      'presenceUpdate',
      presence('gated', 'sec-1', undefined),
      presence('gated', 'sec-1', 'Halo'),
    );
    await tick(20);
    expect(h.rerenderChannelName).not.toHaveBeenCalled();
    // A leave (no after-channel) never triggers the gated-join hook.
    h.client.emit(
      'voiceStateUpdate',
      voiceState('gated', 'u1', 'sec-1'),
      voiceState('gated', 'u1', null),
    );
    await tick(10);
    expect(h.onGatedJoin).not.toHaveBeenCalled();
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
  /**
   * **`plans/scaling.md` §6.1's live half, which the ownership primitive cannot
   * reach.**
   *
   * `ownsGuild` is consulted by the reconcile sweep and the two record-vanished
   * branches, all convergent and low-frequency. The live path had no ownership
   * check at all, so in the split-brain §6.1 describes, an instance whose lease
   * has aged out still holds the shard's WebSocket, still receives every join,
   * and still creates a room alongside the peer that legitimately claimed that
   * shard. Two real Discord channels, two rows, duplicate renames on top. Three
   * documents claimed this was fixed while it was not.
   */
  describe('an instance that cannot prove it owns its shards', () => {
    it('drops a join rather than creating a room a peer is also creating', async () => {
      const h = harness({ serving: () => false });
      dispose = h.dispose;
      h.client.emit(
        'voiceStateUpdate',
        voiceState('g1', 'u1', null),
        voiceState('g1', 'u1', 'sec-1'),
      );
      await tick(10);
      expect(h.handleVoiceStateUpdate).not.toHaveBeenCalled();
    });

    it('drops presence churn rather than issuing a duplicate rename', async () => {
      const h = harness({ serving: () => false });
      dispose = h.dispose;
      h.client.emit(
        'presenceUpdate',
        presence('g1', 'sec-1', 'Halo'),
        presence('g1', 'sec-1', 'Doom'),
      );
      await tick(20);
      expect(h.rerenderChannelName).not.toHaveBeenCalled();
    });

    /**
     * The rename is debounced for four seconds, so the claim can expire during
     * the wait. Re-checked at fire time for the same reason the entitlement gate
     * is.
     */
    it('drops a debounced rename whose claim expired while it waited', async () => {
      let serving = true;
      const h = harness({ serving: () => serving });
      dispose = h.dispose;
      h.client.emit(
        'voiceStateUpdate',
        voiceState('g1', 'u1', null),
        voiceState('g1', 'u1', 'sec-1'),
      );
      await tick(1);
      serving = false;
      await tick(20);
      expect(h.handleVoiceStateUpdate).toHaveBeenCalled();
      expect(h.rerenderChannelName).not.toHaveBeenCalled();
    });

    it('serves normally once ownership is proven again', async () => {
      const h = harness({ serving: () => true });
      dispose = h.dispose;
      h.client.emit(
        'voiceStateUpdate',
        voiceState('g1', 'u1', null),
        voiceState('g1', 'u1', 'sec-1'),
      );
      await tick(20);
      expect(h.handleVoiceStateUpdate).toHaveBeenCalled();
    });
  });
});
