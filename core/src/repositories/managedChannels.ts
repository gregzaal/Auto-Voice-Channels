import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { managedChannels } from '../db/schema.js';

/**
 * Per-channel templates for an adopted standalone channel. Mirrors the name +
 * status shape of a primary's template, but applies to this one channel.
 */
export const managedTemplateSchema = z.object({
  /** Channel-name template (typically uses the `__empty/occupied__` token). */
  name: z.string().optional(),
  /** Voice-channel-status template (blank/unset → no status). */
  status: z.string().optional(),
});

export type ManagedTemplate = z.infer<typeof managedTemplateSchema>;

export const managedStateSchema = z.object({
  /** Last rendered channel name (for change detection / skipping no-op renames). */
  name: z.string().optional(),
  /** Last rendered voice-channel status ('' = cleared). */
  status: z.string().optional(),
  /** Stable random seed for `[[random]]`/`@@random_emoji@@`, fixed at adoption. */
  seed: z.number().int().optional(),
  /**
   * Member ids in arrival order, maintained as members come and go, to pick the
   * longest-present member as `@@creator@@`/owner (same scheme as secondaries).
   */
  roster: z.array(z.string()).optional(),
});

export type ManagedState = z.infer<typeof managedStateSchema>;

export const managedChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  ownerId: z.string().nullable(),
  template: managedTemplateSchema,
  state: managedStateSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ManagedChannelRow = z.infer<typeof managedChannelRowSchema>;

export interface CreateManagedInput {
  channelId: string;
  guildId: string;
  ownerId?: string | null;
  template?: ManagedTemplate;
  state?: ManagedState;
}

/**
 * Repository for adopted standalone channels whose *name* the bot manages (it
 * never creates or deletes them). Persistent — they outlive emptiness and are
 * only removed when un-adopted or when the Discord channel vanishes.
 */
export class ManagedChannelRepository {
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
    return and(eq(managedChannels.fleet, this.fleet), ...conditions);
  }

  /** Adopts a channel (or no-ops if already adopted, leaving its config intact). */
  async create(input: CreateManagedInput): Promise<ManagedChannelRow> {
    const [row] = await this.db
      .insert(managedChannels)
      .values({
        channelId: input.channelId,
        guildId: input.guildId,
        fleet: this.fleet,
        ownerId: input.ownerId ?? null,
        template: input.template ?? {},
        state: input.state ?? {},
      })
      .onConflictDoNothing({ target: managedChannels.channelId })
      .returning();
    if (row) return managedChannelRowSchema.parse(row);
    // The insert conflicted, so a row for this channel id exists. If it's ours,
    // that is a no-op adopt. If not, the channel already belongs to the other
    // fleet - say so, rather than describing an ordinary cross-fleet conflict
    // as something having vanished.
    const existing = await this.get(input.channelId);
    if (!existing) throw new Error(`managed channel ${input.channelId} belongs to another fleet`);
    return existing;
  }

  async get(channelId: string): Promise<ManagedChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(managedChannels)
      .where(this.scoped(eq(managedChannels.channelId, channelId)))
      .limit(1);
    return row ? managedChannelRowSchema.parse(row) : undefined;
  }

  /** Whether a channel id is an adopted managed channel in the given guild. */
  async isManaged(guildId: string, channelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ channelId: managedChannels.channelId })
      .from(managedChannels)
      .where(
        this.scoped(
          and(eq(managedChannels.guildId, guildId), eq(managedChannels.channelId, channelId)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listByGuild(guildId: string): Promise<ManagedChannelRow[]> {
    const rows = await this.db
      .select()
      .from(managedChannels)
      .where(this.scoped(eq(managedChannels.guildId, guildId)));
    return rows.map((r) => managedChannelRowSchema.parse(r));
  }

  /** Distinct guild ids that currently have at least one adopted channel. */
  async listGuildIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ guildId: managedChannels.guildId })
      .from(managedChannels)
      .where(this.scoped());
    return rows.map((r) => r.guildId);
  }

  async setTemplate(channelId: string, template: ManagedTemplate): Promise<void> {
    await this.db
      .update(managedChannels)
      .set({ template, updatedAt: new Date() })
      .where(this.scoped(eq(managedChannels.channelId, channelId)));
  }

  async updateState(channelId: string, state: ManagedState): Promise<void> {
    await this.db
      .update(managedChannels)
      .set({ state, updatedAt: new Date() })
      .where(this.scoped(eq(managedChannels.channelId, channelId)));
  }

  /** Reassigns the occupant-owner (or clears it with `null` when the channel empties). */
  async setOwner(channelId: string, ownerId: string | null): Promise<void> {
    await this.db
      .update(managedChannels)
      .set({ ownerId, updatedAt: new Date() })
      .where(this.scoped(eq(managedChannels.channelId, channelId)));
  }

  /** Stops managing a channel (un-adopt). Idempotent. */
  async remove(channelId: string): Promise<void> {
    await this.db
      .delete(managedChannels)
      .where(this.scoped(eq(managedChannels.channelId, channelId)));
  }
}
