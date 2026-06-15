import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgNotifier, SETTINGS_INVALIDATE_CHANNEL } from '../db/notify.js';
import { SettingsCache } from '../domain/settingsCache.js';
import { GuildRepository } from '../repositories/guilds.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('PgNotifier + SettingsCache (integration)', () => {
  let env: PgTestEnv;

  beforeAll(async () => {
    env = await startPostgres();
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('delivers NOTIFY payloads to LISTEN subscribers', async () => {
    const notifier = new PgNotifier(env.connectionString);
    await notifier.connect();
    const received: string[] = [];
    await notifier.listen(SETTINGS_INVALIDATE_CHANNEL, (p) => received.push(p));
    await notifier.notify(SETTINGS_INVALIDATE_CHANNEL, 'guild-xyz');
    await waitFor(() => received.includes('guild-xyz'));
    expect(received).toContain('guild-xyz');
    await notifier.close();
  });

  it('SettingsCache evicts an entry when an invalidation is broadcast', async () => {
    const repo = new GuildRepository(env.handle.db);
    await repo.ensure('cache-1');

    const notifier = new PgNotifier(env.connectionString);
    await notifier.connect();
    const cache = new SettingsCache(repo, notifier);
    await cache.start();

    // Warm the cache.
    const first = await cache.get('cache-1');
    expect(first.guildId).toBe('cache-1');

    // A separate publisher broadcasts an invalidation for this guild.
    const publisher = new PgNotifier(env.connectionString);
    await publisher.connect();
    await publisher.notify(SETTINGS_INVALIDATE_CHANNEL, 'cache-1');

    // The cache should evict; we verify by updating the DB and seeing the new value.
    await repo.updateSettings('cache-1', { theme: 'dark' });
    await waitFor(async () => true); // allow notify delivery
    await new Promise((r) => setTimeout(r, 50));
    const refreshed = await cache.get('cache-1');
    expect(refreshed.settings).toMatchObject({ theme: 'dark' });

    await cache.stop();
    await notifier.close();
    await publisher.close();
  });
});
