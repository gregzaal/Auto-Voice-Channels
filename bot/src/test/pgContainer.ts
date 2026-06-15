import { createDatabase, runMigrations, type DbHandle } from '@avc/core';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export interface PgTestEnv {
  handle: DbHandle;
  container: StartedTestContainer;
  connectionString: string;
  stop: () => Promise<void>;
}

/**
 * Spins up a real, ephemeral Postgres (Testcontainers), applies all migrations,
 * and returns a Drizzle handle. Mirrors the core test helper so bot-side
 * integration tests can exercise the real persistence layer. Requires Docker.
 */
export async function startPostgres(): Promise<PgTestEnv> {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: 'avc',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgres://postgres:postgres@${host}:${port}/avc`;

  const handle = createDatabase({ connectionString });
  await runMigrations(handle.db);

  return {
    handle,
    container,
    connectionString,
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}
