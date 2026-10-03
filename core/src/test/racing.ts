import { sql } from 'drizzle-orm';
import type { PgTestEnv } from './pgContainer.js';

/** Waits until some connection is blocked on a lock, which is the moment to let the holder go. */
async function untilBlocked(env: PgTestEnv): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await env.handle.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing ever waited on the held lock');
}

/**
 * Holds one statement open and uncommitted on a second connection, starts `racer`, waits until
 * it is blocked behind that statement, then commits it. This is the interleaving a race needs,
 * which two calls in a `Promise.all` only produce by luck, and it resolves to what `racer`
 * resolved to.
 *
 * For a statement that has to re-read a row once the lock is released, which is exactly what
 * a read-then-write implementation gets wrong and a single DB-side statement gets right.
 */
export async function racing<T>(
  env: PgTestEnv,
  held: string,
  params: unknown[],
  racer: () => Promise<T>,
): Promise<T> {
  const holder = await env.handle.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(held, params);
    const pending = racer();
    await untilBlocked(env);
    await holder.query('COMMIT');
    return await pending;
  } catch (err) {
    await holder.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    holder.release();
  }
}
