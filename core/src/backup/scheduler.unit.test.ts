import { describe, expect, it } from 'vitest';
import { isBackupDue, nextDueAt } from './scheduler.js';

const at = (iso: string): Date => new Date(iso);

describe('isBackupDue', () => {
  const daily = { intervalHours: 24, preferredHourUtc: 3 };

  /** A fleet that has never backed up should not wait for 03:00. */
  it('is due immediately when nothing has ever run', () => {
    expect(isBackupDue({ now: at('2026-08-18T14:00:00Z'), lastCompletedAt: null, ...daily })).toBe(
      true,
    );
  });

  it('is not due before the interval elapses', () => {
    expect(
      isBackupDue({
        now: at('2026-08-18T20:00:00Z'),
        lastCompletedAt: at('2026-08-18T03:00:00Z'),
        ...daily,
      }),
    ).toBe(false);
  });

  /**
   * The reason the preferred hour exists. A plain "last + 24h" schedule drifts
   * later every day, because each run finishes a little after the last.
   */
  it('waits for the preferred hour rather than drifting', () => {
    // 24h elapsed, but it is 01:00 UTC and the preferred hour is 03:00.
    expect(
      isBackupDue({
        now: at('2026-08-19T01:30:00Z'),
        lastCompletedAt: at('2026-08-18T01:00:00Z'),
        ...daily,
      }),
    ).toBe(false);
    expect(
      isBackupDue({
        now: at('2026-08-19T03:00:00Z'),
        lastCompletedAt: at('2026-08-18T01:00:00Z'),
        ...daily,
      }),
    ).toBe(true);
  });

  /**
   * But never at the cost of skipping a backup. A tidy schedule is worth less
   * than a backup existing.
   */
  it('runs anyway once badly overdue, preferred hour or not', () => {
    expect(
      isBackupDue({
        now: at('2026-08-20T01:00:00Z'),
        lastCompletedAt: at('2026-08-18T03:00:00Z'),
        ...daily,
      }),
    ).toBe(true);
  });

  it('ignores the preferred hour for sub-daily intervals', () => {
    expect(
      isBackupDue({
        now: at('2026-08-18T14:00:00Z'),
        lastCompletedAt: at('2026-08-18T07:00:00Z'),
        intervalHours: 6,
        preferredHourUtc: 3,
      }),
    ).toBe(true);
  });
});

describe('nextDueAt', () => {
  it('is unknown before the first run', () => {
    expect(nextDueAt({ lastCompletedAt: null, intervalHours: 24, preferredHourUtc: 3 })).toBeNull();
  });

  it('pushes an early due time out to the preferred hour', () => {
    const due = nextDueAt({
      lastCompletedAt: at('2026-08-18T01:00:00Z'),
      intervalHours: 24,
      preferredHourUtc: 3,
    });
    expect(due?.toISOString()).toBe('2026-08-19T03:00:00.000Z');
  });

  it('leaves a due time that is already past the preferred hour alone', () => {
    const due = nextDueAt({
      lastCompletedAt: at('2026-08-18T09:00:00Z'),
      intervalHours: 24,
      preferredHourUtc: 3,
    });
    expect(due?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });
});
