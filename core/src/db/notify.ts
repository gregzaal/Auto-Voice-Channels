import pg from 'pg';
import type { Logger } from '../logger.js';

/** Postgres channel used to broadcast guild settings-cache invalidations. */
export const SETTINGS_INVALIDATE_CHANNEL = 'avc_settings_invalidate';

export type NotifyListener = (payload: string) => void;

/**
 * A thin wrapper over a dedicated `LISTEN`/`NOTIFY` connection. This is the
 * coordination seam for settings-cache invalidation and lightweight signals.
 * It is intentionally swappable: a different backend (e.g. a shared store)
 * could implement the same interface later if ever needed.
 *
 * The connection self-heals: on a dropped connection it reconnects with backoff,
 * re-`LISTEN`s every channel, and fires the {@link onReconnect} handlers so a
 * consumer (the settings cache) can resync — invalidations may have been missed
 * during the gap.
 */
export class PgNotifier {
  private client: pg.Client | undefined;
  private readonly listeners = new Map<string, Set<NotifyListener>>();
  private readonly reconnectHandlers = new Set<() => void>();
  private closed = false;
  private reconnecting = false;

  constructor(
    private readonly connectionString: string,
    private readonly logger?: Logger,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = await this.openClient();
  }

  /** Registers a handler fired after a reconnect (so consumers can resync state). */
  onReconnect(handler: () => void): void {
    this.reconnectHandlers.add(handler);
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

  /**
   * Publishes a payload on a channel. Best-effort while disconnected: if the
   * connection is mid-reconnect, the publish is dropped (callers rely on the
   * cache TTL + reconnect-resync to bound any resulting staleness).
   */
  async notify(channel: string, payload: string): Promise<void> {
    if (!this.client) {
      this.logger?.warn({ channel }, 'pg notifier disconnected; dropping NOTIFY (best-effort)');
      return;
    }
    await this.client.query('SELECT pg_notify($1, $2)', [channel, payload]);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    this.reconnectHandlers.clear();
    if (this.client) {
      await this.client.end();
      this.client = undefined;
    }
  }

  private async openClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      const set = this.listeners.get(msg.channel);
      if (!set) return;
      for (const fn of set) fn(msg.payload ?? '');
    });
    // A connection-level error or close drops us into the reconnect loop. (pg emits
    // 'error' on the client for async failures; without a handler it would throw.)
    client.on('error', (err) => {
      this.logger?.warn({ err }, 'pg notifier connection error');
      this.handleDrop();
    });
    client.on('end', () => this.handleDrop());
    await client.connect();
    return client;
  }

  private handleDrop(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.client = undefined;
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    let delayMs = 500;
    const maxDelayMs = 10_000;
    while (!this.closed) {
      try {
        const client = await this.openClient();
        for (const channel of this.listeners.keys()) {
          await client.query(`LISTEN ${quoteIdent(channel)}`);
        }
        this.client = client;
        this.reconnecting = false;
        this.logger?.info('pg notifier reconnected; re-listened channels');
        for (const handler of this.reconnectHandlers) handler();
        return;
      } catch (err) {
        this.logger?.warn({ err, delayMs }, 'pg notifier reconnect failed; retrying');
        await delay(delayMs);
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quotes a Postgres identifier for use in LISTEN (which can't be parameterized). */
function quoteIdent(ident: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Unsafe channel identifier: ${ident}`);
  }
  return `"${ident}"`;
}
