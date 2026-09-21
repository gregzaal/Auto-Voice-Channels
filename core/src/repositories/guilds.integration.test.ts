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

  describe('mergeSettings key removal', () => {
    /**
     * Concat can add and overwrite and cannot DELETE, which matters because four
     * settings keys fall back to a default when absent
     * (`general`, `channel_name_template`, `channel_status_template`,
     * `problem_alerts`). Writing today's default in place of removing the key
     * would pin the guild to it, so `/import` restoring a snapshot has to be
     * able to put a key back to genuinely absent.
     */
    it('removes the named keys and leaves the rest alone', async () => {
      await repo.ensure('g-rm-1');
      await repo.updateSettings('g-rm-1', {
        general: 'Voice',
        channel_name_template: 'Room ##',
        enabled: true,
      });

      await repo.mergeSettings('g-rm-1', () => ({
        patch: { enabled: false },
        remove: ['general', 'channel_name_template'],
        result: null,
      }));

      const row = await repo.ensure('g-rm-1');
      expect(Object.keys(row.settings).sort()).toEqual(['enabled']);
      expect(row.settings.enabled).toBe(false);
    });

    it('is a no-op for a key that was not there', async () => {
      await repo.ensure('g-rm-2');
      await repo.updateSettings('g-rm-2', { enabled: true });

      await repo.mergeSettings('g-rm-2', () => ({
        patch: {},
        remove: ['general', 'problem_alerts'],
        result: null,
      }));

      expect((await repo.ensure('g-rm-2')).settings).toEqual({ enabled: true });
    });

    /** The existing shape has to keep working, since every other caller uses it. */
    it('still merges when nothing is removed', async () => {
      await repo.ensure('g-rm-3');
      await repo.mergeSettings('g-rm-3', () => ({ patch: { general: 'Voice' }, result: null }));
      await repo.mergeSettings('g-rm-3', () => ({ patch: { enabled: true }, result: null }));
      expect((await repo.ensure('g-rm-3')).settings).toEqual({ general: 'Voice', enabled: true });
    });

    /** Sees what is stored, so a caller can decide what to remove from it. */
    it('hands the decide callback the stored blob', async () => {
      await repo.ensure('g-rm-4');
      await repo.updateSettings('g-rm-4', { general: 'Voice', log_level: 3 });
      const seen = await repo.mergeSettings('g-rm-4', (existing) => ({
        patch: {},
        result: Object.keys(existing?.settings ?? {}).sort(),
      }));
      expect(seen).toEqual(['general', 'log_level']);
    });
  });

  describe('markAnnounced', () => {
    /**
     * The bug this pins: `jsonb_set` with `create_missing` does NOT create an
     * intermediate level, so stamping into a metadata with no `announcements`
     * object silently wrote nothing. A broadcast interrupted halfway would then
     * re-send to every guild it had already reached.
     */
    it('stamps a guild whose metadata has no announcements object yet', async () => {
      await repo.ensure('g-ann-1');
      await repo.markAnnounced('g-ann-1', 'rewrite_2026_08');
      const row = await repo.ensure('g-ann-1');
      const announcements = (row.metadata as Record<string, Record<string, string>>).announcements;
      expect(announcements?.rewrite_2026_08).toBeTruthy();
    });

    it('keeps sibling announcement keys', async () => {
      await repo.ensure('g-ann-2');
      await repo.markAnnounced('g-ann-2', 'first');
      await repo.markAnnounced('g-ann-2', 'second');
      const row = await repo.ensure('g-ann-2');
      const announcements = (row.metadata as Record<string, Record<string, string>>).announcements;
      expect(Object.keys(announcements).sort()).toEqual(['first', 'second']);
    });

    it('does not disturb metadata.billing, which another job round-trips', async () => {
      await repo.ensure('g-ann-3');
      await repo.recordMemberCountSample('g-ann-3', 42, { at: new Date('2026-08-19T00:00:00Z') });
      await repo.markAnnounced('g-ann-3', 'rewrite_2026_08');
      const row = await repo.ensure('g-ann-3');
      const meta = row.metadata as Record<string, Record<string, unknown>>;
      expect(meta.billing?.samples).toBeDefined();
      expect(meta.announcements?.rewrite_2026_08).toBeTruthy();
    });
  });
  /**
   * The outcome check behind the `billing.trials_past_due` alert. Asserted as
   * DELTAS rather than absolute counts: every test in this file shares one
   * database, and several leave a guild parked in some state on purpose.
   */
  describe('countTrialsPastDue', () => {
    const before = new Date('2026-07-04T12:00:00.000Z');
    const lapsed = new Date('2026-07-01T12:00:00.000Z');

    async function overdue(): Promise<number> {
      const { count } = await repo.countTrialsPastDue({ before, minMemberCount: 100 });
      return count;
    }

    it('counts a billable guild whose trial ended and whose ladder never moved', async () => {
      const start = await overdue();
      await repo.ensure('past-due-1');
      await repo.recordMemberCountSample('past-due-1', 15_825, { at: lapsed });
      await repo.transitionAuth({
        guildId: 'past-due-1',
        toStatus: 'trial',
        expiresAt: lapsed,
      });
      expect(await overdue()).toBe(start + 1);
      const { examples } = await repo.countTrialsPastDue({ before, minMemberCount: 100 });
      expect(examples).toContain('past-due-1');

      // Moving it is what clears the alarm, not time passing.
      await repo.transitionAuth({ guildId: 'past-due-1', toStatus: 'grace' });
      expect(await overdue()).toBe(start);
    });

    it('ignores a dormant small guild, whose trial date means nothing', async () => {
      const start = await overdue();
      await repo.ensure('past-due-free');
      await repo.recordMemberCountSample('past-due-free', 40, { at: lapsed });
      await repo.transitionAuth({
        guildId: 'past-due-free',
        toStatus: 'trial',
        expiresAt: lapsed,
      });
      expect(await overdue()).toBe(start);
    });

    it('ignores a guild whose ladder belongs to a pool', async () => {
      const start = await overdue();
      await repo.ensure('past-due-pooled');
      await repo.recordMemberCountSample('past-due-pooled', 15_825, { at: lapsed });
      await repo.transitionAuth({
        guildId: 'past-due-pooled',
        toStatus: 'trial',
        expiresAt: lapsed,
      });
      expect(await overdue()).toBe(start + 1);
      await env.handle.pool.query('UPDATE guilds SET pool_id = $1 WHERE guild_id = $2', [
        'pool-past-due',
        'past-due-pooled',
      ]);
      expect(await overdue()).toBe(start);
    });

    it('ignores a guild still inside its trial', async () => {
      const start = await overdue();
      await repo.ensure('past-due-current');
      await repo.recordMemberCountSample('past-due-current', 15_825, { at: lapsed });
      await repo.transitionAuth({
        guildId: 'past-due-current',
        toStatus: 'trial',
        expiresAt: new Date('2027-07-04T12:00:00.000Z'),
      });
      expect(await overdue()).toBe(start);
    });
  });
});
