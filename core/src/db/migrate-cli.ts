/**
 * CLI entrypoint to run migrations against the configured database.
 * Usage: `pnpm --filter @avc/core run db:migrate` (uses DATABASE_URL).
 */
import { createDatabase } from './client.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const handle = createDatabase({ connectionString });
  try {
    await runMigrations(handle.db);
    // eslint-disable-next-line no-console
    console.log('Migrations applied successfully.');
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
