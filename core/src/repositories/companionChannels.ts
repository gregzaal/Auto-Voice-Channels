import { and, eq, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { companionChannels, secondaryChannels } from '../db/schema.js';

export const companionChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  secondaryChannelId: z.string(),
  viewerRoleId: z.string().nullable(),
  createdAt: z.date(),
});

export type CompanionChannelRow = z.infer<typeof companionChannelRowSchema>;

export interface CreateCompanionChannelInput {
  channelId: string;
  guildId: string;
  secondaryChannelId: string;
  /** The moderator role granted at creation, so the sync can revoke it later. */
  viewerRoleId?: string | null;
}

/**
 * Repository for per-room companion text channels.
 *
 * Shaped after {@link JoinChannelRepository}, including both of its fleet
 * guards, and adds the listing methods that one lacks: a companion outlives its
 * room whenever a write is lost, and the only way that row was ever found in
 * production was raw SQL.
 */
export class CompanionChannelRepository {
  constructor(
    private readonly db: Database,
    private readonly fleet: Fleet = DEFAULT_FLEET,
  ) {}

  /**
   * ANDs this repository's fleet onto a predicate.
   *
   * Every read goes through it, including lookups by channel id: a snowflake is
   * globally unique, but two fleets can share a guild and an unscoped
   * `get(channelId)` would hand one fleet the other's row, after which it would
   * delete a channel it does not own.
   */
  private scoped(...conditions: (SQL | undefined)[]) {
    return and(eq(companionChannels.fleet, this.fleet), ...conditions);
  }

  /**
   * Records a companion, or reports that this room already has one.
   *
   * Returns `null` when a row for the same room already exists, which is a
   * UNIQUE violation on `(fleet, secondary_channel_id)` rather than a read the
   * caller did first. That matters: the caller checks, then spends a Discord
   * round trip creating the channel, then inserts, so two callers can both pass
   * the check. Serialisation through the per-guild queue makes that unreachable
   * today, and the constraint makes it unreachable by construction, which is the
   * difference between a guarantee and a scheduling accident. The loser deletes
   * the channel it just made.
   */
  async create(input: CreateCompanionChannelInput): Promise<CompanionChannelRow | null> {
    const [row] = await this.db
      .insert(companionChannels)
      .values({ ...input, fleet: this.fleet })
      /**
       * Untargeted, so it covers BOTH constraints in one clause (drizzle allows
       * only one). The channel-id primary key can only collide with a row
       * another fleet wrote, and doing nothing there is the same refusal
       * `JoinChannelRepository` spells as a throw: we never touch another
       * fleet's row. The unique index on `(fleet, secondary_channel_id)` is the
       * one that fires in practice.
       */
      .onConflictDoNothing()
      .returning();
    return row ? companionChannelRowSchema.parse(row) : null;
  }

  async get(channelId: string): Promise<CompanionChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(companionChannels)
      .where(this.scoped(eq(companionChannels.channelId, channelId)))
      .limit(1);
    return row ? companionChannelRowSchema.parse(row) : undefined;
  }

  async getBySecondary(secondaryChannelId: string): Promise<CompanionChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(companionChannels)
      .where(this.scoped(eq(companionChannels.secondaryChannelId, secondaryChannelId)))
      .limit(1);
    return row ? companionChannelRowSchema.parse(row) : undefined;
  }

  async remove(channelId: string): Promise<void> {
    await this.db
      .delete(companionChannels)
      .where(this.scoped(eq(companionChannels.channelId, channelId)));
  }

  async removeBySecondary(secondaryChannelId: string): Promise<void> {
    await this.db
      .delete(companionChannels)
      .where(this.scoped(eq(companionChannels.secondaryChannelId, secondaryChannelId)));
  }

  /**
   * Records which moderator role this bot has granted on a companion.
   *
   * Written whenever the sync grants or revokes one, so the next pass knows
   * exactly what to take away. Discord attributes an overwrite to nobody, so
   * this row is the only thing that can tell our grant from a human's.
   */
  async setViewerRole(channelId: string, viewerRoleId: string | null): Promise<void> {
    await this.db
      .update(companionChannels)
      .set({ viewerRoleId })
      .where(this.scoped(eq(companionChannels.channelId, channelId)));
  }

  /** Every companion this fleet owns in one guild, for reconciliation. */
  async listForGuild(guildId: string): Promise<CompanionChannelRow[]> {
    const rows = await this.db
      .select()
      .from(companionChannels)
      .where(this.scoped(eq(companionChannels.guildId, guildId)));
    return rows.map((row) => companionChannelRowSchema.parse(row));
  }

  /**
   * Companions whose room no longer has a row, oldest first.
   *
   * The predicate is entirely in SQL and entirely in the database: it needs no
   * Discord cache, no `guildAvailable` and no shard ownership, which is what
   * lets the orphan job reach a guild this bot has been removed from. Every
   * guild-scoped sweep bails on exactly that case.
   *
   * `limit` bounds one pass; the job runs again.
   *
   * The room subquery is deliberately NOT fleet-scoped: `channel_id` is the sole
   * primary key of `secondary_channels`, so a room belongs to exactly one fleet
   * and a row that exists is the room this companion names. Scoping it would
   * invent orphans out of rows another fleet owns.
   */
  async listOrphans(limit = 100): Promise<CompanionChannelRow[]> {
    const rows = await this.db
      .select()
      .from(companionChannels)
      .where(
        this.scoped(
          notInArray(
            companionChannels.secondaryChannelId,
            this.db.select({ id: secondaryChannels.channelId }).from(secondaryChannels),
          ),
        ),
      )
      .orderBy(companionChannels.createdAt)
      .limit(limit);
    return rows.map((row) => companionChannelRowSchema.parse(row));
  }

  /** How many companions this fleet tracks, and how many are orphaned. */
  async counts(): Promise<{ tracked: number; orphaned: number }> {
    const [row] = await this.db
      .select({
        tracked: sql<number>`count(*)::int`,
        orphaned: sql<number>`count(*) filter (where not exists (
          select 1 from ${secondaryChannels}
           where ${secondaryChannels.channelId} = ${companionChannels.secondaryChannelId}
        ))::int`,
      })
      .from(companionChannels)
      .where(this.scoped());
    return { tracked: row?.tracked ?? 0, orphaned: row?.orphaned ?? 0 };
  }
}
