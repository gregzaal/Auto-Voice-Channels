import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { JoinChannelRepository } from './joinChannels.js';
import { joinChannels } from '../db/schema.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const GUILD = 'guild-1';
const ROOM = 'room-1';

describe('JoinChannelRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: JoinChannelRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new JoinChannelRepository(env.handle.db, 'prod');
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(joinChannels);
  });

  const make = (channelId: string, secondaryChannelId = ROOM) =>
    repo.create({ channelId, guildId: GUILD, secondaryChannelId, creatorId: 'u1' });

  /**
   * The index on `secondary_channel_id` is not unique, so a replayed or racing lock
   * can leave a room with two rows. The creator that finds two has to keep the
   * same one as every other creator, or two of them each delete the other's.
   */
  describe('getBySecondary with two rows for one room', () => {
    it('answers the oldest', async () => {
      await make('join-b');
      await env.handle.db.execute(
        sql`UPDATE join_channels SET created_at = now() - interval '1 minute' WHERE channel_id = 'join-b'`,
      );
      await make('join-a');

      expect((await repo.getBySecondary(ROOM))?.channelId).toBe('join-b');
    });

    it('breaks a tie on the id, whatever order the rows were written in', async () => {
      await make('join-z');
      await make('join-a');
      await env.handle.db.execute(
        sql`UPDATE join_channels SET created_at = '2026-01-01T00:00:00Z' WHERE secondary_channel_id = ${ROOM}`,
      );

      expect((await repo.getBySecondary(ROOM))?.channelId).toBe('join-a');
      expect((await repo.getBySecondary(ROOM))?.channelId).toBe('join-a');
    });

    it('answers each room its own row', async () => {
      await make('join-1', ROOM);
      await make('join-2', 'room-2');
      expect((await repo.getBySecondary('room-2'))?.channelId).toBe('join-2');
    });
  });
});
