import type {
  Logger,
  MemberAccessKind,
  MemberAccessListRepository,
  SecondaryChannelRepository,
} from '@avc/core';
import type { CommandResult } from './commands.js';
import type { PrivacyService } from './privacy.js';
import type { GuildVoiceView } from './types.js';
import {
  ACCESS_REFUSALS,
  clearedMessage,
  listMessage,
  removedMessage,
  roomsNote,
  savedMessage,
  type RoomSync,
} from './accessListsCopy.js';
import { ROOM_ACCESS_REPLIES as say } from './roomAccessCopy.js';

const ok = (message: string): CommandResult => ({ ok: true, message });
const fail = (message: string): CommandResult => ({ ok: false, message });

/**
 * Who `/access trust` or `block` was pointed at, as the interaction layer resolved the
 * option: Discord's own answer about the account and about membership of this server,
 * so nothing here has to fetch.
 */
export interface AccessTarget {
  id: string;
  /** A bot account. */
  bot: boolean;
  /** Discord resolved them as a member of this server. A user picked by id alone is not. */
  inServer: boolean;
  /**
   * What Discord's own answer holds that no overwrite can stop: Administrator, read from
   * the resolved member's permissions, and the server's owner, whose id the guild always
   * knows. Both are checked before the member cache, which has nobody the bot has not
   * seen. Absent means the answer carried neither.
   */
  administrator?: boolean;
  guildOwner?: boolean;
}

export interface AccessCommandsDeps {
  lists: MemberAccessListRepository;
  secondaries: SecondaryChannelRepository;
  /** Applies a creator's lists to one room, which is the only thing done to Discord here. */
  privacy: Pick<PrivacyService, 'applyAccessLists'>;
  voice: GuildVoiceView;
  logger: Logger;
  /**
   * Whether `room_access.disabled` is on (the creation gate's cached snapshot). Absent
   * means not disabled, and a failed read counts as not disabled. While on, `save`
   * refuses and the rest still work: removing, clearing and listing are undo directions.
   */
  roomAccessDisabled?: () => Promise<boolean>;
}

/**
 * The most rooms one edit brings in line before it replies. A member who made more than
 * this at once is in a server where a reply that waits on that many writes would wait too
 * long, and the reply says how many were left.
 */
const MAX_ROOMS_PER_EDIT = 25;

/**
 * A member's saved trusted and blocked lists: `/access trust`, `block`, `remove`,
 * `clear` and `list`. `/access admit` is the privacy service's, since it is about one
 * room and not about a list.
 *
 * **The list is the member's own, per server.** It is keyed by (server, owner) and
 * applies to the rooms THEY create here, whoever owns those rooms by now: a caretaker
 * who inherits a room never rewrites its creator's guests or blocks, and a room the
 * member handed over with `/transfer` is no longer theirs to edit (it is re-pointed to
 * the new owner, so it is not found by the lookup below).
 *
 * **The table is written first, then the live rooms are brought in line.** The save is
 * idempotent and so is applying a list, so a retry after a failure converges, which is
 * why every outcome but a full list applies, `already` included: a retried add after a
 * crash answers `already` for a member whose overwrite was never written.
 *
 * **Every method returns a result and none throws**: these run inside the guild's queue,
 * where a throw is logged as `{ err }` and counts toward the guild's circuit breaker, and
 * a member editing their own list is not the guild failing.
 *
 * **`room_access.disabled`** stops `save` (the entry direction) and never the rest. The
 * undo directions still take their entries back off live rooms, applying only what a room
 * already records, so the switch can never add anything.
 */
export class AccessCommands {
  constructor(private readonly deps: AccessCommandsDeps) {}

  /**
   * `/access trust` and `/access block`.
   *
   * Refuses yourself, a bot, a user who is not in this server, and (for a block) an
   * Administrator or the server's owner, whom no overwrite can stop. That last check
   * reads what the interaction resolved first and the member cache second, so a member
   * who is in neither is let through and is skipped again when the list is applied, which
   * also catches somebody who is promoted later.
   */
  async save(
    guildId: string,
    ownerId: string,
    target: AccessTarget,
    kind: MemberAccessKind,
  ): Promise<CommandResult> {
    return this.guarded('save', guildId, ownerId, async () => {
      if (await this.paused()) return fail(say.paused);
      if (target.id === ownerId) return fail(ACCESS_REFUSALS.self);
      const facts = this.deps.voice.memberFacts?.(guildId, target.id);
      if (target.bot || facts?.bot === true) return fail(ACCESS_REFUSALS.bot(target.id));
      if (!target.inServer) return fail(ACCESS_REFUSALS.notInServer(target.id));
      if (
        kind === 'blocked' &&
        (target.administrator === true ||
          target.guildOwner === true ||
          facts?.administrator === true ||
          facts?.guildOwner === true)
      ) {
        return fail(ACCESS_REFUSALS.unblockable(target.id));
      }

      const added = await this.deps.lists.add(guildId, ownerId, target.id, kind);
      if (added.outcome === 'full') return fail(ACCESS_REFUSALS.full(kind));
      const sync = await this.syncRooms(guildId, ownerId, {
        revokeOnly: false,
        memberId: target.id,
      });
      return ok(savedMessage(target.id, kind, added.outcome) + roomsNote(sync));
    });
  }

  /** `/access remove`: takes a member off whichever list they are on, and off the live rooms. */
  async remove(guildId: string, ownerId: string, memberId: string): Promise<CommandResult> {
    return this.guarded('remove', guildId, ownerId, async () => {
      const was = await this.deps.lists.remove(guildId, ownerId, memberId);
      // Whether or not they were listed: a retry after a crash finds the row gone and the
      // room still holding the overwrite, and applying converges it.
      const sync = await this.syncRooms(guildId, ownerId, { revokeOnly: true, memberId });
      return ok(removedMessage(memberId, was) + roomsNote(sync));
    });
  }

  /** `/access clear`: empties one list, or both, and takes every entry off the live rooms. */
  async clear(guildId: string, ownerId: string, kind?: MemberAccessKind): Promise<CommandResult> {
    return this.guarded('clear', guildId, ownerId, async () => {
      const removed = await this.deps.lists.clear(guildId, ownerId, kind);
      const sync = await this.syncRooms(guildId, ownerId, { revokeOnly: true });
      return ok(clearedMessage(kind, removed.length) + roomsNote(sync));
    });
  }

  /** `/access list`: both lists, as the member sees them. Reads nothing from Discord. */
  async list(guildId: string, ownerId: string): Promise<CommandResult> {
    return this.guarded('list', guildId, ownerId, async () =>
      ok(listMessage(await this.deps.lists.get(guildId, ownerId))),
    );
  }

  // -- internals ------------------------------------------------------------------

  /**
   * Brings the member's open rooms in line with their lists, one after another.
   *
   * The rooms are found by their CREATOR, so a room the member handed over is not
   * touched. `applyAccessLists` never throws and records its own problems, so a room
   * that fails costs the others nothing: the reply says how many did and to run the
   * command again, which retries only what is still wrong.
   */
  private async syncRooms(
    guildId: string,
    ownerId: string,
    opts: { revokeOnly: boolean; memberId?: string },
  ): Promise<RoomSync> {
    const rooms = await this.deps.secondaries.listByOriginalCreator(guildId, ownerId);
    const sync: RoomSync = {
      rooms: rooms.length,
      capped: Math.max(0, rooms.length - MAX_ROOMS_PER_EDIT),
      updated: 0,
      queued: 0,
      failed: 0,
      paused: false,
      movedTarget: false,
    };
    for (const room of rooms.slice(0, MAX_ROOMS_PER_EDIT)) {
      const result = await this.deps.privacy.applyAccessLists(
        guildId,
        room.channelId,
        opts.revokeOnly ? { revokeOnly: true } : {},
      );
      switch (result.status) {
        case 'applied':
        case 'unchanged': {
          const moved = opts.memberId !== undefined && result.movedOut.includes(opts.memberId);
          // A room that already held the entry, or where the entry has no effect (a
          // trusted member in a room that is open to everyone), had no member's overwrite
          // written, and saying "I've applied it" for that would be false. It counts only
          // when the member's own overwrite changed (any member's, for a `clear`) or they
          // were moved out, which is something that happened. The write also holds the
          // bot's allow and the room's record, which say nothing about this edit.
          const changed = result.changedMemberIds ?? [];
          const touched = opts.memberId ? changed.includes(opts.memberId) : changed.length > 0;
          if (touched || moved) sync.updated += 1;
          if (moved) sync.movedTarget = true;
          break;
        }
        case 'deferred':
          sync.queued += 1;
          break;
        case 'failed':
          sync.failed += 1;
          break;
        case 'skipped':
          // A room that went away since it was listed is nothing to bring in line, and
          // is not one the reply should count.
          if (result.reason === 'no_room' || result.reason === 'gone') sync.rooms -= 1;
          else if (result.reason === 'disabled') sync.paused = true;
          else sync.failed += 1;
          break;
      }
    }
    return sync;
  }

  private async paused(): Promise<boolean> {
    try {
      return (await this.deps.roomAccessDisabled?.()) === true;
    } catch {
      return false;
    }
  }

  /** Runs a body so it returns a result and never throws. */
  private async guarded(
    what: string,
    guildId: string,
    ownerId: string,
    body: () => Promise<CommandResult>,
  ): Promise<CommandResult> {
    try {
      return await body();
    } catch (err) {
      this.deps.logger.warn({ err, guildId, ownerId, what }, 'a saved list command failed');
      return fail(ACCESS_REFUSALS.failed);
    }
  }
}
