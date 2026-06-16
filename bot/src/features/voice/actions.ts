/**
 * The Discord side-effect seam. Feature logic depends only on this interface, so
 * it can be driven by a real discord.js implementation in production and by a
 * recording fake in tests (the "fake REST/action recorder").
 */
export interface CreateVoiceChannelInput {
  guildId: string;
  name: string;
  /** Category to create the channel under (parent), if any. */
  parentId?: string;
  /** User limit (0 = unlimited). */
  userLimit?: number;
  bitrate?: number;
  /**
   * Position the new channel relative to this (primary) channel: inherit its
   * category, and sit just above (`above: true`) or below it (default). "Below"
   * is achieved purely via the create-time position (no extra reorder); "above"
   * additionally bulk-reorders the new channel up one slot.
   */
  nearChannelId?: string;
  above?: boolean;
  /**
   * Copy permission overwrites onto the new channel from a source resolved
   * relative to `nearChannelId`: `primary` (the near channel), `category` (its
   * parent category), or a specific channel id.
   */
  inheritFrom?: 'primary' | 'category' | string;
}

/** Outcome of a rename: whether Discord deferred it under a rate limit. */
export interface RenameResult {
  /**
   * True when the rename did not apply within the probe window because Discord
   * is rate-limiting edits to this channel (2 per 10 min). The rename is still
   * queued and will apply once the limit clears — callers should tell the user.
   */
  rateLimited: boolean;
}

export interface VoiceActions {
  /** Creates a voice channel and returns its new id. */
  createVoiceChannel(input: CreateVoiceChannelInput): Promise<string>;
  /** Deletes a channel. Must tolerate an already-deleted channel (idempotent). */
  deleteChannel(guildId: string, channelId: string): Promise<void>;
  /** Renames a channel; reports whether a rate limit deferred it. */
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
  private seq = 0;
  private readonly created = new Set<string>();

  constructor(private readonly idPrefix = 'sec') {}

  createVoiceChannel(input: CreateVoiceChannelInput): Promise<string> {
    const channelId = `${this.idPrefix}-${++this.seq}`;
    this.created.add(channelId);
    this.actions.push({
      type: 'create',
      guildId: input.guildId,
      channelId,
      name: input.name,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    });
    return Promise.resolve(channelId);
  }

  deleteChannel(guildId: string, channelId: string): Promise<void> {
    this.created.delete(channelId);
    this.actions.push({ type: 'delete', guildId, channelId });
    return Promise.resolve();
  }

  renameChannel(guildId: string, channelId: string, name: string): Promise<RenameResult> {
    this.actions.push({ type: 'rename', guildId, channelId, name });
    return Promise.resolve({ rateLimited: this.simulateRenameRateLimit });
  }

  moveMember(guildId: string, memberId: string, channelId: string | null): Promise<void> {
    this.actions.push({ type: 'move', guildId, memberId, channelId });
    return Promise.resolve();
  }

  setUserLimit(guildId: string, channelId: string, limit: number): Promise<void> {
    this.actions.push({ type: 'limit', guildId, channelId, limit });
    return Promise.resolve();
  }

  setPrivacy(guildId: string, channelId: string, isPrivate: boolean): Promise<void> {
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
