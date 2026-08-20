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

describe('AlertRepository delivery (integration)', () => {
  let env: PgTestEnv;
  let repo: AlertRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new AlertRepository(env.handle.db, 'beta');
  }, 600_000);

  afterAll(async () => {
    await env?.stop();
  });

  const old = (mins: number) => new Date(Date.now() - mins * 60_000);

  it('claims an alert the immediate path never delivered', async () => {
    await repo.raise({ key: 'claim.me', message: 'undelivered' }, old(10));
    const claimed = await repo.claimUndelivered(10);
    expect(claimed.map((c) => c.key)).toContain('claim.me');
  });

  /**
   * The grace window. The fast path posts first and stamps afterwards, so a row
   * seconds old is very likely already sent and simply not yet marked.
   */
  it('leaves a freshly raised alert alone', async () => {
    await repo.raise({ key: 'too.new', message: 'just happened' });
    const claimed = await repo.claimUndelivered(10);
    expect(claimed.map((c) => c.key)).not.toContain('too.new');
  });

  /**
   * SKIP LOCKED alone does not prevent the double-send: the row lock dies with
   * the claiming transaction and delivery happens after the commit. The lease
   * is what separates two claims a second apart. Both are load-bearing.
   */
  it('does not hand the same alert to a second claimer a moment later', async () => {
    await repo.raise({ key: 'once.only', message: 'x' }, old(10));
    const first = await repo.claimUndelivered(10);
    const second = await repo.claimUndelivered(10);
    const inFirst = first.filter((c) => c.key === 'once.only');
    const inSecond = second.filter((c) => c.key === 'once.only');
    expect(inFirst).toHaveLength(1);
    expect(inSecond).toHaveLength(0);
  });

  it('does not claim a delivered alert', async () => {
    const { id } = await repo.raise({ key: 'done.already', message: 'x' }, old(10));
    await repo.markDelivered(id);
    const claimed = await repo.claimUndelivered(10);
    expect(claimed.map((c) => c.key)).not.toContain('done.already');
  });

  /**
   * `resolveOthers` and `expireStale` clear conditions without touching
   * `delivered_at`, so without this predicate the loop would post a backlog of
   * things that had stopped being true: an alert storm triggered by recovery.
   */
  it('does not claim an alert whose condition already cleared', async () => {
    await repo.raise({ key: 'gone.away', message: 'x' }, old(10));
    await repo.resolve('gone.away');
    const claimed = await repo.claimUndelivered(10);
    expect(claimed.map((c) => c.key)).not.toContain('gone.away');
  });

  it('closes a resolved-but-unsent row so it leaves the claimable set', async () => {
    await repo.raise({ key: 'never.sent', message: 'x' }, old(10));
    await repo.resolve('never.sent');
    expect(await repo.closeResolvedUndelivered()).toBeGreaterThanOrEqual(1);
    const rows = await repo.since(old(60));
    const row = rows.find((r) => r.key === 'never.sent');
    expect(row?.deliveredAt).not.toBeNull();
  });

  /**
   * The restatement case. `raise` returns the SAME row for a condition that is
   * still open, so a later failed post lands on a row already marked delivered
   * from an earlier success. Leaving the stamp would hide it from the loop.
   */
  it('makes a delivered row claimable again when a later post fails', async () => {
    const solo = new AlertRepository(env.handle.db, 'restate');
    const { id } = await solo.raise({ key: 'restated', message: 'first' }, old(20));
    await solo.markDelivered(id);
    expect((await solo.claimUndelivered(10)).map((c) => c.key)).not.toContain('restated');

    await solo.markDeliveryFailed(id, 'discord refused the restatement');
    // Past the back-off, which is what the lease is for.
    const later = new Date(Date.now() + 20 * 60_000);
    expect((await solo.claimUndelivered(10, later)).map((c) => c.key)).toContain('restated');
  });

  it('backs a failed delivery off rather than releasing it', async () => {
    await repo.raise({ key: 'keeps.failing', message: 'x' }, old(10));
    const [claimed] = (await repo.claimUndelivered(10)).filter((c) => c.key === 'keeps.failing');
    expect(claimed).toBeDefined();
    await repo.markDeliveryFailed(claimed!.id, 'discord said no');
    const again = await repo.claimUndelivered(10);
    expect(again.map((c) => c.key)).not.toContain('keeps.failing');
  });

  it('orders criticals ahead of warnings', async () => {
    const solo = new AlertRepository(env.handle.db, 'ordering');
    await solo.raise({ key: 'a.warn', message: 'x', severity: 'warn' }, old(10));
    await solo.raise({ key: 'b.crit', message: 'x', severity: 'critical' }, old(9));
    const claimed = await solo.claimUndelivered(10);
    expect(claimed[0]?.key).toBe('b.crit');
  });

  it('counts what is still waiting, for /diagnostics', async () => {
    const solo = new AlertRepository(env.handle.db, 'depth');
    expect(await solo.undeliveredDepth()).toBe(0);
    await solo.raise({ key: 'waiting', message: 'x' }, old(10));
    expect(await solo.undeliveredDepth()).toBe(1);
  });

  /** The table shipped with neither an expiry nor a prune, so it grew forever. */
  it('prunes resolved history but keeps what is still open', async () => {
    const solo = new AlertRepository(env.handle.db, 'pruning');
    await solo.raise({ key: 'ancient', message: 'x' }, old(60 * 24 * 90));
    await solo.resolve('ancient', '', old(60 * 24 * 89));
    await solo.raise({ key: 'current', message: 'x' });
    expect(await solo.pruneResolved(old(60 * 24 * 30))).toBe(1);
    expect((await solo.open()).map((a) => a.key)).toEqual(['current']);
  });
});
