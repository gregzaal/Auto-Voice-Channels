import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertRepository } from './alerts.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

describe('AlertRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: AlertRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new AlertRepository(env.handle.db, 'beta');
  }, 600_000);

  afterAll(async () => {
    await env?.stop();
  });

  it('opens an alert and says it opened one', async () => {
    const r = await repo.raise({ key: 'db.ping', message: 'Database health ping failed' });
    expect(r.opened).toBe(true);
    const open = await repo.open();
    expect(open.map((a) => a.key)).toContain('db.ping');
  });

  /**
   * The whole point of the counter. An alert seen for the thousandth time must
   * bump silently, not send a thousandth message, so `opened` is what callers
   * gate notification on.
   */
  it('counts a repeat instead of opening a second alert', async () => {
    await repo.raise({ key: 'repeat.me', message: 'first' });
    const second = await repo.raise({ key: 'repeat.me', message: 'second' });
    expect(second.opened).toBe(false);
    const [row] = (await repo.open()).filter((a) => a.key === 'repeat.me');
    expect(row?.occurrences).toBe(2);
    // The newest observation wins: the stale first sighting is less useful.
    expect(row?.message).toBe('second');
  });

  /**
   * This is what the PARTIAL unique index buys. A total constraint on
   * (fleet, key, target) would make a resolved condition unable to reopen, so
   * one transient blip would silence that condition permanently.
   */
  it('opens a NEW alert when a resolved condition recurs', async () => {
    await repo.raise({ key: 'flappy', message: 'down' });
    expect(await repo.resolve('flappy')).toBe(true);
    const again = await repo.raise({ key: 'flappy', message: 'down again' });
    expect(again.opened).toBe(true);
    expect((await repo.open()).filter((a) => a.key === 'flappy')).toHaveLength(1);
    // Both occurrences survive as history, which is how "this flapped twice"
    // stays distinguishable from "this has been broken since Tuesday".
    const history = await repo.since(new Date(Date.now() - 60_000));
    expect(history.filter((a) => a.key === 'flappy')).toHaveLength(2);
  });

  it('separates alerts about different targets', async () => {
    await repo.raise({ key: 'guild.perm', message: 'a', target: 'g1' });
    const other = await repo.raise({ key: 'guild.perm', message: 'b', target: 'g2' });
    expect(other.opened).toBe(true);
  });

  it('resolving nothing is a no-op, so a checker can call it unconditionally', async () => {
    expect(await repo.resolve('never.fired')).toBe(false);
  });

  it('tracks delivery separately from resolution', async () => {
    const { id } = await repo.raise({ key: 'deliver.me', message: 'x' });
    expect((await repo.undelivered()).some((a) => a.id === id)).toBe(true);
    await repo.markAttempted(id, 'discord said no');
    await repo.markDelivered(id);
    expect((await repo.undelivered()).some((a) => a.id === id)).toBe(false);
    // Delivered but still open: the condition is true, someone has been told.
    expect((await repo.open()).some((a) => a.id === id)).toBe(true);
  });

  /** Fleet scoping, the mistake `/admin/ops` already made once. */
  it('does not see another fleet alerts', async () => {
    const prod = new AlertRepository(env.handle.db, 'prod');
    await prod.raise({ key: 'fleet.scoped', message: 'prod only' });
    expect((await repo.open()).some((a) => a.key === 'fleet.scoped')).toBe(false);
    expect((await prod.open()).some((a) => a.key === 'fleet.scoped')).toBe(true);
  });
});
