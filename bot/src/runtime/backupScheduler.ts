import {
  BackupStorage,
  isBackupDue,
  nextDueAt,
  runBackup,
  withBackupLock,
  RUNTIME_FLAGS,
  type Database,
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
  db: Database;
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
    };
  };
  appVersion: string;
  commit: string;
  report: (message: string, context: Record<string, unknown>) => void;
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
  lastRunAt: string | null;
  lastStatus: 'ok' | 'failed' | null;
  lastKey: string | null;
  lastSizeBytes: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextDueAt: string | null;
  stale: boolean;
}

/** How often to *check*. The due calculation decides whether to act. */
const CHECK_INTERVAL_MS = 15 * 60_000;

export class BackupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;

  private lastRunAt: Date | null = null;
  private lastStatus: 'ok' | 'failed' | null = null;
  private lastKey: string | null = null;
  private lastSizeBytes: number | null = null;
  private lastDurationMs: number | null = null;
  private lastError: string | null = null;

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
      running: this.inFlight !== undefined,
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
      if (!Number.isNaN(parsed.getTime())) this.lastRunAt = parsed;
    }
  }

  async tick(): Promise<void> {
    if (this.stopping || this.inFlight) return;

    const flags = await this.deps.flags.getAll().catch(() => ({}) as Record<string, unknown>);
    if (flags[RUNTIME_FLAGS.GLOBAL_PAUSE] === true) return;
    if (flags[RUNTIME_FLAGS.BACKUP_DISABLED] === true) return;

    // Re-read the shared stamp every tick: another instance may have been the
    // leader since last time, and its success is ours too.
    const stamp = flags[RUNTIME_FLAGS.BACKUP_LAST_COMPLETED_AT];
    if (typeof stamp === 'string') {
      const parsed = new Date(stamp);
      if (!Number.isNaN(parsed.getTime())) this.lastRunAt = parsed;
    }

    const { intervalHours, preferredHourUtc } = this.deps.config.backup;
    if (
      !isBackupDue({
        now: new Date(),
        lastCompletedAt: this.lastRunAt,
        intervalHours,
        preferredHourUtc,
      })
    ) {
      return;
    }

    this.inFlight = this.runOnce().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  /**
   * Takes one backup if this instance wins the lock. Exposed so an operator can
   * force a run without waiting for the schedule.
   */
  async runOnce(): Promise<void> {
    const { db, fleet, logger, config, flags, opsAudit } = this.deps;
    const storage = new BackupStorage(config.backup);

    try {
      const outcome = await withBackupLock(db, fleet, async () => {
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
      if (this.lastError === null) {
        await flags
          .set(RUNTIME_FLAGS.BACKUP_LAST_ERROR, null, { actor: 'backup-scheduler' })
          .catch(() => {});
      }
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
        this.deps.report('Backup retention could not prune', {
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
      this.deps.report('Postgres backup failed', { error: message });
    } finally {
      storage.destroy();
    }
  }
}
