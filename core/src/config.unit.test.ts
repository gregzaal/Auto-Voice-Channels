import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const baseEnv = {
  DISCORD_TOKEN: 'token',
  CLIENT_ID: 'client',
  DATABASE_URL: 'postgres://localhost/avc',
};

describe('loadConfig', () => {
  it('loads valid config with defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.discordToken).toBe('token');
    // Self-host is the default; the hosted service opts out explicitly.
    expect(config.selfHosted).toBe(true);
    expect(config.totalShards).toBe(1);
    expect(config.httpPort).toBe(8080);
    expect(config.logLevel).toBe('info');
  });

  it('parses booleanish SELF_HOSTED values', () => {
    // Hosted (SELF_HOSTED=false) additionally requires a diagnostics token
    // and an explicit fleet.
    const hosted = {
      ...baseEnv,
      DIAGNOSTICS_TOKEN: 'x'.repeat(32),
      FLEET: 'prod',
      ADMIN_CHANNEL_ID: '601348321566654475',
    };
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'true' }).selfHosted).toBe(true);
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: '1' }).selfHosted).toBe(true);
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'yes' }).selfHosted).toBe(true);
    expect(loadConfig({ ...hosted, SELF_HOSTED: 'false' }).selfHosted).toBe(false);
    expect(loadConfig({ ...hosted, SELF_HOSTED: 'off' }).selfHosted).toBe(false);
  });

  /**
   * `/diagnostics` shipped unauthenticated and publicly reachable on the beta
   * fleet. Fail fast rather than fail open: a hosted instance must not be able
   * to boot without a token, and self-host must stay zero-config.
   */
  describe('diagnostics token', () => {
    it('is required when SELF_HOSTED=false', () => {
      expect(() => loadConfig({ ...baseEnv, SELF_HOSTED: 'false' })).toThrow(/DIAGNOSTICS_TOKEN/);
    });

    it('is optional on a self-host', () => {
      expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'true' }).diagnosticsToken).toBeUndefined();
    });

    it('rejects a token short enough to guess', () => {
      expect(() =>
        loadConfig({ ...baseEnv, SELF_HOSTED: 'false', FLEET: 'prod', DIAGNOSTICS_TOKEN: 'short' }),
      ).toThrow();
    });

    it('accepts a long token on either deployment', () => {
      const token = 'y'.repeat(40);
      expect(
        loadConfig({
          ...baseEnv,
          SELF_HOSTED: 'false',
          FLEET: 'prod',
          ADMIN_CHANNEL_ID: '1',
          DIAGNOSTICS_TOKEN: token,
        }).diagnosticsToken,
      ).toBe(token);
      expect(
        loadConfig({ ...baseEnv, SELF_HOSTED: 'true', DIAGNOSTICS_TOKEN: token }).diagnosticsToken,
      ).toBe(token);
    });
  });

  // One OpenAI-compatible endpoint, three knobs, no per-provider adapters:
  // pointing at OpenRouter, Groq, or a local Ollama is a config change only.
  it('defaults the AI knobs and enables the assistant only when a key is set', () => {
    const off = loadConfig(baseEnv);
    expect(off.aiApiKey).toBeUndefined();
    expect(off.aiBaseUrl).toBe('https://api.openai.com/v1');
    expect(off.aiModel).toBe('gpt-5.4-mini');
    expect(off.aiTimeoutMs).toBe(30_000);

    const local = loadConfig({
      ...baseEnv,
      AVC_AI_API_KEY: 'sk-x',
      AVC_AI_BASE_URL: 'http://localhost:11434/v1',
      AVC_AI_MODEL: 'llama3.2',
      AVC_AI_PRICE_INPUT_PER_MTOK: '0',
      AVC_AI_PRICE_OUTPUT_PER_MTOK: '0',
    });
    expect(local.aiApiKey).toBe('sk-x');
    expect(local.aiBaseUrl).toBe('http://localhost:11434/v1');
    expect(local.aiModel).toBe('llama3.2');
    expect(local.aiPriceInputPerMTok).toBe(0);
  });

  it('coerces numeric env vars', () => {
    const config = loadConfig({ ...baseEnv, TOTAL_SHARDS: '4', HTTP_PORT: '9000' });
    expect(config.totalShards).toBe(4);
    expect(config.httpPort).toBe(9000);
  });

  it('resolves instanceId: explicit > FLY_MACHINE_ID > "local"', () => {
    expect(loadConfig(baseEnv).instanceId).toBe('local');
    expect(loadConfig({ ...baseEnv, FLY_MACHINE_ID: 'mach-1' }).instanceId).toBe('mach-1');
    // An explicit INSTANCE_ID always wins over the Fly fallback.
    expect(
      loadConfig({ ...baseEnv, INSTANCE_ID: 'selfhost', FLY_MACHINE_ID: 'mach-1' }).instanceId,
    ).toBe('selfhost');
  });

  it('throws ConfigError listing all missing required fields', () => {
    try {
      loadConfig({});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.map((i) => i.path.join('.'));
      expect(issues).toContain('discordToken');
      expect(issues).toContain('clientId');
      expect(issues).toContain('databaseUrl');
    }
  });

  it('rejects invalid log level', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('rejects non-positive shard counts', () => {
    expect(() => loadConfig({ ...baseEnv, TOTAL_SHARDS: '0' })).toThrow(ConfigError);
  });
});

/**
 * Same fail-fast reasoning as the diagnostics token, different blast radius: a
 * hosted instance that silently defaulted to `prod` would let the beta bot claim
 * production's shard leases and read production's runtime flags. Wrong rows,
 * written plausibly, which is far harder to notice than a refused boot.
 */
describe('fleet', () => {
  const hostedBase = {
    DISCORD_TOKEN: 'token',
    CLIENT_ID: 'client',
    DATABASE_URL: 'postgres://localhost/avc',
    SELF_HOSTED: 'false',
    DIAGNOSTICS_TOKEN: 'z'.repeat(32),
    ADMIN_CHANNEL_ID: '601348321566654475',
  };

  it('is required when SELF_HOSTED=false', () => {
    expect(() => loadConfig(hostedBase)).toThrow(/FLEET is required/);
  });

  it('accepts each known fleet when hosted', () => {
    expect(loadConfig({ ...hostedBase, FLEET: 'prod' }).fleet).toBe('prod');
    expect(loadConfig({ ...hostedBase, FLEET: 'beta' }).fleet).toBe('beta');
  });

  /**
   * The beta fleet ran for weeks with this unset, so every operational alert
   * was silently discarded by NullErrorReporter with nothing saying so. A
   * hosted fleet must not be able to boot that way.
   */
  it('refuses to boot hosted without an admin channel', () => {
    const { ADMIN_CHANNEL_ID: _omitted, ...noChannel } = hostedBase;
    expect(() => loadConfig({ ...noChannel, FLEET: 'prod' })).toThrow(/ADMIN_CHANNEL_ID/);
  });

  it('still lets a self-hoster run without one', () => {
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'true' }).adminChannelId).toBeUndefined();
  });

  it('rejects an unknown fleet', () => {
    expect(() => loadConfig({ ...hostedBase, FLEET: 'staging' })).toThrow(ConfigError);
  });

  /** Self-host is the only fleet in its own database, so it never configures one. */
  it('defaults to prod on a self-host, with no configuration', () => {
    expect(loadConfig({ ...hostedBase, SELF_HOSTED: 'true', FLEET: undefined }).fleet).toBe('prod');
  });
});

/**
 * The regression that shipped: `docker compose up`, the one self-hosting command
 * the README and the website both advertise, could not boot.
 *
 * Compose forwards the optional vars as `${AVC_AI_BASE_URL:-}`, which sets them
 * to the empty string rather than leaving them unset. zod applies `.default()`
 * and `.optional()` only to `undefined`, so all three reached `.min(1)` and the
 * process failed fast on keys the user had been told to leave alone.
 */
describe('empty env vars are treated as absent', () => {
  /** Exactly what compose injects for a .env holding only the two required keys. */
  const composeEnv: NodeJS.ProcessEnv = {
    DISCORD_TOKEN: 'token',
    CLIENT_ID: 'client',
    DATABASE_URL: 'postgres://postgres:postgres@postgres:5432/avc',
    DEV_GUILD_ID: '',
    AVC_AI_BASE_URL: '',
    AVC_AI_API_KEY: '',
    AVC_AI_MODEL: '',
    TOTAL_SHARDS: '1',
    INSTANCE_ID: 'selfhost',
    HTTP_PORT: '8080',
    LOG_LEVEL: 'info',
    NODE_ENV: 'production',
  };

  it('boots the documented self-host command', () => {
    expect(() => loadConfig(composeEnv)).not.toThrow();
  });

  it('falls back to the declared defaults rather than the empty string', () => {
    const config = loadConfig(composeEnv);
    expect(config.aiBaseUrl).toBe('https://api.openai.com/v1');
    expect(config.aiModel).toBe('gpt-5.4-mini');
  });

  /** An empty key must not switch a feature on: no key means no assistant. */
  it('leaves an optional key undefined, not empty', () => {
    const config = loadConfig(composeEnv);
    expect(config.aiApiKey).toBeUndefined();
    expect(config.devGuildId).toBeUndefined();
  });

  /** Whitespace is the same mistake wearing a hat. */
  it('treats whitespace as absent too', () => {
    expect(loadConfig({ ...composeEnv, AVC_AI_API_KEY: '   ' }).aiApiKey).toBeUndefined();
  });

  /** A required key set to empty still fails, just with the clearer message. */
  it('still rejects a required key that is blank', () => {
    expect(() => loadConfig({ ...composeEnv, DISCORD_TOKEN: '' })).toThrow(
      /DISCORD_TOKEN is required/,
    );
  });
});
