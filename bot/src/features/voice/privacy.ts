import type {
  JoinChannelRepository,
  JoinChannelRow,
  Logger,
  SecondaryChannelRepository,
} from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { CommandResult } from './commands.js';
import type { GuildVoiceView } from './types.js';

const ok = (message: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

export interface PrivacyServiceDeps {
  secondaries: SecondaryChannelRepository;
  joinChannels: JoinChannelRepository;
  actions: VoiceActions;
  voice: GuildVoiceView;
  logger: Logger;
}

/**
 * The full private-channel + "⇩ Join {creator}" mechanism, ported from the
 * legacy `private`/`public` commands and join-request handling.
 *
 * `/private` locks the channel to @everyone (keeping current members), then
 * spawns an open "⇩ Join {creator}" companion channel. Joining that channel
 * raises a request to the owner (the discord glue posts the buttons); the owner
 * approves (grant Connect + pull them in), denies (disconnect), or blocks (deny
 * Connect on the join channel). `/public` reverses everything and deletes the
 * companion channel.
 *
 * Pure logic over the repositories + the action seam, so it's exercised with the
 * recording fakes.
 */
export class PrivacyService {
  constructor(private readonly deps: PrivacyServiceDeps) {}

  /** Locks the channel and creates its "⇩ Join {creator}" companion. */
  async makePrivate(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    requestChannelId: string,
  ): Promise<CommandResult> {
    if (!channelId) return fail('You need to be in one of this server’s voice channels.');
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return fail('This isn’t a bot-managed voice channel.');
    }
    if (secondary.ownerId && secondary.ownerId !== userId) {
      return fail('Only the channel owner can make it private.');
    }
    if (secondary.state.private) return fail('This channel is already private.');

    const members = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    await this.deps.actions.setPrivacy(guildId, channelId, true);
    for (const m of members)
      await this.deps.actions.setMemberConnect(guildId, channelId, m.id, true);

    const creatorName = members.find((m) => m.id === userId)?.displayName ?? 'owner';
    const joinChannelId = await this.deps.actions.createJoinChannel(
      guildId,
      `⇩ Join ${creatorName}`,
      channelId,
    );
    await this.deps.joinChannels.create({
      channelId: joinChannelId,
      guildId,
      secondaryChannelId: channelId,
      requestChannelId,
      creatorId: userId,
    });
    await this.deps.secondaries.updateState(channelId, {
      ...secondary.state,
      private: true,
    });

    this.deps.logger.info({ guildId, channelId, joinChannelId }, 'channel made private');
    return ok('🔒 Your channel is now private. Others can ask to join via the **⇩ Join** channel.');
  }

  /** Reopens the channel and deletes its "⇩ Join" companion. */
  async makePublic(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    if (!channelId) return fail('You need to be in one of this server’s voice channels.');
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return fail('This isn’t a bot-managed voice channel.');
    }
    if (secondary.ownerId && secondary.ownerId !== userId) {
      return fail('Only the channel owner can make it public.');
    }
    if (!secondary.state.private) return fail('This channel is already public.');

    await this.deps.actions.setPrivacy(guildId, channelId, false);
    await this.removeJoinChannel(guildId, channelId);
    const { private: _drop, ...rest } = secondary.state;
    await this.deps.secondaries.updateState(channelId, rest);

    this.deps.logger.info({ guildId, channelId }, 'channel made public');
    return ok('🔓 Your channel is now public.');
  }

  /** The join-request context for a channel id, if it is a "⇩ Join" channel. */
  getJoinContext(channelId: string): Promise<JoinChannelRow | undefined> {
    return this.deps.joinChannels.get(channelId);
  }

  /** Admits a requester: grant Connect on the private channel and pull them in. */
  async approveJoin(joinChannelId: string, requesterId: string): Promise<CommandResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    await this.deps.actions.setMemberConnect(
      ctx.guildId,
      ctx.secondaryChannelId,
      requesterId,
      true,
    );
    await this.deps.actions.moveMember(ctx.guildId, requesterId, ctx.secondaryChannelId);
    return ok(`Admitted <@${requesterId}>.`);
  }

  /** Denies a requester (disconnect); `block` also bars them from re-requesting. */
  async denyJoin(
    joinChannelId: string,
    requesterId: string,
    block: boolean,
  ): Promise<CommandResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    await this.deps.actions.moveMember(ctx.guildId, requesterId, null);
    if (block) {
      await this.deps.actions.setMemberConnect(ctx.guildId, joinChannelId, requesterId, false);
    }
    return ok(block ? `Blocked <@${requesterId}>.` : `Denied <@${requesterId}>.`);
  }

  /** Cleans up a private channel's companion when the channel goes away. */
  async cleanupForSecondary(guildId: string, secondaryChannelId: string): Promise<void> {
    await this.removeJoinChannel(guildId, secondaryChannelId);
  }

  /**
   * Ownership of a private secondary transferred (the creator left). Re-point its
   * "⇩ Join" companion at the new owner: rename it and update who may answer join
   * requests. No-ops when the channel has no companion (it isn't private).
   */
  async handleOwnerChanged(
    guildId: string,
    secondaryChannelId: string,
    newOwnerId: string,
    newOwnerName: string,
  ): Promise<void> {
    const row = await this.deps.joinChannels.getBySecondary(secondaryChannelId);
    if (!row) return;
    await this.deps.joinChannels.setCreatorBySecondary(secondaryChannelId, newOwnerId);
    await this.deps.actions.renameChannel(guildId, row.channelId, `⇩ Join ${newOwnerName}`);
    this.deps.logger.info(
      { guildId, secondaryChannelId, joinChannelId: row.channelId, newOwnerId },
      're-pointed join channel at new owner',
    );
  }

  private async removeJoinChannel(guildId: string, secondaryChannelId: string): Promise<void> {
    const row = await this.deps.joinChannels.getBySecondary(secondaryChannelId);
    if (!row) return;
    await this.deps.actions.deleteChannel(guildId, row.channelId);
    await this.deps.joinChannels.removeBySecondary(secondaryChannelId);
  }
}
