import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { memberPools, opsAudit } from '../db/schema.js';
import {
  MAX_MEMBER_SAMPLES,
  parseBillingMeta,
  sanitizeMemberCountSample,
  utcDayKey,
  type BillingMeta,
} from '../domain/billing.js';
import { TIER_IDS, type TierId } from '../domain/tiers.js';

/**
 * A member pool: one subscription covering any number of servers whose member
 * counts sum to under the band ceiling (`plans/member-based-pricing.md`).
 *
 * `status` is never `'trial'` (§5.4) — a pool is a paid construct only, and
 * the type below is intentionally narrower than `AuthStatus` for exactly that
 * reason. `billedTier` is written only by the Paddle webhook (§5.1); the
 * *required* tier is always re-derived from `memberCount` via `tierFor()`.
 */
export const POOL_STATUSES = ['active', 'grace', 'expired'] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

export const memberPoolRowSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  name: z.string().nullable(),
  billedTier: z.enum(TIER_IDS).nullable(),
  status: z.enum(POOL_STATUSES),
  graceUntil: z.date().nullable(),
  memberCount: z.number().int().nullable(),
  memberCountUpdatedAt: z.date().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MemberPoolRow = z.infer<typeof memberPoolRowSchema>;

export interface RecordPoolSampleResult {
  row: MemberPoolRow;
  accepted: boolean;
}

/**
 * Repository for `member_pools`. Same boundary-validation style as
 * `GuildRepository`, and deliberately reuses its billing-metadata helpers
 * (`domain/billing.ts`) rather than re-implementing the sampler and anomaly
 * clamps a second time: a pool's `metadata` column holds the exact same
 * `{ billing: { samples, notifications, pendingAnomaly? } }` shape a guild's
 * does.
 */
export class MemberPoolRepository {
  constructor(private readonly db: Database) {}

  async get(poolId: string): Promise<MemberPoolRow | undefined> {
    const [row] = await this.db
      .select()
      .from(memberPools)
      .where(eq(memberPools.id, poolId))
      .limit(1);
    return row ? memberPoolRowSchema.parse(row) : undefined;
  }

  async getOrThrow(poolId: string): Promise<MemberPoolRow> {
    const row = await this.get(poolId);
    if (!row) throw new Error('That subscription could not be found.');
    return row;
  }

  async listByOwner(ownerUserId: string): Promise<MemberPoolRow[]> {
    const rows = await this.db
      .select()
      .from(memberPools)
      .where(eq(memberPools.ownerUserId, ownerUserId));
    const out: MemberPoolRow[] = [];
    for (const raw of rows) {
      const parsed = memberPoolRowSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /**
   * Keyset-paginated listing for the billing reconcile job's pool pass,
   * mirroring `GuildRepository.listBatch`.
   */
  async listBatch(
    afterPoolId: string | undefined,
    limit: number,
  ): Promise<{ rows: MemberPoolRow[]; lastPoolId: string | undefined }> {
    const rows = await this.db
      .select()
      .from(memberPools)
      .where(afterPoolId !== undefined ? sql`${memberPools.id} > ${afterPoolId}` : undefined)
      .orderBy(memberPools.id)
      .limit(limit);
    const parsed: MemberPoolRow[] = [];
    for (const row of rows) {
      const result = memberPoolRowSchema.safeParse(row);
      if (result.success) parsed.push(result.data);
    }
    const last = rows[rows.length - 1];
    return { rows: parsed, lastPoolId: last ? (last.id as string) : undefined };
  }

  /**
   * Creates a new pool. Idempotent on `id` (a checkout retry must not create
   * two pools for one purchase). Always `active` (§5.4) — there is no other
   * entry point, because a pool comes into existence by completing checkout.
   *
   * `name` defaults to `"Server pool N"`, `N` computed by the caller
   * (`select count(*) from member_pools where owner_user_id = $1`) at
   * creation time and never renumbered afterward (§6.1).
   */
  async create(input: {
    id: string;
    ownerUserId: string;
    name: string;
    billedTier: TierId;
  }): Promise<MemberPoolRow> {
    const [row] = await this.db
      .insert(memberPools)
      .values({
        id: input.id,
        ownerUserId: input.ownerUserId,
        name: input.name,
        billedTier: input.billedTier,
        status: 'active',
      })
      .onConflictDoNothing({ target: memberPools.id })
      .returning();
    if (row) return memberPoolRowSchema.parse(row);
    return this.getOrThrow(input.id);
  }

  /** Count of pools already owned, for the default-name sequence number. */
  async countByOwner(ownerUserId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)::text` })
      .from(memberPools)
      .where(eq(memberPools.ownerUserId, ownerUserId));
    return Number(row?.n ?? 0);
  }

  /** A plain rename. Not billing-affecting, so no webhook or reconciler involvement. */
  async rename(poolId: string, name: string): Promise<void> {
    await this.db
      .update(memberPools)
      .set({ name, updatedAt: new Date() })
      .where(eq(memberPools.id, poolId));
  }

  /** Sets the billed-tier cache. Written only by the Paddle webhook (§5.1). */
  async setBilledTier(poolId: string, tier: TierId | null): Promise<void> {
    await this.db
      .update(memberPools)
      .set({ billedTier: tier, updatedAt: new Date() })
      .where(eq(memberPools.id, poolId));
  }

  /**
   * Transitions the pool's own status, and records it to `ops_audit` (a pool
   * has no per-row audit table of its own the way `guild_auth_events` is for
   * guilds; `ops_audit` targeting the pool id is the record).
   */
  async transitionStatus(input: {
    poolId: string;
    toStatus: PoolStatus;
    reason: string;
    actor?: string;
    graceUntil?: Date | null;
  }): Promise<MemberPoolRow> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(memberPools)
        .where(eq(memberPools.id, input.poolId))
        .for('update');
      if (!current) throw new Error('That subscription could not be found.');
      const fromStatus = current.status as PoolStatus;

      const [updated] = await tx
        .update(memberPools)
        .set({
          status: input.toStatus,
          ...(input.graceUntil !== undefined ? { graceUntil: input.graceUntil } : {}),
          updatedAt: new Date(),
        })
        .where(eq(memberPools.id, input.poolId))
        .returning();

      await tx.insert(opsAudit).values({
        actor: input.actor ?? 'system',
        action: `pool.auth.${input.toStatus}`,
        target: input.poolId,
        details: {
          from: fromStatus,
          to: input.toStatus,
          reason: input.reason,
        },
      });

      return memberPoolRowSchema.parse(updated);
    });
  }

  /**
   * Records a daily observed pooled-member-count sample, identical in shape
   * and behaviour to `GuildRepository.recordMemberCountSample` (same anomaly
   * clamps, same rolling window). The pool pass always passes
   * `authoritative: true`: the sum it computes each tick is derived fresh
   * from every live member guild's own count, not a cached hint, so there is
   * nothing for the clamps to protect against here.
   */
  async recordMemberCountSample(
    poolId: string,
    count: number,
    opts: { at?: Date; authoritative?: boolean } = {},
  ): Promise<RecordPoolSampleResult> {
    const at = opts.at ?? new Date();
    const day = utcDayKey(at);
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(memberPools)
        .where(eq(memberPools.id, poolId))
        .for('update');
      if (!current) throw new Error('That subscription could not be found.');

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
        next = { ...billing, samples: samples.slice(-MAX_MEMBER_SAMPLES) };
        delete next.pendingAnomaly;
      } else {
        next = { ...billing, pendingAnomaly: { day, count } };
      }

      const [updated] = await tx
        .update(memberPools)
        .set({
          ...(decision.accept ? { memberCount: count, memberCountUpdatedAt: at } : {}),
          metadata: sql`${memberPools.metadata} || ${JSON.stringify({ billing: next })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(memberPools.id, poolId))
        .returning();
      return { row: memberPoolRowSchema.parse(updated), accepted: decision.accept };
    });
  }

  /**
   * Clears the daily sample history (notifications kept) — called on every
   * membership change (§5.2a). Never reinterpreted, only reset: an add or a
   * remove must not let 45 days of history computed under the OLD membership
   * decide today's breach/drop verdict for the NEW one.
   */
  async resetSamples(poolId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(memberPools)
        .where(eq(memberPools.id, poolId))
        .for('update');
      if (!current) return;
      const billing = parseBillingMeta((current.metadata ?? {}) as Record<string, unknown>);
      const next: BillingMeta = { ...billing, samples: [] };
      delete next.pendingAnomaly;
      await tx
        .update(memberPools)
        .set({
          metadata: sql`${memberPools.metadata} || ${JSON.stringify({ billing: next })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(memberPools.id, poolId));
    });
  }

  /** Records a delivered pool-level notification's dedupe stamp (§6.6). */
  async recordNotification(poolId: string, key: string, at = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(memberPools)
        .where(eq(memberPools.id, poolId))
        .for('update');
      if (!current) return;
      const billing = parseBillingMeta((current.metadata ?? {}) as Record<string, unknown>);
      const notifications = { ...billing.notifications, [key]: at.toISOString() };
      await tx
        .update(memberPools)
        .set({
          metadata: sql`${memberPools.metadata} || ${JSON.stringify({ billing: { ...billing, notifications } })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(memberPools.id, poolId));
    });
  }
}
