import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { withBackupLock, withDrillLock } from './scheduler.js';

/**
 * Leader election, against a real Postgres (`plans/backups.md` §5).
 *
 * Advisory locks are one of the few things a mock cannot usefully stand in for:
 * every property here is a property of the *connection*, and a fake would
 * happily model the version of them that does not work.
 */
describe('backup leader election (integration)', () => {
  let pg: PgTestEnv;

  beforeAll(async () => {
    pg = await startPostgres();
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const heldLocks = async (): Promise<number> => {
    const res = await pg.handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    return Number(res.rows[0]?.n ?? 0);
  };

  it('runs the work for the instance that wins', async () => {
    const outcome = await withBackupLock(pg.handle.pool, 'prod', async () => 'ran');
    expect(outcome).toEqual({ ran: true, result: 'ran' });
  }, 300_000);

  it('declines rather than queueing when someone else holds it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const leader = withBackupLock(pg.handle.pool, 'prod', async () => {
      await held;
      return 'leader';
    });
    // Let the leader take the lock before the contender tries.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const contender = await withBackupLock(pg.handle.pool, 'prod', async () => 'contender');
    expect(contender.ran).toBe(false);

    release();
    expect(await leader).toEqual({ ran: true, result: 'leader' });
  }, 300_000);

  /**
   * **The regression test for a bug that shipped.**
   *
   * The first implementation acquired and released through `db.execute()`,
   * which takes an arbitrary pooled client per statement. Whenever the pool was
   * busy, the release ran on a different session than the acquire, Postgres
   * returned false instead of raising, and the lock stayed held forever on an
   * idle connection. Every subsequent backup then declined the lock and
   * returned quietly, because that is what a non-leader does: no error, no
   * alert, no backups.
   *
   * The concurrent queries are the whole point of the test. Without them the
   * pool usually hands back the same client and the broken version passes.
   */
  it('releases the lock even when the pool is busy during the work', async () => {
    const before = await heldLocks();

    const outcome = await withBackupLock(pg.handle.pool, 'prod', async () => {
      // Six other statements, so the lock holder is no longer the client the
      // pool would hand out next.
      await Promise.all(
        Array.from({ length: 6 }, () => pg.handle.db.execute(sql`SELECT pg_sleep(0.05)`)),
      );
      return 'done';
    });

    expect(outcome.ran).toBe(true);
    expect(await heldLocks()).toBe(before);

    // And the practical consequence: the next run can still take it.
    const next = await withBackupLock(pg.handle.pool, 'prod', async () => 'next');
    expect(next.ran).toBe(true);
  }, 300_000);

  it('releases the lock when the work throws', async () => {
    const before = await heldLocks();
    await expect(
      withBackupLock(pg.handle.pool, 'prod', async () => {
        throw new Error('dump failed');
      }),
    ).rejects.toThrow('dump failed');
    expect(await heldLocks()).toBe(before);
  }, 300_000);

  /**
   * A backup and a drill have no reason to exclude each other. Sharing a key is
   * how `0x5a7c_0002` produced "the billing job sometimes does not run".
   */
  it('lets a drill run while a backup holds its lock', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const backup = withBackupLock(pg.handle.pool, 'prod', async () => {
      await held;
      return 'backup';
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const drill = await withDrillLock(pg.handle.pool, 'prod', async () => 'drill');
    expect(drill).toEqual({ ran: true, result: 'drill' });

    release();
    await backup;
  }, 300_000);

  /** Beta taking a backup must not mark production's schedule satisfied. */
  it('scopes the lock per fleet', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const prod = withBackupLock(pg.handle.pool, 'prod', async () => {
      await held;
      return 'prod';
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const beta = await withBackupLock(pg.handle.pool, 'beta', async () => 'beta');
    expect(beta).toEqual({ ran: true, result: 'beta' });

    release();
    await prod;
  }, 300_000);
});
