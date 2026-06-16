import type { Logger } from '@avc/core';
import { ActivityType, type Client, type Presence, type VoiceState } from 'discord.js';
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
    run: (guildId, channelId) =>
      deps.dispatcher.dispatch(guildId, 'rerenderChannel', async () => {
        // Routes to the secondary or adopted-managed re-render as appropriate.
        await deps.feature.rerenderChannelName(guildId, channelId);
      }),
    onError: (err, guildId, channelId) => {
      deps.logger.error({ err, guildId, channelId }, 'secondary re-render failed');
    },
  });

  const onVoice = (oldState: VoiceState, newState: VoiceState): void => {
    const event = normalizeVoiceState(oldState, newState);
    if (!event) return;
    if (event.beforeChannelId === event.afterChannelId) return; // mute/unmute

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
    // The rename is debounced per channel and the re-render no-ops if the channel
    // isn't a managed secondary/adopted channel, so scheduling here is cheap and safe.
    scheduler.schedule(guildId, channelId);
  };

  deps.client.on('voiceStateUpdate', onVoice);
  deps.client.on('presenceUpdate', onPresence);

  return () => {
    deps.client.off('voiceStateUpdate', onVoice);
    deps.client.off('presenceUpdate', onPresence);
    scheduler.clear();
  };
}
