/**
 * Backup CLI (`plans/backups.md` §10). The same code path the scheduler calls,
 * so there is one implementation and two callers.
 *
 *   backup:run
 *   backup:list
 *   backup:verify [--at <ISO|key>]
 *   backup:restore [--at <ISO|key>] [--to <DATABASE_URL>] [--force]
 *
 * Reads configuration from the environment through `loadConfig`, so it behaves
 * identically to the running bot and cannot drift from it.
 */
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { BackupStorage } from './storage.js';
import { runBackup } from './runBackup.js';
import { listBackups, restoreBackup, selectBackup, verifyBackup } from './restore.js';

/* eslint-disable no-console */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function requireBackupConfig(): NonNullable<ReturnType<typeof loadConfig>['backup']> {
  const config = loadConfig();
  if (!config.backup) {
    throw new Error(
      'Backups are not configured. Set BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET, ' +
        'BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY. See .env.example.',
    );
  }
  return config.backup;
}

/** Counts tables in the target's public schema, the "is this empty" guard. */
async function countTables(databaseUrl: string): Promise<number> {
  const handle = createDatabase({ connectionString: databaseUrl });
  try {
    const res = await handle.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    return Number(res.rows[0]?.n ?? 0);
  } finally {
    await handle.close();
  }
}

/** Row counts and versions for the manifest. Best-effort by design: a probe
 * failure must never stop a backup from being taken. */
async function probe(databaseUrl: string): Promise<{
  pgServerVersion: string | null;
  migrationVersion: string | null;
  rowCounts: Record<string, number>;
}> {
  const handle = createDatabase({ connectionString: databaseUrl });
  try {
    const version = await handle.db
      .execute<{ v: string }>(sql`SHOW server_version`)
      .then((r) => r.rows[0]?.v ?? null)
      .catch(() => null);

    const migrationVersion = await handle.db
      .execute<{ h: string }>(
        sql`SELECT hash AS h FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
      )
      .then((r) => r.rows[0]?.h ?? null)
      .catch(() => null);

    const rowCounts: Record<string, number> = {};
    for (const table of ['guilds', 'auto_channels', 'secondary_channels', 'subscriptions']) {
      try {
        const res = await handle.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`,
        );
        rowCounts[table] = Number(res.rows[0]?.n ?? 0);
      } catch {
        // A table that does not exist yet is not an error worth failing over.
      }
    }
    return { pgServerVersion: version, migrationVersion, rowCounts };
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig();
  const backupConfig = requireBackupConfig();
  const storage = new BackupStorage(backupConfig);
  const prefix = backupConfig.prefix ?? config.nodeEnv;
  const env = config.nodeEnv;

  try {
    switch (command) {
      case 'run': {
        const result = await runBackup({
          databaseUrl: config.databaseUrl,
          storage,
          prefix,
          env,
          retention: backupConfig.retention,
          encryptionKey: backupConfig.encryptionKey,
          instanceId: config.instanceId ?? 'cli',
          appVersion: process.env.APP_VERSION ?? '0.0.0',
          commit: process.env.GIT_COMMIT ?? 'dev',
          probe: () => probe(config.databaseUrl),
          log: (event, data) => console.log(event, JSON.stringify(data)),
        });
        console.log(`\nBacked up to ${result.key}`);
        console.log(`  ${result.manifest.sizeBytes} bytes, sha256 ${result.manifest.sha256}`);
        console.log(`  took ${Math.round(result.durationMs / 1000)}s`);
        if (result.pruned.length) console.log(`  pruned ${result.pruned.length} old objects`);
        if (result.prunedFailed.length) {
          console.log(`  WARNING: ${result.prunedFailed.length} objects could not be pruned`);
        }
        break;
      }

      case 'list': {
        const listing = await listBackups(storage, prefix, env);
        if (listing.length === 0) {
          console.log('No backups found.');
          break;
        }
        console.log(`${listing.length} backup(s), newest first:\n`);
        for (const b of listing) {
          const mb = (b.sizeBytes / 1024 / 1024).toFixed(1);
          const mv = b.manifest?.migrationVersion ?? '(no manifest)';
          console.log(`  ${b.createdAt.toISOString()}  ${mb.padStart(8)} MB  ${mv}`);
          console.log(`      ${b.key}`);
        }
        break;
      }

      case 'verify': {
        const chosen = selectBackup(await listBackups(storage, prefix, env), arg('at'));
        const result = await verifyBackup(storage, chosen, backupConfig.encryptionKey);
        console.log(`${chosen.key}\n  sha256 ${result.sha256}`);
        if (result.ok) {
          console.log('  OK: checksum matches and it decrypts to a pg_dump archive.');
        } else {
          for (const p of result.problems) console.log(`  PROBLEM: ${p}`);
          process.exitCode = 1;
        }
        break;
      }

      case 'restore': {
        const target = arg('to') ?? config.databaseUrl;
        const chosen = selectBackup(await listBackups(storage, prefix, env), arg('at'));
        console.log(`Restoring ${chosen.key}`);
        console.log(`  taken ${chosen.createdAt.toISOString()}`);
        console.log(`  into  ${target.replace(/:\/\/[^@]*@/, '://***@')}\n`);
        const result = await restoreBackup({
          storage,
          backup: chosen,
          targetDatabaseUrl: target,
          encryptionKey: backupConfig.encryptionKey,
          force: flag('force'),
          countTables,
          log: (event, data) => console.log(event, JSON.stringify(data)),
        });
        console.log(`\nRestored ${result.bytes} bytes.`);
        console.log(
          result.sha256Matched === true
            ? '  Checksum matched the manifest.'
            : '  Checksum NOT verified.',
        );
        for (const w of result.warnings) console.log(`  WARNING: ${w}`);
        console.log('\nRun migrations next if the app version is newer than the dump.');
        break;
      }

      default:
        console.log(
          'Usage:\n' +
            '  backup run\n' +
            '  backup list\n' +
            '  backup verify  [--at <ISO|key>]\n' +
            '  backup restore [--at <ISO|key>] [--to <DATABASE_URL>] [--force]',
        );
        process.exitCode = command ? 1 : 0;
    }
  } finally {
    storage.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
