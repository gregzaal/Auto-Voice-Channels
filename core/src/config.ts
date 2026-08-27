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

/**
 * A Discord snowflake, as a string. Validated rather than taken on trust
 * because every consumer of one is a REST call: a typo'd role id is a 404 from
 * Discord at write time, per member, forever, instead of a boot failure naming
 * the variable.
 */
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake (17-20 digits)');

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
     * Dead-man's switch. The in-process watcher POSTs here on every healthy
     * tick, and something outside notices when the POSTs stop.
     *
     * Optional and unset by default, so nothing changes for a self-hoster who
     * does not want it -- but it is the one piece of down-detection a
     * self-hoster can have at all. Everything else in this system is pull-based
     * and needs an observer we do not run for them. A push to any free
     * heartbeat service costs us nothing and gives them the signal that matters
     * most: the bot stopped.
     *
     * https over the public internet, so a health signal is not a plaintext
     * beacon announcing the deployment exists. **`http://` is allowed to a
     * loopback or private address**, because the self-hoster running
     * uptime-kuma on their own LAN is exactly who this option is for, and
     * config is fail-fast: refusing that URL does not warn them, it stops the
     * bot from booting at all.
     */
    watchdogPingUrl: z
      .string()
      .url()
      .refine(isSafePingUrl, {
        message:
          'WATCHDOG_PING_URL must use https, or http to a loopback or private address ' +
          '(localhost, 10.x, 172.16-31.x, 192.168.x, or a .local/.internal host).',
      })
      .optional(),

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
     * top.gg API token for the listing publisher (server count + command list).
     *
     * Optional, and its presence is the whole switch: unset means the publisher
     * is never constructed, which is the correct state for self-host and for
     * any fleet that is not the one behind the public listing.
     *
     * **Set this on exactly one fleet.** `@me` resolves the project from the
     * token and the count is read from this fleet's `guild_fleet_presence`
     * rows, so the same secret on beta would publish beta's guild count to the
     * production listing. No validation can catch that: the token is valid and
     * the count is real.
     */
    topggToken: z.string().min(1).optional(),

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

    /**
     * Data backups (`plans/backups.md`), optional and **all-or-nothing**.
     *
     * Absent unless every required S3 field is present; partial config fails
     * fast in the superRefine below rather than silently running unprotected,
     * which is the failure mode that matters here (you find out at restore
     * time). `config.backup !== undefined` is the enabled flag the rest of the
     * code reads.
     *
     * Provider-agnostic on purpose: one S3 API covers Backblaze B2, Cloudflare
     * R2, AWS S3 and MinIO, so a self-hoster picks a provider rather than
     * waiting for an adapter.
     */
    backup: z
      .object({
        endpoint: z.string().url(),
        region: z.string().min(1),
        bucket: z.string().min(1),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
        /**
         * 32 bytes, base64 or hex. Optional, and strongly recommended: without
         * it the storage provider can read every guild setting and billing row
         * in the dump. **Losing it loses the backups** — there is no recovery
         * path and the loss only surfaces during a restore.
         */
        encryptionKey: z.string().min(1).optional(),
        intervalHours: z.coerce.number().int().positive().default(24),
        preferredHourUtc: z.coerce.number().int().min(0).max(23).default(3),
        retention: z.object({
          daily: z.coerce.number().int().nonnegative().default(7),
          weekly: z.coerce.number().int().nonnegative().default(4),
          monthly: z.coerce.number().int().nonnegative().default(6),
        }),
        /** Object-key namespace, so one bucket can hold unrelated backup sets. */
        prefix: z.string().optional(),
        /** How often the restore drill runs. Weekly (`plans/backups.md` §9). */
        drillIntervalHours: z.coerce.number().int().positive().default(168),
        /**
         * A scratch database the drill may restore into and then wipe.
         *
         * Optional, and unset is the sane default: without it the drill still
         * re-downloads, decrypts, checksums and parses the archive, which is
         * what catches storage-side rot. With it, the drill also proves the
         * dump loads. Never point this at the live database. The drill checks
         * that you have not, and refuses, but a check is not a reason to try.
         */
        drillDatabaseUrl: z.string().min(1).optional(),
      })
      .optional(),

    /**
     * Supporter roles in the support guild, optional and hosted-only in
     * practice (`plans/monetization.md` §13).
     *
     * Recognition, not entitlement: nothing anywhere reads a supporter role to
     * decide what a guild may do, and it must stay that way. Every feature is
     * on every plan, so the moment a role gates something the pricing promise
     * is gone.
     *
     * Absent unless `SUPPORT_GUILD_ID` and at least one `SUPPORT_ROLE_*` are
     * set, so a self-hoster never meets it. All-or-nothing by *shape* like the
     * backup group: a half-set group fails to boot rather than badging nobody
     * and saying nothing about why.
     */
    supporterRoles: z
      .object({
        guildId: snowflake,
        /**
         * Billed tier -> role id, and partial on purpose: an unmapped tier is
         * simply not badged, which is what lets the set of badged tiers change
         * without a migration or a code edit.
         *
         * `free` has no entry by construction. It is not a purchase, and a
         * "supporter" role on it would be the one badge that means nothing.
         */
        byTier: z
          .object({
            s: snowflake.optional(),
            m: snowflake.optional(),
            l: snowflake.optional(),
            xl: snowflake.optional(),
            xxl: snowflake.optional(),
          })
          .refine((r) => Object.values(r).some((id) => id !== undefined), {
            message:
              'SUPPORT_GUILD_ID is set but no SUPPORT_ROLE_<TIER> is. Set at least one of ' +
              'SUPPORT_ROLE_S / _M / _L / _XL / _XXL, or unset SUPPORT_GUILD_ID.',
          }),
        /**
         * Delay between role writes during a full reconcile.
         *
         * The steady state is a handful of changes a day arriving one NOTIFY at
         * a time, where this never applies. It exists for the other case: a
         * reconcile after a long gap has thousands of changes queued at once,
         * all against one guild's role rate limit, and an unpaced burst would
         * park every other REST call in the fleet behind it.
         */
        writeSpacingMs: z.coerce.number().int().nonnegative().default(250),
        /** How often the safety-net reconcile runs. Daily; the events do the real work. */
        reconcileIntervalHours: z.coerce.number().int().positive().default(24),
      })
      .optional(),

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
     * Same reasoning again, and this one was learned the hard way. The beta
     * fleet ran for weeks with ADMIN_CHANNEL_ID unset, so `ErrorReporter` was
     * `NullErrorReporter` and every report call site was a no-op -- with
     * nothing anywhere saying so. A hosted fleet must not be able to boot with
     * alerting silently switched off. Self-host stays exempt: a self-hoster who
     * does not want Discord alerts should not be forced to configure one.
     */
    if (!cfg.selfHosted && !cfg.adminChannelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adminChannelId'],
        message:
          'ADMIN_CHANNEL_ID is required when SELF_HOSTED=false. Without it every operational ' +
          'alert is silently discarded. Set it to a private text channel the bot can post in.',
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

/**
 * Whether a watchdog ping URL is safe to send over.
 *
 * https anywhere, or http only to somewhere that cannot leave the operator's
 * own network. The point is not to protect a secret (the URL is the secret, and
 * it is in their env either way) but to avoid announcing over the open internet,
 * in cleartext, that this deployment exists and is currently healthy.
 */
function isSafePingUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IPv6 loopback and unique-local (fc00::/7), which is what a private v6
  // network uses.
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

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
    watchdogPingUrl: e.WATCHDOG_PING_URL,
    diagnosticsToken: e.DIAGNOSTICS_TOKEN,
    topggToken: e.TOPGG_TOKEN,
    aiBaseUrl: e.AVC_AI_BASE_URL,
    aiApiKey: e.AVC_AI_API_KEY,
    aiModel: e.AVC_AI_MODEL,
    aiTimeoutMs: e.AVC_AI_TIMEOUT_MS,
    aiPriceInputPerMTok: e.AVC_AI_PRICE_INPUT_PER_MTOK,
    aiPriceOutputPerMTok: e.AVC_AI_PRICE_OUTPUT_PER_MTOK,
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
    backup: backupInput(e),
    supporterRoles: supporterRolesInput(e),
  };
}

/**
 * The supporter-role group, or `undefined` when nobody has configured one.
 *
 * Same shape-driven all-or-nothing as {@link backupInput}: if any key is set we
 * hand zod a partial object and let its own required fields name the missing
 * one. A typo'd `SUPPORT_GUILD_ID` must fail the boot, not silently badge
 * nobody, because nothing about a missing badge looks like a fault.
 */
function supporterRolesInput(e: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const keys = [
    'SUPPORT_GUILD_ID',
    'SUPPORT_ROLE_S',
    'SUPPORT_ROLE_M',
    'SUPPORT_ROLE_L',
    'SUPPORT_ROLE_XL',
    'SUPPORT_ROLE_XXL',
    'SUPPORT_ROLE_WRITE_SPACING_MS',
    'SUPPORT_ROLE_RECONCILE_INTERVAL_HOURS',
  ] as const;
  if (!keys.some((k) => e[k] !== undefined)) return undefined;
  return {
    guildId: e.SUPPORT_GUILD_ID,
    byTier: {
      s: e.SUPPORT_ROLE_S,
      m: e.SUPPORT_ROLE_M,
      l: e.SUPPORT_ROLE_L,
      xl: e.SUPPORT_ROLE_XL,
      xxl: e.SUPPORT_ROLE_XXL,
    },
    writeSpacingMs: e.SUPPORT_ROLE_WRITE_SPACING_MS,
    reconcileIntervalHours: e.SUPPORT_ROLE_RECONCILE_INTERVAL_HOURS,
  };
}

/**
 * The backup group, or `undefined` when the operator has not configured one.
 *
 * All-or-nothing is enforced by *shape*, not by a hand-written check: if any
 * `BACKUP_*` var is set we hand zod a partial object and let its own required
 * fields produce the error, naming exactly which key is missing. If none are
 * set we hand it `undefined` and backups are simply off.
 *
 * The alternative -- returning undefined unless all five are present -- would
 * make a typo'd endpoint silently disable backups, and nobody discovers that
 * until a restore.
 */
function backupInput(e: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const keys = [
    'BACKUP_S3_ENDPOINT',
    'BACKUP_S3_REGION',
    'BACKUP_S3_BUCKET',
    'BACKUP_S3_ACCESS_KEY_ID',
    'BACKUP_S3_SECRET_ACCESS_KEY',
    'BACKUP_ENCRYPTION_KEY',
    'BACKUP_INTERVAL_HOURS',
    'BACKUP_PREFERRED_HOUR_UTC',
    'BACKUP_RETENTION_DAILY',
    'BACKUP_RETENTION_WEEKLY',
    'BACKUP_RETENTION_MONTHLY',
    'BACKUP_PREFIX',
    'BACKUP_DRILL_INTERVAL_HOURS',
    'BACKUP_DRILL_DATABASE_URL',
  ] as const;
  if (!keys.some((k) => e[k] !== undefined)) return undefined;
  return {
    endpoint: e.BACKUP_S3_ENDPOINT,
    region: e.BACKUP_S3_REGION,
    bucket: e.BACKUP_S3_BUCKET,
    accessKeyId: e.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: e.BACKUP_S3_SECRET_ACCESS_KEY,
    encryptionKey: e.BACKUP_ENCRYPTION_KEY,
    intervalHours: e.BACKUP_INTERVAL_HOURS,
    preferredHourUtc: e.BACKUP_PREFERRED_HOUR_UTC,
    retention: {
      daily: e.BACKUP_RETENTION_DAILY,
      weekly: e.BACKUP_RETENTION_WEEKLY,
      monthly: e.BACKUP_RETENTION_MONTHLY,
    },
    prefix: e.BACKUP_PREFIX,
    drillIntervalHours: e.BACKUP_DRILL_INTERVAL_HOURS,
    drillDatabaseUrl: e.BACKUP_DRILL_DATABASE_URL,
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
