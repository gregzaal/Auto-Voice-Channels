import type {
  JoinChannelRepository,
  JoinChannelRow,
  Logger,
  SecondaryChannelRepository,
} from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { CommandResult } from './commands.js';
import type { GuildVoiceView } from './types.js';
import { describeError } from '../../ops/describeError.js';

const ok = (message: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

export interface PrivacyServiceDeps {
  secondaries: SecondaryChannelRepository;
  joinChannels: JoinChannelRepository;
  actions: VoiceActions;
  voice: GuildVoiceView;
  logger: Logger;
  /**
   * Recomputes a room's name after its privacy changed, for `{{PRIVATE}}`.
   *
   * A callback rather than a `VoiceFeature` handle, matching the direction the
   * handler already reaches privacy (`deps.makePrivateOnCreate`): taking the
   * feature here would close a cycle between the two modules.
   */
  rerender?: (guildId: string, channelId: string) => Promise<unknown>;
}

/**
 * The full private-channel + "⇩ Join {owner}" mechanism, ported from the
 * legacy `private`/`public` commands and join-request handling.
 *
 * `/private` locks the channel to @everyone (keeping current members), then
 * spawns an open "⇩ Join {owner}" companion channel. Joining that channel
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

  /** Locks the channel and creates its "⇩ Join {owner}" companion. */
  async makePrivate(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    if (!channelId) return fail("You need to be in one of this server's voice channels.");
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return fail("This isn't a bot-managed voice channel.");
    }
    if (secondary.ownerId && secondary.ownerId !== userId) {
      return fail('Only the channel owner can make it private.');
    }
    if (secondary.state.private) return fail('This channel is already private.');

    const members = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    await this.deps.actions.setPrivacy(guildId, channelId, true);
    for (const m of members)
      await this.deps.actions.setMemberConnect(guildId, channelId, m.id, true);

    const ownerName = members.find((m) => m.id === userId)?.displayName ?? 'owner';
    const joinChannelId = await this.deps.actions.createJoinChannel(
      guildId,
      `⇩ Join ${ownerName}`,
      channelId,
    );
    await this.deps.joinChannels.create({
      channelId: joinChannelId,
      guildId,
      secondaryChannelId: channelId,
      creatorId: userId,
    });
    await this.deps.secondaries.updateState(channelId, {
      ...secondary.state,
      private: true,
    });
    this.rerenderDetached(guildId, channelId, 'private');

    this.deps.logger.info({ guildId, channelId, joinChannelId }, 'channel made private');
    return ok('🔒 Your channel is now private. Others can ask to join via the **⇩ Join** channel.');
  }

  /**
   * Applies the private treatment to a freshly-spawned secondary whose primary is
   * `defaultPrivate`. Unlike {@link makePrivate}, the owner's move into the new
   * channel may not have landed in the voice cache yet, so it grants Connect to
   * the known owner id directly rather than reading the roster. Idempotent: a
   * no-op when the secondary is gone or already private.
   */
  async makePrivateForCreation(
    guildId: string,
    channelId: string,
    ownerId: string,
    ownerName: string,
  ): Promise<void> {
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId || secondary.state.private) return;

    await this.deps.actions.setPrivacy(guildId, channelId, true);
    await this.deps.actions.setMemberConnect(guildId, channelId, ownerId, true);
    const joinChannelId = await this.deps.actions.createJoinChannel(
      guildId,
      `⇩ Join ${ownerName}`,
      channelId,
    );
    await this.deps.joinChannels.create({
      channelId: joinChannelId,
      guildId,
      secondaryChannelId: channelId,
      creatorId: ownerId,
    });
    await this.deps.secondaries.updateState(channelId, { ...secondary.state, private: true });
    this.deps.logger.info(
      { guildId, channelId, joinChannelId, ownerId },
      'secondary made private on creation',
    );
  }

  /** Reopens the channel and deletes its "⇩ Join" companion. */
  async makePublic(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    if (!channelId) return fail("You need to be in one of this server's voice channels.");
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return fail("This isn't a bot-managed voice channel.");
    }
    if (secondary.ownerId && secondary.ownerId !== userId) {
      return fail('Only the channel owner can make it public.');
    }
    if (!secondary.state.private) return fail('This channel is already public.');

    await this.deps.actions.setPrivacy(guildId, channelId, false);
    await this.removeJoinChannel(guildId, channelId);
    const { private: _drop, ...rest } = secondary.state;
    await this.deps.secondaries.updateState(channelId, rest);
    this.rerenderDetached(guildId, channelId, 'public');

    this.deps.logger.info({ guildId, channelId }, 'channel made public');
    return ok('🔓 Your channel is now public.');
  }

  /**
   * Recomputes the room's name for `{{PRIVATE}}`, always AFTER the state write
   * above (it reads the stored flag back) and never awaited.
   *
   * Not awaited because `/private` already spends a `setPrivacy`, one
   * `setMemberConnect` per member and a channel creation before it can reply,
   * and Discord closes the interaction window at 3 seconds. A rate-limited
   * rename adds 2.5s to that on its own. For a guild whose template does not
   * mention `{{PRIVATE}}` the render is unchanged and no rename is issued.
   */
  private rerenderDetached(guildId: string, channelId: string, reason: string): void {
    void this.deps.rerender?.(guildId, channelId).catch((err: unknown) => {
      this.deps.logger.warn({ err, guildId, channelId, reason }, 'detached re-render failed');
    });
  }

  /** The join-request context for a channel id, if it is a "⇩ Join" channel. */
  getJoinContext(channelId: string): Promise<JoinChannelRow | undefined> {
    return this.deps.joinChannels.get(channelId);
  }

  /** Admits a requester: grant Connect on the private channel and pull them in. */
  async approveJoin(joinChannelId: string, requesterId: string): Promise<CommandResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    try {
      await this.deps.actions.setMemberConnect(
        ctx.guildId,
        ctx.secondaryChannelId,
        requesterId,
        true,
      );
      await this.deps.actions.moveMember(ctx.guildId, requesterId, ctx.secondaryChannelId);
    } catch (err) {
      this.deps.logger.warn({ err, joinChannelId, requesterId }, 'failed to admit join requester');
      return fail(`Could not admit <@${requesterId}>: ${describeError(err)}.`);
    }
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
    try {
      await this.deps.actions.moveMember(ctx.guildId, requesterId, null);
      if (block) {
        await this.deps.actions.setMemberConnect(ctx.guildId, joinChannelId, requesterId, false);
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, joinChannelId, requesterId, block },
        'failed to deny join requester',
      );
      return fail(
        `Could not ${block ? 'block' : 'deny'} <@${requesterId}>: ${describeError(err)}.`,
      );
    }
    return ok(block ? `Blocked <@${requesterId}>.` : `Denied <@${requesterId}>.`);
  }

  /** Cleans up a private channel's companion when the channel goes away. */
  async cleanupForSecondary(guildId: string, secondaryChannelId: string): Promise<void> {
    await this.removeJoinChannel(guildId, secondaryChannelId);
  }

  /**
   * Ownership of a private secondary transferred (the owner left). Re-point its
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
