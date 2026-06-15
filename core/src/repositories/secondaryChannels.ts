import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { secondaryChannels } from '../db/schema.js';

export const secondaryStateSchema = z.object({
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
});

export type SecondaryState = z.infer<typeof secondaryStateSchema>;

export const secondaryChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  primaryChannelId: z.string(),
  ownerId: z.string().nullable(),
  state: secondaryStateSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SecondaryChannelRow = z.infer<typeof secondaryChannelRowSchema>;

export interface CreateSecondaryInput {
  channelId: string;
  guildId: string;
  primaryChannelId: string;
  ownerId?: string;
  state?: SecondaryState;
}

/**
 * Repository for bot-managed temporary voice channels (secondaries), tracked for
 * reconciliation. All operations are idempotent so events can be safely replayed.
 */
export class SecondaryChannelRepository {
  constructor(private readonly db: Database) {}

  /** Records a new secondary. Idempotent on the channel id. */
  async create(input: CreateSecondaryInput): Promise<SecondaryChannelRow> {
    const [row] = await this.db
      .insert(secondaryChannels)
      .values({
        channelId: input.channelId,
        guildId: input.guildId,
        primaryChannelId: input.primaryChannelId,
        ownerId: input.ownerId ?? null,
        state: input.state ?? {},
      })
      .onConflictDoUpdate({
        target: secondaryChannels.channelId,
        set: {
          primaryChannelId: input.primaryChannelId,
          ownerId: input.ownerId ?? null,
          state: input.state ?? {},
          updatedAt: new Date(),
        },
      })
      .returning();
    return secondaryChannelRowSchema.parse(row);
  }

  async get(channelId: string): Promise<SecondaryChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.channelId, channelId))
      .limit(1);
    return row ? secondaryChannelRowSchema.parse(row) : undefined;
  }

  async isSecondary(guildId: string, channelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ channelId: secondaryChannels.channelId })
      .from(secondaryChannels)
      .where(
        and(eq(secondaryChannels.guildId, guildId), eq(secondaryChannels.channelId, channelId)),
      )
      .limit(1);
    return row !== undefined;
  }

  async listByGuild(guildId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.guildId, guildId));
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  async listByPrimary(primaryChannelId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.primaryChannelId, primaryChannelId));
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  /** Secondaries a member currently owns in a guild (for `/nick` re-render). */
  async listByOwner(guildId: string, ownerId: string): Promise<SecondaryChannelRow[]> {
    const rows = await this.db
      .select()
      .from(secondaryChannels)
      .where(and(eq(secondaryChannels.guildId, guildId), eq(secondaryChannels.ownerId, ownerId)));
    return rows.map((r) => secondaryChannelRowSchema.parse(r));
  }

  /** Distinct guild ids that currently have at least one tracked secondary. */
  async listGuildIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ guildId: secondaryChannels.guildId })
      .from(secondaryChannels);
    return rows.map((r) => r.guildId);
  }

  /** Number of secondaries currently spawned from a primary. */
  async countByPrimary(primaryChannelId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(secondaryChannels)
      .where(eq(secondaryChannels.primaryChannelId, primaryChannelId));
    return row?.n ?? 0;
  }

  /** Removes a secondary record. Idempotent (no error if already gone). */
  async remove(channelId: string): Promise<void> {
    await this.db.delete(secondaryChannels).where(eq(secondaryChannels.channelId, channelId));
  }

  async updateState(channelId: string, state: SecondaryState): Promise<void> {
    await this.db
      .update(secondaryChannels)
      .set({ state, updatedAt: new Date() })
      .where(eq(secondaryChannels.channelId, channelId));
  }

  /** Reassigns the owner (used by `/transfer` and `/claim`). */
  async setOwner(channelId: string, ownerId: string): Promise<void> {
    await this.db
      .update(secondaryChannels)
      .set({ ownerId, updatedAt: new Date() })
      .where(eq(secondaryChannels.channelId, channelId));
  }
}
