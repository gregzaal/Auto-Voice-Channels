import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { announcementDeliveries } from '../db/schema.js';

/** The delivery outcome for one guild, one touch. Mirrors `ops/announce.ts`'s `Outcome`. */
export type DeliveryTarget = 'system_channel' | 'owner_dm' | 'creator_channel' | 'failed';

/**
 * Per-guild delivery tracking for a one-shot broadcast
 * (`bot/src/ops/announce.ts`, `plans/marketing.md` §5.1 item 6).
 *
 * Replaces the earlier `guilds.metadata.announcements` dedupe stamp: that
 * blob answered "sent or not" but recorded no delivery method and had no
 * room for an opt-out. This table answers both, and stays idempotent the
 * same way — a redeploy mid-broadcast re-checks this table before sending
 * rather than re-sending blind.
 */
export class AnnouncementDeliveryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Guild ids among `guildIds` that already have a DELIVERED row for this
   * `(key, touch)` - `deliveredAt IS NOT NULL`, not merely a row's existence.
   * `recordFailed` also inserts a row (so a retry has something to update),
   * so without this filter a failed attempt would read as delivered and
   * never be retried without `--resend`. One query for the whole batch
   * rather than one per guild, since a broadcast walks the entire install
   * base.
   */
  async alreadyDelivered(key: string, touch: string, guildIds: string[]): Promise<Set<string>> {
    if (guildIds.length === 0) return new Set();
    const rows = await this.db
      .select({ guildId: announcementDeliveries.guildId })
      .from(announcementDeliveries)
      .where(
        and(
          eq(announcementDeliveries.key, key),
          eq(announcementDeliveries.touch, touch),
          isNotNull(announcementDeliveries.deliveredAt),
          inArray(announcementDeliveries.guildId, guildIds),
        ),
      );
    return new Set(
      rows
        .filter((r) => r.guildId !== null)
        .map((r) => r.guildId)
        .filter((id): id is string => id !== null),
    );
  }

  /**
   * Guild ids among `guildIds` that opted out of this announcement `key`,
   * on ANY touch — opting out is meant to skip every remaining touch of the
   * same announcement, not just the one that offered it.
   */
  async optedOut(key: string, guildIds: string[]): Promise<Set<string>> {
    if (guildIds.length === 0) return new Set();
    const rows = await this.db
      .select({ guildId: announcementDeliveries.guildId })
      .from(announcementDeliveries)
      .where(
        and(
          eq(announcementDeliveries.key, key),
          eq(announcementDeliveries.optedOut, true),
          inArray(announcementDeliveries.guildId, guildIds),
        ),
      );
    return new Set(rows.map((r) => r.guildId));
  }

  /** Records a successful delivery, or updates a prior failed attempt to success. */
  async recordDelivered(
    guildId: string,
    key: string,
    touch: string,
    target: DeliveryTarget,
    at = new Date(),
  ): Promise<void> {
    await this.db
      .insert(announcementDeliveries)
      .values({ guildId, key, touch, target, deliveredAt: at, lastError: null })
      .onConflictDoUpdate({
        target: [
          announcementDeliveries.guildId,
          announcementDeliveries.key,
          announcementDeliveries.touch,
        ],
        set: { target, deliveredAt: at, lastError: null, updatedAt: at },
      });
  }

  /**
   * Records a failed attempt, leaving `deliveredAt` unset so a re-run retries it.
   *
   * Also CLEARS `deliveredAt` on conflict, not just on insert: `--resend`
   * exists specifically to re-target an already-delivered guild, and a
   * second attempt that fails must not leave the first attempt's success
   * timestamp behind. Without this, `alreadyDelivered` (which filters on
   * `deliveredAt IS NOT NULL`) would keep reporting a guild as delivered
   * forever after, even though its most recent real attempt failed.
   */
  async recordFailed(
    guildId: string,
    key: string,
    touch: string,
    error: string,
    at = new Date(),
  ): Promise<void> {
    await this.db
      .insert(announcementDeliveries)
      .values({ guildId, key, touch, target: 'failed', lastError: error.slice(0, 500) })
      .onConflictDoUpdate({
        target: [
          announcementDeliveries.guildId,
          announcementDeliveries.key,
          announcementDeliveries.touch,
        ],
        set: { target: 'failed', deliveredAt: null, lastError: error.slice(0, 500), updatedAt: at },
      });
  }
}
