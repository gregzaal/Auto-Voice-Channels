import type { Logger, SecondaryChannelRepository, SecondaryChannelRow } from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { VoiceFeature } from './handler.js';
import type { GuildVoiceView } from './types.js';

/** Result of a per-channel command: a flag plus a user-facing message. */
export interface CommandResult {
  ok: boolean;
  message: string;
}

const ok = (message: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

/** Discord's hard cap on a voice channel's user limit. */
export const MAX_USER_LIMIT = 99;

/**
 * A note appended to a command reply when `count` channel renames were deferred
 * by Discord's per-channel rate limit (2 edits / 10 min), so users understand
 * why the new name hasn't shown up yet. Empty when nothing was rate-limited.
 */
export function rateLimitNote(count: number): string {
  if (count <= 0) return '';
  const what = count === 1 ? 'this channel' : `${count} channels`;
  return `\n⏳ Discord is rate-limiting renames on ${what}; the new name will apply within a few minutes.`;
}

export interface VoiceCommandsDeps {
  secondaries: SecondaryChannelRepository;
  actions: VoiceActions;
  voice: GuildVoiceView;
  feature: VoiceFeature;
  logger: Logger;
}

/**
 * Business logic for the frequent per-channel slash commands (limit, name,
 * private/public, transfer, claim). Decoupled from discord.js — the interaction
 * router resolves the caller's current voice channel and forwards plain ids, so
 * this layer is exercised with the same fakes as the rest of the feature.
 *
 * Most actions are owner-only (`ownerId` on the secondary). `claim` is the
 * exception: anyone may take over a channel whose owner has left.
 */
export class VoiceCommands {
  constructor(private readonly deps: VoiceCommandsDeps) {}

  /** Sets the channel's user limit (0..99; 0 = unlimited). Owner only. */
  async setLimit(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    limit: number,
  ): Promise<CommandResult> {
    const secondary = await this.requireOwned(guildId, channelId, userId);
    if ('error' in secondary) return secondary.error;
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
      return fail(`The limit must be a whole number between 0 and ${MAX_USER_LIMIT}.`);
    }
    await this.deps.actions.setUserLimit(guildId, secondary.row.channelId, limit);
    return ok(
      limit === 0 ? 'Removed this channel’s user limit.' : `Set the user limit to ${limit}.`,
    );
  }

  /** Removes the channel's user limit. Owner only. */
  unlimit(guildId: string, channelId: string | undefined, userId: string): Promise<CommandResult> {
    return this.setLimit(guildId, channelId, userId, 0);
  }

  /**
   * Overrides the channel's name (or `reset`s to the inherited template). The
   * value may use template tokens (`@@game_name@@`, `##`, …) and is re-evaluated
   * on game/membership changes. Owner only, unless `opts.admin` (a server admin
   * may rename any managed channel — this absorbs the old `/rename`).
   */
  setName(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    name: string,
    opts: { admin?: boolean } = {},
  ): Promise<CommandResult> {
    return this.setChannelField(guildId, channelId, userId, 'name', name, opts);
  }

  /**
   * Overrides the channel's voice **status** template (or `reset`s it). Same
   * permission model as {@link setName}. An empty value clears the status.
   */
  setStatus(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    status: string,
    opts: { admin?: boolean } = {},
  ): Promise<CommandResult> {
    return this.setChannelField(guildId, channelId, userId, 'status', status, opts);
  }

  /** Shared per-channel override setter for the name + status templates. */
  private async setChannelField(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    field: 'name' | 'status',
    value: string,
    opts: { admin?: boolean },
  ): Promise<CommandResult> {
    const found = await this.resolveSecondary(guildId, channelId);
    if ('error' in found) return found.error;
    const row = found.row;
    if (!opts.admin && row.ownerId && row.ownerId !== userId) {
      return fail('Only the channel owner can change that. Use `/claim` if the owner has left.');
    }
    const id = row.channelId;
    const stateKey = field === 'name' ? 'template' : 'statusTemplate';
    const trimmed = value.trim();
    // A blank channel NAME is invalid, so an empty name resets to the inherited
    // template. A blank STATUS is a legitimate intent ("no status"), so only the
    // explicit `reset` keyword (or the panel's Reset button) clears that override.
    const isReset = trimmed.toLowerCase() === 'reset' || (field === 'name' && trimmed === '');
    const clearedStatus = field === 'status' && !isReset && trimmed === '';

    const next = { ...row.state };
    if (isReset) {
      delete next[stateKey];
    } else {
      // Newlines aren't valid in channel names; flatten to spaces (legacy parity).
      next[stateKey] = field === 'name' ? trimmed.replace(/[\r\n]+/g, ' ') : trimmed;
    }
    await this.deps.secondaries.updateState(id, next);
    const r = await this.deps.feature.rerenderSecondary(guildId, id);
    const note = rateLimitNote(r.rateLimited ? 1 : 0);
    return ok(
      isReset
        ? `Reset this channel’s ${field} to the inherited template.${note}`
        : clearedStatus
          ? `Cleared this channel’s status — it will stay blank.${note}`
          : `Updated this channel’s ${field}.${note}`,
    );
  }

  /** Transfers ownership to another member who is in the channel. Owner only. */
  async transfer(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    targetId: string,
  ): Promise<CommandResult> {
    const secondary = await this.requireOwned(guildId, channelId, userId);
    if ('error' in secondary) return secondary.error;
    const id = secondary.row.channelId;
    if (targetId === userId) return fail('You already own this channel.');
    const inChannel = this.deps.voice.membersInChannel(id).some((m) => m.id === targetId);
    if (!inChannel) return fail('That member isn’t in this channel.');

    await this.deps.secondaries.setOwner(id, targetId);
    await this.deps.feature.rerenderSecondary(guildId, id);
    return ok(`Transferred ownership to <@${targetId}>.`);
  }

  /**
   * Claims ownership of the channel the caller is in, when its owner has left.
   * Anyone present may claim; no-op refusal if the owner is still here.
   */
  async claim(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    const found = await this.resolveSecondary(guildId, channelId);
    if ('error' in found) return found.error;
    const row = found.row;
    const present = this.deps.voice.membersInChannel(row.channelId);
    if (!present.some((m) => m.id === userId)) {
      return fail('You need to be in the channel to claim it.');
    }
    if (row.ownerId === userId) return fail('You already own this channel.');
    if (row.ownerId && present.some((m) => m.id === row.ownerId)) {
      return fail('The current owner is still here — they can `/transfer` it to you.');
    }
    await this.deps.secondaries.setOwner(row.channelId, userId);
    await this.deps.feature.rerenderSecondary(guildId, row.channelId);
    return ok('You are now the owner of this channel.');
  }

  // -- helpers --------------------------------------------------------------

  private async resolveSecondary(
    guildId: string,
    channelId: string | undefined,
  ): Promise<{ row: SecondaryChannelRow } | { error: CommandResult }> {
    if (!channelId) {
      return { error: fail('You need to be in one of this server’s voice channels.') };
    }
    const row = await this.deps.secondaries.get(channelId);
    if (!row || row.guildId !== guildId) {
      return { error: fail('This isn’t a bot-managed voice channel.') };
    }
    return { row };
  }

  private async requireOwned(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<{ row: SecondaryChannelRow } | { error: CommandResult }> {
    const found = await this.resolveSecondary(guildId, channelId);
    if ('error' in found) return found;
    if (found.row.ownerId && found.row.ownerId !== userId) {
      return {
        error: fail('Only the channel owner can do that. Use `/claim` if the owner has left.'),
      };
    }
    return { row: found.row };
  }
}
