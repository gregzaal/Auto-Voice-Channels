import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/avc',
  },
  // Strict + verbose: we review every generated migration for expand/contract safety.
  strict: true,
  verbose: true,
});
