import { isDeepStrictEqual } from 'node:util';
import type { RoomAccess } from '@avc/core';
import type { AccessFacts, AccessMode } from './accessPlan.js';

/**
 * The fields a plan decides, so a merge knows which keys of the stored record are
 * the planner's to write and which are not.
 */
const PLANNED = [
  'baseline',
  'neutralised',
  'viewerRoleId',
  'trusted',
  'admitted',
  'blocked',
  'hidden',
] as const satisfies readonly (keyof RoomAccess)[];

/**
 * The stored record with a plan's facts written into it.
 *
 * **A merge, never a replacement.** The creator, `kicked` and any field a newer
 * build wrote are carried over untouched: the record is the only thing that tells
 * a grant of ours from one a human added, and a plan that rebuilt it from its own
 * facts would drop whatever it did not know about.
 *
 * Empty lists, a cleared baseline and `hidden: false` are left out and not written
 * as empty values, so a record that says nothing is the same record whether it was
 * never written or was written and emptied, and "has this changed" is a plain
 * comparison ({@link sameFacts}).
 */
export function recordWithFacts(current: RoomAccess | null, facts: AccessFacts): RoomAccess {
  const rest: Record<string, unknown> = { ...(current ?? {}) };
  for (const key of PLANNED) delete rest[key];
  return {
    ...rest,
    ...(facts.baseline ? { baseline: facts.baseline } : {}),
    ...(facts.neutralised.length > 0 ? { neutralised: facts.neutralised } : {}),
    ...(facts.viewerRoleId ? { viewerRoleId: facts.viewerRoleId } : {}),
    ...(facts.trusted.length > 0 ? { trusted: facts.trusted } : {}),
    ...(facts.admitted.length > 0 ? { admitted: facts.admitted } : {}),
    ...(facts.blocked.length > 0 ? { blocked: facts.blocked } : {}),
    ...(facts.hidden ? { hidden: true } : {}),
  };
}

/**
 * Whether writing `facts` would leave the record exactly as it is, so a caller
 * that has nothing to change skips two writes to a row the converge pass visits
 * every few minutes.
 *
 * The stored side is normalised the same way the merge writes, so a record that
 * holds `hidden: false` or an empty list from an older writer is the same as one
 * that omits them.
 */
export function sameFacts(current: RoomAccess | null, facts: AccessFacts): boolean {
  const stored: Record<string, unknown> = { ...(current ?? {}) };
  for (const key of PLANNED) {
    const value = stored[key];
    if (value === false || (Array.isArray(value) && value.length === 0)) delete stored[key];
  }
  return isDeepStrictEqual(stored, recordWithFacts(current, facts));
}

/**
 * The record with an exit marked as queued: the room is still recorded as the mode it is
 * leaving, and `mode` is where a write Discord has only queued will take it. Written
 * apart from the planner's facts (see {@link PLANNED}), so a plan never rebuilds it.
 */
export function withPending(current: RoomAccess | null, mode: AccessMode, at: number): RoomAccess {
  return { ...(current ?? {}), pending: { mode, at } };
}

/**
 * The record without its pending exit, because the change it described has been
 * finalised or the room has been seen to be in that mode. The same object when there
 * is none, so a caller can tell nothing changed.
 */
export function withoutPending(current: RoomAccess): RoomAccess;
export function withoutPending(current: RoomAccess | null): RoomAccess | null;
export function withoutPending(current: RoomAccess | null): RoomAccess | null {
  if (!current || current.pending === undefined) return current;
  const { pending: _pending, ...rest } = current;
  return rest;
}

/** The member lists a caller adds to by hand. */
export type MemberField = 'trusted' | 'admitted' | 'blocked' | 'kicked';

/** The record with `id` added to one of its lists. A set: adding twice changes nothing. */
export function withMember(current: RoomAccess | null, field: MemberField, id: string): RoomAccess {
  const have = current?.[field] ?? [];
  if (have.includes(id)) return current ?? {};
  return { ...(current ?? {}), [field]: [...have, id] };
}

/**
 * The record with `id` taken out of one of its lists, and the list left out when it
 * empties (as {@link recordWithFacts} does). A member who is not on it changes nothing.
 */
export function withoutMember(
  current: RoomAccess | null,
  field: MemberField,
  id: string,
): RoomAccess | null {
  const have = current?.[field];
  if (!current || !have?.includes(id)) return current;
  const left = have.filter((m) => m !== id);
  const next: Record<string, unknown> = { ...current };
  if (left.length > 0) next[field] = left;
  else delete next[field];
  return next as RoomAccess;
}
