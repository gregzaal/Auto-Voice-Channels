import { existsSync, readFileSync } from 'node:fs';
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
});
