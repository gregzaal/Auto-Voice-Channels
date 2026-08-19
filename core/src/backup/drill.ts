import { spawn } from 'node:child_process';
import { sql } from 'drizzle-orm';
import type { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDatabase } from '../db/client.js';
import { decryptStream, parseKey } from './encryption.js';
import { pgEnvFromUrl } from './runBackup.js';
import {
  listBackups,
  restoreBackup,
  selectBackup,
  verifyBackup,
  type BackupListing,
} from './restore.js';
import type { BackupStorage } from './storage.js';

/**
 * The restore drill (`plans/backups.md` §9.2).
 *
 * "The upload succeeded" is not evidence that anything can be recovered. The
 * drill answers the only question that matters: if the database vanished right
 * now, would the newest object in the bucket bring it back.
 *
 * **Two levels, because one of them has to work everywhere.**
 *
 * The *archive* drill needs nothing but the bucket: it re-downloads the newest
 * backup, checks the stored bytes still hash to what the manifest recorded,
 * decrypts them with the key this deployment actually holds, and makes
 * `pg_restore` parse the archive's table of contents and name the tables inside
 * it. That covers the failure modes storage actually has, and the ones a backup
 * system hides best: bit rot, a truncated upload, a rotated encryption key
 * nobody noticed, a bucket lifecycle rule quietly deleting objects.
 *
 * **The two steps do not overlap as much as they look.** A custom-format
 * archive keeps its table of contents at the front, so `pg_restore --list`
 * reports a complete, clean TOC and exits 0 for an archive truncated to 40KB of
 * 1.6MB (measured, not assumed). It proves the header and the catalogue are
 * intact and says nothing whatever about the body. Truncation and rot are
 * caught by step 1's checksum alone, and the TOC parse earns its place by
 * catching a *structurally* wrong archive and by naming the tables. Neither
 * step is redundant, and neither substitutes for the other.
 *
 * The *restore* drill additionally loads the dump into a scratch database and
 * compares row counts against the manifest. It runs only when the operator
 * points `BACKUP_DRILL_DATABASE_URL` at somewhere safe, because the plan's
 * original "create a scratch database on the same server" is not available on a
 * managed Postgres behind a transaction pooler, and doubling the primary's
 * storage every week is not a thing to do by default.
 *
 * The half we give up by defaulting to archive-level is smaller than it looks:
 * CI already restores a real dump into a real second database on every commit
 * (`restore.integration.test.ts`). What CI cannot check is the object sitting in
 * the production bucket, which is exactly what this checks.
 */

/** Tables whose absence means the dump is not what we think it is. */
const FALLBACK_EXPECTED_TABLES = ['guilds', 'auto_channels', 'secondary_channels'] as const;

export interface DrillOptions {
  storage: BackupStorage;
  prefix: string;
  env: string;
  encryptionKey?: string | undefined;
  /**
   * A database the drill may restore into and then wipe. Absent means
   * archive-level only.
   */
  scratchDatabaseUrl?: string | undefined;
  /** The live database, so the drill can refuse to point at it. */
  liveDatabaseUrl?: string | undefined;
  /** Flags a backup older than this as a problem. Defaults to 1.5 days;
   * `Infinity` disables the check, for when backups are deliberately off. */
  maxAgeHours?: number;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface DrillResult {
  ok: boolean;
  key: string | null;
  takenAt: string | null;
  ageHours: number | null;
  sizeBytes: number | null;
  checksumOk: boolean | null;
  tocEntries: number | null;
  tablesInArchive: string[];
  restored: boolean;
  rowCounts: Record<string, { manifest: number; restored: number }>;
  problems: string[];
  notes: string[];
  durationMs: number;
}

/**
 * `pg_restore --list` output to the objects it names.
 *
 * Pure, so the parsing is tested against real `pg_restore` output rather than
 * inferred from a live run. Two entry kinds share the `TABLE` prefix and must
 * not be conflated: `TABLE` is the definition, `TABLE DATA` is its contents.
 * A naive `/TABLE (\S+) (\S+)/` reads the second as schema `DATA`, table
 * `public`, and reports a dump full of tables named `public`.
 */
export function parseRestoreToc(text: string): {
  entries: number;
  tables: string[];
  withData: string[];
} {
  const tables = new Set<string>();
  const withData = new Set<string>();
  let entries = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // `;` opens a comment: the header block, and the section banners.
    if (!trimmed || trimmed.startsWith(';')) continue;
    entries++;
    const match = /^\d+;\s+\d+\s+\d+\s+(TABLE DATA|TABLE)\s+(\S+)\s+(\S+)/.exec(trimmed);
    if (!match) continue;
    (match[1] === 'TABLE' ? tables : withData).add(match[3]!);
  }

  return {
    entries,
    tables: [...tables].sort(),
    withData: [...withData].sort(),
  };
}

/**
 * Streams an object through `pg_restore --list` and returns its table of contents.
 *
 * **Early exit is expected, not an error.** A custom-format archive keeps its
 * TOC at the front, so `pg_restore --list` reading from a pipe stops as soon as
 * it has what it came for and leaves us writing into a closed stdin. `EPIPE`
 * here means it worked. Treating it as a failure would make the drill fail on
 * every healthy backup above a few megabytes, which is the size at which a
 * backup starts to matter.
 */
async function readToc(
  body: Readable,
  encryptionKey: string | undefined,
  encrypted: boolean,
): Promise<{ entries: number; tables: string[]; withData: string[] }> {
  /**
   * Everything that can throw happens before the spawn.
   *
   * `parseKey` rejects a malformed key, and a missing one is refused outright.
   * Both used to throw *after* the child existed, leaving a `pg_restore`
   * blocked forever on a stdin whose write end this process still held: a
   * ref'd handle that keeps the event loop alive, plus an S3 response socket
   * never returned to the agent. It leaked exactly when the key had been
   * rotated or mistyped, which is one of the failures the drill exists to
   * catch, so it would have leaked weekly in the configuration where the drill
   * was doing its job.
   */
  const decrypt = encrypted ? decryptStream(parseKey(requireKey(encryptionKey))) : undefined;

  const child = spawn('pg_restore', ['--list'], { stdio: ['pipe', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    if (stdout.length < 262_144) stdout += d;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => {
    if (stderr.length < 8192) stderr += d;
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (e) =>
      reject(
        new Error(
          `Could not run pg_restore: ${e.message}. The image must include postgresql-client.`,
        ),
      ),
    );
    child.on('close', (code) => resolve(code ?? 0));
  });

  const stages: (Readable | Transform)[] = decrypt ? [body, decrypt] : [body];

  const fed = pipeline([...stages, child.stdin] as unknown as [
    Readable,
    ...NodeJS.WritableStream[],
  ]).catch((error: NodeJS.ErrnoException) => {
    // See above: pg_restore closing stdin early is the normal path.
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    throw error;
  });

  const [, code] = await Promise.all([fed, exited]);
  /**
   * A non-zero exit is a failure even when a table of contents was printed.
   *
   * An archive that parses far enough to emit part of its TOC and then errors
   * exits non-zero with non-empty stdout. Adopting that partial list would let
   * the drill pass or fail on whether the truncation happened to fall after the
   * last table the manifest names, which is not a check, it is a coin flip. The
   * whole job of this step is noticing a bad archive.
   */
  if (code !== 0) {
    throw new Error(`pg_restore --list exited ${code}: ${stderr.trim() || '(no stderr)'}`);
  }
  return parseRestoreToc(stdout);
}

function requireKey(key: string | undefined): string {
  if (!key) throw new Error('The backup is encrypted and no key is configured to read it.');
  return key;
}

/** Host, port and database, so two spellings of one database compare equal. */
function dbIdentity(url: string): string {
  const env = pgEnvFromUrl(url);
  return `${env.PGHOST}:${env.PGPORT ?? '5432'}/${env.PGDATABASE}`;
}

export async function runDrill(opts: DrillOptions): Promise<DrillResult> {
  const now = opts.now ?? ((): Date => new Date());
  const log = opts.log ?? ((): void => {});
  const startedAt = Date.now();
  const problems: string[] = [];
  const notes: string[] = [];

  const result: DrillResult = {
    ok: false,
    key: null,
    takenAt: null,
    ageHours: null,
    sizeBytes: null,
    checksumOk: null,
    tocEntries: null,
    tablesInArchive: [],
    restored: false,
    rowCounts: {},
    problems,
    notes,
    durationMs: 0,
  };

  const listing = await listBackups(opts.storage, opts.prefix, opts.env);
  // A drill checks scheduled backups. Restoring the artifact of a previous
  // drill would be the system marking its own homework.
  const scheduled = listing.filter((b) => b.manifest?.drill !== true);
  if (scheduled.length === 0) {
    problems.push('No backups found to drill against.');
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const backup = selectBackup(scheduled);
  result.key = backup.key;
  result.takenAt = backup.createdAt.toISOString();
  result.sizeBytes = backup.sizeBytes;
  const ageHours = (now().getTime() - backup.createdAt.getTime()) / 3_600_000;
  result.ageHours = Math.round(ageHours * 10) / 10;

  const maxAgeHours = opts.maxAgeHours ?? 36;
  if (ageHours > maxAgeHours) {
    problems.push(
      `The newest backup is ${result.ageHours}h old, past the ${maxAgeHours}h threshold.`,
    );
  }
  if (!backup.manifest) {
    problems.push('The newest backup has no manifest, so nothing can be verified against it.');
  }

  log('drill.start', { key: backup.key, ageHours: result.ageHours });

  // 1. The stored bytes still hash to what was uploaded, and decrypt.
  const verified = await verifyBackup(opts.storage, backup, opts.encryptionKey);
  result.checksumOk = verified.ok;
  for (const problem of verified.problems) problems.push(problem);

  // 2. The archive is structurally intact and holds the tables it should.
  try {
    const encrypted = backup.manifest?.encrypted ?? backup.key.endsWith('.enc');
    const toc = await readToc(
      await opts.storage.getStream(backup.key),
      opts.encryptionKey,
      encrypted,
    );
    result.tocEntries = toc.entries;
    result.tablesInArchive = toc.tables;

    // The manifest names the tables the backup itself counted, so this tracks
    // the schema without a second list to keep in sync.
    const expected = backup.manifest
      ? Object.keys(backup.manifest.rowCounts)
      : [...FALLBACK_EXPECTED_TABLES];
    const missing = expected.filter((t) => !toc.tables.includes(t));
    if (missing.length > 0) {
      problems.push(`Tables missing from the archive: ${missing.join(', ')}.`);
    }
    if (toc.entries === 0) {
      problems.push('The archive lists no objects at all.');
    }
  } catch (error) {
    problems.push(`Could not read the archive's table of contents: ${(error as Error).message}`);
  }

  // 3. Optional: the dump actually loads, and brings the rows with it.
  if (opts.scratchDatabaseUrl && !opts.liveDatabaseUrl) {
    // Refuse rather than quietly running with one of two guards. `runDrill` is
    // exported, so a future caller can reach this without the scheduler's
    // wiring, and "the safety check was skipped because you did not pass the
    // thing it compares against" is not a failure mode worth having.
    problems.push(
      'A drill database was configured with no live database to compare it against. ' +
        'Refusing to restore.',
    );
  } else if (opts.scratchDatabaseUrl) {
    await drillRestore(opts, backup, result, problems, notes, log);
  } else {
    notes.push(
      'Archive-level drill only. Set BACKUP_DRILL_DATABASE_URL to a scratch database ' +
        'to also restore the dump and compare row counts.',
    );
  }

  result.ok = problems.length === 0;
  result.durationMs = Date.now() - startedAt;
  log('drill.done', { key: backup.key, ok: result.ok, problems: problems.length });
  return result;
}

/**
 * The scratch-database half.
 *
 * This restores with `force` over `--clean --if-exists`, which is "drop what is
 * here and replace it". A misconfigured `BACKUP_DRILL_DATABASE_URL` pointing at
 * the live database would be a weekly scheduled outage wearing a health check's
 * clothes, so it is guarded twice.
 *
 * **The guard that does the work is the marker table, not the URL comparison.**
 * Comparing connection strings is guesswork: `localhost` and `127.0.0.1` are the
 * same server spelled differently, a pooler hides the host entirely, and two
 * genuinely separate databases very often share a name (ours are both `avc`,
 * which is what broke the first version of this). So the URL check only catches
 * the exact-match case, and the real invariant is positive rather than negative:
 * **this database must be empty, or must be one a previous drill used.** Live is
 * never empty and never carries the marker, so it cannot pass.
 *
 * The marker is written *before* the restore, not after, so a drill that dies
 * between restoring and wiping leaves a database the next drill can still
 * recognise. Written after, a single crash would wedge every future run.
 */
const MARKER_TABLE = 'avc_drill_scratch';
async function drillRestore(
  opts: DrillOptions,
  backup: BackupListing,
  result: DrillResult,
  problems: string[],
  notes: string[],
  log: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const scratch = opts.scratchDatabaseUrl!;

  if (opts.liveDatabaseUrl && dbIdentity(scratch) === dbIdentity(opts.liveDatabaseUrl)) {
    problems.push(
      'BACKUP_DRILL_DATABASE_URL points at the live database. Refusing to restore over it.',
    );
    return;
  }

  const handle = createDatabase({ connectionString: scratch });
  try {
    /**
     * `pg_tables`, not `information_schema.tables`.
     *
     * The information schema is privilege-filtered: a role with no privileges
     * on a populated database reads zero tables there and would sail through
     * the emptiness check into a restore. `pg_tables` reports the catalogue
     * regardless of what this role may read, which is the question being asked.
     */
    const inventory = await handle.db.execute<{ tables: string; marked: boolean }>(sql`
      SELECT
        count(*)::text AS tables,
        coalesce(bool_or(tablename = ${MARKER_TABLE}), false) AS marked
      FROM pg_tables
      WHERE schemaname = 'public'
    `);
    const tables = Number(inventory.rows[0]?.tables ?? 0);
    const marked = inventory.rows[0]?.marked === true;

    if (tables > 0 && !marked) {
      problems.push(
        `The drill database already holds ${tables} tables and was not left by a drill. ` +
          'Refusing to overwrite it. Point BACKUP_DRILL_DATABASE_URL at an empty database.',
      );
      return;
    }

    // Claims the database before anything destructive happens.
    await handle.db.execute(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(MARKER_TABLE)} (claimed_at timestamptz NOT NULL DEFAULT now())`,
    );

    const restored = await restoreBackup({
      storage: opts.storage,
      backup,
      targetDatabaseUrl: scratch,
      encryptionKey: opts.encryptionKey,
      // The previous drill left its tables behind; that is what a scratch
      // database is for.
      force: true,
      countTables: async () => 0,
      log,
    });
    result.restored = true;
    for (const warning of restored.warnings) notes.push(warning);

    // Row counts, against what the manifest recorded.
    //
    // The manifest is probed *after* the dump finishes, so live writes in that
    // window make it legitimately higher than the restored count. Tolerance is
    // one-sided and generous: fewer rows than expected by a wide margin means a
    // partial restore, more rows than the manifest means something is wrong
    // with the drill itself.
    for (const [table, expected] of Object.entries(backup.manifest?.rowCounts ?? {})) {
      let actual: number;
      try {
        const res = await handle.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`,
        );
        actual = Number(res.rows[0]?.n ?? 0);
      } catch (error) {
        problems.push(`Restored database has no readable "${table}": ${(error as Error).message}`);
        continue;
      }
      result.rowCounts[table] = { manifest: expected, restored: actual };
      const tolerance = Math.max(5, Math.ceil(expected * 0.05));
      if (actual < expected - tolerance || actual > expected) {
        problems.push(`Table "${table}" restored ${actual} rows, manifest recorded ${expected}.`);
      }
    }

    /**
     * Wipe the scratch database again.
     *
     * A drill that leaves a full copy of production sitting in a second
     * database has quietly created a second thing to secure, and nobody is
     * watching that one. Dropping the schema also needs no CREATE DATABASE
     * right, which the plan's original "drop the scratch DB" would have.
     */
    await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await handle.db.execute(sql`CREATE SCHEMA public`);
  } catch (error) {
    problems.push(`Restore into the scratch database failed: ${(error as Error).message}`);
  } finally {
    await handle.close().catch(() => {});
  }
}
