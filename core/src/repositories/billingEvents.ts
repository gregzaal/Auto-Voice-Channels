import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { billingEvents } from '../db/schema.js';

export interface RecordBillingEventInput {
  /** Paddle's event id — the idempotency key. */
  paddleEventId: string;
  eventType: string;
  guildId?: string | null;
  /**
   * The pool the event concerns. Set for a pool subscription's events, which
   * carry no `guild_id` at all, and which pooling being the default billing
   * unit makes the ordinary case rather than the exception.
   */
  poolId?: string | null;
  payload: Record<string, unknown>;
}

/**
 * Append-only Paddle webhook log. `recordOnce` is the idempotency gate for
 * webhook processing (monetization.md §9): the unique `paddle_event_id`
 * constraint makes a redelivered event a no-op, and the caller only applies
 * side effects when `inserted` is true.
 */
export class BillingEventRepository {
  constructor(private readonly db: Database) {}

  /** Records the event; `inserted: false` means it was already processed. */
  async recordOnce(input: RecordBillingEventInput): Promise<{ inserted: boolean }> {
    const rows = await this.db
      .insert(billingEvents)
      .values({
        paddleEventId: input.paddleEventId,
        eventType: input.eventType,
        guildId: input.guildId ?? null,
        poolId: input.poolId ?? null,
        payload: input.payload as never,
      })
      .onConflictDoNothing({ target: billingEvents.paddleEventId })
      .returning({ id: billingEvents.id });
    return { inserted: rows.length > 0 };
  }

  /** Stamps the event as fully processed (side effects applied). */
  async markProcessed(paddleEventId: string, at = new Date()): Promise<void> {
    await this.db
      .update(billingEvents)
      .set({ processedAt: at })
      .where(eq(billingEvents.paddleEventId, paddleEventId));
  }

  async get(paddleEventId: string) {
    const [row] = await this.db
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.paddleEventId, paddleEventId))
      .limit(1);
    return row;
  }
}
