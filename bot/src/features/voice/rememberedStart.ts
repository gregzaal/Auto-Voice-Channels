import type { MemberRoomPrefs, StartMode } from '@avc/core';
import {
  mayUse,
  type CommandAccess,
  type CommandCaller,
  type CommandFeature,
} from './commandAccess.js';
import type { VoiceMember } from './types.js';

/**
 * What a member's remembered settings change about the room that is being made for them: the
 * policy half of restoring them, with no I/O, so every edge unit-tests with plain objects.
 *
 * Each field is present only when it APPLIES. A field that is absent leaves the room exactly as
 * the creator channel would have made it, which is what makes "nothing applies" and "remembering
 * is off" the same room.
 */
export interface RememberedStart {
  /** The member's own name template, which the room starts with in place of the creator channel's. */
  name?: string;
  /**
   * The room's user limit. 0 is a remembered "no limit" and is a value like any other, so it
   * overrides a default limit on the creator channel, and a remembered limit of any kind wins
   * over it: the member's own earlier choice is the more specific one.
   */
  limit?: number;
  /** A start mode STRICTER than the creator channel's own. Never `public`, which is never remembered. */
  privacy?: Exclude<StartMode, 'public'>;
}

/** How strict each start mode is, so "the stricter wins" is a comparison and not a case list. */
const STRICTNESS: Record<StartMode, number> = { public: 0, locked: 1, hidden: 2 };

/**
 * Who the member is, from the snapshot of them the voice event carried, or `undefined` when it
 * carries no roles. A snapshot that was not built from a live member says nothing about them,
 * and absent Manage Channels reads as not exempt, so a rule that names them applies.
 */
export function standingOf(member: VoiceMember): CommandCaller | undefined {
  return member.roleIds === undefined
    ? undefined
    : { userId: member.id, roleIds: member.roleIds, canManage: member.canManage === true };
}

/**
 * Which of a member's remembered settings apply to the room they are making.
 *
 * **A restricted feature is inert for a denied member, saved data included** (see
 * `/restrict`): each field must pass {@link mayUse} for its own feature, so a member who was
 * denied Name after they saved one does not get it back. Name is Name, Size is Size, `private`
 * is Private and Public, and `hidden` is Hide.
 *
 * **Where a rule names the feature and the member's standing cannot be resolved, the field is
 * skipped.** The guards fail OPEN on a standing they cannot read, because a person is there to
 * be refused or let through. A restore has no one clicking, and applying a name or a lock on
 * the strength of a guess would put back exactly what an admin withdrew, so it fails CLOSED.
 * A feature no rule names needs no standing, which is why a server with no rules restores for
 * everyone whatever the snapshot carries.
 *
 * **The stricter privacy wins, and a remembered mode is never a way to a LESS private room.** A
 * remembered `private` over a creator channel that starts its rooms locked or hidden adds
 * nothing, and a remembered `hidden` adds nothing only over one that starts them hidden: over
 * a locked one it is the stricter, so it applies.
 */
export function restoreRemembered(
  prefs: MemberRoomPrefs | undefined,
  input: {
    access: CommandAccess;
    standing: CommandCaller | undefined;
    /** The creator channel's own start mode, which a remembered mode may only tighten. */
    defaultMode: StartMode;
  },
): RememberedStart {
  if (!prefs) return {};
  const { access, standing } = input;
  const permitted = (feature: CommandFeature): boolean => {
    if (access[feature] === undefined) return true;
    return standing !== undefined && mayUse(feature, standing, access);
  };

  const start: RememberedStart = {};
  if (prefs.name !== null && permitted('rename')) start.name = prefs.name;
  if (prefs.limit !== null && permitted('limit')) start.limit = prefs.limit;
  if (prefs.privacy !== null) {
    const mode: Exclude<StartMode, 'public'> = prefs.privacy === 'hidden' ? 'hidden' : 'locked';
    const feature: CommandFeature = prefs.privacy === 'hidden' ? 'hide' : 'privacy';
    if (permitted(feature) && STRICTNESS[mode] > STRICTNESS[input.defaultMode]) {
      start.privacy = mode;
    }
  }
  return start;
}
