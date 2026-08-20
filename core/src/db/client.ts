import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * The connection pool behind a {@link Database}.
 *
 * Exported because a few things genuinely need a *connection* rather than a
 * query runner: session-scoped advisory locks and `LISTEN` both belong to one
 * client and break silently when each statement gets whichever client is free.
 */
export type DbPool = pg.Pool;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions {
  connectionString: string;
  /**
   * Called when an IDLE pooled client errors. Without a handler the pool's
   * 'error' event is unhandled and Node throws, so a dropped socket becomes a
   * crash. Log it and move on: the pool discards the client and the next
   * checkout opens a fresh one.
   */
  onPoolError?: (err: Error) => void;
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
    /**
     * TCP keepalive, and it is load-bearing rather than a nicety.
     *
     * Postgres itself never closes these: `idle_session_timeout` is 0 and the
     * server's own `tcp_keepalives_idle` is 7200s. The thing that drops them is
     * the network path -- the hosted database is reached over Fly's private
     * IPv6 mesh, and an idle flow through it goes away after roughly ten
     * minutes. Without client keepalives nothing holds the path open, the
     * socket is silently blackholed, and the application only finds out on the
     * next read, as ECONNRESET or "Connection terminated unexpectedly".
     *
     * That failure took the beta fleet down overnight on 2026-08-20 and the
     * shape of it is worth remembering: it did NOT happen during the busy
     * evening, because constant traffic meant no connection was ever idle long
     * enough to be reaped. It began when activity dropped. A load test would
     * not have found it; only quiet does.
     *
     * The blast radius is everything, because `SettingsCache.ensure` sits
     * behind the entitlement gate, which is in front of both voice events and
     * commands. One dead socket means the bot does nothing at all for that
     * guild.
     */
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ...(options.applicationName !== undefined ? { application_name: options.applicationName } : {}),
  });
  /**
   * An idle client that errors emits on the POOL, not on any query. Node's
   * default for an unhandled 'error' on an EventEmitter is to throw, which
   * would turn a dropped socket into a process crash.
   */
  pool.on('error', (err) => {
    options.onPoolError?.(err);
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
