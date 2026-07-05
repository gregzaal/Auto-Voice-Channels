import { asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { guildAuthEvents, guilds, opsAudit } from '../db/schema.js';
import { AUTH_STATUSES, type AuthStatus, isEntitled } from '../domain/auth.js';
import {
  MAX_MEMBER_SAMPLES,
  parseBillingMeta,
  sanitizeMemberCountSample,
  utcDayKey,
  type BillingMeta,
} from '../domain/billing.js';
import { TIER_IDS, type TierId } from '../domain/tiers.js';

/** zod schema validating a guild row read from the DB (boundary validation). */
export const guildRowSchema = z.object({
  guildId: z.string(),
  authStatus: z.enum(AUTH_STATUSES),
  authExpiresAt: z.date().nullable(),
  graceUntil: z.date().nullable(),
  memberCount: z.number().int().nullable(),
  memberCountUpdatedAt: z.date().nullable(),
  tier: z.enum(TIER_IDS).nullable(),
  settings: z.record(z.unknown()),
  metadata: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type GuildRow = z.infer<typeof guildRowSchema>;

export interface TransitionAuthInput {
  guildId: string;
  toStatus: AuthStatus;
  reason?: string;
  actor?: string;
  expiresAt?: Date | null;
  /**
   * Sets `authExpiresAt` ONLY when it is currently null — the DB-level
   * "trial window is set exactly once" invariant (monetization.md §3: the
   * clock starts at FIRST add). Ignored when `expiresAt` is also given.
   */
  expiresAtIfNull?: Date;
  /** New grace-window end. Omit to leave unchanged; null clears it. */
  graceUntil?: Date | null;
}

export interface RecordSampleResult {
  row: GuildRow;
  /** False when the anomaly clamps held the value back (monetization.md §12). */
  accepted: boolean;
}

/**
 * Repository for the `guilds` table and its auth-state audit log.
 *
 * Validation: rows are validated with zod at the boundary; a corrupt row throws
 * and quarantines to its guild rather than corrupting shared state.
 */
export class GuildRepository {
  constructor(private readonly db: Database) {}

  /** Ensures a guild row exists (idempotent). Returns the (validated) row. */
  async ensure(guildId: string): Promise<GuildRow> {
    const [row] = await this.db
      .insert(guilds)
      .values({ guildId })
      .onConflictDoNothing({ target: guilds.guildId })
      .returning();
    if (row) return guildRowSchema.parse(row);
    return this.getOrThrow(guildId);
  }

  async get(guildId: string): Promise<GuildRow | undefined> {
    const [row] = await this.db.select().from(guilds).where(eq(guilds.guildId, guildId)).limit(1);
    return row ? guildRowSchema.parse(row) : undefined;
  }

  async getOrThrow(guildId: string): Promise<GuildRow> {
    const row = await this.get(guildId);
    if (!row) throw new Error(`Guild ${guildId} not found`);
    return row;
  }

  /** Fast entitlement gate. Unknown guilds default to a fresh `trial`. */
  async isEntitled(guildId: string, selfHosted: boolean): Promise<boolean> {
    const row = await this.get(guildId);
    const status: AuthStatus = row?.authStatus ?? 'trial';
    return isEntitled({ status, selfHosted });
  }

  /**
   * Keyset-paginated listing for the billing reconcile job: guilds ordered by
   * id, starting strictly after `afterGuildId`. Rows that fail validation are
   * skipped (quarantined) rather than aborting the whole sweep.
   */
  async listBatch(
    afterGuildId: string | undefined,
    limit: number,
  ): Promise<{ rows: GuildRow[]; lastGuildId: string | undefined }> {
    const rows = await this.db
      .select()
      .from(guilds)
      .where(afterGuildId !== undefined ? gt(guilds.guildId, afterGuildId) : undefined)
      .orderBy(asc(guilds.guildId))
      .limit(limit);
    const parsed: GuildRow[] = [];
    for (const row of rows) {
      const result = guildRowSchema.safeParse(row);
      if (result.success) parsed.push(result.data);
    }
    const last = rows[rows.length - 1];
    return { rows: parsed, lastGuildId: last ? (last.guildId as string) : undefined };
  }

  /**
   * Transitions a guild's auth state and appends an audit event in the SAME
   * transaction (atomic). Idempotent for a no-op transition to the same status.
   */
  async transitionAuth(input: TransitionAuthInput): Promise<GuildRow> {
    return this.db.transaction(async (tx) => {
      await tx.insert(guilds).values({ guildId: input.guildId }).onConflictDoNothing();
      const [current] = await tx
        .select()
        .from(guilds)
        .where(eq(guilds.guildId, input.guildId))
        .for('update');
      if (!current) throw new Error(`Guild ${input.guildId} not found`);

      const fromStatus = current.authStatus as AuthStatus;
      const setExpiresAt =
        input.expiresAt !== undefined
          ? { authExpiresAt: input.expiresAt }
          : input.expiresAtIfNull !== undefined && current.authExpiresAt === null
            ? { authExpiresAt: input.expiresAtIfNull }
            : {};

      const [updated] = await tx
        .update(guilds)
        .set({
          authStatus: input.toStatus,
          ...setExpiresAt,
          ...(input.graceUntil !== undefined ? { graceUntil: input.graceUntil } : {}),
          updatedAt: new Date(),
        })
        .where(eq(guilds.guildId, input.guildId))
        .returning();

      await tx.insert(guildAuthEvents).values({
        guildId: input.guildId,
        fromStatus,
        toStatus: input.toStatus,
        reason: input.reason ?? null,
        actor: input.actor ?? 'system',
      });

      // Also record it in the operational audit log so auth changes — notably
      // `blocked` (the per-guild kill-switch) — surface in `v_recent_ops`, the view
      // an operator/agent queries for recent operational actions.
      await tx.insert(opsAudit).values({
        actor: input.actor ?? 'system',
        action: `guild.auth.${input.toStatus}`,
        target: input.guildId,
        details: {
          from: fromStatus,
          to: input.toStatus,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });

      return guildRowSchema.parse(updated);
    });
  }

  /**
   * Merges partial settings into the guild's settings jsonb. The merge happens
   * **DB-side** (`settings || $patch`) in a single statement — so concurrent
   * writers (e.g. a future dashboard alongside the bot) can't clobber each other
   * the way a read-modify-write would. Shallow, like the previous JS spread:
   * top-level keys in the patch replace existing ones.
   */
  async updateSettings(guildId: string, patch: Record<string, unknown>): Promise<GuildRow> {
    await this.ensure(guildId);
    const [updated] = await this.db
      .update(guilds)
      .set({
        settings: sql`${guilds.settings} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(guilds.guildId, guildId))
      .returning();
    return guildRowSchema.parse(updated);
  }

  /**
   * Records a member-count sample: updates `member_count` (+timestamp) and
   * appends/replaces the day's entry in the rolling daily history kept in
   * `metadata.billing.samples`. The §12 anomaly clamps run inside — a lone
   * ~0 sample or >50% single-day swing is held back as `pendingAnomaly` until
   * a later sample confirms it. `authoritative: true` (a fresh REST
   * `with_counts` read, §5 step 3) bypasses the clamps — it IS ground truth.
   *
   * Runs read-modify-write under `FOR UPDATE` so concurrent writers (the
   * owning shard's sampler vs. the reconcile job) can't clobber the history.
   */
  async recordMemberCountSample(
    guildId: string,
    count: number,
    opts: { at?: Date; authoritative?: boolean } = {},
  ): Promise<RecordSampleResult> {
    const at = opts.at ?? new Date();
    const day = utcDayKey(at);
    return this.db.transaction(async (tx) => {
      await tx.insert(guilds).values({ guildId }).onConflictDoNothing();
      const [current] = await tx
        .select()
        .from(guilds)
        .where(eq(guilds.guildId, guildId))
        .for('update');
      if (!current) throw new Error(`Guild ${guildId} not found`);

      const metadata = (current.metadata ?? {}) as Record<string, unknown>;
      const billing = parseBillingMeta(metadata);
      const lastSample = billing.samples[billing.samples.length - 1];
      const previous = lastSample?.count ?? (current.memberCount as number | null);

      const decision = opts.authoritative
        ? { accept: true as const, clamped: false as const }
        : sanitizeMemberCountSample(previous, count, day, billing.pendingAnomaly);

      let next: BillingMeta;
      if (decision.accept) {
        const samples = billing.samples.filter((s) => s.day !== day);
        samples.push({ day, count });
        next = {
          ...billing,
          samples: samples.slice(-MAX_MEMBER_SAMPLES),
        };
        delete next.pendingAnomaly;
      } else {
        next = { ...billing, pendingAnomaly: { day, count } };
      }

      const [updated] = await tx
        .update(guilds)
        .set({
          ...(decision.accept ? { memberCount: count, memberCountUpdatedAt: at } : {}),
          metadata: sql`${guilds.metadata} || ${JSON.stringify({ billing: next })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(guilds.guildId, guildId))
        .returning();
      return { row: guildRowSchema.parse(updated), accepted: decision.accept };
    });
  }

  /**
   * Marks a billing notification as delivered (dedupe bookkeeping in
   * `metadata.billing.notifications`), pruning the map to the most recent
   * entries so it stays bounded.
   */
  async recordBillingNotification(guildId: string, key: string, at = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(guilds)
        .where(eq(guilds.guildId, guildId))
        .for('update');
      if (!current) return;
      const billing = parseBillingMeta((current.metadata ?? {}) as Record<string, unknown>);
      const notifications = { ...billing.notifications, [key]: at.toISOString() };
      const keys = Object.keys(notifications);
      if (keys.length > 40) {
        keys
          .sort((a, b) => Date.parse(notifications[a] ?? '') - Date.parse(notifications[b] ?? ''))
          .slice(0, keys.length - 40)
          .forEach((k) => delete notifications[k]);
      }
      await tx
        .update(guilds)
        .set({
          metadata: sql`${guilds.metadata} || ${JSON.stringify({ billing: { ...billing, notifications } })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(guilds.guildId, guildId));
    });
  }

  /** Marks the one-time new-guild onboarding as done (`metadata.billing.onboardedAt`). */
  async markOnboarded(guildId: string, at = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(guilds)
        .where(eq(guilds.guildId, guildId))
        .for('update');
      if (!current) return;
      const billing = parseBillingMeta((current.metadata ?? {}) as Record<string, unknown>);
      if (billing.onboardedAt) return;
      await tx
        .update(guilds)
        .set({
          metadata: sql`${guilds.metadata} || ${JSON.stringify({ billing: { ...billing, onboardedAt: at.toISOString() } })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(guilds.guildId, guildId));
    });
  }

  /** Sets the billed-tier cache (what the guild's subscription covers). */
  async setBilledTier(guildId: string, tier: TierId | null): Promise<GuildRow> {
    await this.ensure(guildId);
    const [updated] = await this.db
      .update(guilds)
      .set({ tier, updatedAt: new Date() })
      .where(eq(guilds.guildId, guildId))
      .returning();
    return guildRowSchema.parse(updated);
  }
}
