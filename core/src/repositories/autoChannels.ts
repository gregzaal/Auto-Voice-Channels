import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { autoChannels } from '../db/schema.js';

/**
 * Per-primary template/config, mirroring the legacy per-primary settings shape
 * (`channel_name_template`, default limit, position). *
 * **`passthrough` is load-bearing for expand/contract (golden rule 3).** Without
 * it this parse STRIPS any field a newer build added, so during a rolling deploy
 * an old instance doing a read-modify-write on this column silently drops that
 * field, and `/export` cannot carry it either. Verified by probe: a `z.object`
 * here returned `{name}` for `{name, someFutureField}`.
 */
export const primaryTemplateSchema = z
  .object({
    /** Channel-name template for secondaries spawned from this primary. */
    name: z.string().optional(),
    /** Voice-channel-status template for secondaries spawned from this primary. */
    status: z.string().optional(),
    /** Default user limit applied to spawned secondaries (0 = unlimited). */
    limit: z.number().int().min(0).optional(),
    /** Position secondaries above (`true`) or below (default — absent/`false`) the primary. */
    above: z.boolean().optional(),
    /**
     * When `true`, secondaries spawned from this primary are made private on
     * creation (locked to @everyone, with a "⇩ Join" companion) — the same
     * treatment as `/private`. Toggled via `/alwaysprivate` or the `/create` modal.
     */
    defaultPrivate: z.boolean().optional(),
    /**
     * Permission inheritance for spawned secondaries: `primary` (copy the primary
     * channel's overwrites), `category` (copy the primary's category), or a
     * specific channel id to copy. Unset → defaults to `primary` (the legacy
     * behaviour), NOT Discord's implicit category-sync.
     */
    inheritperms: z.string().optional(),
  })
  .passthrough();

export type PrimaryTemplate = z.infer<typeof primaryTemplateSchema>;

export const autoChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  template: primaryTemplateSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AutoChannelRow = z.infer<typeof autoChannelRowSchema>;

/** Repository for primary / creator ("auto") channels. */
export class AutoChannelRepository {
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
   * does not own (`plans/fleets.md` §2).
   */
  private scoped(...conditions: (SQL | undefined)[]) {
    return and(eq(autoChannels.fleet, this.fleet), ...conditions);
  }

  /** Registers (or updates) a primary channel for a guild. Idempotent. */
  async upsert(
    guildId: string,
    channelId: string,
    template: PrimaryTemplate = {},
  ): Promise<AutoChannelRow> {
    const [row] = await this.db
      .insert(autoChannels)
      .values({ channelId, guildId, fleet: this.fleet, template })
      .onConflictDoUpdate({
        target: autoChannels.channelId,
        set: { template, updatedAt: new Date() },
        /**
         * A channel id is globally unique, so the conflict target stays the
         * primary key. But the row it conflicts with may belong to another
         * fleet, or to another GUILD, and without this guard the update would
         * silently rewrite it and return a row carrying someone else's
         * `guildId`.
         *
         * The guild half matters because `/import` writes this from a file:
         * every other writer reaches it through `primaryFor`, which checks
         * `primary.guildId === guildId` in the service layer, so a repository
         * that binds fleet alone was safe only by the grace of its callers.
         * Bind it here instead, where a new caller cannot forget.
         */
        // Non-null because both conditions are present: drizzle's `and` is typed
        // as optional only because it drops undefined ones.
        setWhere: and(eq(autoChannels.fleet, this.fleet), eq(autoChannels.guildId, guildId))!,
      })
      .returning();
    // Only reachable when the guard above declined. Which of the two reasons it
    // was needs one lookup, and it is worth it: "belongs to another guild" and
    // "belongs to another fleet" call for completely different responses.
    if (!row) {
      const existing = await this.get(channelId);
      throw new Error(
        existing
          ? `auto channel ${channelId} belongs to another guild`
          : `auto channel ${channelId} belongs to another fleet`,
      );
    }
    return autoChannelRowSchema.parse(row);
  }

  async get(channelId: string): Promise<AutoChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(autoChannels)
      .where(this.scoped(eq(autoChannels.channelId, channelId)))
      .limit(1);
    return row ? autoChannelRowSchema.parse(row) : undefined;
  }

  /** Whether a channel id is a registered primary in the given guild. */
  async isPrimary(guildId: string, channelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ channelId: autoChannels.channelId })
      .from(autoChannels)
      .where(
        this.scoped(and(eq(autoChannels.guildId, guildId), eq(autoChannels.channelId, channelId))),
      )
      .limit(1);
    return row !== undefined;
  }

  async listByGuild(guildId: string): Promise<AutoChannelRow[]> {
    const rows = await this.db
      .select()
      .from(autoChannels)
      .where(this.scoped(eq(autoChannels.guildId, guildId)));
    return rows.map((r) => autoChannelRowSchema.parse(r));
  }

  /**
   * Un-registers a creator channel. Idempotent.
   *
   * Guild-bound like every other write here: `/import` deletes rows a native
   * export omits (`plans/import_command.md` §5.5a), so a channel id from a file
   * reaches this, and nothing above it re-checks the guild.
   */
  async remove(guildId: string, channelId: string): Promise<void> {
    await this.db
      .delete(autoChannels)
      .where(
        this.scoped(and(eq(autoChannels.guildId, guildId), eq(autoChannels.channelId, channelId))),
      );
  }

  /** Distinct guild ids that have at least one registered primary. */
  async listGuildIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ guildId: autoChannels.guildId })
      .from(autoChannels)
      .where(this.scoped());
    return rows.map((r) => r.guildId);
  }

  /** Count of primaries in a guild (cheap existence/aggregate check). */
  async countByGuild(guildId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(autoChannels)
      .where(this.scoped(eq(autoChannels.guildId, guildId)));
    return row?.n ?? 0;
  }
}
