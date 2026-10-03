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

  /** One query for the converge pass, in the order `getBySecondary` would have answered. */
  describe('listBySecondaries', () => {
    it('answers every row of the rooms asked about, and nobody else', async () => {
      await make('join-1', ROOM);
      await make('join-2', 'room-2');
      await make('join-3', 'room-3');

      const rows = await repo.listBySecondaries([ROOM, 'room-3']);

      expect(rows.map((r) => r.channelId).sort()).toEqual(['join-1', 'join-3']);
    });

    it('lists a room with two rows oldest first, which is the one getBySecondary keeps', async () => {
      await make('join-b');
      await env.handle.db.execute(
        sql`UPDATE join_channels SET created_at = now() - interval '1 minute' WHERE channel_id = 'join-b'`,
      );
      await make('join-a');

      const rows = await repo.listBySecondaries([ROOM]);

      expect(rows.map((r) => r.channelId)).toEqual(['join-b', 'join-a']);
      expect(rows[0]?.channelId).toBe((await repo.getBySecondary(ROOM))?.channelId);
    });

    it('puts them in creation order whatever order they were written or named in', async () => {
      const insert = (id: string, createdAt: string) =>
        env.handle.pool.query(
          "INSERT INTO join_channels (channel_id, guild_id, fleet, secondary_channel_id, creator_id, created_at) VALUES ($1, $2, 'prod', $3, 'u1', $4)",
          [id, GUILD, ROOM, createdAt],
        );
      await insert('join-m', '2026-01-03T00:00:00Z');
      await insert('join-a', '2026-01-02T00:00:00Z');
      await insert('join-z', '2026-01-01T00:00:00Z');

      expect((await repo.listBySecondaries([ROOM])).map((r) => r.channelId)).toEqual([
        'join-z',
        'join-a',
        'join-m',
      ]);
    });

    it('asks nothing for no rooms, and is bound to the repository fleet', async () => {
      await make('join-1');
      const other = new JoinChannelRepository(env.handle.db, 'beta');
      expect(await repo.listBySecondaries([])).toEqual([]);
      expect(await other.listBySecondaries([ROOM])).toEqual([]);
    });
  });
});
