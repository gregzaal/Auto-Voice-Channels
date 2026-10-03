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
 * whatever a newer build added. Every field is optional for the same reason, so
 * a build that has never heard of one still parses the rest.
 *
 * The record is written ahead of the Discord call it describes (a PUT is
 * idempotent, so a replay converges), and removal only ever takes back what is
 * recorded here: Discord stores no author for an overwrite, so this record is
 * the only thing that tells a grant of ours from one a human added.
 */
export const roomAccessSchema = z
  .object({
    /**
     * The room's original creator, whose saved lists apply to it. Frozen when
     * the room first leaves public, and never rewritten by `/transfer`,
     * `/reclaim` or the owner leaving, so a caretaker's edits cannot revoke the
     * creator's guests or blocks.
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
 * Reads a stored access blob, or `null` when there is none or it does not parse.
 *
 * **Never throws, on purpose.** Every room in a guild is parsed on one listing,
 * and a row schema that throws on one bad blob fails the whole listing: a newer
 * build's shape this one cannot read would take every room in the guild down
 * with it. A blob that does not parse reads as "no record", which is the safe
 * direction for the readers (they fall back to the default behaviour) and loses
 * nothing that was readable.
 */
export function parseRoomAccess(raw: unknown): RoomAccess | null {
  const parsed = roomAccessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
