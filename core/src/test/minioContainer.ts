import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageConfig } from '../backup/storage.js';

export interface MinioTestEnv {
  container: StartedTestContainer;
  config: StorageConfig;
  stop: () => Promise<void>;
}

/**
 * An ephemeral S3-compatible endpoint for backup integration tests.
 *
 * A real S3 server rather than a mock, for the same reason the DB tests use a
 * real Postgres: the things that break in this pipeline are multipart uploads,
 * pagination and streaming bodies, and none of those exist in a fake. It
 * stands in for Backblaze B2, which is what production actually writes to.
 *
 * Still named for MinIO, which it ran until MinIO's images stopped being
 * pullable, so the four suites that import it did not have to change.
 */
export async function startMinio(bucket = 'avc-test'): Promise<MinioTestEnv> {
  // Any pair works: a SeaweedFS with no identities configured does not check
  // signatures. The client still signs every request, as it does against B2.
  const accessKeyId = 'test';
  const secretAccessKey = 'test';

  /**
   * **SeaweedFS, because MinIO can no longer be pulled anonymously.** Docker
   * Hub's `minio/minio` stopped serving anonymous pulls on 2026-09-12, and
   * `quay.io/minio/minio`, which replaced it, answered 401 Unauthorized from
   * 2026-10-04, for every tag. Both are removals, not rate limits (a 429 comes
   * back on its own), and both failed CI on every push until noticed.
   *
   * Each went unnoticed because these four suites `describe.skipIf` themselves
   * away without `pg_dump` on PATH, so they pass on a developer machine and
   * only ever run in CI. A machine that already has the image keeps working
   * from its local cache, which is its own trap: the check is to `docker rmi`
   * the tag and pull again, never "it works here".
   *
   * One container runs the master, volume, filer and S3 gateway (`server -s3`),
   * and is ready when the gateway answers its health check. Pinned to a
   * release, never `latest`, so a new SeaweedFS cannot change a backup test's
   * result without a commit saying so.
   */
  const container = await new GenericContainer('chrislusf/seaweedfs:4.48')
    .withCommand(['server', '-dir=/data', '-s3', '-s3.port=8333', '-ip.bind=0.0.0.0'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forHttp('/healthz', 8333).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
  const config: StorageConfig = {
    endpoint,
    region: 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
  };

  const client = new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  client.destroy();

  return {
    container,
    config,
    stop: async () => {
      await container.stop();
    },
  };
}
