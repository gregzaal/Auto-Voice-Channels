import { SETTINGS_INVALIDATE_CHANNEL } from '../db/notify.js';
import type { PgNotifier } from '../db/notify.js';
import type { AuthStatus } from './auth.js';
import type { GuildRepository, GuildRow, TransitionAuthInput } from '../repositories/guilds.js';
import type { TierId } from './tiers.js';

/**
 * Read seam for guild settings on the hot path. Both {@link SettingsCache} and a
 * raw {@link GuildRepository} satisfy it, so the voice feature can be wired with
 * either (cache in production, repo in tests).
 */
export interface GuildSettingsReader {
  ensure(guildId: string): Promise<GuildRow>;
}

/**
 * Read+write seam. Settings/auth mutations go through here so the cache can
 * invalidate (locally + cluster-wide). A raw {@link GuildRepository} also
 * satisfies it structurally.
 */
export interface GuildSettingsStore extends GuildSettingsReader {
  updateSettings(guildId: string, patch: Record<string, unknown>): Promise<GuildRow>;
  transitionAuth(input: TransitionAuthInput): Promise<GuildRow>;
  /**
   * Sets the billed-tier cache with invalidation, exactly like
   * `transitionAuth`. Needed by the billing reconciler's pool pass, which
   * fans a pool's `billed_tier` out to every member guild's `guilds.tier`
   * (`plans/member-based-pricing.md` §5.1) — a plain `GuildRepository` write
   * would leave every other instance's settings cache serving the old tier
   * for up to its TTL.
   */
  setBilledTier(guildId: string, tier: TierId | null): Promise<GuildRow>;
  /**
   * Read-modify-write under the row lock, with invalidation.
   *
   * For any settings key whose new value depends on its old one. `updateSettings`
   * merges DB-side but only at the TOP level, so a nested map like `aliases` is
   * replaced wholesale, and a read-then-write of it loses whatever landed in
   * between. The legacy importer merges that same key one level deeper, so
   * "in between" includes a live import pass, which is why the repository's own
   * `mergeSettings` exists.
   */
  mergeSettings<T>(
    guildId: string,
    decide: (
      existing: { authStatus: AuthStatus; settings: Record<string, unknown> } | undefined,
    ) => { patch: Record<string, unknown>; remove?: readonly string[]; result: T },
  ): Promise<T>;
}

interface Entry {
  row: GuildRow;
  fetchedAt: number;
}

export interface SettingsCacheOptions {
  /**
   * Max age before a cached entry is re-read. A safety net bounding staleness if a
   * NOTIFY invalidation is ever missed (NOTIFY is best-effort). Default 60s.
   */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-process guild settings cache with cross-instance invalidation over Postgres
 * `LISTEN/NOTIFY`. The DB stays the source of truth; this only avoids re-reading
 * unchanged settings on the hot path (every voice event reads guild settings).
 *
 * Consistency: writes route through {@link updateSettings}/{@link transitionAuth},
 * which write to the DB then invalidate (local evict + broadcast). Receivers evict
 * on the broadcast; a dropped LISTEN connection resyncs by clearing the whole cache
 * on reconnect; and a per-entry TTL bounds staleness if a broadcast is ever missed.
 */
export class SettingsCache implements GuildSettingsStore {
  private readonly cache = new Map<string, Entry>();
  private unsubscribe: (() => void) | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly repo: GuildRepository,
    private readonly notifier: PgNotifier,
    options: SettingsCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Begins listening for invalidation broadcasts and reconnect resyncs. */
  async start(): Promise<void> {
    this.unsubscribe = await this.notifier.listen(SETTINGS_INVALIDATE_CHANNEL, (guildId) => {
      this.cache.delete(guildId);
    });
    // A reconnect may have missed invalidations during the gap — drop everything.
    this.notifier.onReconnect(() => this.cache.clear());
  }

  /** Returns the guild row (creating it if absent), served from cache when fresh. */
  async ensure(guildId: string): Promise<GuildRow> {
    const hit = this.cache.get(guildId);
    if (hit && this.now() - hit.fetchedAt < this.ttlMs) return hit.row;
    const row = await this.repo.ensure(guildId);
    this.cache.set(guildId, { row, fetchedAt: this.now() });
    return row;
  }

  /** Writes a settings patch through to the DB, then invalidates the cache. */
  async updateSettings(guildId: string, patch: Record<string, unknown>): Promise<GuildRow> {
    const row = await this.repo.updateSettings(guildId, patch);
    await this.invalidate(guildId);
    return row;
  }

  /** Read-modify-write under the row lock, then invalidates the cache. */
  async mergeSettings<T>(
    guildId: string,
    decide: (
      existing: { authStatus: AuthStatus; settings: Record<string, unknown> } | undefined,
    ) => { patch: Record<string, unknown>; remove?: readonly string[]; result: T },
  ): Promise<T> {
    const result = await this.repo.mergeSettings(guildId, decide);
    await this.invalidate(guildId);
    return result;
  }

  /** Transitions auth state through to the DB, then invalidates the cache. */
  async transitionAuth(input: TransitionAuthInput): Promise<GuildRow> {
    const row = await this.repo.transitionAuth(input);
    await this.invalidate(input.guildId);
    return row;
  }

  /** Sets the billed-tier cache through to the DB, then invalidates the cache. */
  async setBilledTier(guildId: string, tier: TierId | null): Promise<GuildRow> {
    const row = await this.repo.setBilledTier(guildId, tier);
    await this.invalidate(guildId);
    return row;
  }

  /** Local eviction (does not broadcast). */
  evict(guildId: string): void {
    this.cache.delete(guildId);
  }

  /**
   * Evicts locally and broadcasts invalidation to all instances. The broadcast is
   * best-effort (the notifier drops it while reconnecting); the TTL + reconnect
   * resync bound any resulting staleness, so a failed broadcast never fails a write.
   */
  async invalidate(guildId: string): Promise<void> {
    this.cache.delete(guildId);
    try {
      await this.notifier.notify(SETTINGS_INVALIDATE_CHANNEL, guildId);
    } catch {
      // best-effort; TTL + reconnect-resync cover the gap.
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cache.clear();
  }
}
