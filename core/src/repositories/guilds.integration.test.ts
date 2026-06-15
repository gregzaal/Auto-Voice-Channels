import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GuildRepository } from './guilds.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

describe('GuildRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: GuildRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new GuildRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('ensure() is idempotent and creates a trial guild', async () => {
    const a = await repo.ensure('g-1');
    const b = await repo.ensure('g-1');
    expect(a.guildId).toBe('g-1');
    expect(a.authStatus).toBe('trial');
    expect(b.guildId).toBe('g-1');
    expect(b.createdAt.getTime()).toBe(a.createdAt.getTime());
  });

  it('isEntitled reflects auth status and SELF_HOSTED bypass', async () => {
    await repo.ensure('g-2');
    expect(await repo.isEntitled('g-2', false)).toBe(true); // trial
    await repo.transitionAuth({ guildId: 'g-2', toStatus: 'expired' });
    expect(await repo.isEntitled('g-2', false)).toBe(false);
    expect(await repo.isEntitled('g-2', true)).toBe(true); // self-hosted bypass
    await repo.transitionAuth({ guildId: 'g-2', toStatus: 'blocked' });
    expect(await repo.isEntitled('g-2', true)).toBe(false); // kill-switch wins
  });

  it('unknown guilds default to entitled trial', async () => {
    expect(await repo.isEntitled('never-seen', false)).toBe(true);
  });

  it('transitionAuth writes the guild and an audit event atomically', async () => {
    await repo.ensure('g-3');
    const updated = await repo.transitionAuth({
      guildId: 'g-3',
      toStatus: 'active',
      reason: 'payment',
      actor: 'agent',
    });
    expect(updated.authStatus).toBe('active');

    const events = await env.handle.db.query.guildAuthEvents.findMany({
      where: (e, { eq }) => eq(e.guildId, 'g-3'),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.fromStatus).toBe('trial');
    expect(events[0]?.toStatus).toBe('active');
    expect(events[0]?.actor).toBe('agent');

    // The transition is also mirrored into ops_audit (so blocks/auth changes show
    // up in v_recent_ops, the operational audit view).
    const ops = await env.handle.db.query.opsAudit.findMany({
      where: (o, { eq }) => eq(o.target, 'g-3'),
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.action).toBe('guild.auth.active');
    expect(ops[0]?.actor).toBe('agent');
    expect(ops[0]?.details).toMatchObject({ from: 'trial', to: 'active', reason: 'payment' });
  });

  it('updateSettings merges into the settings jsonb', async () => {
    await repo.ensure('g-4');
    await repo.updateSettings('g-4', { prefix: '!', limit: 5 });
    const after = await repo.updateSettings('g-4', { limit: 10 });
    expect(after.settings).toMatchObject({ prefix: '!', limit: 10 });
  });
});
