import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { RuntimeFlagsRepository } from './runtimeFlags.js';
import { OpsAuditRepository } from './opsAudit.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

describe('RuntimeFlags + OpsAudit (integration)', () => {
  let env: PgTestEnv;
  let flags: RuntimeFlagsRepository;
  let audit: OpsAuditRepository;

  beforeAll(async () => {
    env = await startPostgres();
    flags = new RuntimeFlagsRepository(env.handle.db);
    audit = new OpsAuditRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('set() upserts a flag and records an ops_audit entry atomically', async () => {
    await flags.set('global.pause', true, { actor: 'agent', reason: 'incident' });
    expect(await flags.getBool('global.pause')).toBe(true);

    const recent = await audit.recent(10);
    const entry = recent.find((e) => e.action === 'flag.set' && e.target === 'global.pause');
    expect(entry).toBeDefined();
    expect(entry?.actor).toBe('agent');
    expect(entry?.details).toMatchObject({ value: true, reason: 'incident' });
  });

  /**
   * `import.disabled` is the one lever whose blast radius is not fleet-scoped:
   * `guilds.settings` has no fleet column, so an import through either bot
   * rewrites the row both read. One click has to stop every path into it.
   */
  describe('getBoolAnyFleet', () => {
    it('is true when any fleet has set it, whichever fleet is asking', async () => {
      const beta = new RuntimeFlagsRepository(env.handle.db, 'beta');
      const prod = new RuntimeFlagsRepository(env.handle.db, 'prod');

      expect(await prod.getBoolAnyFleet('import.disabled')).toBe(false);

      await beta.set('import.disabled', true, { actor: 'agent', reason: 'incident' });

      // Per-fleet reads still disagree, which is the trap this method exists for.
      expect(await prod.getBool('import.disabled')).toBe(false);
      expect(await beta.getBool('import.disabled')).toBe(true);

      expect(await prod.getBoolAnyFleet('import.disabled')).toBe(true);
      expect(await beta.getBoolAnyFleet('import.disabled')).toBe(true);
    });

    it('is false once every fleet has cleared it', async () => {
      const beta = new RuntimeFlagsRepository(env.handle.db, 'beta');
      const prod = new RuntimeFlagsRepository(env.handle.db, 'prod');
      await beta.set('import.announce_disabled', true, { actor: 'agent' });
      await prod.set('import.announce_disabled', false, { actor: 'agent' });

      expect(await prod.getBoolAnyFleet('import.announce_disabled')).toBe(true);

      await beta.set('import.announce_disabled', false, { actor: 'agent' });
      expect(await prod.getBoolAnyFleet('import.announce_disabled')).toBe(false);
    });
  });

  /**
   * The table had no retention at all, while `metrics_hourly` has had a prune
   * since it existed. Survivable while every writer was an operator action, and
   * not once `/import` made it grow with a customer action.
   */
  describe('audit retention', () => {
    it('drops entries past the window and keeps the rest', async () => {
      await env.handle.db.execute('DELETE FROM ops_audit');
      const now = new Date('2026-09-01T00:00:00Z');
      const old = new Date('2025-08-01T00:00:00Z');
      await env.handle.db.execute(
        `INSERT INTO ops_audit (actor, action, target, created_at) VALUES
           ('t', 'old.action', 'a', '${old.toISOString()}'),
           ('t', 'new.action', 'b', '${now.toISOString()}')`,
      );

      const removed = await audit.prune(now);

      expect(removed).toBe(1);
      const left = await audit.recent(10);
      expect(left.map((r) => r.action)).toEqual(['new.action']);
    });

    it('is a no-op when nothing is old enough', async () => {
      await env.handle.db.execute('DELETE FROM ops_audit');
      await audit.record({ actor: 't', action: 'fresh', target: 'x' });
      expect(await audit.prune(new Date())).toBe(0);
      expect(await audit.recent(10)).toHaveLength(1);
    });

    it('honours a shorter window when one is asked for', async () => {
      await env.handle.db.execute('DELETE FROM ops_audit');
      await audit.record({ actor: 't', action: 'fresh', target: 'x' });
      // Everything is older than a zero-day window.
      expect(await audit.prune(new Date(Date.now() + 86_400_000), 0)).toBe(1);
    });
  });

  it('overwrites an existing flag value', async () => {
    await flags.set('throttle.create', 5, { actor: 'agent' });
    await flags.set('throttle.create', 10, { actor: 'agent' });
    expect(await flags.get('throttle.create')).toBe(10);
  });

  it('getBool returns the fallback for missing/non-bool flags', async () => {
    expect(await flags.getBool('does.not.exist', true)).toBe(true);
    await flags.set('not.a.bool', 'string', { actor: 'agent' });
    expect(await flags.getBool('not.a.bool', false)).toBe(false);
  });

  it('getAll returns every flag', async () => {
    await flags.set('a.flag', 1, { actor: 'agent' });
    const all = await flags.getAll();
    expect(all).toHaveProperty('a.flag', 1);
  });

  it('audit.record appends and recent() returns newest first', async () => {
    await audit.record({ actor: 'agent', action: 'guild.block', target: 'g-99' });
    const recent = await audit.recent(1);
    expect(recent[0]?.action).toBe('guild.block');
  });
  /**
   * `value` is NOT NULL, so the obvious way to clear a flag raises a
   * constraint violation. The backup scheduler did exactly that on every
   * success, inside a catch that swallowed it, so a recovered fleet kept
   * showing the failure that was already over.
   */
  it('clears a flag by removing it, and records the removal', async () => {
    await flags.set('backup.last_error', 'pg_dump exited 1', { actor: 'test' });
    expect(await flags.get('backup.last_error')).toBe('pg_dump exited 1');

    await flags.clear('backup.last_error', { actor: 'test' });
    expect(await flags.get('backup.last_error')).toBeUndefined();

    const rows = await env.handle.db.execute<{ action: string }>(
      sql`SELECT action FROM ops_audit WHERE target = 'backup.last_error' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows.rows[0]?.action).toBe('flag.clear');
  });

  it('is a no-op on a flag that was never set', async () => {
    await expect(flags.clear('backup.never_set', { actor: 'test' })).resolves.toBeUndefined();
  });
});
