import { Status } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createGatewayHealth } from './gatewayHealth.js';

/**
 * The 2026-09-01 incident, as a test.
 *
 * Shard 0 wedged in `Connecting` for 3h37m while `/health` reported the gateway
 * `up`, because the status was a variable set once on ready and cleared only by
 * a client-level `error` that a wedged shard never fires. Fly's check stayed
 * green, `fly status` showed four healthy machines, and the outage was found by
 * a human in the morning.
 */
describe('gateway health', () => {
  const build = (opts: {
    readyAt?: Date | null;
    statuses: number[];
    now: () => number;
    graceMs?: number;
  }) =>
    createGatewayHealth({
      readyAt: () => (opts.readyAt === undefined ? new Date() : opts.readyAt),
      shardStatuses: () => opts.statuses,
      now: opts.now,
      ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
    });

  it('is unknown before the gateway has ever been ready', () => {
    const health = build({ readyAt: null, statuses: [], now: () => 0 });
    expect(health()).toBe('unknown');
  });

  it('is up when every shard is ready', () => {
    const health = build({ statuses: [Status.Ready, Status.Ready], now: () => 0 });
    expect(health()).toBe('up');
  });

  /**
   * The whole point. A shard stuck in `Connecting` has to become `down`, and it
   * has to do so without waiting for an event discord.js will never emit.
   */
  it('goes down once a shard has been stuck past the grace period', () => {
    let clock = 0;
    const statuses = [Status.Ready, Status.Connecting];
    const health = build({ statuses, now: () => clock, graceMs: 120_000 });

    // A blip is not an outage: Fly would pull a healthy machine on every resume.
    expect(health()).toBe('up');
    clock = 119_000;
    expect(health()).toBe('up');

    clock = 120_000;
    expect(health()).toBe('down');
    // And it stays down, rather than flapping, for as long as it is stuck.
    clock = 3 * 60 * 60 * 1000;
    expect(health()).toBe('down');
  });

  it('recovers to up, and resets the clock, once the shard comes back', () => {
    let clock = 0;
    const statuses = [Status.Connecting];
    const health = build({ statuses, now: () => clock, graceMs: 1000 });

    health();
    clock = 5000;
    expect(health()).toBe('down');

    statuses[0] = Status.Ready;
    expect(health()).toBe('up');

    // A fresh disconnect gets the full grace again, not the stale timestamp.
    statuses[0] = Status.Resuming;
    expect(health()).toBe('up');
    clock = 5500;
    expect(health()).toBe('up');
    clock = 6001;
    expect(health()).toBe('down');
  });

  /**
   * Reading `client.ws.status` or `isReady()` is the trap: discord.js latches
   * both and never resets them on a disconnect. A caller that passed no shard
   * statuses at all would look permanently healthy, so an empty list is down.
   */
  it('treats having no shards at all as down, not as up', () => {
    let clock = 0;
    const health = build({ statuses: [], now: () => clock, graceMs: 1000 });
    health();
    clock = 2000;
    expect(health()).toBe('down');
  });

  it('is down while any one shard of several is stuck', () => {
    let clock = 0;
    const health = build({
      statuses: [Status.Ready, Status.Ready, Status.Ready, Status.Connecting],
      now: () => clock,
      graceMs: 1000,
    });
    health();
    clock = 2000;
    expect(health()).toBe('down');
  });

  /**
   * The grace clock starts at the first OBSERVATION of a stuck shard, not at
   * the disconnect itself, and that is fine because Fly polls `/health` every
   * ten seconds. Pinned so nobody later reads the grace as "two minutes after
   * the disconnect" and shortens it on that basis.
   */
  it('starts the grace clock when the problem is first seen', () => {
    let clock = 1_000_000;
    const health = build({ statuses: [Status.Connecting], now: () => clock, graceMs: 1000 });
    expect(health()).toBe('up');
    clock = 1_001_000;
    expect(health()).toBe('down');
  });
});
