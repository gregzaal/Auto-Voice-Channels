import { describe, expect, it } from 'vitest';
import {
  isManifestKey,
  manifestKey,
  objectKey,
  parseManifest,
  planRetention,
  type BackupEntry,
} from './manifest.js';

describe('objectKey', () => {
  const at = new Date('2026-08-18T03:04:05.678Z');

  it('lays out prefix/env/Y/M/D and a colon-free stamp', () => {
    expect(objectKey({ prefix: 'v2', env: 'production', at, encrypted: false })).toBe(
      'v2/production/2026/08/18/avc-20260818T030405Z.dump',
    );
  });

  it('marks encrypted objects in the extension', () => {
    expect(objectKey({ prefix: 'v2', env: 'production', at, encrypted: true })).toMatch(
      /\.dump\.enc$/,
    );
  });

  it('normalises a prefix given with slashes', () => {
    expect(objectKey({ prefix: '/v2/', env: 'test', at, encrypted: false })).toBe(
      'v2/test/2026/08/18/avc-20260818T030405Z.dump',
    );
  });

  /** Lexical sort must equal chronological sort, or "latest" listing breaks. */
  it('sorts lexically in time order', () => {
    const keys = [
      new Date('2026-01-02T00:00:00Z'),
      new Date('2026-01-10T00:00:00Z'),
      new Date('2025-12-31T23:59:59Z'),
      new Date('2026-01-02T00:00:01Z'),
    ].map((d) => objectKey({ prefix: 'v2', env: 'production', at: d, encrypted: false }));
    expect([...keys].sort()).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    const chronological = [keys[2], keys[0], keys[3], keys[1]];
    expect([...keys].sort()).toEqual(chronological);
  });
});

describe('manifestKey', () => {
  it('sits beside the dump', () => {
    expect(manifestKey('v2/production/2026/08/18/avc-x.dump')).toBe(
      'v2/production/2026/08/18/avc-x.dump.manifest.json',
    );
  });
  it('is detectable when listing', () => {
    expect(isManifestKey('a/b.dump.manifest.json')).toBe(true);
    expect(isManifestKey('a/b.dump')).toBe(false);
  });
});

describe('parseManifest', () => {
  const good = {
    createdAt: '2026-08-18T03:00:00.000Z',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    encrypted: true,
    pgServerVersion: '16.4',
    migrationVersion: '0017_messy_earthquake',
    rowCounts: { guilds: 1862, subscriptions: 3 },
    instanceId: 'm1',
    appVersion: '0.1.0',
    commit: 'deadbeef',
  };

  it('accepts a well-formed manifest', () => {
    expect(parseManifest(JSON.stringify(good)).rowCounts.guilds).toBe(1862);
  });

  /** A corrupt manifest must fail loudly: it is what restore trusts. */
  it('rejects a bad checksum shape', () => {
    expect(() => parseManifest(JSON.stringify({ ...good, sha256: 'nope' }))).toThrow();
  });

  it('rejects a missing migrationVersion field entirely', () => {
    const { migrationVersion: _omit, ...rest } = good;
    expect(() => parseManifest(JSON.stringify(rest))).toThrow();
  });

  /** Null is different from absent: an old dump may predate the field's source. */
  it('allows a null migrationVersion', () => {
    expect(
      parseManifest(JSON.stringify({ ...good, migrationVersion: null })).migrationVersion,
    ).toBeNull();
  });
});

describe('planRetention', () => {
  const policy = { daily: 7, weekly: 4, monthly: 6 };
  const at = (iso: string): BackupEntry => ({ key: iso, createdAt: new Date(iso) });

  it('keeps everything when there is less than the policy allows', () => {
    const entries = [at('2026-08-18T03:00:00Z'), at('2026-08-17T03:00:00Z')];
    expect(planRetention(entries, policy).deleteKeys).toEqual([]);
  });

  it('keeps one per day and drops the rest of that day', () => {
    const entries = [
      at('2026-08-18T03:00:00Z'),
      at('2026-08-18T09:00:00Z'),
      at('2026-08-18T15:00:00Z'),
    ];
    const { keep, deleteKeys } = planRetention(entries, { daily: 7, weekly: 0, monthly: 0 });
    expect(keep.map((k) => k.key)).toEqual(['2026-08-18T15:00:00Z']);
    expect(deleteKeys).toHaveLength(2);
  });

  /** The whole point of GFS: an old backup survives as the weekly or monthly. */
  it('promotes an out-of-daily-range backup into the weekly and monthly buckets', () => {
    const entries = [
      at('2026-08-18T03:00:00Z'),
      at('2026-08-11T03:00:00Z'),
      at('2026-07-04T03:00:00Z'),
      at('2026-06-04T03:00:00Z'),
    ];
    const { deleteKeys } = planRetention(entries, { daily: 1, weekly: 2, monthly: 3 });
    expect(deleteKeys).toEqual([]);
  });

  it('deletes what no bucket claims', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      at(new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString()),
    );
    const { keep, deleteKeys } = planRetention(entries, policy);
    expect(keep.length + deleteKeys.length).toBe(40);
    expect(deleteKeys.length).toBeGreaterThan(0);
    // No object is both kept and deleted.
    expect(keep.some((k) => deleteKeys.includes(k.key))).toBe(false);
  });

  /**
   * The invariant that matters most. A misconfigured policy must never be able
   * to leave the bucket empty.
   */
  it('never deletes the newest backup, even with a zeroed policy', () => {
    const entries = [at('2026-08-18T03:00:00Z'), at('2026-08-17T03:00:00Z')];
    const { keep, deleteKeys } = planRetention(entries, { daily: 0, weekly: 0, monthly: 0 });
    expect(keep.map((k) => k.key)).toEqual(['2026-08-18T03:00:00Z']);
    expect(deleteKeys).toEqual(['2026-08-17T03:00:00Z']);
  });

  it('handles an empty bucket', () => {
    expect(planRetention([], policy)).toEqual({ keep: [], deleteKeys: [] });
  });

  it('is not confused by input arriving oldest-first', () => {
    const entries = [
      at('2026-08-16T03:00:00Z'),
      at('2026-08-17T03:00:00Z'),
      at('2026-08-18T03:00:00Z'),
    ];
    const { keep } = planRetention(entries, { daily: 1, weekly: 0, monthly: 0 });
    expect(keep.map((k) => k.key)).toEqual(['2026-08-18T03:00:00Z']);
  });

  /** Weeks are ISO, so a new year must not silently re-bucket December. */
  it('buckets across a year boundary by ISO week', () => {
    const entries = [at('2027-01-01T03:00:00Z'), at('2026-12-28T03:00:00Z')];
    const { deleteKeys } = planRetention(entries, { daily: 0, weekly: 1, monthly: 0 });
    // Both fall in ISO week 2026-W53, so the older one is superseded.
    expect(deleteKeys).toEqual(['2026-12-28T03:00:00Z']);
  });
});
