import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { memberAccessLists } from '../db/schema.js';
import {
  MAX_SAVED_BLOCKED,
  MAX_SAVED_TRUSTED,
  MEMBER_ACCESS_KINDS,
  type MemberAccessKind,
} from '../domain/roomAccess.js';

/**
 * Advisory-lock namespace for one owner's saved lists, keyed per (server,
 * owner) by a hash of the pair.
 *
 * A sibling of `REFUND_CLAIM_LOCK` (0x5a7c_0003) in the same family, with its
 * own namespace rather than a slot, because it is keyed by a hashed pair and not
 * by a fixed job. A hash collision only makes two owners queue behind each
 * other for one short transaction.
 */
export const MEMBER_ACCESS_LOCK = 0x5a7c_0005;

/** One owner's saved lists, oldest entry first. */
export interface MemberAccessLists {
  trusted: string[];
  blocked: string[];
}

/**
 * What {@link MemberAccessListRepository.add} did.
 *
 * - `added`: a new entry.
 * - `flipped`: the member was on the other list and moved, which is how
 *   "trusted or blocked, never both" is kept; `from` is the list they left, so
 *   the caller can take back what that list had granted.
 * - `already`: already on this list, so a retried add is a no-op.
 * - `full`: this list is at its cap and nothing changed, including for a member
 *   who was on the other list.
 */
export type AddMemberAccessResult =
  | { outcome: 'added' }
  | { outcome: 'flipped'; from: MemberAccessKind }
  | { outcome: 'already' }
  | { outcome: 'full'; limit: number };

const isKind = (value: string): value is MemberAccessKind =>
  (MEMBER_ACCESS_KINDS as readonly string[]).includes(value);

/**
 * Splits rows into the two lists, skipping a `kind` this build does not know.
 *
 * The column is plain text, so a newer build may add a kind, and an older one
 * must read around it rather than file the member under a list they are not on.
 */
function group(rows: readonly { memberId: string; kind: string }[]): MemberAccessLists {
  const lists: MemberAccessLists = { trusted: [], blocked: [] };
  for (const row of rows) if (isKind(row.kind)) lists[row.kind].push(row.memberId);
  return lists;
}

/**
 * Repository for room owners' saved trusted and blocked lists.
 *
 * Shaped after {@link CompanionChannelRepository}, minus its fleet scoping: this
 * is customer data shared by every fleet (see `memberAccessLists` in the schema
 * for why), so there is no `scoped` helper. What stands in its place is the
 * guild: every write here is bound to one except the two erasure-on-request
 * methods, which exist precisely to span servers.
 */
export class MemberAccessListRepository {
  constructor(private readonly db: Database) {}

  /** One owner's lists in a server. */
  async get(guildId: string, ownerId: string): Promise<MemberAccessLists> {
    const rows = await this.db
      .select({ memberId: memberAccessLists.memberId, kind: memberAccessLists.kind })
      .from(memberAccessLists)
      .where(and(eq(memberAccessLists.guildId, guildId), eq(memberAccessLists.ownerId, ownerId)))
      .orderBy(asc(memberAccessLists.createdAt), asc(memberAccessLists.memberId));
    return group(rows);
  }

  /**
   * Every owner's lists in a server, in ONE query, for the converge pass.
   *
   * A per-owner `get` per room would be one read per room per sweep; this is one
   * read per guild, keyed by owner, and an owner with nobody saved has no key.
   */
  async listByGuild(guildId: string): Promise<Map<string, MemberAccessLists>> {
    const rows = await this.db
      .select({
        ownerId: memberAccessLists.ownerId,
        memberId: memberAccessLists.memberId,
        kind: memberAccessLists.kind,
      })
      .from(memberAccessLists)
      .where(eq(memberAccessLists.guildId, guildId))
      .orderBy(asc(memberAccessLists.createdAt), asc(memberAccessLists.memberId));
    const byOwner = new Map<string, MemberAccessLists>();
    for (const row of rows) {
      if (!isKind(row.kind)) continue;
      let lists = byOwner.get(row.ownerId);
      if (!lists) byOwner.set(row.ownerId, (lists = { trusted: [], blocked: [] }));
      lists[row.kind].push(row.memberId);
    }
    return byOwner;
  }

  /** How many members an owner has saved on each list in a server. */
  async counts(guildId: string, ownerId: string): Promise<{ trusted: number; blocked: number }> {
    const [row] = await this.db
      .select({
        trusted: sql<number>`count(*) filter (where ${memberAccessLists.kind} = 'trusted')::int`,
        blocked: sql<number>`count(*) filter (where ${memberAccessLists.kind} = 'blocked')::int`,
      })
      .from(memberAccessLists)
      .where(and(eq(memberAccessLists.guildId, guildId), eq(memberAccessLists.ownerId, ownerId)));
    return { trusted: row?.trusted ?? 0, blocked: row?.blocked ?? 0 };
  }

  /**
   * Puts a member on a list, taking them off the other one if they are there.
   *
   * **Serialised per (server, owner) by an advisory lock, not a row lock.** The
   * cap is a count and the count is only true if nobody else adds between
   * reading it and writing, but with one row per member there is no single row
   * to `SELECT ... FOR UPDATE`, and for an owner's FIRST entry there is no row at
   * all, so a row lock would lock nothing and two racing adds could both take the
   * last slot. A transaction-scoped advisory lock covers that case too, and is
   * released with the transaction.
   *
   * The flip is one upsert on the `(guild, owner, member)` key, so a member is on
   * one list or the other at every instant.
   *
   * Idempotent: repeating an add answers `already` and changes nothing.
   */
  async add(
    guildId: string,
    ownerId: string,
    memberId: string,
    kind: MemberAccessKind,
  ): Promise<AddMemberAccessResult> {
    return this.db.transaction(async (tx): Promise<AddMemberAccessResult> => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${MEMBER_ACCESS_LOCK}, hashtext(${guildId}::text || ':' || ${ownerId}::text))`,
      );
      const rows = await tx
        .select({ memberId: memberAccessLists.memberId, kind: memberAccessLists.kind })
        .from(memberAccessLists)
        .where(and(eq(memberAccessLists.guildId, guildId), eq(memberAccessLists.ownerId, ownerId)));
      const existing = rows.find((row) => row.memberId === memberId);
      if (existing?.kind === kind) return { outcome: 'already' };

      const limit = kind === 'trusted' ? MAX_SAVED_TRUSTED : MAX_SAVED_BLOCKED;
      if (rows.filter((row) => row.kind === kind).length >= limit) {
        return { outcome: 'full', limit };
      }

      await tx
        .insert(memberAccessLists)
        .values({ guildId, ownerId, memberId, kind })
        .onConflictDoUpdate({
          target: [
            memberAccessLists.guildId,
            memberAccessLists.ownerId,
            memberAccessLists.memberId,
          ],
          // `now()` and not a JS date, so it is on the same clock as the
          // `created_at` and `updated_at` defaults the first insert took.
          set: { kind, updatedAt: sql`now()` },
        });
      return existing ? { outcome: 'flipped', from: existing.kind } : { outcome: 'added' };
    });
  }

  /**
   * Takes a member off whichever list they are on. Resolves to that list, or
   * `null` if they were on neither, so a retried remove is a harmless no-op.
   */
  async remove(
    guildId: string,
    ownerId: string,
    memberId: string,
  ): Promise<MemberAccessKind | null> {
    const [row] = await this.db
      .delete(memberAccessLists)
      .where(
        and(
          eq(memberAccessLists.guildId, guildId),
          eq(memberAccessLists.ownerId, ownerId),
          eq(memberAccessLists.memberId, memberId),
        ),
      )
      .returning({ kind: memberAccessLists.kind });
    return row && isKind(row.kind) ? row.kind : null;
  }

  /**
   * Empties one list, or both when `kind` is omitted. Resolves to the member ids
   * that were removed, so the caller can take back exactly what they were
   * granted.
   */
  async clear(guildId: string, ownerId: string, kind?: MemberAccessKind): Promise<string[]> {
    const rows = await this.db
      .delete(memberAccessLists)
      .where(
        and(
          eq(memberAccessLists.guildId, guildId),
          eq(memberAccessLists.ownerId, ownerId),
          kind ? eq(memberAccessLists.kind, kind) : undefined,
        ),
      )
      .returning({ memberId: memberAccessLists.memberId });
    return rows.map((row) => row.memberId);
  }

  /**
   * Erasure on request, for the person who is LISTED: removes them from every
   * owner's lists in every server. Resolves to how many entries went.
   *
   * Not bound to a guild, deliberately and unlike every other write here: a
   * person asking to be forgotten is asking about all of it, and it is an
   * operator's tool, never reached from a command. Served by the `member_id`
   * index.
   */
  async deleteByMember(memberId: string): Promise<number> {
    const rows = await this.db
      .delete(memberAccessLists)
      .where(eq(memberAccessLists.memberId, memberId))
      .returning({ memberId: memberAccessLists.memberId });
    return rows.length;
  }

  /**
   * Erasure on request, for the OWNER: removes everything they have saved, in
   * every server. Resolves to how many entries went.
   *
   * Unbound to a guild for the same reason as {@link deleteByMember}, and served
   * by the index that leads with `owner_id`.
   */
  async deleteByOwner(ownerId: string): Promise<number> {
    const rows = await this.db
      .delete(memberAccessLists)
      .where(eq(memberAccessLists.ownerId, ownerId))
      .returning({ memberId: memberAccessLists.memberId });
    return rows.length;
  }
}
