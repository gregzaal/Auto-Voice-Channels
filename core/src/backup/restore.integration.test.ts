import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { startMinio, type MinioTestEnv } from '../test/minioContainer.js';
import { createDatabase } from '../db/client.js';
import { BackupStorage } from './storage.js';
import { runBackup } from './runBackup.js';
import { listBackups, restoreBackup, selectBackup, verifyBackup } from './restore.js';

/**
 * The claim the whole system rests on: **a backup taken from one database
 * restores into another with the data intact.**
 *
 * Everything before this proves bytes moved. This proves they mean something.
 */

function hasPgTools(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    execFileSync('pg_restore', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const KEY = Buffer.alloc(32, 3).toString('base64');

describe.skipIf(!hasPgTools())('restore (integration)', () => {
  let source: PgTestEnv;
  let target: PgTestEnv;
  let minio: MinioTestEnv;
  let storage: BackupStorage;

  const countTables = async (databaseUrl: string): Promise<number> => {
    const handle = createDatabase({ connectionString: databaseUrl });
    try {
      const res = await handle.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      return Number(res.rows[0]?.n ?? 0);
    } finally {
      await handle.close();
    }
  };

  beforeAll(async () => {
    [source, target, minio] = await Promise.all([
      startPostgres(),
      startPostgres(),
      startMinio('restore-test'),
    ]);
    storage = new BackupStorage(minio.config);

    // Distinctive data, so a restore that "succeeds" against an empty dump fails.
    for (const id of ['g-restore-1', 'g-restore-2', 'g-restore-3']) {
      await source.handle.db.execute(sql`INSERT INTO guilds (guild_id) VALUES (${id})`);
    }
  }, 600_000);

  afterAll(async () => {
    storage?.destroy();
    await Promise.all([source?.stop(), target?.stop(), minio?.stop()]);
  });

  const take = async (env: string, encrypted: boolean, when: string) =>
    runBackup({
      databaseUrl: source.connectionString,
      storage,
      prefix: 'v2',
      env,
      retention: { daily: 30, weekly: 4, monthly: 6 },
      ...(encrypted ? { encryptionKey: KEY } : {}),
      instanceId: 'i',
      appVersion: '0.1.0',
      commit: 'c',
      now: () => new Date(when),
      probe: async () => ({
        pgServerVersion: '16',
        migrationVersion: 'test',
        rowCounts: { guilds: 3 },
      }),
    });

  it('lists what was taken, newest first, with manifests attached', async () => {
    await take('listing', true, '2026-03-01T03:00:00Z');
    await take('listing', true, '2026-03-02T03:00:00Z');
    const listing = await listBackups(storage, 'v2', 'listing');

    expect(listing).toHaveLength(2);
    expect(listing[0]!.createdAt.getTime()).toBeGreaterThan(listing[1]!.createdAt.getTime());
    expect(listing[0]!.manifest?.rowCounts.guilds).toBe(3);
  }, 600_000);

  it('verifies integrity without touching a database', async () => {
    await take('verify', true, '2026-03-03T03:00:00Z');
    const chosen = selectBackup(await listBackups(storage, 'v2', 'verify'));
    const result = await verifyBackup(storage, chosen, KEY);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  }, 600_000);

  /** Wrong key must be caught by verify, not discovered during a restore. */
  it('fails verification with the wrong key', async () => {
    const chosen = selectBackup(await listBackups(storage, 'v2', 'verify'));
    const result = await verifyBackup(storage, chosen, Buffer.alloc(32, 9).toString('base64'));
    expect(result.ok).toBe(false);
  }, 600_000);

  /** The one that matters. */
  it('restores an encrypted backup into a different database, with the rows', async () => {
    await take('roundtrip', true, '2026-03-04T03:00:00Z');
    const chosen = selectBackup(await listBackups(storage, 'v2', 'roundtrip'));

    const result = await restoreBackup({
      storage,
      backup: chosen,
      targetDatabaseUrl: target.connectionString,
      encryptionKey: KEY,
      force: true, // the target has migrations applied, so it is not empty
      countTables,
    });

    expect(result.sha256Matched).toBe(true);

    const handle = createDatabase({ connectionString: target.connectionString });
    try {
      const rows = await handle.db.execute<{ guild_id: string }>(
        sql`SELECT guild_id FROM guilds ORDER BY guild_id`,
      );
      expect(rows.rows.map((r) => r.guild_id)).toEqual([
        'g-restore-1',
        'g-restore-2',
        'g-restore-3',
      ]);
    } finally {
      await handle.close();
    }
  }, 900_000);

  /**
   * The guard between "restore the backup" and "delete production". A populated
   * target must be refused unless --force is given.
   */
  it('refuses to restore over a non-empty database without force', async () => {
    const chosen = selectBackup(await listBackups(storage, 'v2', 'roundtrip'));
    await expect(
      restoreBackup({
        storage,
        backup: chosen,
        targetDatabaseUrl: target.connectionString,
        encryptionKey: KEY,
        countTables,
      }),
    ).rejects.toThrow(/Refusing to restore over it/);
  }, 600_000);

  it('refuses an encrypted backup when no key is configured', async () => {
    const chosen = selectBackup(await listBackups(storage, 'v2', 'roundtrip'));
    await expect(
      restoreBackup({
        storage,
        backup: chosen,
        targetDatabaseUrl: target.connectionString,
        force: true,
        countTables,
      }),
    ).rejects.toThrow(/no BACKUP_ENCRYPTION_KEY/);
  }, 600_000);

  describe('selectBackup', () => {
    it('picks the newest at or before a requested instant', async () => {
      const listing = await listBackups(storage, 'v2', 'listing');
      const chosen = selectBackup(listing, '2026-03-01T12:00:00Z');
      expect(chosen.createdAt.toISOString()).toBe('2026-03-01T03:00:00.000Z');
    }, 600_000);

    it('accepts an exact key', async () => {
      const listing = await listBackups(storage, 'v2', 'listing');
      expect(selectBackup(listing, listing[1]!.key).key).toBe(listing[1]!.key);
    }, 600_000);

    it('explains itself when nothing is old enough', async () => {
      const listing = await listBackups(storage, 'v2', 'listing');
      expect(() => selectBackup(listing, '2020-01-01T00:00:00Z')).toThrow(/The oldest is/);
    }, 600_000);

    it('rejects an unparseable selector', async () => {
      const listing = await listBackups(storage, 'v2', 'listing');
      expect(() => selectBackup(listing, 'yesterday-ish')).toThrow(/Could not read/);
    }, 600_000);
  });
});
