import {
  isEntitled,
  SETTINGS_INVALIDATE_CHANNEL,
  type GuildSettingsReader,
  type Logger,
  type PgNotifier,
} from '@avc/core';

export interface EntitlementGateOptions {
  /** Row source (the SettingsCache in production — already TTL-cached). */
  guilds: GuildSettingsReader;
  /** Optional LISTEN hookup so auth transitions evict instantly cluster-wide. */
  notifier?: PgNotifier;
  selfHosted: boolean;
  logger: Logger;
  /** Max staleness of the sync answer. Default 60s (matches the settings cache). */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Synchronous entitlement answers for the hot paths (presence intake, voice
 * events) — the §4 hard-gate short-circuit that makes non-entitled guilds cost
 * ~0 CPU/RAM. `check()` never blocks: it serves a cached boolean and refreshes
 * in the background, **failing open** for unknown guilds — the authoritative
 * `isEntitled` check downstream (`VoiceFeature.maybeCreate`) still gates any
 * real action, so a stale `true` can never create channels for a gated guild;
 * it only costs a few queue hops until the cache warms.
 */
export class EntitlementGate {
  private readonly cache = new Map<string, { entitled: boolean; fetchedAt: number }>();
  private readonly refreshing = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: EntitlementGateOptions) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Subscribes to settings invalidations so auth transitions evict promptly. */
  async start(): Promise<void> {
    if (!this.opts.notifier) return;
    this.unsubscribe = await this.opts.notifier.listen(SETTINGS_INVALIDATE_CHANNEL, (guildId) => {
      /**
       * Mark STALE, do not delete.
       *
       * `check()` is sync and answers `hit?.entitled ?? true`, so deleting the
       * entry made the next voice event fail open and be processed as entitled.
       * Exactly one event per guild slipped through after every invalidation,
       * which is enough to create a channel for a guild we just gated. Observed
       * live: a gated guild's empty-channel cleanup ran anyway.
       *
       * Keeping the last known value makes this genuinely
       * stale-while-revalidate: the answer may be one refresh out of date, but
       * it is never a guess. Fail-open then applies only to guilds we have
       * never seen, which is the case it was designed for.
       */
      const hit = this.cache.get(guildId);
      if (hit) this.cache.set(guildId, { ...hit, fetchedAt: 0 });
      // Refresh now rather than waiting for the next event, so the stale window
      // is microseconds in the common case instead of until the next join.
      this.refresh(guildId);
    });
    this.opts.notifier.onReconnect(() => this.cache.clear());
  }

  /** Sync gate for hot paths. Stale-while-revalidate; unknown guilds pass. */
  check(guildId: string): boolean {
    const hit = this.cache.get(guildId);
    const fresh = hit !== undefined && this.now() - hit.fetchedAt < this.ttlMs;
    if (!fresh) this.refresh(guildId);
    return hit?.entitled ?? true;
  }

  private refresh(guildId: string): void {
    if (this.refreshing.has(guildId)) return;
    this.refreshing.add(guildId);
    void this.opts.guilds
      .ensure(guildId)
      .then((row) => {
        this.cache.set(guildId, {
          entitled: isEntitled({ status: row.authStatus, selfHosted: this.opts.selfHosted }),
          fetchedAt: this.now(),
        });
      })
      .catch((err: unknown) => {
        // Fail open: a DB blip must never mute a healthy guild's events.
        this.opts.logger.debug({ err, guildId }, 'entitlement refresh failed');
      })
      .finally(() => this.refreshing.delete(guildId));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cache.clear();
  }
}
