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
 * MinIO rather than a mock, for the same reason the DB tests use a real
 * Postgres: the things that break in this pipeline are multipart uploads,
 * pagination and streaming bodies, and none of those exist in a fake. It is
 * also the closest local stand-in for Backblaze B2, which is what production
 * actually writes to.
 */
export async function startMinio(bucket = 'avc-test'): Promise<MinioTestEnv> {
  const accessKeyId = 'minioadmin';
  const secretAccessKey = 'minioadmin';

  /**
   * **`quay.io`, not Docker Hub, and that is not interchangeable.** `minio/minio`
   * on Docker Hub stopped serving anonymous pulls: the registry answers 404
   * "pull access denied ... repository does not exist or may require 'docker
   * login'" for every tag, including ones it served before. That is a removal,
   * not a rate limit, which answers 429 and would come back on its own.
   *
   * It broke CI silently on 2026-09-12 and took a day to notice, because these
   * four suites `describe.skipIf` themselves away without `pg_dump` on PATH, so
   * they are green on a developer machine and only ever run in CI. A machine
   * that pulled the image before the removal keeps working from its local
   * cache, which is its own trap: the check is `docker rmi` the tag and pull
   * again, never "it works here".
   *
   * MinIO publishes the same release to quay.io (identical digest, verified),
   * so the tag is unchanged. If quay ever does the same thing, the options are
   * an authenticated Docker Hub pull in CI, which does not help anyone locally,
   * or a different S3 implementation entirely.
   */
  const container = await new GenericContainer('quay.io/minio/minio:RELEASE.2024-09-13T20-26-02Z')
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forLogMessage(/API:/))
    .withStartupTimeout(120_000)
    .start();

  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
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
