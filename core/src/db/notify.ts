import pg from 'pg';
import type { Logger } from '../logger.js';

/** Postgres channel used to broadcast guild settings-cache invalidations. */
export const SETTINGS_INVALIDATE_CHANNEL = 'avc_settings_invalidate';

/**
 * Postgres channel carrying one **Discord snowflake** whose supporter roles in
 * the support guild may have changed.
 *
 * The snowflake, not the Auth.js user id, deliberately: the listener is a
 * Discord-side actor and would otherwise have to resolve `users.id` ->
 * `accounts.provider_account_id` before it could do anything, which is the
 * exact comparison that silently never matches when someone gets it wrong.
 * Web already deals in Auth.js ids, so the translation happens there.
 *
 * Best-effort like every other broadcast here: the support-guild reconcile on
 * reconnect, and the daily sweep, both converge on their own from the database.
 */
export const SUPPORTER_SYNC_CHANNEL = 'avc_supporter_sync';

export type NotifyListener = (payload: string) => void;

/**
 * How often to poke the `LISTEN` connection with a no-op query.
 *
 * TCP keepalive is configured in {@link PgNotifier.openClient} and is NOT
 * sufficient on its own. Observed on the beta fleet 2026-08-21: 28 drop and
 * reconnect cycles in 4.5 hours, on an exact ten-minute cadence, with
 * `keepAlive` enabled and a 10s initial delay. Whatever the private-network
 * path counts as activity, it is not keepalive probes.
 *
 * So the connection generates real traffic instead, which no middlebox can
 * decline to count. Four minutes puts two beats inside the shortest window
 * that has actually been seen to reap us, so losing one does not let the flow
 * go quiet.
 *
 * The second effect is worth as much as the first: a blackholed socket is
 * otherwise discovered on the next NOTIFY, which on a quiet night can be
 * hours. A beat turns that into at most one interval, and the failure path
 * below routes it into the same reconnect loop as any other drop.
 */
export const NOTIFIER_HEARTBEAT_MS = 240_000;

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
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly connectionString: string,
    private readonly logger?: Logger,
    private readonly heartbeatIntervalMs: number = NOTIFIER_HEARTBEAT_MS,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = await this.openClient();
    this.startHeartbeat();
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
    // Cleared before `end()` so a beat cannot race the teardown and resurrect
    // the reconnect loop on the way out.
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.listeners.clear();
    this.reconnectHandlers.clear();
    if (this.client) {
      await this.client.end();
      this.client = undefined;
    }
  }

  /**
   * Armed once and left running across reconnects: the beat reads `this.client`
   * each tick rather than closing over one connection, so it keeps working
   * after the reconnect loop swaps the client out.
   */
  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatIntervalMs <= 0) return;
    this.heartbeat = setInterval(() => void this.beat(), this.heartbeatIntervalMs);
    // Unref'd so a notifier is never the reason the process refuses to exit.
    this.heartbeat.unref();
  }

  private async beat(): Promise<void> {
    const client = this.client;
    if (!client || this.closed || this.reconnecting) return;
    try {
      await client.query('SELECT 1');
    } catch (err) {
      /**
       * `SELECT 1` has no logical way to fail, so a rejection here is the
       * connection, not the query. Driving `handleDrop` directly matters
       * because a blackholed socket may never emit 'error' or 'end' at all:
       * that is the case this beat exists to catch. It is guarded on `closed`
       * and `reconnecting`, so calling it redundantly alongside a real event is
       * harmless.
       */
      this.logger?.warn({ err }, 'pg notifier heartbeat failed; reconnecting');
      this.handleDrop();
    }
  }

  private async openClient(): Promise<pg.Client> {
    /**
     * `keepAlive` matters more here than anywhere else in the codebase. A
     * LISTEN connection is idle by definition: it sends nothing and waits. The
     * private-network path drops idle flows after about ten minutes, so without
     * keepalives this socket is guaranteed to die on a timer, taking settings-
     * cache invalidation with it until the reconnect loop notices.
     */
    const client = new pg.Client({
      connectionString: this.connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
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
