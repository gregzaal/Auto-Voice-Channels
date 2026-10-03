import {
  ActivityType,
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  type Activity,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import type { Logger } from '@avc/core';
import {
  BOT_ACCESS,
  diffOverwrites,
  leaveOutMembers,
  OVERWRITE_MEMBER,
  SINGLE_WRITE_MAX,
  type ResolvedOverwrite,
} from './accessPlan.js';
import type {
  ApplyOverwritesResult,
  CompanionSyncResult,
  CreateCompanionChannelInput,
  CreateCompanionChannelResult,
  CreateVoiceChannelInput,
  MoveMemberOptions,
  RenameResult,
  SyncCompanionMembersInput,
  VoiceActions,
} from './actions.js';
import type { CommandCaller } from './commandAccess.js';
import type {
  BotRoleAccess,
  GuildVoiceView,
  MemberActivity,
  MemberFacts,
  VoiceChannelProperties,
  VoiceMember,
  VoiceStateEvent,
} from './types.js';

/** Discord API error code for "Unknown Channel" (already deleted). */
const UNKNOWN_CHANNEL = 10003;
/** Discord API error code for "Unknown Member" (already gone). */
const UNKNOWN_MEMBER = 10007;
/** "Unknown User": an id that names no account, which an overwrite can answer with too. */
const UNKNOWN_USER = 10013;
/** "Unknown Overwrite": the overwrite, or the role it names, is not there. */
const UNKNOWN_OVERWRITE = 10009;
/** "Target user is not connected to voice": a move or disconnect of a member who is not in voice. */
const NOT_IN_VOICE = 40032;
/** "Missing Access" (50001 — can't see the resource) / "Missing Permissions" (50013). */
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
/** "Invalid Form Body": how a request Discord will not take as a whole can be answered. */
const INVALID_FORM_BODY = 50035;

function isApiError(err: unknown, code: number): boolean {
  return err instanceof DiscordAPIError && err.code === code;
}

/**
 * A 4xx that Discord refused the request with, which sending it another way might
 * get past. Not a rate limit (discord.js queues those and never rejects with one)
 * and not a channel that is gone, which has its own handling.
 */
function isClientRejection(err: unknown): boolean {
  return (
    err instanceof DiscordAPIError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429 &&
    err.code !== UNKNOWN_CHANNEL
  );
}

/**
 * Empties the request body a Discord error carries, and returns the error.
 *
 * A failed overwrite write holds the whole set it sent, and anything that logs the
 * error (the dispatcher logs every one it catches, once per sweep while a failure
 * lasts) would write every member id with an allow or deny on the room: a hidden
 * room's guest list and an owner's block list. Nothing downstream reads it.
 */
function withoutRequestBody<T>(err: T): T {
  if (typeof err === 'object' && err !== null && 'requestBody' in err) {
    (err as { requestBody: unknown }).requestBody = { files: undefined, json: undefined };
  }
  return err;
}

/**
 * Discord's `CHANNEL_OBFUSCATED` channel flag (`1 << 17`), mandatory for every
 * bot from 2026-11-16. The gateway still dispatches a channel the bot cannot
 * View, but with its name replaced by `___hidden___`, this flag set, and its
 * overwrites reduced to a single `@everyone` View deny. discord.js builds its
 * overwrite cache from that payload, so the cache holds a falsehood about a
 * channel we may still own, and an edit merged onto it would write the falsehood
 * back. Declared here because the installed `discord-api-types` predates it.
 */
export const CHANNEL_OBFUSCATED = 1 << 17;

/**
 * Thrown instead of acting on a channel the bot can no longer see.
 *
 * Counts as a permission error ({@link isPermissionError}), so every existing
 * recovery path applies unchanged: the room is recorded as a lost-access problem
 * and given up on, rather than retried every sweep. It is deliberately NOT "the
 * channel is gone", which is a different problem with a different fix.
 */
export class ChannelObfuscatedError extends Error {
  constructor(readonly channelId: string) {
    super(`channel ${channelId} is obfuscated: the bot can no longer view it`);
    this.name = 'ChannelObfuscatedError';
  }
}

/** Whether Discord is showing us only the obfuscated shell of this channel. */
function isObfuscated(channel: { flags?: { bitfield: number } | null }): boolean {
  return ((channel.flags?.bitfield ?? 0) & CHANNEL_OBFUSCATED) !== 0;
}

/** Whether `err` is a Discord permission/visibility failure (the bot lacks access). */
export function isPermissionError(err: unknown): boolean {
  return (
    isApiError(err, MISSING_ACCESS) ||
    isApiError(err, MISSING_PERMISSIONS) ||
    err instanceof ChannelObfuscatedError
  );
}

/**
 * Whether Discord says the thing is already gone.
 *
 * Distinct from a permission error, and the pair together are the only
 * PERMANENT failures: everything else (a 500, an exhausted rate limit, a
 * dropped socket) is worth retrying, and a caller that drops its only record of
 * a channel on a transient failure orphans it for good.
 */
export function isGoneError(err: unknown): boolean {
  return isApiError(err, UNKNOWN_CHANNEL);
}

/**
 * Channel types a companion may legitimately be.
 *
 * It is created as a text channel, and a human can convert it to an
 * announcement channel without telling anyone. Both still carry permission
 * overwrites and both are ours to converge and to delete.
 */
function isCompanionType(type: number): boolean {
  return type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;
}

// Lives in `accessPlan.ts`, which has to stay free of discord.js, and is re-exported
// so this file's callers keep importing it from here.
export type { ResolvedOverwrite };

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
    canManage: managesChannels(member),
  };
}

/**
 * Whether a member can manage channels, which no `/restrict` rule can stop.
 *
 * Judged against `channel` when there is one, so Manage Channels held only
 * through a category or room overwrite counts, which is how the command guard
 * sees it (it reads the interaction's own channel-level permissions). Without
 * one it is the guild-wide answer, which is all a snapshot of a member has.
 * `permissionsFor` answers null for a member it cannot resolve, which falls
 * back to the guild-wide answer too.
 *
 * Never throws, because the snapshot is built on the path of every voice state
 * event and a throw there would drop the event. Not exempt is the answer that
 * changes nothing else: it only means a rule that names this member applies.
 */
function managesChannels(member: GuildMember, channel?: GuildBasedChannel): boolean {
  try {
    const permissions = channel?.permissionsFor(member) ?? member.permissions;
    return (
      permissions.has(PermissionFlagsBits.ManageChannels) ||
      permissions.has(PermissionFlagsBits.Administrator)
    );
  } catch {
    return false;
  }
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

/**
 * The same window for a voice-channel status write, and deliberately the same
 * number as {@link RENAME_PROBE_MS}.
 *
 * Discord does not publish a tight rate limit on `/voice-status` today, which is
 * exactly why this is here rather than added after the fact: the endpoint is
 * written on the same hot path as a rename, from inside the guild's serial work
 * queue, and an unbounded await there is what stalled three guilds on
 * 2026-09-16 (`guildQueue.ts`). If Discord tightens this endpoint — and a status
 * that changes whenever someone's game does is an obvious candidate —
 * discord.js will queue the request rather than reject it, and without this the
 * queue would wait on it for as long as Discord says.
 *
 * Separate constant from the rename's so the two can diverge if their limits do.
 */
const STATUS_PROBE_MS = 2500;

/**
 * The same window for an overwrite write, as its own number because the limit it
 * guards is its own: 10 writes per 10 seconds per channel, shared with every edit
 * to the channel itself (measured 2026-10-03: the 11th got a 429 with a 10.5 second
 * wait, and discord.js queues such a request rather than rejecting it).
 *
 * **Why a probe, when the caller wants to confirm the write.** The same reason as
 * the rename: this runs inside the guild's serial queue, and a hide that waited out
 * a 429 would hold every other event for that guild for ten seconds. What makes it
 * safe is the result's `deferred`, which tells the caller not to confirm anything
 * yet, and the order the caller works in: the access record is written BEFORE the
 * request, so a write that lands late agrees with the record, and one that fails
 * late is repaired by the converge pass. A transition is one bulk request, so a
 * 429 needs a burst against one room to happen at all.
 */
const OVERWRITE_PROBE_MS = 2500;

/** Discord caps the ids in one gateway member request at 100. */
const MEMBER_LOOKUP_BATCH = 100;

/**
 * How long to wait for the gateway to answer member lookups, ALL the batches of one
 * check together. discord.js waits two minutes per request by default, which in the
 * guild queue is an outage. Past this the answer is "unknown", and unknown members
 * are written rather than dropped.
 */
const MEMBER_LOOKUP_TIMEOUT_MS = 3000;

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
    // Renaming the shell would target `___hidden___` and could never succeed.
    if (isObfuscated(channel)) throw new ChannelObfuscatedError(channelId);

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

  async moveMember(
    guildId: string,
    memberId: string,
    channelId: string | null,
    options?: MoveMemberOptions,
  ): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(memberId);
      // Read AFTER the fetch above, not before it: the gateway keeps the voice state
      // current, so this is as fresh as anything we can know without moving them.
      // The caller's own read can be seconds old, and a disconnect takes the member
      // out of whichever channel they are in now.
      if (options?.onlyFrom !== undefined && member.voice.channelId !== options.onlyFrom) return;
      await member.voice.setChannel(channelId);
    } catch (err) {
      // 40032: they left voice between the check and the move. Nothing to undo.
      if (
        isApiError(err, UNKNOWN_MEMBER) ||
        isApiError(err, UNKNOWN_CHANNEL) ||
        isApiError(err, NOT_IN_VOICE)
      ) {
        return;
      }
      throw err;
    }
  }

  async setUserLimit(_guildId: string, channelId: string, limit: number): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isVoiceBased()) return;
      if (isObfuscated(channel)) throw new ChannelObfuscatedError(channelId);
      await channel.setUserLimit(limit);
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      throw err;
    }
  }

  async setPrivacy(_guildId: string, channelId: string, isPrivate: boolean): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isVoiceBased()) return;
      // The overwrite cache of an obfuscated channel is a single `@everyone`
      // View deny, and `edit` merges onto the cache before it PUTs.
      if (isObfuscated(channel)) throw new ChannelObfuscatedError(channelId);
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
      if (isObfuscated(channel)) throw new ChannelObfuscatedError(channelId);
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
   * A room's overwrites as Discord holds them now.
   *
   * Fetched with `force`, because the overwrite cache can lag a CHANNEL_UPDATE by
   * long enough to plan against a set that has since changed, and a plan written
   * back from a stale read reverts whatever somebody did in between. discord.js
   * patches the cached channel in place from that response, so the cache read below
   * is the fresh one.
   *
   * Null only for a channel Discord says is gone (10003). A fetch that succeeds but
   * yields no channel means the channel EXISTS and this process does not hold its
   * guild, which is not the same thing and is not answered as if it were: a caller
   * that drops a room's record on "gone" would drop a live room's.
   */
  async readOverwrites(guildId: string, channelId: string): Promise<ResolvedOverwrite[] | null> {
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId, { force: true });
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return null;
      throw err;
    }
    if (!channel) throw new Error(`channel ${channelId} exists but its guild is not held here`);
    if (!channel.isVoiceBased()) return null;
    if (channel.guildId !== guildId) throw new Error(`channel ${channelId} is not in ${guildId}`);
    // The shell holds a single `@everyone` View deny and nothing else. Planning
    // against it would produce a "complete" set that is a falsehood.
    if (isObfuscated(channel)) throw new ChannelObfuscatedError(channelId);
    return mapOverwrites(channel.permissionOverwrites.cache);
  }

  /**
   * Makes a room's overwrites `desired`.
   *
   * **One or two changes are one request each. More than that is ONE bulk request.**
   * Overwrite writes are 10 per 10 seconds per channel and a hide touches the owner,
   * every occupant, the trusted list, a role or two and `@everyone`, which written
   * one by one is a 429. A bulk `PATCH` with the full `permission_overwrites` array
   * cost one token whatever it carried (measured 2026-10-03) and is atomic, so it
   * cannot leave a half-applied set. `previous` is what the plan was made against:
   * the bulk set is built from it, so the caller reads it fresh
   * ({@link readOverwrites}) immediately before planning.
   *
   * A single change is written with the exact allow and deny the plan computed, not
   * through discord.js's `edit`, which merges onto the CACHED overwrite and would
   * write a stale cache back.
   *
   * **A bulk write Discord rejects is retried one overwrite at a time.** A bulk set
   * resends every overwrite on the channel, the ones nobody changed included, and
   * what Discord checks in those is UNVERIFIED: an overwrite for a member who has
   * since left, or one carrying a bit the bot does not hold (a human's), may be
   * refused where changing nothing about it would not be. Writing only what differs
   * checks only that. It gives up the all-or-nothing of one request, which is what
   * the access record written before this call and the converge pass are for.
   *
   * **Members who are not in the server are left out.** What Discord does with an
   * overwrite for a user id that has left is UNVERIFIED too, and a list is exactly
   * where such an id comes from (a saved block outlives the member's membership). So
   * the members this write would add or change are checked first, and a write that
   * still answers Unknown Member, Unknown User or Invalid Form Body is checked again
   * and retried once without whoever Discord confirms is gone. The result names
   * them, so they are never recorded as having an overwrite, and an overwrite one of
   * them already had is left as it was. The bot's own overwrite is never dropped.
   *
   * Refuses a set that does not give the bot its own access: the planner always
   * does, and this is the last place that can stop a write that would shut the bot
   * out of the room it manages.
   */
  async applyOverwrites(
    guildId: string,
    channelId: string,
    desired: readonly ResolvedOverwrite[],
    previous: readonly ResolvedOverwrite[],
  ): Promise<ApplyOverwritesResult> {
    const gone: ApplyOverwritesResult = {
      written: [],
      droppedMemberIds: [],
      requests: 0,
      deferred: false,
      channelGone: true,
    };
    const botId = this.client.user?.id;
    if (botId) {
      const mine = desired.find((o) => o.type === OVERWRITE_MEMBER && o.id === botId);
      if (!mine || (mine.allow & BOT_ACCESS) !== BOT_ACCESS) {
        throw new Error(`refusing to write overwrites that leave the bot out of ${channelId}`);
      }
    }
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return gone;
      throw err;
    }
    // Which is not "gone": see `readOverwrites`.
    if (!channel) throw new Error(`channel ${channelId} exists but its guild is not held here`);
    // Not a voice channel any more is not one of ours to write to either.
    if (!channel.isVoiceBased()) return gone;
    // The only bulk replace here: a channel of another guild is not ours to replace.
    if (channel.guildId !== guildId) throw new Error(`channel ${channelId} is not in ${guildId}`);
    // Sending `desired` back to the shell would replace the real set with a lie.
    if (isObfuscated(channel)) throw new ChannelObfuscatedError(channelId);

    const who = { guildId: channel.guild.id, ...(botId ? { botId } : {}) };
    const changedMembers = diffOverwrites(previous, desired, who)
      .upserts.filter((o) => o.type === OVERWRITE_MEMBER && o.id !== botId)
      .map((o) => o.id);
    const absent = await this.absentMembers(channel.guild, changedMembers, true);
    if (absent.size > 0) {
      this.logger?.info(
        { guildId, channelId, dropped: absent.size, checked: changedMembers.length },
        'leaving out overwrites for members no longer in the server',
      );
    }
    const state = {
      wanted: leaveOutMembers(desired, previous, absent),
      dropped: [...absent],
      requests: 0,
      sentBulk: false,
    };

    // As `setVoiceStatus`: the write is raced against a short probe so a 429 cannot
    // hold the guild's queue, and a failure after the probe has won is logged here
    // because nothing else is left listening.
    const write = this.writeOverwrites(channel, previous, state, who);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = new Promise<{ kind: 'pending' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'pending' }), OVERWRITE_PROBE_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([
      write.then(
        () => ({ kind: 'done' as const }),
        (err: unknown) => ({ kind: 'failed' as const, err }),
      ),
      probe,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    if (outcome.kind === 'failed') {
      if (isApiError(outcome.err, UNKNOWN_CHANNEL)) return gone;
      // The channel came from the cache, so this write is the first call that
      // reached Discord, and a 50001 may mean "deleted" as easily as "hidden".
      if (isPermissionError(outcome.err) && (await this.confirmChannelGone(channelId))) return gone;
      throw withoutRequestBody(outcome.err);
    }
    if (outcome.kind === 'pending') {
      void write.catch((err: unknown) => {
        if (!isApiError(err, UNKNOWN_CHANNEL)) {
          this.logger?.warn(
            { err: withoutRequestBody(err), guildId, channelId },
            'deferred overwrite write failed',
          );
        }
      });
      this.logger?.debug({ guildId, channelId }, 'overwrite write deferred, queue continuing');
    }
    return {
      written: [...state.wanted],
      droppedMemberIds: [...state.dropped],
      requests: state.requests,
      deferred: outcome.kind === 'pending',
      channelGone: false,
    };
  }

  /**
   * Writes `state.wanted`, falling back to one overwrite at a time when a bulk write
   * is refused, and retrying once without members Discord says are not in the server.
   * Each of the two happens at most once.
   */
  private async writeOverwrites(
    channel: VoiceBasedChannel,
    previous: readonly ResolvedOverwrite[],
    state: { wanted: ResolvedOverwrite[]; dropped: string[]; requests: number; sentBulk: boolean },
    who: { guildId: string; botId?: string },
  ): Promise<void> {
    let bulk = true;
    let looked = false;
    for (;;) {
      try {
        await this.writeChanges(channel, previous, state, who, bulk);
        return;
      } catch (err) {
        if (!isClientRejection(err)) throw err;
        if (state.sentBulk) {
          state.sentBulk = false;
          bulk = false;
          this.logger?.debug(
            {
              guildId: channel.guildId,
              channelId: channel.id,
              code: (err as DiscordAPIError).code,
            },
            'bulk overwrite write refused, writing one overwrite at a time',
          );
          continue;
        }
        const memberGone = isApiError(err, UNKNOWN_MEMBER) || isApiError(err, UNKNOWN_USER);
        if (looked || !(memberGone || isApiError(err, INVALID_FORM_BODY))) throw err;
        looked = true;
        // The error does not say whose id it was. Only the members this write adds or
        // changes can have been what it refused, so only they are asked about, and
        // against Discord and not the cache that vouched for them. An Invalid Form
        // Body is less specific, so it takes the cache's word for the members it holds.
        const changed = diffOverwrites(previous, state.wanted, who)
          .upserts.filter((o) => o.type === OVERWRITE_MEMBER && o.id !== who.botId)
          .map((o) => o.id);
        const missing = await this.absentMembers(channel.guild, changed, !memberGone);
        // Nobody missing means this was something else.
        if (missing.size === 0) throw err;
        this.logger?.warn(
          { guildId: channel.guildId, channelId: channel.id, dropped: missing.size },
          'leaving out overwrites for members no longer in the server',
        );
        state.dropped.push(...missing);
        state.wanted = leaveOutMembers(state.wanted, previous, missing);
      }
    }
  }

  private async writeChanges(
    channel: VoiceBasedChannel,
    previous: readonly ResolvedOverwrite[],
    state: { wanted: ResolvedOverwrite[]; requests: number; sentBulk: boolean },
    who: { guildId: string; botId?: string },
    bulk: boolean,
  ): Promise<void> {
    const diff = diffOverwrites(previous, state.wanted, who);
    const changes = diff.upserts.length + diff.deletes.length;
    if (changes === 0) return;
    if (bulk && changes > SINGLE_WRITE_MAX) {
      state.requests += 1;
      state.sentBulk = true;
      await channel.permissionOverwrites.set(state.wanted);
      return;
    }
    // The diff already puts the bot first, so a deny that would lock it out cannot
    // land before the allow that keeps it in.
    for (const o of diff.upserts) {
      state.requests += 1;
      await this.client.rest.put(`/channels/${channel.id}/permissions/${o.id}`, {
        body: { id: o.id, type: o.type, allow: o.allow.toString(), deny: o.deny.toString() },
      });
    }
    for (const d of diff.deletes) {
      state.requests += 1;
      await this.client.rest
        .delete(`/channels/${channel.id}/permissions/${d.id}`)
        .catch((err: unknown) => {
          // Already gone is what a delete is for.
          if (isApiError(err, UNKNOWN_OVERWRITE) || isApiError(err, UNKNOWN_MEMBER)) return;
          throw err;
        });
    }
  }

  /**
   * Which of these members Discord does not have in the server.
   *
   * The guild's member cache is trusted for a member it holds (nothing removes one
   * but a leave) and not for one it does not, because Discord only pushes an
   * initial slice of a large guild's members on connect. One gateway request per
   * hundred ids covers the rest, all of them inside ONE deadline: a gateway that
   * answers nothing costs the caller three seconds, not three per hundred. A lookup
   * that fails or runs out of time reports nobody missing: dropping a member on a
   * gateway hiccup would be a silent block that is not applied, and a write that
   * really does name someone who has left is caught by its own error in
   * {@link writeOverwrites}.
   */
  private async absentMembers(
    guild: Guild,
    ids: readonly string[],
    trustCache: boolean,
  ): Promise<Set<string>> {
    const absent = new Set<string>();
    const unique = [...new Set(ids)];
    const toAsk = trustCache ? unique.filter((id) => !guild.members.cache.has(id)) : unique;
    const deadline = Date.now() + MEMBER_LOOKUP_TIMEOUT_MS;
    for (let i = 0; i < toAsk.length; i += MEMBER_LOOKUP_BATCH) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const batch = toAsk.slice(i, i + MEMBER_LOOKUP_BATCH);
      try {
        const found = await guild.members.fetch({ user: batch, time: remaining });
        for (const id of batch) if (!found.has(id)) absent.add(id);
      } catch (err) {
        // The message and nothing else: a rate limit error carries the ids it asked about.
        this.logger?.debug(
          { guildId: guild.id, reason: err instanceof Error ? err.message : 'unknown' },
          'member lookup failed, writing without it',
        );
      }
    }
    return absent;
  }

  /** Whether the moderator role still exists. See {@link VoiceActions.roleExists}. */
  async roleExists(guildId: string, roleId: string): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    return this.resolveViewerRole(guild, roleId).roleId !== null;
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

  /**
   * Sets (or with `''` clears) a voice channel's status.
   *
   * discord.js has no helper for this endpoint yet, so it calls the raw route —
   * and, like {@link renameChannel}, it refuses to wait indefinitely for it. The
   * caller is a queued per-guild task, so time spent here is time no other event
   * for that guild is handled; a write that has not landed inside
   * {@link STATUS_PROBE_MS} is left to finish in the background, where its
   * failure is still logged.
   *
   * A deferred write that Discord eventually accepts converges, because every
   * re-render writes the current value rather than a delta. One that ultimately
   * FAILS does not: `rerenderSecondary` persists the new status regardless of
   * the outcome, so the next render sees no change and never retries. That is
   * pre-existing and is the reason this logs rather than passing quietly.
   */
  async setVoiceStatus(guildId: string, channelId: string, status: string): Promise<void> {
    const apply = this.client.rest.put(`/channels/${channelId}/voice-status`, {
      body: { status },
    });
    /**
     * Handled here rather than on the losing branch, because after the race
     * this method has returned and nothing else is listening.
     *
     * Not for unhandled-rejection safety: `Promise.race` subscribes to every
     * element, so a late rejection is marked handled either way. This is the
     * only thing that will REPORT the failure once the write has been deferred.
     */
    const settled = apply.then(
      () => 'done' as const,
      (err: unknown) => {
        if (isApiError(err, UNKNOWN_CHANNEL)) return 'gone' as const;
        // The guild id was already a parameter and simply went unlogged, which
        // left the most common cause of this warning (a guild that has not
        // granted the permission) with nothing to identify the guild by.
        this.logger?.warn({ err, guildId, channelId }, 'failed to set voice channel status');
        return 'failed' as const;
      },
    );
    /**
     * Unref'd and cleared, unlike `renameChannel`'s probe.
     *
     * This runs on every presence change that moves a managed name, so a ref'd
     * 2.5s timer left behind by every write that lands in 40ms is the same
     * carelessness the queue's own timer takes care to avoid.
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), STATUS_PROBE_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([settled, probe]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (outcome === 'pending') {
      // Debug, not warn: a deferred status write is the guard working, and on a
      // throttled endpoint it would otherwise be a warning per re-render.
      this.logger?.debug({ guildId, channelId }, 'voice status write deferred, queue continuing');
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

  /**
   * The configured moderator role, but only when it still exists here.
   *
   * Discord accepts a channel create whose `permission_overwrites` names a role
   * the guild does not have and silently drops that entry, while the equivalent
   * `PUT .../permissions/{id}` answers `10009 Unknown Overwrite`. A role deleted
   * since it was configured therefore produced a create that looked fine and a
   * sync that failed every five minutes forever. Found in production on
   * 2026-09-18: an `stct` value restored from the legacy archive naming a role
   * the guild had deleted years earlier.
   *
   * Resolved from the local role cache, which GUILD_CREATE populates, so it
   * costs no request. The `size > 0` guard is the cold-cache case: an empty
   * cache means "we do not know yet", not "the role is gone", and must never be
   * read as grounds to stop granting a perfectly good role.
   */
  private resolveViewerRole(
    guild: Guild,
    roleId: string | null | undefined,
  ): { roleId: string | null; missing: boolean } {
    /**
     * Compared against the guild id, not `roles.everyone.id`: `@everyone`'s id IS the
     * guild id, and `RoleManager#everyone` is itself `cache.get(guild.id)`, so reading it
     * here would throw on exactly the unhydrated guild the size guard below
     * exists to tolerate -- making that guard unreachable and turning "we do not
     * know yet" into a create that fails outright.
     */
    if (!roleId || roleId === guild.id) return { roleId: null, missing: false };
    /**
     * Absent evidence is not evidence of absence, and this is the direction
     * that matters: judging a live role missing silently withholds a permission
     * the admin asked for, with no error anywhere. An empty cache means "not
     * loaded", so only a populated cache that does not list the role counts.
     */
    const cache = guild.roles?.cache;
    if (!cache || typeof cache.has !== 'function' || !(cache.size > 0)) {
      return { roleId, missing: false };
    }
    return cache.has(roleId) ? { roleId, missing: false } : { roleId: null, missing: true };
  }

  /**
   * Creates a room's private companion text channel.
   *
   * `@everyone` is denied View Channel in the create payload itself, so there is
   * no window in which the channel exists and is readable by the server. The
   * bot's own allow goes in the same payload for the reason `setPrivacy`
   * documents: denying `@everyone` also denies the bot, which is a member of it.
   *
   * The topic names the room, which is what makes an orphan identifiable by a
   * human later. It is NOT a recovery index: the row is, and nothing here
   * deletes a channel on a topic match, which is the legacy defect that forced
   * its help text to tell admins not to edit the topic.
   */
  async createCompanionChannel(
    input: CreateCompanionChannelInput,
  ): Promise<CreateCompanionChannelResult> {
    const guild = await this.client.guilds.fetch(input.guildId);
    const viewerRole = this.resolveViewerRole(guild, input.roleId);
    const room = await this.client.channels.fetch(input.secondaryChannelId).catch(() => null);
    const parentId = room?.isVoiceBased() ? room.parent?.id : undefined;
    const botId = this.client.user?.id;

    const overwrites = [
      { id: guild.roles.everyone.id, deny: PermissionFlagsBits.ViewChannel },
      ...(botId
        ? [
            {
              id: botId,
              type: OverwriteType.Member,
              allow:
                PermissionFlagsBits.ViewChannel |
                PermissionFlagsBits.ManageChannels |
                PermissionFlagsBits.SendMessages,
            },
          ]
        : []),
      // Never `@everyone`, whose id is the guild id: granting it View here would
      // undo the deny above and publish the chat to the whole server. Refused at
      // three levels, this being the one that writes.
      ...(viewerRole.roleId
        ? [
            {
              id: viewerRole.roleId,
              type: OverwriteType.Role,
              allow: PermissionFlagsBits.ViewChannel,
            },
          ]
        : []),
      ...input.memberIds.map((id) => ({
        id,
        type: OverwriteType.Member,
        allow: PermissionFlagsBits.ViewChannel,
      })),
    ];

    const channel = await guild.channels.create({
      name: input.name,
      type: ChannelType.GuildText,
      ...(parentId ? { parent: parentId } : {}),
      topic: `Chat for <#${input.secondaryChannelId}>. Visible to whoever is in that room right now.`,
      permissionOverwrites: overwrites,
    });
    return {
      channelId: channel.id,
      grantedRoleId: viewerRole.roleId,
      roleMissing: viewerRole.missing,
    };
  }

  /**
   * Converges a companion's viewers on `memberIds` (plus the moderator role).
   *
   * Reads the CURRENT set from the channel's own overwrite cache, which discord.js
   * already holds, so a steady-state call with nothing to do costs zero requests
   * and a join costs exactly one. Never touches the `@everyone` deny, the bot's
   * own allow, or any overwrite a human added: only member overwrites this bot
   * granted View Channel to are candidates for removal.
   */
  async syncCompanionMembers(input: SyncCompanionMembersInput): Promise<CompanionSyncResult> {
    const channel = await this.client.channels.fetch(input.channelId).catch((err: unknown) => {
      if (isApiError(err, UNKNOWN_CHANNEL)) return null;
      throw err;
    });
    if (!channel) return { added: 0, removed: 0, channelGone: true };
    /**
     * Announcement channels count.
     *
     * One right-click converts a text channel to one, and treating that as
     * "not ours" froze the ACL silently: departed members kept read access for
     * the life of the channel, and the teardown reported success while
     * leaking it. Anything else really is not ours and is left alone.
     */
    if (!('permissionOverwrites' in channel) || !isCompanionType(channel.type)) {
      return { added: 0, removed: 0, channelGone: false };
    }

    const botId = this.client.user?.id;
    const guildId = channel.guildId;
    const desired = new Set(input.memberIds);
    /**
     * `@everyone` is never a viewer, whatever the setting says.
     *
     * The role id equals the guild id, and granting it View would undo the deny
     * in the same channel and publish every room's chat to the server. The
     * settings validator and the settings service both refuse it; this is the
     * last of the three guards, at the only place that actually writes.
     */
    const everyoneId = channel.guild.roles.everyone.id;
    const viewerRole = this.resolveViewerRole(channel.guild, input.roleId);
    const roleId = viewerRole.roleId;

    /**
     * What this bot granted a MEMBER, so occupants converge.
     *
     * The test is the exact overwrite this code writes: `ViewChannel` allowed
     * and nothing else, denying nothing. A human who granted somebody a
     * different set (View plus Manage Messages, say) is left alone, which is
     * the closest thing to "did we write this" available for a member, and it
     * is a safe heuristic here only because the bot writes one per occupant.
     *
     * **Roles are NOT inferred this way.** The bot writes at most one role
     * overwrite, so every other one is somebody's deliberate grant and the same
     * heuristic would revoke a moderator's decision every five minutes. The
     * caller passes `previousRoleId`, read from the row this bot wrote, so the
     * revoke names exactly what the grant named.
     */
    const ours = (allow: bigint, deny: bigint): boolean =>
      allow === PermissionFlagsBits.ViewChannel && deny === 0n;
    const currentMembers = new Set<string>();
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.id === botId || overwrite.id === everyoneId) continue;
      if (overwrite.type !== OverwriteType.Member) continue;
      if (!ours(overwrite.allow.bitfield, overwrite.deny.bitfield)) continue;
      currentMembers.add(overwrite.id);
    }

    let added = 0;
    let removed = 0;
    try {
      /**
       * The `@everyone` deny is re-asserted, not assumed.
       *
       * It is written once in the create payload, and one click of "Sync
       * permissions with category" on the companion, or any admin clearing the
       * overwrite, would publish every message in that room's chat to the whole
       * server while `/channelinfo` kept telling members only the room can read
       * it. Costs nothing in the steady state: the overwrite is already there
       * and this writes only when it is not.
       */
      const everyone = channel.permissionOverwrites.cache.get(everyoneId);
      if (!everyone || (everyone.deny.bitfield & PermissionFlagsBits.ViewChannel) === 0n) {
        await channel.permissionOverwrites.edit(
          everyoneId,
          { ViewChannel: false },
          { type: OverwriteType.Role },
        );
      }
      for (const memberId of desired) {
        if (currentMembers.has(memberId)) continue;
        await channel.permissionOverwrites.edit(
          memberId,
          { ViewChannel: true },
          { type: OverwriteType.Member },
        );
        added += 1;
      }
      for (const memberId of currentMembers) {
        if (desired.has(memberId)) continue;
        await channel.permissionOverwrites.delete(memberId).catch((err: unknown) => {
          if (isApiError(err, UNKNOWN_MEMBER)) return;
          throw err;
        });
        removed += 1;
      }
      /**
       * The moderator role converges in BOTH directions, and is reported back
       * so the caller can record what is now granted.
       *
       * Adding only was the first version and it was a privacy defect with a
       * false confirmation on top: clearing the setting told the admin nobody
       * outside the room could read it while every live companion still had the
       * old role on it, and changing the role added the new one and kept the old.
       *
       * Its own try/catch, separate from the member loops above, because a role
       * that has since been DELETED from the guild makes the grant throw, and a
       * throw here would skip the revoke directly below it and strand the old
       * role's overwrite with nothing able to remove it.
       */
      const stale = input.previousRoleId;
      if (stale && stale !== roleId && stale !== everyoneId) {
        await channel.permissionOverwrites.delete(stale).catch(() => undefined);
        removed += 1;
      }
      if (viewerRole.missing) {
        /**
         * Nothing to attempt: the role is gone, so the PUT could only ever
         * answer 10009, and a warning every five minutes is what that used to
         * look like. The caller reports it once instead, through the same
         * backed-off channel as any other permission problem.
         */
        return { added, removed, channelGone: false, grantedRoleId: null, roleMissing: true };
      }
      if (roleId) {
        const existing = channel.permissionOverwrites.cache.get(roleId);
        if (!existing || (existing.allow.bitfield & PermissionFlagsBits.ViewChannel) === 0n) {
          try {
            await channel.permissionOverwrites.edit(
              roleId,
              { ViewChannel: true },
              { type: OverwriteType.Role },
            );
            added += 1;
          } catch (err) {
            this.logger?.warn(
              { err, guildId, channelId: input.channelId, roleId },
              'could not grant the companion moderator role',
            );
            return { added, removed, channelGone: false, grantedRoleId: null };
          }
        }
      }
      return { added, removed, channelGone: false, grantedRoleId: roleId };
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL))
        return { added, removed, channelGone: true, grantedRoleId: input.previousRoleId ?? null };
      this.logger?.warn(
        { err, guildId, channelId: input.channelId, added, removed },
        'companion member sync incomplete',
      );
      throw err;
    }
  }

  /** Deletes a companion text channel, tolerating it already being gone. */
  async deleteCompanionChannel(_guildId: string, channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && isCompanionType(channel.type)) await channel.delete();
    } catch (err) {
      if (isApiError(err, UNKNOWN_CHANNEL)) return;
      throw err;
    }
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

  /**
   * A room owner's roles and whether they can manage channels, from the cache.
   *
   * The roles are the member's own, without `@everyone` (whose id is the guild
   * id and is in every member's `roles.cache`). `canManage` is judged against the
   * ROOM, so a member who has Manage Channels through the category or a room
   * overwrite counts, as they do for the guard, which reads the interaction's own
   * channel-level permissions. It cannot match the guard exactly: a companion
   * text panel is clicked in a different channel from the room, and that
   * channel's overwrites are the ones the guard sees. The click-time guard is the
   * authority, this only decides which buttons are drawn. Cache only, and
   * `undefined` when the room or the member is not in it, which the panel reads
   * as "cannot say" and hides nothing for.
   */
  ownerAccessOf(channelId: string, ownerId: string): CommandCaller | undefined {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !('guild' in channel)) return undefined;
    const guild = channel.guild;
    const member = guild.members.cache.get(ownerId);
    if (!member) return undefined;
    return {
      userId: ownerId,
      roleIds: [...member.roles.cache.keys()].filter((id) => id !== guild.id),
      canManage: managesChannels(member, channel),
    };
  }

  /**
   * Whether a member is a bot, an Administrator or the server's owner, from the
   * member cache. `undefined` for a member who is not in it, which is "cannot
   * say" and not "ordinary".
   *
   * The two that matter bypass every channel overwrite, so a deny written for one
   * does nothing and moving them out of a room is wrong, not merely useless.
   */
  memberFacts(guildId: string, memberId: string): MemberFacts | undefined {
    const guild = this.client.guilds.cache.get(guildId);
    const member = guild?.members.cache.get(memberId);
    if (!guild || !member) return undefined;
    return {
      bot: member.user.bot,
      administrator: member.permissions.has(PermissionFlagsBits.Administrator),
      guildOwner: guild.ownerId === memberId,
    };
  }

  /**
   * Which of `roleIds` sit at or above the bot's own top role, and the bot's own
   * managed role, from the guild's role cache.
   *
   * The comparison is Discord's hierarchy for editing a role, which is ASSUMED to
   * hold for a role's overwrite on a channel too: not verified against Discord
   * (see `uneditableRoleIds` in `accessPlan.ts`). The bot's own managed role is
   * never reported as uneditable, however high it sits: it is the role the bot
   * itself relies on and the planner leaves its overwrite alone.
   */
  botRoleAccess(guildId: string, roleIds: readonly string[]): BotRoleAccess | undefined {
    const guild = this.client.guilds.cache.get(guildId);
    const me = guild?.members.me;
    if (!guild || !me) return undefined;
    const botRoleId = me.roles.botRole?.id ?? null;
    const top = me.roles.highest;
    return {
      leaveRoleId: botRoleId,
      uneditableRoleIds: roleIds.filter((id) => {
        if (id === botRoleId || id === guild.id) return false;
        const role = guild.roles.cache.get(id);
        return role !== undefined && role.comparePositionTo(top) >= 0;
      }),
    };
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
