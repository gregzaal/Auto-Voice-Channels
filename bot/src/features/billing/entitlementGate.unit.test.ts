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
});
