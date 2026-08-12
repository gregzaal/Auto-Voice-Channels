import type { Logger } from '@avc/core';
import {
  ActivityType,
  type Client,
  type DMChannel,
  type NonThreadGuildBasedChannel,
  type Presence,
  type VoiceState,
} from 'discord.js';
import type { GuildDispatcher } from '../../runtime/dispatcher.js';
import { normalizeVoiceState } from './discordAdapter.js';
import type { VoiceFeature } from './handler.js';
import { RenameScheduler } from './renameScheduler.js';

/** Minimal presence shape the activity signature reads (eases testing). */
interface PresenceLike {
  activities: readonly {
    type: ActivityType;
    name: string;
    state?: string | null;
    details?: string | null;
    party?: { size?: readonly [number, number] } | null;
  }[];
}

/**
 * A signature of the only presence fields a channel name can depend on — the
 * Playing/Streaming activities' name/state/details/party size. Status and
 * custom-status changes (the bulk of presence traffic) leave it unchanged, so we
 * can cheaply skip the rerender they'd otherwise trigger.
 */
export function gameSignature(presence: PresenceLike | null | undefined): string {
  if (!presence) return '';
  return presence.activities
    .filter((a) => a.type === ActivityType.Playing || a.type === ActivityType.Streaming)
    .map(
      (a) =>
        `${a.type}:${a.name}:${a.state ?? ''}:${a.details ?? ''}:${a.party?.size?.join('/') ?? ''}`,
    )
    .join('|');
}

export interface VoiceGatewayDeps {
  client: Client;
  dispatcher: GuildDispatcher;
  feature: VoiceFeature;
  logger: Logger;
  /** Debounce window for dynamic renames (ms). Defaults to 4000. */
  renameDelayMs?: number;
  /**
   * Sync entitlement gate (monetization.md §4 hard gate): when it returns
   * false the event is dropped BEFORE the dispatcher/queue, so non-entitled
   * guilds cost ~0 CPU/RAM. Omitted → all guilds pass (tests, self-host).
   */
  entitled?: (guildId: string) => boolean;
  /**
   * Called (sync, fire-and-forget) when a member joins a voice channel in a
   * non-entitled guild — the one carve-out from the short-circuit, so joining
   * a creator channel can surface a throttled "AVC is paused here" notice.
   */
  onGatedJoin?: (guildId: string, channelId: string) => void;
  /**
   * Called when a member LEAVES a channel in a non-entitled guild, so a temp
   * channel that just emptied is still tidied away. Gating stops AVC creating
   * channels; it should not leave dead empty ones behind for an admin to clear
   * up by hand.
   */
  onGatedLeave?: (guildId: string, channelId: string) => void;
}

/**
 * Bridges discord.js voice + presence events to the voice feature, routing each
 * one through the per-guild dispatcher so processing is ordered within a guild
 * and fault-isolated across guilds.
 *
 * - `voiceStateUpdate` drives create/move/cleanup, and reports which secondaries
 *   may need a re-render (join/leave changes `@@num@@`/games).
 * - `presenceUpdate` schedules a re-render for the secondary a member is in when
 *   their game changes.
 *
 * Renames are debounced per channel and dispatched as their own queued tasks.
 *
 * @returns a disposer that detaches listeners and cancels pending renames.
 */
export function registerVoiceGateway(deps: VoiceGatewayDeps): () => void {
  const scheduler = new RenameScheduler({
    delayMs: deps.renameDelayMs ?? 4000,
    run: (guildId, channelId) => {
      // Re-check the gate at fire time: a rename scheduled during a fail-open
      // window (cold cache at boot / after a NOTIFY eviction) must not execute
      // once the refresh has resolved the guild as gated — the rename path has
      // no downstream entitlement check of its own.
      if (deps.entitled && !deps.entitled(guildId)) return Promise.resolve();
      return deps.dispatcher.dispatch(guildId, 'rerenderChannel', async () => {
        // Routes to the secondary or adopted-managed re-render as appropriate.
        // `abandon`: nobody is waiting on this, so a channel we can no longer act
        // on must stop being tracked rather than be retried on every event.
        await deps.feature.rerenderChannelName(guildId, channelId, {
          onUnmanageable: 'abandon',
        });
      });
    },
    onError: (err, guildId, channelId) => {
      deps.logger.error({ err, guildId, channelId }, 'secondary re-render failed');
    },
  });

  const onVoice = (oldState: VoiceState, newState: VoiceState): void => {
    const event = normalizeVoiceState(oldState, newState);
    if (!event) return;
    if (event.beforeChannelId === event.afterChannelId) return; // mute/unmute

    // Hard-gate short-circuit: a non-entitled guild's voice events never reach
    // the dispatcher (enforcement + the §10 cost model). Joins are handed to
    // the gated-join hook so creator channels can post the reactivation notice.
    if (deps.entitled && !deps.entitled(event.guildId)) {
      if (event.afterChannelId) deps.onGatedJoin?.(event.guildId, event.afterChannelId);
      if (event.beforeChannelId) deps.onGatedLeave?.(event.guildId, event.beforeChannelId);
      return;
    }

    void deps.dispatcher
      .dispatch(event.guildId, 'voiceStateUpdate', () => deps.feature.handleVoiceStateUpdate(event))
      .then((touched) => {
        for (const channelId of touched) scheduler.schedule(event.guildId, channelId);
      })
      .catch((err: unknown) => {
        deps.logger.error({ err, guildId: event.guildId }, 'voiceStateUpdate handling failed');
      });
  };

  const onPresence = (oldPresence: Presence | null, newPresence: Presence): void => {
    // Presence is the highest-volume event (and the biggest scaling-cost driver),
    // so filter as cheaply as possible and build NO log object on the common path.
    // 1. Only members currently in a voice channel can affect a managed name.
    const guildId = newPresence.guild?.id;
    const channelId = newPresence.member?.voice.channelId;
    if (!guildId || !channelId) return;
    // 2. Skip the constant status / custom-status churn: only act when a
    //    Playing/Streaming activity actually changed (the fields a name reads).
    if (gameSignature(oldPresence) === gameSignature(newPresence)) return;
    // 3. Hard-gate short-circuit: presence is the dominant scaling cost, so a
    //    non-entitled guild's presence churn does no work at all.
    if (deps.entitled && !deps.entitled(guildId)) return;
    // The rename is debounced per channel and the re-render no-ops if the channel
    // isn't a managed secondary/adopted channel, so scheduling here is cheap and safe.
    scheduler.schedule(guildId, channelId);
  };

  const onChannelDelete = (channel: DMChannel | NonThreadGuildBasedChannel): void => {
    if (channel.isDMBased()) return;
    const guildId = channel.guild.id;
    // Deliberately NOT gated on `entitled`: this is bookkeeping for a channel that
    // no longer exists, it is a rare O(1) event rather than presence-style churn,
    // and a gated guild that later reactivates must not inherit rows pointing at
    // channels Discord deleted while it was paused.
    void deps.dispatcher
      .dispatch(guildId, 'channelDelete', () =>
        deps.feature.handleChannelDeleted(guildId, channel.id),
      )
      .catch((err: unknown) => {
        deps.logger.error({ err, guildId, channelId: channel.id }, 'channelDelete handling failed');
      });
  };

  deps.client.on('voiceStateUpdate', onVoice);
  deps.client.on('presenceUpdate', onPresence);
  deps.client.on('channelDelete', onChannelDelete);

  return () => {
    deps.client.off('voiceStateUpdate', onVoice);
    deps.client.off('presenceUpdate', onPresence);
    deps.client.off('channelDelete', onChannelDelete);
    scheduler.clear();
  };
}
