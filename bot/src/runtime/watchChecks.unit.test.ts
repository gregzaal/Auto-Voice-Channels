import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Status } from 'discord.js';
import type { SubsystemStatus } from '../ops/health.js';
import { buildWatchChecks, type WatchCheckDeps } from './watchChecks.js';

function deps(over: Partial<WatchCheckDeps> = {}): WatchCheckDeps {
  return {
    client: {
      isReady: () => true,
      readyAt: new Date(),
      ws: { status: Status.Ready, shards: new Map() },
    } as never,
    snapshot: () => [],
    dbStatus: () => 'up' as SubsystemStatus,
    heartbeat: () => ({ lastOkAt: clock.now, consecutiveFailures: 0 }),
    selfHosted: false,
    now: () => clock.now,
    ...over,
  };
}

/** A clock the tests move by hand, so hold-downs and ages are deterministic. */
const clock = { now: 1_000_000 };

const find = (d: WatchCheckDeps, key: string) => {
  const check = buildWatchChecks(d).find((c) => c.key === key);
  if (!check) throw new Error(`no check named ${key}`);
  return check;
};

describe('buildWatchChecks', () => {
  describe('db.unreachable', () => {
    it('is quiet while the database answers', async () => {
      expect(await find(deps(), 'db.unreachable').run()).toEqual([]);
    });

    it('fires when the health ping says down', async () => {
      const d = deps({ dbStatus: () => 'down' });
      expect(await find(d, 'db.unreachable').run()).toHaveLength(1);
    });

    /**
     * `unknown` is the boot state and the state after a reader throws. Guessing
     * "broken" from an absence of evidence pages someone on every startup.
     */
    it('treats unknown as not-a-problem', async () => {
      const d = deps({ dbStatus: () => 'unknown' });
      expect(await find(d, 'db.unreachable').run()).toEqual([]);
    });

    /**
     * It must NOT reuse `db.ping`. Both writers hit the same partial unique
     * index, so a shared key means one row whose severity flips every 15
     * seconds and which this check can never resolve.
     */
    it('does not collide with the event-driven ping key', () => {
      expect(buildWatchChecks(deps()).map((c) => c.key)).not.toContain('db.ping');
    });
  });

  describe('gateway.down', () => {
    it('is quiet when every shard is ready', async () => {
      const d = deps({
        client: {
          isReady: () => true,
          readyAt: new Date(),
          ws: { status: Status.Ready, shards: new Map([[0, { status: Status.Ready }]]) },
        } as never,
      });
      expect(await find(d, 'gateway.down').run()).toEqual([]);
    });

    it('reports one fleet-wide problem when the client is not ready', async () => {
      const d = deps({
        client: {
          isReady: () => false,
          readyAt: new Date(),
          ws: { status: Status.Connecting, shards: new Map() },
        } as never,
      });
      const problems = await find(d, 'gateway.down').run();
      expect(problems).toHaveLength(1);
      expect(problems[0]?.target).toBeUndefined();
      expect(problems[0]?.details).toEqual({ status: 'Connecting' });
    });

    /**
     * The case the manager's own aggregate status misses: it can still read
     * Ready while an individual shard has dropped.
     */
    it('names the individual shard that is not ready', async () => {
      const d = deps({
        client: {
          isReady: () => true,
          readyAt: new Date(),
          ws: {
            status: Status.Ready,
            shards: new Map([
              [0, { status: Status.Ready }],
              [1, { status: Status.Resuming }],
            ]),
          },
        } as never,
      });
      const problems = await find(d, 'gateway.down').run();
      expect(problems).toHaveLength(1);
      expect(problems[0]?.target).toBe('1');
      expect(problems[0]?.details).toEqual({ status: 'Resuming' });
    });

    /** Two ticks of grace, so a routine RESUME is not an incident. */
    it('needs confirming before it opens', () => {
      expect(find(deps(), 'gateway.down').confirmations).toBeGreaterThanOrEqual(2);
    });
  });

  describe('circuit.tripped', () => {
    it('names the guild whose breaker is open', async () => {
      const d = deps({
        snapshot: () => [
          { guildId: 'g1', depth: 0, circuitState: 'closed' },
          { guildId: 'g2', depth: 3, circuitState: 'open' },
        ],
      });
      const problems = await find(d, 'circuit.tripped').run();
      expect(problems.map((p) => p.target)).toEqual(['g2']);
    });

    /**
     * The latch. `peekState()` returns `half-open` for as long as the cooldown
     * has elapsed and only a dispatched task ever closes it, while
     * `maybeEvict` refuses to drop a non-closed queue. So a guild that trips
     * once and then goes quiet reports `half-open` forever, and alerting on
     * "not closed" would open a row that can never resolve and whose
     * `last_seen_at` is re-stamped every tick so it never ages out either.
     */
    it('ignores a guild parked in half-open, which is where a quiet guild latches', async () => {
      const d = deps({
        snapshot: () => [{ guildId: 'latched', depth: 0, circuitState: 'half-open' }],
      });
      const check = find(d, 'circuit.tripped');
      expect(await check.run()).toEqual([]);
      clock.now += 60_000;
      expect(await check.run()).toEqual([]);
    });

    /**
     * A genuinely broken guild oscillates open, half-open, open as each trial
     * fails, so a 60s poll samples it either way. Without the hold-down the
     * alert would raise and resolve on alternating ticks.
     */
    it('holds a sighting of open across ticks that sample half-open', async () => {
      let state = 'open';
      const d = deps({
        snapshot: () => [{ guildId: 'flappy', depth: 1, circuitState: state }],
      });
      const check = find(d, 'circuit.tripped');
      expect(await check.run()).toHaveLength(1);

      state = 'half-open';
      clock.now += 60_000;
      expect(await check.run()).toHaveLength(1);
      clock.now += 60_000;
      expect(await check.run()).toHaveLength(1);
    });

    it('lets go once the guild has stopped tripping', async () => {
      let state = 'open';
      const d = deps({ snapshot: () => [{ guildId: 'g', depth: 1, circuitState: state }] });
      const check = find(d, 'circuit.tripped');
      expect(await check.run()).toHaveLength(1);

      state = 'closed';
      clock.now += 4 * 60_000;
      expect(await check.run()).toHaveLength(1);
      clock.now += 2 * 60_000;
      expect(await check.run()).toEqual([]);
    });

    /**
     * Warn, never critical. One guild in trouble is exactly what per-guild
     * isolation exists to contain, and a critical would withhold the watchdog
     * ping and declare the whole instance dead over it.
     */
    it('is a warning, so it cannot suppress the watchdog ping', () => {
      expect(find(deps(), 'circuit.tripped').severity).toBe('warn');
      expect(find(deps(), 'queue.backlog').severity).toBe('warn');
    });
  });

  describe('queue.backlog', () => {
    it('ignores a busy guild and reports a stuck one', async () => {
      const d = deps({
        snapshot: () => [
          { guildId: 'busy', depth: 99, circuitState: 'closed' },
          { guildId: 'stuck', depth: 100, circuitState: 'closed' },
        ],
      });
      const problems = await find(d, 'queue.backlog').run();
      expect(problems.map((p) => p.target)).toEqual(['stuck']);
    });
  });

  describe('shard.heartbeat', () => {
    /** One instance, one claim, nothing to lose a shard to. */
    it('does not exist on a self-host', () => {
      const keys = buildWatchChecks(deps({ selfHosted: true })).map((c) => c.key);
      expect(keys).not.toContain('shard.heartbeat');
    });

    it('tolerates a single failed beat and fires on the second', async () => {
      const one = deps({ heartbeat: () => ({ lastOkAt: clock.now, consecutiveFailures: 1 }) });
      expect(await find(one, 'shard.heartbeat').run()).toEqual([]);
      const two = deps({ heartbeat: () => ({ lastOkAt: clock.now, consecutiveFailures: 2 }) });
      expect(await find(two, 'shard.heartbeat').run()).toHaveLength(1);
    });

    /**
     * The 2026-08-20 shape. A beat that never settles increments no counter, so
     * the failure count sits at zero while the lease quietly expires. Age is
     * the only thing that sees it.
     */
    it('catches a heartbeat that hangs rather than fails', async () => {
      const d = deps({
        heartbeat: () => ({ lastOkAt: clock.now - 40_000, consecutiveFailures: 0 }),
      });
      const problems = await find(d, 'shard.heartbeat').run();
      expect(problems).toHaveLength(1);
      expect(problems[0]?.details).toMatchObject({ hung: true, consecutiveFailures: 0 });
    });

    it('is quiet while beats are landing', async () => {
      const d = deps({
        heartbeat: () => ({ lastOkAt: clock.now - 5_000, consecutiveFailures: 0 }),
      });
      expect(await find(d, 'shard.heartbeat').run()).toEqual([]);
    });

    /** A boot that has never beaten is not a hung heartbeat. */
    it('does not fire before the first beat has ever landed', async () => {
      const d = deps({ heartbeat: () => ({ lastOkAt: null, consecutiveFailures: 0 }) });
      expect(await find(d, 'shard.heartbeat').run()).toEqual([]);
    });

    it('needs confirming, so a 20s transient is not a page', () => {
      expect(find(deps(), 'shard.heartbeat').confirmations).toBeGreaterThanOrEqual(2);
    });
  });

  /**
   * `start()` fires its first tick immediately after `client.login`, and on
   * 1004 guilds READY lands tens of seconds later. Without this gate the boot
   * itself is an observation of "not connected".
   */
  describe('gateway.down before the first READY', () => {
    it('stays quiet until the client has been ready once, then reports', async () => {
      const c = {
        isReady: () => false,
        readyAt: null as Date | null,
        ws: { status: Status.Connecting, shards: new Map() },
      };
      const check = find(deps({ client: c as never }), 'gateway.down');
      expect(await check.run()).toEqual([]);

      c.readyAt = new Date();
      c.isReady = () => true;
      expect(await check.run()).toEqual([]);

      c.isReady = () => false;
      expect(await check.run()).toHaveLength(1);
    });
  });

  describe('permissions.blocked', () => {
    const problems = (guildId: string, at: number) => ({
      guildId,
      lastAt: at,
      problems: [{ channelId: 'c1', operation: 'create' as const, at }],
    });

    /**
     * A thousand customers' own misconfigured servers are not an operator
     * incident. They are told directly by PermissionProblemNotifier, and the
     * operator already gets reportIfFleetwide when enough break at once.
     */
    it('is not registered on the hosted fleet', () => {
      const keys = buildWatchChecks(
        deps({ selfHosted: false, permissionProblems: () => [problems('g1', clock.now)] }),
      ).map((c) => c.key);
      expect(keys).not.toContain('permissions.blocked');
    });

    it('is registered on a self-host that supplies a reader', () => {
      const keys = buildWatchChecks(deps({ selfHosted: true, permissionProblems: () => [] })).map(
        (c) => c.key,
      );
      expect(keys).toContain('permissions.blocked');
    });

    /** Self-host without the reader wired must not throw or half-register. */
    it('is absent when no reader is supplied', () => {
      const keys = buildWatchChecks(deps({ selfHosted: true })).map((c) => c.key);
      expect(keys).not.toContain('permissions.blocked');
    });

    it('names each affected guild with actionable advice', async () => {
      const d = deps({
        selfHosted: true,
        permissionProblems: () => [problems('g1', clock.now), problems('g2', clock.now)],
      });
      const found = await find(d, 'permissions.blocked').run();
      expect(found.map((p) => p.target)).toEqual(['g1', 'g2']);
      expect(found[0]?.message.length).toBeGreaterThan(10);
    });

    /**
     * Never critical. A confirmed critical withholds the watchdog ping
     * fleet-wide, so one misconfigured server would read as "the bot is down".
     */
    it('is a warning and needs confirming', () => {
      const d = deps({ selfHosted: true, permissionProblems: () => [] });
      const check = find(d, 'permissions.blocked');
      expect(check.severity).toBe('warn');
      expect(check.confirmations).toBeGreaterThanOrEqual(2);
    });

    it('asks the tracker for a bounded window, not for everything', async () => {
      const asked: number[] = [];
      const d = deps({
        selfHosted: true,
        permissionProblems: (since) => {
          asked.push(since);
          return [];
        },
      });
      await find(d, 'permissions.blocked').run();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toBe(6 * 3_600_000);
    });
  });

  /**
   * The scheduler encodes a gate id as `key` + separator + `target`, and splits
   * on it to read the pair back. A key carrying anything exotic would corrupt
   * that, and a duplicate key would make two checks reconcile each other's
   * alerts out of existence every tick.
   *
   * Asserted as a charset rather than "does not contain the separator", so this
   * still holds if the separator ever changes. It previously checked for a
   * space while the separator was actually NUL, which is a test that could
   * never have failed.
   */
  it('has unique keys, all plain lowercase slugs', () => {
    const keys = buildWatchChecks(deps()).map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => !/^[a-z0-9]+(?:[._][a-z0-9]+)*$/.test(k))).toEqual([]);
  });

  /**
   * The watcher's keys must not collide with any key an event-driven
   * `report()` uses, and this is checked mechanically rather than by keeping a
   * list, because a hand-kept list of "keys that must stay disjoint" rots.
   *
   * A shared key means one row under the partial unique index, written by two
   * writers with different severities and only one of which stamps the
   * `instance` the resolve path filters on. The row then flips severity on the
   * faster writer's cycle and can never be resolved. That is not hypothetical:
   * `db.ping` and `db.unreachable` were one key until it was caught.
   */
  it('shares no key with any event-driven report() call in the bot', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const botSrc = resolve(here, '..');
    const eventKeys = new Set<string>();

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/\breport(?:\?\.)?\(\s*['"`]([^'"`]+)['"`]/g)) {
          if (m[1]) eventKeys.add(m[1]);
        }
      }
    };
    walk(botSrc);

    // A guard on the guard: if the scan finds nothing, the regex has rotted and
    // this test would pass by looking at an empty set.
    expect(eventKeys.size).toBeGreaterThan(5);

    const watcherKeys = buildWatchChecks(deps()).map((c) => c.key);
    expect(watcherKeys.filter((k) => eventKeys.has(k))).toEqual([]);
  });
  /**
   * The one wall in this system that arrives on somebody else's schedule.
   *
   * `recommended_shards` grows with the install base, and when it passes what a
   * fleet runs Discord starts refusing identifies with 4011 and the fleet cannot
   * connect at all. On 2026-09-01 prod ran 4 shards against a recommendation of
   * 6: the number was already in the metric store and on `/admin/ops`, and
   * nothing looked at it, so the first anyone would have known is a fleet that
   * would not boot.
   */
  describe('shard.headroom', () => {
    it('says nothing while the fleet has enough shards', () => {
      const d = deps({ shardHeadroom: () => ({ running: 4, recommended: 4 }) });
      expect(find(d, 'shard.headroom').run()).toEqual([]);
    });

    it('says nothing when the fleet runs more than recommended', () => {
      const d = deps({ shardHeadroom: () => ({ running: 8, recommended: 6 }) });
      expect(find(d, 'shard.headroom').run()).toEqual([]);
    });

    /**
     * **Prod's own numbers, and they must NOT warn.**
     *
     * 4 shards against a recommendation of 6 is the state today, and the check
     * used to fire on it. `recommended_shards` is advisory sizing at roughly a
     * thousand guilds per shard, so being under it is ordinary. Since the only
     * remedy is a `TOTAL_SHARDS` change that reshuffles every guild-to-shard
     * mapping, a warning here could not be cleared and re-announced itself once
     * per process: four identical messages per deploy.
     */
    it('says nothing at the ordinary distance below the recommendation', () => {
      const d = deps({ shardHeadroom: () => ({ running: 4, recommended: 6 }) });
      expect(find(d, 'shard.headroom').run()).toEqual([]);
    });

    /**
     * The wall is Discord's hard ceiling of one shard per 2,500 guilds. At a
     * ratio of 1.75 the estimate is ~1,750 guilds per shard, about 70% of it,
     * which is notice with a deploy cycle of room to act.
     */
    it('warns, with both numbers, once the ratio says the wall is close', () => {
      const d = deps({ shardHeadroom: () => ({ running: 4, recommended: 8 }) });
      const raised = find(d, 'shard.headroom').run();
      expect(raised).toHaveLength(1);
      expect(raised[0]?.message).toContain('8');
      expect(raised[0]?.message).toContain('4');
      expect(raised[0]?.message).toContain('2,500');
      expect(raised[0]?.details).toEqual({
        running: 4,
        recommended: 8,
        estimatedGuildsPerShard: 2000,
      });
    });

    /**
     * `warn`, so it never withholds the watchdog ping. This is weeks of notice,
     * not an outage, and paging on it would teach everyone to ignore the channel.
     */
    it('is a warning rather than a critical', () => {
      const d = deps({ shardHeadroom: () => ({ running: 4, recommended: 6 }) });
      expect(find(d, 'shard.headroom').severity).toBe('warn');
    });

    /** Absent before the first gateway poll lands, which is not a problem. */
    it('says nothing when the numbers are not known yet', () => {
      expect(find(deps(), 'shard.headroom').run()).toEqual([]);
      expect(find(deps({ shardHeadroom: () => undefined }), 'shard.headroom').run()).toEqual([]);
    });

    /** A self-hoster has one shard and no fleet, so it would be noise forever. */
    it('is not offered to a self-hoster', () => {
      const built = buildWatchChecks(
        deps({ selfHosted: true, shardHeadroom: () => ({ running: 1, recommended: 4 }) }),
      );
      expect(built.some((c) => c.key === 'shard.headroom')).toBe(false);
    });
  });
  /**
   * The other wall, and AGENTS.md calls it the single term that decides how this
   * scales: memory tracks the MEMBER count of the install base, at a measured
   * ~1.28 KB per cached member, and the caches driving it are deliberately
   * unbounded because naming a channel after a game needs the joiner's presence
   * at the instant they join. Beta already OOM-looped at 512MB.
   */
  describe('memory.headroom', () => {
    const mb = (n: number) => n * 1024 * 1024;

    it('says nothing at ordinary usage', () => {
      const d = deps({ heapUsage: () => ({ usedBytes: mb(400), limitBytes: mb(1700) }) });
      expect(find(d, 'memory.headroom').run()).toEqual([]);
    });

    it('warns once the heap is near its ceiling, with both numbers', () => {
      const d = deps({ heapUsage: () => ({ usedBytes: mb(1500), limitBytes: mb(1700) }) });
      const raised = find(d, 'memory.headroom').run();
      expect(raised).toHaveLength(1);
      expect(raised[0]?.details).toEqual({ usedMb: 1500, limitMb: 1700 });
    });

    it('does not warn just below the threshold', () => {
      const d = deps({ heapUsage: () => ({ usedBytes: mb(1400), limitBytes: mb(1700) }) });
      expect(find(d, 'memory.headroom').run()).toEqual([]);
    });

    /**
     * `warn`, so it never withholds the watchdog ping. The answer is a bigger
     * machine, which is a purchase and a deploy, not a 3am action.
     */
    it('is a warning rather than a critical', () => {
      const d = deps({ heapUsage: () => ({ usedBytes: mb(1690), limitBytes: mb(1700) }) });
      expect(find(d, 'memory.headroom').severity).toBe('warn');
    });

    it('says nothing when the numbers are unavailable or nonsense', () => {
      expect(find(deps(), 'memory.headroom').run()).toEqual([]);
      const zero = deps({ heapUsage: () => ({ usedBytes: mb(100), limitBytes: 0 }) });
      expect(find(zero, 'memory.headroom').run()).toEqual([]);
    });

    /** A self-hoster picks their own box and cannot be told to buy a bigger one. */
    it('is not offered to a self-hoster', () => {
      const built = buildWatchChecks(
        deps({
          selfHosted: true,
          heapUsage: () => ({ usedBytes: mb(1690), limitBytes: mb(1700) }),
        }),
      );
      expect(built.some((c) => c.key === 'memory.headroom')).toBe(false);
    });
  });
});
