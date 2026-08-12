import { describe, expect, it, vi } from 'vitest';
import type { GuildRow, GuildSettingsReader } from '@avc/core';
import { fakeLogger } from '../../runtime/testUtils.js';
import { EntitlementGate } from './entitlementGate.js';

function rowWith(status: GuildRow['authStatus']): GuildRow {
  const now = new Date();
  return {
    guildId: 'g-1',
    authStatus: status,
    authExpiresAt: null,
    graceUntil: null,
    memberCount: null,
    memberCountUpdatedAt: null,
    tier: null,
    settings: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('EntitlementGate', () => {
  it('fails open for unknown guilds, then serves the cached answer', async () => {
    let status: GuildRow['authStatus'] = 'expired';
    const guilds: GuildSettingsReader = {
      ensure: vi.fn(async () => rowWith(status)),
    };
    let clock = 0;
    const gate = new EntitlementGate({
      guilds,
      selfHosted: false,
      logger: fakeLogger(),
      ttlMs: 1_000,
      now: () => clock,
    });

    // Cold cache: fail open, background refresh kicked off.
    expect(gate.check('g-1')).toBe(true);
    await tick();
    // Warm: the expired guild is now short-circuited.
    expect(gate.check('g-1')).toBe(false);

    // TTL elapses → stale value still served while a refresh runs.
    status = 'trial';
    clock = 2_000;
    expect(gate.check('g-1')).toBe(false);
    await tick();
    expect(gate.check('g-1')).toBe(true);
  });

  it('grace counts as entitled; blocked never does (even self-hosted)', async () => {
    const guilds: GuildSettingsReader = { ensure: vi.fn(async () => rowWith('grace')) };
    const gate = new EntitlementGate({ guilds, selfHosted: false, logger: fakeLogger() });
    gate.check('g-1');
    await tick();
    expect(gate.check('g-1')).toBe(true);

    const blockedGuilds: GuildSettingsReader = { ensure: vi.fn(async () => rowWith('blocked')) };
    const selfHostGate = new EntitlementGate({
      guilds: blockedGuilds,
      selfHosted: true,
      logger: fakeLogger(),
    });
    selfHostGate.check('g-1');
    await tick();
    expect(selfHostGate.check('g-1')).toBe(false);
  });

  it('a failed refresh keeps failing open (a DB blip never mutes a guild)', async () => {
    const guilds: GuildSettingsReader = {
      ensure: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const gate = new EntitlementGate({ guilds, selfHosted: false, logger: fakeLogger() });
    expect(gate.check('g-1')).toBe(true);
    await tick();
    expect(gate.check('g-1')).toBe(true);
  });
  /**
   * Regression, found live. `check()` is sync and answered `hit?.entitled ??
   * true`, and the invalidation listener DELETED the entry, so the next voice
   * event after every invalidation failed open and was processed as entitled.
   * One event per guild per invalidation is enough to create a channel for a
   * guild we just gated.
   *
   * Invalidation must mark the entry stale, not remove it: the answer may be
   * one refresh out of date, but it is never a guess.
   */
  it('serves the last known answer while revalidating, instead of failing open', async () => {
    let status: GuildRow['authStatus'] = 'expired';
    const guilds: GuildSettingsReader = { ensure: vi.fn(async () => rowWith(status)) };
    let invalidate: ((guildId: string) => void) | undefined;
    const notifier = {
      listen: vi.fn(async (_channel: string, cb: (payload: string) => void) => {
        invalidate = cb;
        return () => undefined;
      }),
      onReconnect: vi.fn(),
    };
    const clock = 0;
    const gate = new EntitlementGate({
      guilds,
      selfHosted: false,
      logger: fakeLogger(),
      ttlMs: 60_000,
      now: () => clock,
      notifier: notifier as never,
    });
    await gate.start();

    // Warm the cache with a known-gated guild.
    gate.check('g-1');
    await tick();
    expect(gate.check('g-1')).toBe(false);

    // An invalidation arrives (auth transition, or any settings write).
    invalidate?.('g-1');
    // BEFORE the refresh resolves, the gate must still say "not entitled".
    expect(gate.check('g-1')).toBe(false);
    await tick();
    expect(gate.check('g-1')).toBe(false);

    // And it does pick up a real change once the refresh lands.
    status = 'active';
    invalidate?.('g-1');
    await tick();
    expect(gate.check('g-1')).toBe(true);
  });

  it('still fails open for a guild it has never seen', async () => {
    const guilds: GuildSettingsReader = { ensure: vi.fn(async () => rowWith('expired')) };
    const gate = new EntitlementGate({
      guilds,
      selfHosted: false,
      logger: fakeLogger(),
      ttlMs: 60_000,
      now: () => 0,
    });
    // Never blocking on a cold cache is deliberate: an unknown guild is a cache
    // miss, not a gated one.
    expect(gate.check('never-seen')).toBe(true);
  });
});
