import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { joinChannels } from '../db/schema.js';

export const joinChannelRowSchema = z.object({
  channelId: z.string(),
  guildId: z.string(),
  secondaryChannelId: z.string(),
  creatorId: z.string(),
  createdAt: z.date(),
});

export type JoinChannelRow = z.infer<typeof joinChannelRowSchema>;

export interface CreateJoinChannelInput {
  channelId: string;
  guildId: string;
  secondaryChannelId: string;
  creatorId: string;
}

/**
 * Repository for "⇩ Join {creator}" companion channels (the private-channel
 * request mechanism). Keyed by the join channel's own id, with a secondary-id
 * index so cleanup can find the join channel for a private secondary.
 */
export class JoinChannelRepository {
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
    return and(eq(joinChannels.fleet, this.fleet), ...conditions);
  }

  async create(input: CreateJoinChannelInput): Promise<JoinChannelRow> {
    const [row] = await this.db
      .insert(joinChannels)
      .values({ ...input, fleet: this.fleet })
      .onConflictDoUpdate({
        target: joinChannels.channelId,
        set: {
          secondaryChannelId: input.secondaryChannelId,
          creatorId: input.creatorId,
        },
        // Same guard as AutoChannelRepository.upsert: the conflicting row may
        // belong to the other fleet, and repointing its companion at one of our
        // secondaries would break join requests for a channel we do not own.
        setWhere: eq(joinChannels.fleet, this.fleet),
      })
      .returning();
    if (!row) {
      throw new Error(`join channel ${input.channelId} belongs to another fleet`);
    }
    return joinChannelRowSchema.parse(row);
  }

  async get(channelId: string): Promise<JoinChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(joinChannels)
      .where(this.scoped(eq(joinChannels.channelId, channelId)))
      .limit(1);
    return row ? joinChannelRowSchema.parse(row) : undefined;
  }

  /**
   * The room's "⇩ Join" channel, if it has one.
   *
   * **Oldest first, then by id, and not left to Postgres's heap order.** The index
   * on `secondary_channel_id` is not unique, so a replayed or racing lock can leave
   * a room with two rows. Which one this answers has to be the same for everyone
   * who asks, or two creators comparing "is mine the one that is kept" would each
   * decide it was the other's and both delete theirs.
   */
  async getBySecondary(secondaryChannelId: string): Promise<JoinChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(joinChannels)
      .where(this.scoped(eq(joinChannels.secondaryChannelId, secondaryChannelId)))
      .orderBy(asc(joinChannels.createdAt), asc(joinChannels.channelId))
      .limit(1);
    return row ? joinChannelRowSchema.parse(row) : undefined;
  }

  /**
   * Every "⇩ Join" channel of the given rooms, oldest first within a room, in ONE query.
   *
   * For the converge pass, which has to know which locked and hidden rooms of a guild
   * have one, and would otherwise ask {@link getBySecondary} once per room per sweep. By
   * room id and not by guild so it is served by the index on `secondary_channel_id`:
   * the table has none on the guild, and a scan of it per guild per sweep is what the
   * index is there to avoid. Nothing is asked for an empty list.
   */
  async listBySecondaries(secondaryChannelIds: readonly string[]): Promise<JoinChannelRow[]> {
    if (secondaryChannelIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(joinChannels)
      .where(this.scoped(inArray(joinChannels.secondaryChannelId, [...secondaryChannelIds])))
      .orderBy(asc(joinChannels.createdAt), asc(joinChannels.channelId));
    return rows.map((r) => joinChannelRowSchema.parse(r));
  }

  async remove(channelId: string): Promise<void> {
    await this.db.delete(joinChannels).where(this.scoped(eq(joinChannels.channelId, channelId)));
  }

  /**
   * Reassigns the owner of a secondary's join channel (when ownership transfers
   * because the original creator left), so the new owner can answer requests.
   */
  async setCreatorBySecondary(secondaryChannelId: string, creatorId: string): Promise<void> {
    await this.db
      .update(joinChannels)
      .set({ creatorId })
      .where(this.scoped(eq(joinChannels.secondaryChannelId, secondaryChannelId)));
  }

  async removeBySecondary(secondaryChannelId: string): Promise<void> {
    await this.db
      .delete(joinChannels)
      .where(this.scoped(eq(joinChannels.secondaryChannelId, secondaryChannelId)));
  }
}
