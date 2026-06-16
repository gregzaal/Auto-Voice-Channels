import {
  ActivityType,
  ChannelType,
  DiscordAPIError,
  OverwriteType,
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
    const near = input.nearChannelId
      ? await this.client.channels.fetch(input.nearChannelId).catch(() => null)
      : null;
    const placeAbove = input.above === true;
    // Create the channel *at the primary's own position*: Discord breaks position
    // ties by id, and the new channel always has the largest id, so it lands
    // directly below the primary in a single call. For the default "below" that
    // is already correct, so we do no extra work (no reorder → no flicker). For
    // "above" we then bulk-reorder it up one slot (Discord can't place a new
    // channel above an existing one at create time — the id tie-break forbids it).
    let createPosition: number | undefined;
    let reorderAboveIndex: number | undefined;
    if (near?.isVoiceBased()) {
      parentId ??= near.parent?.id;
      createPosition = near.rawPosition;
      if (placeAbove) reorderAboveIndex = near.position; // captured before create
    }

    // Resolve inherited permission overwrites, if requested.
    const permissionOverwrites = input.inheritFrom
      ? await this.resolveInheritedOverwrites(input.inheritFrom, near)
      : undefined;

    const channel = await guild.channels.create({
      name: input.name,
      type: ChannelType.GuildVoice,
      ...(parentId ? { parent: parentId } : {}),
      ...(createPosition !== undefined ? { position: createPosition } : {}),
      ...(input.userLimit !== undefined ? { userLimit: input.userLimit } : {}),
      ...(input.bitrate !== undefined ? { bitrate: input.bitrate } : {}),
      ...(permissionOverwrites ? { permissionOverwrites } : {}),
    });
    if (reorderAboveIndex !== undefined) {
      await this.placeAboveSibling(channel, reorderAboveIndex);
    }
    return channel.id;
  }

  /**
   * Moves a just-created voice `channel` directly above the sibling whose
   * pre-create sorted index was `nearIndex`, via the bulk channel-reorder endpoint
   * (discord.js rebuilds the full sibling list with unique sequential positions,
   * so it's deterministic — no id tie-break). Only used for "above": "below" is
   * already correct from the create-time position and needs no reorder. Best-
   * effort: a failure leaves the channel created (just mis-ordered).
   */
  private async placeAboveSibling(channel: VoiceBasedChannel, nearIndex: number): Promise<void> {
    try {
      // `setPosition` removes the channel from the sorted list then re-inserts it
      // at `nearIndex` of the *remaining* siblings — which equals the list as it
      // was before this channel existed — landing it in the near channel's old
      // slot (pushing near down → above).
      await channel.setPosition(nearIndex);
    } catch (err) {
      this.logger?.warn({ err, channelId: channel.id }, 'failed to position new channel');
    }
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
      // Pass the overwrite type explicitly: with the user cache disabled,
      // discord.js can't resolve a bare member id to a User to infer the type
      // (it would throw InvalidType). Given the type, it uses the id directly.
      await channel.permissionOverwrites.edit(
        memberId,
        { Connect: allow },
        { type: OverwriteType.Member },
      );
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL) || isApiError(err, UNKNOWN_MEMBER)) return;
      throw err;
    }
  }

  async repositionSecondaries(
    guildId: string,
    primaryChannelId: string,
    orderedChannelIds: string[],
    above: boolean,
  ): Promise<void> {
    if (orderedChannelIds.length === 0) return;
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const primary =
        guild.channels.cache.get(primaryChannelId) ??
        (await guild.channels.fetch(primaryChannelId).catch(() => null));
      if (!primary?.isVoiceBased()) return;
      const parentId = primary.parentId;
      const sort = (list: VoiceBasedChannel[]): VoiceBasedChannel[] =>
        list.sort(
          (a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
        );
      // The channels to move (in the requested order), and everything else in the
      // category in current display order.
      const moving = new Set(orderedChannelIds);
      const secs = orderedChannelIds
        .map((id) => guild.channels.cache.get(id))
        .filter(
          (c): c is VoiceBasedChannel =>
            !!c && c.isVoiceBased() && c.parentId === parentId && moving.has(c.id),
        );
      const rest = sort(
        [...guild.channels.cache.values()].filter(
          (c): c is VoiceBasedChannel =>
            c.isVoiceBased() && c.parentId === parentId && !moving.has(c.id),
        ),
      );
      const pIdx = rest.findIndex((c) => c.id === primaryChannelId);
      if (pIdx === -1 || secs.length === 0) return;
      // Insert the block just above (pIdx) or just below (pIdx + 1) the primary,
      // then reassign sequential positions and push it all in ONE bulk reorder
      // (minimal flicker; deterministic — no id tie-break).
      const insertAt = above ? pIdx : pIdx + 1;
      const desired = [...rest.slice(0, insertAt), ...secs, ...rest.slice(insertAt)];
      await guild.channels.setPositions(desired.map((c, i) => ({ channel: c.id, position: i })));
    } catch (err) {
      this.logger?.warn({ err, primaryChannelId }, 'failed to reposition secondaries');
    }
  }

  async repositionGroup(
    guildId: string,
    primaryChannelIds: string[],
    orderedSecondaryIds: string[],
    above: boolean,
  ): Promise<void> {
    if (primaryChannelIds.length === 0 || orderedSecondaryIds.length === 0) return;
    try {
      const guild = await this.client.guilds.fetch(guildId);
      // Resolve the group's category from the first primary that's in cache. `null`
      // parent = the server root (a valid group too).
      const anchor = primaryChannelIds
        .map((id) => guild.channels.cache.get(id))
        .find((c): c is VoiceBasedChannel => !!c && c.isVoiceBased());
      if (!anchor) return;
      const parentId = anchor.parentId ?? null;
      const sort = (list: VoiceBasedChannel[]): VoiceBasedChannel[] =>
        list.sort(
          (a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
        );

      const moving = new Set(orderedSecondaryIds);
      const inCategory = (c: VoiceBasedChannel): boolean => (c.parentId ?? null) === parentId;
      // The secondaries to move, in the requested (group) order.
      const secs = orderedSecondaryIds
        .map((id) => guild.channels.cache.get(id))
        .filter(
          (c): c is VoiceBasedChannel =>
            !!c && c.isVoiceBased() && inCategory(c) && moving.has(c.id),
        );
      // Everything else in the category, in current display order.
      const rest = sort(
        [...guild.channels.cache.values()].filter(
          (c): c is VoiceBasedChannel => c.isVoiceBased() && inCategory(c) && !moving.has(c.id),
        ),
      );
      if (secs.length === 0) return;
      const primarySet = new Set(primaryChannelIds);
      const primaryIdxs = rest.flatMap((c, i) => (primarySet.has(c.id) ? [i] : []));
      if (primaryIdxs.length === 0) return;
      // Below → just under the bottommost primary; above → just over the topmost.
      const insertAt = above ? Math.min(...primaryIdxs) : Math.max(...primaryIdxs) + 1;
      const desired = [...rest.slice(0, insertAt), ...secs, ...rest.slice(insertAt)];
      await guild.channels.setPositions(desired.map((c, i) => ({ channel: c.id, position: i })));
    } catch (err) {
      this.logger?.warn({ err, primaryChannelIds }, 'failed to reposition group');
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
    const near = await this.client.channels.fetch(nearChannelId).catch(() => null);
    let parentId: string | undefined;
    let createPosition: number | undefined;
    let nearIndex: number | undefined;
    if (near?.isVoiceBased()) {
      parentId = near.parent?.id;
      createPosition = near.rawPosition; // land adjacent, then hop above
      nearIndex = near.position;
    }
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      ...(parentId ? { parent: parentId } : {}),
      ...(createPosition !== undefined ? { position: createPosition } : {}),
    });
    // Sit the "⇩ Join" companion directly above its (private) channel.
    if (nearIndex !== undefined) {
      await this.placeAboveSibling(channel, nearIndex);
    }
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

  categoryOf(channelId: string): string | null | undefined {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !('parentId' in channel)) return undefined;
    return channel.parentId ?? null;
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
