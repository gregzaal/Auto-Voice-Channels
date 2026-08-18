import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';

/**
 * A thin S3 façade for the backup pipeline (`plans/backups.md` §2).
 *
 * Deliberately small and provider-agnostic: one S3 API covers Backblaze B2,
 * Cloudflare R2, AWS S3 and MinIO, which is what lets a self-hoster pick a
 * provider instead of waiting for an adapter. Nothing above this file knows
 * which one is in use.
 *
 * `forcePathStyle` is on because MinIO and several B2 endpoints do not serve
 * virtual-hosted-style buckets, and getting it wrong produces a DNS error that
 * looks nothing like a configuration problem.
 */

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

export class BackupStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      /**
       * Do not add checksums the operation does not require.
       *
       * AWS SDK v3 changed its default to `WHEN_SUPPORTED`, which attaches an
       * `x-amz-checksum-crc32` header to everything. Real S3 accepts it; most
       * S3-*compatible* providers do not, and they answer `DeleteObjects` with
       * "Missing required header for this request: Content-Md5" because the
       * CRC32 header displaced the MD5 they actually want.
       *
       * Found by the MinIO integration test, and it would have behaved the same
       * way against Backblaze B2 in production: every prune failing forever,
       * silently, while backups kept succeeding and the bucket kept growing.
       */
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Proves the credentials and bucket work *before* a dump is taken.
   *
   * Worth its own call: without it the first sign of a bad key is a failed
   * upload after spending minutes dumping the database, and on a schedule that
   * failure repeats nightly with the same wasted work.
   */
  async checkAccess(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /**
   * Streams an object up as a multipart upload.
   *
   * `lib-storage` handles the part splitting and concurrency, which is what
   * keeps memory bounded regardless of database size: the pipeline never holds
   * more than a few parts, rather than the whole dump.
   */
  async upload(key: string, body: Readable | Buffer | string, contentType?: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      },
      queueSize: 3,
      partSize: 8 * 1024 * 1024,
    });
    await upload.done();
  }

  /** Every object under a prefix, following pagination to the end. */
  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        out.push({ key: item.Key, size: item.Size ?? 0, lastModified: item.LastModified });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    return res.Body as Readable;
  }

  async getText(key: string): Promise<string> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    return res.Body.transformToString();
  }

  /**
   * Deletes objects one request at a time, with bounded concurrency.
   *
   * **Not** `DeleteObjects`, the batch API, and that is deliberate. The batch
   * call requires a `Content-MD5` header on most S3-compatible providers, and
   * AWS SDK v3 no longer sends one: it attaches `x-amz-checksum-crc32` instead,
   * which real S3 accepts and MinIO and Backblaze B2 reject with "Missing
   * required header for this request: Content-Md5". Setting
   * `requestChecksumCalculation: 'WHEN_REQUIRED'` does not bring the MD5 back on
   * current SDK versions.
   *
   * The batch API's only advantage is throughput on very large deletes, and a
   * retention prune removes a handful of objects per run. Trading that for
   * working on every provider is not a close call.
   *
   * Found by the MinIO integration test. Against B2 this would have been every
   * prune failing forever, silently, while backups kept succeeding and the
   * bucket kept growing.
   *
   * Returns what failed rather than throwing: a prune that cannot delete one
   * object must not abort the rest, and must never fail a backup that has
   * already been uploaded. A key that is already gone counts as deleted, since
   * S3 DELETE is idempotent and a racing prune is not an error.
   */
  async deleteMany(
    keys: readonly string[],
  ): Promise<{ deleted: string[]; failed: string[]; errors: string[] }> {
    const deleted: string[] = [];
    const failed: string[] = [];
    const errors: string[] = [];
    const CONCURRENCY = 8;

    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const batch = keys.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (key) => {
          try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
            deleted.push(key);
          } catch (error) {
            // A provider with delete disabled (the object-lock model in §6)
            // lands here. That is a retention misconfiguration, not a backup
            // failure, so it is reported with its reason rather than thrown.
            failed.push(key);
            errors.push(`${key}: ${(error as Error).message}`);
          }
        }),
      );
    }
    return { deleted, failed, errors };
  }

  destroy(): void {
    this.client.destroy();
  }
}
