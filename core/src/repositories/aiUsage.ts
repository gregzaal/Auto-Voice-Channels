import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { aiUsage } from '../db/schema.js';

/** The UTC calendar-month key (`YYYY-MM`) for a date. The cap resets on the 1st. */
export function utcMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export interface BuildReservation {
  /** False when the guild is already at its monthly cap. */
  allowed: boolean;
  /** Builds consumed this month **including** this one when allowed. */
  used: number;
  /** The cap in force (0 = unlimited). */
  limit: number;
}

export interface AiMonthUsage {
  builds: number;
  refunds: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Per-guild-per-month `/templateassistant` usage
 * (`plans/assisted_templates.md` §5).
 *
 * Two things live here and they are deliberately different in kind:
 *
 * - **{@link reserveBuild}** is a runaway-cost backstop. The cap is uniform on
 *   every tier, is never raised by paying, and is not an entitlement check —
 *   `SELF_HOSTED` skips it entirely at the call site.
 * - **{@link monthTotals}** feeds the fleet-wide spend ceiling (§5.2), which is
 *   the control that actually bounds total exposure; a per-guild cap never can.
 *
 * The month key is the reset mechanism (a new month is a new row), so nothing
 * has to run on the 1st and there is no clock to race.
 */
export class AiUsageRepository {
  constructor(private readonly db: Database) {}

  /**
   * Atomically consumes one build against the guild's monthly cap.
   *
   * Reserve-then-spend, not spend-then-count: the increment and the limit test
   * are a single statement, so concurrent interactions in one guild cannot both
   * squeeze past the cap. A provider failure afterwards is given back via
   * {@link refundBuild} — the reservation is only meant to bound spend, so a
   * call that never reached the provider must not cost the guild a build.
   *
   * `limit <= 0` means unlimited (the `create.rate_limit_per_min` convention).
   */
  async reserveBuild(guildId: string, month: string, limit: number): Promise<BuildReservation> {
    if (limit <= 0) {
      const row = await this.incrementUnbounded(guildId, month);
      return { allowed: true, used: row, limit: 0 };
    }
    // The `WHERE` on the DO UPDATE makes this a compare-and-swap: at the cap no
    // row comes back and nothing was written.
    const result = await this.db.execute(sql`
      INSERT INTO ai_usage (guild_id, month, builds)
      VALUES (${guildId}, ${month}, 1)
      ON CONFLICT (guild_id, month) DO UPDATE
        SET builds = ai_usage.builds + 1, updated_at = now()
        WHERE ai_usage.builds < ${limit}
      RETURNING builds
    `);
    const used = (result.rows[0] as { builds?: number | string } | undefined)?.builds;
    if (used === undefined) return { allowed: false, used: limit, limit };
    return { allowed: true, used: Number(used), limit };
  }

  /** Gives a reserved build back after a provider/transport failure. */
  async refundBuild(guildId: string, month: string): Promise<void> {
    await this.db
      .update(aiUsage)
      .set({
        builds: sql`greatest(${aiUsage.builds} - 1, 0)`,
        refunds: sql`${aiUsage.refunds} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(aiUsage.guildId, guildId), eq(aiUsage.month, month)));
  }

  /** Adds the provider's reported token usage for one call. */
  async recordTokens(
    guildId: string,
    month: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    const prompt = Math.max(0, Math.trunc(promptTokens));
    const completion = Math.max(0, Math.trunc(completionTokens));
    if (prompt === 0 && completion === 0) return;
    await this.db
      .insert(aiUsage)
      .values({ guildId, month, promptTokens: prompt, completionTokens: completion })
      .onConflictDoUpdate({
        target: [aiUsage.guildId, aiUsage.month],
        set: {
          promptTokens: sql`${aiUsage.promptTokens} + ${prompt}`,
          completionTokens: sql`${aiUsage.completionTokens} + ${completion}`,
          updatedAt: new Date(),
        },
      });
  }

  /** This guild's usage for a month (0s when it has never used the assistant). */
  async guildUsage(guildId: string, month: string): Promise<AiMonthUsage> {
    const [row] = await this.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.guildId, guildId), eq(aiUsage.month, month)))
      .limit(1);
    if (!row) return { builds: 0, refunds: 0, promptTokens: 0, completionTokens: 0 };
    return {
      builds: Number(row.builds),
      refunds: Number(row.refunds),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
    };
  }

  /** Fleet-wide totals for a month — the input to the global spend ceiling (§5.2). */
  async monthTotals(month: string): Promise<AiMonthUsage> {
    const result = await this.db.execute(sql`
      SELECT
        coalesce(sum(builds), 0)            AS builds,
        coalesce(sum(refunds), 0)           AS refunds,
        coalesce(sum(prompt_tokens), 0)     AS prompt_tokens,
        coalesce(sum(completion_tokens), 0) AS completion_tokens
      FROM ai_usage WHERE month = ${month}
    `);
    const row = result.rows[0] as Record<string, string | number> | undefined;
    return {
      builds: Number(row?.['builds'] ?? 0),
      refunds: Number(row?.['refunds'] ?? 0),
      promptTokens: Number(row?.['prompt_tokens'] ?? 0),
      completionTokens: Number(row?.['completion_tokens'] ?? 0),
    };
  }

  /** The unlimited path: still counted (diagnostics + the fleet ceiling need it). */
  private async incrementUnbounded(guildId: string, month: string): Promise<number> {
    const [row] = await this.db
      .insert(aiUsage)
      .values({ guildId, month, builds: 1 })
      .onConflictDoUpdate({
        target: [aiUsage.guildId, aiUsage.month],
        set: { builds: sql`${aiUsage.builds} + 1`, updatedAt: new Date() },
      })
      .returning({ builds: aiUsage.builds });
    return Number(row?.builds ?? 1);
  }
}
