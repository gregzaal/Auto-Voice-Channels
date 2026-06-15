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
}

/**
 * Creates a Drizzle database handle backed by a `pg.Pool`. Callers own the
 * lifecycle and must call {@link DbHandle.close} on shutdown.
 */
export function createDatabase(options: CreateDatabaseOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
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
