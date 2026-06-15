import { SETTINGS_INVALIDATE_CHANNEL } from '../db/notify.js';
import type { PgNotifier } from '../db/notify.js';
import type { GuildRepository, GuildRow } from '../repositories/guilds.js';

/**
 * In-process guild settings cache with cross-instance invalidation over
 * Postgres `LISTEN/NOTIFY`. The DB remains the source of truth; this only
 * avoids re-reading unchanged settings on the hot path.
 *
 * Invalidation is intentionally simple: a NOTIFY carrying a guild id evicts
 * that guild's entry on every instance.
 */
export class SettingsCache {
  private readonly cache = new Map<string, GuildRow>();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly repo: GuildRepository,
    private readonly notifier: PgNotifier,
  ) {}

  /** Begins listening for invalidation broadcasts. */
  async start(): Promise<void> {
    this.unsubscribe = await this.notifier.listen(SETTINGS_INVALIDATE_CHANNEL, (guildId) => {
      this.cache.delete(guildId);
    });
  }

  async get(guildId: string): Promise<GuildRow> {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    const row = await this.repo.ensure(guildId);
    this.cache.set(guildId, row);
    return row;
  }

  /** Local eviction (does not broadcast). */
  evict(guildId: string): void {
    this.cache.delete(guildId);
  }

  /** Evicts locally and broadcasts invalidation to all instances. */
  async invalidate(guildId: string): Promise<void> {
    this.cache.delete(guildId);
    await this.notifier.notify(SETTINGS_INVALIDATE_CHANNEL, guildId);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cache.clear();
  }
}
