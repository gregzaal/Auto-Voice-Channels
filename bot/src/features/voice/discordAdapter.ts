import {
  ActivityType,
  ChannelType,
  DiscordAPIError,
  type Activity,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import type { Logger } from '@avc/core';
import type { CreateVoiceChannelInput, RenameResult, VoiceActions } from './actions.js';
import type { GuildVoiceView, MemberActivity, VoiceMember, VoiceStateEvent } from './types.js';

/** Discord API error code for "Unknown Channel" (already deleted). */
const UNKNOWN_CHANNEL = 10003;
/** Discord API error code for "Unknown Member" (already gone). */
const UNKNOWN_MEMBER = 10007;

function isApiError(err: unknown, code: number): boolean {
  return err instanceof DiscordAPIError && err.code === code;
}

interface ResolvedOverwrite {
  id: string;
  type: number;
  allow: bigint;
  deny: bigint;
}

/** Maps a channel's permission-overwrite cache to `channels.create` input. */
function mapOverwrites(cache: {
  values(): IterableIterator<{
    id: string;
    type: number;
    allow: { bitfield: bigint };
    deny: { bitfield: bigint };
  }>;
}): ResolvedOverwrite[] {
  return [...cache.values()].map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield,
    deny: o.deny.bitfield,
  }));
}

function toActivity(a: Activity): MemberActivity {
  const kind =
    a.type === ActivityType.Playing
      ? 'playing'
      : a.type === ActivityType.Streaming
        ? 'streaming'
        : 'other';
  return {
    kind,
    name: a.name,
    ...(a.state ? { state: a.state } : {}),
    ...(a.details ? { details: a.details } : {}),
    ...(a.party?.size
      ? { party: { ...(a.party.id ? { id: a.party.id } : {}), size: a.party.size } }
      : {}),
  };
}

/**
 * Builds a plain {@link VoiceMember} from a discord.js guild member, carrying the
 * presence/role data the rich name templates consume. Presence is read lazily
 * from cache; when absent, the richer tokens simply fall back to their defaults.
 */
function toVoiceMember(member: GuildMember): VoiceMember {
  const activities = (member.presence?.activities ?? []).map(toActivity);
  return {
    id: member.id,
    displayName: member.displayName,
    bot: member.user.bot,
    playing: activities.filter((a) => a.kind === 'playing').map((a) => a.name),
    activities,
    roleIds: [...member.roles.cache.keys()],
    selfStreaming: member.voice?.streaming ?? false,
  };
}

/**
 * Real discord.js implementation of the voice side-effect seam. All mutating
 * calls tolerate already-applied state (deleted channel / absent member) so the
 * dispatcher can replay events idempotently.
 */
/**
 * How long to wait for a channel rename to apply before treating it as deferred
 * by a rate limit. A normal rename resolves well under this; Discord's per-channel
 * edit limit (2 / 10 min) makes a throttled one queue for far longer.
 */
const RENAME_PROBE_MS = 2500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DiscordVoiceActions implements VoiceActions {
  constructor(
    private readonly client: Client,
    private readonly logger?: Logger,
  ) {}

  async createVoiceChannel(input: CreateVoiceChannelInput): Promise<string> {
    const guild = await this.client.guilds.fetch(input.guildId);

    // Resolve placement (category + position) relative to the primary channel.
    let parentId = input.parentId;
    let position: number | undefined;
    const near = input.nearChannelId
      ? await this.client.channels.fetch(input.nearChannelId).catch(() => null)
      : null;
    if (near?.isVoiceBased()) {
      parentId ??= near.parent?.id;
      position = input.above === false ? near.rawPosition + 1 : near.rawPosition;
    }

    // Resolve inherited permission overwrites, if requested.
    const permissionOverwrites = input.inheritFrom
      ? await this.resolveInheritedOverwrites(input.inheritFrom, near)
      : undefined;

    const channel = await guild.channels.create({
      name: input.name,
      type: ChannelType.GuildVoice,
      ...(parentId ? { parent: parentId } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(input.userLimit !== undefined ? { userLimit: input.userLimit } : {}),
      ...(input.bitrate !== undefined ? { bitrate: input.bitrate } : {}),
      ...(permissionOverwrites ? { permissionOverwrites } : {}),
    });
    return channel.id;
  }

  private async resolveInheritedOverwrites(
    mode: string,
    near: Awaited<ReturnType<Client['channels']['fetch']>> | null,
  ): Promise<ReturnType<typeof mapOverwrites> | undefined> {
    try {
      if (mode === 'primary') {
        return near?.isVoiceBased() ? mapOverwrites(near.permissionOverwrites.cache) : undefined;
      }
      if (mode === 'category') {
        const parent = near?.isVoiceBased() ? near.parent : null;
        return parent ? mapOverwrites(parent.permissionOverwrites.cache) : undefined;
      }
      // Otherwise `mode` is a channel id to copy from.
      const source = await this.client.channels.fetch(mode).catch(() => null);
      return source && 'permissionOverwrites' in source
        ? mapOverwrites(source.permissionOverwrites.cache)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async deleteChannel(_guildId: string, channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isVoiceBased()) await channel.delete();
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      throw err;
    }
  }

  async renameChannel(_guildId: string, channelId: string, name: string): Promise<RenameResult> {
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return { rateLimited: false };
      throw err;
    }
    if (!channel?.isVoiceBased()) return { rateLimited: false };

    // discord.js queues a rate-limited edit rather than throwing, which could
    // otherwise block the per-guild work queue for up to 10 minutes. Race the
    // rename against a short probe: if it hasn't applied, report it as deferred
    // and let it complete in the background (it still converges).
    const apply = channel.setName(name);
    const outcome = await Promise.race([
      apply.then(
        () => 'done' as const,
        (err: unknown) => {
          if (isApiError(err, UNKNOWN_CHANNEL)) return 'done' as const;
          throw err;
        },
      ),
      delay(RENAME_PROBE_MS).then(() => 'pending' as const),
    ]);
    if (outcome === 'done') return { rateLimited: false };

    void apply.catch((err: unknown) => {
      if (!isApiError(err, UNKNOWN_CHANNEL)) {
        this.logger?.warn({ err, channelId }, 'deferred channel rename ultimately failed');
      }
    });
    return { rateLimited: true };
  }

  async moveMember(guildId: string, memberId: string, channelId: string | null): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(memberId);
      await member.voice.setChannel(channelId);
    } catch (err) {
      if (isApiError(err, UNKNOWN_MEMBER) || isApiError(err, UNKNOWN_CHANNEL)) return;
      throw err;
    }
  }

  async setUserLimit(_guildId: string, channelId: string, limit: number): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isVoiceBased()) await channel.setUserLimit(limit);
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      throw err;
    }
  }

  async setPrivacy(_guildId: string, channelId: string, isPrivate: boolean): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isVoiceBased()) return;
      const everyone = channel.guild.roles.everyone;
      // `null` clears the overwrite (public); `false` denies Connect (private).
      await channel.permissionOverwrites.edit(everyone, { Connect: isPrivate ? false : null });
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      throw err;
    }
  }

  async setMemberConnect(
    _guildId: string,
    channelId: string,
    memberId: string,
    allow: boolean,
  ): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isVoiceBased()) return;
      await channel.permissionOverwrites.edit(memberId, { Connect: allow });
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL) || isApiError(err, UNKNOWN_MEMBER)) return;
      throw err;
    }
  }

  async setVoiceStatus(_guildId: string, channelId: string, status: string): Promise<void> {
    // discord.js has no helper for voice channel status yet, so call the raw
    // endpoint. Its rate limit is far laxer than channel renames. `''` clears it.
    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, {
        body: { status },
      });
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      this.logger?.warn({ err, channelId }, 'failed to set voice channel status');
    }
  }

  async createJoinChannel(guildId: string, name: string, nearChannelId: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);
    const near = await this.client.channels.fetch(nearChannelId);
    const parent = near?.isVoiceBased() ? (near.parent ?? undefined) : undefined;
    const position = near?.isVoiceBased() ? near.rawPosition : undefined;
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      ...(parent ? { parent: parent.id } : {}),
      ...(position !== undefined ? { position } : {}),
    });
    return channel.id;
  }
}

/**
 * Read-only voice view backed by the discord.js cache. Channel ids are globally
 * unique, so members are resolved directly from the client channel cache.
 *
 * Presence is read lazily off each member; with the presence cache disabled this
 * may be empty, in which case game-name templating falls back to "General".
 */
export class DiscordVoiceView implements GuildVoiceView {
  constructor(private readonly client: Client) {}

  membersInChannel(channelId: string): VoiceMember[] {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return [];
    const voiceChannel = channel as VoiceBasedChannel;
    return [...voiceChannel.members.values()].map((m) => toVoiceMember(m));
  }

  channelExists(channelId: string): boolean {
    return this.client.channels.cache.has(channelId);
  }
}

/**
 * Normalizes a discord.js `voiceStateUpdate` (old, new) pair into the feature's
 * {@link VoiceStateEvent}. Returns `undefined` when there is no guild context.
 */
export function normalizeVoiceState(
  oldState: VoiceState,
  newState: VoiceState,
): VoiceStateEvent | undefined {
  const guildId = newState.guild?.id ?? oldState.guild?.id;
  if (!guildId) return undefined;
  const member = newState.member ?? oldState.member;
  if (!member) return undefined;

  return {
    guildId,
    member: toVoiceMember(member),
    ...(oldState.channelId ? { beforeChannelId: oldState.channelId } : {}),
    ...(newState.channelId ? { afterChannelId: newState.channelId } : {}),
  };
}
