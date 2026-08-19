import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decryptStream, isEncrypted, parseKey } from './encryption.js';
import { isManifestKey, manifestKey, parseManifest, type BackupManifest } from './manifest.js';
import { parseKeyDate, pgEnvFromUrl } from './runBackup.js';
import type { BackupStorage } from './storage.js';

/** How much of `pg_restore`'s stderr we keep. Enough for any real report. */
const STDERR_LIMIT = 16384;

/**
 * Download, decrypt, verify, `pg_restore` (`plans/backups.md` §10).
 *
 * Written to be usable under pressure, which shapes two things: it refuses
 * anything ambiguous rather than guessing, and every refusal names what to do
 * about it. The moment this code runs is the moment nobody wants a surprise.
 */

export interface BackupListing {
  key: string;
  createdAt: Date;
  sizeBytes: number;
  manifest: BackupManifest | null;
}

/**
 * Available backups, newest first.
 *
 * The manifest is fetched per entry, so this is N+1 requests by design: a
 * listing is a human-facing, rare operation, and the migration version is the
 * whole reason someone runs it.
 */
export async function listBackups(
  storage: BackupStorage,
  prefix: string,
  env: string,
): Promise<BackupListing[]> {
  const scope = `${prefix.replace(/^\/+|\/+$/g, '')}/${env}/`;
  const objects = await storage.list(scope);
  const dumps = objects.filter((o) => !isManifestKey(o.key) && parseKeyDate(o.key) !== null);

  const out = await Promise.all(
    dumps.map(async (o): Promise<BackupListing> => {
      let manifest: BackupManifest | null = null;
      try {
        manifest = parseManifest(await storage.getText(manifestKey(o.key)));
      } catch {
        // A dump whose manifest is missing or corrupt is still restorable, and
        // hiding it would be the wrong call in an emergency. It is listed
        // without metadata so the operator can see it and decide.
        manifest = null;
      }
      return {
        key: o.key,
        createdAt: parseKeyDate(o.key)!,
        sizeBytes: o.size,
        manifest,
      };
    }),
  );
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Resolves `--latest` / `--at <ISO|key>` to exactly one backup, or explains why not. */
export function selectBackup(listing: readonly BackupListing[], at?: string): BackupListing {
  if (listing.length === 0) {
    throw new Error('No backups found under that prefix and environment.');
  }
  if (!at) return listing[0]!;

  const exact = listing.find((b) => b.key === at);
  if (exact) return exact;

  const wanted = new Date(at);
  if (Number.isNaN(wanted.getTime())) {
    throw new Error(`Could not read "${at}" as an object key or an ISO timestamp.`);
  }
  // The newest backup at or before the requested moment: what "restore to this
  // point in time" means when the exact instant has no backup.
  const match = listing.find((b) => b.createdAt.getTime() <= wanted.getTime());
  if (!match) {
    throw new Error(
      `No backup at or before ${wanted.toISOString()}. The oldest is ` +
        `${listing[listing.length - 1]!.createdAt.toISOString()}.`,
    );
  }
  return match;
}

export interface RestoreOptions {
  storage: BackupStorage;
  backup: BackupListing;
  targetDatabaseUrl: string;
  encryptionKey?: string | undefined;
  /** Required to restore over a database that already has tables. */
  force?: boolean;
  /** Tables present in the target, injected so this stays DB-client-agnostic. */
  countTables: (databaseUrl: string) => Promise<number>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Does a non-zero `pg_restore` exit describe only errors we can safely ignore?
 *
 * `pg_restore` exits 1 for ANY error it met, including ones it deliberately
 * ignored and summarised as "errors ignored on restore: N". On managed
 * Postgres the archive's `DROP EXTENSION` and `COMMENT ON EXTENSION`
 * statements always fail, because the platform owns `pgaudit` and
 * `pg_stat_monitor` and our role does not. Every table, index and row lands
 * correctly and the exit code says otherwise.
 *
 * That is not cosmetic. Left alone it fails the weekly restore drill every
 * week against a backup that is perfectly good, which is alert fatigue on the
 * one check standing between us and data loss. Worse, during a real incident
 * it tells whoever is recovering that their restore failed when it succeeded,
 * at the exact moment they are least able to second-guess it.
 *
 * Three conditions, and the last two matter more than the first:
 *
 *  1. Every `pg_restore: error:` line is an extension-ownership error.
 *  2. The `errors ignored on restore: N` summary is PRESENT. pg_restore emits
 *     it immediately before returning, whenever it ignored anything. Its
 *     absence therefore means the process never reached the end, or that the
 *     stderr we are reading was truncated before it got there. Either way we
 *     are deciding on a partial picture and must not tolerate anything.
 *  3. N equals the number of error lines we actually matched. If pg_restore
 *     counted more errors than we can see, the ones we cannot see are the ones
 *     that would have failed this check.
 *
 * Conditions 2 and 3 exist because the caller's stderr buffer is capped and
 * drops what overflows, and because `--clean` runs its DROP phase FIRST: the
 * tolerable extension errors are at the front of the buffer and any real error
 * from the data or post-data phase is what falls off the end. Reading condition
 * 1 alone off a truncated buffer reports a broken restore as a good one.
 *
 * Do not widen this. An error this function cannot name is exactly the one
 * worth stopping for.
 */
export function restoreErrorsAreIgnorable(stderr: string): boolean {
  const lines = stderr.split('\n').map((line) => line.trim());

  /**
   * `pg_restore: error:` is the PG12+ unified format, which is what the runtime
   * image installs. An older client logs `pg_restore: [archiver (db)]` instead
   * and matches nothing here, which fails closed. Leave it that way.
   */
  const errors = lines.filter((line) => line.startsWith('pg_restore: error:'));
  if (errors.length === 0) return false;
  if (!errors.every((line) => /must be owner of extension/i.test(line))) return false;

  const summary = lines
    .map((line) => /errors ignored on restore:\s*(\d+)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .pop();
  if (!summary) return false;

  return Number(summary[1]) === errors.length;
}

export interface RestoreResult {
  key: string;
  bytes: number;
  sha256: string;
  sha256Matched: boolean | null;
  warnings: string[];
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? ((): void => {});
  const warnings: string[] = [];
  const manifest = opts.backup.manifest;

  // Refuse to overwrite a populated database unless told twice. This is the
  // only guard between "restore the backup" and "delete production".
  const existingTables = await opts.countTables(opts.targetDatabaseUrl);
  if (existingTables > 0 && !opts.force) {
    throw new Error(
      `Target database already has ${existingTables} tables. Refusing to restore over it. ` +
        `Re-run with --force if that is genuinely what you want.`,
    );
  }

  if (manifest?.drill) {
    warnings.push('This object is a restore-drill artifact, not a scheduled backup.');
  }
  if (manifest?.encrypted && !opts.encryptionKey) {
    throw new Error(
      'This backup is encrypted and no BACKUP_ENCRYPTION_KEY is configured. ' +
        'Without the original key the object cannot be recovered.',
    );
  }

  const body = await opts.storage.getStream(opts.backup.key);
  const encryptedByKeyName = opts.backup.key.endsWith('.enc');
  const useDecrypt = Boolean(opts.encryptionKey) && (manifest?.encrypted ?? encryptedByKeyName);

  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });

  // `-d` needs the real database name. `-d -` is not "read stdin", it is a
  // database literally called "-", which is how CI first failed this. The
  // archive comes from stdin implicitly, because no filename is given.
  const pgEnv = pgEnvFromUrl(opts.targetDatabaseUrl);
  const dbName = pgEnv.PGDATABASE;
  if (!dbName) {
    throw new Error(`Target connection string names no database: ${opts.targetDatabaseUrl}`);
  }

  const child = spawn(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--dbname', dbName],
    {
      env: { ...process.env, ...pgEnv },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  /**
   * Bounded, and it says so when it bounds. Silently dropping the tail is how a
   * truncated buffer starts looking like a clean one to
   * `restoreErrorsAreIgnorable`, whose summary-line check depends on the END of
   * the output being present.
   */
  let stderr = '';
  let stderrTruncated = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += d;
    else stderrTruncated = true;
  });

  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (e) =>
      reject(
        new Error(
          `Could not run pg_restore: ${e.message}. The image must include postgresql-client.`,
        ),
      ),
    );
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      /**
       * A signal-terminated child reports `code === null`, so without this it
       * would fall through to the predicate and be judged on whatever stderr it
       * had produced before it died. A kill during the post-data phase is the
       * dangerous one: stdin is long since consumed, so the pipeline has
       * already resolved and cannot flag it, and the result is every row
       * present with no indexes, primary keys or foreign keys. Nothing
       * downstream can see that, because the row counts are all correct.
       */
      if (signal !== null) {
        return reject(
          new Error(`pg_restore was killed by ${signal}: ${stderr.trim() || '(no stderr)'}`),
        );
      }
      if (!stderrTruncated && restoreErrorsAreIgnorable(stderr)) return resolve();
      reject(new Error(`pg_restore exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });

  // The checksum is over the *stored* bytes, matching how runBackup computed it,
  // so the tap sits before decryption rather than after.
  const stages: (Readable | Transform)[] = [body, tap];
  if (useDecrypt) stages.push(decryptStream(parseKey(opts.encryptionKey!)));

  log('restore.start', { key: opts.backup.key, encrypted: useDecrypt });
  await Promise.all([
    pipeline([...stages, child.stdin] as unknown as [Readable, ...NodeJS.WritableStream[]]),
    exited,
  ]);

  const sha256 = hash.digest('hex');
  const sha256Matched = manifest ? sha256 === manifest.sha256 : null;
  if (sha256Matched === false) {
    warnings.push(
      `Checksum mismatch: the object hashes to ${sha256} but its manifest recorded ` +
        `${manifest!.sha256}. The restore completed, so inspect the data before trusting it.`,
    );
  }
  if (sha256Matched === null) {
    warnings.push('No manifest, so the object could not be checksum-verified.');
  }
  if (stderr.trim()) {
    /**
     * Say what is known, and no more. An earlier version of this line added
     * "and does not affect the data", which is a reassurance this code cannot
     * actually verify, addressed to someone mid-incident who is least able to
     * second-guess it.
     */
    const tolerated = !stderrTruncated && restoreErrorsAreIgnorable(stderr);
    warnings.push(
      (tolerated
        ? 'pg_restore could not drop or comment the platform-owned extensions, which managed ' +
          'Postgres always refuses. Tolerated, and reported here so it is not invisible: '
        : 'pg_restore reported: ') + stderr.trim().slice(0, 500),
    );
    if (stderrTruncated) {
      warnings.push(
        `pg_restore produced more than ${STDERR_LIMIT} bytes of stderr and the rest was dropped, ` +
          'so the report above is incomplete.',
      );
    }
  }

  log('restore.done', { key: opts.backup.key, bytes, sha256Matched });
  return { key: opts.backup.key, bytes, sha256, sha256Matched, warnings };
}

/**
 * Integrity check without touching a database: stream the object, verify the
 * checksum, and confirm it decrypts to something `pg_dump` produced.
 *
 * This is what the weekly drill and `backup:verify` share, and it is the cheap
 * half of §9: it catches silent corruption in storage without needing a scratch
 * database.
 */
export async function verifyBackup(
  storage: BackupStorage,
  backup: BackupListing,
  encryptionKey?: string,
): Promise<{ ok: boolean; sha256: string; problems: string[] }> {
  const problems: string[] = [];
  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  let plainHead = Buffer.alloc(0);

  const raw = await storage.getStream(backup.key);
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8)]);
      done(null, chunk);
    },
  });
  const sink = new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (plainHead.length < 8) plainHead = Buffer.concat([plainHead, chunk.subarray(0, 8)]);
      done();
    },
  });

  const encrypted = backup.manifest?.encrypted ?? backup.key.endsWith('.enc');
  const stages: (Readable | Transform)[] = [raw, tap];
  if (encrypted) {
    if (!encryptionKey) {
      return {
        ok: false,
        sha256: '',
        problems: ['Encrypted, and no key is configured to check it.'],
      };
    }
    stages.push(decryptStream(parseKey(encryptionKey)));
  }
  stages.push(sink);

  try {
    await pipeline(stages as unknown as [Readable, ...NodeJS.WritableStream[]]);
  } catch (error) {
    return { ok: false, sha256: '', problems: [(error as Error).message] };
  }

  const sha256 = hash.digest('hex');
  if (encrypted && !isEncrypted(head)) problems.push('Missing the encrypted-object header.');
  if (plainHead.subarray(0, 5).toString('ascii') !== 'PGDMP') {
    problems.push('Decrypted content is not a pg_dump custom-format archive.');
  }
  if (backup.manifest) {
    if (sha256 !== backup.manifest.sha256) problems.push('Checksum does not match the manifest.');
    if (bytes !== backup.manifest.sizeBytes) {
      problems.push(`Size is ${bytes}, manifest says ${backup.manifest.sizeBytes}.`);
    }
  } else {
    problems.push('No manifest to verify against.');
  }

  return { ok: problems.length === 0, sha256, problems };
}
