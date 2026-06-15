import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { joinChannels } from '../db/schema.js';

export const joinChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  secondaryChannelId: z.string(),
  requestChannelId: z.string(),
  creatorId: z.string(),
  createdAt: z.date(),
});

export type JoinChannelRow = z.infer<typeof joinChannelRowSchema>;

export interface CreateJoinChannelInput {
  channelId: string;
  guildId: string;
  secondaryChannelId: string;
  requestChannelId: string;
  creatorId: string;
}

/**
 * Repository for "⇩ Join {creator}" companion channels (the private-channel
 * request mechanism). Keyed by the join channel's own id, with a secondary-id
 * index so cleanup can find the join channel for a private secondary.
 */
export class JoinChannelRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateJoinChannelInput): Promise<JoinChannelRow> {
    const [row] = await this.db
      .insert(joinChannels)
      .values(input)
      .onConflictDoUpdate({
        target: joinChannels.channelId,
        set: {
          secondaryChannelId: input.secondaryChannelId,
          requestChannelId: input.requestChannelId,
          creatorId: input.creatorId,
        },
      })
      .returning();
    return joinChannelRowSchema.parse(row);
  }

  async get(channelId: string): Promise<JoinChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(joinChannels)
      .where(eq(joinChannels.channelId, channelId))
      .limit(1);
    return row ? joinChannelRowSchema.parse(row) : undefined;
  }

  async getBySecondary(secondaryChannelId: string): Promise<JoinChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(joinChannels)
      .where(eq(joinChannels.secondaryChannelId, secondaryChannelId))
      .limit(1);
    return row ? joinChannelRowSchema.parse(row) : undefined;
  }

  async remove(channelId: string): Promise<void> {
    await this.db.delete(joinChannels).where(eq(joinChannels.channelId, channelId));
  }

  /**
   * Reassigns the owner of a secondary's join channel (when ownership transfers
   * because the original creator left), so the new owner can answer requests.
   */
  async setCreatorBySecondary(secondaryChannelId: string, creatorId: string): Promise<void> {
    await this.db
      .update(joinChannels)
      .set({ creatorId })
      .where(eq(joinChannels.secondaryChannelId, secondaryChannelId));
  }

  async removeBySecondary(secondaryChannelId: string): Promise<void> {
    await this.db
      .delete(joinChannels)
      .where(eq(joinChannels.secondaryChannelId, secondaryChannelId));
  }
}
