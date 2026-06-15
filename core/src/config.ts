import { z } from 'zod';

/**
 * Application configuration, validated with zod at startup. The process should
 * fail fast on invalid/missing config (see {@link loadConfig}).
 *
 * One codebase, config-driven: the scaled hosted service and a self-hosted
 * instance differ only by the values here.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

export const configSchema = z.object({
  /** Discord bot token. Never commit this; supply via env / secrets. */
  discordToken: z.string().min(1, 'DISCORD_TOKEN is required'),
  /** Discord application (client) id, used for slash-command registration. */
  clientId: z.string().min(1, 'CLIENT_ID is required'),
  /**
   * Optional dev/test guild id. When set, slash commands are registered to this
   * guild only (they appear instantly, vs. up to ~1h for global). Leave unset in
   * production for global registration.
   */
  devGuildId: z.string().optional(),
  /** Postgres connection string (source of truth). */
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),

  /** When true, the entitlement gate always allows (no trial/active/expired/billing). */
  selfHosted: booleanish.default(false),

  /** Total shard count across all instances. A managed config value. */
  totalShards: z.coerce.number().int().positive().default(1),

  /**
   * Expected number of instances in the fleet. Each instance claims free shards
   * up to `ceil(totalShards / expectedInstances)` (see {@link shardCapFor}), so the
   * shards spread across the fleet instead of the first instance grabbing them all.
   * Self-host leaves this at 1 → one instance claims every shard (unchanged).
   */
  expectedInstances: z.coerce.number().int().positive().default(1),

  /** Stable identifier for this running instance (used for shard leases). */
  instanceId: z.string().min(1).default('local'),

  /** HTTP port for the health / diagnostics endpoint. */
  httpPort: z.coerce.number().int().min(0).max(65535).default(8080),

  /** Optional Discord channel id to report significant errors to. */
  adminChannelId: z.string().optional(),

  /** Log level for pino. */
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

  /** Runtime environment label. */
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Per-instance shard cap: the most shards one instance will claim, given the total
 * shard count and the expected fleet size. `ceil(total / expected)`, floored at 1.
 * Self-host (`expected = 1`) → the cap is the full total, so it claims every shard.
 */
export function shardCapFor(totalShards: number, expectedInstances: number): number {
  return Math.max(1, Math.ceil(totalShards / Math.max(1, expectedInstances)));
}

/** Maps process env to the config schema's input shape. */
function envToInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    discordToken: env.DISCORD_TOKEN,
    clientId: env.CLIENT_ID,
    devGuildId: env.DEV_GUILD_ID,
    databaseUrl: env.DATABASE_URL,
    selfHosted: env.SELF_HOSTED,
    totalShards: env.TOTAL_SHARDS,
    expectedInstances: env.EXPECTED_INSTANCES,
    instanceId: env.INSTANCE_ID,
    httpPort: env.HTTP_PORT,
    adminChannelId: env.ADMIN_CHANNEL_ID,
    logLevel: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
  };
}

export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Loads and validates configuration from the given environment (defaults to
 * `process.env`). Throws {@link ConfigError} with all issues on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(envToInput(env));
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  return result.data;
}
