import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['{core,bot}/**/*.unit.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['{core,bot}/**/*.integration.test.ts'],
      environment: 'node',
      // Integration tests spin up real Postgres via Testcontainers; allow generous timeouts.
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);
