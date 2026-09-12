import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { costsMonthly, opsAudit } from '../db/schema.js';

export interface MonthlyCosts {
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  flyCents: number;
  postgresCents: number;
  modelSpendCents: number;
  paddleFeesCents: number;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface CostsInput {
  flyCents: number;
  postgresCents: number;
  modelSpendCents: number;
  paddleFeesCents: number;
}

/**
 * Hand-entered monthly infrastructure costs. A tiny, narrow table by design: one row a month, four
 * numbers, no history beyond what an operator chooses to type in.
 */
export class CostsRepository {
  constructor(private readonly db: Database) {}

  async get(month: string): Promise<MonthlyCosts | undefined> {
    const [row] = await this.db
      .select()
      .from(costsMonthly)
      .where(eq(costsMonthly.month, month))
      .limit(1);
    return row;
  }

  /** Every month ever entered, oldest first (`month` sorts chronologically as text). */
  async all(): Promise<MonthlyCosts[]> {
    return this.db.select().from(costsMonthly).orderBy(asc(costsMonthly.month));
  }

  /** Upserts one month's figures and records an `ops_audit` entry atomically. */
  async set(
    month: string,
    input: CostsInput,
    options: { actor: string; reason: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(costsMonthly)
        .values({ month, ...input, updatedBy: options.actor })
        .onConflictDoUpdate({
          target: costsMonthly.month,
          set: { ...input, updatedBy: options.actor, updatedAt: new Date() },
        });

      await tx.insert(opsAudit).values({
        actor: options.actor,
        action: 'costs.set',
        target: month,
        details: { ...input, reason: options.reason } as never,
      });
    });
  }
}
