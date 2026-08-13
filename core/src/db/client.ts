import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions {
  connectionString: string;
  /** Max pool size. Keep modest; Postgres connections are finite. */
  max?: number;
  /**
   * `application_name`, which shows up in `pg_stat_activity`. Worth setting
   * whenever more than one pool talks to the same database: without it, "what is
   * running this query" has no answer.
   */
  applicationName?: string;
}

/**
 * Creates a Drizzle database handle backed by a `pg.Pool`. Callers own the
 * lifecycle and must call {@link DbHandle.close} on shutdown.
 *
 * **Do not add `statement_timeout` (or other GUCs) here.** node-postgres sends
 * any such option in the connection STARTUP packet, and a transaction-pooling
 * proxy - which is what the hosted Postgres sits behind - rejects the
 * connection outright with `unsupported startup parameter: statement_timeout`.
 * It cannot track a per-session GUC across pooled backends, so it refuses
 * rather than lie about it.
 *
 * This is invisible in development, where Postgres is connected to directly and
 * the same option works fine. It shipped once and took the operator console
 * down in production while every local check stayed green.
 *
 * To bound a query, issue `SET LOCAL statement_timeout` inside an explicit
 * transaction, which is scoped to that transaction and therefore safe through a
 * pooler.
 */
export function createDatabase(options: CreateDatabaseOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.applicationName !== undefined ? { application_name: options.applicationName } : {}),
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
