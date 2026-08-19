import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { GuildFleetPresenceRepository } from './guildFleetPresence.js';

/**
 * Per-fleet guild presence (`plans/fleets.md` §6.1).
 *
 * The table shipped with migration 0017 and was backfilled, then nothing wrote
 * to it for six days, so it was a frozen snapshot. These cover the writers that
 * close that gap, and in particular the two ways a presence reconcile can be
 * catastrophic rather than merely wrong.
 */

const A = '200000000000000001';
const B = '200000000000000002';
const C = '200000000000000003';

describe('GuildFleetPresenceRepository (integration)', () => {
  let env: PgTestEnv;
  let prod: GuildFleetPresenceRepository;
  let beta: GuildFleetPresenceRepository;

  beforeAll(async () => {
    env = await startPostgres();
    prod = new GuildFleetPresenceRepository(env.handle.db, 'prod');
    beta = new GuildFleetPresenceRepository(env.handle.db, 'beta');
  }, 300_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.execute(sql`DELETE FROM guild_fleet_presence`);
  });

  it('records a fleet joining a guild', async () => {
    await prod.markPresent(A);
    expect(await prod.isPresent(A)).toBe(true);
    expect(await beta.isPresent(A)).toBe(false);
  });

  it('records a fleet leaving, without deleting the row', async () => {
    await prod.markPresent(A);
    await prod.markRemoved(A);
    expect(await prod.isPresent(A)).toBe(false);
    expect(await prod.presentFleets(A)).toEqual([]);
  });

  it('clears the removal marker when the fleet is re-added', async () => {
    await prod.markPresent(A);
    await prod.markRemoved(A);
    await prod.markPresent(A);
    expect(await prod.isPresent(A)).toBe(true);
  });

  /**
   * A kick during a gateway gap arrives as a removal for a guild this fleet has
   * no row for. Ignoring it would leave the fleet permanently, wrongly present.
   */
  it('records a removal for a guild it has never seen', async () => {
    await prod.markRemoved(A);
    expect(await prod.isPresent(A)).toBe(false);
  });

  /**
   * §6.1's first rule, and the bug it was written to prevent: the dashboard
   * asks "is ANY fleet here", so a customer happily using beta with prod absent
   * must not be told the bot is missing.
   */
  it('reports every fleet present in a guild', async () => {
    await prod.markPresent(A);
    await beta.markPresent(A);
    expect((await prod.presentFleets(A)).sort()).toEqual(['beta', 'prod']);

    await prod.markRemoved(A);
    expect(await prod.presentFleets(A)).toEqual(['beta']);
  });

  it('keeps the fleets independent', async () => {
    await prod.markPresent(A);
    await beta.markPresent(A);
    await beta.markRemoved(A);
    expect(await prod.isPresent(A)).toBe(true);
    expect(await beta.isPresent(A)).toBe(false);
  });

  describe('reconcilePresence', () => {
    it('adds guilds it can see and removes ones it cannot', async () => {
      await prod.markPresent(A);
      await prod.markPresent(B);

      const result = await prod.reconcilePresence([B, C]);

      expect(result).toEqual({ added: 1, removed: 1 });
      expect(await prod.isPresent(A)).toBe(false);
      expect(await prod.isPresent(B)).toBe(true);
      expect(await prod.isPresent(C)).toBe(true);
    });

    /**
     * The catastrophic case. "The bot is in no guilds" and "the gateway cache
     * has not filled yet" look identical here, and acting on the empty set
     * would mark the entire install base removed, which in turn would stop
     * every queued billing notification from ever being delivered.
     */
    it('refuses to narrow on an empty set', async () => {
      await prod.markPresent(A);
      await prod.markPresent(B);

      expect(await prod.reconcilePresence([])).toEqual({ added: 0, removed: 0 });

      expect(await prod.isPresent(A)).toBe(true);
      expect(await prod.isPresent(B)).toBe(true);
    });

    /** One fleet reconciling must never touch the other's rows. */
    it('never narrows another fleet', async () => {
      await beta.markPresent(A);
      await prod.markPresent(A);

      await prod.reconcilePresence([B]);

      expect(await beta.isPresent(A)).toBe(true);
      expect(await prod.isPresent(A)).toBe(false);
    });

    /** A steady-state boot should report no change rather than churn rows. */
    it('is a no-op when nothing changed', async () => {
      await prod.markPresent(A);
      await prod.markPresent(B);
      expect(await prod.reconcilePresence([A, B])).toEqual({ added: 0, removed: 0 });
    });

    it('does not double-count a duplicated guild id', async () => {
      expect(await prod.reconcilePresence([A, A, B])).toEqual({ added: 2, removed: 0 });
    });
  });
  describe('markManyPresent', () => {
    /** What a partial-shard instance may do: evidence of presence only. */
    it('widens without ever narrowing', async () => {
      await prod.markPresent(A);
      await prod.markRemoved(A);

      // Two rows written: A re-added, B inserted for the first time.
      const result = await prod.markManyPresent([A, B]);

      expect(result).toEqual({ added: 2, removed: 0 });
      expect(await prod.isPresent(A)).toBe(true);
      expect(await prod.isPresent(B)).toBe(true);
    });

    /**
     * The reason it exists. An instance holding some shards sees some guilds,
     * so anything it cannot see must be left alone rather than marked removed.
     */
    it('leaves a guild it was not told about alone', async () => {
      await prod.markPresent(C);
      await prod.markManyPresent([A]);
      expect(await prod.isPresent(C)).toBe(true);
    });

    it('handles an empty batch', async () => {
      expect(await prod.markManyPresent([])).toEqual({ added: 0, removed: 0 });
    });
  });

  /**
   * Chunked bulk upserts and a single array parameter for the narrowing, so
   * this has to hold past one chunk. 600 crosses the 500-row chunk boundary.
   */
  it('reconciles a batch larger than one chunk', async () => {
    const many = Array.from({ length: 600 }, (_, i) => String(300000000000000000n + BigInt(i)));
    expect(await prod.reconcilePresence(many)).toEqual({ added: 600, removed: 0 });

    const kept = many.slice(0, 400);
    expect(await prod.reconcilePresence(kept)).toEqual({ added: 0, removed: 200 });
    expect(await prod.isPresent(many[0]!)).toBe(true);
    expect(await prod.isPresent(many[599]!)).toBe(false);
  });
});
