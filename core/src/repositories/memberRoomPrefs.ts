import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { autoChannels, memberRoomPrefs } from '../db/schema.js';
import {
  MAX_MEMBER_PREF_LIMIT,
  MAX_MEMBER_PREF_NAME_LENGTH,
  MAX_MEMBER_PREF_STATUS_LENGTH,
  MEMBER_PREF_PRIVACIES,
  type MemberPrefPrivacy,
} from '../domain/memberRoomPrefs.js';

/**
 * What one member has remembered for rooms made from one creator channel. Each setting is
 * null when nothing is remembered for it, which is not the same as a value: a `limit` of 0
 * is a remembered "no limit". A blank status is not remembered (the owner's call, 2026-10-04):
 * it clears the status, so no caller stores a `status` of `''`.
 */
export interface MemberRoomPrefs {
  name: string | null;
  limit: number | null;
  privacy: MemberPrefPrivacy | null;
  status: string | null;
}

/**
 * What a save did.
 *
 * - `saved`: the value is stored.
 * - `cleared`: the setting was removed, which also deletes the row when it was the last one
 *   left. Idempotent: clearing something that was never saved answers the same.
 * - `notOptedIn`: the creator channel does not remember (or is not this server's, or is gone),
 *   so nothing was written. This is the common answer on a server that never turned it on.
 * - `tooLong`: the name is over {@link MAX_MEMBER_PREF_NAME_LENGTH}, or the status over
 *   {@link MAX_MEMBER_PREF_STATUS_LENGTH}. Refused rather than cut: a template cut at a
 *   character limit is a different template, and the member is better served by not having it
 *   remembered than by having a broken one.
 * - `invalid`: a value that is not a setting at all (an empty name, a limit Discord would not
 *   accept), so a bug in a caller cannot store something a later restore would choke on.
 */
export type SaveMemberPrefResult =
  | { status: 'saved' }
  | { status: 'cleared' }
  | { status: 'notOptedIn' }
  | { status: 'tooLong'; max: number }
  | { status: 'invalid' };

type PrefColumn = 'name_template' | 'user_limit' | 'privacy' | 'status_template';

const isPrivacy = (value: string | null): value is MemberPrefPrivacy =>
  value !== null && (MEMBER_PREF_PRIVACIES as readonly string[]).includes(value);

/** A name a save would have accepted, so a row written any other way reads as nothing. */
const isName = (value: string | null): value is string =>
  value !== null && value.trim() !== '' && value.length <= MAX_MEMBER_PREF_NAME_LENGTH;

/** A limit a save would have accepted, for the same reason. */
const isLimit = (value: number | null): value is number =>
  value !== null && Number.isInteger(value) && value >= 0 && value <= MAX_MEMBER_PREF_LIMIT;

/** A status a save would have accepted, for the same reason. An empty one is accepted, though no caller saves one. */
const isStatus = (value: string | null): value is string =>
  value !== null && value.length <= MAX_MEMBER_PREF_STATUS_LENGTH;

/**
 * What one pass of the orphan sweep did, in rows.
 *
 * - `marked`: rows whose creator channel is missing, put on the grace clock for the first time.
 * - `restored`: rows whose creator channel is back, taken off the clock.
 * - `removed`: rows that were orphaned for the whole grace and are gone.
 */
export interface OrphanSweepResult {
  marked: number;
  restored: number;
  removed: number;
}

/**
 * Repository for what members have remembered about their own rooms, per creator channel.
 *
 * Shaped after {@link MemberAccessListRepository}: customer data shared by every fleet, so
 * there is no `scoped` helper, and the guild stands in its place. Every write is bound to one
 * except the two that exist to span servers (erasure by member, and the orphan sweep).
 *
 * **A save checks the opt-in and writes in ONE statement.** The creator channel's
 * `rememberPrefs` flag lives in `auto_channels.template`, and reading it first would cost an
 * uncached `auto_channels` read on every `/name`, `/limit` and `/private` in every server,
 * nearly all of which never turned it on. So the write is `INSERT ... SELECT ... WHERE
 * EXISTS (the creator channel, in this guild, with the flag)`, and it writes nothing for a
 * creator channel that does not remember. That is also what makes a replay safe.
 *
 * **Per field, so a save never reads or rewrites another setting.** Each is an upsert that
 * sets only its own column and `updated_at`: a name saved from one command cannot undo a
 * limit saved from another a moment earlier, and no caller needs the row to change one field.
 */
export class MemberRoomPrefsRepository {
  constructor(private readonly db: Database) {}

  /** What one member has remembered for one creator channel, or `undefined` when nothing. */
  async get(primaryChannelId: string, userId: string): Promise<MemberRoomPrefs | undefined> {
    const [row] = await this.db
      .select({
        name: memberRoomPrefs.nameTemplate,
        limit: memberRoomPrefs.userLimit,
        privacy: memberRoomPrefs.privacy,
        status: memberRoomPrefs.statusTemplate,
      })
      .from(memberRoomPrefs)
      .where(
        and(
          eq(memberRoomPrefs.primaryChannelId, primaryChannelId),
          eq(memberRoomPrefs.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    // The columns are plain text and a number, so a newer build may store a privacy this one
    // does not know, and a hand edit or another build may leave a limit Discord refuses, an
    // empty name or an overlong status. A reader must read around each rather than act on a
    // value it cannot apply, which is what a save already refuses to store.
    const prefs: MemberRoomPrefs = {
      name: isName(row.name) ? row.name : null,
      limit: isLimit(row.limit) ? row.limit : null,
      privacy: isPrivacy(row.privacy) ? row.privacy : null,
      status: isStatus(row.status) ? row.status : null,
    };
    return prefs.name === null &&
      prefs.limit === null &&
      prefs.privacy === null &&
      prefs.status === null
      ? undefined
      : prefs;
  }

  /**
   * Remembers the name template a member set, or forgets it (`null`).
   *
   * Only ever called with a name the member set themselves: a name that was merely
   * inherited from the creator channel is not theirs to have remembered.
   */
  async saveName(
    guildId: string,
    primaryChannelId: string,
    userId: string,
    name: string | null,
  ): Promise<SaveMemberPrefResult> {
    if (name === null) return this.clearField(guildId, primaryChannelId, userId, 'name_template');
    if (name.length > MAX_MEMBER_PREF_NAME_LENGTH) {
      return { status: 'tooLong', max: MAX_MEMBER_PREF_NAME_LENGTH };
    }
    // A NUL is the one character Postgres refuses in text, and an empty template is a reset.
    if (name.trim() === '' || name.includes('\u0000')) return { status: 'invalid' };
    return this.upsertField(guildId, primaryChannelId, userId, 'name_template', sql`${name}::text`);
  }

  /** Remembers the room's user limit (0 is "no limit"), or forgets it (`null`). */
  async saveLimit(
    guildId: string,
    primaryChannelId: string,
    userId: string,
    limit: number | null,
  ): Promise<SaveMemberPrefResult> {
    if (limit === null) return this.clearField(guildId, primaryChannelId, userId, 'user_limit');
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_MEMBER_PREF_LIMIT) {
      return { status: 'invalid' };
    }
    return this.upsertField(
      guildId,
      primaryChannelId,
      userId,
      'user_limit',
      sql`${limit}::smallint`,
    );
  }

  /** Remembers that the member's rooms start private or hidden, or forgets it (`null`). */
  async savePrivacy(
    guildId: string,
    primaryChannelId: string,
    userId: string,
    privacy: MemberPrefPrivacy | null,
  ): Promise<SaveMemberPrefResult> {
    if (privacy === null) return this.clearField(guildId, primaryChannelId, userId, 'privacy');
    if (!isPrivacy(privacy)) return { status: 'invalid' };
    return this.upsertField(guildId, primaryChannelId, userId, 'privacy', sql`${privacy}::text`);
  }

  /**
   * Remembers the voice status template a member set, or forgets it (`null`).
   *
   * Under the same rule as a name: only ever one the member set themselves. The caller passes
   * `null` for a blank status, which clears what was remembered (the owner's call, 2026-10-04),
   * so an empty string is never saved in practice. This method would still store one as "no
   * status".
   */
  async saveStatus(
    guildId: string,
    primaryChannelId: string,
    userId: string,
    status: string | null,
  ): Promise<SaveMemberPrefResult> {
    if (status === null) {
      return this.clearField(guildId, primaryChannelId, userId, 'status_template');
    }
    if (status.length > MAX_MEMBER_PREF_STATUS_LENGTH) {
      return { status: 'tooLong', max: MAX_MEMBER_PREF_STATUS_LENGTH };
    }
    if (status.includes('\u0000')) return { status: 'invalid' };
    return this.upsertField(
      guildId,
      primaryChannelId,
      userId,
      'status_template',
      sql`${status}::text`,
    );
  }

  /**
   * Writes one setting, and only for a creator channel that remembers.
   *
   * The column is spliced in with `sql.raw`, which is safe only because it is one of the four
   * literals this file passes, never text from a caller. The values are parameters, and the
   * guild reaches the statement twice: in the opt-in check, which also pins the creator
   * channel to this server, and on the conflict path, so a row that somehow belongs to
   * another server is never updated by this one.
   *
   * The opt-in is the JSON boolean `true` and nothing else, which is how the bot reads it
   * (`=== true`). `->>` would also take the string "true", which an older build's `/import`
   * can carry in unvalidated, and the editor would show Off for a creator channel that saves.
   */
  private async upsertField(
    guildId: string,
    primaryChannelId: string,
    userId: string,
    column: PrefColumn,
    value: SQL,
  ): Promise<SaveMemberPrefResult> {
    const col = sql.raw(`"${column}"`);
    const result = await this.db.execute(sql`
      INSERT INTO member_room_prefs (primary_channel_id, user_id, guild_id, ${col}, updated_at)
      SELECT ${primaryChannelId}::text, ${userId}::text, ${guildId}::text, ${value}, now()
       WHERE EXISTS (
         SELECT 1 FROM auto_channels
          WHERE ${eq(autoChannels.channelId, primaryChannelId)}
            AND ${eq(autoChannels.guildId, guildId)}
            AND ${autoChannels.template}->'rememberPrefs' = 'true'::jsonb
       )
      ON CONFLICT (primary_channel_id, user_id) DO UPDATE
        SET ${col} = EXCLUDED.${col}, updated_at = now()
        WHERE ${eq(memberRoomPrefs.guildId, guildId)}
      RETURNING 1
    `);
    return result.rows.length > 0 ? { status: 'saved' } : { status: 'notOptedIn' };
  }

  /**
   * Forgets one setting, and deletes the row when it was the last one left.
   *
   * **Not gated on the opt-in, unlike a save.** A clear only ever removes what a member
   * already has, so it creates nothing for an opted-out creator channel to refuse, and
   * refusing it would leave a dormant value that comes back, unasked, the day an admin
   * turns the feature on again. It is bound to the guild all the same.
   *
   * Two statements in one transaction: null the setting, then delete the row if that left
   * nothing. They are not one statement because a deciding snapshot is the hazard. A single
   * statement that chose between deleting and updating from the other settings as they
   * stood when it started would, racing a save of another setting, match neither branch
   * once that save committed, and a clear that answered `cleared` would have kept the value.
   * The update takes the row lock and re-reads the row, so the delete after it sees the
   * settings as they are now, and nobody else sees a row with nothing in it. A row that
   * already had nothing here is left untouched, so a replay does not move `updated_at`.
   *
   * **A read comes first, and a clear that finds nothing opens no transaction.** Nearly every
   * clear finds nothing: a name reset in a room that never had one remembered, a `/public` in a
   * server that never turned this on. Each runs inside a guild's queued task, so each must cost
   * one statement and not the four of a transaction (begin, update, delete, commit). The read is
   * not a decision the writes rely on: a save that lands just after it is a save that came
   * after this clear, and the transaction below still re-reads the row under its lock.
   */
  private async clearField(
    guildId: string,
    primaryChannelId: string,
    userId: string,
    column: PrefColumn,
  ): Promise<SaveMemberPrefResult> {
    const mine = and(
      eq(memberRoomPrefs.primaryChannelId, primaryChannelId),
      eq(memberRoomPrefs.userId, userId),
      eq(memberRoomPrefs.guildId, guildId),
    );
    const col = sql.raw(`"${column}"`);
    const held = await this.db.execute(sql`
      SELECT 1 FROM member_room_prefs WHERE ${mine} AND ${col} IS NOT NULL LIMIT 1
    `);
    if (held.rows.length === 0) return { status: 'cleared' };
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE member_room_prefs SET ${col} = NULL, updated_at = now()
         WHERE ${mine} AND ${col} IS NOT NULL
      `);
      await tx.execute(sql`
        DELETE FROM member_room_prefs
         WHERE ${mine} AND name_template IS NULL AND user_limit IS NULL AND privacy IS NULL
           AND status_template IS NULL
      `);
    });
    return { status: 'cleared' };
  }

  /**
   * How many members have something remembered for one creator channel, for the admin's
   * readout. Counts rows, which each hold something by construction.
   */
  async countByPrimary(guildId: string, primaryChannelId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberRoomPrefs)
      .where(
        and(
          eq(memberRoomPrefs.guildId, guildId),
          eq(memberRoomPrefs.primaryChannelId, primaryChannelId),
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * The admin's "Clear saved settings": removes every member's remembered settings for one
   * creator channel. Resolves to how many members' rows went, so the reply can say.
   *
   * Bound to the guild as well as the creator channel, so an admin of one server cannot clear
   * another's by naming its channel, and it works while the feature is off: the rows are
   * dormant, not gone, and an admin who turned it off may want them gone.
   */
  async clearByPrimary(guildId: string, primaryChannelId: string): Promise<number> {
    const rows = await this.db
      .delete(memberRoomPrefs)
      .where(
        and(
          eq(memberRoomPrefs.guildId, guildId),
          eq(memberRoomPrefs.primaryChannelId, primaryChannelId),
        ),
      )
      .returning({ userId: memberRoomPrefs.userId });
    return rows.length;
  }

  /**
   * Erasure on request, for a server: removes everything remembered for every member there.
   * Resolves to how many rows went. An operator's tool, not reachable from a command.
   */
  async deleteByGuild(guildId: string): Promise<number> {
    const rows = await this.db
      .delete(memberRoomPrefs)
      .where(eq(memberRoomPrefs.guildId, guildId))
      .returning({ userId: memberRoomPrefs.userId });
    return rows.length;
  }

  /**
   * Erasure on request, for the MEMBER: removes everything remembered about them, across
   * every creator channel and server. Resolves to how many rows went.
   *
   * Not bound to a guild, deliberately and unlike every other write here: a person asking
   * to be forgotten is asking about all of it. An operator's tool, never reached from a
   * command, served by the `user_id` index.
   */
  async deleteByUser(userId: string): Promise<number> {
    const rows = await this.db
      .delete(memberRoomPrefs)
      .where(eq(memberRoomPrefs.userId, userId))
      .returning({ userId: memberRoomPrefs.userId });
    return rows.length;
  }

  /**
   * The orphan sweep, one bounded pass: puts rows whose creator channel is missing on a grace
   * clock, takes rows whose creator channel is back off it, and deletes the rows that have
   * been on it for at least `graceMs`. Each step touches at most `limit` rows.
   *
   * **The whole predicate is in SQL**, as `CompanionChannelRepository.listOrphans` does,
   * for the same reason: it needs no Discord cache, no shard and no lease, so it reaches
   * rows no per-guild pass can see. The creator channel check is deliberately not
   * fleet-scoped, because a creator channel id is the primary key of `auto_channels` and
   * belongs to exactly one fleet, so a row that exists in any of them is the creator
   * channel these rows name, and scoping it would invent orphans out of another fleet's.
   *
   * **The grace runs from `orphaned_at`, which the sweep stamps when it first finds the
   * creator channel missing, and not from `updated_at`.** See
   * {@link MEMBER_PREFS_ORPHAN_GRACE_MS}: a creator channel dropped by `/import` can come
   * back from its snapshot, and the snapshot carries no remembered settings. `updated_at`
   * moves only when the member saves, so a row last saved a month ago would have been
   * deleted the hour its creator channel went. The stamp is cleared when the creator
   * channel is back, so a later removal starts a fresh grace. Delete also re-checks that the
   * creator channel is still missing, so a creator channel that returned after the stamp
   * was read cannot lose its rows.
   *
   * Idempotent, and safe for every instance of every fleet to run: each step picks its rows
   * with `FOR UPDATE SKIP LOCKED`, so two sweeps that overlap take disjoint batches instead of
   * waiting on, or deadlocking over, each other's rows, and a repeat finds nothing to do.
   *
   * Not bound to a guild, like the erasures: it spans servers by design, and it is the
   * sweep's, not a command's. `limit` bounds one pass and the job runs again, oldest first.
   * There is no index on these columns, so a pass scans the table, which is bounded by the
   * members who have changed a room and is run about once an hour.
   */
  async sweepOrphans(opts: { graceMs: number; limit: number }): Promise<OrphanSweepResult> {
    const limit = Math.trunc(opts.limit);
    if (!(limit > 0)) return { marked: 0, restored: 0, removed: 0 };
    const graceMs = Math.max(0, opts.graceMs);
    const restored = await this.db.execute(sql`
      UPDATE member_room_prefs SET orphaned_at = NULL
       WHERE (primary_channel_id, user_id) IN (
         SELECT m.primary_channel_id, m.user_id
           FROM member_room_prefs m
          WHERE m.orphaned_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM auto_channels a WHERE a.channel_id = m.primary_channel_id)
          LIMIT ${limit}
            FOR UPDATE OF m SKIP LOCKED
       )
      RETURNING 1
    `);
    const marked = await this.db.execute(sql`
      UPDATE member_room_prefs SET orphaned_at = now()
       WHERE (primary_channel_id, user_id) IN (
         SELECT m.primary_channel_id, m.user_id
           FROM member_room_prefs m
          WHERE m.orphaned_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM auto_channels a WHERE a.channel_id = m.primary_channel_id)
          ORDER BY m.updated_at
          LIMIT ${limit}
            FOR UPDATE OF m SKIP LOCKED
       )
      RETURNING 1
    `);
    const removed = await this.db.execute(sql`
      DELETE FROM member_room_prefs
       WHERE (primary_channel_id, user_id) IN (
         SELECT m.primary_channel_id, m.user_id
           FROM member_room_prefs m
          WHERE m.orphaned_at < now() - (${graceMs}::double precision * interval '1 millisecond')
            AND NOT EXISTS (SELECT 1 FROM auto_channels a WHERE a.channel_id = m.primary_channel_id)
          ORDER BY m.orphaned_at
          LIMIT ${limit}
            FOR UPDATE OF m SKIP LOCKED
       )
      RETURNING 1
    `);
    return {
      marked: marked.rows.length,
      restored: restored.rows.length,
      removed: removed.rows.length,
    };
  }
}
