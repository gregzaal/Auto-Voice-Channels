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
    // Hosted (SELF_HOSTED=false) additionally requires a diagnostics token.
    const hosted = { ...baseEnv, DIAGNOSTICS_TOKEN: 'x'.repeat(32) };
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
        loadConfig({ ...baseEnv, SELF_HOSTED: 'false', DIAGNOSTICS_TOKEN: 'short' }),
      ).toThrow();
    });

    it('accepts a long token on either deployment', () => {
      const token = 'y'.repeat(40);
      expect(
        loadConfig({ ...baseEnv, SELF_HOSTED: 'false', DIAGNOSTICS_TOKEN: token }).diagnosticsToken,
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
