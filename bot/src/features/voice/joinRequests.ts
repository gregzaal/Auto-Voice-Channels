import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type VoiceState,
} from 'discord.js';
import type { Logger } from '@avc/core';
import type { PrivacyService } from './privacy.js';

export interface JoinRequestsDeps {
  client: Client;
  privacy: PrivacyService;
  logger: Logger;
}

/**
 * Watches for members joining a "⇩ Join {creator}" companion channel and posts a
 * request to the private channel's owner (Approve / Deny / Block buttons, handled
 * in the interaction router). The requester simply waits in the join channel
 * until the owner decides. The owner re-entering their own join channel is
 * ignored.
 *
 * @returns a disposer that detaches the listener.
 */
export function registerJoinRequests(deps: JoinRequestsDeps): () => void {
  const onVoice = (oldState: VoiceState, newState: VoiceState): void => {
    const joinChannelId = newState.channelId;
    if (!joinChannelId || joinChannelId === oldState.channelId) return;
    const guildId = newState.guild?.id;
    const requesterId = newState.member?.id;
    if (!guildId || !requesterId) return;
    void post(joinChannelId, requesterId).catch((err: unknown) => {
      deps.logger.error({ err, guildId, joinChannelId }, 'join request failed');
    });
  };

  async function post(joinChannelId: string, requesterId: string): Promise<void> {
    const ctx = await deps.privacy.getJoinContext(joinChannelId);
    if (!ctx) return; // not a join channel
    if (requesterId === ctx.creatorId) return; // owner re-entering their own lobby

    const channel = await deps.client.channels.fetch(ctx.requestChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`avc:join:approve:${joinChannelId}:${requesterId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`avc:join:deny:${joinChannelId}:${requesterId}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`avc:join:block:${joinChannelId}:${requesterId}`)
        .setLabel('Block')
        .setStyle(ButtonStyle.Danger),
    );
    await channel.send({
      content: `🔔 <@${ctx.creatorId}>, <@${requesterId}> would like to join your private channel.`,
      components: [row],
    });
  }

  deps.client.on('voiceStateUpdate', onVoice);
  return () => {
    deps.client.off('voiceStateUpdate', onVoice);
  };
}
