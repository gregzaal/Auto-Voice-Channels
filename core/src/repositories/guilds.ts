import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm';
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
  /**
   * Null = the bot is in the guild. Set when it is removed, cleared on re-add.
   *
   * `.nullish()` rather than `.nullable()` on purpose: web and bot deploy
   * independently, so a build carrying this field can read rows before the
   * migration that adds the column has run. A missing key must degrade to
   * "unknown", not throw and blank the caller's entire guild list.
   */
  botRemovedAt: z.date().nullish(),
  /**
   * Denormalized guild identity. `.nullish()` for the same reason as
   * `botRemovedAt`: a build carrying these fields can read rows written before
   * the migration that adds the columns has run, and a missing key must degrade
   * to "unknown" rather than throw and blank the caller's whole list.
   */
  name: z.string().nullish(),
  iconHash: z.string().nullish(),
  ownerId: z.string().nullish(),
  memberCount: z.number().int().nullable(),
  memberCountUpdatedAt: z.date().nullable(),
  tier: z.enum(TIER_IDS).nullable(),
  /**
   * The member pool this guild bills through, or null for ordinary per-guild
   * billing. `.nullish()` for the usual reason: web and bot deploy
   * independently, and a build carrying this field can read rows written
   * before the migration that adds the column has run.
   */
  poolId: z.string().nullish(),
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

  /**
   * Records that the bot was removed from (or re-added to) a guild.
   *
   * The row itself is deliberately NOT deleted on removal. A removed guild can
   * still carry a live paid subscription, and the dashboard resolves a guild's
   * plan from this row: delete it and the card falls back to "AVC isn't in this
   * server yet", which hides the cancel button from someone still being billed.
   * Marking is also what lets the dashboard say so explicitly.
   *
   * Idempotent, and a no-op for a guild we have never seen (nothing to mark).
   */
  async setBotPresence(guildId: string, removedAt: Date | null): Promise<void> {
    await this.db
      .update(guilds)
      .set({ botRemovedAt: removedAt, updatedAt: new Date() })
      .where(eq(guilds.guildId, guildId));
  }

  /**
   * Clears the removal marker for every guild the bot can currently see.
   *
   * The event-driven writer above cannot do this. `guildCreate` is guarded on
   * `client.isReady()`, and discord.js does not emit it for the initial guild
   * batch at all, so a guild that was re-added while the fleet was down keeps
   * `bot_removed_at` set **forever**. `attentionFor` reads that column and
   * tells the owner, at `critical`, that they are paying for a server AVC is
   * not in, while the bot sits in it working perfectly.
   *
   * Latent since the column existed and harmless at three test guilds. It
   * stopped being harmless on 2026-08-19, when the beta fleet inherited 1004
   * real ones, some of them paying.
   *
   * Only ever clears, never sets: an instance owning a subset of shards sees a
   * subset of guilds, so "not in my cache" is not evidence of removal. Marking
   * removal stays with `guildDelete`, which is per-guild and unambiguous.
   *
   * Returns how many rows actually changed, so a boot that clears hundreds is
   * visible in the logs rather than inferred later from a support ticket.
   */
  async clearBotRemovedFor(guildIds: readonly string[]): Promise<number> {
    const ids = [...new Set(guildIds)];
    if (ids.length === 0) return 0;
    const cleared = await this.db
      .update(guilds)
      .set({ botRemovedAt: null, updatedAt: new Date() })
      .where(
        and(
          isNotNull(guilds.botRemovedAt),
          // A single JSON parameter rather than one bind per guild: `inArray`
          // expands to `IN ($1, $2, ...)` and walks into Postgres's 65535
          // parameter ceiling at cutover scale.
          sql`${guilds.guildId} = ANY(
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
          )`,
        ),
      )
      .returning({ guildId: guilds.guildId });
    return cleared.length;
  }

  /**
   * Upserts the denormalized guild identity (name / icon / owner) from a
   * gateway payload.
   *
   * Writes only when something actually changed. `GUILD_UPDATE` fires for every
   * kind of guild edit, most of which touch none of these three fields, and an
   * unconditional UPDATE would bump `updated_at` fleet-wide on every one of them
   * for no information gain.
   *
   * Creates the row if it is missing, so a guild the bot was already in when
   * this shipped gets its identity on the next gateway event rather than waiting
   * for a backfill.
   */
  async recordIdentity(
    guildId: string,
    identity: { name: string; iconHash: string | null; ownerId: string | null },
  ): Promise<void> {
    const [current] = await this.db
      .select({ name: guilds.name, iconHash: guilds.iconHash, ownerId: guilds.ownerId })
      .from(guilds)
      .where(eq(guilds.guildId, guildId))
      .limit(1);

    if (
      current &&
      current.name === identity.name &&
      current.iconHash === identity.iconHash &&
      current.ownerId === identity.ownerId
    ) {
      return;
    }

    await this.db
      .insert(guilds)
      .values({ guildId, ...identity })
      .onConflictDoUpdate({
        target: guilds.guildId,
        set: { ...identity, updatedAt: new Date() },
      });
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

  /**
   * Records that a one-off announcement was delivered to this guild
   * (`metadata.announcements.<key>`).
   *
   * Separate from `metadata.billing` on purpose: that object is parsed by
   * `parseBillingMeta` and round-tripped by the reconcile job, so putting
   * unrelated keys in it risks them being dropped by a schema that does not
   * know about them. Announcements are their own namespace.
   *
   * Idempotent, and the caller should only stamp on a CONFIRMED delivery, so a
   * re-run retries the guilds that failed rather than skipping them forever.
   */
  async markAnnounced(guildId: string, key: string, at = new Date()): Promise<void> {
    await this.db
      .update(guilds)
      .set({
        /**
         * Merged with `||`, NOT `jsonb_set`.
         *
         * `jsonb_set(metadata, '{announcements,key}', v, true)` looks right and
         * silently does nothing when `metadata` has no `announcements` object:
         * `create_missing` creates only the FINAL key, never an intermediate
         * level, and a path that cannot be walked returns the input unchanged.
         * No error, no row skipped, just a stamp that was never written. This
         * shipped and meant an interrupted broadcast would have re-sent to every
         * guild it had already reached.
         *
         * `||` creates the object when absent and preserves sibling keys when
         * present.
         */
        metadata: sql`${guilds.metadata} || jsonb_build_object(
          'announcements',
          coalesce(${guilds.metadata} -> 'announcements', '{}'::jsonb)
            || jsonb_build_object(${key}::text, ${at.toISOString()}::text)
        )`,
        updatedAt: new Date(),
      })
      .where(eq(guilds.guildId, guildId));
  }

  /**
   * Records that a permission-problem notice went out to this guild
   * (`metadata.problems`), with how many have gone out in the current run of
   * the condition so the sender can back off and eventually stop.
   *
   * Its own namespace, not `metadata.billing` (which `parseBillingMeta`
   * round-trips and would drop unknown keys) and not `metadata.announcements`
   * (whose values are bare timestamps, and whose contract is one-off sends).
   *
   * Merged with `||`, NOT `jsonb_set`, for the reason spelled out on
   * {@link markAnnounced}: `create_missing` creates only the final key, so a
   * guild whose metadata has no `problems` object yet, which is every guild the
   * first time, would silently not be written at all.
   *
   * Written on ATTEMPT rather than on confirmed delivery, which is the opposite
   * of `markAnnounced`. A guild whose permissions are broken is exactly the
   * guild every rung can fail for, and it is also the guild the sweep re-tests
   * every five minutes, so stamping on success alone would re-walk the whole
   * delivery ladder forever for the guilds least able to receive it.
   */
  async markProblemNotified(guildId: string, at: Date, sends: number): Promise<void> {
    await this.db
      .update(guilds)
      .set({
        metadata: sql`${guilds.metadata} || jsonb_build_object(
          'problems',
          coalesce(${guilds.metadata} -> 'problems', '{}'::jsonb)
            || jsonb_build_object(
                 'lastNotifiedAt', ${at.toISOString()}::text,
                 'sends', ${sends}::int
               )
        )`,
        updatedAt: new Date(),
      })
      .where(eq(guilds.guildId, guildId));
  }

  /**
   * Forgets a guild's notice history, once its problems have all cleared, so
   * the next unrelated problem starts from the shortest interval again.
   */
  async clearProblemNotified(guildId: string): Promise<void> {
    await this.db
      .update(guilds)
      .set({
        metadata: sql`${guilds.metadata} - 'problems'`,
        updatedAt: new Date(),
      })
      .where(eq(guilds.guildId, guildId));
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

  /**
   * Sets or clears which pool this guild bills through, and the tier cache
   * together, in one statement (`plans/member-based-pricing.md` §6.1: "the
   * two are written together"). `poolId: null` is the leaving-a-pool case.
   */
  async setPoolId(guildId: string, poolId: string | null, tier: TierId | null): Promise<GuildRow> {
    await this.ensure(guildId);
    const [updated] = await this.db
      .update(guilds)
      .set({ poolId, tier, updatedAt: new Date() })
      .where(eq(guilds.guildId, guildId))
      .returning();
    return guildRowSchema.parse(updated);
  }
}
