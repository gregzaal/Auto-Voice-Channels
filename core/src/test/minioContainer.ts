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

  const container = await new GenericContainer('minio/minio:RELEASE.2024-09-13T20-26-02Z')
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
