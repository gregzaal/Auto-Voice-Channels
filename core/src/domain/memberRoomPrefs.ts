/**
 * Which privacy a member's remembered room settings can hold.
 *
 * Mirrored by an inline literal in `db/schema.ts` (drizzle-kit's bundler cannot
 * follow cross-file imports), and `schema.unit.test.ts` asserts the two match.
 *
 * `public` is never remembered: it is what every room is until somebody changes it, so
 * remembering it would only pin a member to the open default after an admin chose
 * a private one for the creator channel.
 */
export const MEMBER_PREF_PRIVACIES = ['private', 'hidden'] as const;
export type MemberPrefPrivacy = (typeof MEMBER_PREF_PRIVACIES)[number];

/**
 * The longest name template one member can have remembered, which is the longest the
 * `/name` editor accepts. The panel's Name box stops at 100, so the two differ on purpose:
 * a saved template longer than the box is still a template the member wrote with `/name`.
 */
export const MAX_MEMBER_PREF_NAME_LENGTH = 1000;

/** The most people Discord lets into a voice channel, so the largest limit worth remembering. */
export const MAX_MEMBER_PREF_LIMIT = 99;

/**
 * How long a row whose creator channel no longer exists is kept before the orphan sweep
 * deletes it.
 *
 * The grace is what keeps `/import` undoable. An import that drops a creator channel is
 * one way, with the snapshot it takes first as the only route back, and that snapshot does
 * not carry anyone's remembered settings. Deleting those rows the moment the creator
 * channel went would make the undo lose them for good, so they wait out this long first.
 */
export const MEMBER_PREFS_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most rows one pass of the orphan sweep deletes. A pass runs about once an hour, so a
 * backlog (an import that dropped a busy creator channel, say) clears over a few hours and
 * never as one large delete on a table other fleets are writing to.
 */
export const MEMBER_PREFS_ORPHAN_SWEEP_LIMIT = 500;
