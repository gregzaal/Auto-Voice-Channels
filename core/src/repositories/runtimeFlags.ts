import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { opsAudit, runtimeFlags } from '../db/schema.js';

/**
 * DB-backed runtime flags (the no-deploy control plane). Every mutation writes
 * an `ops_audit` entry in the same transaction so humans can see and reverse
 * agent actions.
 */
export class RuntimeFlagsRepository {
  constructor(private readonly db: Database) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const [row] = await this.db
      .select()
      .from(runtimeFlags)
      .where(eq(runtimeFlags.key, key))
      .limit(1);
    return row ? (row.value as T) : undefined;
  }

  async getBool(key: string, fallback = false): Promise<boolean> {
    const value = await this.get(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.select().from(runtimeFlags);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Upserts a flag and records an `ops_audit` entry atomically. */
  async set(
    key: string,
    value: unknown,
    options: { actor: string; reason?: string; description?: string } = { actor: 'agent' },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(runtimeFlags)
        .values({
          key,
          value: value as never,
          description: options.description ?? null,
          updatedBy: options.actor,
        })
        .onConflictDoUpdate({
          target: runtimeFlags.key,
          set: {
            value: value as never,
            ...(options.description !== undefined ? { description: options.description } : {}),
            updatedBy: options.actor,
            updatedAt: new Date(),
          },
        });

      await tx.insert(opsAudit).values({
        actor: options.actor,
        action: 'flag.set',
        target: key,
        details: { value, reason: options.reason ?? null } as never,
      });
    });
  }
}
