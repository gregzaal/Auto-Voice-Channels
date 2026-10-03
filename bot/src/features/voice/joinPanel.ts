import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/** Custom-id prefix for the "⇩ Join" request Approve/Deny/Block buttons. */
export const JOIN_PREFIX = 'avc:join:';

/**
 * Custom-id prefix for the card's Always allow button, which is not another action
 * under {@link JOIN_PREFIX} on purpose.
 *
 * An instance that predates the button answers a prefix it does not know with "That
 * button is out of date", but `parseJoinId` reads an unknown ACTION under `avc:join:`
 * as nothing and the old handler returns without a word, which leaves the owner with a
 * bare "This interaction failed". The three ids that already exist are untouched, so
 * an older card and an older instance keep working byte for byte.
 */
export const ALWAYS_PREFIX = 'avc:always:';

/** Builds Always allow's custom id: `avc:always:<joinChannelId>:<requesterId>`. */
export function alwaysId(joinChannelId: string, requesterId: string): string {
  return `${ALWAYS_PREFIX}${joinChannelId}:${requesterId}`;
}

/** Parses Always allow's custom id; null if it isn't one / is malformed. */
export function parseAlwaysId(
  customId: string,
): { joinChannelId: string; requesterId: string } | null {
  if (!customId.startsWith(ALWAYS_PREFIX)) return null;
  const [, , joinChannelId, requesterId, ...extra] = customId.split(':');
  if (!joinChannelId || !requesterId || extra.length > 0) return null;
  return { joinChannelId, requesterId };
}

export type JoinAction = 'approve' | 'deny' | 'block';

/** Builds a join request's custom id: `avc:join:<action>:<joinChannelId>:<requesterId>`. */
export function joinId(action: JoinAction, joinChannelId: string, requesterId: string): string {
  return `${JOIN_PREFIX}${action}:${joinChannelId}:${requesterId}`;
}

/**
 * The Approve / Always allow / Deny / Block button row for a join request.
 *
 * Always allow is Approve that also puts the member on the owner's saved trusted list,
 * so it sits beside it. The three older buttons keep their ids and their labels.
 */
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
      .setCustomId(alwaysId(joinChannelId, requesterId))
      .setLabel('Always allow')
      .setStyle(ButtonStyle.Primary),
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
