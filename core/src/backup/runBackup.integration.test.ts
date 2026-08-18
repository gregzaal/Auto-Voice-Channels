import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { startMinio, type MinioTestEnv } from '../test/minioContainer.js';
import { BackupStorage } from './storage.js';
import { runBackup } from './runBackup.js';
import { decryptStream } from './encryption.js';
import { isManifestKey, manifestKey, parseManifest } from './manifest.js';

/**
 * The round trip that matters: a real Postgres dumped by a real `pg_dump`,
 * encrypted, streamed into a real S3 implementation, and read back.
 *
 * `plans/backups.md` §9: "a backup you can't restore isn't a backup". Every
 * piece here is exercised for real because the failures this is guarding
 * against -- multipart uploads, streaming bodies, pagination, a client/server
 * version mismatch -- do not exist against a mock.
 */

/**
 * `pg_dump` is on the runtime image and on CI, but not on every dev machine.
 * Skipping loudly beats failing on a laptop that was never going to have it.
 */
function hasPgDump(): boolean {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe.skipIf(!hasPgDump())('runBackup (integration)', () => {
  let pg: PgTestEnv;
  let minio: MinioTestEnv;
  let storage: BackupStorage;

  beforeAll(async () => {
    [pg, minio] = await Promise.all([startPostgres(), startMinio()]);
    storage = new BackupStorage(minio.config);
    await pg.handle.db.execute(sql`INSERT INTO guilds (guild_id) VALUES ('g-backup-1')`);
  }, 300_000);

  afterAll(async () => {
    storage?.destroy();
    await Promise.all([pg?.stop(), minio?.stop()]);
  });

  const base = (over: Partial<Parameters<typeof runBackup>[0]> = {}) => ({
    databaseUrl: pg.connectionString,
    storage,
    prefix: 'v2',
    env: 'test',
    retention: { daily: 7, weekly: 4, monthly: 6 },
    instanceId: 'test-instance',
    appVersion: '0.1.0',
    commit: 'testcommit',
    probe: async () => ({
      pgServerVersion: '16',
      migrationVersion: '0017_test',
      rowCounts: { guilds: 1 },
    }),
    ...over,
  });

  it('dumps, encrypts, uploads and writes a manifest', async () => {
    const result = await runBackup(
      base({ encryptionKey: ENCRYPTION_KEY, now: () => new Date('2026-08-18T03:00:00Z') }),
    );

    expect(result.key).toBe('v2/test/2026/08/18/avc-20260818T030000Z.dump.enc');
    expect(result.manifest.sizeBytes).toBeGreaterThan(0);
    expect(result.manifest.encrypted).toBe(true);
    expect(result.manifest.rowCounts.guilds).toBe(1);

    const objects = await storage.list('v2/test/');
    expect(objects.map((o) => o.key)).toContain(result.key);
    expect(objects.map((o) => o.key)).toContain(manifestKey(result.key));
  }, 300_000);

  /** The manifest is what a restore trusts, so it must survive a round trip. */
  it('writes a manifest that parses and matches the object', async () => {
    const result = await runBackup(
      base({ encryptionKey: ENCRYPTION_KEY, now: () => new Date('2026-08-17T03:00:00Z') }),
    );
    const parsed = parseManifest(await storage.getText(manifestKey(result.key)));

    expect(parsed).toEqual(result.manifest);
    const stored = await buffer(await storage.getStream(result.key));
    expect(stored.length).toBe(parsed.sizeBytes);
  }, 300_000);

  /**
   * The actual point of the whole exercise: the bytes in the bucket decrypt to
   * something `pg_restore` recognises. A dump that uploads but cannot be read
   * back is the failure mode this test exists to prevent.
   */
  it('produces an object that decrypts to a valid pg_dump archive', async () => {
    const result = await runBackup(
      base({ encryptionKey: ENCRYPTION_KEY, now: () => new Date('2026-08-16T03:00:00Z') }),
    );
    const stored = await buffer(await storage.getStream(result.key));
    const plain = await buffer(
      Readable.from([stored]).pipe(decryptStream(Buffer.from(ENCRYPTION_KEY, 'base64'))),
    );

    // pg_dump custom format starts with the magic "PGDMP".
    expect(plain.subarray(0, 5).toString('ascii')).toBe('PGDMP');
    // And pg_restore can list its contents, which is the real proof.
    const listing = execFileSync('pg_restore', ['--list'], {
      input: plain,
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    expect(listing).toMatch(/guilds/);
  }, 300_000);

  it('works unencrypted too, for a self-host that set no key', async () => {
    const result = await runBackup(base({ now: () => new Date('2026-08-15T03:00:00Z') }));
    expect(result.key).toMatch(/\.dump$/);
    expect(result.manifest.encrypted).toBe(false);
    const stored = await buffer(await storage.getStream(result.key));
    expect(stored.subarray(0, 5).toString('ascii')).toBe('PGDMP');
  }, 300_000);

  /** Pruning must remove the manifest with its dump, never orphan one. */
  it('prunes superseded backups and their manifests, keeping the newest', async () => {
    const scope = 'v2/prunetest/';
    const days = ['2026-05-01', '2026-05-02', '2026-05-03'];
    for (const d of days) {
      await runBackup(
        base({
          env: 'prunetest',
          retention: { daily: 5, weekly: 5, monthly: 5 },
          now: () => new Date(`${d}T03:00:00Z`),
        }),
      );
    }
    // Now squeeze the policy so only the newest survives.
    const last = await runBackup(
      base({
        env: 'prunetest',
        retention: { daily: 1, weekly: 0, monthly: 0 },
        now: () => new Date('2026-05-04T03:00:00Z'),
      }),
    );

    const remaining = (await storage.list(scope)).map((o) => o.key);
    expect(remaining).toContain(last.key);
    expect(remaining).toContain(manifestKey(last.key));
    // No manifest left without its dump.
    for (const key of remaining.filter(isManifestKey)) {
      expect(remaining).toContain(key.replace(/\.manifest\.json$/, ''));
    }
    expect(remaining.filter((k) => !isManifestKey(k))).toHaveLength(1);
  }, 600_000);

  /** A foreign object sharing the bucket must never be deleted by our prune. */
  it('leaves objects it did not write alone', async () => {
    const scope = 'v2/foreign/';
    await storage.upload(`${scope}legacy-notes.txt`, 'not ours');
    await runBackup(
      base({
        env: 'foreign',
        retention: { daily: 0, weekly: 0, monthly: 0 },
        now: () => new Date('2026-04-01T03:00:00Z'),
      }),
    );
    await runBackup(
      base({
        env: 'foreign',
        retention: { daily: 0, weekly: 0, monthly: 0 },
        now: () => new Date('2026-04-02T03:00:00Z'),
      }),
    );

    const remaining = (await storage.list(scope)).map((o) => o.key);
    expect(remaining).toContain(`${scope}legacy-notes.txt`);
  }, 600_000);

  /** Bad credentials must fail before a dump is taken, not after. */
  it('checks bucket access up front', async () => {
    const bad = new BackupStorage({ ...minio.config, bucket: 'does-not-exist' });
    await expect(runBackup(base({ storage: bad }))).rejects.toThrow();
    bad.destroy();
  }, 300_000);
});
