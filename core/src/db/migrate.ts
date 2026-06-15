import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the generated SQL migrations folder.
 *
 * At runtime this file lives in `dist/db/`, and migrations are emitted to
 * `core/drizzle` at the package root, i.e. two levels up from `dist/db`.
 */
export const MIGRATIONS_FOLDER = resolve(here, '..', '..', 'drizzle');

/**
 * Applies all pending migrations. Run automatically on boot. Idempotent: a
 * migration already applied is skipped.
 */
export async function runMigrations(
  db: Database,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
