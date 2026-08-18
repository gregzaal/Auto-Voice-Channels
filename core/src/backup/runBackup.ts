import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encryptStream, parseKey } from './encryption.js';
import {
  isManifestKey,
  manifestKey,
  objectKey,
  planRetention,
  type BackupManifest,
  type RetentionPolicy,
} from './manifest.js';
import type { BackupStorage } from './storage.js';

/**
 * The dump-encrypt-upload-manifest-prune pipeline (`plans/backups.md` §4).
 *
 * Streamed end to end so memory stays bounded regardless of database size. This
 * runs in-process inside the bot, which is also serving Discord events, so
 * buffering a dump would put the whole database in that heap.
 *
 * Ordering is the safety property: **the new object is uploaded and verified
 * before anything old is deleted.** A prune failure is reported and never fails
 * the backup, because a successful backup with a stale sibling is fine and a
 * deleted history is not.
 */

export interface RunBackupOptions {
  databaseUrl: string;
  storage: BackupStorage;
  prefix: string;
  env: string;
  retention: RetentionPolicy;
  encryptionKey?: string | undefined;
  instanceId: string;
  appVersion: string;
  commit: string;
  /** Row counts and versions for the manifest. Injected so this stays DB-agnostic. */
  probe: () => Promise<{
    pgServerVersion: string | null;
    migrationVersion: string | null;
    rowCounts: Record<string, number>;
  }>;
  /** Marks the object as a drill so it is never mistaken for a real backup. */
  drill?: boolean;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface BackupResult {
  key: string;
  manifest: BackupManifest;
  pruned: string[];
  prunedFailed: string[];
  durationMs: number;
}

/**
 * Postgres connection as environment rather than argv.
 *
 * `pg_dump postgres://user:pass@host/db` puts the password in the process list,
 * readable by any other process on the box. The env form does not.
 */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  const u = new URL(databaseUrl);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(u.hostname),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  // Managed providers generally require TLS; `prefer` keeps a local
  // docker-compose Postgres working without it.
  const sslmode = u.searchParams.get('sslmode');
  env.PGSSLMODE = sslmode ?? 'prefer';
  return env;
}

/** Hashes and counts bytes as they pass, so neither needs a second read. */
function digestStream(): Transform & { sha256: () => string; bytes: () => number } {
  const hash = createHash('sha256');
  let bytes = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  return Object.assign(t, {
    sha256: () => hash.digest('hex'),
    bytes: () => bytes,
  });
}

export async function runBackup(opts: RunBackupOptions): Promise<BackupResult> {
  const now = opts.now ?? ((): Date => new Date());
  const log = opts.log ?? ((): void => {});
  const startedAt = Date.now();
  const at = now();
  const encrypted = Boolean(opts.encryptionKey);

  // Fail before spending minutes on a dump nobody can upload.
  await opts.storage.checkAccess();

  const key = objectKey({ prefix: opts.prefix, env: opts.env, at, encrypted });
  log('backup.start', { key, encrypted });

  const child = spawn('pg_dump', ['-Fc', '--no-owner', '--no-privileges'], {
    env: { ...process.env, ...pgEnvFromUrl(opts.databaseUrl) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    // Bounded: a pathological dump must not grow this without limit.
    if (stderr.length < 8192) stderr += d;
  });

  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (e) =>
      reject(
        new Error(
          `Could not run pg_dump: ${e.message}. The runtime image must include postgresql-client.`,
        ),
      ),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited ${code}: ${stderr.trim() || '(no stderr)'}`)),
    );
  });

  const digest = digestStream();
  const body = new PassThrough();

  const stages: (Readable | Transform | PassThrough)[] = [child.stdout];
  if (opts.encryptionKey) stages.push(encryptStream(parseKey(opts.encryptionKey)));
  stages.push(digest, body);

  // Upload consumes `body` concurrently with the dump producing into it, which
  // is what makes this streaming rather than staged through a temp file.
  const uploaded = opts.storage.upload(key, body, 'application/octet-stream');

  await Promise.all([pipeline(stages as [Readable, ...NodeJS.WritableStream[]]), exited, uploaded]);

  const sizeBytes = digest.bytes();
  if (sizeBytes === 0) {
    throw new Error('pg_dump produced zero bytes. Refusing to record an empty object as a backup.');
  }

  const probed = await opts.probe();
  const manifest: BackupManifest = {
    createdAt: at.toISOString(),
    sizeBytes,
    sha256: digest.sha256(),
    encrypted,
    pgServerVersion: probed.pgServerVersion,
    migrationVersion: probed.migrationVersion,
    rowCounts: probed.rowCounts,
    instanceId: opts.instanceId,
    appVersion: opts.appVersion,
    commit: opts.commit,
    ...(opts.drill ? { drill: true } : {}),
  };
  await opts.storage.upload(
    manifestKey(key),
    JSON.stringify(manifest, null, 2),
    'application/json',
  );
  log('backup.uploaded', { key, sizeBytes, sha256: manifest.sha256 });

  const { pruned, prunedFailed } = await prune(opts, key, log);

  return {
    key,
    manifest,
    pruned,
    prunedFailed,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Retention, run only after the new object is safely up.
 *
 * Entries are dated from the object key rather than the sibling manifest: one
 * list call instead of N gets, and the key is generated by us so it is as
 * trustworthy as the manifest for ordering. Anything unparseable is left alone
 * rather than deleted, because an object this code does not understand is not
 * an object it should remove.
 */
async function prune(
  opts: RunBackupOptions,
  justWritten: string,
  log: (event: string, data: Record<string, unknown>) => void,
): Promise<{ pruned: string[]; prunedFailed: string[] }> {
  try {
    const scope = `${opts.prefix.replace(/^\/+|\/+$/g, '')}/${opts.env}/`;
    const objects = await opts.storage.list(scope);
    const entries = objects
      .filter((o) => !isManifestKey(o.key))
      .map((o) => ({ key: o.key, createdAt: parseKeyDate(o.key) }))
      .filter((e): e is { key: string; createdAt: Date } => e.createdAt !== null);

    const { deleteKeys } = planRetention(entries, opts.retention);
    // Belt and braces over planRetention's own guarantee.
    const targets = deleteKeys.filter((k) => k !== justWritten);
    if (targets.length === 0) return { pruned: [], prunedFailed: [] };

    const withManifests = targets.flatMap((k) => [k, manifestKey(k)]);
    const { deleted, failed } = await opts.storage.deleteMany(withManifests);
    log('backup.pruned', { deleted: deleted.length, failed: failed.length });
    return { pruned: deleted, prunedFailed: failed };
  } catch (error) {
    // Never fail a successful backup because cleanup failed.
    log('backup.prune_failed', { error: (error as Error).message });
    return { pruned: [], prunedFailed: [] };
  }
}

/** `.../avc-20260818T030405Z.dump[.enc]` back to a Date, or null if foreign. */
export function parseKeyDate(key: string): Date | null {
  const m = /avc-(\d{8})T(\d{6})Z\.dump(\.enc)?$/.exec(key);
  if (!m) return null;
  const [, d, t] = m;
  const iso =
    `${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)}` +
    `T${t!.slice(0, 2)}:${t!.slice(2, 4)}:${t!.slice(4, 6)}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
