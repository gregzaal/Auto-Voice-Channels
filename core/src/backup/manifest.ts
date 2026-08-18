import { z } from 'zod';

/**
 * Object keys, the manifest sidecar, and grandfather-father-son retention
 * (`plans/backups.md` §4 and §6). Pure: no S3, no filesystem, no clock of its
 * own. Everything that decides what to delete lives here so it can be tested
 * exhaustively rather than observed in production.
 */

/**
 * `${prefix}/${env}/${YYYY}/${MM}/${DD}/avc-${ISO}.dump[.enc]`
 *
 * The date path is for humans browsing the bucket; the code never parses it and
 * reads `createdAt` off the manifest instead. Colons are stripped from the ISO
 * stamp because several S3 consoles and CLIs handle them badly in keys.
 */
export function objectKey(opts: {
  prefix: string;
  env: string;
  at: Date;
  encrypted: boolean;
}): string {
  // ISO 8601 *basic* format: no separators. Colons break several S3 consoles
  // and CLIs, and the dashes buy nothing once the date is also in the path.
  const iso = opts.at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const y = opts.at.getUTCFullYear();
  const m = String(opts.at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(opts.at.getUTCDate()).padStart(2, '0');
  const ext = opts.encrypted ? '.dump.enc' : '.dump';
  return `${trimSlashes(opts.prefix)}/${opts.env}/${y}/${m}/${d}/avc-${iso}${ext}`;
}

/** The manifest lives beside its dump, so listing one lists the other. */
export function manifestKey(dumpKey: string): string {
  return `${dumpKey}.manifest.json`;
}

export function isManifestKey(key: string): boolean {
  return key.endsWith('.manifest.json');
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

/**
 * What a restore needs to know before it touches Postgres.
 *
 * `migrationVersion` is the load-bearing one: restoring a dump taken on an
 * older schema into a newer deployment is the failure this is here to catch,
 * and it is invisible without recording it. `sha256` and `sizeBytes` verify
 * the object survived the round trip.
 */
export const manifestSchema = z.object({
  createdAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  encrypted: z.boolean(),
  pgServerVersion: z.string().nullable(),
  migrationVersion: z.string().nullable(),
  rowCounts: z.record(z.number().int().nonnegative()),
  instanceId: z.string(),
  appVersion: z.string(),
  commit: z.string(),
  /** Present only on drill runs, so a drill is never mistaken for a real backup. */
  drill: z.boolean().optional(),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

export function parseManifest(raw: string): BackupManifest {
  return manifestSchema.parse(JSON.parse(raw));
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupEntry {
  key: string;
  createdAt: Date;
}

/** UTC day, ISO week and month buckets. Deliberately UTC: a server that moves
 * timezone must not silently re-bucket its own history. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}
function weekKey(d: Date): string {
  // ISO-8601 week, so weeks do not drift against the calendar year.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Which backups to keep, and which to delete.
 *
 * Grandfather-father-son: keep the newest backup in each of the last `daily`
 * days, `weekly` ISO weeks and `monthly` months. One object can satisfy several
 * buckets at once, which is the point of GFS and why this is a set union rather
 * than three independent lists.
 *
 * **The newest backup is always kept, unconditionally**, even with a policy of
 * all zeroes. Pruning to nothing is never what an operator meant, and §6 is
 * explicit that we never end up with no backup.
 */
export function planRetention(
  entries: readonly BackupEntry[],
  policy: RetentionPolicy,
): { keep: BackupEntry[]; deleteKeys: string[] } {
  if (entries.length === 0) return { keep: [], deleteKeys: [] };

  // Newest first, so the first entry seen for any bucket is the one to keep.
  const sorted = [...entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>([sorted[0]!.key]);

  const takeNewestPerBucket = (bucketOf: (d: Date) => string, limit: number): void => {
    const seen = new Set<string>();
    for (const entry of sorted) {
      if (seen.size >= limit) break;
      const bucket = bucketOf(entry.createdAt);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      keep.add(entry.key);
    }
  };

  takeNewestPerBucket(dayKey, policy.daily);
  takeNewestPerBucket(weekKey, policy.weekly);
  takeNewestPerBucket(monthKey, policy.monthly);

  return {
    keep: sorted.filter((e) => keep.has(e.key)),
    deleteKeys: sorted.filter((e) => !keep.has(e.key)).map((e) => e.key),
  };
}
