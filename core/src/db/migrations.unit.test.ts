import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from './migrate.js';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as { entries: JournalEntry[] };

/**
 * The migration journal, checked for the ways it goes wrong silently.
 *
 * **Drizzle applies a migration only if its journal `when` is later than the
 * newest one already applied**, and skips an older one with no error. Two
 * branches that each generate a migration, or a hand-edited stamp, therefore
 * lose one without a failure anywhere: the table or column just never appears.
 * Nothing else in the suite would notice.
 */
describe('migration journal', () => {
  it('numbers entries in order with no gaps', () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it('stamps every entry later than the one before it', () => {
    const late = journal.entries.filter((e, i) => i > 0 && e.when <= journal.entries[i - 1]!.when);
    expect(late.map((e) => e.tag)).toEqual([]);
  });

  it('has a SQL file and a snapshot for every entry', () => {
    const missing: string[] = [];
    for (const entry of journal.entries) {
      const sql = `${entry.tag}.sql`;
      const snapshot = `${entry.tag.slice(0, 4)}_snapshot.json`;
      if (!existsSync(join(MIGRATIONS_FOLDER, sql))) missing.push(sql);
      if (!existsSync(join(MIGRATIONS_FOLDER, 'meta', snapshot))) missing.push(snapshot);
    }
    expect(missing).toEqual([]);
  });

  /**
   * The other direction, which is the one a merge conflict in `_journal.json`
   * produces: resolving it by dropping an entry leaves its SQL and snapshot on
   * disk, and drizzle never applies a file the journal does not list.
   */
  it('lists every SQL file and snapshot on disk', () => {
    const tags = journal.entries.map((e) => e.tag).sort();
    const sqlOnDisk = readdirSync(MIGRATIONS_FOLDER)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -'.sql'.length))
      .sort();
    expect(sqlOnDisk).toEqual(tags);

    const snapshotsOnDisk = readdirSync(join(MIGRATIONS_FOLDER, 'meta'))
      .filter((f) => f.endsWith('_snapshot.json'))
      .sort();
    expect(snapshotsOnDisk).toEqual(
      journal.entries.map((e) => `${e.tag.slice(0, 4)}_snapshot.json`).sort(),
    );
  });

  it('names each entry after its index', () => {
    const misnamed = journal.entries.filter(
      (e) => e.tag.slice(0, 4) !== String(e.idx).padStart(4, '0'),
    );
    expect(misnamed.map((e) => e.tag)).toEqual([]);
  });
});
