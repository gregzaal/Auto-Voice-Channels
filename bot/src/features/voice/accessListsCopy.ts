import { MAX_SAVED_BLOCKED, MAX_SAVED_TRUSTED, type MemberAccessKind } from '@avc/core';

/**
 * What `/access` says about a member's saved trusted and blocked lists, kept out of the
 * service and the handler so every reply is worded once and one render-time test covers
 * all of them.
 *
 * **What a saved list is, and what it is not.** It belongs to the member who made it and
 * applies to the rooms THEY create in this server, so every reply that saves something
 * says so. A block never stops an Administrator or the server's owner, because no
 * overwrite can: the replies that can be read as promising otherwise say it plainly.
 *
 * **"The rooms you create" is a promise two things keep.** `VoiceFeature.maybeCreate`
 * applies the creator's lists to a room as it is made, and the sweep's converge pass
 * (`PrivacyService.convergeGuild`) brings every live room in line within one interval,
 * which also covers a room made while the hook failed or while `room_access.disabled` was
 * on. This copy and the command descriptions that say the same are true of a build that has
 * both, and must not be deployed without them.
 *
 * Replies are ephemeral and are sent with mentions suppressed, so a mention of the
 * person on a list pings nobody.
 */

const LIMITS: Record<MemberAccessKind, number> = {
  trusted: MAX_SAVED_TRUSTED,
  blocked: MAX_SAVED_BLOCKED,
};

/** What a list is called in a sentence. */
const listName = (kind: MemberAccessKind): string => `${kind} list`;

/** Why a member could not be put on a list. Each names the member, so the reply stands alone. */
export const ACCESS_REFUSALS = {
  /** `/access trust` or `block` with nobody picked, which only a hand-built request sends. */
  unusable: "That isn't someone I can put on a list.",
  self: "That's you. You always have access to your own rooms, so there is nothing to save.",
  bot: (memberId: string): string =>
    `<@${memberId}> is a bot, so I can't put it on a list. To let it into one room, use \`/access admit\`.`,
  notInServer: (memberId: string): string =>
    `<@${memberId}> isn't in this server, so I can't put them on a list.`,
  /** An Administrator or the server's owner, whom no block can stop. */
  unblockable: (memberId: string): string =>
    `<@${memberId}> is an Administrator or owns this server, so a block would not stop them: ` +
    "Administrators can still enter every room. I haven't added them to your blocked list.",
  full: (kind: MemberAccessKind): string =>
    `Your ${listName(kind)} is full (${LIMITS[kind]}). Take someone off it with \`/access remove\`, ` +
    'or empty it with `/access clear`, then try again.',
  failed: "I couldn't update your lists just now. Try again in a moment.",
} as const;

/** The same two sentences on every reply that saves somebody: where it applies, and the way back. */
const UNDO = ' Undo it with `/access remove`.';

/** What a save says. The room note, if any, is appended by the caller. */
export function savedMessage(
  memberId: string,
  kind: MemberAccessKind,
  outcome: 'added' | 'flipped' | 'already',
): string {
  const who = `<@${memberId}>`;
  if (outcome === 'already') return `${who} is already on your ${listName(kind)}.`;
  const lead =
    outcome === 'flipped'
      ? `${who} moved from your ${kind === 'trusted' ? 'blocked' : 'trusted'} list to your ${listName(kind)}`
      : `${who} is on your ${listName(kind)}`;
  return kind === 'trusted'
    ? `${lead}, so they can join the locked or hidden rooms you create in this server.${UNDO}`
    : `${lead}, so they cannot join the rooms you create in this server. ` +
        `Administrators can still enter, because nothing a room can say stops them.${UNDO}`;
}

/** What `/access remove` says. `was` is the list they were on, or null for neither. */
export function removedMessage(memberId: string, was: MemberAccessKind | null): string {
  return was
    ? `<@${memberId}> is off your ${listName(was)}.`
    : `<@${memberId}> wasn't on either of your lists, so nothing changed.`;
}

/** What `/access clear` says. `removed` is how many entries it took off. */
export function clearedMessage(kind: MemberAccessKind | undefined, removed: number): string {
  const which = kind ? `your ${listName(kind)}` : 'both your lists';
  if (removed === 0) {
    return kind
      ? `Your ${listName(kind)} was already empty.`
      : 'Both your lists were already empty.';
  }
  return `Emptied ${which} (${removed === 1 ? '1 person' : `${removed} people`}).`;
}

/** Mentions in a sentence, or "nobody". */
const mentions = (ids: readonly string[]): string =>
  ids.length === 0 ? 'nobody' : ids.map((id) => `<@${id}>`).join(', ');

/**
 * The `/access list` reply: both lists, with how full each is, and what a saved list
 * does. The caps are 25 and 25, so the longest reply is about 1,300 characters.
 *
 * `inert` is a member an admin has turned Saved lists off for, whose lists apply to nothing
 * until it is turned back on. They can still read them, and the sentence that says the lists
 * apply to their rooms would be false, so it is replaced and not added to.
 */
export function listMessage(
  lists: { trusted: string[]; blocked: string[] },
  opts: { inert?: boolean } = {},
): string {
  return [
    '**Your saved lists in this server**',
    `**Trusted** (${lists.trusted.length} of ${LIMITS.trusted}): ${mentions(lists.trusted)}`,
    `**Blocked** (${lists.blocked.length} of ${LIMITS.blocked}): ${mentions(lists.blocked)}`,
    '',
    opts.inert
      ? 'A server admin has turned off **Saved lists** for you, so these apply to none of your ' +
        'rooms right now. They are kept, and apply again if it is turned back on. Take someone ' +
        'off with `/access remove`, or empty a list with `/access clear`.'
      : 'They apply to the rooms you create in this server. Trusted people can join your locked ' +
        'and hidden rooms. Blocked people cannot join any room you create, though Administrators ' +
        'can always enter. Take someone off with `/access remove`, or empty a list with ' +
        '`/access clear`.',
  ].join('\n');
}

/** What an edit did to the live rooms of the member who made it, for the note under the reply. */
export interface RoomSync {
  /** How many rooms the member created that are still open. */
  rooms: number;
  /** How many of them this reply left alone because it stops at a cap. */
  capped: number;
  /** Rooms the edit changed. A room that already held the entry, or that it does nothing for, is not one. */
  updated: number;
  /** Discord has queued the change and it has not landed. */
  queued: number;
  failed: number;
  /** The lever was switched on while it ran, so nothing was applied. */
  paused: boolean;
  /** The member this edit is about was in one of the rooms, and was asked to leave it. */
  movedTarget: boolean;
}

/**
 * The sentence about the member's live rooms, or none when they have none.
 *
 * Honest about every outcome: a retry is the answer to a failure because the save is
 * idempotent, and a change Discord has only queued is never said to have happened.
 */
export function roomsNote(sync: RoomSync): string {
  if (sync.rooms === 0) return '';
  if (sync.paused) {
    return ' Applying lists to rooms is switched off for now, so your current rooms were not changed.';
  }
  const parts: string[] = [];
  if (sync.updated > 0) {
    parts.push(
      `I've applied it to ${sync.updated === 1 ? 'your current room' : `${sync.updated} of your current rooms`}${sync.movedTarget ? ' and moved them out of it' : ''}.`,
    );
  }
  if (sync.queued > 0) {
    parts.push(
      `Discord is slowing down changes to ${sync.queued === 1 ? 'one room' : `${sync.queued} rooms`}, so ${sync.queued === 1 ? 'it is' : 'they are'} queued.`,
    );
  }
  if (sync.failed > 0) {
    parts.push(
      `I could not update ${sync.failed === 1 ? 'one room' : `${sync.failed} rooms`}. Run the command again to retry.`,
    );
  }
  if (sync.capped > 0) {
    parts.push(`I only updated the first ${sync.rooms - sync.capped} of your ${sync.rooms} rooms.`);
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}
