import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { startMinio, type MinioTestEnv } from '../test/minioContainer.js';
import { BackupStorage } from './storage.js';
import { runBackup } from './runBackup.js';
import { manifestKey } from './manifest.js';
import { runDrill } from './drill.js';

/**
 * The drill, against a real bucket and a real archive (`plans/backups.md` §9).
 *
 * The point of a drill is to notice a backup that cannot be restored, so the
 * tests that matter here are the failing ones: a corrupted object, a missing
 * manifest, a key that no longer decrypts. A drill that only ever passes is
 * indistinguishable from one that always returns true.
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

const KEY = Buffer.alloc(32, 7).toString('base64');
const TAKEN_AT = '2026-08-19T03:00:00Z';
const SOON_AFTER = new Date('2026-08-19T09:00:00Z');

describe.skipIf(!hasPgTools())('runDrill (integration)', () => {
  let source: PgTestEnv;
  let scratch: PgTestEnv;
  let minio: MinioTestEnv;
  let storage: BackupStorage;

  beforeAll(async () => {
    [source, scratch, minio] = await Promise.all([
      startPostgres(),
      startPostgres(),
      startMinio('drill-test'),
    ]);
    storage = new BackupStorage(minio.config);

    for (const id of ['g-drill-1', 'g-drill-2', 'g-drill-3', 'g-drill-4']) {
      await source.handle.db.execute(sql`INSERT INTO guilds (guild_id) VALUES (${id})`);
    }
  }, 600_000);

  afterAll(async () => {
    storage?.destroy();
    await Promise.all([source?.stop(), scratch?.stop(), minio?.stop()]);
  });

  const take = async (env: string, when = TAKEN_AT, encrypted = true) =>
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
        rowCounts: { guilds: 4 },
      }),
    });

  const drill = (env: string, extra: Record<string, unknown> = {}) =>
    runDrill({
      storage,
      prefix: 'v2',
      env,
      encryptionKey: KEY,
      now: () => SOON_AFTER,
      ...extra,
    });

  it('passes on a healthy encrypted backup, with no database at all', async () => {
    await take('healthy');
    const result = await drill('healthy');

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checksumOk).toBe(true);
    expect(result.restored).toBe(false);
    expect(result.tablesInArchive).toContain('guilds');
    expect(result.tocEntries).toBeGreaterThan(0);
  }, 900_000);

  it('says so when no scratch database is configured', async () => {
    const result = await drill('healthy');
    expect(result.notes.join(' ')).toMatch(/BACKUP_DRILL_DATABASE_URL/);
  }, 600_000);

  it('reports having nothing to check rather than passing vacuously', async () => {
    const result = await drill('empty-bucket');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/No backups found/);
  }, 600_000);

  /** The failure the whole drill exists for: the object rotted in the bucket. */
  it('fails when the stored object no longer matches its manifest', async () => {
    const taken = await take('corrupt');
    await storage.upload(taken.key, Buffer.alloc(4096, 1), 'application/octet-stream');

    const result = await drill('corrupt');
    expect(result.ok).toBe(false);
    expect(result.checksumOk).toBe(false);
    expect(result.problems.join(' ')).toMatch(/Checksum|header|pg_dump/);
  }, 900_000);

  /** A stale backup is a finding, not a pass with an old date attached. */
  it('fails when the newest backup is older than the threshold', async () => {
    await take('stale', '2026-08-01T03:00:00Z');
    const result = await drill('stale', { maxAgeHours: 36 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/past the 36h threshold/);
  }, 900_000);

  /** Losing the key is silent until a restore. The drill makes it loud. */
  it('fails when the configured key cannot decrypt the object', async () => {
    await take('wrongkey');
    const result = await drill('wrongkey', {
      encryptionKey: Buffer.alloc(32, 9).toString('base64'),
    });
    expect(result.ok).toBe(false);
  }, 900_000);

  it('fails when the manifest is gone, rather than skipping the checks', async () => {
    const taken = await take('nomanifest');
    await storage.deleteMany([manifestKey(taken.key)]);

    const result = await drill('nomanifest');
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/no manifest/i);
  }, 900_000);

  describe('with a scratch database', () => {
    it('restores the dump and matches row counts against the manifest', async () => {
      await take('scratch');
      const result = await drill('scratch', {
        scratchDatabaseUrl: scratch.connectionString,
        liveDatabaseUrl: source.connectionString,
      });

      expect(result.problems).toEqual([]);
      expect(result.restored).toBe(true);
      expect(result.rowCounts.guilds).toEqual({ manifest: 4, restored: 4 });
    }, 900_000);

    /**
     * A drill that leaves a copy of production in a second database has created
     * a second thing to secure that nobody is watching.
     */
    it('wipes the scratch database when it is done', async () => {
      const tables = await scratch.handle.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(Number(tables.rows[0]?.n)).toBe(0);
    }, 600_000);

    /**
     * Both test containers use the database name `avc`, which is exactly the
     * case the first implementation refused: it compared database names and
     * called two separate servers the same database. A scratch Postgres using
     * the default name is the normal setup, not a mistake, and the test above
     * passing is what proves the guard no longer rejects it.
     */
    it('refuses a populated database even with no live URL to compare against', async () => {
      const result = await drill('scratch', {
        // A real database full of tables, and nothing configured to recognise
        // it by. Only the marker check can catch this, which is the point.
        scratchDatabaseUrl: source.connectionString,
      });
      expect(result.restored).toBe(false);
      expect(result.problems.join(' ')).toMatch(/was not left by a drill/);

      const rows = await source.handle.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM guilds`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(4);
    }, 600_000);

    /**
     * The guard that stops a misconfigured drill from being a weekly scheduled
     * outage. It must refuse *before* restoring, so the live rows survive.
     */
    it('refuses to restore into the live database', async () => {
      await take('guard');
      const result = await drill('guard', {
        scratchDatabaseUrl: source.connectionString,
        liveDatabaseUrl: source.connectionString,
      });

      expect(result.ok).toBe(false);
      expect(result.restored).toBe(false);
      expect(result.problems.join(' ')).toMatch(/points at the live database/);

      const rows = await source.handle.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM guilds`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(4);
    }, 900_000);
  });

  /**
   * A drill artifact carries `drill: true` so it can never become the object a
   * later drill checks. Otherwise the system ends up verifying its own copy.
   *
   * **The two are a day apart on purpose.** The first version put them an hour
   * apart and failed for a reason worth keeping: retention keeps the newest
   * backup per day, so the drill artifact evicted the real backup taken an hour
   * earlier, and the drill then found nothing at all to check. Nothing uploads
   * artifacts today, so this is latent rather than live, but any future code
   * that writes one into the backup prefix inherits the problem: **a drill
   * artifact must never be able to prune a real backup.**
   */
  it('ignores drill artifacts when choosing what to check', async () => {
    await take('artifacts', '2026-08-19T03:00:00Z');
    await runBackup({
      databaseUrl: source.connectionString,
      storage,
      prefix: 'v2',
      env: 'artifacts',
      retention: { daily: 30, weekly: 4, monthly: 6 },
      encryptionKey: KEY,
      instanceId: 'i',
      appVersion: '0.1.0',
      commit: 'c',
      drill: true,
      now: () => new Date('2026-08-20T04:00:00Z'),
      probe: async () => ({ pgServerVersion: '16', migrationVersion: 't', rowCounts: {} }),
    });

    const result = await drill('artifacts', { maxAgeHours: 24 * 365 });
    // The scheduled backup, not the newer drill artifact.
    expect(result.takenAt).toBe('2026-08-19T03:00:00.000Z');
  }, 900_000);
});
