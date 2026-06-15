import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
