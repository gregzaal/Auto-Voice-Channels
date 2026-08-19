import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_FLAGS } from '@avc/core';
import { BackupScheduler, type BackupSchedulerDeps } from './backupScheduler.js';

/**
 * The tick's decisions, over injected dependencies. No Postgres, no S3.
 *
 * What is worth pinning here is not "does a backup happen" (the integration
 * tests cover that) but the precedence and isolation rules, each of which is a
 * promise made in a docstring or a README and each of which fails silently:
 * a drill must not be able to look like a failed backup, a broken backup must
 * not be able to starve the drill, and a flag that says stop must stop.
 */

function makeDeps(overrides: Partial<BackupSchedulerDeps> = {}): {
  deps: BackupSchedulerDeps;
  flagValues: Record<string, unknown>;
  reported: { message: string; context: Record<string, unknown> }[];
  audited: { action: string }[];
} {
  const flagValues: Record<string, unknown> = {};
  const reported: { message: string; context: Record<string, unknown> }[] = [];
  const audited: { action: string }[] = [];

  const deps = {
    pool: {} as BackupSchedulerDeps['pool'],
    fleet: 'prod',
    flags: {
      getAll: async () => ({ ...flagValues }),
      get: async (key: string) => flagValues[key],
      set: async (key: string, value: unknown) => {
        flagValues[key] = value;
      },
    } as unknown as BackupSchedulerDeps['flags'],
    opsAudit: {
      record: async (entry: { action: string }) => {
        audited.push(entry);
      },
    } as unknown as BackupSchedulerDeps['opsAudit'],
    logger: {
      info: () => {},
      error: () => {},
      child: () => deps.logger,
    } as unknown as BackupSchedulerDeps['logger'],
    config: {
      databaseUrl: 'postgres://u:p@localhost:5432/live',
      instanceId: 'i-1',
      nodeEnv: 'test',
      backup: {
        endpoint: 'https://s3.invalid',
        region: 'r',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
        intervalHours: 24,
        preferredHourUtc: 3,
        retention: { daily: 7, weekly: 4, monthly: 6 },
        drillIntervalHours: 168,
      },
    },
    appVersion: '0.1.0',
    commit: 'c',
    report: (message: string, context: Record<string, unknown>) => {
      reported.push({ message, context });
    },
    probe: async () => ({ pgServerVersion: '16', migrationVersion: 'm', rowCounts: {} }),
    ...overrides,
  } as BackupSchedulerDeps;

  return { deps, flagValues, reported, audited };
}

/** A scheduler whose two jobs are stubs, so the tick's choices are visible. */
function makeScheduler(overrides: Partial<BackupSchedulerDeps> = {}) {
  const harness = makeDeps(overrides);
  const scheduler = new BackupScheduler(harness.deps);
  const backup = vi.fn(async () => {});
  const drill = vi.fn(async () => {});
  scheduler.runOnce = backup;
  scheduler.drillOnce = drill;
  return { ...harness, scheduler, backup, drill };
}

describe('BackupScheduler.tick', () => {
  it('takes a backup when one is due and nothing has ever run', async () => {
    const { scheduler, backup, drill } = makeScheduler();
    await scheduler.tick();
    expect(backup).toHaveBeenCalledTimes(1);
    // No backup has ever completed, so there is nothing to drill against.
    expect(drill).not.toHaveBeenCalled();
  });

  it('does nothing at all while global.pause is set', async () => {
    const { scheduler, backup, drill, flagValues } = makeScheduler();
    flagValues[RUNTIME_FLAGS.GLOBAL_PAUSE] = true;
    await scheduler.tick();
    expect(backup).not.toHaveBeenCalled();
    expect(drill).not.toHaveBeenCalled();
  });

  it('stops backups but not drills when backup.disabled is set', async () => {
    const { scheduler, backup, drill, flagValues } = makeScheduler();
    flagValues[RUNTIME_FLAGS.BACKUP_DISABLED] = true;
    flagValues[RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT] = new Date().toISOString();
    await scheduler.tick();
    expect(backup).not.toHaveBeenCalled();
    expect(drill).toHaveBeenCalledTimes(1);
  });

  it('stops drills but not backups when backup.drill_disabled is set', async () => {
    const { scheduler, backup, drill, flagValues } = makeScheduler();
    flagValues[RUNTIME_FLAGS.BACKUP_DRILL_DISABLED] = true;
    flagValues[RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT] = new Date().toISOString();
    await scheduler.tick();
    expect(drill).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled(); // not due, one just completed
  });

  it('never runs both jobs in one tick when the backup succeeds', async () => {
    const { scheduler, backup, drill } = makeScheduler();
    // A successful backup stamps lastRunAt, which is what `runOnce` does.
    scheduler.runOnce = vi.fn(async () => {
      (scheduler as unknown as { lastRunAt: Date; lastStatus: string }).lastRunAt = new Date();
      (scheduler as unknown as { lastStatus: string }).lastStatus = 'ok';
    });
    await scheduler.tick();
    expect(drill).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  /**
   * The starvation bug. A failed backup does not advance `lastRunAt`, so the
   * backup stays due on every tick forever. Returning unconditionally after
   * attempting it meant the drill never ran again, losing the one signal that
   * matters while backups are broken: is the last good object still restorable.
   */
  it('still drills when the backup keeps failing', async () => {
    const { scheduler, drill, flagValues } = makeScheduler();
    flagValues[RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT] = new Date(
      Date.now() - 48 * 3_600_000,
    ).toISOString();
    scheduler.runOnce = vi.fn(async () => {
      (scheduler as unknown as { lastStatus: string }).lastStatus = 'failed';
    });

    await scheduler.tick();
    expect(drill).toHaveBeenCalledTimes(1);
  });

  it('does not start a job once stopping', async () => {
    const { scheduler, backup } = makeScheduler();
    await scheduler.stop();
    await scheduler.tick();
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('BackupScheduler.stats', () => {
  it('reports a drill as drilling, never as a backup in progress', async () => {
    const { scheduler } = makeScheduler();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    scheduler.drillOnce = vi.fn(async () => {
      await held;
    });
    (scheduler as unknown as { lastRunAt: Date }).lastRunAt = new Date();

    const ticking = scheduler.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.stats.drilling).toBe(true);
    expect(scheduler.stats.running).toBe(false);

    release();
    await ticking;
    expect(scheduler.stats.drilling).toBe(false);
  });

  /**
   * The promise the drill's docstring makes. A backup that is fine must not
   * look broken because a verification download failed.
   */
  it('leaves the backup status alone when a drill fails', async () => {
    const { scheduler, flagValues } = makeScheduler();
    (scheduler as unknown as { lastStatus: string }).lastStatus = 'ok';
    (scheduler as unknown as { lastError: string | null }).lastError = null;

    await (
      scheduler as unknown as {
        recordDrill: (r: unknown) => Promise<void>;
      }
    ).recordDrill({
      ok: false,
      key: 'k',
      ageHours: 1,
      restored: false,
      tablesInArchive: [],
      problems: ['checksum mismatch'],
      durationMs: 5,
    });

    expect(scheduler.stats.lastStatus).toBe('ok');
    expect(scheduler.stats.lastError).toBeNull();
    expect(scheduler.stats.lastDrillResult).toBe('failed');
    expect(flagValues[RUNTIME_FLAGS.BACKUP_LAST_ERROR]).toBeUndefined();
  });
});

describe('BackupScheduler.hydrate', () => {
  /**
   * Drills are weekly, restarts are not. Without the verdict a recent
   * `lastDrillAt` sits beside a null result, and a drill that *failed* reads as
   * "no result" after the next deploy.
   */
  it('restores the last drill verdict, not just its timestamp', async () => {
    const { scheduler, flagValues } = makeScheduler();
    flagValues[RUNTIME_FLAGS.BACKUP_LAST_DRILL_AT] = '2026-08-19T03:00:00.000Z';
    flagValues[RUNTIME_FLAGS.BACKUP_LAST_DRILL_RESULT] = {
      ok: false,
      problems: ['Checksum does not match the manifest.'],
    };

    await scheduler.hydrate();

    expect(scheduler.stats.lastDrillAt).toBe('2026-08-19T03:00:00.000Z');
    expect(scheduler.stats.lastDrillResult).toBe('failed');
    expect(scheduler.stats.lastDrillProblems).toEqual(['Checksum does not match the manifest.']);
  });

  it('survives a fleet that has never drilled', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.hydrate();
    expect(scheduler.stats.lastDrillAt).toBeNull();
    expect(scheduler.stats.lastDrillResult).toBeNull();
  });
});
