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

  /**
   * Reconciling a polled condition. Without this an alert can only ever go up,
   * and every consumer that asks "is anything wrong" latches red forever.
   */
  it('resolves the targets a polled condition no longer names', async () => {
    await repo.raise({ key: 'poll.me', message: 'a', target: 'g1' });
    await repo.raise({ key: 'poll.me', message: 'b', target: 'g2' });
    await repo.raise({ key: 'poll.me', message: 'c', target: 'g3' });

    expect(await repo.resolveOthers('poll.me', ['g2'])).toBe(2);
    const open = (await repo.open()).filter((a) => a.key === 'poll.me');
    expect(open.map((a) => a.target)).toEqual(['g2']);
  });

  /**
   * The healthy case, and the one an off-by-one gets wrong: an empty list means
   * the condition is true nowhere, NOT "no filter, touch nothing".
   */
  it('resolves everything under a key when the condition is true nowhere', async () => {
    await repo.raise({ key: 'all.clear', message: 'a', target: 'g1' });
    await repo.raise({ key: 'all.clear', message: 'b' });
    expect(await repo.resolveOthers('all.clear', [])).toBe(2);
    expect((await repo.open()).filter((a) => a.key === 'all.clear')).toHaveLength(0);
  });

  it('does not resolve another key, or another fleet', async () => {
    const prod = new AlertRepository(env.handle.db, 'prod');
    await repo.raise({ key: 'mine', message: 'a', target: 'g1' });
    await prod.raise({ key: 'mine', message: 'a', target: 'g1' });
    await repo.raise({ key: 'other', message: 'a', target: 'g1' });

    await repo.resolveOthers('mine', []);
    expect((await repo.open()).some((a) => a.key === 'other')).toBe(true);
    expect((await prod.open()).some((a) => a.key === 'mine')).toBe(true);
  });

  /**
   * The multi-instance case. A's healthy tick must not close B's open
   * condition, and nothing in (fleet, key) alone can tell them apart.
   */
  it('only resolves rows raised by the given instance', async () => {
    await repo.raise({
      key: 'per.instance',
      message: 'a is sad',
      target: 'g1',
      details: { instance: 'a' },
    });
    await repo.raise({
      key: 'per.instance',
      message: 'b is sad',
      target: 'g2',
      details: { instance: 'b' },
    });

    expect(await repo.resolveOthers('per.instance', [], { instance: 'a' })).toBe(1);
    const open = (await repo.open()).filter((x) => x.key === 'per.instance');
    expect(open.map((x) => x.target)).toEqual(['g2']);
  });

  /**
   * Event-driven conditions have no poll to tell them they stopped: the catch
   * block that raised one does not run again precisely because it went away.
   */
  it('ages out an alert nothing has seen for a while', async () => {
    const old = new Date(Date.now() - 48 * 3_600_000);
    await repo.raise({ key: 'stale.one', message: 'ancient' }, old);
    await repo.raise({ key: 'fresh.one', message: 'current' });

    expect(await repo.expireStale(new Date(Date.now() - 24 * 3_600_000))).toBe(1);
    const open = await repo.open();
    expect(open.some((a) => a.key === 'stale.one')).toBe(false);
    expect(open.some((a) => a.key === 'fresh.one')).toBe(true);
  });

  /**
   * Two writers reach the same key: a catch block that knows only that
   * something failed, and the watcher that has confirmed it is true right now.
   * Whichever fired first must not pin the severity, because that is the column
   * `/api/watch` filters on.
   */
  it('escalates the severity, and never quietly walks it back down', async () => {
    await repo.raise({ key: 'escalates', message: 'from a catch block' });
    await repo.raise({ key: 'escalates', message: 'confirmed', severity: 'critical' });
    const [row] = (await repo.open()).filter((a) => a.key === 'escalates');
    expect(row?.severity).toBe('critical');

    /**
     * The direction that matters. The catch block writes every 15 seconds and
     * passes no severity at all, so last-writer-wins would relabel a confirmed
     * outage `warn` within seconds of the watcher escalating it -- and that is
     * the column `/api/watch` filters on. An open row records the worst the
     * condition has been; it comes down by resolving, not by downgrade.
     */
    await repo.raise({ key: 'escalates', message: 'another catch block' });
    const [after] = (await repo.open()).filter((a) => a.key === 'escalates');
    expect(after?.severity).toBe('critical');
  });

  /** Fleet scoping, the mistake `/admin/ops` already made once. */
  it('does not see another fleet alerts', async () => {
    const prod = new AlertRepository(env.handle.db, 'prod');
    await prod.raise({ key: 'fleet.scoped', message: 'prod only' });
    expect((await repo.open()).some((a) => a.key === 'fleet.scoped')).toBe(false);
    expect((await prod.open()).some((a) => a.key === 'fleet.scoped')).toBe(true);
  });
});
