/**
 * Backup CLI (`plans/backups.md` §10). The same code path the scheduler calls,
 * so there is one implementation and two callers.
 *
 *   backup:run
 *   backup:list
 *   backup:verify [--at <ISO|key>]
 *   backup:drill  [--scratch <DATABASE_URL>]
 *   backup:restore [--at <ISO|key>] [--to <DATABASE_URL>] [--force]
 *
 * Reads configuration from the environment through `loadConfig`, so it behaves
 * identically to the running bot and cannot drift from it.
 */
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { BackupStorage } from './storage.js';
import { probeForManifest, runBackup } from './runBackup.js';
import { listBackups, restoreBackup, selectBackup, verifyBackup } from './restore.js';
import { runDrill } from './drill.js';

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
          probe: async () => {
            const handle = createDatabase({ connectionString: config.databaseUrl });
            try {
              return await probeForManifest(handle.db);
            } finally {
              await handle.close();
            }
          },
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

      case 'drill': {
        const result = await runDrill({
          storage,
          prefix,
          env,
          encryptionKey: backupConfig.encryptionKey,
          scratchDatabaseUrl: arg('scratch') ?? backupConfig.drillDatabaseUrl,
          liveDatabaseUrl: config.databaseUrl,
          log: (event, data) => console.log(event, JSON.stringify(data)),
        });
        console.log(`\n${result.key ?? '(no backup)'}`);
        if (result.key) {
          console.log(`  taken ${result.takenAt} (${result.ageHours}h ago)`);
          // `null` means nothing was checked, which under pressure must not
          // read as "the checksum failed".
          console.log(
            `  checksum ${result.checksumOk === null ? 'not checked' : result.checksumOk ? 'matches' : 'DOES NOT MATCH'}`,
          );
          console.log(`  archive lists ${result.tocEntries ?? 0} objects`);
          console.log(`  tables: ${result.tablesInArchive.join(', ') || '(none)'}`);
        }
        if (result.restored) {
          console.log('  restored into the scratch database:');
          for (const [table, counts] of Object.entries(result.rowCounts)) {
            console.log(`    ${table}: ${counts.restored} rows (manifest ${counts.manifest})`);
          }
        }
        for (const note of result.notes) console.log(`  NOTE: ${note}`);
        for (const problem of result.problems) console.log(`  PROBLEM: ${problem}`);
        console.log(result.ok ? '\nDRILL PASSED' : '\nDRILL FAILED');
        if (!result.ok) process.exitCode = 1;
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
            '  backup drill   [--scratch <DATABASE_URL>]\n' +
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
