import {
  ActivityType,
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  type Activity,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import type { Logger } from '@avc/core';
import type { CreateVoiceChannelInput, RenameResult, VoiceActions } from './actions.js';
import type {
  GuildVoiceView,
  MemberActivity,
  VoiceChannelProperties,
  VoiceMember,
  VoiceStateEvent,
} from './types.js';

/** Discord API error code for "Unknown Channel" (already deleted). */
const UNKNOWN_CHANNEL = 10003;
/** Discord API error code for "Unknown Member" (already gone). */
const UNKNOWN_MEMBER = 10007;
/** "Missing Access" (50001 — can't see the resource) / "Missing Permissions" (50013). */
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function isApiError(err: unknown, code: number): boolean {
  return err instanceof DiscordAPIError && err.code === code;
}

/** Whether `err` is a Discord permission/visibility failure (the bot lacks access). */
export function isPermissionError(err: unknown): boolean {
  return isApiError(err, MISSING_ACCESS) || isApiError(err, MISSING_PERMISSIONS);
}

export interface ResolvedOverwrite {
  id: string;
  type: number;
  allow: bigint;
  deny: bigint;
}

/** The permissions the bot must retain to manage a channel it created. */
const BOT_REQUIRED_PERMS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.MoveMembers;

/**
 * Whether these overwrites hide the channel from `@everyone` (whose role id equals
 * the guild id). Such a category, if a new channel syncs to it, would leave the
 * bot — a member of `@everyone` — unable to see/manage the channel.
 */
export function everyoneViewDenied(overwrites: ResolvedOverwrite[], guildId: string): boolean {
  return overwrites.some(
    (o) => o.id === guildId && (o.deny & PermissionFlagsBits.ViewChannel) !== 0n,
  );
}

/**
 * Masks each overwrite's allow/deny to the bits the bot actually holds, dropping
 * any that become empty. Discord rejects a create whose overwrites touch a
 * permission the bot doesn't have (50013); masking keeps the bits it can set —
 * crucially View/Connect, which preserve a channel's visibility/hiding.
 */
export function maskOverwrites(
  overwrites: ResolvedOverwrite[],
  botPerms: bigint,
): ResolvedOverwrite[] {
  /**
   * `Manage Roles` needs ADMINISTRATOR, not `Manage Roles`.
   *
   * Discord states two rules for overwrites on Create Guild Channel, and the
   * mask above only implemented the first: "only permissions your bot has in
   * the guild can be allowed/denied. **Setting MANAGE_ROLES permission in
   * channels is only possible for guild administrators.**" AVC normally holds
   * Manage Roles but not Administrator, so `allow & botPerms` kept the bit and
   * Discord rejected the ENTIRE create with a bare 403 - on any role, in allow
   * or deny, regardless of role position.
   *
   * Conditioned on ADMINISTRATOR rather than stripped outright: a server that
   * has given AVC admin *can* set the bit, and dropping it there would quietly
   * take away an inherited permission Discord was willing to grant.
   *
   * **Where this diverges from what the admin asked for**, in the far commoner
   * non-admin case: a role allowed Manage Permissions on the source does not
   * get it on the new room (fails safe), and a role explicitly *denied* it
   * does not carry that denial (fails open, so a role holding it guild-wide
   * keeps it here). Neither is a regression, since before this the channel
   * was not created at all, but the second is a real, narrow divergence from
   * intent, which is why it's documented rather than just fixed.
   */
  const canSetManageRoles = (botPerms & PermissionFlagsBits.Administrator) !== 0n;
  const settable = canSetManageRoles ? botPerms : botPerms & ~PermissionFlagsBits.ManageRoles;
  return overwrites
    .map((o) => ({ id: o.id, type: o.type, allow: o.allow & settable, deny: o.deny & settable }))
    .filter((o) => o.allow !== 0n || o.deny !== 0n);
}

/**
 * Guards against AVC locking itself out of a channel it creates. Inheriting (or
 * syncing to) a "private" category/source copies its `@everyone` View/Connect
 * *denies* onto the new channel — and the bot, being in `@everyone`, loses access
 * to its own channel (later moves/deletes fail with `Missing Access`, 50001). A
 * member-level overwrite for the bot is the highest-precedence rule in Discord's
 * model, so we merge in a bot allow that overrides any inherited role/`@everyone`
 * deny.
 */
export function withBotAccess(overwrites: ResolvedOverwrite[], botId: string): ResolvedOverwrite[] {
  const mine = overwrites.find((o) => o.id === botId && o.type === OverwriteType.Member);
  if (mine) {
    mine.allow |= BOT_REQUIRED_PERMS;
    mine.deny &= ~BOT_REQUIRED_PERMS;
    return overwrites;
  }
  return [
    ...overwrites,
    { id: botId, type: OverwriteType.Member, allow: BOT_REQUIRED_PERMS, deny: 0n },
  ];
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
 * Gap left between channels by any reorder we perform.
 *
 * A reorder is the only chance to choose these numbers, and numbering them
 * 0, 1, 2 leaves a category with nowhere to put the next room except on top of
 * an existing position. Spacing them means a create takes a free slot instead,
 * and needs no reorder at all.
 *
 * **The value is the headroom, and the two directions spend it differently.** A
 * `below` block with something under it in its category (a divider, another
 * creator channel) absorbs `POSITION_STEP - 1` creates before the slot beneath its
 * last room is taken, so sixteen buys fifteen, and a block with nothing below it
 * never runs out at all. An `above` block absorbs only `log2(POSITION_STEP)`,
 * four, because every room inserts into the same gap between the newest room and
 * the creator channel and takes its midpoint. Raising the step helps `above`
 * logarithmically and `below` linearly. At a step of 2, `below` would reorder
 * every other join, which is barely better than reordering on every one.
 *
 * Costs nothing to raise: positions are ordering values rather than indices,
 * Discord already tolerates gaps (a deleted room leaves one), and each category
 * is ordered independently, so the larger numbers do not collide with anything.
 *
 * Applied across the WHOLE list rather than inside the block, so the sequence
 * stays strictly increasing. Spacing only the block would reorder it relative to
 * the channels either side of it, which is the fault this is meant to prevent.
 *
 * **Numbering starts at one step, not at zero, and that is load-bearing for
 * `above`.** Discord refuses a negative position outright (400, `NUMBER_TYPE_MIN`,
 * "int32 value should be greater than or equal to 0" — measured against the live
 * API, on both create and bulk reorder). A room placed *above* its creator channel
 * needs a free integer BELOW the topmost channel's position, so a category whose
 * top channel sits at 0 has nowhere for one to go and every such create has to buy
 * a reorder. Starting at `POSITION_STEP` leaves that headroom and costs nothing:
 * positions are ordering values, not indices.
 */
const POSITION_STEP = 16;

/**
 * How long to wait for a channel rename to apply before treating it as deferred
 * by a rate limit. A normal rename resolves well under this; Discord's per-channel
 * edit limit (2 / 10 min) makes a throttled one queue for far longer.
 */
const RENAME_PROBE_MS = 2500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real discord.js implementation of the voice side-effect seam. All mutating
 * calls tolerate already-applied state (deleted channel / absent member) so the
 * dispatcher can replay events idempotently.
 */
export class DiscordVoiceActions implements VoiceActions {
  constructor(
    private readonly client: Client,
    private readonly logger?: Logger,
  ) {}

  async createVoiceChannel(input: CreateVoiceChannelInput): Promise<string> {
    const guild = await this.client.guilds.fetch(input.guildId);

    // A copied bitrate can be stale relative to what a FRESH create currently
    // allows: Discord never retroactively clamps an EXISTING channel when the
    // guild's boost tier later drops, so a primary set to e.g. 256kbps while
    // boosted keeps reporting that bitrate forever even after boosts lapse.
    // Clamping here (rather than trusting the copied value) is what stops that
    // ordinary boost churn from turning into a create failure.
    const bitrate =
      input.bitrate !== undefined ? Math.min(input.bitrate, guild.maximumBitrate) : undefined;

    // Resolve placement (category + position) relative to the primary channel.
    let parentId = input.parentId;
    const near = input.nearChannelId
      ? await this.client.channels.fetch(input.nearChannelId).catch(() => null)
      : null;
    const placeAbove = input.above === true;
    // Create the channel in the slot it is meant to END in, so the first thing
    // anyone sees is its final position. Discord honours an arbitrary create-time
    // position exactly and shifts no sibling to make room (measured against the
    // live API), so the only thing that can stop this is the slot already being
    // occupied — which `makeRoomAt` fixes by re-spacing the category first, in an
    // order-preserving way nobody can see.
    // The anchor is the channel the new one is positioned AGAINST, which for a
    // grouped category is not the primary it belongs to. They are resolved apart
    // because `near` also decides the inherited permissions below, and pointing
    // that at the group's end primary copied a different creator channel's
    // overwrites onto the room.
    const anchor =
      input.anchorChannelId && input.anchorChannelId !== input.nearChannelId
        ? await this.client.channels.fetch(input.anchorChannelId).catch(() => null)
        : near;
    let createPosition: number | undefined;
    if (anchor?.isVoiceBased()) {
      parentId ??= anchor.parent?.id;
      const index = this.insertIndexFor(anchor, input.afterChannelIds, placeAbove);
      createPosition =
        index === -1
          ? anchor.rawPosition
          : await this.slotFor(anchor, index, placeAbove, input.reserveSlotAbove === true);
    }

    // Resolve the permission overwrites to create the channel with:
    //  - `inheritFrom` copies its source's overwrites (secondaries default to the
    //    primary channel; `/inheritpermissions` can pick the category or a channel);
    //  - a channel created directly in a category with no inherit source (e.g. a
    //    primary) only snapshots that category when it hides itself from @everyone —
    //    otherwise we leave perms clean and let Discord sync as usual.
    const botId = this.client.user?.id;
    let overwrites = input.inheritFrom
      ? await this.resolveInheritedOverwrites(input.inheritFrom, near)
      : undefined;
    if (!overwrites && !input.inheritFrom && parentId) {
      const category = await this.resolveCategoryOverwrites(parentId);
      if (category && everyoneViewDenied(category, input.guildId)) overwrites = category;
    }
    // Inject a bot-access overwrite when the result hides the channel from
    // @everyone (and so from the bot, a member of @everyone).
    if (overwrites && botId && everyoneViewDenied(overwrites, input.guildId)) {
      overwrites = withBotAccess(overwrites, botId);
    }
    // Discord only lets you set overwrite bits you yourself hold, and only with
    // Manage Roles — otherwise it rejects the whole create with 50013. So mask
    // every overwrite to the bot's own permissions (View/Connect denies survive,
    // exotic bits the bot lacks are dropped); without Manage Roles we can't set
    // overwrites at all, so fall back to letting Discord sync to the category.
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const botPerms = me?.permissions.bitfield ?? 0n;
    let permissionOverwrites: ResolvedOverwrite[] | undefined;
    if (
      overwrites &&
      overwrites.length > 0 &&
      (botPerms & PermissionFlagsBits.ManageRoles) !== 0n
    ) {
      const masked = maskOverwrites(overwrites, botPerms);
      // Inheriting promises to copy the source's permissions, and this is the
      // one bit it may quietly not copy. Debug rather than warn: it is correct
      // behaviour, but "why can my mods not edit these rooms" needs an answer
      // that does not require reading the source.
      if (
        (botPerms & PermissionFlagsBits.Administrator) === 0n &&
        overwrites.some((o) => ((o.allow | o.deny) & PermissionFlagsBits.ManageRoles) !== 0n)
      ) {
        this.logger?.debug(
          { guildId: input.guildId, source: input.inheritFrom ?? 'category' },
          'dropped Manage Roles from inherited overwrites (needs Administrator)',
        );
      }
      if (masked.length > 0) permissionOverwrites = masked;
    }

    const baseOptions = {
      name: input.name,
      type: ChannelType.GuildVoice as const,
      ...(parentId ? { parent: parentId } : {}),
      ...(createPosition !== undefined ? { position: createPosition } : {}),
      ...(input.userLimit !== undefined ? { userLimit: input.userLimit } : {}),
      ...(permissionOverwrites ? { permissionOverwrites } : {}),
    };
    // Bitrate/region/video-quality/nsfw copied from a primary, kept separate
    // from `baseOptions` so a create that fails because of one of THEM (a
    // stale value Discord no longer accepts on a fresh channel) can be retried
    // without them, rather than leaving the primary permanently unable to
    // spawn rooms over a value Discord itself would silently default anyway.
    const copiedProps = {
      ...(bitrate !== undefined ? { bitrate } : {}),
      ...(input.rtcRegion !== undefined ? { rtcRegion: input.rtcRegion } : {}),
      ...(input.videoQualityMode !== undefined ? { videoQualityMode: input.videoQualityMode } : {}),
      ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
    };

    let channel;
    try {
      channel = await guild.channels.create({ ...baseOptions, ...copiedProps });
    } catch (err) {
      const retryWithoutCopiedProps =
        err instanceof DiscordAPIError &&
        !isPermissionError(err) &&
        Object.keys(copiedProps).length > 0;
      if (!retryWithoutCopiedProps) throw err;
      this.logger?.warn(
        { guildId: input.guildId, err, dropped: Object.keys(copiedProps) },
        'create failed with copied channel properties, retrying without them',
      );
      channel = await guild.channels.create(baseOptions);
    }
    return channel.id;
  }

  /**
   * The category's voice channels in the order Discord renders them.
   *
   * Positions in two categories are separate number spaces, so this is always
   * scoped to one parent (`null` — the server root — is a real parent here).
   */
  private sortedSiblings(anchor: VoiceBasedChannel): VoiceBasedChannel[] {
    return [...anchor.guild.channels.cache.values()]
      .filter((c): c is VoiceBasedChannel => c.isVoiceBased() && c.parentId === anchor.parentId)
      .sort((a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  /**
   * Where the new room belongs, as an index into {@link sortedSiblings}: the
   * slot it would occupy once it exists.
   *
   * `above` inserts immediately before the primary, because the block above a
   * creator channel is ordered oldest-first and the newest room therefore sits
   * directly against it (`blockMisordered` in the handler is the same rule from
   * the other side). `below` inserts after the primary's existing block.
   *
   * Returns -1 when the primary is not in the sorted list at all, which means the
   * channel cache cannot see this category. That is "cannot say", not "index 0":
   * an unhydrated guild yields an EMPTY sibling list, and reading that as index 0
   * would assert the room belongs at the very top of a category we know nothing
   * about. {@link positionCollides} reads the same blind cache, so it would not
   * notice either.
   */
  private insertIndexFor(
    anchor: VoiceBasedChannel,
    blockIds: string[] | undefined,
    above: boolean,
  ): number {
    const siblings = this.sortedSiblings(anchor);
    const start = siblings.findIndex((c) => c.id === anchor.id);
    if (start === -1) return -1;
    if (above) return start;

    // Walk DOWN from the primary and stop at the first channel that is not part
    // of this block, rather than taking the largest position any room holds.
    // An unbounded maximum reads a single room somebody dragged to the bottom of
    // the category as the end of the block, and then anchors every future room
    // below everything in between, including other creator channels and their
    // rooms. That would be a new fault, in a state the misorder check cannot see.
    const block = new Set(blockIds ?? []);
    let end = start;
    for (let i = start + 1; i < siblings.length; i += 1) {
      if (block.has(siblings[i]!.id)) {
        end = i;
        continue;
      }
      // A private room's "join" companion sits directly above the room it fronts
      // and is not in `blockIds`, so tolerate exactly that shape: one foreign
      // channel whose successor is ours again. Without this, any guild with a
      // private room in the block falls back to the primary's own position, the
      // new room lands above its elders, and the misorder check then buys a bulk
      // reorder on every single join.
      if (block.has(siblings[i + 1]?.id ?? '')) continue;
      break;
    }
    return end + 1;
  }

  /**
   * The position to create a channel at so that it lands at `index` of the
   * category's voice channels, with no reorder afterwards.
   *
   * **A shared position is not a safe place to land, and this is measured.** The
   * documented sort is position then id, so a tie should render oldest-first, and
   * for a while this relied on that. It does not hold in the client: a guild with
   * rooms 9, 10 and 11 all on position 81 rendered them `10, 9, 11`, which is not
   * id order in any direction. Discord then normalises such a tie into unique
   * positions at some later point and bakes that arbitrary order in, at which
   * point the block is genuinely out of order rather than merely ambiguous. So a
   * tie is not a harmless steady state, it is the thing that decays into the bug.
   * Every branch here therefore returns a position nothing else holds.
   *
   * **Which end of the gap to take is not a style choice.** A `below` room hugs
   * the TOP of its gap, because the next room down will want the space underneath
   * it and taking the middle would halve it for nothing. An `above` room takes the
   * MIDDLE, because every later room inserts into that same shrinking gap between
   * the newest room and the primary, so the midpoint is what buys more than one.
   *
   * When the gap is too small, {@link makeRoomAt} re-spaces the category and
   * returns the slot it opened. Only if THAT fails do we tie deliberately, with
   * the channel ABOVE the slot wherever there is one. The new channel has the
   * largest snowflake in the guild, so a tie sorts it below its partner: tying
   * upwards renders on the correct side, and tying downwards renders it on the
   * wrong side of the very channel it was meant to sit against. Above-mode used to
   * tie downwards on every single create, and that is the frame this work removes.
   *
   * **One tie is unavoidable and it is the only one left:** an `above` room whose
   * anchor is the topmost voice channel of its category AND sits at position 0,
   * when the re-space that would have moved it down has failed. There is nothing
   * above position 0 to tie with, because Discord refuses a negative position, so
   * the room ties with its own creator channel and renders under it until
   * {@link positionCollides} buys the repair.
   */
  private async slotFor(
    anchor: VoiceBasedChannel,
    index: number,
    above: boolean,
    reserveSlotAbove: boolean,
  ): Promise<number> {
    const siblings = this.sortedSiblings(anchor);
    // `-1` for "nothing above", so the first usable position is 0. Discord
    // refuses anything lower (400 NUMBER_TYPE_MIN), which is why this floor
    // exists rather than being allowed to go negative.
    const lower = index > 0 ? siblings[index - 1]!.rawPosition : -1;
    const upper = siblings[index]?.rawPosition;
    // The companion of a private room has to fit in the slot directly above the
    // room, so that room needs two free integers rather than one.
    const need = reserveSlotAbove ? 2 : 1;

    if (upper === undefined) return Math.max(lower + need, 0);
    const gap = upper - lower;
    if (gap > need) {
      if (!above) return lower + need;
      // The reserved slot goes between the predecessor and the room, never below
      // it, because that is where the companion has to sit. So take the midpoint
      // of what is left AFTER reserving rather than of the whole gap.
      const first = lower + need;
      return first + Math.floor((upper - first) / 2);
    }
    return (
      (await this.makeRoomAt(anchor, siblings, index, need)) ??
      (lower >= 0 ? lower : anchor.rawPosition)
    );
  }

  /**
   * Re-spaces the category's voice channels, opening `need` free slots at `index`,
   * and returns the position for the new channel: the BOTTOM one of them, so any
   * slot reserved beyond the first sits ABOVE the new channel, which is the side
   * a private room's companion has to be on.
   *
   * **This is invisible, and that is the whole point of doing it here rather than
   * afterwards.** The mapping is strictly increasing in the existing sort order, so
   * the only thing it changes is the numbers behind the channels. Running it BEFORE
   * the create means the new channel's first appearance is its final position; the
   * reorder it replaces ran after, which is what anyone watching saw as a jump.
   *
   * The one case where it settles something rather than preserving it is a TIE,
   * which is one of the two things that bring it here. A tie has no defined render
   * order to preserve (a client was measured rendering one trio `10, 9, 11`), so
   * resolving it the documented way is the point rather than a side effect.
   *
   * Best-effort: `undefined` means the caller should fall back to a tie rather
   * than fail a create over placement.
   */
  private async makeRoomAt(
    anchor: VoiceBasedChannel,
    siblings: VoiceBasedChannel[],
    index: number,
    need: number,
  ): Promise<number | undefined> {
    try {
      await anchor.guild.channels.setPositions(
        siblings.map((c, i) => ({
          channel: c.id,
          position: (i < index ? i + 1 : i + 1 + need) * POSITION_STEP,
        })),
      );
      return (index + need) * POSITION_STEP;
    } catch (err) {
      this.logger?.warn(
        // `anchorChannelId`, not `primaryChannelId`: a join companion is
        // positioned against its ROOM, so naming this a primary would put a
        // secondary's id in a field an operator reads as a creator channel.
        { err, guildId: anchor.guildId, anchorChannelId: anchor.id },
        'could not make room for a new channel; creating at a shared position',
      );
      return undefined;
    }
  }

  positionCollides(guildId: string, channelId: string): Promise<boolean> {
    // Cache only, never `guilds.fetch`. This runs on the join path after the room
    // already exists and the member has been moved into it, so it must not be
    // able to fail: a REST read here could reject and unwind a create that has
    // already succeeded. A guild we cannot see answers "no collision", which
    // leaves the order alone rather than reordering on a guess.
    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!guild || !channel?.isVoiceBased()) return Promise.resolve(false);
    // Read from the channel Discord actually created rather than predicting what
    // it would assign: the whole reason a tie has to be undone is that Discord's
    // own handling of one cannot be relied on.
    const collides = [...guild.channels.cache.values()].some(
      (c) =>
        c.id !== channel.id &&
        c.isVoiceBased() &&
        c.parentId === channel.parentId &&
        c.rawPosition === channel.rawPosition,
    );
    return Promise.resolve(collides);
  }

  /** A category's overwrites by id (for the implicit-sync lock-out guard). */
  private async resolveCategoryOverwrites(
    categoryId: string,
  ): Promise<ResolvedOverwrite[] | undefined> {
    const category = await this.client.channels.fetch(categoryId).catch(() => null);
    return category && 'permissionOverwrites' in category
      ? mapOverwrites(category.permissionOverwrites.cache)
      : undefined;
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
      /**
       * Otherwise `mode` is a channel id to copy from.
       *
       * **Two guards, both matching what the legacy bot did.**
       *
       * The channel must be in *this* guild. `client.channels.fetch` is global,
       * where legacy used `guild.get_channel`, so without the check a stored id
       * pointing at another server would copy that server's overwrites into
       * this one. Nothing in the dump does this today (23 id values, all
       * in-guild) but the id is admin-supplied and lives forever.
       *
       * And an id that no longer resolves falls back to the primary, not to
       * nothing. Returning undefined here means the caller creates the channel
       * with no overwrites at all, which makes Discord sync it to the category
       * -- so a locked primary inside an open category silently produces an
       * *open* room. Legacy started from the primary's overwrites and only
       * replaced them if the id resolved, and its help text promised exactly
       * that. **11 of the 23 id values in the dump are already dead**, so this
       * is the common case for them, not the edge case.
       */
      const source = await this.client.channels.fetch(mode).catch(() => null);
      const sameGuild =
        source && 'guildId' in source && near && 'guildId' in near
          ? source.guildId === near.guildId
          : false;
      if (source && sameGuild && 'permissionOverwrites' in source) {
        return mapOverwrites(source.permissionOverwrites.cache);
      }
      return near?.isVoiceBased() ? mapOverwrites(near.permissionOverwrites.cache) : undefined;
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

  /**
   * Whether `channelId` is *definitively* gone from Discord.
   *
   * Discord answers `Missing Access` (50001) rather than `Unknown Channel` for a
   * resource it will not confirm exists, so by error code alone a deleted channel
   * is indistinguishable from one merely hidden from the bot. Worse, discord.js
   * serves `channels.fetch` from its cache, so a stale entry can make the edit the
   * first call to touch the API at all. A forced re-fetch bypasses the cache and
   * asks Discord directly.
   *
   * Only an explicit 10003 counts as proof. Anything else — a hidden channel, a
   * timeout, a 5xx during an outage — returns false, because dropping a live
   * channel's row on ambiguous evidence is far worse than retrying a dead one.
   */
  private async confirmChannelGone(channelId: string): Promise<boolean> {
    try {
      await this.client.channels.fetch(channelId, { force: true });
      return false;
    } catch (err) {
      return isApiError(err, UNKNOWN_CHANNEL);
    }
  }

  async renameChannel(_guildId: string, channelId: string, name: string): Promise<RenameResult> {
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return { rateLimited: false, channelGone: true };
      if (isPermissionError(err) && (await this.confirmChannelGone(channelId))) {
        return { rateLimited: false, channelGone: true };
      }
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
        async (err: unknown) => {
          if (isApiError(err, UNKNOWN_CHANNEL)) return 'gone' as const;
          // The channel came from the cache, so this edit is the first call that
          // actually reached Discord — and a 50001 here may mean "deleted" just as
          // easily as "hidden". Ask again, uncached, before believing either.
          if (isPermissionError(err) && (await this.confirmChannelGone(channelId))) {
            return 'gone' as const;
          }
          throw err;
        },
      ),
      delay(RENAME_PROBE_MS).then(() => 'pending' as const),
    ]);
    if (outcome === 'gone') return { rateLimited: false, channelGone: true };
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
      if (isPrivate) {
        // Same lockout `withBotAccess` guards against at create time, reached
        // by a different door: denying @everyone Connect below also denies it
        // to the bot (a member of @everyone) unless a higher-precedence
        // overwrite says otherwise, and without Administrator the bot then
        // can't even grant the owner Connect right after (Discord: you can
        // only set an overwrite bit you effectively hold) -- nor rename,
        // delete, or move anyone out of the channel it just locked. Written
        // first, so there is no window where the @everyone deny applies
        // without it.
        const botId = this.client.user?.id;
        if (botId) {
          await channel.permissionOverwrites.edit(
            botId,
            { ViewChannel: true, Connect: true, ManageChannels: true, MoveMembers: true },
            { type: OverwriteType.Member },
          );
        }
      }
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

  /**
   * Writes `desired` (top to bottom) back as positions, in ONE bulk reorder.
   *
   * **Skipped entirely when the channels already render in this order.** A create
   * now lands in its final slot, so the repair that follows one is usually asking
   * for the order that already holds, and issuing it anyway would spend a REST
   * call per join to change nothing.
   *
   * "Already in this order" means strictly increasing positions, so a TIE is never
   * treated as correct however close it looks. The client resolves a tie in an
   * order of its own and Discord eventually makes that resolution permanent, which
   * is the fault this whole mechanism exists to undo.
   *
   * Numbering starts at one step rather than zero, so the category keeps room
   * above its topmost channel for an `above` room to be created into. See
   * {@link POSITION_STEP}.
   */
  private async applyOrder(
    guild: { channels: { setPositions(p: { channel: string; position: number }[]): unknown } },
    desired: VoiceBasedChannel[],
  ): Promise<void> {
    const alreadyRight = desired.every(
      (c, i) => i === 0 || desired[i - 1]!.rawPosition < c.rawPosition,
    );
    if (alreadyRight) return;
    await guild.channels.setPositions(
      desired.map((c, i) => ({ channel: c.id, position: (i + 1) * POSITION_STEP })),
    );
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
      // then hand the whole list to `applyOrder`, which sends at most ONE bulk
      // reorder and sends none at all when the category already renders this way.
      const insertAt = above ? pIdx : pIdx + 1;
      const desired = [...rest.slice(0, insertAt), ...secs, ...rest.slice(insertAt)];
      await this.applyOrder(guild, desired);
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
      await this.applyOrder(guild, desired);
    } catch (err) {
      this.logger?.warn({ err, primaryChannelIds }, 'failed to reposition group');
    }
  }

  async setVoiceStatus(guildId: string, channelId: string, status: string): Promise<void> {
    // discord.js has no helper for voice channel status yet, so call the raw
    // endpoint. Its rate limit is far laxer than channel renames. `''` clears it.
    try {
      await this.client.rest.put(`/channels/${channelId}/voice-status`, {
        body: { status },
      });
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      // The guild id was already a parameter and simply went unlogged, which
      // left the most common cause of this warning (a guild that has not
      // granted the permission) with nothing to identify the guild by.
      this.logger?.warn({ err, guildId, channelId }, 'failed to set voice channel status');
    }
  }

  async createJoinChannel(guildId: string, name: string, nearChannelId: string): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);
    const near = await this.client.channels.fetch(nearChannelId).catch(() => null);
    let parentId: string | undefined;
    let createPosition: number | undefined;
    if (near?.isVoiceBased()) {
      parentId = near.parent?.id;
      // The companion sits directly above the room it fronts, so it wants the
      // room's own slot in the sorted list. A room created with `reserveSlotAbove`
      // has left one free and this costs nothing; otherwise `slotFor` re-spaces.
      const index = this.sortedSiblings(near).findIndex((c) => c.id === near.id);
      createPosition =
        index === -1 ? near.rawPosition : await this.slotFor(near, index, true, false);
    }
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      ...(parentId ? { parent: parentId } : {}),
      ...(createPosition !== undefined ? { position: createPosition } : {}),
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

  /**
   * discord.js's own `Guild#available`, which is stricter than it looks: it is
   * false for an outage, false for a `READY` stub, and false for any payload
   * that arrived without a `channels` array (`Guild.js`). An absent guild
   * answers false too, so a guild on another instance's shard is never
   * mistaken for one whose channels have all vanished.
   */
  guildAvailable(guildId: string): boolean {
    return this.client.guilds.cache.get(guildId)?.available === true;
  }

  categoryOf(channelId: string): string | null | undefined {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !('parentId' in channel)) return undefined;
    return channel.parentId ?? null;
  }

  /**
   * The channel's live user limit. Fresh immediately after `/limit`, because
   * `GuildChannelManager.edit` patches the cache from the PATCH response rather
   * than waiting for the gateway echo.
   */
  userLimitOf(channelId: string): number | undefined {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return undefined;
    return (channel as VoiceBasedChannel).userLimit;
  }

  displayOrderOf(channelIds: string[]): string[] | undefined {
    const known = channelIds
      .map((id) => this.client.channels.cache.get(id))
      .filter((c): c is VoiceBasedChannel => !!c && c.isVoiceBased());
    if (known.length === 0) return undefined;
    return known
      .sort((a, b) => a.rawPosition - b.rawPosition || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map((c) => c.id);
  }

  voicePropertiesOf(channelId: string): VoiceChannelProperties | undefined {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return undefined;
    const voiceChannel = channel as VoiceBasedChannel;
    // Narrowed rather than cast, so a hypothetical future third Discord mode
    // falls back to `null` (not copied) instead of silently mistyping it.
    const videoQualityMode =
      voiceChannel.videoQualityMode === 1 || voiceChannel.videoQualityMode === 2
        ? voiceChannel.videoQualityMode
        : null;
    return {
      bitrate: voiceChannel.bitrate,
      rtcRegion: voiceChannel.rtcRegion,
      videoQualityMode,
      nsfw: voiceChannel.nsfw,
    };
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
