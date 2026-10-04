import { DiscordAPIError } from 'discord.js';
import {
  diffOverwrites,
  leaveOutMembers,
  OVERWRITE_MEMBER,
  SINGLE_WRITE_MAX,
  type ResolvedOverwrite,
} from './accessPlan.js';

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

/** Options for {@link VoiceActions.moveMember}. */
export interface MoveMemberOptions {
  /**
   * Only act while the member is STILL in this channel, judged from their voice
   * state read immediately before the move, never from a snapshot an earlier
   * step took. A disconnect (`channelId` null) takes the member out of whatever
   * channel they are in now, so a block that picked its target from a stale read
   * would disconnect somebody who has since moved to an unrelated channel.
   */
  onlyFrom?: string;
}

/** What {@link VoiceActions.applyOverwrites} actually did. */
export interface ApplyOverwritesResult {
  /**
   * The overwrites asked of Discord: `desired` less what it asked for the members
   * Discord reported not being in the server. What the caller records as written, so
   * an id that never got an overwrite is never remembered as having one. One of those
   * members who already had an overwrite is left holding it, unchanged, and is here
   * as it was.
   */
  written: ResolvedOverwrite[];
  /** Member ids whose change was left out because Discord does not have them in the server. */
  droppedMemberIds: string[];
  /** REST writes made: 0 when nothing differed, 1 for a bulk write. */
  requests: number;
  /**
   * True when the write did not land within the probe window because Discord is
   * rate limiting this channel (10 overwrite writes per 10 seconds, shared with
   * edits to the channel itself). It is still queued and will land, so the caller
   * must not tell anyone the change has taken effect, and a failure after this
   * point is logged and left to the next converge pass rather than reported here.
   * So is a member found to have left after this point: only the ones the check
   * before the write found are in `droppedMemberIds`.
   */
  deferred: boolean;
  /** True when the channel is confirmed gone, so there was nothing to write. */
  channelGone: boolean;
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
  /**
   * Moves a member to a channel (or disconnects them when channelId is null).
   * A member who is not in voice, or has left the server, is not an error.
   */
  moveMember(
    guildId: string,
    memberId: string,
    channelId: string | null,
    options?: MoveMemberOptions,
  ): Promise<void>;
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
   * A room's permission overwrites as Discord holds them NOW, read fresh because
   * the cache can lag a channel update by long enough to plan against a set that
   * is no longer there. Null when the channel is confirmed gone, or is not a voice
   * channel. Throws for one the bot can no longer see, and for one that exists but
   * belongs to a guild this process does not hold or to a different guild: neither
   * is "gone", and a caller that drops a room's record on null would drop a live
   * room's.
   */
  readOverwrites(guildId: string, channelId: string): Promise<ResolvedOverwrite[] | null>;
  /**
   * A room's overwrites as the gateway cache holds them, with no request, or `undefined`
   * when the cache cannot say (the channel is not cached, belongs to another guild, or is
   * only the obfuscated shell of one the bot cannot see).
   *
   * Optional, and never a basis for a WRITE: the cache can lag a channel update, which is
   * why {@link readOverwrites} forces a fresh read. It is for a caller that only asks
   * "does anything differ", the sweep, which then reads fresh before it writes. A wrong
   * answer costs a repair one more sweep (the cache is patched by every channel update)
   * or one fresh read it did not need. Absent means the caller reads fresh, as it did.
   */
  cachedOverwrites?(guildId: string, channelId: string): ResolvedOverwrite[] | undefined;
  /**
   * Makes a room's overwrites `desired`, given `previous`, the set the plan was
   * made against. One or two changes are written one request each, the bot's
   * first. More than that is ONE bulk request carrying the whole set, because
   * overwrite writes are limited to 10 per 10 seconds per channel and a hide
   * touches far more than that. Never writes a partial set in bulk.
   *
   * Members Discord does not have in the server are left out and reported, so a
   * list that names someone who has since left cannot fail the whole write.
   */
  applyOverwrites(
    guildId: string,
    channelId: string,
    desired: readonly ResolvedOverwrite[],
    previous: readonly ResolvedOverwrite[],
  ): Promise<ApplyOverwritesResult>;
  /**
   * Whether the role still exists in the guild. False for `@everyone`, which is
   * never a moderator role. True when the guild's roles are not loaded yet: not
   * knowing is not grounds to withhold a grant the admin asked for.
   */
  roleExists(guildId: string, roleId: string): Promise<boolean>;
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
      /**
       * Recorded because the limit a room is born with is decided by the CALLER (the creator
       * channel's default, or the one a member remembered), and a restored 0 over a default
       * limit is visible nowhere else.
       */
      userLimit?: number;
      bitrate?: number;
      rtcRegion?: string;
      videoQualityMode?: 1 | 2;
      nsfw?: boolean;
    }
  | { type: 'delete'; guildId: string; channelId: string }
  | { type: 'rename'; guildId: string; channelId: string; name: string }
  | {
      type: 'move';
      guildId: string;
      memberId: string;
      channelId: string | null;
      /** Present only when the caller scoped the move to a channel the member must still be in. */
      onlyFrom?: string;
    }
  | { type: 'limit'; guildId: string; channelId: string; limit: number }
  | { type: 'privacy'; guildId: string; channelId: string; isPrivate: boolean }
  | { type: 'connect'; guildId: string; channelId: string; memberId: string; allow: boolean }
  | {
      type: 'overwrites';
      guildId: string;
      channelId: string;
      /** What the channel holds after the write. */
      written: ResolvedOverwrite[];
      /** The set the plan was made against. */
      previous: ResolvedOverwrite[];
      droppedMemberIds: string[];
      /** What the real adapter would have spent: 0, one per change up to two, else one bulk. */
      requests: number;
    }
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
  /** When true, `readOverwrites` throws Missing Access, as it does for a room the bot can no longer see. */
  failReadOverwrites = false;
  /** When true, `applyOverwrites` throws Missing Permissions and the channel keeps what it held. */
  failOverwrites = false;
  /** When true, every `applyOverwrites` reports itself deferred behind Discord's rate limit. */
  simulateOverwriteRateLimit = false;
  /** When set, `readOverwrites` and `applyOverwrites` report this channel as deleted on Discord. */
  overwritesGoneForChannel?: string;
  /**
   * Member ids Discord does not have in the server. `applyOverwrites` leaves them
   * out and reports them, which is what the real adapter's member check and its
   * retry after Unknown Member or Unknown User add up to.
   */
  readonly unknownMemberIds = new Set<string>();
  /** Role ids that no longer exist in the guild, for `roleExists`. */
  readonly missingRoleIds = new Set<string>();
  /**
   * Members `moveMember` finds not connected to voice (Discord's 40032), which the
   * real adapter swallows. Nothing is recorded for them.
   */
  readonly notConnectedMemberIds = new Set<string>();
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
  /** What each room's overwrites currently are, which `applyOverwrites` replaces. */
  private readonly overwrites = new Map<string, ResolvedOverwrite[]>();
  /** Where each member is in voice, for the `onlyFrom` check. Absent means "where the caller expects". */
  private readonly memberChannels = new Map<string, string | null>();

  constructor(private readonly idPrefix = 'sec') {}

  /**
   * Sets what `readOverwrites` reports for a room and what the next
   * `applyOverwrites` is measured against. A room never seeded reads as holding
   * none, which is what a freshly created channel with no inherited set holds.
   */
  seedOverwrites(channelId: string, overwrites: readonly ResolvedOverwrite[]): void {
    this.overwrites.set(
      channelId,
      overwrites.map((o) => ({ ...o })),
    );
  }

  /** What the room's overwrites are now, after whatever has been written to it. */
  overwritesOf(channelId: string): ResolvedOverwrite[] {
    return (this.overwrites.get(channelId) ?? []).map((o) => ({ ...o }));
  }

  /**
   * Says which channel a member is in right now, so a move scoped with `onlyFrom`
   * can find them elsewhere. `null` is not in voice. A member never mentioned is
   * taken to be where the caller expects.
   */
  setMemberChannel(memberId: string, channelId: string | null): void {
    this.memberChannels.set(memberId, channelId);
  }

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
      ...(input.userLimit !== undefined ? { userLimit: input.userLimit } : {}),
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

  moveMember(
    guildId: string,
    memberId: string,
    channelId: string | null,
    options?: MoveMemberOptions,
  ): Promise<void> {
    // Skipped before anything can fail, as the adapter does: it reads the member's
    // voice state right before moving them, and a member who is elsewhere is left be.
    if (
      options?.onlyFrom !== undefined &&
      this.memberChannels.has(memberId) &&
      this.memberChannels.get(memberId) !== options.onlyFrom
    ) {
      return Promise.resolve();
    }
    if (this.notConnectedMemberIds.has(memberId)) return Promise.resolve();
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
    this.actions.push({
      type: 'move',
      guildId,
      memberId,
      channelId,
      ...(options?.onlyFrom !== undefined ? { onlyFrom: options.onlyFrom } : {}),
    });
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

  readOverwrites(_guildId: string, channelId: string): Promise<ResolvedOverwrite[] | null> {
    if (this.failReadOverwrites) {
      return Promise.reject(
        new DiscordAPIError(
          { code: 50001, message: 'Missing Access' } as never,
          50001,
          403,
          'GET',
          'https://discord.test',
          {} as never,
        ),
      );
    }
    if (this.overwritesGoneForChannel === channelId) return Promise.resolve(null);
    return Promise.resolve(this.overwritesOf(channelId));
  }

  /**
   * What the real adapter's cache would say: what the room holds, and nothing for a room
   * whose read fails (the cache of a channel the bot cannot see is only its shell) or that
   * is gone. A test makes it stale by spying on it.
   */
  cachedOverwrites(_guildId: string, channelId: string): ResolvedOverwrite[] | undefined {
    if (this.failReadOverwrites || this.overwritesGoneForChannel === channelId) return undefined;
    return this.overwritesOf(channelId);
  }

  applyOverwrites(
    guildId: string,
    channelId: string,
    desired: readonly ResolvedOverwrite[],
    previous: readonly ResolvedOverwrite[],
  ): Promise<ApplyOverwritesResult> {
    if (this.failOverwrites) {
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
    if (this.overwritesGoneForChannel === channelId) {
      return Promise.resolve({
        written: [],
        droppedMemberIds: [],
        requests: 0,
        deferred: false,
        channelGone: true,
      });
    }
    // Only the members this write would add or change are checked, as the adapter
    // does: an existing overwrite Discord already accepted is not second-guessed.
    const diff = diffOverwrites(previous, desired);
    const droppedMemberIds = diff.upserts
      .filter((o) => o.type === OVERWRITE_MEMBER && this.unknownMemberIds.has(o.id))
      .map((o) => o.id);
    const dropped = new Set(droppedMemberIds);
    const written = leaveOutMembers(desired, previous, dropped);
    const changes = diffOverwrites(previous, written);
    const size = changes.upserts.length + changes.deletes.length;
    const requests = size === 0 ? 0 : size > SINGLE_WRITE_MAX ? 1 : size;
    this.overwrites.set(
      channelId,
      written.map((o) => ({ ...o })),
    );
    this.actions.push({
      type: 'overwrites',
      guildId,
      channelId,
      written: written.map((o) => ({ ...o })),
      previous: previous.map((o) => ({ ...o })),
      droppedMemberIds,
      requests,
    });
    return Promise.resolve({
      written: written.map((o) => ({ ...o })),
      droppedMemberIds,
      requests,
      deferred: this.simulateOverwriteRateLimit,
      channelGone: false,
    });
  }

  roleExists(guildId: string, roleId: string): Promise<boolean> {
    // `@everyone`'s id is the guild id, and it is never a moderator role.
    return Promise.resolve(roleId !== guildId && !this.missingRoleIds.has(roleId));
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
