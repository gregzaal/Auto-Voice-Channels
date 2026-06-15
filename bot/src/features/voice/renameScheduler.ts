/**
 * Coalesces rapid rename triggers (join/leave/presence churn) into at most one
 * rename per channel per debounce window. Discord rate-limits channel renames
 * hard (≈2 per 10 minutes), so we avoid issuing redundant renames; discord.js
 * still queues any that do hit the limit.
 */
export interface RenameSchedulerOptions {
  /** Debounce window in milliseconds. */
  delayMs: number;
  /** Runs a (re)render for one channel. Errors are swallowed by the scheduler. */
  run: (guildId: string, channelId: string) => Promise<void>;
  onError?: (err: unknown, guildId: string, channelId: string) => void;
}

export class RenameScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: RenameSchedulerOptions) {}

  /** Schedules (or reschedules) a debounced re-render for a channel. */
  schedule(guildId: string, channelId: string): void {
    const existing = this.timers.get(channelId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(channelId);
      void this.options.run(guildId, channelId).catch((err: unknown) => {
        this.options.onError?.(err, guildId, channelId);
      });
    }, this.options.delayMs);
    // Don't keep the event loop alive solely for a pending rename.
    timer.unref?.();
    this.timers.set(channelId, timer);
  }

  /** Cancels all pending renames (graceful shutdown). */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
