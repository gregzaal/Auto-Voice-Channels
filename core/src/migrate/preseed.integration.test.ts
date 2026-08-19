import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { autoChannels, guilds, secondaryChannels } from '../db/schema.js';
import { SecondaryChannelRepository } from '../repositories/secondaryChannels.js';
import { preseedNames } from './preseed.js';

/**
 * The pre-seed pass against a real database (`plans/migration.md` §5.2).
 *
 * Discord is injected. What needs proving is not that `fetch` works, it is that
 * the pass touches exactly the rows it should: an adopted channel with no name
 * gets one, a channel the bot has already named is left alone, and a row whose
 * channel has been deleted is reported rather than papered over.
 */

const GUILD = '111111111111111111';
const GONE_GUILD = '222222222222222222';
const PRIMARY = '605724722902204416';
const ADOPTED = '700000000000000001';
const ALREADY_NAMED = '700000000000000002';
const DELETED_ON_DISCORD = '700000000000000003';
const IN_GONE_GUILD = '700000000000000004';

describe('preseedNames (integration)', () => {
  let pg: PgTestEnv;

  const discord = async (guildId: string): Promise<Map<string, string> | null> => {
    if (guildId === GONE_GUILD) return null; // bot was removed
    return new Map([
      [ADOPTED, '🎮 Alice-s room'],
      [ALREADY_NAMED, 'renamed by hand'],
    ]);
  };

  const run = (apply: boolean) =>
    preseedNames({
      db: pg.handle.db,
      fleet: 'prod',
      token: 'unused',
      apply,
      fetchGuildChannels: discord,
    });

  const stateOf = async (channelId: string): Promise<Record<string, unknown>> => {
    const [row] = await pg.handle.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.channelId, channelId));
    return (row?.state ?? {}) as Record<string, unknown>;
  };

  beforeAll(async () => {
    pg = await startPostgres();
    const repo = new SecondaryChannelRepository(pg.handle.db, 'prod');

    for (const id of [GUILD, GONE_GUILD]) {
      await pg.handle.db.insert(guilds).values({ guildId: id });
    }
    await pg.handle.db
      .insert(autoChannels)
      .values({ fleet: 'prod', guildId: GUILD, channelId: PRIMARY, template: {} });

    for (const [channelId, guildId, state] of [
      [ADOPTED, GUILD, {}],
      [ALREADY_NAMED, GUILD, { name: 'what the bot last set' }],
      [DELETED_ON_DISCORD, GUILD, {}],
      [IN_GONE_GUILD, GONE_GUILD, {}],
    ] as [string, string, Record<string, unknown>][]) {
      await repo.create({
        channelId,
        guildId,
        primaryChannelId: PRIMARY,
        ownerId: '291185187105275904',
        state,
      });
    }
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('writes nothing on a dry run', async () => {
    const summary = await run(false);
    expect(summary.named).toBe(1);
    expect(await stateOf(ADOPTED)).toEqual({});
  }, 300_000);

  it('names the adopted channel from Discord', async () => {
    await run(true);
    expect(await stateOf(ADOPTED)).toEqual({ name: '🎮 Alice-s room' });
  }, 300_000);

  /**
   * The property that makes a re-run safe. Once the bot is running, `state.name`
   * is its own record of what it last set; overwriting it with whatever Discord
   * currently says would hand somebody's manual rename to the reconciler as if
   * the bot had made it, and the next sweep would rename it back.
   */
  it('never touches a channel that already has a name', async () => {
    expect(await stateOf(ALREADY_NAMED)).toEqual({ name: 'what the bot last set' });
  }, 300_000);

  it('reports a channel Discord no longer has, and leaves the row alone', async () => {
    const summary = await run(true);
    expect(summary.missing).toBe(1);
    expect(await stateOf(DELETED_ON_DISCORD)).toEqual({});
  }, 300_000);

  it('reports a guild the bot is no longer in', async () => {
    const summary = await run(true);
    expect(summary.unreachable).toEqual([GONE_GUILD]);
    expect(await stateOf(IN_GONE_GUILD)).toEqual({});
  }, 300_000);

  it('has nothing left to do once every reachable channel is named', async () => {
    const summary = await run(true);
    expect(summary.named).toBe(0);
    // Two rows stay candidates forever, and correctly so: one channel Discord
    // deleted, one in a guild the bot has left. Neither has a name to learn.
    expect(summary.candidates).toBe(2);
  }, 300_000);

  /**
   * Only the name is added, and **including keys this build has never heard
   * of**.
   *
   * The first version of this test used `private` and `index`, both in the
   * schema, so it could not fail for the case that mattered: the code parsed
   * the row through `secondaryStateSchema` before writing it back, and a bare
   * `z.object` strips unknown keys, so an older build would silently delete a
   * field a newer bot had written. `updateState` replaces `state` wholesale, so
   * stripping is data loss, not validation.
   */
  it('preserves the rest of the state, including keys it does not know', async () => {
    await pg.handle.db
      .update(secondaryChannels)
      .set({ state: { private: true, index: 3, fromAFutureRelease: 'keep me' } })
      .where(eq(secondaryChannels.channelId, ADOPTED));

    await run(true);

    expect(await stateOf(ADOPTED)).toEqual({
      private: true,
      index: 3,
      fromAFutureRelease: 'keep me',
      name: '🎮 Alice-s room',
    });
  }, 300_000);

  /**
   * `state -> 'name' IS NULL` is true for a missing key but false for a JSON
   * null, so a row shaped this way was skipped here and then renamed by the
   * reconciler, which is the exact outcome the pass exists to prevent.
   */
  it('treats an explicit null name as unnamed', async () => {
    await pg.handle.db
      .update(secondaryChannels)
      .set({ state: { name: null } })
      .where(eq(secondaryChannels.channelId, ADOPTED));

    const summary = await run(true);

    expect(summary.named).toBe(1);
    expect(await stateOf(ADOPTED)).toEqual({ name: '🎮 Alice-s room' });
  }, 300_000);

  /** The query must not pick up rows belonging to another fleet. */
  it('is scoped to its own fleet', async () => {
    const summary = await preseedNames({
      db: pg.handle.db,
      fleet: 'beta',
      token: 'unused',
      apply: true,
      fetchGuildChannels: discord,
    });
    expect(summary.candidates).toBe(0);
    const total = await pg.handle.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM secondary_channels WHERE fleet = 'beta'`,
    );
    expect(Number(total.rows[0]?.n)).toBe(0);
  }, 300_000);
});
