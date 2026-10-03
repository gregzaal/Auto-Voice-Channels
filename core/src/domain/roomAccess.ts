import { z } from 'zod';

/**
 * Which saved list a member sits on.
 *
 * Mirrored by an inline literal in `db/schema.ts` (drizzle-kit's bundler cannot
 * follow cross-file imports), and `schema.unit.test.ts` asserts the two match.
 */
export const MEMBER_ACCESS_KINDS = ['trusted', 'blocked'] as const;
export type MemberAccessKind = (typeof MEMBER_ACCESS_KINDS)[number];

/**
 * How many members one owner can save on each list, per server.
 *
 * Our own product limits and not Discord's: a channel can carry 1000 permission
 * overwrites (error 30060 past that), so 25 is about what an owner can curate by
 * hand and keeps the overwrites a single room spends well inside the cap.
 */
export const MAX_SAVED_TRUSTED = 25;
export const MAX_SAVED_BLOCKED = 25;

/** What `@everyone` (or a role) had on one permission bit: an allow, a deny, or no explicit overwrite. */
const overwriteBit = z.enum(['allow', 'deny', 'none']);

/**
 * What a room's access column holds: who may see and enter it beyond the
 * creator channel's defaults, and everything the bot wrote to get there.
 *
 * **`passthrough`, here and in each nested object, for the same reason as
 * `secondaryStateSchema`**: a bare `z.object` strips unknown keys, so an older
 * instance doing a read-modify-write during a rolling deploy would silently drop
 * whatever a newer build added. Every top-level field is optional for the same
 * reason, so a build that has never heard of one still parses the rest. A nested
 * entry keeps the fields it cannot be acted on without (a role overwrite with no
 * role id restores nothing).
 *
 * A value this build cannot read (an enum member a newer build added) fails the
 * whole record and not just its field, so the repository never writes over a
 * record it could not read (see {@link readRoomAccess}).
 *
 * The record is written ahead of the Discord call it describes (a PUT is
 * idempotent, so a replay converges), and removal only ever takes back what is
 * recorded here: Discord stores no author for an overwrite, so this record is
 * the only thing that tells a grant of ours from one a human added.
 */
export const roomAccessSchema = z
  .object({
    /**
     * The room's original creator, whose saved lists apply to it. Stamped by the
     * repository from the room's `original_creator` column the first time any
     * record is written for the room (a block on a public room counts), and never
     * rewritten by `/transfer`, `/reclaim` or the owner leaving, so a caretaker's
     * edits cannot revoke the creator's guests or blocks.
     */
    creatorId: z.string().optional(),
    /** The room is hidden from the channel list. `state.private` stays true for it. */
    hidden: z.boolean().optional(),
    /**
     * What `@everyone` had on View and Connect before the room left public, so
     * going public again restores it rather than writing a neutral overwrite
     * over, say, a role-gated creator channel's inherited Connect deny.
     *
     * Every field is optional and an absent one means UNKNOWN, which restores
     * with the pre-baseline behaviour (`Connect: null`). `none` is a known
     * answer: there was no explicit overwrite. The distinction matters because a
     * room locked by an older instance has no baseline, and recording the live
     * values would store the lock itself as "the original".
     */
    baseline: z
      .object({ view: overwriteBit.optional(), connect: overwriteBit.optional() })
      .passthrough()
      .optional(),
    /**
     * Role overwrites whose inherited View allow was flipped to deny so the hide
     * is real (a role's allow beats the `@everyone` deny), each with what it was
     * so unhiding can put it back.
     */
    neutralised: z
      .array(z.object({ roleId: z.string(), view: overwriteBit }).passthrough())
      .optional(),
    /**
     * The moderator role granted View on this room, so a change or removal of
     * the setting can revoke it. Manage Channels alone does not reveal a hidden
     * room.
     */
    viewerRoleId: z.string().optional(),
    /** Members whose saved-trusted overwrites we wrote on this room. */
    trusted: z.array(z.string()).optional(),
    /** Members whose saved-blocked overwrites we wrote on this room. */
    blocked: z.array(z.string()).optional(),
    /**
     * Members admitted to this room only, whose overwrites we wrote. Kept so
     * removal is a diff against what we wrote. Dies with the room.
     */
    admitted: z.array(z.string()).optional(),
  })
  .passthrough();

export type RoomAccess = z.infer<typeof roomAccessSchema>;

/**
 * Reads a stored access blob and says whether this build could read it.
 *
 * **Never throws, on purpose.** Every room in a guild is parsed on one listing,
 * and a row schema that throws on one bad blob fails the whole listing: a newer
 * build's shape this one cannot read would take every room in the guild down
 * with it.
 *
 * The two ways of "no record" are told apart because they are not the same for a
 * WRITER. A column with nothing in it is `{ readable: true, access: null }`. A
 * blob that is there and does not parse is `{ readable: false }`: it may well be
 * a hidden room's record, so a writer must not replace it with its own idea of
 * the record, which would destroy the grants and the way back to the room's
 * original permissions.
 */
export type RoomAccessRead = { readable: true; access: RoomAccess | null } | { readable: false };

export function readRoomAccess(raw: unknown): RoomAccessRead {
  if (raw === null || raw === undefined) return { readable: true, access: null };
  const parsed = roomAccessSchema.safeParse(raw);
  return parsed.success ? { readable: true, access: parsed.data } : { readable: false };
}

/**
 * Reads a stored access blob, or `null` when there is none or it does not parse.
 *
 * For READERS, which fall back to the default behaviour for a room they cannot
 * read a record for. That is not the safe direction for every reader: a hidden
 * room whose record this build cannot read looks like a plain locked one, so
 * anything that would act on the absence of a record (create a Join channel, for
 * one) has to weigh that. Writers use {@link readRoomAccess}, which does not
 * conflate the two.
 */
export function parseRoomAccess(raw: unknown): RoomAccess | null {
  const read = readRoomAccess(raw);
  return read.readable ? read.access : null;
}
