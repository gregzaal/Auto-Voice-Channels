import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { opsAudit, runtimeFlags } from '../db/schema.js';

/**
 * DB-backed runtime flags (the no-deploy control plane). Every mutation writes
 * an `ops_audit` entry in the same transaction so humans can see and reverse
 * agent actions.
 */
export class RuntimeFlagsRepository {
  /**
   * Flags are per fleet (`plans/fleets.md` §2): pausing beta must not pause
   * production, and that independence is the whole reason for having a beta.
   * Defaults to `prod`, so self-host and existing callers are unchanged.
   */
  constructor(
    private readonly db: Database,
    private readonly fleet: Fleet = DEFAULT_FLEET,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const [row] = await this.db
      .select()
      .from(runtimeFlags)
      .where(and(eq(runtimeFlags.fleet, this.fleet), eq(runtimeFlags.key, key)))
      .limit(1);
    return row ? (row.value as T) : undefined;
  }

  async getBool(key: string, fallback = false): Promise<boolean> {
    const value = await this.get(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select()
      .from(runtimeFlags)
      .where(eq(runtimeFlags.fleet, this.fleet));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * Whether ANY fleet has this flag set true.
   *
   * Almost every lever here is correctly per fleet: pausing beta must not pause
   * production. `import.disabled` is the exception, because the thing it stops
   * is not fleet-scoped. `guilds.settings` has no `fleet` column and
   * `avc_settings_invalidate` is one global channel, so an `/import` run through
   * the beta bot rewrites the row prod reads and tells every prod instance to
   * pick it up, `enabled` included. 35 guilds have both bots installed.
   *
   * So an operator reaching for the kill switch during an incident needs one
   * click to stop every path into that blob, not one per fleet with no
   * indication that the others exist.
   */
  async getBoolAnyFleet(key: string): Promise<boolean> {
    const rows = await this.db
      .select({ value: runtimeFlags.value })
      .from(runtimeFlags)
      .where(eq(runtimeFlags.key, key));
    return rows.some((r) => r.value === true);
  }

  /**
   * Removes a flag, and records the removal.
   *
   * **Not `set(key, null)`.** `runtime_flags.value` is `NOT NULL`, so writing a
   * JS null raises a constraint violation rather than clearing anything. The
   * backup scheduler had been "clearing" `backup.last_error` on every success
   * that way for as long as the flag existed, inside a `.catch(() => {})` that
   * swallowed the error, so a fleet that failed once and then recovered would
   * have shown a stale failure next to a healthy backup forever. Absence is the
   * right representation of "no error" anyway: `get` returns undefined and
   * `/admin/ops` shows the fallback.
   */
  async clear(key: string, options: { actor: string; reason?: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(runtimeFlags)
        .where(and(eq(runtimeFlags.fleet, this.fleet), eq(runtimeFlags.key, key)));
      await tx.insert(opsAudit).values({
        actor: options.actor,
        action: 'flag.clear',
        target: key,
        fleet: this.fleet,
        details: { reason: options.reason ?? null } as never,
      });
    });
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
          fleet: this.fleet,
          key,
          value: value as never,
          description: options.description ?? null,
          updatedBy: options.actor,
        })
        .onConflictDoUpdate({
          // Composite: the same flag key is a different row per fleet.
          target: [runtimeFlags.fleet, runtimeFlags.key],
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
        fleet: this.fleet,
        details: { value, reason: options.reason ?? null } as never,
      });
    });
  }
}
