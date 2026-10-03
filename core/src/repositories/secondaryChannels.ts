import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { parseRoomAccess, readRoomAccess, type RoomAccess } from '../domain/roomAccess.js';
import { secondaryChannels } from '../db/schema.js';

/**
 * **`passthrough` is load-bearing for expand/contract (golden rule 3), and this
 * is the fourth jsonb column schema to need it.** A bare `z.object` STRIPS
 * unknown keys, so during a rolling deploy an old instance doing any
 * read-modify-write on this column (a `/name` edit, a roster update, a privacy
 * toggle) silently drops whatever a newer build wrote. `preseed.ts` already
 * works around exactly this by spreading the raw object.
 *
 * It ships AHEAD of the first field that depends on it, deliberately: the
 * stripper is the OLD image, which by definition does not carry this change, so
 * adding a field in the same release would still lose it for the length of the
 * rollout.
 */
export const secondaryStateSchema = z
  .object({
    /** Last rendered channel name. */
    name: z.string().optional(),
    /** Last rendered voice-channel status (for change detection; '' = cleared). */
    status: z.string().optional(),
    /** Per-channel voice-status template override (set via `/name` status edit). */
    statusTemplate: z.string().optional(),
    /** Whether the channel was created private (locked to @everyone). */
    private: z.boolean().optional(),
    /** Stable sibling index (`i`) captured at creation, for `##`-style tokens. */
    index: z.number().int().min(0).optional(),
    /**
     * Per-channel name-template override set via `/name`. When present it replaces
     * the primary's template for this channel only; `/name reset` clears it. It is
     * still re-evaluated on game/membership changes (it may contain tokens).
     */
    template: z.string().optional(),
    /**
     * Stable random seed for `[[random]]` template picks, generated once at
     * creation so a channel's random emoji/word never changes (no rename churn).
     */
    seed: z.number().int().optional(),
    /**
     * Member ids in voice-join (arrival) order, maintained as members come and go.
     * Discord exposes no voice-join timestamp, so we track order ourselves to pick
     * the longest-present member as the next owner when the owner leaves. Self-
     * heals after a restart/gap (present-but-untracked members append in cache
     * order). Stale ids (members who left) are pruned on the next leave.
     */
    roster: z.array(z.string()).optional(),
    /**
     * The RAW display name of whoever created the room, for
     * `@@original_creator@@`.
     *
     * Cached because the original creator has usually left by the time the
     * token is rendered, and a member fetch on the render path is not an
     * option. Raw, not resolved: `displayName()` applies the per-user `/nick`
     * override, so storing its output would freeze a nickname the server can
     * still change.
     *
     * Only safe to write because this schema is `passthrough` (above), which
     * shipped a release earlier for exactly this reason: the stripper during a
     * rolling deploy is the OLD image.
     */
    originalCreatorName: z.string().optional(),
    /**
     * The room control panel message posted into the room's chat at creation.
     *
     * Two jobs. It is the replay guard, so a create that runs twice (a
     * caught-up reconcile, a redelivered voice event) does not post a second
     * panel into the same room. And it is how the panel is found again: the
     * panel follows its room, so it is EDITED whenever the room's privacy,
     * owner or size changes, or an admin changes what the panel carries.
     *
     * Written through {@link SecondaryChannelRepository.setControlPanelMessage}
     * and {@link SecondaryChannelRepository.clearControlPanelMessage}, never
     * through `updateState`: those merge server side, where `updateState`
     * replaces the whole column, so a read-modify-write around a Discord round
     * trip would discard whatever else landed in the meantime. **A caller that
     * does both must refresh the panel AFTER its `updateState`**, or the
     * replace reverts the merge - which is exactly what `rerenderSecondary` did
     * until the ordering was fixed.
     */
    controlPanelMessageId: z.string().optional(),
    /**
     * Where that panel was posted: the room itself, or its companion text
     * channel when the creator channel has those switched on.
     *
     * Recorded rather than recomputed because the answer can change after the
     * fact - a companion the reconciler builds later does not move the panel -
     * so the stored id is the only honest record of where it went, and the only
     * way a later edit knows where to aim.
     */
    controlPanelChannelId: z.string().optional(),
    /**
     * A digest of the panel as it was last rendered, so a re-render that would
     * change nothing issues no request.
     *
     * The panel follows the room - its privacy button, its owner, its size -
     * so it is re-derived on every `rerenderSecondary`, including the bulk
     * sweeps that walk a whole guild. Without this every one of those would be
     * an edit per room. With it they are a hash per room and no traffic at all.
     */
    controlPanelHash: z.string().optional(),
  })
  .passthrough();

export type SecondaryState = z.infer<typeof secondaryStateSchema>;

export const secondaryChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  primaryChannelId: z.string(),
  ownerId: z.string().nullable(),
  originalCreator: z.string().nullable(),
  state: secondaryStateSchema,
  /**
   * `null` when none was written OR when the stored blob does not parse, and it
   * never throws. This schema runs on every row of {@link
   * SecondaryChannelRepository.listByGuild}, so a throw here would fail the
   * listing for the whole guild over one room's blob, and a newer build's shape
   * this one cannot read is exactly how that would happen during a rolling deploy.
   */
  access: z.unknown().transform((raw) => parseRoomAccess(raw)),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SecondaryChannelRow = z.infer<typeof secondaryChannelRowSchema>;

/**
 * What an access write did, which a caller has to look at before it goes on to
 * Discord.
 *
 * The record is written ahead of the overwrite it describes, so a caller that
 * carries on after anything but `written` makes a grant that is recorded
 * nowhere, and a grant that is not recorded is one no later removal will ever
 * take back.
 *
 * - `written`: the record as stored, or `null` when it was cleared.
 * - `missing`: no such room for this fleet (deleted meanwhile, or another
 *   fleet's). Nothing was decided or written.
 * - `unreadable`: the room has a record this build cannot read, which may be a
 *   hidden room's. Nothing was decided or written, because replacing it would
 *   destroy what a newer build recorded. The caller refuses and leaves the room
 *   to a build that can read it.
 */
export type AccessWriteResult =
  | { status: 'written'; access: RoomAccess | null }
  | { status: 'missing' }
  | { status: 'unreadable' };

/**
 * A change to a room's `state` and `access` that must land as one write.
 *
 * `private` lives in `state` (older builds read it) and `hidden` lives in
 * `access`. One statement keeps a transition from being half applied: a crash,
 * or a reader, between two statements would see a locked room that is not hidden
 * or a hidden room that is not locked, and the hide would be re-run or
 * "repaired" from the wrong half.
 *
 * **That is all it guarantees.** It does not stop another writer reverting
 * `private` afterwards: {@link SecondaryChannelRepository.updateState} still
 * replaces the whole `state` column from an older snapshot, so a hidden room can
 * end up with `access.hidden` and no `state.private`. A reader therefore treats
 * `hidden` as implying locked and does not trust `private` alone, and whatever
 * sweeps rooms puts `private` back.
 */
export interface AccessTransition {
  /**
   * Keys merged into `state` server side (`state || patch`). Everything else in
   * it is left alone.
   *
   * Checked against the state schema before anything is written: a value of the
   * wrong type would make this room's row fail to parse, and every listing of the
   * guild parses every row.
   */
  statePatch?: Partial<SecondaryState>;
  /** Keys taken out of `state` (`state - key`), after the patch is applied. */
  stateRemove?: readonly string[];
  /**
   * The new access record, decided from the record as it stands under a row
   * lock, or `null` to clear it. There is deliberately no form that takes a
   * value: a record written without reading the current one loses whatever a
   * concurrent writer just added (the lists, a baseline already captured).
   *
   * Runs synchronously inside the lock, so keep it pure: no Discord call, no
   * await.
   */
  access: (current: RoomAccess | null) => RoomAccess | null;
}

/**
 * Makes sure a record being written names the creator it belongs to, and never
 * moves one it already names.
 *
 * The creator carries forward from the stored record first, so a writer that
 * builds the new record from scratch and forgets to spread the old one does not
 * hand the room to whoever the column names after a `/transfer`. Only a record
 * that has never named one is stamped from the column. That is the one place the
 * guarantee is kept: {@link SecondaryChannelRepository.listByOriginalCreator}
 * falls back to the column for a record without one, and the column moves.
 */
function keepCreator(
  next: RoomAccess | null,
  current: RoomAccess | null,
  originalCreator: string | null,
): RoomAccess | null {
  if (next === null || next.creatorId !== undefined) return next;
  const creatorId = current?.creatorId ?? originalCreator;
  return creatorId === null || creatorId === undefined ? next : { ...next, creatorId };
}

export interface CreateSecondaryInput {
  channelId: string;
  guildId: string;
  primaryChannelId: string;
  ownerId?: string;
  /** The channel's original creator; defaults to `ownerId` when omitted. */
  originalCreator?: string;
  state?: SecondaryState;
  /**
   * Overrides the DB default. Only the legacy importer sets this, and it must:
   * the reconciler derives `##` numbering from sibling `createdAt` order, so
   * adopting channels with today's date would renumber every room in a guild on
   * the first reconcile. It passes the channel's real creation time, recovered
   * from its snowflake.
   */
  createdAt?: Date;
}

/**
 * Repository for bot-managed temporary voice channels (secondaries), tracked for
 * reconciliation. All operations are idempotent so events can be safely replayed.
 */
export class SecondaryChannelRepository {
  constructor(
    private readonly db: Database,
    private readonly fleet: Fleet = DEFAULT_FLEET,
  ) {}

  /**
   * ANDs this repository's fleet onto a predicate.
   *
   * Every read goes through it, including lookups by channel id, which look
   * safe because a snowflake is globally unique and are not: two fleets can
   * share a guild, and an unscoped `get(channelId)` would hand one fleet the
   * other's row, after which it would happily rename or delete a channel it
   * does not own.
   */
  private scoped(...conditions: (SQL | undefined)[]) {
    return and(eq(secondaryChannels.fleet, this.fleet), ...conditions);
  }

  /**
   * Records a new secondary. Create-once: idempotent on the channel id, and on
   * conflict it does NOT touch the existing row — so a replayed create can't
   * clobber live state (roster, seed, owner, private flag). Mutations are owned by
   * {@link updateState}/{@link setOwner}.
   */
  async create(input: CreateSecondaryInput): Promise<SecondaryChannelRow> {
    const [row] = await this.db
      .insert(secondaryChannels)
      .values({
        channelId: input.channelId,
        guildId: input.guildId,
        fleet: this.fleet,
        primaryChannelId: input.primaryChannelId,
        ownerId: input.ownerId ?? null,
        // The creator is the first owner unless a specific one is given.
        originalCreator: input.originalCreator ?? input.ownerId ?? null,
        state: input.state ?? {},
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .onConflictDoNothing({ target: secondaryChannels.channelId })
      .returning();
    if (row) return secondaryChannelRowSchema.parse(row);
    // Already existed — return the live row unchanged rather than overwriting it.
    const existing = await this.get(input.channelId);
    if (!existing) throw new Error(`secondary ${input.channelId} vanished during create`);
    return existing;
  }

  async get(channelId: string): Promise<SecondaryChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)))
      .limit(1);
    return row ? secondaryChannelRowSchema.parse(row) : undefined;
  }

  async isSecondary(guildId: string, channelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ channelId: secondaryChannels.channelId })
      .from(secondaryChannels)
      .where(
        this.scoped(
          and(eq(secondaryChannels.guildId, guildId), eq(secondaryChannels.channelId, channelId)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listByGuild(guildId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.guildId, guildId)));
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  async listByPrimary(primaryChannelId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.primaryChannelId, primaryChannelId)));
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  /** Secondaries a member currently owns in a guild (for `/nick` re-render). */
  async listByOwner(guildId: string, ownerId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(
        this.scoped(
          and(eq(secondaryChannels.guildId, guildId), eq(secondaryChannels.ownerId, ownerId)),
        ),
      );
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  /**
   * Rooms whose saved lists belong to `creatorId`: the ones to apply a change to
   * a list to, live.
   *
   * The creator is `access.creatorId` where the room has one, which the
   * repository stamps the first time any record is written for the room, and the
   * `original_creator` column otherwise. Not the column alone: `/transfer` moves
   * the column on purpose, and a room's guests and blocks must not follow it.
   * Not the access record alone: a room with none (never locked, never blocked
   * against) still takes a block.
   *
   * So a handover BEFORE a room's first record gives it to the new creator, and
   * one after it does not.
   *
   * The predicate is in SQL, like {@link listByOwner}, and `->>` on a blob that
   * is not an object yields null rather than an error, so a malformed record
   * falls through to the column.
   */
  async listByOriginalCreator(guildId: string, creatorId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(
        this.scoped(
          and(
            eq(secondaryChannels.guildId, guildId),
            sql`coalesce(${secondaryChannels.access}->>'creatorId', ${secondaryChannels.originalCreator}) = ${creatorId}`,
          ),
        ),
      );
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  /** Distinct guild ids that currently have at least one tracked secondary. */
  async listGuildIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ guildId: secondaryChannels.guildId })
      .from(secondaryChannels)
      .where(this.scoped());
    return rows.map((r) => r.guildId);
  }

  /** Number of secondaries currently spawned from a primary. */
  /**
   * Just the channel ids of a primary's rooms, oldest first.
   *
   * Deliberately not {@link listByPrimary}: this runs on the join path, where a
   * full row means every sibling's `state` jsonb over the wire plus a zod parse
   * each, and where one corrupt `state` would block room creation for the whole
   * primary rather than for the one room it belongs to.
   *
   * Ordered in SQL, including the id tie-break, because more than one caller
   * decides something from this order and `created_at` is only millisecond
   * precision: two rooms created inside one millisecond (the importer derives
   * both from a snowflake) would otherwise fall back to Postgres heap order,
   * which moves whenever a row is rewritten.
   */
  async listIdsByPrimary(primaryChannelId: string): Promise<string[]> {
    const rows = await this.db
      .select({ channelId: secondaryChannels.channelId })
      .from(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.primaryChannelId, primaryChannelId)))
      .orderBy(asc(secondaryChannels.createdAt), asc(secondaryChannels.channelId));
    return rows.map((r) => r.channelId);
  }

  async countByPrimary(primaryChannelId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.primaryChannelId, primaryChannelId)));
    return row?.n ?? 0;
  }

  /** Removes a secondary record. Idempotent (no error if already gone). */
  async remove(channelId: string): Promise<void> {
    await this.db
      .delete(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
  }

  /**
   * Replaces the whole `state` column. It does not touch `access`: a stale
   * snapshot written back here cannot revert an access change, which is why
   * access is a column of its own and not a key in this blob. It CAN revert
   * `private`, which still lives here (see {@link AccessTransition}).
   */
  async updateState(channelId: string, state: SecondaryState): Promise<void> {
    await this.db
      .update(secondaryChannels)
      .set({ state, updatedAt: new Date() })
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
  }

  /**
   * Records where the room's control panel was posted, merging into `state`
   * rather than replacing it.
   *
   * **A merge, deliberately, and not {@link updateState}.** The panel is posted
   * over a Discord round trip that takes tens to hundreds of milliseconds, and
   * the create path has two other writers active in that window: the roster
   * append and, on a default-private room, the privacy toggle. A
   * read-modify-write around the post would carry a `state` read from before
   * it and silently discard whichever of them landed first, taking the roster
   * (which decides who inherits the room) with it. `||` merges server side, so
   * only these two keys are touched. Same shape and same reason as
   * {@link setOwnerAndCreator}.
   *
   * `updatedAt` is deliberately NOT bumped: this records something about a
   * message, not about the channel, and the rename paths read `updatedAt`.
   */
  async setControlPanelMessage(
    channelId: string,
    messageId: string,
    panelChannelId: string,
    hash: string,
  ): Promise<void> {
    await this.db
      .update(secondaryChannels)
      .set({
        state: sql`coalesce(${secondaryChannels.state}, '{}'::jsonb) || ${JSON.stringify({
          controlPanelMessageId: messageId,
          controlPanelChannelId: panelChannelId,
          controlPanelHash: hash,
        })}::jsonb`,
      })
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
  }

  /**
   * Forgets a room's control panel, after an edit proved the message is gone.
   *
   * A merge cannot delete a key, so this is the one panel write that has to
   * name the survivors: `state - 'key'` removes them server side, which keeps
   * it a single statement and leaves everything else in the blob untouched.
   */
  async clearControlPanelMessage(channelId: string): Promise<void> {
    await this.db
      .update(secondaryChannels)
      .set({
        state: sql`coalesce(${secondaryChannels.state}, '{}'::jsonb)
          - 'controlPanelMessageId' - 'controlPanelChannelId' - 'controlPanelHash'`,
      })
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
  }

  /**
   * The room's access record, or `null`: it has none, it does not parse, or
   * there is no such room (this does not tell those apart; {@link get} does).
   *
   * Reads the one column, so it does not carry the room's `state` over the wire
   * or parse it, and one corrupt `state` cannot make this fail.
   */
  async getAccess(channelId: string): Promise<RoomAccess | null> {
    const [row] = await this.db
      .select({ access: secondaryChannels.access })
      .from(secondaryChannels)
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)))
      .limit(1);
    return row ? parseRoomAccess(row.access) : null;
  }

  /**
   * The one place the access column is written: reads the record under a row
   * lock, lets `decide` change it, and writes the result (and `state`, when a
   * transition has a change for it) in one `UPDATE`.
   *
   * **A read-modify-write that cannot lose a concurrent writer.** `trusted`,
   * `blocked` and `admitted` are arrays inside one blob, so two callers each
   * reading it, adding a member and writing it back would drop one of the two,
   * and an entry lost here is an overwrite that no later removal will ever
   * revoke (removal only takes back what is recorded). `SELECT ... FOR UPDATE`
   * makes the second caller wait for the first and read what it wrote.
   *
   * The same select takes `original_creator`, so {@link keepCreator} can name the
   * room's creator in the record without a second read.
   */
  private writeAccess(
    channelId: string,
    decide: (current: RoomAccess | null) => RoomAccess | null,
    state?: SQL,
  ): Promise<AccessWriteResult> {
    return this.db.transaction(async (tx): Promise<AccessWriteResult> => {
      const [row] = await tx
        .select({
          access: secondaryChannels.access,
          originalCreator: secondaryChannels.originalCreator,
        })
        .from(secondaryChannels)
        .where(this.scoped(eq(secondaryChannels.channelId, channelId)))
        .for('update');
      if (!row) return { status: 'missing' };
      const stored = readRoomAccess(row.access);
      if (!stored.readable) return { status: 'unreadable' };
      const access = keepCreator(decide(stored.access), stored.access, row.originalCreator);
      await tx
        .update(secondaryChannels)
        .set({ ...(state ? { state } : {}), access, updatedAt: new Date() })
        .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
      return { status: 'written', access };
    });
  }

  /**
   * Changes the access record from what it is now, under a row lock. See
   * {@link writeAccess} for why it is a lock and not a read then a write, and
   * {@link AccessWriteResult} for the three ways it can end.
   *
   * `mutate` runs inside the lock, so it must be synchronous and pure: a Discord
   * call in it would hold the row for the length of a round trip. Throwing from
   * it rolls the write back. Return `null` to clear the record. `mutate` is only
   * called for a room that exists and whose record this build can read.
   *
   * `updatedAt` is bumped, unlike {@link setControlPanelMessage}: this records
   * something about the channel's permissions, not about a message.
   */
  async mutateAccess(
    channelId: string,
    mutate: (current: RoomAccess | null) => RoomAccess | null,
  ): Promise<AccessWriteResult> {
    return this.writeAccess(channelId, mutate);
  }

  /**
   * Writes `state` and `access` in ONE `UPDATE`, which is the whole reason this
   * exists beside {@link mutateAccess}.
   *
   * `private` stays in `state` for older builds and `hidden` is in `access`, so
   * a hide, a lock and a return to public change both. One statement is one row
   * version: a reader sees both changes or neither (and see
   * {@link AccessTransition} for what that does not cover).
   *
   * The `state` half is a server-side merge (`||`, then `- key`), never the
   * whole-column replace {@link updateState} does from an earlier snapshot, so
   * whatever else landed in `state` meanwhile (the roster, the panel keys)
   * survives. A transition that names no state keys touches only `access`.
   *
   * Throws, before anything is written, for a `statePatch` the state schema
   * rejects: that is a bug in the caller and not a condition of the room.
   */
  async transitionAccess(
    channelId: string,
    transition: AccessTransition,
  ): Promise<AccessWriteResult> {
    const patch =
      transition.statePatch === undefined
        ? undefined
        : secondaryStateSchema.parse(transition.statePatch);
    const remove = transition.stateRemove ?? [];
    const merges = patch !== undefined && Object.keys(patch).length > 0;
    let state: SQL | undefined;
    if (merges || remove.length > 0) {
      state = sql`coalesce(${secondaryChannels.state}, '{}'::jsonb)`;
      if (merges) state = sql`${state} || ${JSON.stringify(patch)}::jsonb`;
      // One `- key` per key, as `GuildRepository.mergeSettings` does: drizzle
      // expands a JS array into a tuple of placeholders, which Postgres reads as
      // a record and will not cast to `text[]`. Applied after the merge, so a key
      // named in both is removed.
      for (const key of remove) state = sql`(${state}) - ${key}::text`;
    }
    return this.writeAccess(channelId, transition.access, state);
  }

  /**
   * Reassigns only the current owner, leaving {@link SecondaryChannelRow.originalCreator}
   * untouched. Used when the owner leaves and the longest-present member takes over
   * as caretaker — so the original creator keeps their standing to `/reclaim` it back.
   */
  async setOwner(channelId: string, ownerId: string): Promise<void> {
    await this.db
      .update(secondaryChannels)
      .set({ ownerId, updatedAt: new Date() })
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
  }

  /**
   * Hands the channel to `memberId` as both current owner AND original creator — a
   * deliberate takeover via `/transfer` or `/reclaim`. Moving `originalCreator` too
   * means the previous holder can't later `/reclaim` it back; the handover sticks.
   */
  async setOwnerAndCreator(
    channelId: string,
    memberId: string,
    displayName?: string,
  ): Promise<void> {
    /**
     * The cached name moves with the creator, in ONE statement.
     *
     * Two writes would leave a crash between them naming the wrong person,
     * which is worse than not having the token: `/transfer` and `/reclaim`
     * deliberately move `originalCreator`, so a stale cached name would keep
     * showing whoever used to own the room after a handover the users saw
     * happen. `||` rather than `merge` so a row with no `state` yet still gets
     * the key.
     */
    await this.db
      .update(secondaryChannels)
      .set({
        ownerId: memberId,
        originalCreator: memberId,
        ...(displayName === undefined
          ? {}
          : {
              state: sql`coalesce(${secondaryChannels.state}, '{}'::jsonb) || ${JSON.stringify({
                originalCreatorName: displayName,
              })}::jsonb`,
            }),
        updatedAt: new Date(),
      })
      .where(this.scoped(eq(secondaryChannels.channelId, channelId)));
  }
}
