import { describe, expect, it } from 'vitest';
import { restoreErrorsAreIgnorable } from './restore.js';

/**
 * The real stderr from a drill against Fly Managed Postgres on 2026-08-19.
 * Every table restored with matching row counts and pg_restore still exited 1.
 */
const PLATFORM_EXTENSIONS = `pg_restore: error: could not execute query: ERROR:  must be owner of extension pgaudit
Command was: DROP EXTENSION IF EXISTS pgaudit;
pg_restore: error: could not execute query: ERROR:  must be owner of extension pg_stat_monitor
Command was: DROP EXTENSION IF EXISTS pg_stat_monitor;
pg_restore: error: could not execute query: ERROR:  must be owner of extension pg_stat_monitor
Command was: COMMENT ON EXTENSION pg_stat_monitor IS 'monitoring';
pg_restore: error: could not execute query: ERROR:  must be owner of extension pgaudit
Command was: COMMENT ON EXTENSION pgaudit IS 'provides auditing functionality';
pg_restore: warning: errors ignored on restore: 4`;

/** The same run with the trailing summary line removed. */
const WITHOUT_SUMMARY = PLATFORM_EXTENSIONS.split('\n').slice(0, -1).join('\n');

describe('restoreErrorsAreIgnorable', () => {
  it('tolerates extension ownership, which managed Postgres always refuses', () => {
    expect(restoreErrorsAreIgnorable(PLATFORM_EXTENSIONS)).toBe(true);
  });

  it('refuses a real failure', () => {
    const stderr = `pg_restore: error: could not execute query: ERROR:  relation "guilds" already exists
Command was: CREATE TABLE guilds (...);
pg_restore: warning: errors ignored on restore: 1`;
    expect(restoreErrorsAreIgnorable(stderr)).toBe(false);
  });

  it('refuses a real failure hiding among tolerable ones', () => {
    const stderr = `${WITHOUT_SUMMARY}
pg_restore: error: could not execute query: ERROR:  out of disk space
pg_restore: warning: errors ignored on restore: 5`;
    expect(restoreErrorsAreIgnorable(stderr)).toBe(false);
  });

  /**
   * The buffer that feeds this is capped, and `--clean` runs its DROP phase
   * first, so the tolerable extension errors sit at the FRONT and any real
   * error from the data or post-data phase is what falls off the end. Checking
   * only the error lines would call that a clean run.
   *
   * pg_restore emits its summary immediately before returning, so requiring the
   * summary is what makes a truncated buffer detectable at all.
   */
  it('refuses when the trailing summary is missing, which is what truncation looks like', () => {
    expect(restoreErrorsAreIgnorable(WITHOUT_SUMMARY)).toBe(false);
  });

  /**
   * Same shape as a kill: the process never reached its own summary. A kill in
   * the post-data phase leaves every row present with no indexes, primary keys
   * or foreign keys, which no row-count check downstream can see.
   */
  it('refuses when pg_restore died before finishing', () => {
    const partial = PLATFORM_EXTENSIONS.split('\n').slice(0, 4).join('\n');
    expect(restoreErrorsAreIgnorable(partial)).toBe(false);
  });

  /**
   * pg_restore counted more errors than we can see, so the ones we cannot see
   * are precisely the ones that would have failed the check above.
   */
  it('refuses when the summary counts more errors than are visible', () => {
    const stderr = `${WITHOUT_SUMMARY}
pg_restore: warning: errors ignored on restore: 9`;
    expect(restoreErrorsAreIgnorable(stderr)).toBe(false);
  });

  it('refuses when the exit code had no error lines behind it at all', () => {
    expect(restoreErrorsAreIgnorable('')).toBe(false);
    expect(restoreErrorsAreIgnorable('pg_restore: warning: errors ignored on restore: 4')).toBe(
      false,
    );
  });

  /**
   * Pins the line filtering specifically. The error line here is genuinely
   * tolerable and the summary agrees, so the only thing that can make this
   * false is the `Command was:` echo being counted as an error line, which an
   * earlier version of this test failed to isolate.
   */
  it('does not count a Command was: echo as an error line', () => {
    const stderr = `pg_restore: error: could not execute query: ERROR:  must be owner of extension pgaudit
Command was: COMMENT ON TABLE t IS 'must be owner of extension';
pg_restore: warning: errors ignored on restore: 1`;
    expect(restoreErrorsAreIgnorable(stderr)).toBe(true);
  });

  /** An older client logs a different prefix and must fail closed, not open. */
  it('refuses the pre-PG12 log format rather than guessing', () => {
    const stderr = `pg_restore: [archiver (db)] Error while PROCESSING TOC:
pg_restore: [archiver (db)] could not execute query: ERROR:  must be owner of extension pgaudit
pg_restore: warning: errors ignored on restore: 1`;
    expect(restoreErrorsAreIgnorable(stderr)).toBe(false);
  });

  it('tolerates CRLF, which is how this file checks out on Windows', () => {
    expect(restoreErrorsAreIgnorable(PLATFORM_EXTENSIONS.replace(/\n/g, '\r\n'))).toBe(true);
  });
});
