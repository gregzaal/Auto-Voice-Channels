import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
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
  /** Position secondaries above (true, default) or below the primary. */
  above: z.boolean().optional(),
  /**
   * Permission inheritance for spawned secondaries: `primary` (copy the primary
   * channel's overwrites), `category` (copy the primary's category), or a
   * specific channel id to copy. Unset → Discord defaults.
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
  constructor(private readonly db: Database) {}

  /** Registers (or updates) a primary channel for a guild. Idempotent. */
  async upsert(
    guildId: string,
    channelId: string,
    template: PrimaryTemplate = {},
  ): Promise<AutoChannelRow> {
    const [row] = await this.db
      .insert(autoChannels)
      .values({ channelId, guildId, template })
      .onConflictDoUpdate({
        target: autoChannels.channelId,
        set: { template, updatedAt: new Date() },
      })
      .returning();
    return autoChannelRowSchema.parse(row);
  }

  async get(channelId: string): Promise<AutoChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(autoChannels)
      .where(eq(autoChannels.channelId, channelId))
      .limit(1);
    return row ? autoChannelRowSchema.parse(row) : undefined;
  }

  /** Whether a channel id is a registered primary in the given guild. */
  async isPrimary(guildId: string, channelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ channelId: autoChannels.channelId })
      .from(autoChannels)
      .where(and(eq(autoChannels.guildId, guildId), eq(autoChannels.channelId, channelId)))
      .limit(1);
    return row !== undefined;
  }

  async listByGuild(guildId: string): Promise<AutoChannelRow[]> {
    const rows = await this.db.select().from(autoChannels).where(eq(autoChannels.guildId, guildId));
    return rows.map((r) => autoChannelRowSchema.parse(r));
  }

  async remove(channelId: string): Promise<void> {
    await this.db.delete(autoChannels).where(eq(autoChannels.channelId, channelId));
  }

  /** Distinct guild ids that have at least one registered primary. */
  async listGuildIds(): Promise<string[]> {
    const rows = await this.db.selectDistinct({ guildId: autoChannels.guildId }).from(autoChannels);
    return rows.map((r) => r.guildId);
  }

  /** Count of primaries in a guild (cheap existence/aggregate check). */
  async countByGuild(guildId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(autoChannels)
      .where(eq(autoChannels.guildId, guildId));
    return row?.n ?? 0;
  }
}
