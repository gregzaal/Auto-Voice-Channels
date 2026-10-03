import type { RoomAccess } from '@avc/core';
import type { AccessMode } from './accessPlan.js';

/**
 * What a room is, as far as anyone who can ask Discord could tell: open to
 * everyone, locked, hidden from the channel list, or not knowable.
 */
export type RoomMode = AccessMode | 'unknown';

/** What {@link roomMode} reads of a stored room. */
export interface RoomModeInput {
  state: { private?: boolean | undefined };
  access: RoomAccess | null;
}

/**
 * The mode a room is in, derived from its row.
 *
 * **Never read `state.private` alone.** A hidden room is private, so `private`
 * stays true in `state` for readers that predate hiding, but it lives in the one
 * column every whole-state writer replaces from an older snapshot. A stale
 * replace can therefore drop it from a hidden room, leaving `access.hidden` with
 * no `private` beside it, and a reader that trusted `private` would call a hidden
 * room public (and then offer to lock it, creating a "⇩ Join" channel that names
 * its owner). So hidden wins: the access record says hidden, and hidden implies
 * locked.
 *
 * **A record this build cannot read is `unknown`, never a plain locked room.** The
 * row schema reads such a blob as no record at all, so the row alone cannot tell
 * the two apart: the caller says so with `accessReadable: false`, from
 * `SecondaryChannelRepository.readAccess`. What it may hold is a hidden room's
 * record, and acting on its absence (opening the room, creating a Join channel,
 * restoring a baseline nobody can read) is the harm. Nothing should change such a
 * room except a build that can read it.
 *
 * `private` set and no record is a locked room, which is also what an older build
 * leaves behind. Neither flag is public.
 */
export function roomMode(row: RoomModeInput, opts: { accessReadable?: boolean } = {}): RoomMode {
  if (opts.accessReadable === false) return 'unknown';
  if (row.access?.hidden === true) return 'hidden';
  if (row.state.private === true) return 'locked';
  return 'public';
}
