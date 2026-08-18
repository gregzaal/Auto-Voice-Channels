import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { startMinio, type MinioTestEnv } from '../test/minioContainer.js';
import { BackupStorage } from './storage.js';

/**
 * `BackupStorage` against a real S3 implementation.
 *
 * Separate from the pipeline test because this needs no `pg_dump`, so it runs
 * on every machine rather than only where a Postgres client happens to be
 * installed. The things being checked here -- multipart upload, list
 * pagination, batched delete -- are exactly the ones a mock cannot fail on.
 */
describe('BackupStorage (integration)', () => {
  let minio: MinioTestEnv;
  let storage: BackupStorage;

  beforeAll(async () => {
    minio = await startMinio('storage-test');
    storage = new BackupStorage(minio.config);
  }, 300_000);

  afterAll(async () => {
    storage?.destroy();
    await minio?.stop();
  });

  it('accepts a bucket that exists', async () => {
    await expect(storage.checkAccess()).resolves.toBeUndefined();
  });

  /** The up-front check exists so a bad config fails before a dump is taken. */
  it('rejects a bucket that does not', async () => {
    const bad = new BackupStorage({ ...minio.config, bucket: 'nope-not-here' });
    await expect(bad.checkAccess()).rejects.toThrow();
    bad.destroy();
  });

  it('round-trips a small object', async () => {
    await storage.upload('t/small.txt', 'hello');
    expect(await storage.getText('t/small.txt')).toBe('hello');
  });

  /**
   * Larger than the 8MB part size, so this actually exercises the multipart
   * path rather than a single PUT. Streamed, because that is how the pipeline
   * calls it and a Buffer would not prove the stream plumbing works.
   */
  it('streams a multipart upload and reads back identical bytes', async () => {
    const payload = randomBytes(20 * 1024 * 1024);
    await storage.upload('t/big.bin', Readable.from([payload]));
    const back = await buffer(await storage.getStream('t/big.bin'));
    expect(back.length).toBe(payload.length);
    expect(back.equals(payload)).toBe(true);
  }, 300_000);

  /** Listing must follow pagination: S3 caps a page at 1000 keys. */
  it('lists past the 1000-key page boundary', async () => {
    const keys = Array.from({ length: 1050 }, (_, i) => `page/o-${String(i).padStart(5, '0')}`);
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(keys.slice(i, i + 50).map((k) => storage.upload(k, 'x')));
    }
    const listed = await storage.list('page/');
    expect(listed).toHaveLength(1050);
  }, 600_000);

  it('scopes listing to the prefix', async () => {
    await storage.upload('other/thing', 'x');
    const listed = await storage.list('t/');
    expect(listed.every((o) => o.key.startsWith('t/'))).toBe(true);
  });

  it('deletes in batches and reports what went', async () => {
    const keys = ['d/1', 'd/2', 'd/3'];
    await Promise.all(keys.map((k) => storage.upload(k, 'x')));
    const { deleted, failed, errors } = await storage.deleteMany(keys);
    expect(errors).toEqual([]);
    expect(deleted.sort()).toEqual(keys);
    expect(failed).toEqual([]);
    expect(await storage.list('d/')).toHaveLength(0);
  }, 300_000);

  /**
   * Deleting something that is not there is not an error in S3, and must not
   * be treated as one: a prune racing another instance would otherwise fail.
   */
  it('treats deleting a missing key as success, not failure', async () => {
    const { failed } = await storage.deleteMany(['d/never-existed']);
    expect(failed).toEqual([]);
  });
});
