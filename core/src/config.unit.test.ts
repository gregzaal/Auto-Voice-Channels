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
    expect(config.selfHosted).toBe(false);
    expect(config.totalShards).toBe(1);
    expect(config.httpPort).toBe(8080);
    expect(config.logLevel).toBe('info');
  });

  it('parses booleanish SELF_HOSTED values', () => {
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'true' }).selfHosted).toBe(true);
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: '1' }).selfHosted).toBe(true);
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'yes' }).selfHosted).toBe(true);
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'false' }).selfHosted).toBe(false);
    expect(loadConfig({ ...baseEnv, SELF_HOSTED: 'off' }).selfHosted).toBe(false);
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
