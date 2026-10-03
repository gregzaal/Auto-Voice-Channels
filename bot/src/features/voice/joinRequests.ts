import { type Client, type VoiceState } from 'discord.js';
import type { Logger } from '@avc/core';
import { buildJoinRow } from './joinPanel.js';
import type { PrivacyService } from './privacy.js';

export interface JoinRequestsDeps {
  client: Client;
  privacy: PrivacyService;
  logger: Logger;
  /**
   * Sync entitlement gate (monetization hard gate): joins in non-entitled
   * guilds are dropped before any DB read — a gated guild's leftover private
   * channels must not keep generating join-request messages the owner can't
   * act on. Omitted → all guilds pass (tests, self-host).
   */
  entitled?: (guildId: string) => boolean;
  /**
   * Runs guild work through the guild's queue, which is where it is ordered with the
   * rest of that guild's changes and counted by its breaker. The knock check can move
   * a member out of voice, so it goes through here when this is given. Omitted (tests)
   * it runs directly.
   */
  run?: <T>(guildId: string, name: string, task: () => Promise<T>) => Promise<T>;
}

/**
 * Watches for members joining a "⇩ Join {owner}" companion channel and posts a
 * request to the private channel's owner (Approve / Deny / Block buttons, handled
 * in the interaction router). The requester simply waits in the join channel
 * until the owner decides. The owner re-entering their own join channel is
 * ignored, and so is a member the owner has blocked, who is moved out instead.
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
    if (deps.entitled && !deps.entitled(guildId)) return;
    void post(joinChannelId, requesterId).catch((err: unknown) => {
      deps.logger.error({ err, guildId, joinChannelId }, 'join request failed');
    });
  };

  async function post(joinChannelId: string, requesterId: string): Promise<void> {
    const ctx = await deps.privacy.getJoinContext(joinChannelId);
    if (!ctx) return; // not a join channel
    if (requesterId === ctx.creatorId) return; // owner re-entering their own lobby

    // Somebody the owner has blocked, or a vote removed, gets no card: they are asked
    // to leave the lobby and the owner never hears about it. Before anything is posted.
    // The check itself never throws, so a rejection is the guild's queue refusing the work
    // (a tripped breaker, a drain). It is a safeguard and a card the owner did not need is
    // better than none, so the knock goes through as it did before the check existed.
    try {
      const check = (): Promise<boolean> => deps.privacy.refuseBlockedKnock(ctx, requesterId);
      const refused = deps.run ? await deps.run(ctx.guildId, 'join:knock', check) : await check();
      if (refused) return;
    } catch (err) {
      deps.logger.debug(
        { err, guildId: ctx.guildId, joinChannelId },
        'knock check was not run, posting the card',
      );
    }

    // Post the request into the private channel's OWN integrated text chat: only
    // the owner (who is inside) and admitted members can see it — outsiders and
    // the un-admitted requester cannot. (Denying Connect already hides this chat.)
    const secondary = await deps.client.channels.fetch(ctx.secondaryChannelId).catch(() => null);
    if (secondary?.isTextBased() && 'send' in secondary) {
      await secondary.send({
        content: `🔔 <@${ctx.creatorId}>, <@${requesterId}> would like to join.`,
        components: [buildJoinRow(joinChannelId, requesterId)],
      });
    }

    // The requester can't see the private channel, so confirm in the public
    // "⇩ Join {owner}" companion's text chat (which they can see) that their
    // request was sent.
    const lobby = await deps.client.channels.fetch(joinChannelId).catch(() => null);
    if (lobby?.isTextBased() && 'send' in lobby) {
      await lobby.send(
        `🔔 <@${requesterId}>, your request to join was sent. Please wait for the owner to respond.`,
      );
    }
  }

  deps.client.on('voiceStateUpdate', onVoice);
  return () => {
    deps.client.off('voiceStateUpdate', onVoice);
  };
}
