import { describe, expect, it } from 'vitest';
import { parseKeyDate, pgEnvFromUrl } from './runBackup.js';

describe('pgEnvFromUrl', () => {
  /**
   * The whole reason this function exists: `pg_dump <url>` puts the password in
   * the process list, readable by anything else on the box.
   */
  it('maps a connection string onto PG* environment variables', () => {
    const env = pgEnvFromUrl('postgres://alice:s3cret@db.example.com:6543/avc');
    expect(env).toMatchObject({
      PGHOST: 'db.example.com',
      PGPORT: '6543',
      PGUSER: 'alice',
      PGPASSWORD: 's3cret',
      PGDATABASE: 'avc',
    });
  });

  /** Managed providers routinely issue passwords containing URL-escaped bytes. */
  it('percent-decodes credentials', () => {
    const env = pgEnvFromUrl('postgres://user%40host:p%40ss%3Aword@h/db');
    expect(env.PGUSER).toBe('user@host');
    expect(env.PGPASSWORD).toBe('p@ss:word');
  });

  it('omits the port when the URL does not carry one', () => {
    expect(pgEnvFromUrl('postgres://u:p@h/db').PGPORT).toBeUndefined();
  });

  /** Local docker-compose has no TLS; a managed primary requires it. */
  it('defaults sslmode to prefer so both profiles work', () => {
    expect(pgEnvFromUrl('postgres://u:p@h/db').PGSSLMODE).toBe('prefer');
  });

  it('honours an explicit sslmode', () => {
    expect(pgEnvFromUrl('postgres://u:p@h/db?sslmode=require').PGSSLMODE).toBe('require');
  });

  it('handles a password-less local connection', () => {
    const env = pgEnvFromUrl('postgres://postgres@localhost:5432/avc');
    expect(env.PGPASSWORD).toBeUndefined();
    expect(env.PGUSER).toBe('postgres');
  });
});

describe('parseKeyDate', () => {
  it('recovers the timestamp from a key we wrote', () => {
    expect(parseKeyDate('v2/production/2026/08/18/avc-20260818T030405Z.dump')?.toISOString()).toBe(
      '2026-08-18T03:04:05.000Z',
    );
  });

  it('handles the encrypted extension', () => {
    expect(parseKeyDate('v2/x/avc-20260818T030405Z.dump.enc')).not.toBeNull();
  });

  /**
   * Anything unparseable must be left alone, never pruned. An object this code
   * does not understand is not an object it should delete.
   */
  it('returns null for foreign objects sharing the bucket', () => {
    expect(parseKeyDate('v2/production/notes.txt')).toBeNull();
    expect(parseKeyDate('legacy/beta/2020-07-18.json')).toBeNull();
    expect(parseKeyDate('v2/x/avc-nonsense.dump')).toBeNull();
  });

  it('does not mistake a manifest for a dump', () => {
    expect(parseKeyDate('v2/x/avc-20260818T030405Z.dump.manifest.json')).toBeNull();
  });
});
