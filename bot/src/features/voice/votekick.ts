import type { Logger, SecondaryChannelRepository } from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { GuildVoiceView } from './types.js';

export interface VoteKickDeps {
  secondaries: SecondaryChannelRepository;
  voice: GuildVoiceView;
  actions: VoiceActions;
  logger: Logger;
}

interface VoteSession {
  guildId: string;
  channelId: string;
  targetId: string;
  initiatorId: string;
  reason: string | undefined;
  required: number;
  eligible: Set<string>;
  votes: Set<string>;
  /** Monotonic token identifying this session, so a stale timeout can't cancel a newer one. */
  epoch: number;
}

export interface StartResult {
  ok: boolean;
  message: string;
  required?: number;
  /** Token for the started session, to pass back to {@link VoteKickManager.cancel}. */
  epoch?: number;
}

export interface VoteResult {
  ok: boolean;
  message: string;
  resolved: boolean;
  kicked: boolean;
  votes?: number;
  required?: number;
}

/**
 * Majority votekick, ported from the legacy `kick` command. A member starts a
 * vote against another member in the same managed channel; once a majority of
 * the *other* members (the initiator's vote counts immediately) agree, the
 * target is denied Connect and disconnected.
 *
 * One active vote per channel, tracked in memory (votes are ephemeral and need
 * not survive a restart — the session simply lapses). The 2-minute timeout is
 * driven by the caller (the interaction collector); {@link cancel} ends a vote.
 */
export class VoteKickManager {
  private readonly sessions = new Map<string, VoteSession>();
  private seq = 0;

  constructor(private readonly deps: VoteKickDeps) {}

  /** Required yes-votes given `eligible` non-target voters: a strict majority. */
  static requiredVotes(eligible: number): number {
    return Math.floor(eligible / 2) + 1;
  }

  /** Begins a votekick. The initiator's vote is counted immediately. */
  async start(
    guildId: string,
    channelId: string | undefined,
    initiatorId: string,
    targetId: string,
    reason?: string,
  ): Promise<StartResult> {
    if (!channelId) return { ok: false, message: 'You need to be in the channel to start a vote.' };
    const secondary = await this.deps.secondaries.get(channelId);
    if (!secondary || secondary.guildId !== guildId) {
      return { ok: false, message: 'This isn’t a bot-managed voice channel.' };
    }
    if (this.sessions.has(channelId)) {
      return { ok: false, message: 'A votekick is already in progress in this channel.' };
    }
    if (targetId === initiatorId) return { ok: false, message: 'You can’t votekick yourself.' };

    const present = this.deps.voice.membersInChannel(channelId).filter((m) => !m.bot);
    if (!present.some((m) => m.id === initiatorId)) {
      return { ok: false, message: 'You need to be in the channel to start a vote.' };
    }
    if (!present.some((m) => m.id === targetId)) {
      return { ok: false, message: 'That member isn’t in this channel.' };
    }
    if (secondary.ownerId === targetId) {
      return { ok: false, message: 'You can’t votekick the channel owner.' };
    }

    const eligible = new Set(present.map((m) => m.id).filter((id) => id !== targetId));
    const required = VoteKickManager.requiredVotes(eligible.size);
    const epoch = ++this.seq;
    const session: VoteSession = {
      guildId,
      channelId,
      targetId,
      initiatorId,
      reason,
      required,
      eligible,
      votes: new Set([initiatorId]),
      epoch,
    };
    this.sessions.set(channelId, session);

    if (session.votes.size >= required) {
      await this.kick(session);
      this.sessions.delete(channelId);
      return { ok: true, required, epoch, message: `<@${targetId}> was kicked.` };
    }
    return { ok: true, required, epoch, message: 'Vote started.' };
  }

  /** Records a vote from `voterId`. Resolves (and kicks) once a majority agrees. */
  async vote(channelId: string, voterId: string): Promise<VoteResult> {
    const session = this.sessions.get(channelId);
    if (!session) {
      return { ok: false, resolved: false, kicked: false, message: 'There’s no active vote here.' };
    }
    if (voterId === session.targetId || !session.eligible.has(voterId)) {
      return {
        ok: false,
        resolved: false,
        kicked: false,
        message: 'You’re not eligible to vote in this channel.',
      };
    }
    session.votes.add(voterId);
    if (session.votes.size >= session.required) {
      await this.kick(session);
      this.sessions.delete(channelId);
      return {
        ok: true,
        resolved: true,
        kicked: true,
        votes: session.votes.size,
        required: session.required,
        message: `<@${session.targetId}> was kicked.`,
      };
    }
    return {
      ok: true,
      resolved: false,
      kicked: false,
      votes: session.votes.size,
      required: session.required,
      message: `Vote recorded (${session.votes.size}/${session.required}).`,
    };
  }

  hasSession(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  /**
   * Ends a vote without kicking (timeout/cancel). When `epoch` is given, only the
   * session with that token is cancelled — a stale timeout for a since-replaced
   * session is a no-op (it must not cancel a newer vote on the same channel).
   */
  cancel(channelId: string, epoch?: number): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    if (epoch !== undefined && session.epoch !== epoch) return;
    this.sessions.delete(channelId);
  }

  private async kick(session: VoteSession): Promise<void> {
    await this.deps.actions.setMemberConnect(
      session.guildId,
      session.channelId,
      session.targetId,
      false,
    );
    await this.deps.actions.moveMember(session.guildId, session.targetId, null);
    this.deps.logger.info(
      { guildId: session.guildId, channelId: session.channelId, target: session.targetId },
      'votekick succeeded',
    );
  }
}
