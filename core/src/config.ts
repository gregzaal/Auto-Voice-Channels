import { z } from 'zod';
import { DEFAULT_FLEET, FLEETS } from './domain/fleets.js';

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

export const configSchema = z
  .object({
    /** Discord bot token. Never commit this; supply via env / secrets. */
    discordToken: z
      .string({ required_error: 'DISCORD_TOKEN is required' })
      .min(1, 'DISCORD_TOKEN is required'),
    /** Discord application (client) id, used for slash-command registration. */
    clientId: z.string({ required_error: 'CLIENT_ID is required' }).min(1, 'CLIENT_ID is required'),
    /**
     * Optional dev/test guild id. When set, slash commands are registered to this
     * guild only (they appear instantly, vs. up to ~1h for global). Leave unset in
     * production for global registration.
     */
    devGuildId: z.string().optional(),
    /** Postgres connection string (source of truth). */
    databaseUrl: z
      .string({ required_error: 'DATABASE_URL is required' })
      .min(1, 'DATABASE_URL is required'),

    /**
     * When true, the entitlement gate always allows (no trial/active/expired/billing).
     *
     * Defaults to **true** so a self-hoster never has to set anything to run the
     * full bot. The hosted paid service is the only deployment that runs with
     * entitlement enforced, and it sets `SELF_HOSTED=false` explicitly (see
     * `deploy/fly/fly.toml`). Consequence: the hosted fleet MUST keep that
     * setting, or it fails open (everyone entitled). That is a deliberate
     * trade-off in favour of self-hosters, who are the common case.
     */
    selfHosted: booleanish.default(true),

    /**
     * Which hosted fleet this process belongs to (`plans/fleets.md`).
     *
     * Two live bots share one database: `prod` and `beta`. Everything about the
     * customer is shared between them (entitlement, subscriptions, settings);
     * everything about a bot's own operation is scoped by this value — shard
     * leases, identify buckets, runtime flags, the channels it manages, and the
     * advisory-lock keys it coordinates on.
     *
     * Self-host is always `prod` and never notices any of this: it is the only
     * fleet in its own database, so the scoping is a no-op there.
     *
     * Optional here rather than `.default()` so the refinement below can tell an
     * unset FLEET from an explicit `FLEET=prod`. The default is applied after
     * validation, so callers still see a concrete {@link Fleet}.
     */
    fleet: z.enum(FLEETS).optional(),

    /** Total shard count across all instances. A managed config value. */
    totalShards: z.coerce.number().int().positive().default(1),

    /**
     * Expected number of instances in the fleet. Each instance claims free shards
     * up to `ceil(totalShards / expectedInstances)` (see {@link shardCapFor}), so the
     * shards spread across the fleet instead of the first instance grabbing them all.
     * Self-host leaves this at 1 → one instance claims every shard (unchanged).
     */
    expectedInstances: z.coerce.number().int().positive().default(1),

    /**
     * Stable identifier for this running instance (used for shard leases). MUST be
     * unique per running process — two instances sharing an id corrupt the shard
     * leases (each thinks it owns the other's shards). On Fly this is sourced from
     * the per-machine `FLY_MACHINE_ID`; self-host sets it explicitly; else `local`.
     */
    instanceId: z.string().min(1).default('local'),

    /** HTTP port for the health / diagnostics endpoint. */
    httpPort: z.coerce.number().int().min(0).max(65535).default(8080),

    /** Optional Discord channel id to report significant errors to. */
    adminChannelId: z.string().optional(),

    /**
     * Bearer token guarding `GET /diagnostics`.
     *
     * The endpoint discloses shard and instance topology, every runtime flag,
     * billing job counters, and the AI model plus month-to-date estimated spend.
     * That is fine on a self-host (one operator, usually not even exposed) and
     * not fine on the hosted fleet, so it is **required when `SELF_HOSTED=false`**
     * and optional otherwise. Enforced below, so a hosted instance cannot boot
     * without one rather than failing open.
     */
    diagnosticsToken: z.string().min(16).optional(),

    /**
     * AI-assisted templates (`/templateassistant`) — a single **OpenAI-compatible**
     * `/v1/chat/completions` endpoint, chosen over per-provider adapters so a
     * self-hoster only has to set env vars (`plans/assisted_templates.md` §3).
     *
     * The same three knobs cover OpenAI, OpenRouter, Groq/Together/Fireworks, and
     * a local Ollama / LM Studio / vLLM with no code change. The feature is
     * enabled **iff `aiApiKey` is set** — everything else has a working default,
     * and the whole command simply doesn't appear otherwise.
     */
    aiBaseUrl: z.string().min(1).default('https://api.openai.com/v1'),
    aiApiKey: z.string().min(1).optional(),
    aiModel: z.string().min(1).default('gpt-5.4-mini'),
    /** Per-request timeout for the model call (ms). */
    aiTimeoutMs: z.coerce.number().int().positive().default(30_000),

    /**
     * Provider prices per 1M tokens, used only to turn the tracked token counts
     * into the estimated spend the fleet-wide ceiling is enforced on
     * (`plans/assisted_templates.md` §5.2). Defaults are the §6 `gpt-5.4-mini`
     * list rates; a self-hoster on a local model sets both to `0`.
     */
    aiPriceInputPerMTok: z.coerce.number().nonnegative().default(0.75),
    aiPriceOutputPerMTok: z.coerce.number().nonnegative().default(4.5),

    /** Log level for pino. */
    logLevel: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),

    /** Runtime environment label. */
    nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  })
  .superRefine((cfg, ctx) => {
    // Fail fast rather than fail open: the hosted fleet must never serve an
    // unauthenticated /diagnostics, and the only safe place to catch that is
    // startup. Self-host is exempt, so nothing changes for self-hosters.
    if (!cfg.selfHosted && !cfg.diagnosticsToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['diagnosticsToken'],
        message:
          'DIAGNOSTICS_TOKEN is required when SELF_HOSTED=false (>=16 chars). ' +
          'Generate one with `openssl rand -hex 32` and set it as a Fly secret.',
      });
    }

    /**
     * Same fail-fast reasoning, different blast radius. `fleet` defaults to
     * `prod` so self-host needs no config, but on the hosted side an unset FLEET
     * means the beta bot would quietly claim prod's shard leases and read prod's
     * runtime flags — writing plausible rows into the wrong fleet, which is far
     * harder to notice and to unpick than a boot failure.
     */
    if (!cfg.selfHosted && cfg.fleet === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fleet'],
        message:
          `FLEET is required when SELF_HOSTED=false (one of: ${FLEETS.join(', ')}). ` +
          'Defaulting a hosted instance to prod would let the beta fleet claim ' +
          "production's shard leases and runtime flags.",
      });
    }
  })
  // Applied after validation so the refinement above could distinguish an unset
  // FLEET from an explicit one. Self-host gets `prod` and never thinks about it.
  .transform((cfg) => ({ ...cfg, fleet: cfg.fleet ?? DEFAULT_FLEET }));

export type Config = z.infer<typeof configSchema>;

/**
 * Per-instance shard cap: the most shards one instance will claim, given the total
 * shard count and the expected fleet size. `ceil(total / expected)`, floored at 1.
 * Self-host (`expected = 1`) → the cap is the full total, so it claims every shard.
 */
export function shardCapFor(totalShards: number, expectedInstances: number): number {
  return Math.max(1, Math.ceil(totalShards / Math.max(1, expectedInstances)));
}

/**
 * An env var that was set to the empty string, treated as absent.
 *
 * Every optional key below relies on `.default()` or `.optional()`, and zod only
 * applies either to `undefined`. An empty string is a present value, so it
 * reaches `.min(1)` and fails.
 *
 * That is not a hypothetical. `docker compose up` -- the one self-hosting command
 * the README and the website both advertise -- could not boot: the compose file
 * forwards the optional AI vars as `${AVC_AI_BASE_URL:-}`, which sets them to the
 * empty string when unset, and the process fails fast on three keys the user was
 * told to leave alone. Normalising here rather than per-key fixes the whole class
 * and covers any orchestrator that does the same thing (Fly, k8s, CI).
 *
 * Required keys still fail, and still name the env var: each carries a
 * `required_error` as well as its `.min(1)` message, because normalising a blank
 * to `undefined` otherwise swaps "DISCORD_TOKEN is required" for the useless
 * "discordToken: Required", which names an internal key the user never typed.
 */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Maps process env to the config schema's input shape. */
function envToInput(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const e = new Proxy(env, {
    get: (target, key: string) => blankToUndefined(target[key]),
  }) as NodeJS.ProcessEnv;
  return {
    discordToken: e.DISCORD_TOKEN,
    clientId: e.CLIENT_ID,
    devGuildId: e.DEV_GUILD_ID,
    databaseUrl: e.DATABASE_URL,
    selfHosted: e.SELF_HOSTED,
    fleet: e.FLEET,
    totalShards: e.TOTAL_SHARDS,
    expectedInstances: e.EXPECTED_INSTANCES,
    // Prefer an explicit INSTANCE_ID; on Fly fall back to the per-machine
    // FLY_MACHINE_ID so each machine gets a unique, stable lease identity.
    instanceId: e.INSTANCE_ID ?? e.FLY_MACHINE_ID,
    httpPort: e.HTTP_PORT,
    adminChannelId: e.ADMIN_CHANNEL_ID,
    diagnosticsToken: e.DIAGNOSTICS_TOKEN,
    aiBaseUrl: e.AVC_AI_BASE_URL,
    aiApiKey: e.AVC_AI_API_KEY,
    aiModel: e.AVC_AI_MODEL,
    aiTimeoutMs: e.AVC_AI_TIMEOUT_MS,
    aiPriceInputPerMTok: e.AVC_AI_PRICE_INPUT_PER_MTOK,
    aiPriceOutputPerMTok: e.AVC_AI_PRICE_OUTPUT_PER_MTOK,
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
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
