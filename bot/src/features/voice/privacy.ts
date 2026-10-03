import type {
  JoinChannelRepository,
  JoinChannelRow,
  Logger,
  MemberAccessListRepository,
  RoomAccess,
  SecondaryChannelRepository,
  SecondaryChannelRow,
} from '@avc/core';
import type { ApplyOverwritesResult, VoiceActions } from './actions.js';
import type { CommandResult } from './commands.js';
import type { GuildVoiceView, VoiceMember } from './types.js';
import { describeError } from '../../ops/describeError.js';
import {
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  joinChannelOverwrites,
  planAccess,
  type AccessFacts,
  type AccessMode,
  type AccessPlan,
  type AccessPlanInput,
  type ResolvedOverwrite,
} from './accessPlan.js';
import { recordWithFacts, sameFacts, withMember } from './accessRecord.js';
import { ChannelObfuscatedError, isPermissionError } from './discordAdapter.js';
import { permissionProblemMessage, type PermissionProblemTracker } from './permissionProblems.js';
import {
  ROOM_ACCESS_REPLIES as say,
  TOO_MANY_OVERWRITES,
  accessFailed,
  admitBlocked,
  admitFailed,
  admitKicked,
  admitted,
  hiddenMessage,
  lockedWithoutJoin,
  roleDefeatsHide,
  unhiddenMessage,
  unhiddenWithoutJoin,
  withSkipped,
} from './roomAccessCopy.js';
import { roomMode } from './roomMode.js';

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
  /**
   * The bot's own user id, which every plan names (it is never blocked and is always
   * allowed). A function because the client only knows it once it has logged in.
   * Absent or `undefined` means a change to a room's access is refused with "try
   * again", never attempted without it.
   */
  botUserId?: () => string | undefined;
  /**
   * The owners' saved trusted and blocked lists. Optional so a construction that
   * predates them keeps working: without it a room's lists are not applied, and the
   * entries already recorded on it are left alone and not revoked.
   */
  memberAccessLists?: MemberAccessListRepository | undefined;
  /**
   * The guild's moderator role (`text_channel_role`, which companion text also
   * uses), or null for none. It is granted View, never Connect, on a hidden room.
   */
  moderatorRoleId?: (guildId: string) => Promise<string | null>;
  /**
   * A member's name as the rest of the product shows it, `/nick` included. Absent
   * falls back to the raw display name.
   */
  ownerName?: (guildId: string, member: VoiceMember) => Promise<string>;
  /** Where an access change the bot lacks the permission for is recorded. */
  permissionProblems?: PermissionProblemTracker;
  serverLog?: (guildId: string, level: 1 | 2 | 3, message: string) => void;
}

/** A room as a command finds it, or the reply that says it cannot be acted on. */
type Opened =
  | { kind: 'open'; row: SecondaryChannelRow; access: RoomAccess | null; mode: AccessMode }
  | { kind: 'refused'; result: CommandResult };

type OkPlan = Extract<AccessPlan, { ok: true }>;

/**
 * How a change to a room's access ended. Every path that returns one has already
 * contained its own errors: nothing here throws.
 */
export type AccessOutcome =
  | {
      /** `unchanged`: the room already was as asked, so nothing was written. */
      status: 'applied' | 'unchanged' | 'deferred';
      plan: OkPlan;
      /** The moderator role that can see the room as a result, or null. */
      viewerRoleId: string | null;
      /** Blocked members who were in the room and were asked to leave it. */
      movedOut: string[];
      /** Set when the room is right but its "⇩ Join" channel could not be made. */
      joinError?: unknown;
    }
  | { status: 'refused'; reason: 'role_defeats_hide'; defeatedBy: string[] }
  | { status: 'refused'; reason: 'too_many_overwrites' }
  | { status: 'not_ready' | 'gone' | 'missing' | 'unreadable' }
  | { status: 'failed'; error: unknown };

/** What {@link PrivacyService.applyAccessLists} did, for a caller that is not a command. */
export interface AccessApplyResult {
  /**
   * `applied` or `unchanged` means the room holds what the lists say. `deferred`
   * means Discord queued the write and it has not landed. `skipped` means nothing was
   * decided (see `reason`), and `failed` that something went wrong (see `error`).
   */
  status: 'applied' | 'unchanged' | 'deferred' | 'skipped' | 'failed';
  reason?: 'no_lists' | 'no_room' | 'unreadable' | 'not_ready' | 'gone' | 'refused';
  /** Blocked members who were in the room and were asked to leave it. */
  movedOut: string[];
  /** Roles the plan could not edit and left as they were. */
  skippedRoleIds: string[];
  error?: unknown;
}

/** What {@link PrivacyService.tryMakePrivateForCreation} did. */
export type PrivateCreation =
  | { ok: true; applied: boolean; deferred?: boolean }
  | {
      ok: false;
      reason: 'unreadable' | 'not_ready' | 'refused' | 'gone' | 'failed';
      /** What was thrown, when something was: a caller that rolls back checks it for a permission error. */
      error?: unknown;
    };

/** A room's creator's saved lists, as they apply to it. */
interface RoomLists {
  creatorId: string | null;
  trusted: string[];
  blocked: string[];
}

/** One change to a room's access: from the mode it is in to the mode it should be in. */
interface ChangeInput {
  guildId: string;
  row: SecondaryChannelRow;
  /** The room's record as the caller read it, which the plan is made against. */
  record: RoomAccess | null;
  from: AccessMode;
  /** The same as `from` to converge a room on its own lists, or to apply one admit or kick. */
  to: AccessMode;
  /** Who the plan treats as the owner: the room's, or the creator by id on a create. */
  ownerId: string | null;
  /** The creator's lists, when the caller has already read them. */
  lists?: RoomLists;
  /** The "⇩ Join" channel's name, asked only when one has to be made. */
  joinName: () => Promise<string>;
}

/** The facts, less members Discord does not have in the server, unless they were already recorded. */
function recordableFacts(
  facts: AccessFacts,
  dropped: readonly string[],
  stored: RoomAccess | null,
): AccessFacts {
  if (dropped.length === 0) return facts;
  const gone = new Set(dropped);
  const keep = (ids: string[], was: string[] | undefined): string[] =>
    ids.filter((id) => !gone.has(id) || (was ?? []).includes(id));
  return {
    ...facts,
    trusted: keep(facts.trusted, stored?.trusted),
    admitted: keep(facts.admitted, stored?.admitted),
    blocked: keep(facts.blocked, stored?.blocked),
  };
}

/**
 * The full private-channel + "⇩ Join {owner}" mechanism, ported from the
 * legacy `private`/`public` commands and join-request handling, and the modes
 * built on it: a room is public, locked, or hidden from the channel list.
 *
 * `/private` locks the channel to @everyone (keeping current members), then
 * spawns an open "⇩ Join {owner}" companion channel. Joining that channel
 * raises a request to the owner (the discord glue posts the buttons); the owner
 * approves (grant Connect + pull them in), denies (disconnect), or blocks (deny
 * Connect on the join channel, and save the block). `/public` reverses everything
 * and deletes the companion channel. `/hide` goes further: no companion, and the
 * room is gone from the channel list for everyone who has not been let in.
 *
 * **Every change to who may see or join a room is one transition, in four steps.**
 * Read what Discord holds NOW, plan the whole overwrite set (`accessPlan.ts`),
 * write the intent into the room's access record in ONE statement with `private`,
 * apply the set through the adapter, then finalise the record. A plan's record is
 * persisted before the write because a PUT is idempotent and a replay converges
 * only if the record already names everything the channel depends on, and what a
 * plan takes back stays named until the take-back has landed.
 *
 * Pure logic over the repositories + the action seam, so it's exercised with the
 * recording fakes.
 */
export class PrivacyService {
  constructor(private readonly deps: PrivacyServiceDeps) {}

  // -- the four commands --------------------------------------------------------

  /** Locks the channel and creates its "⇩ Join {owner}" companion. */
  async makePrivate(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    return this.guarded('private', guildId, channelId, async () => {
      const opened = await this.open(guildId, channelId, userId, say.notOwnerPrivate);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode } = opened;
      if (mode === 'hidden') return fail(say.privateOnHidden);
      if (mode === 'locked') return fail(say.alreadyPrivate);

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: access,
        from: mode,
        to: 'locked',
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      return this.report(guildId, row.channelId, 'private', outcome);
    });
  }

  /**
   * Applies the private treatment to a freshly-spawned secondary whose primary is
   * `defaultPrivate`. Unlike {@link makePrivate}, the owner's move into the new
   * channel may not have landed in the voice cache yet, so it grants the known
   * owner id directly rather than reading the roster. Idempotent: a no-op when the
   * secondary is gone or already private (or hidden).
   *
   * **Throws when it fails, which is the contract the create path's rollback reads**:
   * a room an admin's `defaultPrivate` could not lock down is deleted, because
   * nobody (not even the owner) could get into it. A caller that must not do that,
   * a REMEMBERED preference, calls {@link tryMakePrivateForCreation}, which says what
   * went wrong and throws nothing.
   */
  async makePrivateForCreation(
    guildId: string,
    channelId: string,
    ownerId: string,
    ownerName: string,
    mode: 'locked' | 'hidden' = 'locked',
  ): Promise<void> {
    const result = await this.tryMakePrivateForCreation(
      guildId,
      channelId,
      ownerId,
      ownerName,
      mode,
    );
    if (result.ok) return;
    throw (
      result.error ?? new Error(`could not make ${channelId} ${mode} on creation: ${result.reason}`)
    );
  }

  /**
   * {@link makePrivateForCreation} that answers instead of throwing.
   *
   * A hidden room writes the owner's View and Connect by id (their move is not
   * cached yet), the bot's allow and the `@everyone` deny, and creates no Join
   * channel: the same edge as `/hide` from a public room, planned the same way, with
   * the baseline captured from the channel as it was created.
   */
  async tryMakePrivateForCreation(
    guildId: string,
    channelId: string,
    ownerId: string,
    ownerName: string,
    mode: 'locked' | 'hidden' = 'locked',
  ): Promise<PrivateCreation> {
    try {
      const row = await this.deps.secondaries.get(channelId);
      if (!row || row.guildId !== guildId) return { ok: true, applied: false };
      const read = await this.deps.secondaries.readAccess(channelId);
      if (!read) return { ok: true, applied: false };
      if (!read.readable) return { ok: false, reason: 'unreadable' };
      if (roomMode({ state: row.state, access: read.access }) !== 'public') {
        return { ok: true, applied: false };
      }

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: read.access,
        from: 'public',
        to: mode,
        ownerId,
        joinName: () => Promise.resolve(`⇩ Join ${ownerName}`),
      });
      switch (outcome.status) {
        case 'applied':
        case 'deferred':
          if (outcome.joinError !== undefined) {
            return { ok: false, reason: 'failed', error: outcome.joinError };
          }
          this.deps.logger.info(
            { guildId, channelId, ownerId, mode },
            'secondary made private on creation',
          );
          return {
            ok: true,
            applied: true,
            ...(outcome.status === 'deferred' ? { deferred: true } : {}),
          };
        case 'unchanged':
        case 'missing':
          return { ok: true, applied: false };
        case 'refused':
          return { ok: false, reason: 'refused' };
        case 'failed':
          return { ok: false, reason: 'failed', error: outcome.error };
        default:
          return { ok: false, reason: outcome.status };
      }
    } catch (err) {
      return { ok: false, reason: 'failed', error: err };
    }
  }

  /** Reopens the channel and deletes its "⇩ Join" companion. */
  async makePublic(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    return this.guarded('public', guildId, channelId, async () => {
      const opened = await this.open(guildId, channelId, userId, say.notOwnerPublic);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode } = opened;
      if (mode === 'public') return fail(say.alreadyPublic);

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: access,
        from: mode,
        to: 'public',
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      return this.report(guildId, row.channelId, 'public', outcome);
    });
  }

  /** Hides the room from the channel list. Owner only, and a room with an owner. */
  async hide(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    return this.guarded('hide', guildId, channelId, async () => {
      const opened = await this.open(guildId, channelId, userId, say.notOwnerHide);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode } = opened;
      if (mode === 'hidden') return fail(say.alreadyHidden);

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: access,
        from: mode,
        to: 'hidden',
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      return this.report(guildId, row.channelId, 'hide', outcome);
    });
  }

  /** Shows a hidden room in the channel list again. It stays locked. */
  async unhide(
    guildId: string,
    channelId: string | undefined,
    userId: string,
  ): Promise<CommandResult> {
    return this.guarded('unhide', guildId, channelId, async () => {
      const opened = await this.open(guildId, channelId, userId, say.notOwnerUnhide);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode } = opened;
      if (mode !== 'hidden') return fail(say.notHidden);

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: access,
        from: mode,
        to: 'locked',
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      return this.report(guildId, row.channelId, 'unhide', outcome);
    });
  }

  /**
   * Lets one member into THIS room, and only this room: recorded in the room's access
   * record, applied as an overwrite, and gone with the room. Connect in a locked
   * room, View and Connect in a hidden one. An open room has nothing to admit
   * anyone to.
   *
   * A member the owner blocked, or a vote removed, is refused and not quietly left
   * out: a block beats an admission, so a "done" would be false.
   */
  async admit(
    guildId: string,
    channelId: string | undefined,
    ownerId: string,
    memberId: string,
  ): Promise<CommandResult> {
    return this.guarded('admit', guildId, channelId, async () => {
      const opened = await this.open(guildId, channelId, ownerId, say.notOwnerAdmit);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode } = opened;
      if (mode === 'public') return fail(say.openToEveryone);
      if (memberId === ownerId) return fail(say.admitSelf);
      if (memberId === this.deps.botUserId?.()) return fail(say.admitBot);
      if ((access?.kicked ?? []).includes(memberId)) return fail(admitKicked(memberId));
      const lists = await this.listsFor(guildId, row, access);
      if (lists.blocked.includes(memberId)) return fail(admitBlocked(memberId));

      // The intent first: an overwrite no record names is one nothing will take back.
      const written = await this.deps.secondaries.mutateAccess(row.channelId, (current) =>
        withMember(current, 'admitted', memberId),
      );
      if (written.status === 'missing') return fail(say.notManaged);
      if (written.status === 'unreadable') return fail(say.unreadable);

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: written.access,
        from: mode,
        to: mode,
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      switch (outcome.status) {
        case 'applied':
        case 'unchanged':
          return ok(admitted(memberId, mode));
        case 'failed':
          // The id stays recorded, which is the safe direction: the next apply for
          // this room writes it, and a replay of this command is a no-op.
          return fail(admitFailed(memberId, describeError(outcome.error)));
        default:
          return this.refusal(outcome);
      }
    });
  }

  // -- saved lists ----------------------------------------------------------------

  /**
   * Makes a room's overwrites say what its creator's saved lists say, for the room's
   * CURRENT mode: blocked members are denied in every mode, trusted ones are let in
   * only while the room is locked or hidden, and whoever was admitted to this room
   * stays admitted. Then asks blocked members who are in the room to leave it.
   *
   * **Never throws, and never fails the room.** It runs after a room exists and works,
   * from paths that must go on whatever happens here, so every outcome is a typed
   * result, a permission failure is recorded as an access problem for the guild to
   * see, and nothing counts against the breaker.
   *
   * The creator is `access.creatorId` (the room's original creator, not whoever owns
   * it now), and a room whose record names none falls back to the `original_creator`
   * column. It never grants or moves the room's current owner, and skips
   * Administrators and the server owner, whom no overwrite can stop.
   *
   * The block is persisted and the overwrite applied BEFORE anyone is moved: a move
   * that fails or finds nobody costs nothing, whereas a move ahead of the block lets
   * the member walk straight back in.
   *
   * Idempotent: a second run reads the channel as the first left it, plans no change
   * and writes nothing.
   */
  async applyAccessLists(guildId: string, roomChannelId: string): Promise<AccessApplyResult> {
    const skipped = (reason: NonNullable<AccessApplyResult['reason']>): AccessApplyResult => ({
      status: 'skipped',
      reason,
      movedOut: [],
      skippedRoleIds: [],
    });
    try {
      // Without the repository, "no entries" would read as "everything was removed".
      if (!this.deps.memberAccessLists) return skipped('no_lists');
      const row = await this.deps.secondaries.get(roomChannelId);
      if (!row || row.guildId !== guildId) return skipped('no_room');
      const read = await this.deps.secondaries.readAccess(roomChannelId);
      if (!read) return skipped('no_room');
      if (!read.readable) {
        this.deps.logger.warn(
          { guildId, channelId: roomChannelId },
          'a room has an access record this build cannot read; its lists were not applied',
        );
        return skipped('unreadable');
      }
      const mode = roomMode({ state: row.state, access: read.access });
      if (mode === 'unknown') return skipped('unreadable');

      // A public room that has never had an access record, made by somebody with
      // nothing saved: there is nothing for a list to change, and it costs no call to
      // Discord at all. Any other room is planned, which also repairs what an
      // interrupted change or a stale write left behind.
      const lists = await this.listsFor(guildId, row, read.access);
      if (
        mode === 'public' &&
        read.access === null &&
        lists.trusted.length === 0 &&
        lists.blocked.length === 0
      ) {
        return { status: 'unchanged', movedOut: [], skippedRoleIds: [] };
      }

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: read.access,
        from: mode,
        to: mode,
        ownerId: row.ownerId,
        lists,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      switch (outcome.status) {
        case 'applied':
        case 'unchanged':
          return {
            status: outcome.status,
            movedOut: outcome.movedOut,
            skippedRoleIds: outcome.plan.skippedRoleIds,
          };
        case 'deferred':
          return { status: 'deferred', movedOut: [], skippedRoleIds: outcome.plan.skippedRoleIds };
        case 'failed':
          return { status: 'failed', movedOut: [], skippedRoleIds: [], error: outcome.error };
        case 'refused':
          return skipped('refused');
        case 'missing':
          return skipped('no_room');
        default:
          return skipped(outcome.status);
      }
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, channelId: roomChannelId },
        'could not apply a room access list',
      );
      return { status: 'failed', movedOut: [], skippedRoleIds: [], error: err };
    }
  }

  /**
   * Records a member a vote removed from the room and denies them View and Connect
   * together, in every mode. Resolves to whether that is in effect (or queued behind
   * a rate limit): `false` means the caller still has to bar them some other way.
   *
   * Recorded in `kicked`, not in the owner's saved list: a vote belongs to the room,
   * so no list edit can lift it, a grant for a trusted member cannot replace it, and
   * it dies with the room. A room with no access record yet gets one holding only its
   * creator and this member. Never throws.
   */
  async denyKicked(guildId: string, channelId: string, targetId: string): Promise<boolean> {
    try {
      const row = await this.deps.secondaries.get(channelId);
      if (!row || row.guildId !== guildId) return false;
      const read = await this.deps.secondaries.readAccess(channelId);
      if (!read?.readable) return false;
      const written = await this.deps.secondaries.mutateAccess(channelId, (current) =>
        withMember(current, 'kicked', targetId),
      );
      if (written.status !== 'written') return false;
      const mode = roomMode({ state: row.state, access: written.access });
      if (mode === 'unknown') return false;

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: written.access,
        from: mode,
        to: mode,
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      return (
        outcome.status === 'applied' ||
        outcome.status === 'unchanged' ||
        outcome.status === 'deferred'
      );
    } catch (err) {
      this.deps.logger.warn({ err, guildId, channelId }, 'could not record a kick in the room');
      return false;
    }
  }

  // -- the "⇩ Join" knock -------------------------------------------------------

  /** The join-request context for a channel id, if it is a "⇩ Join" channel. */
  getJoinContext(channelId: string): Promise<JoinChannelRow | undefined> {
    return this.deps.joinChannels.get(channelId);
  }

  /**
   * Whether a member who knocked is on a list that bars them, and if so, turns them
   * away: moved out of the "⇩ Join" channel they are waiting in, and no card posted.
   *
   * Reads the saved blocked list of the room's creator AND of the current owner (who
   * answers the card, and is a caretaker if the creator left), plus whoever a vote
   * removed from the room. Fails open on a read problem: an owner who gets a card they
   * did not need is better than a person turned away on a guess.
   *
   * The move is last and its failure is swallowed: the requester may already have
   * left, and nothing here may throw into the voice listener.
   */
  async refuseBlockedKnock(ctx: JoinChannelRow, requesterId: string): Promise<boolean> {
    try {
      if (!(await this.isBarredFromRoom(ctx, requesterId))) return false;
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId: ctx.guildId, joinChannelId: ctx.channelId },
        'could not check the blocked list for a knock',
      );
      return false;
    }
    try {
      await this.deps.actions.moveMember(ctx.guildId, requesterId, null, {
        onlyFrom: ctx.channelId,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId: ctx.guildId, joinChannelId: ctx.channelId },
        'could not move a blocked member out of the join channel',
      );
    }
    return true;
  }

  /**
   * Admits a requester: grant Connect on the private channel and pull them in.
   *
   * `always` also puts them on the owner's saved trusted list, so every room that
   * owner makes lets them in. The grant comes first and stands on its own, so a list
   * that is full or unavailable costs the saving and never the admission, and the
   * reply says so.
   */
  async approveJoin(
    joinChannelId: string,
    requesterId: string,
    always = false,
  ): Promise<CommandResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    let saved = '';
    try {
      await this.deps.actions.setMemberConnect(
        ctx.guildId,
        ctx.secondaryChannelId,
        requesterId,
        true,
      );
      if (always) saved = await this.saveToList(ctx, requesterId, 'trusted');
      await this.deps.actions.moveMember(ctx.guildId, requesterId, ctx.secondaryChannelId);
    } catch (err) {
      this.deps.logger.warn({ err, joinChannelId, requesterId }, 'failed to admit join requester');
      return fail(`Could not admit <@${requesterId}>: ${describeError(err)}.`);
    }
    return ok(`Admitted <@${requesterId}>.${saved}`);
  }

  /**
   * Denies a requester (disconnect); `block` also bars them from re-requesting, and
   * saves the block.
   *
   * The block is persisted FIRST: on the owner's saved list, then as an overwrite on
   * the room through the same plan every list uses, and the join channel keeps the
   * Connect deny it has always had. The disconnect is last and best effort, because a
   * requester who already left voice would otherwise throw and lose the block that
   * the owner just asked for.
   */
  async denyJoin(
    joinChannelId: string,
    requesterId: string,
    block: boolean,
  ): Promise<CommandResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    let note = '';
    if (block) {
      // Persisted first. Everything after it is allowed to fail without losing it.
      note = await this.saveToList(ctx, requesterId, 'blocked');
      try {
        await this.deps.actions.setMemberConnect(ctx.guildId, joinChannelId, requesterId, false);
      } catch (err) {
        this.deps.logger.warn(
          { err, joinChannelId, requesterId },
          'failed to block join requester',
        );
        return fail(`Could not block <@${requesterId}>: ${describeError(err)}.`);
      }
    }
    try {
      // Last, and scoped to the join channel: the requester may have left it by now.
      await this.deps.actions.moveMember(ctx.guildId, requesterId, null, {
        onlyFrom: joinChannelId,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, joinChannelId, requesterId, block },
        'failed to move a denied join requester out',
      );
      // A block is already saved and applied, and is not undone by this.
      if (!block) return fail(`Could not deny <@${requesterId}>: ${describeError(err)}.`);
      note += ' I could not move them out of the voice channel.';
    }
    return ok(block ? `Blocked <@${requesterId}>.${note}` : `Denied <@${requesterId}>.`);
  }

  /** Cleans up a private channel's companion when the channel goes away. */
  async cleanupForSecondary(guildId: string, secondaryChannelId: string): Promise<void> {
    await this.removeJoinChannel(guildId, secondaryChannelId);
  }

  /**
   * Ownership of a private secondary transferred. Re-point its "⇩ Join" companion at
   * the new owner: rename it and update who may answer join requests. No-ops when the
   * channel has no companion (it isn't private).
   *
   * `opts.handover` says it was a DELIBERATE handover (`/transfer`, or a claim of an
   * ownerless room) and not the owner leaving. Only then do the room's saved lists
   * change hands: the repository has already re-pointed the record's creator (in the
   * same statement that moved the column), and this applies the new creator's lists,
   * which revokes what the giver's put on the room. The owner leaving never gets
   * here with it, so a caretaker cannot revoke the creator's guests or blocks.
   */
  async handleOwnerChanged(
    guildId: string,
    secondaryChannelId: string,
    newOwnerId: string,
    newOwnerName: string,
    opts: { handover?: boolean } = {},
  ): Promise<void> {
    const row = await this.deps.joinChannels.getBySecondary(secondaryChannelId);
    if (row) {
      await this.deps.joinChannels.setCreatorBySecondary(secondaryChannelId, newOwnerId);
      await this.deps.actions.renameChannel(guildId, row.channelId, `⇩ Join ${newOwnerName}`);
      this.deps.logger.info(
        { guildId, secondaryChannelId, joinChannelId: row.channelId, newOwnerId },
        're-pointed join channel at new owner',
      );
    }
    if (opts.handover) await this.applyAccessLists(guildId, secondaryChannelId);
  }

  // -- internals ------------------------------------------------------------------

  /**
   * Recomputes the room's name for `{{PRIVATE}}`, always AFTER the state write
   * (it reads the stored flag back) and never awaited.
   *
   * Not awaited because a transition already spends a read, a bulk write and a channel
   * creation before it can reply, and Discord closes the interaction window at 3
   * seconds. A rate-limited rename adds 2.5s to that on its own. For a guild whose
   * template does not mention `{{PRIVATE}}` the render is unchanged and no rename is
   * issued.
   */
  private rerenderDetached(guildId: string, channelId: string, reason: string): void {
    void this.deps.rerender?.(guildId, channelId).catch((err: unknown) => {
      this.deps.logger.warn({ err, guildId, channelId, reason }, 'detached re-render failed');
    });
  }

  /**
   * Runs a command body so it returns a result and never throws.
   *
   * An error that escapes a task in the guild's queue is logged as `{ err }` and
   * counts toward that guild's circuit breaker, and a missing permission is exactly
   * the kind of error these commands meet. The breaker is for a guild that is
   * failing, not for an owner pressing a button the bot cannot act on.
   */
  private async guarded(
    what: string,
    guildId: string,
    channelId: string | undefined,
    body: () => Promise<CommandResult>,
  ): Promise<CommandResult> {
    try {
      return await body();
    } catch (err) {
      this.deps.logger.warn({ err, guildId, channelId, what }, 'a room access command failed');
      return fail(accessFailed(describeError(err)));
    }
  }

  /**
   * Finds the room a command is about, and refuses what must not be acted on.
   *
   * A room with no owner passes every owner check (there is no one to compare the
   * caller with), which is why it is refused here: anyone present could otherwise hide
   * or lock a room nobody owns. A record this build cannot read is refused too,
   * because it may well be a hidden room's, and acting on its absence is the harm.
   */
  private async open(
    guildId: string,
    channelId: string | undefined,
    userId: string,
    notOwner: string,
  ): Promise<Opened> {
    const refused = (message: string): Opened => ({ kind: 'refused', result: fail(message) });
    if (!channelId) return refused(say.noChannel);
    const row = await this.deps.secondaries.get(channelId);
    if (!row || row.guildId !== guildId) return refused(say.notManaged);
    if (row.ownerId === null) return refused(say.ownerless);
    if (row.ownerId !== userId) return refused(notOwner);
    const read = await this.deps.secondaries.readAccess(channelId);
    if (!read) return refused(say.notManaged);
    if (!read.readable) return refused(say.unreadable);
    const mode = roomMode({ state: row.state, access: read.access });
    // Only an unreadable record is `unknown`, and that was refused above.
    if (mode === 'unknown') return refused(say.unreadable);
    return { kind: 'open', row, access: read.access, mode };
  }

  /** What a finished change says to the owner who asked for it. */
  private report(
    guildId: string,
    channelId: string,
    kind: 'private' | 'public' | 'hide' | 'unhide',
    outcome: AccessOutcome,
  ): CommandResult {
    switch (outcome.status) {
      case 'applied':
      case 'unchanged': {
        this.rerenderDetached(guildId, channelId, kind);
        this.deps.logger.info({ guildId, channelId, outcome: outcome.status }, `room ${kind}`);
        const skipped = outcome.plan.skippedRoleIds;
        if (kind === 'public') return ok(withSkipped(say.public, skipped));
        if (kind === 'hide') {
          return ok(hiddenMessage({ viewerRoleId: outcome.viewerRoleId, skippedRoleIds: skipped }));
        }
        if (kind === 'unhide') {
          return outcome.joinError === undefined
            ? ok(unhiddenMessage(skipped))
            : fail(unhiddenWithoutJoin(describeError(outcome.joinError)));
        }
        return outcome.joinError === undefined
          ? ok(withSkipped(say.locked, skipped))
          : fail(lockedWithoutJoin(describeError(outcome.joinError)));
      }
      case 'deferred':
        // Queued behind a rate limit, so it has not happened: never confirm it. The
        // intent is recorded and the write will land, and the name follows it.
        this.rerenderDetached(guildId, channelId, kind);
        return fail(say.deferred);
      default:
        return this.refusal(outcome);
    }
  }

  /** The reply for every outcome that did not change the room. */
  private refusal(outcome: AccessOutcome): CommandResult {
    switch (outcome.status) {
      case 'refused':
        return fail(
          outcome.reason === 'role_defeats_hide'
            ? roleDefeatsHide(outcome.defeatedBy)
            : TOO_MANY_OVERWRITES,
        );
      case 'not_ready':
        return fail(say.notReady);
      case 'gone':
        return fail(say.gone);
      case 'missing':
        return fail(say.notManaged);
      case 'unreadable':
        return fail(say.unreadable);
      case 'failed':
        return fail(accessFailed(describeError(outcome.error)));
      case 'deferred':
        return fail(say.deferred);
      default:
        return fail(say.notReady);
    }
  }

  /**
   * Changes a room from one mode to another, or converges it on the mode it is in.
   *
   * The one place overwrites and the access record are written. Never throws.
   *
   * 1. Read what Discord holds now (forced fresh) and plan the whole set.
   * 2. Write the plan's INTENT: `private` in `state` and the record that names
   *    everything the write adds and everything it will take back, in one statement.
   *    A write that stops halfway must leave every member and role it touched named,
   *    or nothing will ever take them back.
   * 3. Apply the set. More than two changes is one bulk request, atomic, and a
   *    transition touches far more than the 10 per 10 seconds a channel allows.
   * 4. Finalise: the record as it should stand once the write has landed, which drops
   *    what was taken back. Only after the write has landed.
   *
   * **A failed write reverts what the intent changed in the room's mode**, so the room
   * is never recorded as hidden or locked when Discord says otherwise, and tells the
   * caller. **A deferred write is not reverted and not finalised**: it is queued and
   * will land, so the intent stands and the caller must not say it has happened.
   */
  private async changeAccess(input: ChangeInput): Promise<AccessOutcome> {
    const outcome = await this.writeAccess(input);
    if (outcome.status !== 'applied' && outcome.status !== 'unchanged') return outcome;
    // Last, and only once the block is persisted and applied: a move that fails or
    // finds nobody costs nothing, and moving somebody a block has not reached lets
    // them walk straight back in.
    outcome.movedOut = await this.moveBlockedOut(input.guildId, input.row, [
      ...outcome.plan.facts.blocked,
      ...(input.record?.kicked ?? []),
    ]);
    return outcome;
  }

  /** The read, plan, intent, apply and finalise of {@link changeAccess}, less the move. */
  private async writeAccess(input: ChangeInput): Promise<AccessOutcome> {
    const { guildId, row, record, from, to } = input;
    const channelId = row.channelId;
    const botId = this.deps.botUserId?.();
    if (!botId) return { status: 'not_ready' };

    let current: ResolvedOverwrite[] | null;
    let plan: AccessPlan;
    let viewerRoleId: string | null;
    try {
      current = await this.deps.actions.readOverwrites(guildId, channelId);
      if (current === null) return { status: 'gone' };
      const planned = await this.planInput(input, botId, current);
      plan = planAccess(planned.input);
      viewerRoleId = planned.viewerRoleId;
    } catch (err) {
      return this.failure(guildId, channelId, err);
    }
    if (!plan.ok) {
      return plan.reason === 'role_defeats_hide'
        ? { status: 'refused', reason: 'role_defeats_hide', defeatedBy: plan.defeatedBy }
        : { status: 'refused', reason: 'too_many_overwrites' };
    }

    // Applying a list to a room that already holds it is the common case for the
    // sweep, and costs a read and nothing else.
    const nothingToWrite = plan.diff.upserts.length === 0 && plan.diff.deletes.length === 0;
    const hasPrivate = to === 'public' || row.state.private === true;
    if (
      from === to &&
      nothingToWrite &&
      hasPrivate &&
      sameFacts(record, plan.factsBeforeWrite) &&
      sameFacts(record, plan.facts)
    ) {
      return {
        status: 'unchanged',
        plan,
        viewerRoleId: this.sees(plan, viewerRoleId),
        movedOut: [],
      };
    }

    // The mode a reader sees changes at the intent for these two edges, so these are
    // the two a failure has to put back.
    const flagsChanged =
      (from === 'public' && to !== 'public') || (from === 'locked' && to === 'hidden');
    const intent = await this.deps.secondaries.transitionAccess(channelId, {
      ...(to !== 'public' ? { statePatch: { private: true } } : {}),
      access: (stored) => recordWithFacts(stored, plan.factsBeforeWrite),
    });
    if (intent.status !== 'written') return { status: intent.status };

    // Phase one: what can fail and leave Discord as it was. A failure here puts the
    // room's mode back, so it is never recorded as locked or hidden when it is not.
    let applied: ApplyOverwritesResult;
    try {
      // The Join channel names the owner and is open to all, so it goes BEFORE the deny
      // that hides the room, and a hidden room never has one.
      if (to === 'hidden') await this.removeJoinChannel(guildId, channelId);
      applied = await this.deps.actions.applyOverwrites(guildId, channelId, plan.desired, current);
    } catch (err) {
      if (flagsChanged) await this.revertIntent(channelId, from);
      // A hide that failed after it took the Join channel away leaves a locked room
      // nobody can knock on, so it is put back, best effort.
      if (from === 'locked' && to === 'hidden' && input.ownerId) {
        try {
          await this.ensureJoinChannel(guildId, channelId, input.ownerId, await input.joinName());
        } catch (restoreErr) {
          this.deps.logger.warn(
            { err: restoreErr, guildId, channelId },
            'could not put the join channel back after a failed hide',
          );
        }
      }
      return this.failure(guildId, channelId, err);
    }
    if (applied.channelGone) return { status: 'gone' };
    const sees = this.sees(plan, viewerRoleId);

    // A lock gets its Join channel whether the write has landed or is only queued: it
    // is what the owner's guests knock on, and it does no harm ahead of the lock.
    let joinError: unknown;
    const needsJoin = to === 'locked' && from !== 'locked' && input.ownerId !== null;
    if (applied.deferred) {
      if (needsJoin) joinError = await this.joinForLock(input, botId, plan);
      return {
        status: 'deferred',
        plan,
        viewerRoleId: sees,
        movedOut: [],
        ...(joinError !== undefined ? { joinError } : {}),
      };
    }

    // Phase two: the write has landed, so nothing from here puts the room back. A
    // failure leaves the intent recorded, which names everything the channel holds.
    try {
      // Once the lock is off, so nobody is left knocking on a room that is open.
      if (to === 'public' && from !== 'public') await this.removeJoinChannel(guildId, channelId);

      const finalised = await this.deps.secondaries.transitionAccess(channelId, {
        ...(to !== 'public' ? { statePatch: { private: true } } : { stateRemove: ['private'] }),
        access: (stored) =>
          recordWithFacts(stored, recordableFacts(plan.facts, applied.droppedMemberIds, record)),
      });
      if (finalised.status !== 'written') return { status: finalised.status };
    } catch (err) {
      return this.failure(guildId, channelId, err);
    }
    this.deps.permissionProblems?.clear(guildId, channelId, ['access']);

    if (needsJoin) joinError = await this.joinForLock(input, botId, plan);
    return {
      status: 'applied',
      plan,
      viewerRoleId: sees,
      movedOut: [],
      ...(joinError !== undefined ? { joinError } : {}),
    };
  }

  /**
   * Makes the room's "⇩ Join" channel after a lock, and denies the owner's blocked
   * members Connect on it when it is new. Resolves to what went wrong, if anything:
   * the room is as asked either way, and only its way for others to knock is missing.
   */
  private async joinForLock(input: ChangeInput, botId: string, plan: OkPlan): Promise<unknown> {
    try {
      const joined = await this.ensureJoinChannel(
        input.guildId,
        input.row.channelId,
        input.ownerId!,
        await input.joinName(),
      );
      if (joined.created) {
        await this.denyBlockedOnJoin(input.guildId, joined.channelId, botId, plan);
      }
      return undefined;
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId: input.guildId, channelId: input.row.channelId },
        'could not create the join channel',
      );
      return err;
    }
  }

  /**
   * Puts the room's mode back to what it was before an intent that did not land.
   * Only `private` and `hidden` go back: what the plan recorded stays, because a
   * write that stopped halfway may have put it on the channel and nothing else would
   * ever name it.
   */
  private async revertIntent(channelId: string, from: AccessMode): Promise<void> {
    try {
      await this.deps.secondaries.transitionAccess(channelId, {
        ...(from === 'public' ? { stateRemove: ['private'] } : {}),
        access: (stored) => {
          if (!stored) return stored;
          const { hidden: _hidden, ...rest } = stored;
          return from === 'hidden' ? { ...rest, hidden: true } : rest;
        },
      });
    } catch (err) {
      this.deps.logger.warn({ err, channelId }, 'could not put a room back after a failed change');
    }
  }

  /** The moderator role, if the plan leaves it able to see the room. */
  private sees(plan: OkPlan, viewerRoleId: string | null): string | null {
    if (!viewerRoleId) return null;
    const holds = plan.desired.some(
      (o) => o.type === OVERWRITE_ROLE && o.id === viewerRoleId && (o.allow & VIEW_CHANNEL) !== 0n,
    );
    return holds ? viewerRoleId : null;
  }

  /** Records a failure the guild should hear about, and returns it. */
  private failure(guildId: string, channelId: string, err: unknown): AccessOutcome {
    this.deps.logger.warn(
      { err, guildId, channelId },
      'could not change who can see or join a room',
    );
    if (err instanceof ChannelObfuscatedError) {
      // A channel the bot can no longer see is lost access, not an access change that
      // failed: recorded with no operation of its own, as everywhere else it is.
      this.deps.permissionProblems?.record(guildId, {
        channelId,
        operation: 'delete',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId));
    } else if (isPermissionError(err)) {
      // Missing Access and Missing Permissions are what the problem's wording is true
      // for. The limit, a deleted role and a role above the bot each need their own.
      this.deps.permissionProblems?.record(guildId, {
        channelId,
        operation: 'access',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId, 'access'));
    }
    return { status: 'failed', error: err };
  }

  /** Everything a plan needs that is not the room's overwrites. */
  private async planInput(
    input: ChangeInput,
    botId: string,
    current: readonly ResolvedOverwrite[],
  ): Promise<{ input: AccessPlanInput; viewerRoleId: string | null }> {
    const { guildId, row, record, from, to } = input;
    const lists = input.lists ?? (await this.listsFor(guildId, row, record));

    // The moderator role sees a hidden room (View only), unless it has been deleted,
    // in which case the grant would fail the write with an error about a role.
    let viewerRoleId: string | null = null;
    if (to === 'hidden') {
      const configured = (await this.deps.moderatorRoleId?.(guildId)) ?? null;
      if (
        configured &&
        configured !== guildId &&
        (await this.deps.actions.roleExists(guildId, configured))
      ) {
        viewerRoleId = configured;
      }
    }

    const roleIds = new Set<string>([
      ...current.filter((o) => o.type === OVERWRITE_ROLE).map((o) => o.id),
      ...(record?.neutralised ?? []).map((n) => n.roleId),
      ...(record?.viewerRoleId ? [record.viewerRoleId] : []),
      ...(viewerRoleId ? [viewerRoleId] : []),
    ]);
    const roles = this.deps.voice.botRoleAccess?.(guildId, [...roleIds]);

    return {
      viewerRoleId,
      input: {
        guildId,
        botId,
        current,
        mode: to,
        previousMode: from,
        record,
        ownerId: input.ownerId,
        occupants: this.occupantIds(row),
        trusted: lists.trusted,
        admitted: record?.admitted ?? [],
        blocked: lists.blocked,
        kicked: record?.kicked ?? [],
        viewerRoleId,
        leaveRoleId: roles?.leaveRoleId ?? null,
        uneditableRoleIds: roles?.uneditableRoleIds ?? [],
      },
    };
  }

  /**
   * Who is in the room: the roster (maintained by the join and leave events) and the
   * voice cache together, because the cache lags a join by long enough to plan
   * without somebody who is standing in the room.
   */
  private occupantIds(row: SecondaryChannelRow): string[] {
    const present = this.deps.voice
      .membersInChannel(row.channelId)
      .filter((m) => !m.bot)
      .map((m) => m.id);
    return [...new Set([...(row.state.roster ?? []), ...present])];
  }

  /**
   * The room creator's saved lists, as they apply to this room.
   *
   * Blocked members the overwrite cannot stop (Administrators, the server owner) are
   * left out here and not only at the moment someone is added: a member can become
   * an Administrator after they were listed. Without the repository the entries the
   * room already records are returned as they are, so nothing is revoked.
   */
  private async listsFor(
    guildId: string,
    row: SecondaryChannelRow,
    record: RoomAccess | null,
  ): Promise<RoomLists> {
    const creatorId = record?.creatorId ?? row.originalCreator;
    const repo = this.deps.memberAccessLists;
    if (!repo) {
      return { creatorId, trusted: record?.trusted ?? [], blocked: record?.blocked ?? [] };
    }
    if (!creatorId) return { creatorId, trusted: [], blocked: [] };
    const lists = await repo.get(guildId, creatorId);
    return {
      creatorId,
      trusted: lists.trusted,
      blocked: lists.blocked.filter((id) => !this.bypassesOverwrites(guildId, id)),
    };
  }

  /** Whether no overwrite can stop this member: an Administrator, or the server's owner. */
  private bypassesOverwrites(guildId: string, memberId: string): boolean {
    const facts = this.deps.voice.memberFacts?.(guildId, memberId);
    return facts?.administrator === true || facts?.guildOwner === true;
  }

  /**
   * Asks blocked members who are in the room to leave it. Last, best effort and each
   * on its own: the move re-reads where the member is right now, so a stale cache
   * cannot disconnect somebody who has gone to another channel, and a member who left
   * voice, or one the bot cannot move, costs nothing.
   *
   * Never the room's owner, the bot, an Administrator or the server owner.
   */
  private async moveBlockedOut(
    guildId: string,
    row: SecondaryChannelRow,
    blockedIds: Iterable<string>,
  ): Promise<string[]> {
    const present = new Set(
      this.deps.voice
        .membersInChannel(row.channelId)
        .filter((m) => !m.bot)
        .map((m) => m.id),
    );
    const botId = this.deps.botUserId?.();
    const moved: string[] = [];
    for (const id of new Set(blockedIds)) {
      if (id === row.ownerId || id === botId || !present.has(id)) continue;
      if (this.bypassesOverwrites(guildId, id)) continue;
      try {
        await this.deps.actions.moveMember(guildId, id, null, { onlyFrom: row.channelId });
        moved.push(id);
      } catch (err) {
        this.deps.logger.warn(
          { err, guildId, channelId: row.channelId },
          'could not move a blocked member out of the room',
        );
      }
    }
    return moved;
  }

  /**
   * Puts a requester on the current owner's saved list, then makes the room agree.
   * Returns what to add to the reply: nothing when it went as asked, and a plain
   * sentence when it could not be saved.
   *
   * The list is written first, because the overwrite is derived from it, and a
   * failure to apply it leaves the entry saved, which is what the owner asked for.
   */
  private async saveToList(
    ctx: JoinChannelRow,
    memberId: string,
    kind: 'trusted' | 'blocked',
  ): Promise<string> {
    const repo = this.deps.memberAccessLists;
    if (!repo) return '';
    try {
      const result = await repo.add(ctx.guildId, ctx.creatorId, memberId, kind);
      if (result.outcome === 'full') {
        return ` Your ${kind} list is full (${result.limit}), so they were not added to it.`;
      }
      // Every outcome but `full` applies, `already` included: a retried add after a
      // crash answers `already` for a member whose overwrite was never written.
      const applied = await this.applyAccessLists(ctx.guildId, ctx.secondaryChannelId);
      if (applied.status === 'failed') {
        this.deps.logger.warn(
          { err: applied.error, guildId: ctx.guildId, channelId: ctx.secondaryChannelId },
          'saved a knock decision but could not apply it to the room',
        );
      }
      return '';
    } catch (err) {
      // The decision itself still goes ahead: it is the saving that is lost.
      this.deps.logger.warn(
        { err, guildId: ctx.guildId, channelId: ctx.secondaryChannelId },
        'could not save a knock decision to the list',
      );
      return ` I could not save them to your ${kind} list.`;
    }
  }

  /**
   * Whether a knocking member is barred from the room: on the saved blocked list of
   * the room's creator or of its current owner, or removed from it by a vote.
   */
  private async isBarredFromRoom(ctx: JoinChannelRow, requesterId: string): Promise<boolean> {
    const row = await this.deps.secondaries.get(ctx.secondaryChannelId);
    const record = row ? await this.deps.secondaries.readAccess(row.channelId) : undefined;
    const access = record?.readable ? record.access : null;
    if ((access?.kicked ?? []).includes(requesterId)) return true;
    const repo = this.deps.memberAccessLists;
    if (!repo) return (access?.blocked ?? []).includes(requesterId);
    const owners = new Set<string>([ctx.creatorId]);
    const creator = access?.creatorId ?? row?.originalCreator;
    if (creator) owners.add(creator);
    for (const ownerId of owners) {
      if ((await repo.get(ctx.guildId, ownerId)).blocked.includes(requesterId)) return true;
    }
    return false;
  }

  /** The "⇩ Join {owner}" name, with the owner's `/nick` applied. */
  private async ownerJoinName(guildId: string, row: SecondaryChannelRow): Promise<string> {
    const owner = this.deps.voice.membersInChannel(row.channelId).find((m) => m.id === row.ownerId);
    if (!owner) return '⇩ Join owner';
    const name = this.deps.ownerName
      ? await this.deps.ownerName(guildId, owner)
      : owner.displayName;
    return `⇩ Join ${name}`;
  }

  /**
   * Makes sure the room has exactly one "⇩ Join" channel, creating it only when there
   * is none.
   *
   * `join_channels` has no uniqueness on the room, so a replay or two racing creators
   * could each make one. The loser notices after it has written its row: both ask for
   * the oldest, which is the same row for everyone, and the one that is not it deletes
   * its own channel and row.
   */
  private async ensureJoinChannel(
    guildId: string,
    roomChannelId: string,
    ownerId: string,
    name: string,
  ): Promise<{ channelId: string; created: boolean }> {
    const existing = await this.deps.joinChannels.getBySecondary(roomChannelId);
    if (existing) return { channelId: existing.channelId, created: false };

    const channelId = await this.deps.actions.createJoinChannel(guildId, name, roomChannelId);
    try {
      await this.deps.joinChannels.create({
        channelId,
        guildId,
        secondaryChannelId: roomChannelId,
        creatorId: ownerId,
      });
    } catch (err) {
      await this.deps.actions.deleteChannel(guildId, channelId).catch(() => undefined);
      throw err;
    }
    const kept = await this.deps.joinChannels.getBySecondary(roomChannelId);
    if (kept && kept.channelId !== channelId) {
      await this.deps.actions.deleteChannel(guildId, channelId).catch(() => undefined);
      await this.deps.joinChannels.remove(channelId);
      return { channelId: kept.channelId, created: false };
    }
    return { channelId, created: true };
  }

  /**
   * Denies the owner's blocked members Connect on a Join channel just made, so they
   * cannot sit in it and knock. Best effort: the knock card checks the list as well.
   */
  private async denyBlockedOnJoin(
    guildId: string,
    joinChannelId: string,
    botId: string,
    plan: OkPlan,
  ): Promise<void> {
    const blocked = plan.facts.blocked;
    if (blocked.length === 0) return;
    try {
      const current = await this.deps.actions.readOverwrites(guildId, joinChannelId);
      if (!current) return;
      await this.deps.actions.applyOverwrites(
        guildId,
        joinChannelId,
        joinChannelOverwrites(current, botId, blocked),
        current,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, joinChannelId },
        'could not deny blocked members on the join channel',
      );
    }
  }

  private async removeJoinChannel(guildId: string, secondaryChannelId: string): Promise<void> {
    const row = await this.deps.joinChannels.getBySecondary(secondaryChannelId);
    if (!row) return;
    await this.deps.actions.deleteChannel(guildId, row.channelId);
    await this.deps.joinChannels.removeBySecondary(secondaryChannelId);
  }
}
