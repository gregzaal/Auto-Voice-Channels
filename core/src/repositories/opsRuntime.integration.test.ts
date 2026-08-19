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
