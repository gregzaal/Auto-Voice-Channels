import { DiscordAPIError } from 'discord.js';

/**
 * The Discord side-effect seam. Feature logic depends only on this interface, so
 * it can be driven by a real discord.js implementation in production and by a
 * recording fake in tests (the "fake REST/action recorder").
 */
export interface CreateCompanionChannelInput {
  guildId: string;
  /** What the channel is called. Discord lowercases and hyphenates it itself. */
  name: string;
  /** The room this belongs to: its category, and what the topic names. */
  secondaryChannelId: string;
  /** Members allowed to read it at creation, written inline in the create payload. */
  memberIds: readonly string[];
  /** The guild's moderator role, or null. */
  roleId: string | null;
}

export interface SyncCompanionMembersInput {
  guildId: string;
  /** The companion text channel. */
  channelId: string;
  /** Exactly who should be able to read it now. */
  memberIds: readonly string[];
  roleId: string | null;
  /**
   * The moderator role this bot last granted here, from the stored row.
   *
   * Discord attributes an overwrite to nobody, so without this the revoke
   * would have to guess by permission bits and would take away a grant a
   * moderator made by hand, every few minutes, with no way to opt out.
   */
  previousRoleId?: string | null;
}

export interface CompanionSyncResult {
  added: number;
  removed: number;
  /** True when Discord says the channel is gone, so the caller can drop the row. */
  channelGone: boolean;
  /**
   * The moderator role now granted here, for the caller to record.
   *
   * Null when none is configured or the grant failed, so a role that could
   * not be granted is never remembered as granted.
   */
  grantedRoleId?: string | null;
  /**
   * True when a moderator role IS configured but no longer exists in the guild.
   *
   * Distinct from `grantedRoleId: null`, which also covers "none configured"
   * and "the grant failed once". Only this one means the setting points at a
   * deleted role, which no amount of retrying fixes and which the admin is the
   * only one who can correct.
   */
  roleMissing?: boolean;
}

/** What {@link VoiceActions.createCompanionChannel} actually managed to do. */
export interface CreateCompanionChannelResult {
  channelId: string;
  /**
   * The moderator role actually written into the create payload.
   *
   * Null when none is configured or the configured one no longer exists.
   * Returned rather than assumed, because Discord accepts a create whose
   * `permission_overwrites` names an unknown role and silently drops that
   * entry: the caller cannot infer a grant from the create having succeeded.
   */
  grantedRoleId: string | null;
  /** As {@link CompanionSyncResult.roleMissing}. */
  roleMissing: boolean;
}

export interface CreateVoiceChannelInput {
  guildId: string;
  name: string;
  /** Category to create the channel under (parent), if any. */
  parentId?: string;
  /** User limit (0 = unlimited). */
  userLimit?: number;
  bitrate?: number;
  /** Voice region override (e.g. "us-east"). Omit for Discord's "Automatic". */
  rtcRegion?: string;
  /** 1 = Auto, 2 = Full (720p) — mirrors discord.js's `VideoQualityMode`. */
  videoQualityMode?: 1 | 2;
  /** Age-restricted ("NSFW") channel. */
  nsfw?: boolean;
  /**
   * The creator channel this room belongs to. Gives the new channel its category
   * AND, for `inheritFrom: 'primary'`, its permission overwrites — so this must
   * always be the primary the member actually joined.
   *
   * **Placement is a separate question, and `anchorChannelId` is where it lives.**
   * Keeping both on one field is what made a grouped create copy the wrong creator
   * channel's permissions: a grouped block is positioned against a different
   * primary than the one that spawned the room.
   */
  nearChannelId?: string;
  /**
   * Position the new channel against THIS channel instead of `nearChannelId`: just
   * above it (`above: true`) or below it (default). Defaults to `nearChannelId`.
   *
   * A GROUPED category is the reason it exists. Its block sits above every creator
   * channel in the category or below every one of them, so the anchor is the
   * topmost or bottommost primary and `above` is the group's direction, neither of
   * which is a fact about the primary the member joined.
   */
  anchorChannelId?: string;
  above?: boolean;
  /**
   * The existing rooms the new one goes after: the primary's own block, or the
   * whole group's block in a grouped category. The new channel is placed below the
   * last of them rather than at the anchor's own position, so it lands below its
   * elders however their positions have drifted. Ignored for `above`, which
   * inserts against the anchor. See `insertIndexFor`.
   */
  afterChannelIds?: string[];
  /**
   * Leave the position directly above the new channel free as well, for a private
   * room's "⇩ Join" companion, which is created immediately afterwards and has to
   * sit there. Without it that create finds the slot taken and has to re-space the
   * category first, which is a second REST call on the join path.
   */
  reserveSlotAbove?: boolean;
  /**
   * Copy permission overwrites onto the new channel from a source resolved
   * relative to `nearChannelId`: `primary` (the near channel), `category` (its
   * parent category), or a specific channel id.
   */
  inheritFrom?: 'primary' | 'category' | string;
}

/** Outcome of a rename: whether Discord deferred it, or the channel is gone. */
export interface RenameResult {
  /**
   * True when the rename did not apply within the probe window because Discord
   * is rate-limiting edits to this channel (2 per 10 min). The rename is still
   * queued and will apply once the limit clears — callers should tell the user.
   */
  rateLimited: boolean;
  /**
   * True when the channel is confirmed to no longer exist on Discord. Callers
   * must stop tracking it rather than retry — nothing will ever make the rename
   * succeed. Never set for a channel that merely became invisible to the bot:
   * that stays a permission error (thrown), because the two are different
   * problems with different fixes.
   */
  channelGone?: boolean;
}

export interface VoiceActions {
  /** Creates a voice channel and returns its new id. */
  createVoiceChannel(input: CreateVoiceChannelInput): Promise<string>;
  /**
   * Whether `channelId` shares its position with another channel in its category.
   *
   * Asked after a create, because a shared position is not the harmless state the
   * documented position-then-id sort implies: clients were measured rendering one
   * tied trio out of id order, and Discord later normalises such a tie into unique
   * positions that preserve whatever order it had rather than ours. Undoing it
   * costs one bulk reorder, which is why the question is worth asking at all.
   *
   * Optional: absent means "cannot say", and a caller must then leave the order
   * alone rather than reorder a guild's channels on an assumption. Implementations
   * must answer from state they already hold: this is asked on the join path after
   * the room exists and the member has been moved, so a call that can fail would
   * be able to unwind a create that has already succeeded.
   */
  positionCollides?(guildId: string, channelId: string): Promise<boolean>;
  /** Deletes a channel. Must tolerate an already-deleted channel (idempotent). */
  deleteChannel(guildId: string, channelId: string): Promise<void>;
  /**
   * Renames a channel; reports whether a rate limit deferred it, or whether the
   * channel turned out to be gone (see {@link RenameResult}).
   */
  renameChannel(guildId: string, channelId: string, name: string): Promise<RenameResult>;
  /** Moves a member to a channel (or disconnects them when channelId is null). */
  moveMember(guildId: string, memberId: string, channelId: string | null): Promise<void>;
  /** Sets a channel's user limit (0 = unlimited). */
  setUserLimit(guildId: string, channelId: string, limit: number): Promise<void>;
  /**
   * Toggles a channel's privacy by editing the @everyone Connect overwrite:
   * `private` denies Connect (so only explicitly-permitted members join), public
   * clears the overwrite.
   */
  setPrivacy(guildId: string, channelId: string, isPrivate: boolean): Promise<void>;
  /** Grants or revokes a single member's Connect permission on a channel. */
  setMemberConnect(
    guildId: string,
    channelId: string,
    memberId: string,
    allow: boolean,
  ): Promise<void>;
  /**
   * Creates an open "⇩ Join" companion voice channel next to `nearChannelId`
   * (same category, adjacent position, @everyone may connect). Returns its id.
   */
  createJoinChannel(guildId: string, name: string, nearChannelId: string): Promise<string>;
  /**
   * Creates a private companion TEXT channel for a room, in the same category,
   * readable by nobody but the bot until members are synced onto it.
   *
   * Separate from the voice methods above rather than a widening of them: every
   * one of those early-returns on a non-voice channel and reports SUCCESS, so a
   * text channel routed through them would be orphaned on teardown while the
   * row was dropped cleanly.
   */
  createCompanionChannel(input: CreateCompanionChannelInput): Promise<CreateCompanionChannelResult>;
  /**
   * Converges a companion text channel's viewers onto exactly `memberIds`
   * (plus `roleId` when set), and reports what it changed.
   *
   * The desired set is passed in whole rather than as a delta, so a missed join
   * or leave is repaired by the next call instead of accumulating. The CURRENT
   * set is read from the channel's own overwrite cache, which costs nothing, so
   * this writes only the difference.
   */
  syncCompanionMembers(input: SyncCompanionMembersInput): Promise<CompanionSyncResult>;
  /** Deletes a companion text channel. Tolerates it already being gone. */
  deleteCompanionChannel(guildId: string, channelId: string): Promise<void>;
  /** Sets a voice channel's status (`''` clears it). Separate, laxer rate limit. */
  setVoiceStatus(guildId: string, channelId: string, status: string): Promise<void>;
  /**
   * Repositions a set of channels as a contiguous block directly above or below a
   * primary, in the given top-to-bottom order, via a single bulk reorder. Used by
   * `/position` to make existing channels match a changed above/below setting; the
   * list interleaves each secondary with its "⇩ Join" companion so they stay
   * adjacent.
   */
  repositionSecondaries(
    guildId: string,
    primaryChannelId: string,
    orderedChannelIds: string[],
    above: boolean,
  ): Promise<void>;
  /**
   * Repositions a whole category **group**: the ordered secondary block is placed
   * above all the group's primaries (`above`) or below all of them, in one bulk
   * reorder. Like {@link repositionSecondaries} but spanning every primary in the
   * category (used by the `/group` feature).
   */
  repositionGroup(
    guildId: string,
    primaryChannelIds: string[],
    orderedSecondaryIds: string[],
    above: boolean,
  ): Promise<void>;
}

export type RecordedAction =
  | {
      type: 'create';
      guildId: string;
      channelId: string;
      name: string;
      parentId?: string;
      /**
       * Recorded because placement is decided by the CALLER, not the adapter: the
       * anchor and the direction are what a grouped category gets wrong, and
       * without them here no handler test can see which channel a create was
       * placed against.
       */
      nearChannelId?: string;
      anchorChannelId?: string;
      above?: boolean;
      reserveSlotAbove?: boolean;
      afterChannelIds?: string[];
      bitrate?: number;
      rtcRegion?: string;
      videoQualityMode?: 1 | 2;
      nsfw?: boolean;
    }
  | { type: 'delete'; guildId: string; channelId: string }
  | { type: 'rename'; guildId: string; channelId: string; name: string }
  | { type: 'move'; guildId: string; memberId: string; channelId: string | null }
  | { type: 'limit'; guildId: string; channelId: string; limit: number }
  | { type: 'privacy'; guildId: string; channelId: string; isPrivate: boolean }
  | { type: 'connect'; guildId: string; channelId: string; memberId: string; allow: boolean }
  | {
      type: 'joinChannel';
      guildId: string;
      channelId: string;
      name: string;
      nearChannelId: string;
    }
  | { type: 'status'; guildId: string; channelId: string; status: string }
  | {
      type: 'companionCreate';
      guildId: string;
      channelId: string;
      name: string;
      secondaryChannelId: string;
    }
  | {
      type: 'companionSync';
      guildId: string;
      channelId: string;
      memberIds: string[];
      roleId: string | null;
    }
  | { type: 'companionDelete'; guildId: string; channelId: string }
  | {
      type: 'reposition';
      guildId: string;
      primaryChannelId: string;
      channelIds: string[];
      above: boolean;
    }
  | {
      type: 'repositionGroup';
      guildId: string;
      primaryChannelIds: string[];
      channelIds: string[];
      above: boolean;
    };

/**
 * In-memory recorder used by tests. Records every action and assigns synthetic
 * channel ids on create. Tolerates deleting unknown channels (idempotent).
 */
export class RecordingVoiceActions implements VoiceActions {
  readonly actions: RecordedAction[] = [];
  /** When true, every rename reports as rate-limited (for testing the notice). */
  simulateRenameRateLimit = false;
  /** When set, `deleteChannel` throws Missing Access for this channel id. */
  failDeleteForChannel?: string;
  /** When set, `renameChannel` throws Missing Access for this channel id. */
  failRenameForChannel?: string;
  /** When set, `renameChannel` reports this channel id as deleted on Discord. */
  renameGoneForChannel?: string;
  /** When true, `createVoiceChannel` throws Missing Permissions (tests the create path). */
  failCreate = false;
  /** When true, `moveMember` throws Missing Permissions (tests the created-but-stranded path). */
  failMove = false;
  /** When true, `setPrivacy` throws Missing Permissions (tests the created-but-unlockable path). */
  failPrivacy = false;
  /**
   * When true, a configured moderator role is treated as no longer existing in
   * the guild, exactly as {@link DiscordVoiceActions.resolveViewerRole} decides
   * it for real: no grant is attempted and the caller is told to report it.
   */
  missingCompanionRole = false;
  /** When true, `createCompanionChannel` throws Missing Permissions. */
  failCompanionCreate = false;
  /** When set, `syncCompanionMembers` reports this channel as gone from Discord. */
  companionGoneForChannel?: string;
  private seq = 0;
  private readonly created = new Set<string>();
  /**
   * Who can currently read each companion, so the fake can answer the same
   * "write only the difference" question the real adapter answers from the
   * channel's overwrite cache.
   */
  private readonly companionViewers = new Map<string, Set<string>>();

  constructor(private readonly idPrefix = 'sec') {}

  createVoiceChannel(input: CreateVoiceChannelInput): Promise<string> {
    if (this.failCreate) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50013, message: 'Missing Permissions' } as never,
          50013,
          403,
          'POST',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    const channelId = `${this.idPrefix}-${++this.seq}`;
    this.created.add(channelId);
    this.actions.push({
      type: 'create',
      guildId: input.guildId,
      channelId,
      name: input.name,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.nearChannelId ? { nearChannelId: input.nearChannelId } : {}),
      ...(input.anchorChannelId ? { anchorChannelId: input.anchorChannelId } : {}),
      ...(input.above !== undefined ? { above: input.above } : {}),
      ...(input.reserveSlotAbove !== undefined ? { reserveSlotAbove: input.reserveSlotAbove } : {}),
      ...(input.afterChannelIds ? { afterChannelIds: input.afterChannelIds } : {}),
      ...(input.bitrate !== undefined ? { bitrate: input.bitrate } : {}),
      ...(input.rtcRegion !== undefined ? { rtcRegion: input.rtcRegion } : {}),
      ...(input.videoQualityMode !== undefined ? { videoQualityMode: input.videoQualityMode } : {}),
      ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
    });
    return Promise.resolve(channelId);
  }

  /** Channel ids that {@link positionCollides} reports as sharing a position. */
  readonly collidingChannels = new Set<string>();

  positionCollides(_guildId: string, channelId: string): Promise<boolean> {
    return Promise.resolve(this.collidingChannels.has(channelId));
  }

  deleteChannel(guildId: string, channelId: string): Promise<void> {
    if (this.failDeleteForChannel === channelId) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50001, message: 'Missing Access' } as never,
          50001,
          403,
          'DELETE',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    this.created.delete(channelId);
    this.actions.push({ type: 'delete', guildId, channelId });
    return Promise.resolve();
  }

  renameChannel(guildId: string, channelId: string, name: string): Promise<RenameResult> {
    if (this.failRenameForChannel === channelId) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50001, message: 'Missing Access' } as never,
          50001,
          403,
          'PATCH',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    this.actions.push({ type: 'rename', guildId, channelId, name });
    if (this.renameGoneForChannel === channelId) {
      return Promise.resolve({ rateLimited: false, channelGone: true });
    }
    return Promise.resolve({ rateLimited: this.simulateRenameRateLimit });
  }

  moveMember(guildId: string, memberId: string, channelId: string | null): Promise<void> {
    if (this.failMove) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50013, message: 'Missing Permissions' } as never,
          50013,
          403,
          'PATCH',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    this.actions.push({ type: 'move', guildId, memberId, channelId });
    return Promise.resolve();
  }

  setUserLimit(guildId: string, channelId: string, limit: number): Promise<void> {
    this.actions.push({ type: 'limit', guildId, channelId, limit });
    return Promise.resolve();
  }

  setPrivacy(guildId: string, channelId: string, isPrivate: boolean): Promise<void> {
    if (this.failPrivacy) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50013, message: 'Missing Permissions' } as never,
          50013,
          403,
          'PUT',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    this.actions.push({ type: 'privacy', guildId, channelId, isPrivate });
    return Promise.resolve();
  }

  setMemberConnect(
    guildId: string,
    channelId: string,
    memberId: string,
    allow: boolean,
  ): Promise<void> {
    this.actions.push({ type: 'connect', guildId, channelId, memberId, allow });
    return Promise.resolve();
  }

  createJoinChannel(guildId: string, name: string, nearChannelId: string): Promise<string> {
    const channelId = `${this.idPrefix}-join-${++this.seq}`;
    this.created.add(channelId);
    this.actions.push({ type: 'joinChannel', guildId, channelId, name, nearChannelId });
    return Promise.resolve(channelId);
  }

  createCompanionChannel(
    input: CreateCompanionChannelInput,
  ): Promise<CreateCompanionChannelResult> {
    if (this.failCompanionCreate) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50013, message: 'Missing Permissions' } as never,
          50013,
          403,
          'POST',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    const channelId = `${this.idPrefix}-text-${++this.seq}`;
    this.created.add(channelId);
    this.companionViewers.set(channelId, new Set(input.memberIds));
    this.actions.push({
      type: 'companionCreate',
      guildId: input.guildId,
      channelId,
      name: input.name,
      secondaryChannelId: input.secondaryChannelId,
    });
    /**
     * The fake grants whatever it is given, because it has no guild to resolve
     * a role against. Tests that need the "role no longer exists" path drive it
     * through `missingCompanionRole` instead of inventing a second fake.
     */
    // `@everyone`'s id IS the guild id, and the real adapter refuses it rather
    // than publishing the chat to the server. Modelled here so a service-level
    // test cannot pass against code that records it as granted.
    const wanted = input.roleId && input.roleId !== input.guildId ? input.roleId : null;
    return Promise.resolve({
      channelId,
      grantedRoleId: this.missingCompanionRole ? null : wanted,
      roleMissing: this.missingCompanionRole && !!wanted,
    });
  }

  syncCompanionMembers(input: SyncCompanionMembersInput): Promise<CompanionSyncResult> {
    if (this.companionGoneForChannel === input.channelId) {
      return Promise.resolve({ added: 0, removed: 0, channelGone: true, grantedRoleId: null });
    }
    const current = this.companionViewers.get(input.channelId) ?? new Set<string>();
    const desired = new Set(input.memberIds);
    const added = [...desired].filter((id) => !current.has(id)).length;
    const removed = [...current].filter((id) => !desired.has(id)).length;
    this.companionViewers.set(input.channelId, desired);
    this.actions.push({
      type: 'companionSync',
      guildId: input.guildId,
      channelId: input.channelId,
      memberIds: [...input.memberIds],
      roleId: input.roleId,
    });
    if (this.missingCompanionRole && input.roleId && input.roleId !== input.guildId) {
      return Promise.resolve({
        added,
        removed,
        channelGone: false,
        grantedRoleId: null,
        roleMissing: true,
      });
    }
    return Promise.resolve({ added, removed, channelGone: false, grantedRoleId: input.roleId });
  }

  deleteCompanionChannel(guildId: string, channelId: string): Promise<void> {
    this.created.delete(channelId);
    this.companionViewers.delete(channelId);
    this.actions.push({ type: 'companionDelete', guildId, channelId });
    return Promise.resolve();
  }

  setVoiceStatus(guildId: string, channelId: string, status: string): Promise<void> {
    this.actions.push({ type: 'status', guildId, channelId, status });
    return Promise.resolve();
  }

  repositionSecondaries(
    guildId: string,
    primaryChannelId: string,
    orderedChannelIds: string[],
    above: boolean,
  ): Promise<void> {
    this.actions.push({
      type: 'reposition',
      guildId,
      primaryChannelId,
      channelIds: orderedChannelIds,
      above,
    });
    return Promise.resolve();
  }

  repositionGroup(
    guildId: string,
    primaryChannelIds: string[],
    orderedSecondaryIds: string[],
    above: boolean,
  ): Promise<void> {
    this.actions.push({
      type: 'repositionGroup',
      guildId,
      primaryChannelIds,
      channelIds: orderedSecondaryIds,
      above,
    });
    return Promise.resolve();
  }

  /** Convenience for assertions. */
  ofType<T extends RecordedAction['type']>(type: T): Extract<RecordedAction, { type: T }>[] {
    return this.actions.filter((a) => a.type === type) as Extract<RecordedAction, { type: T }>[];
  }
}
