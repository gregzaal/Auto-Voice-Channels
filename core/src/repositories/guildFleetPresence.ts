import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { guildFleetPresence } from '../db/schema.js';
import type { Fleet } from '../domain/fleets.js';

/**
 * Which fleets are in which guilds (`plans/fleets.md` §6.1).
 *
 * The table shipped with the fleet migration (0017) and was backfilled from
 * `guilds.bot_removed_at`, but **nothing wrote to it afterwards**, so it has
 * been a frozen snapshot of 2026-08-13 ever since. That was survivable while
 * one fleet existed and `bot_removed_at` still meant "the hosted bot left". It
 * stops being survivable at the ladder/delivery split, which has to ask "can
 * THIS fleet reach that guild" and gets a stale yes for every guild prod has
 * been kicked out of since.
 *
 * `guilds.bot_removed_at` is still written alongside these rows and still read
 * by the dashboard and the admin console. That is expand/contract, not
 * duplication: the shared column goes away in a later release, once §6.1's
 * cross-fleet presence read has replaced every use of it.
 */
/** Rows per bulk upsert. Bounded so one statement stays a sane size. */
const UPSERT_CHUNK = 500;

export class GuildFleetPresenceRepository {
  constructor(
    private readonly db: Database,
    private readonly fleet: Fleet,
  ) {}

  /**
   * Records that this fleet is in the guild, clearing any removal marker.
   *
   * Idempotent, and it does not touch `first_seen_at` on a re-add: the column
   * answers "since when have we known this guild", which a kick and a re-invite
   * do not reset.
   */
  async markPresent(guildId: string, at = new Date()): Promise<void> {
    await this.db
      .insert(guildFleetPresence)
      .values({ guildId, fleet: this.fleet, firstSeenAt: at, removedAt: null })
      .onConflictDoUpdate({
        target: [guildFleetPresence.guildId, guildFleetPresence.fleet],
        set: { removedAt: null, updatedAt: at },
      });
  }

  /**
   * Records that this fleet is no longer in the guild.
   *
   * Inserts when the row is missing rather than no-opping, because a fleet can
   * be removed from a guild it only ever learned about through a removal (a
   * kick during a gateway gap, replayed as `GUILD_DELETE` on reconnect).
   */
  async markRemoved(guildId: string, at = new Date()): Promise<void> {
    await this.db
      .insert(guildFleetPresence)
      .values({ guildId, fleet: this.fleet, firstSeenAt: at, removedAt: at })
      .onConflictDoUpdate({
        target: [guildFleetPresence.guildId, guildFleetPresence.fleet],
        set: { removedAt: at, updatedAt: at },
      });
  }

  /**
   * Widening only: marks a batch of guilds present, never removes any.
   *
   * What a partial-shard instance may safely do. It sees a subset of the
   * fleet's guilds, so its cache is evidence of presence and no evidence at
   * all of absence.
   */
  async markManyPresent(
    guildIds: Iterable<string>,
    at = new Date(),
  ): Promise<{ added: number; removed: number }> {
    const ids = [...new Set(guildIds)];
    let added = 0;
    for (let i = 0; i < ids.length; i += UPSERT_CHUNK) {
      const chunk = ids.slice(i, i + UPSERT_CHUNK);
      const result = await this.db
        .insert(guildFleetPresence)
        .values(
          chunk.map((guildId) => ({
            guildId,
            fleet: this.fleet,
            firstSeenAt: at,
            removedAt: null,
          })),
        )
        .onConflictDoUpdate({
          target: [guildFleetPresence.guildId, guildFleetPresence.fleet],
          set: { removedAt: null, updatedAt: at },
          setWhere: sql`${guildFleetPresence.removedAt} IS NOT NULL`,
        })
        .returning({ guildId: guildFleetPresence.guildId });
      added += result.length;
    }
    return { added, removed: 0 };
  }

  /** Is this fleet currently in the guild? */
  async isPresent(guildId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ guildId: guildFleetPresence.guildId })
      .from(guildFleetPresence)
      .where(
        and(
          eq(guildFleetPresence.guildId, guildId),
          eq(guildFleetPresence.fleet, this.fleet),
          isNull(guildFleetPresence.removedAt),
        ),
      );
    return row !== undefined;
  }

  /**
   * Every guild this fleet is currently in.
   *
   * The bulk form of {@link isPresent}, for jobs that walk the whole install
   * base. `guilds` is a SHARED table, so anything iterating it and acting per
   * guild must intersect with this or it will act on guilds whose bot is a
   * different fleet entirely. That is the same mistake the billing
   * ladder/delivery split exists to prevent (`plans/fleets.md` §4).
   */
  async presentGuildIds(): Promise<Set<string>> {
    const rows = await this.db
      .select({ guildId: guildFleetPresence.guildId })
      .from(guildFleetPresence)
      .where(and(eq(guildFleetPresence.fleet, this.fleet), isNull(guildFleetPresence.removedAt)));
    return new Set(rows.map((r) => r.guildId));
  }

  /**
   * Every fleet currently in the guild.
   *
   * The dashboard's question, per §6.1: "is *any* fleet here". Asking per fleet
   * is how a subscribed customer happily running beta gets told the bot is not
   * in their server.
   */
  async presentFleets(guildId: string): Promise<Fleet[]> {
    const rows = await this.db
      .select({ fleet: guildFleetPresence.fleet })
      .from(guildFleetPresence)
      .where(and(eq(guildFleetPresence.guildId, guildId), isNull(guildFleetPresence.removedAt)));
    return rows.map((r) => r.fleet);
  }

  /**
   * Reconciles this fleet's presence against the guilds it can actually see.
   *
   * Events are missable, so the guild list is the truth and the event stream
   * is the optimization: a kick while the process is down is never replayed as
   * `GUILD_DELETE`, and neither is one that lands during a gateway outage,
   * because a re-IDENTIFY does not diff the new guild list against the old
   * cache. **So this has to be called periodically, not only at READY**, or a
   * fleet stays wrongly marked present in a guild it was thrown out of and
   * that guild's notifications are handed to a bot that cannot deliver them.
   *
   * Returns what changed, so a run that suddenly marks hundreds of guilds
   * removed is visible in the logs rather than inferred later from a support
   * ticket.
   *
   * **Only ever narrows to guilds this fleet has rows for.** A fleet that owns
   * a subset of shards sees a subset of guilds, so "not in my cache" is not
   * "not in the guild" — callers pass the full set for the fleet, and the
   * caller in `index.ts` runs this only when the instance holds every shard.
   */
  async reconcilePresence(
    presentGuildIds: Iterable<string>,
    at = new Date(),
  ): Promise<{ added: number; removed: number }> {
    const present = [...new Set(presentGuildIds)];

    /**
     * An empty set narrows nothing.
     *
     * "The bot is in no guilds" and "the gateway cache has not filled yet" are
     * indistinguishable here, and one of them is overwhelmingly more likely.
     * Acting on it would mark the entire install base removed from a single
     * mistimed call, so the empty case is refused rather than handled. A fleet
     * genuinely in zero guilds has nothing to reconcile anyway.
     */
    if (present.length === 0) return { added: 0, removed: 0 };

    /**
     * Chunked bulk upserts, not one statement per guild.
     *
     * This runs on the boot path with the whole install base: 1862 guilds at
     * the beta switch and every hosted guild at cutover. A round-trip each
     * would put minutes of sequential latency in front of the billing job,
     * which is now sequenced behind it.
     */
    let added = 0;
    for (let i = 0; i < present.length; i += UPSERT_CHUNK) {
      const chunk = present.slice(i, i + UPSERT_CHUNK);
      const result = await this.db
        .insert(guildFleetPresence)
        .values(
          chunk.map((guildId) => ({
            guildId,
            fleet: this.fleet,
            firstSeenAt: at,
            removedAt: null,
          })),
        )
        .onConflictDoUpdate({
          target: [guildFleetPresence.guildId, guildFleetPresence.fleet],
          // Only touch rows that actually disagree, so a steady-state boot does
          // not bump `updated_at` across the entire install base.
          set: { removedAt: null, updatedAt: at },
          setWhere: sql`${guildFleetPresence.removedAt} IS NOT NULL`,
        })
        .returning({ guildId: guildFleetPresence.guildId });
      added += result.length;
    }

    /**
     * One array parameter, not one bind per guild.
     *
     * `notInArray` expands to `id NOT IN ($1, $2, ...)`, which walks into
     * Postgres's 65535-parameter ceiling somewhere past 65k guilds and fails
     * the whole reconcile. This binds a single JSON string instead and lets
     * Postgres build the array, so the list length stops mattering.
     *
     * The JSON detour is not decoration: drizzle binds a JS array as a
     * *record*, so the obvious `<> ALL(${present}::text[])` fails at runtime
     * with "cannot cast type record to text[]" and typechecks perfectly.
     */
    const gone = await this.db
      .update(guildFleetPresence)
      .set({ removedAt: at, updatedAt: at })
      .where(
        and(
          eq(guildFleetPresence.fleet, this.fleet),
          isNull(guildFleetPresence.removedAt),
          sql`${guildFleetPresence.guildId} <> ALL(
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(present)}::jsonb))
          )`,
        ),
      )
      .returning({ guildId: guildFleetPresence.guildId });

    return { added, removed: gone.length };
  }
}
