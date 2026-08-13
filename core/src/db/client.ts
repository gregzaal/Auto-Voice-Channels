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
   * Server-side `statement_timeout` for every connection in this pool, in ms.
   *
   * For pools whose queries are exploratory rather than on a known hot path -
   * an operator console, an ad-hoc report - so one accidental sequential scan
   * cannot pin a connection indefinitely and starve the pool it shares a
   * database with. Omit for the bot's own pool, where every query is a bounded,
   * indexed lookup and a timeout would only add a failure mode.
   */
  statementTimeoutMs?: number;
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
 */
export function createDatabase(options: CreateDatabaseOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ...(options.statementTimeoutMs !== undefined
      ? { statement_timeout: options.statementTimeoutMs }
      : {}),
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
