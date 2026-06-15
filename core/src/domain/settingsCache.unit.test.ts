import { describe, expect, it } from 'vitest';
import { SettingsCache } from './settingsCache.js';
import type { GuildRepository, GuildRow } from '../repositories/guilds.js';
import type { PgNotifier } from '../db/notify.js';

function row(guildId: string, settings: Record<string, unknown> = {}): GuildRow {
  return {
    guildId,
    authStatus: 'trial',
    authExpiresAt: null,
    settings,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function fakeRepo() {
  return {
    ensureCalls: 0,
    updateCalls: 0,
    async ensure(guildId: string): Promise<GuildRow> {
      this.ensureCalls += 1;
      return row(guildId);
    },
    async updateSettings(guildId: string, patch: Record<string, unknown>): Promise<GuildRow> {
      this.updateCalls += 1;
      return row(guildId, patch);
    },
    async transitionAuth(): Promise<GuildRow> {
      return row('g');
    },
  };
}

function fakeNotifier() {
  return {
    notifies: [] as string[],
    listener: undefined as ((payload: string) => void) | undefined,
    reconnectCb: undefined as (() => void) | undefined,
    async listen(_channel: string, cb: (payload: string) => void): Promise<() => void> {
      this.listener = cb;
      return () => {};
    },
    async notify(_channel: string, payload: string): Promise<void> {
      this.notifies.push(payload);
    },
    onReconnect(cb: () => void): void {
      this.reconnectCb = cb;
    },
  };
}

function build(nowRef: { t: number }) {
  const repo = fakeRepo();
  const notifier = fakeNotifier();
  const cache = new SettingsCache(
    repo as unknown as GuildRepository,
    notifier as unknown as PgNotifier,
    {
      ttlMs: 1_000,
      now: () => nowRef.t,
    },
  );
  return { repo, notifier, cache };
}

describe('SettingsCache', () => {
  it('serves a fresh entry from cache without re-reading', async () => {
    const now = { t: 0 };
    const { repo, cache } = build(now);
    await cache.start();
    await cache.ensure('g1');
    await cache.ensure('g1');
    expect(repo.ensureCalls).toBe(1);
  });

  it('re-reads once the entry is older than the TTL', async () => {
    const now = { t: 0 };
    const { repo, cache } = build(now);
    await cache.start();
    await cache.ensure('g1');
    now.t = 1_001; // past the 1s TTL
    await cache.ensure('g1');
    expect(repo.ensureCalls).toBe(2);
  });

  it('evicts on a broadcast invalidation', async () => {
    const now = { t: 0 };
    const { repo, notifier, cache } = build(now);
    await cache.start();
    await cache.ensure('g1');
    notifier.listener?.('g1'); // a NOTIFY for g1 arrives
    await cache.ensure('g1');
    expect(repo.ensureCalls).toBe(2);
  });

  it('writes through and broadcasts on updateSettings', async () => {
    const now = { t: 0 };
    const { repo, notifier, cache } = build(now);
    await cache.start();
    await cache.ensure('g1');
    await cache.updateSettings('g1', { enabled: false });
    expect(repo.updateCalls).toBe(1);
    expect(notifier.notifies).toContain('g1');
    // The local entry was invalidated → next read re-fetches.
    await cache.ensure('g1');
    expect(repo.ensureCalls).toBe(2);
  });

  it('drops the whole cache on a notifier reconnect (resync)', async () => {
    const now = { t: 0 };
    const { repo, notifier, cache } = build(now);
    await cache.start();
    await cache.ensure('g1');
    await cache.ensure('g2');
    notifier.reconnectCb?.(); // connection bounced; we may have missed invalidations
    await cache.ensure('g1');
    await cache.ensure('g2');
    expect(repo.ensureCalls).toBe(4);
  });
});
