import type { Logger, ShardLeaseRepository } from '@avc/core';

/** Discord's required spacing between identifies in the same rate-limit bucket. */
const IDENTIFY_SPACING_MS = 5_000;

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('identify wait aborted');
}

/** A delay that rejects promptly if the abort signal fires. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(toAbortError(signal.reason));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface IdentifyThrottlerOptions {
  repo: ShardLeaseRepository;
  /** Discord's `session_start_limit.max_concurrency` (identifies per 5s bucket). */
  maxConcurrency: number;
  logger: Logger;
  /** Minimum spacing between identifies in one bucket (Discord: 5s). */
  spacingMs?: number;
  /** Upper bound on a single poll wait when a bucket is busy. */
  pollCapMs?: number;
  /** Injectable delay (defaults to a real, abortable timer). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Cluster-wide identify throttler. `@discordjs/ws` calls `waitForIdentify(shardId)`
 * before sending each IDENTIFY; we resolve only once the shard's bucket
 * (`shardId % max_concurrency`) is free, enforcing Discord's 5s-per-bucket spacing
 * across *all* instances via {@link ShardLeaseRepository.reserveIdentify}. Without
 * this, a multi-instance deploy re-identifying at once would collectively exceed
 * `max_concurrency` and trip the gateway's identify rate limit (risking a ban).
 *
 * Structurally implements `@discordjs/ws`'s `IIdentifyThrottler`.
 */
export class PgIdentifyThrottler {
  private readonly repo: ShardLeaseRepository;
  private readonly maxConcurrency: number;
  private readonly logger: Logger;
  private readonly spacingMs: number;
  private readonly pollCapMs: number;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: IdentifyThrottlerOptions) {
    this.repo = options.repo;
    this.maxConcurrency = Math.max(1, options.maxConcurrency);
    this.logger = options.logger.child({ component: 'identify-throttler' });
    this.spacingMs = options.spacingMs ?? IDENTIFY_SPACING_MS;
    this.pollCapMs = options.pollCapMs ?? 1_000;
    this.sleepFn = options.sleep ?? abortableDelay;
  }

  async waitForIdentify(shardId: number, signal: AbortSignal): Promise<void> {
    const bucket = ((shardId % this.maxConcurrency) + this.maxConcurrency) % this.maxConcurrency;
    for (;;) {
      if (signal.aborted) throw toAbortError(signal.reason);
      const { ok, waitMs } = await this.repo.reserveIdentify(bucket, this.spacingMs);
      if (ok) {
        this.logger.debug({ shardId, bucket }, 'identify slot reserved');
        return;
      }
      // Re-check after roughly the reported wait (capped so a stale estimate can't
      // park us too long), re-acquiring the lock each pass so cross-instance
      // ordering stays fair.
      await this.sleepFn(Math.min(Math.max(waitMs, 1), this.pollCapMs), signal);
    }
  }
}
