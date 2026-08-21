import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgNotifier, SETTINGS_INVALIDATE_CHANNEL } from '../db/notify.js';
import { SettingsCache } from '../domain/settingsCache.js';
import { GuildRepository } from '../repositories/guilds.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now();
  while (!(await predicate())) {
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

  it('heartbeats the LISTEN connection, and keeps delivering across beats', async () => {
    /**
     * A LISTEN connection sends nothing and waits, so the private-network path
     * reaps it on a timer. Keepalive probes did not stop that in production, so
     * the notifier issues real queries. This asserts the beat is actually on
     * the wire: `pg_stat_activity.query` holds the last statement a backend
     * ran, and nothing else in this suite runs a bare `SELECT 1`.
     *
     * What it cannot cover is the reaping itself. There is no middlebox in a
     * Testcontainers network, which is the same reason the backup drill's
     * permission failures only ever showed up against the real cluster.
     */
    const notifier = new PgNotifier(env.connectionString, undefined, 50);
    await notifier.connect();
    const received: string[] = [];
    await notifier.listen(SETTINGS_INVALIDATE_CHANNEL, (p) => received.push(p));

    const beatSeen = async (): Promise<boolean> => {
      const res = await env.handle.db.execute(
        sql`SELECT 1 FROM pg_stat_activity
             WHERE query = 'SELECT 1' AND pid <> pg_backend_pid()`,
      );
      return res.rows.length > 0;
    };

    let seen = false;
    await waitFor(async () => (seen = seen || (await beatSeen())));
    expect(seen).toBe(true);

    // The beat shares the connection with LISTEN, so prove it did not disturb it.
    await notifier.notify(SETTINGS_INVALIDATE_CHANNEL, 'after-beat');
    await waitFor(() => received.includes('after-beat'));
    expect(received).toContain('after-beat');

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
    const first = await cache.ensure('cache-1');
    expect(first.guildId).toBe('cache-1');

    // A separate publisher broadcasts an invalidation for this guild.
    const publisher = new PgNotifier(env.connectionString);
    await publisher.connect();
    await publisher.notify(SETTINGS_INVALIDATE_CHANNEL, 'cache-1');

    // The cache should evict; we verify by updating the DB and seeing the new value.
    await repo.updateSettings('cache-1', { theme: 'dark' });
    await waitFor(async () => true); // allow notify delivery
    await new Promise((r) => setTimeout(r, 50));
    const refreshed = await cache.ensure('cache-1');
    expect(refreshed.settings).toMatchObject({ theme: 'dark' });

    await cache.stop();
    await notifier.close();
    await publisher.close();
  });
});
