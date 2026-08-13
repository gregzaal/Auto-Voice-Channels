import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { autoChannels } from '../db/schema.js';

/**
 * Per-primary template/config, mirroring the legacy per-primary settings shape
 * (`channel_name_template`, default limit, position).
 */
export const primaryTemplateSchema = z.object({
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
});

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
         * primary key. But the row it conflicts with may belong to the OTHER
         * fleet, and without this guard the update would silently rewrite that
         * fleet's template. Gating makes this practically unreachable, which is
         * exactly why it should fail loudly rather than corrupt quietly if the
         * gate ever fails: no row comes back, and the caller below throws.
         */
        setWhere: eq(autoChannels.fleet, this.fleet),
      })
      .returning();
    // Only reachable when the guard above declined: the channel is already a
    // creator channel of the other fleet. Say so, rather than letting a zod
    // parse failure on `undefined` describe it as a schema problem.
    if (!row) {
      throw new Error(`auto channel ${channelId} belongs to another fleet`);
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

  async remove(channelId: string): Promise<void> {
    await this.db.delete(autoChannels).where(this.scoped(eq(autoChannels.channelId, channelId)));
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
