import pg from 'pg';

/** Postgres channel used to broadcast guild settings-cache invalidations. */
export const SETTINGS_INVALIDATE_CHANNEL = 'avc_settings_invalidate';

export type NotifyListener = (payload: string) => void;

/**
 * A thin wrapper over a dedicated `LISTEN`/`NOTIFY` connection. This is the
 * coordination seam for settings-cache invalidation and lightweight signals.
 * It is intentionally swappable: a different backend (e.g. a shared store)
 * could implement the same interface later if ever needed.
 */
export class PgNotifier {
  private client: pg.Client | undefined;
  private readonly listeners = new Map<string, Set<NotifyListener>>();

  constructor(private readonly connectionString: string) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    client.on('notification', (msg) => {
      const set = this.listeners.get(msg.channel);
      if (!set) return;
      for (const fn of set) fn(msg.payload ?? '');
    });
    this.client = client;
  }

  /** Subscribes to a channel; returns an unsubscribe function. */
  async listen(channel: string, listener: NotifyListener): Promise<() => void> {
    if (!this.client) throw new Error('PgNotifier not connected');
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.client.query(`LISTEN ${quoteIdent(channel)}`);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** Publishes a payload on a channel. */
  async notify(channel: string, payload: string): Promise<void> {
    if (!this.client) throw new Error('PgNotifier not connected');
    await this.client.query('SELECT pg_notify($1, $2)', [channel, payload]);
  }

  async close(): Promise<void> {
    this.listeners.clear();
    if (this.client) {
      await this.client.end();
      this.client = undefined;
    }
  }
}

/** Quotes a Postgres identifier for use in LISTEN (which can't be parameterized). */
function quoteIdent(ident: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Unsafe channel identifier: ${ident}`);
  }
  return `"${ident}"`;
}
