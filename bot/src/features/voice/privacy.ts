import type {
  JoinChannelRepository,
  JoinChannelRow,
  Logger,
  MemberAccessLists,
  MemberAccessListRepository,
  MemberPrefPrivacy,
  MemberRoomPrefsRepository,
  RoomAccess,
  RoomAccessRead,
  SecondaryChannelRepository,
  SecondaryChannelRow,
} from '@avc/core';
import type { ApplyOverwritesResult, VoiceActions } from './actions.js';
import type { CommandResult } from './commands.js';
import type { GuildVoiceView, VoiceMember } from './types.js';
import { describeError } from '../../ops/describeError.js';
import {
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  diffOverwrites,
  joinChannelOverwrites,
  leaveOutMembers,
  planAccess,
  type AccessFacts,
  type AccessMode,
  type AccessPlan,
  type AccessPlanInput,
  type ResolvedOverwrite,
} from './accessPlan.js';
import {
  carriedMode,
  isExit,
  recordWithFacts,
  sameFacts,
  withMember,
  withoutMember,
  withoutPending,
  withPending,
} from './accessRecord.js';
import { savedListsInert, type CommandAccess, type CommandCaller } from './commandAccess.js';
import { ChannelObfuscatedError, isPermissionError, withoutRequestBody } from './discordAdapter.js';
import { permissionProblemMessage, type PermissionProblemTracker } from './permissionProblems.js';
import {
  BLOCK_NOT_SAVED_PAUSED,
  ROOM_ACCESS_REPLIES as say,
  TOO_MANY_OVERWRITES,
  accessFailed,
  admitBlocked,
  admitFailed,
  admitKicked,
  admitNotInServer,
  admitted,
  deferredMessage,
  hiddenMessage,
  lockedWithoutJoin,
  roleDefeatsHide,
  savedNote,
  unhiddenMessage,
  unhiddenWithoutJoin,
  withSkipped,
} from './roomAccessCopy.js';
import { rememberSetting, type RememberedSaveDeps } from './rememberedSave.js';
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
  /**
   * Whether `room_access.disabled` is on (the creation gate's cached snapshot, never an
   * uncached flag read). Absent means not disabled. It never throws: a failed read counts
   * as not disabled.
   *
   * While it is on the ENTRY directions refuse: `hide`, `admit`, the knock card's Always
   * allow, and applying a saved list to a room, which is also what a new room's creator's
   * lists and the sweep's pass over a guild are (`convergeGuild` adds nothing while it is
   * on, and only carries a queued opening through). Every undo is untouched: `unhide`,
   * `makePublic`, taking a saved entry back off a live room, finishing a queued opening,
   * and a block's own deny and move on the card. It is deliberately not
   * consulted by `makePrivate`, a vote's kick or
   * a creation: those are existing features whose rollback is a deploy, and a switch that
   * quietly stopped locking a room would be a worse fault than the one it was thrown for.
   * They, `makePublic` and `unhide` therefore still write the creator's saved lists as
   * part of their own change, so this does not stop every write of a saved list.
   *
   * The one creation it does reach is a creator channel set to start its rooms hidden, and
   * not through this service: `VoiceFeature.maybeCreate` asks the same snapshot and makes a
   * locked room instead, so `tryMakePrivateForCreation` is never asked to hide one while the
   * lever is on. The room is still locked, never open.
   */
  roomAccessDisabled?: () => Promise<boolean>;
  /**
   * The guild's `/restrict` rules as they stand now, empty while `command_access.disabled`
   * is on. Asked so a member who is denied Saved lists has lists that apply to nothing
   * (see {@link savedListsInert}). Optional: absent means nobody is restricted. It never
   * throws: a failed read counts as no rules, which keeps every saved list applying.
   */
  commandAccess?: (guildId: string) => Promise<CommandAccess>;
  /**
   * What an owner's `/private`, `/hide`, `/unhide` and `/public` are remembered in, for the
   * creator channels that remember. Optional so a construction that predates it keeps working:
   * absent means nothing is saved. See {@link rememberSetting} for who is saved for and when.
   */
  memberPrefs?: Pick<MemberRoomPrefsRepository, 'savePrivacy'> | undefined;
  /**
   * The `member_prefs.disabled` lever, through the creation gate's cached snapshot. It stops a
   * privacy being saved, and never one being taken back out (`/public`). Absent means not
   * disabled, and a read that throws counts as not disabled.
   */
  memberPrefsDisabled?: RememberedSaveDeps['memberPrefsDisabled'];
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
      /**
       * Members the write left out because Discord has nobody by that id in the server.
       * They hold no overwrite, whatever the plan asked for.
       */
      droppedMemberIds: string[];
      /** Set when the room is right but its "⇩ Join" channel could not be made. */
      joinError?: unknown;
    }
  | { status: 'refused'; reason: 'role_defeats_hide'; defeatedBy: string[] }
  | { status: 'refused'; reason: 'too_many_overwrites' }
  | { status: 'not_ready' | 'gone' | 'missing' | 'unreadable' }
  | { status: 'failed'; error: unknown };

/**
 * A knock decision's result. `keepCard` means nothing was decided (the lever refused
 * an Always allow, so the owner can still press Approve), and a caller that turned the
 * card into the result would strip the buttons that reply points at.
 */
export type JoinDecisionResult = CommandResult & { keepCard?: true };

/** What {@link PrivacyService.applyAccessLists} did, for a caller that is not a command. */
export interface AccessApplyResult {
  /**
   * `applied` or `unchanged` means the room holds what the lists say. `deferred`
   * means Discord queued the write and it has not landed. `skipped` means nothing was
   * decided (see `reason`), and `failed` that something went wrong (see `error`).
   */
  status: 'applied' | 'unchanged' | 'deferred' | 'skipped' | 'failed';
  reason?: 'no_lists' | 'no_room' | 'unreadable' | 'not_ready' | 'gone' | 'refused' | 'disabled';
  /** Blocked members who were in the room and were asked to leave it. */
  movedOut: string[];
  /** Roles the plan could not edit and left as they were. */
  skippedRoleIds: string[];
  /**
   * Set on `applied` and `unchanged`: the members whose own overwrite was written to the
   * room or taken off it. `applied` alone does not say that anybody's was, because the
   * write also covers the bot's allow and the room's record, and a trusted member in a
   * room that is open to everyone has no overwrite at all.
   */
  changedMemberIds?: string[];
  /** The mode a queued exit was carried through to, when this run finished one. */
  completed?: AccessMode;
  /** The room's "⇩ Join" channel was made, taken away or trimmed to one (converge only). */
  joinChanged?: boolean;
  error?: unknown;
}

/** What {@link PrivacyService.applyAccessLists} may be told beyond the room. */
export interface AccessApplyOptions {
  /**
   * The caller only takes entries away (`/access remove` and `clear`, a handover while the
   * lever is on): it is never skipped, and it adds nothing.
   */
  revokeOnly?: boolean;
  /**
   * Set only by the create path: the room has just been made and `id` made it. It means
   * the room is new, so a creator who has blocked nobody ends the run before the room is
   * read at all. `standing` is who they are from the member's own snapshot, which is truer than
   * a cache that may not have them yet, and absent when the snapshot carried no roles.
   * Without a standing the cache says, and a creator it cannot show is not restricted.
   */
  creator?: { id: string; standing?: CommandCaller | undefined } | undefined;
  /**
   * The creator's saved lists, when the caller has already read them. The sweep reads
   * every owner's in one query for the guild and hands each room its own, instead of one
   * read per room.
   */
  saved?: MemberAccessLists | undefined;
  /**
   * Set only by the sweep, with the room's "⇩ Join" rows and the room's own row as it
   * listed them. It is what makes the run also settle the Join channel (a hidden room has
   * none, a locked one exactly one), what keeps a problem the guild has already been told
   * about from being told again, and what spares the run reading the row and its record
   * again, and asking Discord for the room's overwrites until the cache says something
   * differs. Without it a run touches the Join channel only when the room changes mode.
   */
  sweep?: { joins: readonly JoinChannelRow[]; room: SecondaryChannelRow } | undefined;
}

/** What one pass of {@link PrivacyService.convergeGuild} did, for the log and for tests. */
export interface AccessConvergeResult {
  /** Rooms the pass had something to do for, whether or not they needed anything. */
  considered: number;
  /** Rooms whose overwrites or record were written. */
  repaired: number;
  /** Queued exits carried through to the mode they were heading for. */
  completed: number;
  /** Rooms whose "⇩ Join" channel was made, taken away or trimmed to one. */
  joinsFixed: number;
  /** Rooms left alone because their access record is one this build cannot read. */
  unreadable: string[];
  /** Rooms that could not be brought in line this time. */
  failed: number;
}

/** What {@link PrivacyService.tryMakePrivateForCreation} did. */
export type PrivateCreation =
  | { ok: true; applied: boolean; deferred?: boolean }
  | {
      ok: false;
      reason: 'unreadable' | 'not_ready' | 'refused' | 'gone' | 'failed';
      /** What was thrown, when something was: a caller that rolls back checks it for a permission error. */
      error?: unknown;
      /**
       * The room is in the mode that was asked for all the same: only its Join channel could not
       * be made, which the sweep makes. A caller that falls back to a public room on failure
       * must not, or it would describe a locked room as open.
       */
      held?: true;
    };

/**
 * Thrown by {@link PrivacyService.makePrivateForCreation} when the plan REFUSED to make the
 * room private or hidden (a role the bot cannot edit would still show a hidden room, or
 * the room has too many overrides), as opposed to a write that failed.
 *
 * Its own class so the create path can treat it as the failure it is for an admin's
 * default: a room that was meant to start hidden and cannot be is deleted, never left
 * visible to everyone while its creator is told it is hidden. A refusal carries no
 * Discord error to read, so without this it would be an unrecognised error that escapes
 * the create path with the room still in place.
 */
export class CreationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreationRefusedError';
  }
}

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
  /**
   * The caller only takes entries away, so the plan may not add the moderator role: a
   * hidden room keeps the one it recorded, whatever the server's setting says now.
   */
  revokeOnly?: boolean;
  /** The "⇩ Join" channel's name, asked only when one has to be made. */
  joinName: () => Promise<string>;
  /**
   * Log a failure and leave it off the guild's problem list. For a caller that is
   * about to delete the room and report the problem against another channel itself.
   */
  quiet?: boolean;
  /**
   * Run by the sweep, which comes back every few minutes: a problem the guild has already
   * been told about is not recorded or logged again, so one room the bot cannot edit is one
   * incident and not one per sweep. It is still logged for the operator.
   */
  sweep?: boolean;
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
 * The lists, less every entry the room does not already record: what a caller that is
 * only taking entries away may apply. A recorded entry that is still listed is kept (it
 * is wanted, and dropping it would revoke it), and one the lists no longer hold is simply
 * absent, which is what makes the plan take it back.
 */
function onlyRecorded(wanted: RoomLists, record: RoomAccess | null): RoomLists {
  const trusted = new Set(record?.trusted ?? []);
  const blocked = new Set(record?.blocked ?? []);
  return {
    ...wanted,
    trusted: wanted.trusted.filter((id) => trusted.has(id)),
    blocked: wanted.blocked.filter((id) => blocked.has(id)),
  };
}

/**
 * Whether a record holds anything the sweep has to look after: a mode, a marker, or an
 * entry. A record that names only its creator (what an emptied list leaves) does not, so
 * a room whose lists are all gone costs the sweep nothing.
 */
function recordsAccess(record: RoomAccess | null): boolean {
  if (!record) return false;
  return (
    record.hidden === true ||
    record.pending !== undefined ||
    record.baseline !== undefined ||
    record.viewerRoleId !== undefined ||
    (record.neutralised?.length ?? 0) > 0 ||
    (record.trusted?.length ?? 0) > 0 ||
    (record.blocked?.length ?? 0) > 0 ||
    (record.admitted?.length ?? 0) > 0 ||
    (record.kicked?.length ?? 0) > 0
  );
}

/**
 * How long the sweep leaves a room alone after Discord showed it only the obfuscated shell
 * of the channel (the bot can no longer see it). The incident is recorded once, and asking
 * again every sweep would only repeat it, so the sweep asks again rarely, which is also how
 * it notices the access has been given back.
 */
const LOST_ACCESS_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * How long a member Discord has said it has nobody by that id for is taken as still gone,
 * without asking again. A saved list outlives its entries' membership (the commonest block
 * is somebody who left or was banned), and every room that list reaches would otherwise ask
 * the gateway again and write its record twice, every sweep, to end up where it started.
 * A member who rejoins is in the member cache at once, which overrides this: the hour only
 * covers a cache that missed it.
 */
const ABSENT_MEMBER_RECHECK_MS = 60 * 60 * 1000;

/**
 * How long a room's sweep incident is not recorded a second time, whatever the guild's
 * problem list says. The list holds ten, so a guild with more broken rooms evicts each one
 * before its next sweep, and without this every sweep would record them all again (a log
 * line each, and the notifier's backoff restarted). For the ordinary case the list's own
 * answer decides, and this only bounds the rest.
 */
const SWEEP_TOLD_FOR_MS = 6 * 60 * 60 * 1000;

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

  /**
   * Rooms the sweep found it could no longer see, and when. In memory and per process, like
   * the problem tracker it sits beside: a restart asks once more, which is one more request.
   */
  private readonly lostAccess = new Map<string, number>();

  /** Members Discord has no one for, by guild and member, and when it said so. See {@link ABSENT_MEMBER_RECHECK_MS}. */
  private readonly absentMembers = new Map<string, number>();

  /** Sweep incidents already told to a guild, by room and operation, and when. See {@link SWEEP_TOLD_FOR_MS}. */
  private readonly sweepTold = new Map<string, number>();

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
      await this.rememberPrivacy(row, userId, outcome, 'private');
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
   *
   * It does not record the failure as an access problem on the room: the rollback
   * deletes the room and records it against the creator channel, and a second entry
   * for a channel that no longer exists would be one nothing ever clears.
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
      { quiet: true },
    );
    if (result.ok) return;
    const message = `could not make ${channelId} ${mode} on creation: ${result.reason}`;
    if (result.reason === 'refused') throw new CreationRefusedError(message);
    throw result.error ?? new Error(message);
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
    opts: { quiet?: boolean } = {},
  ): Promise<PrivateCreation> {
    try {
      const row = await this.deps.secondaries.get(channelId);
      if (!row || row.guildId !== guildId) return { ok: true, applied: false };
      const read = await this.deps.secondaries.readAccess(channelId);
      if (!read) return { ok: true, applied: false };
      if (!read.readable) return { ok: false, reason: 'unreadable' };
      if (roomMode({ state: row.state, access: read }) !== 'public') {
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
        ...(opts.quiet ? { quiet: true } : {}),
      });
      switch (outcome.status) {
        case 'applied':
        case 'deferred':
          if (outcome.joinError !== undefined) {
            return { ok: false, reason: 'failed', error: outcome.joinError, held: true };
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
      // Public is never remembered: it is what every room is until somebody changes it, and
      // remembering it would pin a member to an open room after the creator channel chose a
      // private one. So going public takes whatever they remembered back out.
      await this.rememberPrivacy(row, userId, outcome, null);
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
      if (await this.accessPaused()) return fail(say.paused);
      const opened = await this.open(guildId, channelId, userId, say.notOwnerHide);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode } = opened;
      if (mode === 'hidden') return fail(say.alreadyHidden);
      // Before the Join channel goes: a hide from a locked room deletes it, and a write
      // the bot has no permission for would then have to put it back under a new id.
      if (this.lacksManageRoles(guildId, row.channelId)) return fail(say.needsManageRoles);

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: access,
        from: mode,
        to: 'hidden',
        ownerId: row.ownerId,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      await this.rememberPrivacy(row, userId, outcome, 'hidden');
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
      // A room that is shown again is still locked, so it is `private` that they now want. Left
      // as `hidden`, a member who hid a room and then showed it would be given a hidden room
      // next time.
      await this.rememberPrivacy(row, userId, outcome, 'private');
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
      if (await this.accessPaused()) return fail(say.paused);
      const opened = await this.open(guildId, channelId, ownerId, say.notOwnerAdmit);
      if (opened.kind === 'refused') return opened.result;
      const { row, access, mode: recorded } = opened;
      // A queued opening is carried through and not written over: the room is as it was
      // recorded until that write lands, and an admit that planned the recorded mode would
      // close the room again behind it.
      const mode = carriedMode(recorded, access, Date.now()) ?? recorded;
      if (mode === 'public') return fail(say.openToEveryone);
      if (this.lacksManageRoles(guildId, row.channelId)) return fail(say.needsManageRoles);
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
        from: recorded,
        to: mode,
        ownerId: row.ownerId,
        lists,
        joinName: () => this.ownerJoinName(guildId, row),
      });
      switch (outcome.status) {
        case 'applied':
        case 'unchanged':
          if (outcome.droppedMemberIds.includes(memberId)) {
            // Discord has nobody by that id in the server, so no overwrite was written
            // for them. Said so, and taken back out of the record: a "done" would be
            // false, and an id kept for somebody who cannot be let in is only clutter.
            await this.deps.secondaries.mutateAccess(row.channelId, (current) =>
              withoutMember(current, 'admitted', memberId),
            );
            return fail(admitNotInServer(memberId));
          }
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
   * column. It never blocks or moves the room's current owner, and skips
   * Administrators and the server owner, whom no overwrite can stop.
   *
   * The block is persisted and the overwrite applied BEFORE anyone is moved: a move
   * that fails or finds nobody costs nothing, whereas a move ahead of the block lets
   * the member walk straight back in.
   *
   * Idempotent: a second run reads the channel as the first left it, plans no change
   * and writes nothing.
   *
   * A queued OPENING (`record.pending`) is carried through to the mode it was heading
   * for instead of being re-asserted as the mode the record still names. A creator who is
   * denied Saved lists has no lists (see {@link listsFor}). {@link convergeGuild} is this,
   * run for every room of a guild with `sweep` set.
   *
   * **`room_access.disabled` skips it** (`reason: 'disabled'`), which is what keeps a
   * knock card's Block and the sweep from applying lists while the lever is on.
   * `revokeOnly` is for the caller that is TAKING ENTRIES AWAY (`/access remove` and
   * `clear`, and a handover while the lever is on): it is never skipped, and it adds
   * nothing to the room. It applies only the entries the room already records, and a
   * hidden room keeps the moderator role it recorded rather than the one the server has
   * set now. The lever never stands between a member and the removal of something they
   * put there.
   */
  async applyAccessLists(
    guildId: string,
    roomChannelId: string,
    opts: AccessApplyOptions = {},
  ): Promise<AccessApplyResult> {
    const skipped = (reason: NonNullable<AccessApplyResult['reason']>): AccessApplyResult => ({
      status: 'skipped',
      reason,
      movedOut: [],
      skippedRoleIds: [],
    });
    try {
      const repo = this.deps.memberAccessLists;
      // Without the repository, "no entries" would read as "everything was removed".
      if (!repo) return skipped('no_lists');
      if (!opts.revokeOnly && (await this.accessPaused())) return skipped('disabled');

      // A room that has just been made is not read when its creator has blocked nobody.
      // Only a block can matter to it: a room that started locked or hidden was planned
      // from these same lists a moment ago, and in an open room a trusted entry grants
      // nothing. One indexed read, and it ends the run for nearly every room.
      let saved = opts.saved;
      if (opts.creator && !opts.revokeOnly && saved === undefined) {
        saved = await repo.get(guildId, opts.creator.id);
        if (saved.blocked.length === 0) {
          return { status: 'unchanged', movedOut: [], skippedRoleIds: [] };
        }
      }

      // The sweep has just listed this room, inside the guild's one queued task, so what it
      // found is what is stored and the two reads below would only repeat it. A record that
      // parsed is the whole answer. One that did not could be missing or unreadable, which
      // only the stored blob tells apart, so that case still reads it.
      const listed = opts.sweep?.room;
      const row = listed ?? (await this.deps.secondaries.get(roomChannelId));
      if (!row || row.guildId !== guildId) return skipped('no_room');
      const read: RoomAccessRead | undefined =
        listed && listed.access !== null
          ? { readable: true, access: listed.access }
          : await this.deps.secondaries.readAccess(roomChannelId);
      if (!read) return skipped('no_room');
      if (!read.readable) {
        this.deps.logger.warn(
          { guildId, channelId: roomChannelId },
          'a room has an access record this build cannot read; its lists were not applied',
        );
        return skipped('unreadable');
      }
      const mode = roomMode({ state: row.state, access: read });
      if (mode === 'unknown') return skipped('unreadable');

      /**
       * A queued exit is carried through, not undone.
       *
       * The record of a room whose opening Discord has only queued still says hidden or
       * locked, and planning it as that would re-close it and fight the write that is
       * about to land (or, once a restart has lost that write, undo what the owner asked
       * for). So the room is planned as the mode it is heading for, which finalises the
       * record. A marker for a mode the room is already in, or for a way IN, is stale (the
       * queued write landed, or something else wrote it), and so is one too old to be a write
       * still waiting for its turn: those are only cleared (see {@link carriedMode}).
       */
      let record = read.access;
      let target: AccessMode = mode;
      if (record?.pending !== undefined) {
        const carried = carriedMode(mode, record, Date.now());
        if (carried !== null) {
          target = carried;
        } else {
          const cleared = await this.deps.secondaries.mutateAccess(roomChannelId, (current) =>
            withoutPending(current),
          );
          if (cleared.status === 'written') record = cleared.access;
        }
      }

      const wanted = await this.listsFor(guildId, row, record, {
        saved,
        standing: opts.creator?.standing,
      });
      const lists = opts.revokeOnly ? onlyRecorded(wanted, record) : wanted;
      // A public room that has never had an access record, made by somebody with
      // nothing saved: there is nothing for a list to change, and it costs no call to
      // Discord at all. Any other room is planned, which also repairs what an
      // interrupted change or a stale write left behind.
      if (
        mode === 'public' &&
        record === null &&
        lists.trusted.length === 0 &&
        lists.blocked.length === 0
      ) {
        return { status: 'unchanged', movedOut: [], skippedRoleIds: [] };
      }

      const outcome = await this.changeAccess({
        guildId,
        row,
        record,
        from: mode,
        to: target,
        ownerId: row.ownerId,
        lists,
        joinName: () => this.ownerJoinName(guildId, row),
        ...(opts.revokeOnly ? { revokeOnly: true } : {}),
        ...(opts.sweep ? { sweep: true } : {}),
      });
      switch (outcome.status) {
        case 'applied':
        case 'unchanged': {
          // Only after the write has landed: a queued one says nothing about the Join channel.
          const joinChanged = opts.sweep
            ? await this.settleJoinChannel(guildId, row, target, opts.sweep.joins, outcome.plan)
            : false;
          // A Join channel that could not be made is recorded as an access problem, and
          // the room's own write returned `unchanged`, which clears nothing. Making it now
          // is what resolves that.
          if (joinChanged) this.clearIncident(guildId, roomChannelId, ['access']);
          this.sweepTold.delete(`${roomChannelId}:refused`);
          return {
            status: outcome.status,
            movedOut: outcome.movedOut,
            skippedRoleIds: outcome.plan.skippedRoleIds,
            changedMemberIds: [
              ...outcome.plan.diff.upserts.filter((o) => o.type === OVERWRITE_MEMBER),
              ...outcome.plan.diff.deletes.filter((o) => o.type === OVERWRITE_MEMBER),
            ].map((o) => o.id),
            ...(target !== mode && outcome.status === 'applied' ? { completed: target } : {}),
            ...(joinChanged ? { joinChanged: true } : {}),
          };
        }
        case 'deferred':
          return { status: 'deferred', movedOut: [], skippedRoleIds: outcome.plan.skippedRoleIds };
        case 'failed':
          return { status: 'failed', movedOut: [], skippedRoleIds: [], error: outcome.error };
        case 'refused':
          // The room is left exactly as it is, which for a hidden room that a role the bot
          // cannot edit would show is the unsafe direction, so the sweep says which room and
          // why (ids only), once and not every five minutes.
          if (opts.sweep) this.logRefusal(guildId, roomChannelId, outcome);
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
   * The sweep's pass over one guild's rooms: brings every room that has something
   * recorded, or whose creator has saved a list, in line with what the lists and the
   * record say. This is the correctness mechanism for saved lists and hidden rooms, and
   * everything that applies one live (a create, a command, a card) is an early
   * application of what this guarantees.
   *
   * **It is {@link applyAccessLists} run over a guild, so it repairs what that plans:** an
   * entry missing from Discord is added, a recorded entry the lists no longer name is taken
   * back, blocked occupants are asked to leave, a hidden room keeps the bot's allow and
   * the full `@everyone` deny, a lost `private` comes back, and the moderator role is
   * revoked and granted as the setting changes (a deleted role is simply dropped). **A
   * queued opening is carried through** to the mode it was heading for. And it settles the
   * Join channel: a hidden room has none and a locked one exactly one.
   *
   * **What it never does.** It never deletes an overwrite no record names (a human's, a
   * knocker an owner approved, a vote's older deny), never touches the current owner's
   * overwrite beyond granting what they need, and writes nothing a second run would write.
   * It DOES override a hand edit of a hidden room's `@everyone` overwrite, within one
   * sweep: a hidden room is meant to be hidden, as the companion text channel is meant to
   * be private. A locked room's `@everyone` Connect deny is put back the same way, so an
   * admin who opens a locked room by editing it, and not with `/public`, has the lock
   * restored. A record this build cannot read is skipped and reported, never repaired, and
   * only a room the pass considers can be reported: the listing cannot tell an unreadable
   * record from none, so one whose creator has saved nothing is not looked at.
   *
   * **Cheap when there is nothing to do:** one query for the saved lists of the live rooms'
   * owners and one for the Join channels of the locked and hidden ones. A room that holds
   * what it should costs nothing from Discord or the database, because it is planned from
   * the row the sweep listed and the channel cache, and only one the cache shows differing
   * is read fresh and written. A room with no record whose creator has no saved entries
   * costs nothing at all.
   *
   * `room_access.disabled` turns the pass off, except that it still carries a queued
   * opening through (an undo, which the lever never blocks), taking entries away and adding
   * none. It never throws: each room has its own try and catch, so one room the bot cannot
   * edit costs that room, not the guild's other passes, and nothing here counts against
   * the breaker.
   */
  async convergeGuild(
    guildId: string,
    rooms: readonly SecondaryChannelRow[],
  ): Promise<AccessConvergeResult> {
    const result: AccessConvergeResult = {
      considered: 0,
      repaired: 0,
      completed: 0,
      joinsFixed: 0,
      unreadable: [],
      failed: 0,
    };
    try {
      const repo = this.deps.memberAccessLists;
      if (!repo || rooms.length === 0) return result;

      // The lever stops the pass adding anything, but an opening Discord queued is an undo,
      // which it never blocks: the owner was told it would land, and a restart that lost
      // the write would otherwise leave the room closed against their request for as long
      // as the lever is on. So while it is on the pass looks at those rooms only, and
      // carries them through without adding an entry or a role.
      const paused = await this.accessPaused();
      const candidates = paused ? rooms.filter((room) => this.hasQueuedOpening(room)) : rooms;
      if (candidates.length === 0) return result;

      const creatorOf = (room: SecondaryChannelRow): string | null =>
        room.access?.creatorId ?? room.originalCreator;
      let byOwner: Map<string, MemberAccessLists>;
      try {
        byOwner = await repo.listByGuild(guildId, [
          ...new Set(candidates.flatMap((room) => creatorOf(room) ?? [])),
        ]);
      } catch (err) {
        // Never read as "nobody has saved anything": that would take every saved entry
        // off every room.
        this.deps.logger.warn({ err, guildId }, 'could not read the saved lists; skipping');
        return result;
      }

      const none: MemberAccessLists = { trusted: [], blocked: [] };
      const work = candidates.flatMap((room) => {
        const creatorId = creatorOf(room);
        const saved = (creatorId ? byOwner.get(creatorId) : undefined) ?? none;
        const locked = room.state.private === true;
        return recordsAccess(room.access) ||
          saved.blocked.length > 0 ||
          (locked && saved.trusted.length > 0)
          ? [{ room, saved }]
          : [];
      });
      if (work.length === 0) return result;

      // One read for the Join rows of every room that is not open.
      const closed = work
        .filter(({ room }) => room.state.private === true || room.access?.hidden === true)
        .map(({ room }) => room.channelId);
      const joinsByRoom = new Map<string, JoinChannelRow[]>();
      try {
        for (const join of await this.deps.joinChannels.listBySecondaries(closed)) {
          const rows = joinsByRoom.get(join.secondaryChannelId) ?? [];
          rows.push(join);
          joinsByRoom.set(join.secondaryChannelId, rows);
        }
      } catch (err) {
        this.deps.logger.warn({ err, guildId }, 'could not read the join channels; skipping');
        return result;
      }

      for (const { room, saved } of work) {
        const lostAt = this.lostAccess.get(room.channelId);
        if (lostAt !== undefined) {
          if (Date.now() - lostAt < LOST_ACCESS_RETRY_MS) continue;
          this.lostAccess.delete(room.channelId);
        }
        result.considered += 1;
        try {
          const applied = await this.applyAccessLists(guildId, room.channelId, {
            saved,
            sweep: { joins: joinsByRoom.get(room.channelId) ?? [], room },
            ...(paused ? { revokeOnly: true } : {}),
          });
          if (applied.status === 'skipped' && applied.reason === 'disabled') break;
          // Asked again after the long wait and answered, so the room's lost-access
          // incident is over. Nothing else clears it: the room's own write may well be
          // `unchanged`.
          if (
            lostAt !== undefined &&
            (applied.status === 'applied' ||
              applied.status === 'unchanged' ||
              applied.status === 'deferred')
          ) {
            this.clearIncident(guildId, room.channelId, ['delete']);
          }
          this.tally(result, room.channelId, applied);
        } catch (err) {
          result.failed += 1;
          this.deps.logger.warn(
            { err, guildId, channelId: room.channelId },
            'could not converge a room access',
          );
        }
      }

      if (
        result.repaired + result.completed + result.joinsFixed + result.failed > 0 ||
        result.unreadable.length > 0
      ) {
        this.deps.logger.info(
          { guildId, ...result, unreadable: result.unreadable.length },
          'converged room access',
        );
      }
    } catch (err) {
      this.deps.logger.warn({ err, guildId }, 'the room access pass failed');
    }
    return result;
  }

  /** Counts what one room's run did, and remembers a room the bot can no longer see. */
  private tally(result: AccessConvergeResult, channelId: string, applied: AccessApplyResult): void {
    switch (applied.status) {
      case 'applied':
        result.repaired += 1;
        if (applied.completed !== undefined) result.completed += 1;
        break;
      case 'failed':
        result.failed += 1;
        if (applied.error instanceof ChannelObfuscatedError) {
          this.lostAccess.set(channelId, Date.now());
        }
        break;
      case 'skipped':
        if (applied.reason === 'unreadable') result.unreadable.push(channelId);
        else if (applied.reason === 'refused') result.failed += 1;
        break;
      default:
        break;
    }
    if (applied.joinChanged) result.joinsFixed += 1;
  }

  /** Whether a room has an opening Discord queued that the sweep would carry through. */
  private hasQueuedOpening(room: SecondaryChannelRow): boolean {
    const mode = roomMode({ state: room.state, access: { readable: true, access: room.access } });
    return mode !== 'unknown' && carriedMode(mode, room.access, Date.now()) !== null;
  }

  /**
   * Ends a room's incidents of these kinds: the guild's problem list, and what the sweep
   * remembers of having told it.
   */
  private clearIncident(
    guildId: string,
    channelId: string,
    operations: readonly ('access' | 'delete')[],
  ): void {
    this.deps.permissionProblems?.clear(guildId, channelId, operations);
    for (const operation of operations) this.sweepTold.delete(`${channelId}:${operation}`);
  }

  /** Whether the sweep has already told the guild about this (room, kind) and may not again yet. */
  private toldRecently(key: string): boolean {
    const at = this.sweepTold.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < SWEEP_TOLD_FOR_MS) return true;
    this.sweepTold.delete(key);
    return false;
  }

  /** Logs a room the sweep could not plan a change for, once per room for a long while. Ids only. */
  private logRefusal(
    guildId: string,
    channelId: string,
    outcome: Extract<AccessOutcome, { status: 'refused' }>,
  ): void {
    const key = `${channelId}:refused`;
    if (this.toldRecently(key)) return;
    this.sweepTold.set(key, Date.now());
    this.deps.logger.warn(
      {
        guildId,
        channelId,
        reason: outcome.reason,
        ...(outcome.reason === 'role_defeats_hide' ? { defeatedBy: outcome.defeatedBy } : {}),
      },
      'the sweep could not plan a room access change and left the room as it is',
    );
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
      // A record this build cannot read answers `unreadable` here and is left as it is.
      const written = await this.deps.secondaries.mutateAccess(channelId, (current) =>
        withMember(current, 'kicked', targetId),
      );
      if (written.status !== 'written') return false;
      const mode = roomMode({
        state: row.state,
        access: { readable: true, access: written.access },
      });
      if (mode === 'unknown') return false;

      const outcome = await this.changeAccess({
        guildId,
        row,
        record: written.access,
        from: mode,
        // A queued opening is carried through and not written over, as `admit` does.
        to: carriedMode(mode, written.access, Date.now()) ?? mode,
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
      if (!(await this.barredFromRoom(ctx, requesterId))) return false;
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
  ): Promise<JoinDecisionResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    // A new entry on a saved list, so the lever stops it. A plain approval is not an
    // entry direction (it is one person, this room, and dies with it) and goes ahead.
    // Nothing was decided, and the reply sends the owner to Approve, so the card has to
    // keep it: `keepCard` is what stops the router turning the card into this refusal.
    if (always && (await this.accessPaused())) return { ...fail(say.alwaysPaused), keepCard: true };
    // A card outlives the decision that made it stale: the owner blocks a knock, then
    // approves the same person's second card, or the room votes them out in between.
    // A grant here would replace the deny the block left, so a barred member is refused.
    let barred: 'kicked' | 'blocked' | null = null;
    try {
      barred = await this.barredFromRoom(ctx, requesterId);
    } catch (err) {
      // Open, as a knock is: the owner pressed Approve, and the check is a safeguard.
      this.deps.logger.warn(
        { err, joinChannelId, requesterId },
        'could not check the blocked list before admitting a requester',
      );
    }
    if (barred)
      return fail(barred === 'kicked' ? admitKicked(requesterId) : admitBlocked(requesterId));
    let saved = '';
    try {
      await this.deps.actions.setMemberConnect(
        ctx.guildId,
        ctx.secondaryChannelId,
        requesterId,
        true,
      );
      if (always) saved = (await this.saveToList(ctx, requesterId, 'trusted')).note;
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
   * the owner just asked for. A failed deny on the join channel is a note when the
   * block was saved (the knock check turns them away anyway) and a failure when it
   * was the only block there was.
   *
   * Asked to block the bot or a member no overwrite can stop, it denies them and says
   * it could not block them, and saves nothing.
   */
  async denyJoin(
    joinChannelId: string,
    requesterId: string,
    block: boolean,
  ): Promise<CommandResult> {
    const ctx = await this.deps.joinChannels.get(joinChannelId);
    if (!ctx) return fail('That request has expired.');
    let note = '';
    // Nobody can block the bot or a member whose permissions override every overwrite,
    // so asking to is a deny, and says why. They are never added to a list that could
    // not keep them out.
    const unblockable =
      block &&
      (requesterId === this.deps.botUserId?.() ||
        this.bypassesOverwrites(ctx.guildId, requesterId));
    if (unblockable) {
      note = ' I could not block them, because they have permissions that override any block.';
    }
    const blocking = block && !unblockable;
    if (blocking) {
      // Persisted first. Everything after it is allowed to fail without losing it.
      const listed = await this.saveToList(ctx, requesterId, 'blocked');
      note = listed.note;
      try {
        await this.deps.actions.setMemberConnect(ctx.guildId, joinChannelId, requesterId, false);
      } catch (err) {
        this.deps.logger.warn(
          { err, joinChannelId, requesterId },
          'failed to block join requester',
        );
        // With the block on the owner's list the knock check turns them away anyway, so
        // this is a note and the disconnect still happens. With nothing saved it was the
        // whole block, and it did not land.
        if (!listed.saved) return fail(`Could not block <@${requesterId}>: ${describeError(err)}.`);
        note += ' I could not stop them knocking on the **⇩ Join** channel again.';
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
      if (!blocking) return fail(`Could not deny <@${requesterId}>: ${describeError(err)}.`);
      note += ' I could not move them out of the voice channel.';
    }
    return ok(`${blocking ? 'Blocked' : 'Denied'} <@${requesterId}>.${note}`);
  }

  /** Cleans up a private channel's companion when the channel goes away. */
  async cleanupForSecondary(guildId: string, secondaryChannelId: string): Promise<void> {
    // What the sweep remembers of a room that is gone, which nothing else would ever drop.
    this.lostAccess.delete(secondaryChannelId);
    for (const kind of ['access', 'delete', 'refused']) {
      this.sweepTold.delete(`${secondaryChannelId}:${kind}`);
    }
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
   * which takes back the saved trusted and blocked entries the giver's lists put on
   * the room. It does not take back members the giver admitted to this room alone,
   * nor the giver's own access as the owner: those stay until the room is deleted.
   * The owner leaving never gets here with it, so a caretaker cannot revoke the
   * creator's guests or blocks.
   */
  async handleOwnerChanged(
    guildId: string,
    secondaryChannelId: string,
    newOwnerId: string,
    newOwnerName: string,
    opts: { handover?: boolean } = {},
  ): Promise<void> {
    try {
      const row = await this.deps.joinChannels.getBySecondary(secondaryChannelId);
      if (row) {
        await this.deps.joinChannels.setCreatorBySecondary(secondaryChannelId, newOwnerId);
        await this.deps.actions.renameChannel(guildId, row.channelId, `⇩ Join ${newOwnerName}`);
        this.deps.logger.info(
          { guildId, secondaryChannelId, joinChannelId: row.channelId, newOwnerId },
          're-pointed join channel at new owner',
        );
      }
    } finally {
      // Whether or not the companion could be renamed: who may enter the room does not
      // wait on what its lobby is called. Never throws, so it cannot hide the error above.
      // While the lever is on the recipient's lists are not APPLIED, but the giver's
      // entries still come off: taking them away is a revoke, which the lever never
      // holds back, and leaving them would keep the giver's guests in a room the giver
      // gave away until somebody next edits a list.
      if (opts.handover) {
        await this.applyAccessLists(guildId, secondaryChannelId, {
          revokeOnly: await this.accessPaused(),
        });
      }
    }
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

  /** Whether `room_access.disabled` is on. Never throws: a failed read counts as not disabled. */
  private async accessPaused(): Promise<boolean> {
    try {
      return (await this.deps.roomAccessDisabled?.()) === true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the cache says the bot cannot edit this room's overwrites, which is a
   * preflight and not the authority: "cannot say" goes ahead, and Discord answers.
   * Records the access problem the failed write would have, so an admin still hears
   * about a bot that is missing the permission.
   */
  private lacksManageRoles(guildId: string, channelId: string): boolean {
    if (this.deps.voice.botPermissionsIn?.(channelId)?.manageRoles !== false) return false;
    this.deps.permissionProblems?.record(guildId, {
      channelId,
      operation: 'access',
      at: Date.now(),
    });
    this.deps.serverLog?.(guildId, 1, permissionProblemMessage(channelId, 'access'));
    return true;
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
    const mode = roomMode({ state: row.state, access: read });
    // Only an unreadable record is `unknown`, and that was refused above.
    if (mode === 'unknown') return refused(say.unreadable);
    return { kind: 'open', row, access: read.access, mode };
  }

  /**
   * Remembers the privacy an owner chose for their next room (`null` takes it back out), once
   * the change has taken effect, which is `applied`. A command that finds the room already in
   * the mode asked for is refused by `open` before it gets here, so `unchanged` (a plan with
   * nothing to write, which needs the same mode before and after) is not an outcome of these
   * four commands. Never when it was refused, failed or only queued behind a rate limit,
   * because then the room is not what they asked for and the command says so. A lock whose
   * Join channel could not be made is `applied` with the error beside it: the room is locked,
   * which is what they chose, and the sweep makes the channel. Never throws. The save is the
   * owner's own, by equality (see {@link rememberSetting}), and `open` has already refused
   * anyone else.
   */
  private async rememberPrivacy(
    row: SecondaryChannelRow,
    userId: string,
    outcome: AccessOutcome,
    privacy: MemberPrefPrivacy | null,
  ): Promise<void> {
    if (outcome.status !== 'applied') return;
    await rememberSetting(
      {
        memberPrefs: this.deps.memberPrefs,
        memberPrefsDisabled: this.deps.memberPrefsDisabled,
        logger: this.deps.logger,
      },
      row,
      userId,
      { field: 'privacy', value: privacy },
    );
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
        return fail(deferredMessage(kind));
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
        return fail(deferredMessage('admit'));
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

    /** A plan for these overwrites, less what it asks for members already known to be gone. */
    const planFor = async (overwrites: readonly ResolvedOverwrite[]) => {
      const planned = await this.planInput(input, botId, overwrites);
      const made = planAccess(planned.input);
      const trimmed = made.ok
        ? this.withoutKnownAbsent(made, guildId, botId, overwrites, record)
        : { plan: made, absent: [] };
      return { ...trimmed, viewerRoleId: planned.viewerRoleId };
    };

    let current: ResolvedOverwrite[] | null;
    let plan: AccessPlan;
    let absent: string[];
    let viewerRoleId: string | null;
    try {
      // Applying a list to a room that already holds it is the common case for the sweep,
      // so the sweep asks the channel cache first, which every channel update patches and
      // which costs no request. Only a room the cache shows differing is read fresh (the
      // cache can lag, and nothing is ever WRITTEN from it) and planned again.
      const cached = input.sweep
        ? this.deps.actions.cachedOverwrites?.(guildId, channelId)
        : undefined;
      if (cached) {
        const trial = await planFor(cached);
        if (trial.plan.ok && this.holdsAlready(input, trial.plan)) {
          return {
            status: 'unchanged',
            plan: trial.plan,
            viewerRoleId: this.sees(trial.plan, trial.viewerRoleId),
            movedOut: [],
            droppedMemberIds: trial.absent,
          };
        }
      }
      current = await this.deps.actions.readOverwrites(guildId, channelId);
      if (current === null) return { status: 'gone' };
      ({ plan, absent, viewerRoleId } = await planFor(current));
    } catch (err) {
      return this.failure(guildId, channelId, err, input.quiet, input.sweep);
    }
    if (!plan.ok) {
      return plan.reason === 'role_defeats_hide'
        ? { status: 'refused', reason: 'role_defeats_hide', defeatedBy: plan.defeatedBy }
        : { status: 'refused', reason: 'too_many_overwrites' };
    }

    // The room already holds what the plan says: nothing to write, and no reason to touch
    // the record twice. Which is why a member who is not in the server must not read as a
    // change the plan keeps asking for (see `withoutKnownAbsent`).
    if (this.holdsAlready(input, plan)) {
      return {
        status: 'unchanged',
        plan,
        viewerRoleId: this.sees(plan, viewerRoleId),
        movedOut: [],
        droppedMemberIds: absent,
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
      this.rememberAbsent(guildId, applied.droppedMemberIds);
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
      return this.failure(guildId, channelId, err, input.quiet, input.sweep);
    }
    if (applied.channelGone) return { status: 'gone' };
    const sees = this.sees(plan, viewerRoleId);
    // Who the room holds nothing for because Discord has nobody by that id: the ones this
    // write found, and the ones an earlier write found that it did not ask about again.
    const dropped = [...new Set([...applied.droppedMemberIds, ...absent])];

    // A lock gets its Join channel whether the write has landed or is only queued: it
    // is what the owner's guests knock on, and it does no harm ahead of the lock.
    // Not when the room is leaving hidden and the write is only queued: it is still
    // recorded hidden, and a channel naming the owner beside a room that has not been
    // seen to open is the leak the hide exists to prevent. Asking again, once it has
    // landed, makes it.
    //
    // A queued write is not watched: nothing finalises the record when it lands or
    // reverts it when it fails, and the reply says what the owner can do (see
    // `deferredMessage`). Until something does, a record that still says hidden or
    // private after a queued OPENING describes the room as it was, and the sweep that
    // derives the desired state from a record would undo the opening. So an opening is
    // marked pending, which tells the sweep to carry it through (see `applyAccessLists`).
    //
    // And any other queued change SUPERSEDES an earlier marker: Discord runs the writes of
    // a channel in order, so this one lands after the opening and is what the owner last
    // asked for. A marker left standing would have the sweep re-open the room against it.
    let joinError: unknown;
    const needsJoin = to === 'locked' && from !== 'locked' && input.ownerId !== null;
    if (applied.deferred) {
      if (isExit(from, to)) await this.setPending(channelId, to);
      else if (record?.pending !== undefined) await this.setPending(channelId, null);
      if (needsJoin && from !== 'hidden') joinError = await this.joinForLock(input, botId, plan);
      return {
        status: 'deferred',
        plan,
        viewerRoleId: sees,
        movedOut: [],
        droppedMemberIds: dropped,
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
        // Whatever was queued is settled, whether it was this change or an earlier one
        // that this change carried through.
        access: (stored) =>
          withoutPending(
            recordWithFacts(stored, recordableFacts(plan.facts, applied.droppedMemberIds, record)),
          ),
      });
      if (finalised.status !== 'written') return { status: finalised.status };
    } catch (err) {
      return this.failure(guildId, channelId, err, input.quiet, input.sweep);
    }
    this.clearIncident(guildId, channelId, ['access']);

    if (needsJoin) joinError = await this.joinForLock(input, botId, plan);
    return {
      status: 'applied',
      plan,
      viewerRoleId: sees,
      movedOut: [],
      droppedMemberIds: dropped,
      ...(joinError !== undefined ? { joinError } : {}),
    };
  }

  /**
   * Whether the room already holds what the plan says, so there is nothing to write: it
   * keeps its mode, no overwrite differs, `private` is where it belongs, and the record
   * already names everything the plan would.
   */
  private holdsAlready(input: ChangeInput, plan: OkPlan): boolean {
    const { row, record, from, to } = input;
    const nothingToWrite = plan.diff.upserts.length === 0 && plan.diff.deletes.length === 0;
    const hasPrivate = to === 'public' || row.state.private === true;
    return (
      from === to &&
      nothingToWrite &&
      hasPrivate &&
      sameFacts(record, plan.factsBeforeWrite) &&
      sameFacts(record, plan.facts)
    );
  }

  /**
   * The plan less what it asks for members Discord has already said it has nobody by that
   * id for, and the ones it left out.
   *
   * A saved list names members who have since left (the commonest block is somebody who was
   * banned), and a plan always wants an overwrite written for each. Nothing can be written
   * for them, so a plan that kept asking would read as a change every sweep: the intent
   * and the finalising write of the record, and the gateway lookup that finds them gone
   * again, over and over to end where it began. Leaving them out, for the hour the answer is
   * believed (see {@link ABSENT_MEMBER_RECHECK_MS}), lets such a room read as unchanged.
   *
   * Only a member the room holds NO overwrite for, and who is not in the member cache (a
   * member who has rejoined is). One who already has an overwrite keeps it, and what the
   * record already names stays named, so a block that outlives their membership still
   * blocks them if they come back.
   */
  private withoutKnownAbsent(
    plan: OkPlan,
    guildId: string,
    botId: string,
    current: readonly ResolvedOverwrite[],
    record: RoomAccess | null,
  ): { plan: OkPlan; absent: string[] } {
    if (this.absentMembers.size === 0) return { plan, absent: [] };
    const held = new Set(current.filter((o) => o.type === OVERWRITE_MEMBER).map((o) => o.id));
    const absent = new Set(
      plan.diff.upserts
        .filter(
          (o) =>
            o.type === OVERWRITE_MEMBER &&
            o.id !== botId &&
            !held.has(o.id) &&
            this.knownAbsent(guildId, o.id),
        )
        .map((o) => o.id),
    );
    if (absent.size === 0) return { plan, absent: [] };
    const gone = [...absent];
    const desired = leaveOutMembers(plan.desired, current, absent);
    return {
      absent: gone,
      plan: {
        ...plan,
        desired,
        diff: diffOverwrites(current, desired, { botId, guildId }),
        facts: recordableFacts(plan.facts, gone, record),
        factsBeforeWrite: recordableFacts(plan.factsBeforeWrite, gone, record),
      },
    };
  }

  /** Remembers members a write found Discord has nobody for. */
  private rememberAbsent(guildId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    for (const [key, at] of this.absentMembers) {
      if (now - at >= ABSENT_MEMBER_RECHECK_MS) this.absentMembers.delete(key);
    }
    for (const id of ids) this.absentMembers.set(`${guildId}:${id}`, now);
  }

  /** Whether a member is still believed to be gone from the server. */
  private knownAbsent(guildId: string, id: string): boolean {
    const key = `${guildId}:${id}`;
    const at = this.absentMembers.get(key);
    if (at === undefined) return false;
    // In the member cache means they have rejoined, and an hour on the cache may simply
    // have missed it: either way ask Discord again.
    if (
      Date.now() - at >= ABSENT_MEMBER_RECHECK_MS ||
      this.deps.voice.memberFacts?.(guildId, id) !== undefined
    ) {
      this.absentMembers.delete(key);
      return false;
    }
    return true;
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
      // Without the request body: the channel's name is the owner's.
      this.deps.logger.warn(
        { err: withoutRequestBody(err), guildId: input.guildId, channelId: input.row.channelId },
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
   *
   * Only an edge that was not already hidden is ever reverted (a room leaving hidden
   * keeps both flags until its write has landed), so `hidden` simply comes off.
   */
  private async revertIntent(channelId: string, from: AccessMode): Promise<void> {
    try {
      await this.deps.secondaries.transitionAccess(channelId, {
        ...(from === 'public' ? { stateRemove: ['private'] } : {}),
        access: (stored) => {
          if (!stored) return stored;
          const { hidden: _hidden, ...rest } = stored;
          return rest;
        },
      });
    } catch (err) {
      this.deps.logger.warn({ err, channelId }, 'could not put a room back after a failed change');
    }
  }

  /**
   * Marks an opening Discord has only queued, so the sweep carries it through and does not
   * re-assert the mode the record still names, or takes the marker off when a later change
   * has been queued behind it (`null`). Never throws: the write is already queued and will
   * land, and the marker is only what lets a lost one be finished.
   */
  private async setPending(channelId: string, mode: AccessMode | null): Promise<void> {
    const at = Date.now();
    try {
      const written = await this.deps.secondaries.mutateAccess(channelId, (current) =>
        mode === null ? withoutPending(current) : withPending(current, mode, at),
      );
      if (written.status !== 'written') {
        this.deps.logger.warn(
          { channelId, status: written.status },
          'could not update the marker of a queued opening',
        );
      }
    } catch (err) {
      this.deps.logger.warn({ err, channelId }, 'could not update the marker of a queued opening');
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

  /**
   * Records a failure the guild should hear about, and returns it. `quiet` keeps a
   * permission failure off the problem list and out of the server's log channel (it is
   * still logged), for a caller that reports it itself, as the create path's rollback
   * does. `sweep` is for the periodic pass, which fails on the same room every time it
   * comes round until somebody fixes it: an incident the guild already has is neither
   * recorded again (which would restart the notifier's backoff) nor logged to the server's
   * log channel again.
   */
  private failure(
    guildId: string,
    channelId: string,
    err: unknown,
    quiet: boolean | undefined,
    sweep?: boolean,
  ): AccessOutcome {
    // A failed channel create (the Join channel) carries the name it was given, which is the
    // owner's display name, and this is logged on every sweep for as long as it fails.
    withoutRequestBody(err);
    this.deps.logger.warn(
      { err, guildId, channelId },
      'could not change who can see or join a room',
    );
    // Told already: the guild's problem list still holds it, or the sweep recorded it
    // within the last hours. The list is capped at ten, so past ten broken rooms it evicts
    // each before its next sweep and cannot be the only memory.
    const told = (operation: 'delete' | 'access'): boolean =>
      sweep === true &&
      ((this.deps.permissionProblems
        ?.recent(guildId)
        .some((p) => p.channelId === channelId && p.operation === operation) ??
        false) ||
        this.toldRecently(`${channelId}:${operation}`));
    const record = (operation: 'delete' | 'access'): void => {
      this.deps.permissionProblems?.record(guildId, { channelId, operation, at: Date.now() });
      if (sweep === true) this.sweepTold.set(`${channelId}:${operation}`, Date.now());
      this.deps.serverLog?.(
        guildId,
        1,
        permissionProblemMessage(channelId, operation === 'access' ? 'access' : undefined),
      );
    };
    if (err instanceof ChannelObfuscatedError) {
      // A channel the bot can no longer see is lost access, not an access change that
      // failed: recorded with no operation of its own, as everywhere else it is.
      if (!told('delete')) record('delete');
    } else if (isPermissionError(err) && !quiet && !told('access')) {
      // Missing Access and Missing Permissions are what the problem's wording is true
      // for. The limit, a deleted role and a role above the bot each need their own.
      record('access');
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
    // in which case the grant would fail the write with an error about a role. A caller
    // that only takes entries away keeps the role the room recorded: a setting changed
    // since the hide would otherwise be GRANTED here, which is an addition.
    let viewerRoleId: string | null = null;
    if (to === 'hidden') {
      const configured = input.revokeOnly
        ? (record?.viewerRoleId ?? null)
        : ((await this.deps.moderatorRoleId?.(guildId)) ?? null);
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
   *
   * **A creator who is denied Saved lists has none**: their lists are inert, so the room
   * is planned as if nothing were saved, which also takes back what an earlier plan wrote
   * for them. `saved` is for a caller that has read them already, and `standing` for one
   * that knows who the creator is better than the cache does.
   */
  private async listsFor(
    guildId: string,
    row: SecondaryChannelRow,
    record: RoomAccess | null,
    known: { saved?: MemberAccessLists | undefined; standing?: CommandCaller | undefined } = {},
  ): Promise<RoomLists> {
    const creatorId = record?.creatorId ?? row.originalCreator;
    const repo = this.deps.memberAccessLists;
    if (!repo) {
      return { creatorId, trusted: record?.trusted ?? [], blocked: record?.blocked ?? [] };
    }
    if (!creatorId) return { creatorId, trusted: [], blocked: [] };
    const lists = known.saved ?? (await repo.get(guildId, creatorId));
    // The rules are asked only when there is something they could make inert.
    if (
      lists.trusted.length + lists.blocked.length > 0 &&
      (await this.listsInert(guildId, row.channelId, creatorId, known.standing))
    ) {
      return { creatorId, trusted: [], blocked: [] };
    }
    return {
      creatorId,
      trusted: lists.trusted,
      blocked: lists.blocked.filter((id) => !this.bypassesOverwrites(guildId, id)),
    };
  }

  /**
   * Whether this member's saved lists are inert: they are denied Saved lists (see
   * {@link savedListsInert}). `standing` is who they are when the caller knows, else the
   * cache says, and a member the cache cannot show is not inert. The settings are asked
   * first and the cache only when a rule names the feature, so a guild with no rule pays
   * one cached settings read. Never throws: a failed read counts as not inert, which keeps
   * the list applying.
   */
  private async listsInert(
    guildId: string,
    roomChannelId: string,
    ownerId: string,
    standing?: CommandCaller,
  ): Promise<boolean> {
    try {
      const rules = (await this.deps.commandAccess?.(guildId)) ?? {};
      if (rules.access === undefined) return false;
      return savedListsInert(
        rules,
        standing ?? this.deps.voice.ownerAccessOf?.(roomChannelId, ownerId),
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, guildId, channelId: roomChannelId },
        'could not read the restrictions for a saved list; applying it',
      );
      return false;
    }
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
   * Answers whether it was saved, and what to add to the reply: nothing when it went
   * as asked, and a plain sentence when it could not be saved.
   *
   * The list is written first, because the overwrite is derived from it, and a
   * failure to apply it leaves the entry saved, which is what the owner asked for.
   */
  private async saveToList(
    ctx: JoinChannelRow,
    memberId: string,
    kind: 'trusted' | 'blocked',
  ): Promise<{ saved: boolean; note: string }> {
    const repo = this.deps.memberAccessLists;
    if (!repo) return { saved: false, note: '' };
    // The lever stops the saving and nothing else: a Block still turns the requester
    // away, and says that it did not save them.
    if (await this.accessPaused()) return { saved: false, note: BLOCK_NOT_SAVED_PAUSED };
    // A member who is denied Saved lists has lists that apply to nothing. Saving to one
    // would leave an entry that springs to life the day the rule goes, and a reply that
    // says it is in force would be untrue now, so the decision stands without it.
    if (await this.listsInert(ctx.guildId, ctx.secondaryChannelId, ctx.creatorId)) {
      return { saved: false, note: '' };
    }
    try {
      const result = await repo.add(ctx.guildId, ctx.creatorId, memberId, kind);
      if (result.outcome === 'full') {
        return {
          saved: false,
          note: ` Your ${kind} list is full (${result.limit}), so they were not added to it.`,
        };
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
      return { saved: true, note: savedNote(kind) };
    } catch (err) {
      // The decision itself still goes ahead: it is the saving that is lost.
      this.deps.logger.warn(
        { err, guildId: ctx.guildId, channelId: ctx.secondaryChannelId },
        'could not save a knock decision to the list',
      );
      return { saved: false, note: ` I could not save them to your ${kind} list.` };
    }
  }

  /**
   * Why a knocking member is barred from the room, or null when they are not: removed
   * from it by a vote, or on the saved blocked list of the room's creator or of its
   * current owner. Not a member whose permissions override every overwrite: nothing
   * written for them keeps them out, so turning them away would only be a disconnect.
   *
   * Reads the room's row once. An access record this build cannot read reads as none
   * here, which is the direction that lets a knock through.
   */
  private async barredFromRoom(
    ctx: JoinChannelRow,
    requesterId: string,
  ): Promise<'kicked' | 'blocked' | null> {
    if (this.bypassesOverwrites(ctx.guildId, requesterId)) return null;
    const row = await this.deps.secondaries.get(ctx.secondaryChannelId);
    const access = row?.access ?? null;
    if ((access?.kicked ?? []).includes(requesterId)) return 'kicked';
    const repo = this.deps.memberAccessLists;
    if (!repo) return (access?.blocked ?? []).includes(requesterId) ? 'blocked' : null;
    const owners = new Set<string>([ctx.creatorId]);
    const creator = access?.creatorId ?? row?.originalCreator;
    if (creator) owners.add(creator);
    for (const ownerId of owners) {
      // An owner who is denied Saved lists has lists that bar nobody.
      if (
        (await repo.get(ctx.guildId, ownerId)).blocked.includes(requesterId) &&
        !(await this.listsInert(ctx.guildId, ctx.secondaryChannelId, ownerId))
      ) {
        return 'blocked';
      }
    }
    return null;
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
   * Makes the room's "⇩ Join" channel agree with its mode, for the sweep: a hidden room has
   * none (it would name the owner beside a room that is meant to be gone from the list) and
   * a locked one exactly one. Resolves to whether it changed anything.
   *
   * `joins` is what the sweep found before this run, which this run's own write may have
   * changed (a queued opening it carried through makes one), so every step is idempotent:
   * the create looks first, and the removal reads what is there. Never throws: a failure is
   * recorded like any other access problem the sweep meets, once.
   */
  private async settleJoinChannel(
    guildId: string,
    row: SecondaryChannelRow,
    mode: AccessMode,
    joins: readonly JoinChannelRow[],
    plan: OkPlan,
  ): Promise<boolean> {
    try {
      if (mode === 'hidden') {
        if (joins.length === 0) return false;
        await this.removeJoinChannel(guildId, row.channelId);
        return true;
      }
      const botId = this.deps.botUserId?.();
      // An ownerless room has nobody for the channel to name.
      if (mode !== 'locked' || row.ownerId === null || !botId) return false;
      if (joins.length > 1) {
        // Everything beyond the oldest, which is the one the knock and the rest keep.
        for (const extra of joins.slice(1)) {
          await this.deps.actions.deleteChannel(guildId, extra.channelId);
          await this.deps.joinChannels.remove(extra.channelId);
        }
        return true;
      }
      if (joins.length === 1) return false;
      const made = await this.ensureJoinChannel(
        guildId,
        row.channelId,
        row.ownerId,
        await this.ownerJoinName(guildId, row),
      );
      if (!made.created) return false;
      await this.denyBlockedOnJoin(guildId, made.channelId, botId, plan);
      return true;
    } catch (err) {
      this.failure(guildId, row.channelId, err, false, true);
      return false;
    }
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

  /**
   * Deletes the room's "⇩ Join" channel and its row. Every one it has: a replay or two
   * racing creators can leave two, and deleting the oldest while forgetting all of
   * them would leave a channel naming the owner that nothing tracks any more.
   */
  private async removeJoinChannel(guildId: string, secondaryChannelId: string): Promise<void> {
    // Bounded: a row that would not go must not hold this in a loop.
    for (let i = 0; i < 10; i++) {
      const row = await this.deps.joinChannels.getBySecondary(secondaryChannelId);
      if (!row) return;
      await this.deps.actions.deleteChannel(guildId, row.channelId);
      await this.deps.joinChannels.remove(row.channelId);
    }
  }
}
