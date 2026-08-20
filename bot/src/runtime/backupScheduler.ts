import {
  BackupStorage,
  isBackupDue,
  nextDueAt,
  runBackup,
  runDrill,
  withBackupLock,
  withDrillLock,
  RUNTIME_FLAGS,
  type DbPool,
  type DrillResult,
  type Fleet,
  type OpsAuditRepository,
  type RuntimeFlagsRepository,
} from '@avc/core';
import type { Logger } from 'pino';

/**
 * The in-process backup scheduler (`plans/backups.md` §5).
 *
 * In-process rather than a cron container, and that single choice is what makes
 * production and self-host genuinely the same system: a self-hoster gets
 * backups from `docker compose up` with nothing else to run, and production
 * needs no scheduled machine.
 *
 * Follows the existing job pattern here (`setInterval(...).unref()`, started
 * after the drain handler, stopped on shutdown). Backups never begin during
 * drain, and one in flight is awaited rather than killed.
 */

export interface BackupSchedulerDeps {
  /**
   * The pool, not a `Database`. Leader election pins one client for the length
   * of a backup, which a per-statement query runner cannot do
   * (`withBackupLock`).
   */
  pool: DbPool;
  fleet: Fleet;
  flags: RuntimeFlagsRepository;
  opsAudit: OpsAuditRepository;
  logger: Logger;
  config: {
    databaseUrl: string;
    instanceId: string;
    nodeEnv: string;
    backup: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      encryptionKey?: string | undefined;
      intervalHours: number;
      preferredHourUtc: number;
      retention: { daily: number; weekly: number; monthly: number };
      prefix?: string | undefined;
      drillIntervalHours: number;
      drillDatabaseUrl?: string | undefined;
    };
  };
  appVersion: string;
  commit: string;
  report: (kind: string, message: string, context: Record<string, unknown>) => void;
  /** Manifest metadata. Injected so the bot needs no SQL of its own. */
  probe: () => Promise<{
    pgServerVersion: string | null;
    migrationVersion: string | null;
    rowCounts: Record<string, number>;
  }>;
}

export interface BackupSchedulerStats {
  enabled: boolean;
  running: boolean;
  drilling: boolean;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null;
  lastKey: string | null;
  lastSizeBytes: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextDueAt: string | null;
  stale: boolean;
  lastDrillAt: string | null;
  lastDrillResult: 'passed' | 'failed' | null;
  lastDrillProblems: string[];
  nextDrillDueAt: string | null;
}

/** How often to *check*. The due calculation decides whether to act. */
const CHECK_INTERVAL_MS = 15 * 60_000;

/** A flag value that should be an ISO timestamp, or null if it is not one. */
function readStamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  /** Which job `inFlight` is, so `/diagnostics` does not call a drill a backup. */
  private inFlightKind: 'backup' | 'drill' | undefined;
  private stopping = false;

  private lastRunAt: Date | null = null;
  private lastStatus: 'ok' | 'failed' | null = null;
  private lastKey: string | null = null;
  private lastSizeBytes: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;
  private lastDrillAt: Date | null = null;
  private lastDrillResult: 'passed' | 'failed' | null = null;
  private lastDrillProblems: string[] = [];

  constructor(private readonly deps: BackupSchedulerDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  /**
   * Stops scheduling and waits for any dump already running.
   *
   * Awaited rather than aborted: a half-uploaded object with no manifest is
   * worse than a deploy that takes another minute, and the next boot would have
   * no way to tell it apart from a good one.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inFlight) {
      this.deps.logger.info('waiting for in-flight backup to finish before shutdown');
      await this.inFlight.catch(() => {});
    }
  }

  get stats(): BackupSchedulerStats {
    const { intervalHours, preferredHourUtc } = this.deps.config.backup;
    const next = nextDueAt({ lastCompletedAt: this.lastRunAt, intervalHours, preferredHourUtc });
    return {
      enabled: true,
      running: this.inFlightKind === 'backup',
      drilling: this.inFlightKind === 'drill',
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastStatus: this.lastStatus,
      lastKey: this.lastKey,
      lastSizeBytes: this.lastSizeBytes,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      nextDueAt: next?.toISOString() ?? null,
      // Informational only. A stale backup must never gate a rollout, so this
      // is reported and alerted on, never returned as unhealthy (section 8).
      stale: this.isStale(),
      lastDrillAt: this.lastDrillAt?.toISOString() ?? null,
      lastDrillResult: this.lastDrillResult,
      lastDrillProblems: this.lastDrillProblems,
      nextDrillDueAt:
        nextDueAt({
          lastCompletedAt: this.lastDrillAt,
          intervalHours: this.deps.config.backup.drillIntervalHours,
          preferredHourUtc,
        })?.toISOString() ?? null,
    };
  }

  isStale(): boolean {
    if (!this.lastRunAt) return false;
    const ageHours = (Date.now() - this.lastRunAt.getTime()) / 3_600_000;
    return ageHours > this.deps.config.backup.intervalHours * 1.5;
  }

  /** Loads the fleet-wide last-success stamp, so a leader change neither
   * double-runs nor skips. */
  async hydrate(): Promise<void> {
    const raw = await this.deps.flags.get(RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT).catch(() => null);
    if (typeof raw === 'string') {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        this.lastRunAt = parsed;
        // The stamp is only written on success, so its presence *is* the
        // status. Leaving it null rendered a real backup as "ran at 06:22,
        // outcome unknown" on every `/diagnostics` after a restart.
        this.lastStatus = 'ok';
      }
    }

    // Written on failure and deleted on the next success, so its presence
    // means the most recent attempt is the one that failed.
    const failure = await this.deps.flags.get(RUNTIME_FLAGS.BACKUP_LAST_ERROR).catch(() => null);
    if (typeof failure === 'string') {
      this.lastError = failure;
      this.lastStatus = 'failed';
    }
    const drilled = await this.deps.flags.get(RUNTIME_FLAGS.BACKUP_LAST_DRILL_AT).catch(() => null);
    if (typeof drilled === 'string') {
      const parsed = new Date(drilled);
      if (!Number.isNaN(parsed.getTime())) this.lastDrillAt = parsed;
    }

    /**
     * The drill's verdict, not just its timestamp.
     *
     * Drills are weekly and machine restarts are not, so without this the
     * steady state on `/diagnostics` is a recent `lastDrillAt` beside a null
     * result. Worse, a drill that *failed* would read as "no result" after the
     * next deploy, which is the one rendering that must not happen. Both
     * READMEs point operators at this field.
     */
    const verdict = await this.deps.flags
      .get<{ ok?: boolean; problems?: string[] }>(RUNTIME_FLAGS.BACKUP_LAST_DRILL_RESULT)
      .catch(() => null);
    if (verdict && typeof verdict === 'object') {
      this.lastDrillResult = verdict.ok === true ? 'passed' : 'failed';
      this.lastDrillProblems = Array.isArray(verdict.problems) ? verdict.problems : [];
    }
  }

  async tick(): Promise<void> {
    if (this.stopping || this.inFlight) return;

    const flags = await this.deps.flags.getAll().catch(() => ({}) as Record<string, unknown>);
    if (flags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true) return;

    // Re-read the shared stamps every tick: another instance may have been the
    // leader since last time, and its success is ours too.
    this.lastRunAt = readStamp(flags[RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT]) ?? this.lastRunAt;
    this.lastDrillAt = readStamp(flags[RUNTIME_FLAGS.BACKUP_LAST_DRILL_AT]) ?? this.lastDrillAt;

    const { intervalHours, preferredHourUtc, drillIntervalHours } = this.deps.config.backup;
    const now = new Date();

    const backupDisabled = flags[RUNTIME_FLAGS.BACKUP_DISABLED] === true;
    if (
      !backupDisabled &&
      isBackupDue({ now, lastCompletedAt: this.lastRunAt, intervalHours, preferredHourUtc })
    ) {
      await this.guard('backup', () => this.runOnce());
      /**
       * One heavy job per tick, but only when the backup actually produced
       * one. The drill is weekly and the next check is fifteen minutes away,
       * so deferring costs nothing, and stacking a full download onto a
       * just-finished dump on a shared-cpu-1x machine is not free.
       *
       * **Returning unconditionally here starved the drill forever.** A failed
       * backup does not advance `lastRunAt`, by design, so `isBackupDue` stays
       * true on every subsequent tick and this branch would be taken every
       * time. The drill would never run again, which loses precisely the
       * signal that matters most while backups are broken: is the last good
       * object still restorable.
       */
      if (this.lastStatus === 'ok') return;
    }

    if (flags[RUNTIME_FLAGS.BACKUP_DRILL_DISABLED] === true) return;
    // A drill with no backup to check is noise, not a finding.
    if (!this.lastRunAt) return;
    if (
      isBackupDue({
        now,
        lastCompletedAt: this.lastDrillAt,
        intervalHours: drillIntervalHours,
        preferredHourUtc,
      })
    ) {
      await this.guard('drill', () => this.drillOnce(backupDisabled));
    }
  }

  /** Runs one job at a time, and lets `stop()` wait for it. */
  private async guard(kind: 'backup' | 'drill', fn: () => Promise<void>): Promise<void> {
    // Re-checked here, not only at the top of the tick: `stop()` can land
    // during the flag read, and it only waits for work that is already in
    // flight. Without this a drain could start a job it will not wait for.
    if (this.stopping) return;
    this.inFlightKind = kind;
    this.inFlight = fn().finally(() => {
      this.inFlight = undefined;
      this.inFlightKind = undefined;
    });
    await this.inFlight;
  }

  /**
   * Takes one backup if this instance wins the lock. Exposed so an operator can
   * force a run without waiting for the schedule.
   */
  async runOnce(): Promise<void> {
    const { pool, fleet, logger, config, flags, opsAudit } = this.deps;
    const storage = new BackupStorage(config.backup);

    try {
      const outcome = await withBackupLock(pool, fleet, async () => {
        logger.info('backup starting');
        return runBackup({
          databaseUrl: config.databaseUrl,
          storage,
          prefix: config.backup.prefix ?? config.nodeEnv,
          env: config.nodeEnv,
          retention: config.backup.retention,
          encryptionKey: config.backup.encryptionKey,
          instanceId: config.instanceId,
          appVersion: this.deps.appVersion,
          commit: this.deps.commit,
          probe: () => this.deps.probe(),
          log: (event, data) => logger.info(data, event),
        });
      });

      // Another instance holds the lock. Not an error, and not our turn.
      if (!outcome.ran) return;

      const result = outcome.result;
      this.lastRunAt = new Date(result.manifest.createdAt);
      this.lastStatus = 'ok';
      this.lastKey = result.key;
      this.lastSizeBytes = result.manifest.sizeBytes;
      this.lastDurationMs = result.durationMs;
      this.lastError = null;

      // Each set() writes its own ops_audit row, so the flag change and the
      // audit trail cannot drift apart.
      await flags.set(RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT, result.manifest.createdAt, {
        actor: 'backup-scheduler',
      });
      await flags.set(
        RUNTIME_FLAGS.BACKUP_LAST_RESULT,
        {
          key: result.key,
          sizeBytes: result.manifest.sizeBytes,
          sha256: result.manifest.sha256,
          durationMs: result.durationMs,
          pruned: result.pruned.length,
        },
        { actor: 'backup-scheduler' },
      );
      // Removed rather than set to null: the column is NOT NULL, so the
      // previous `set(key, null)` raised inside its own catch and the last
      // failure was never actually cleared.
      await flags
        .clear(RUNTIME_FLAGS.BACKUP_LAST_ERROR, { actor: 'backup-scheduler' })
        .catch(() => {});
      await opsAudit.record({
        actor: 'backup-scheduler',
        action: 'backup.completed',
        target: result.key,
        details: { sizeBytes: result.manifest.sizeBytes, durationMs: result.durationMs },
      });

      logger.info(
        { key: result.key, sizeBytes: result.manifest.sizeBytes, durationMs: result.durationMs },
        'backup completed',
      );

      if (result.prunedFailed.length > 0) {
        // Not a backup failure, but it means the bucket grows forever if left.
        this.deps.report('backup.prune', 'Backup retention could not prune', {
          failed: result.prunedFailed.length,
        });
      }
    } catch (error) {
      const message = (error as Error).message;
      this.lastStatus = 'failed';
      this.lastError = message;
      logger.error({ err: error }, 'backup failed');

      await flags
        .set(RUNTIME_FLAGS.BACKUP_LAST_ERROR, message, { actor: 'backup-scheduler' })
        .catch(() => {});
      await opsAudit
        .record({
          actor: 'backup-scheduler',
          action: 'backup.failed',
          target: config.backup.bucket,
          details: { error: message },
        })
        .catch(() => {});
      this.deps.report('backup.failed', 'Postgres backup failed', { error: message });
    } finally {
      storage.destroy();
    }
  }

  /**
   * Runs one restore drill if this instance wins the drill lock
   * (`plans/backups.md` §9). Exposed so an operator can force one.
   *
   * **A failed drill is not a failed backup**, and the two are kept apart
   * deliberately: `backup.last_error` stays clear, `lastStatus` stays `ok`, and
   * nothing here can make a healthy backup look broken. What a failed drill
   * means is that the newest object may not restore, which is worth a loud
   * alert and nothing else.
   */
  async drillOnce(backupsDisabled = false): Promise<void> {
    const { pool, fleet, logger, config, flags, opsAudit } = this.deps;
    const storage = new BackupStorage(config.backup);

    try {
      const outcome = await withDrillLock(pool, fleet, async () => {
        logger.info('restore drill starting');
        return runDrill({
          storage,
          prefix: config.backup.prefix ?? config.nodeEnv,
          env: config.nodeEnv,
          encryptionKey: config.backup.encryptionKey,
          scratchDatabaseUrl: config.backup.drillDatabaseUrl,
          liveDatabaseUrl: config.databaseUrl,
          /**
           * The drill is weekly, so the newest backup should be a day old and
           * anything past the staleness threshold is itself the finding.
           *
           * Unless an operator switched backups off, in which case the object
           * being old is the thing they asked for. Reporting a deliberate
           * action as a fault every week trains people to ignore the alert,
           * and the rest of the drill still runs: is the newest object we do
           * have still restorable.
           */
          maxAgeHours: backupsDisabled ? Infinity : config.backup.intervalHours * 1.5,
          log: (event, data) => logger.info(data, event),
        });
      });

      if (!outcome.ran) return;
      await this.recordDrill(outcome.result);
    } catch (error) {
      // The drill itself broke, which is not the same as the backup failing to
      // verify, but it is equally a reason nobody should trust the bucket.
      const message = (error as Error).message;
      this.lastDrillAt = new Date();
      this.lastDrillResult = 'failed';
      this.lastDrillProblems = [message];
      logger.error({ err: error }, 'restore drill errored');
      await flags
        .set(RUNTIME_FLAGS.BACKUP_LAST_DRILL_AT, this.lastDrillAt.toISOString(), {
          actor: 'backup-scheduler',
        })
        .catch(() => {});
      await opsAudit
        .record({
          actor: 'backup-scheduler',
          action: 'backup.drill.failed',
          target: config.backup.bucket,
          details: { error: message },
        })
        .catch(() => {});
      this.deps.report('backup.drill.error', 'Backup restore drill could not run', {
        error: message,
      });
    } finally {
      storage.destroy();
    }
  }

  private async recordDrill(result: DrillResult): Promise<void> {
    const { flags, opsAudit, logger } = this.deps;
    this.lastDrillAt = new Date();
    this.lastDrillResult = result.ok ? 'passed' : 'failed';
    this.lastDrillProblems = result.problems;

    await flags.set(RUNTIME_FLAGS.BACKUP_LAST_DRILL_AT, this.lastDrillAt.toISOString(), {
      actor: 'backup-scheduler',
    });
    await flags.set(
      RUNTIME_FLAGS.BACKUP_LAST_DRILL_RESULT,
      {
        ok: result.ok,
        key: result.key,
        ageHours: result.ageHours,
        restored: result.restored,
        tablesInArchive: result.tablesInArchive.length,
        problems: result.problems,
        notes: result.notes,
        durationMs: result.durationMs,
      },
      { actor: 'backup-scheduler' },
    );
    await opsAudit.record({
      actor: 'backup-scheduler',
      action: result.ok ? 'backup.drill.passed' : 'backup.drill.failed',
      target: result.key ?? this.deps.config.backup.bucket,
      details: {
        restored: result.restored,
        problems: result.problems,
        notes: result.notes,
        durationMs: result.durationMs,
      },
    });

    if (result.ok) {
      /**
       * `notes` is logged, not just stored. A drill that passes only because
       * something was tolerated must leave a trace someone can find later --
       * otherwise the tolerance is invisible exactly where it matters most, on
       * the unattended weekly run rather than the CLI where a human is reading
       * the output anyway.
       */
      logger.info(
        {
          key: result.key,
          restored: result.restored,
          durationMs: result.durationMs,
          ...(result.notes.length ? { notes: result.notes } : {}),
        },
        'restore drill passed',
      );
      return;
    }

    logger.error({ key: result.key, problems: result.problems }, 'restore drill failed');
    this.deps.report('backup.drill.failed', 'Backup restore drill failed', {
      key: result.key,
      problems: result.problems.join(' | '),
    });
  }
}
