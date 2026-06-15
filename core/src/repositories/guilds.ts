import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { guildAuthEvents, guilds } from '../db/schema.js';
import { AUTH_STATUSES, type AuthStatus, isEntitled } from '../domain/auth.js';

/** zod schema validating a guild row read from the DB (boundary validation). */
export const guildRowSchema = z.object({
  guildId: z.string(),
  authStatus: z.enum(AUTH_STATUSES),
  authExpiresAt: z.date().nullable(),
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

      const [updated] = await tx
        .update(guilds)
        .set({
          authStatus: input.toStatus,
          ...(input.expiresAt !== undefined ? { authExpiresAt: input.expiresAt } : {}),
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

      return guildRowSchema.parse(updated);
    });
  }

  /** Merges partial settings into the guild's settings jsonb. */
  async updateSettings(guildId: string, patch: Record<string, unknown>): Promise<GuildRow> {
    const current = await this.ensure(guildId);
    const merged = { ...current.settings, ...patch };
    const [updated] = await this.db
      .update(guilds)
      .set({ settings: merged, updatedAt: new Date() })
      .where(eq(guilds.guildId, guildId))
      .returning();
    return guildRowSchema.parse(updated);
  }
}
