import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/** Custom-id prefix for the "⇩ Join" request Approve/Deny/Block buttons. */
export const JOIN_PREFIX = 'avc:join:';

export type JoinAction = 'approve' | 'deny' | 'block';

/** Builds a join request's custom id: `avc:join:<action>:<joinChannelId>:<requesterId>`. */
export function joinId(action: JoinAction, joinChannelId: string, requesterId: string): string {
  return `${JOIN_PREFIX}${action}:${joinChannelId}:${requesterId}`;
}

/** The Approve / Deny / Block button row for a join request. */
export function buildJoinRow(
  joinChannelId: string,
  requesterId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(joinId('approve', joinChannelId, requesterId))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(joinId('deny', joinChannelId, requesterId))
      .setLabel('Deny')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(joinId('block', joinChannelId, requesterId))
      .setLabel('Block')
      .setStyle(ButtonStyle.Danger),
  );
}

/** Parses a join-request custom id; null if it isn't one / is malformed. */
export function parseJoinId(
  customId: string,
): { action: JoinAction; joinChannelId: string; requesterId: string } | null {
  if (!customId.startsWith(JOIN_PREFIX)) return null;
  const [, , action, joinChannelId, requesterId] = customId.split(':');
  if (
    (action !== 'approve' && action !== 'deny' && action !== 'block') ||
    !joinChannelId ||
    !requesterId
  ) {
    return null;
  }
  return { action, joinChannelId, requesterId };
}
