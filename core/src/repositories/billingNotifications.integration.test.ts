import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { guilds } from '../db/schema.js';
import type { LeniencyNotification } from '../domain/leniency.js';
import { BillingNotificationRepository } from './billingNotifications.js';
import { GuildFleetPresenceRepository } from './guildFleetPresence.js';

/**
 * The queue that lets the ladder advance on one fleet and be delivered by
 * another (`plans/fleets.md` §4).
 *
 * The interesting cases are all about *who may take a row*, so these run
 * against real Postgres: the fleet scoping is a join and the anti-double-send
 * is `SKIP LOCKED`, neither of which a fake can demonstrate.
 */

const IN_BOTH = '100000000000000001';
const PROD_ONLY = '100000000000000002';
const BETA_ONLY = '100000000000000003';
const NO_FLEET = '100000000000000004';

const notification = (key: string, kind = 'trial_warning'): LeniencyNotification =>
  ({ key, kind, daysLeft: 7 }) as LeniencyNotification;

describe('BillingNotificationRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: BillingNotificationRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new BillingNotificationRepository(env.handle.db);

    for (const id of [IN_BOTH, PROD_ONLY, BETA_ONLY, NO_FLEET]) {
      await env.handle.db.insert(guilds).values({ guildId: id }).onConflictDoNothing();
    }
    const prod = new GuildFleetPresenceRepository(env.handle.db, 'prod');
    const beta = new GuildFleetPresenceRepository(env.handle.db, 'beta');
    await prod.markPresent(IN_BOTH);
    await beta.markPresent(IN_BOTH);
    await prod.markPresent(PROD_ONLY);
    await beta.markPresent(BETA_ONLY);
    // NO_FLEET deliberately gets no presence row at all.
  }, 300_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.execute(sql`DELETE FROM billing_notifications`);
  });

  it('queues a notification and reports it pending', async () => {
    expect(await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'), 4200)).toBe(true);
    expect(await repo.pending()).toBe(1);
  });

  /**
   * Re-enqueue is the normal case, not an error path: the ladder re-derives
   * every undelivered notification on each hourly pass, because the dedupe
   * stamp it reads is only written once a delivery lands.
   */
  it('is idempotent while the notification is still pending', async () => {
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'), 4200);
    expect(await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'), 4200)).toBe(false);
    expect(await repo.pending()).toBe(1);
  });

  /**
   * The reason the unique index is partial. `grace_nudge` is deliberately
   * re-sent weekly, so a total unique constraint on (guild, key) would let the
   * first nudge silence every one after it, permanently and silently.
   */
  it('allows the same key again once the first was delivered', async () => {
    await repo.enqueue(IN_BOTH, notification('grace_nudge', 'grace_nudge'));
    const [first] = await repo.claimForFleet('prod', 10);
    await repo.markDelivered(first!.id, 'prod');

    expect(await repo.enqueue(IN_BOTH, notification('grace_nudge', 'grace_nudge'))).toBe(true);
    const again = await repo.claimForFleet('prod', 10);
    expect(again).toHaveLength(1);
  });

  /**
   * The whole point of the split. A fleet must never be handed work for a guild
   * its bot is not in: delivery would fail, the row would sit pending, and the
   * guild would never be told anything.
   */
  it('hands each fleet only the guilds it is in', async () => {
    const enqueueAll = async (): Promise<void> => {
      await env.handle.db.execute(sql`DELETE FROM billing_notifications`);
      for (const g of [IN_BOTH, PROD_ONLY, BETA_ONLY, NO_FLEET]) {
        await repo.enqueue(g, notification('trial_warning:7:m'));
      }
    };

    // Each fleet asked against a fresh queue, because a claim is exclusive:
    // asking prod first and beta second would measure the claim lease rather
    // than the presence join, and the two are worth failing separately.
    await enqueueAll();
    const forProd = await repo.claimForFleet('prod', 10);
    expect(forProd.map((r) => r.guildId).sort()).toEqual([IN_BOTH, PROD_ONLY].sort());

    await enqueueAll();
    const forBeta = await repo.claimForFleet('beta', 10);
    expect(forBeta.map((r) => r.guildId).sort()).toEqual([BETA_ONLY, IN_BOTH].sort());
  });

  /**
   * A guild both fleets are in gets the message once, not twice.
   *
   * Presence is not exclusive and both bots could physically deliver, so
   * nothing about the join prevents a duplicate. The claim is what does.
   */
  it('delivers a guild both fleets are in exactly once', async () => {
    await repo.enqueue(IN_BOTH, notification('hard_gate', 'hard_gate'));

    const forProd = await repo.claimForFleet('prod', 10);
    expect(forProd).toHaveLength(1);

    const forBeta = await repo.claimForFleet('beta', 10);
    expect(forBeta).toHaveLength(0);
  });

  /** A guild no fleet is in yields nothing to anybody, rather than erroring. */
  it('hands nobody a guild with no present fleet', async () => {
    await repo.enqueue(NO_FLEET, notification('hard_gate', 'hard_gate'));
    expect(await repo.claimForFleet('prod', 10)).toHaveLength(0);
    expect(await repo.claimForFleet('beta', 10)).toHaveLength(0);
    expect(await repo.pending()).toBe(1);
  });

  /** A fleet that was removed stops being handed the guild's work. */
  it('stops handing out a guild the fleet was removed from', async () => {
    const prod = new GuildFleetPresenceRepository(env.handle.db, 'prod');
    await repo.enqueue(PROD_ONLY, notification('trial_warning:7:m'));
    await prod.markRemoved(PROD_ONLY);
    try {
      expect(await repo.claimForFleet('prod', 10)).toHaveLength(0);
    } finally {
      await prod.markPresent(PROD_ONLY);
    }
  });

  /**
   * Two instances of one fleet draining at the same time must take disjoint
   * rows. Without `SKIP LOCKED` the second would block on the first and then
   * re-read the same rows, double-sending every notification in the batch.
   */
  it('never hands the same row to two concurrent claims', async () => {
    for (let i = 0; i < 6; i++) {
      await repo.enqueue(IN_BOTH, notification(`trial_warning:${i}:m`));
    }
    const [a, b] = await Promise.all([
      repo.claimForFleet('prod', 3),
      repo.claimForFleet('prod', 3),
    ]);
    const ids = [...a.map((r) => r.id), ...b.map((r) => r.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });

  /**
   * The case `SKIP LOCKED` cannot cover, and the one that actually bites.
   *
   * Delivery happens after the claim transaction commits, so the row lock is
   * already gone by the time the message is being sent. A second instance
   * ticking a moment later would re-claim and re-send it. The claim lease is
   * what makes the claim outlive its transaction.
   */
  it('never hands the same row to a second claim moments later', async () => {
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    const first = await repo.claimForFleet('prod', 10);
    expect(first).toHaveLength(1);

    const second = await repo.claimForFleet('prod', 10);
    expect(second).toHaveLength(0);
  });

  /** A deliverer that died mid-send must not strand the row forever. */
  it('hands the row out again once the claim lease runs out', async () => {
    const at = new Date();
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    expect(await repo.claimForFleet('prod', 10, at, 60_000)).toHaveLength(1);

    const later = new Date(at.getTime() + 61_000);
    expect(await repo.claimForFleet('prod', 10, later, 60_000)).toHaveLength(1);
  });

  it('counts an attempt on every claim', async () => {
    const at = new Date();
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    const [first] = await repo.claimForFleet('prod', 10, at);
    expect(first?.attempts).toBe(1);
    await repo.markFailed(first!.id, 'retry me', at);
    const [second] = await repo.claimForFleet('prod', 10, new Date(at.getTime() + 120_000));
    expect(second?.attempts).toBe(2);
  });

  it('carries the notification and the member count the advance pass saw', async () => {
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:l'), 12_345);
    const [row] = await repo.claimForFleet('prod', 10);
    expect(row?.notification).toMatchObject({ key: 'trial_warning:7:l', daysLeft: 7 });
    expect(row?.memberCount).toBe(12_345);
  });

  it('stops handing out a delivered row', async () => {
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    const [row] = await repo.claimForFleet('prod', 10);
    await repo.markDelivered(row!.id, 'prod');
    expect(await repo.claimForFleet('prod', 10)).toHaveLength(0);
    expect(await repo.pending()).toBe(0);
  });

  /** A failure leaves the row for a later drain rather than dropping it. */
  it('keeps a failed row pending', async () => {
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    const [row] = await repo.claimForFleet('prod', 10);
    await repo.markFailed(row!.id, 'missing permissions');
    expect(await repo.pending()).toBe(1);
  });

  /**
   * A stale notice is worse than none. "Your trial ends in 7 days", arriving
   * after it ended and after the hard-gate message, is actively wrong.
   */
  it('expires and reports what nobody delivered', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000);
    await repo.enqueue(NO_FLEET, notification('trial_warning:7:m'), 0, {
      at: past,
      ttlMs: 86_400_000,
    });
    const expired = await repo.expire();
    expect(expired).toEqual([{ guildId: NO_FLEET, key: 'trial_warning:7:m', attempts: 0 }]);
    expect(await repo.pending()).toBe(0);
  });

  it('never claims an expired row', async () => {
    const past = new Date(Date.now() - 10 * 86_400_000);
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'), 0, {
      at: past,
      ttlMs: 86_400_000,
    });
    expect(await repo.claimForFleet('prod', 10)).toHaveLength(0);
  });

  it('prunes delivered rows older than the cutoff, and keeps newer ones', async () => {
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    const [row] = await repo.claimForFleet('prod', 10);
    await repo.markDelivered(row!.id, 'prod', new Date(Date.now() - 40 * 86_400_000));

    expect(await repo.pruneDelivered(new Date(Date.now() - 60 * 86_400_000))).toBe(0);
    expect(await repo.pruneDelivered(new Date(Date.now() - 30 * 86_400_000))).toBe(1);
  });
  /**
   * A row being delivered right now must not be expired underneath the
   * deliverer. Without the claim guard, a slow send that outlives the TTL by
   * seconds fires the loudest "we failed a customer" signal in the system for
   * a message that did arrive.
   */
  it('never expires a row that is currently claimed', async () => {
    const at = new Date();
    // Alive when claimed, expired 30 seconds later: the window a slow send
    // (system channel refuses, fall back to an owner DM) actually lands in.
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'), 0, {
      at,
      ttlMs: 30_000,
    });
    expect(await repo.claimForFleet('prod', 10, at, 5 * 60_000)).toHaveLength(1);

    const midDelivery = new Date(at.getTime() + 60_000);
    expect(await repo.expire(midDelivery)).toEqual([]);

    // Once the claim lease runs out it is fair game again.
    const afterLease = new Date(at.getTime() + 6 * 60_000);
    expect(await repo.expire(afterLease)).toHaveLength(1);
  });

  /** Expiry reports how many attempts were made, so the caller can tell
   * "nobody could reach this guild" from "we tried and could not post". */
  it('reports the attempt count with an expiry', async () => {
    const at = new Date();
    const enqueuedAt = new Date(at.getTime() - 10 * 86_400_000);
    await repo.enqueue(NO_FLEET, notification('hard_gate', 'hard_gate'), 0, {
      at: enqueuedAt,
      ttlMs: 86_400_000,
    });
    expect(await repo.expire(at)).toEqual([{ guildId: NO_FLEET, key: 'hard_gate', attempts: 0 }]);
  });

  /**
   * A warning must not outlive the horizon it quotes. `daysLeft` is rendered
   * verbatim at delivery, so "1 day left" arriving two days late is not stale,
   * it is wrong.
   */
  it('caps the TTL at the horizon the notification itself names', async () => {
    const at = new Date('2026-07-04T12:00:00.000Z');
    await repo.enqueue(
      IN_BOTH,
      { key: 'trial_warning:1:m', kind: 'trial_warning', daysLeft: 1 } as LeniencyNotification,
      500,
      { at },
    );
    const [row] = await env.handle.db
      .execute<{
        expires_at: string;
      }>(sql`SELECT expires_at FROM billing_notifications WHERE guild_id = ${IN_BOTH}`)
      .then((r) => r.rows);
    // One day, not the flat three.
    expect(new Date(row!.expires_at).getTime() - at.getTime()).toBe(86_400_000);
  });

  /** A notification with no horizon of its own keeps the flat TTL. */
  it('leaves a notification with no daysLeft on the full TTL', async () => {
    const at = new Date('2026-07-04T12:00:00.000Z');
    await repo.enqueue(
      IN_BOTH,
      { key: 'hard_gate', kind: 'hard_gate' } as LeniencyNotification,
      500,
      { at },
    );
    const [row] = await env.handle.db
      .execute<{
        expires_at: string;
      }>(sql`SELECT expires_at FROM billing_notifications WHERE guild_id = ${IN_BOTH}`)
      .then((r) => r.rows);
    expect(new Date(row!.expires_at).getTime() - at.getTime()).toBe(3 * 86_400_000);
  });

  /**
   * A failure backs the row off rather than freeing it outright. The deliver
   * phase runs on every instance of the fleet, and the lease is the only thing
   * spacing retries: freeing it turns a permanently-failing guild into N
   * attempts an hour against Discord.
   */
  it('backs a failed row off instead of releasing it immediately', async () => {
    const at = new Date();
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    const [row] = await repo.claimForFleet('prod', 10, at);
    await repo.markFailed(row!.id, 'missing permissions', at);

    // Not immediately claimable again.
    expect(await repo.claimForFleet('prod', 10, new Date(at.getTime() + 30_000))).toHaveLength(0);
    // But claimable once the back-off elapses.
    expect(await repo.claimForFleet('prod', 10, new Date(at.getTime() + 120_000))).toHaveLength(1);
  });

  /**
   * The send happened but the bookkeeping threw. The reconciler leaves the row
   * untouched in that case, so the full claim lease has to hold it: retrying
   * on a shortened clock would re-send a message that already went out.
   */
  it('holds a claimed row for the full lease when nothing marks it', async () => {
    const at = new Date();
    await repo.enqueue(IN_BOTH, notification('trial_warning:7:m'));
    expect(await repo.claimForFleet('prod', 10, at)).toHaveLength(1);

    // Four minutes in, still held. The default lease is five.
    expect(await repo.claimForFleet('prod', 10, new Date(at.getTime() + 240_000))).toHaveLength(0);
  });
});
