import {
  DEFAULT_LENIENCY_CONFIG,
  evaluateLeniency,
  isCountDiscrepant,
  parseBillingMeta,
  RUNTIME_FLAGS,
  SUBSCRIPTION_OK_STATUSES,
  trialDurationMs,
  trialPolicyFor,
  utcDayKey,
  type BillingRunRepository,
  type GuildRepository,
  type GuildRow,
  type GuildSettingsStore,
  type LeniencyConfig,
  type LeniencyDecision,
  type LeniencyState,
  type Logger,
  type OpsAuditRepository,
  type RuntimeFlagsRepository,
  type SubscriptionRepository,
} from '@avc/core';
import type { BillingNotifier } from './notifier.js';

export interface BillingReconcilerDeps {
  guilds: GuildRepository;
  /** Write-through store (SettingsCache) so transitions invalidate cluster-wide. */
  store: GuildSettingsStore;
  subscriptions: SubscriptionRepository;
  runs: BillingRunRepository;
  flags: RuntimeFlagsRepository;
  opsAudit: OpsAuditRepository;
  notifier: BillingNotifier;
  /** Member counts from this instance's gateway cache (the daily sampler). */
  listCachedGuildCounts: () => { guildId: string; memberCount: number }[];
  /**
   * Fresh authoritative count via REST `GET /guilds/{id}?with_counts=true`
   * (§5 step 3). Null = unavailable → the transition is skipped this run.
   */
  fetchAuthoritativeCount: (guildId: string) => Promise<number | null>;
  logger: Logger;
  instanceId: string;
  /** How often the job ticks. Default 60 min. */
  intervalMs?: number;
  /** Min spacing between cluster-wide advance passes. Default 55 min. */
  advanceSpacingMs?: number;
  /** Guilds per DB page in the advance pass. Default 200. */
  batchSize?: number;
  now?: () => Date;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface BillingRunStats {
  lastRunAt: string | null;
  lastAdvanceAt: string | null;
  sampled: number;
  advanced: number;
  transitions: number;
  notificationsSent: number;
  errors: number;
}

const JOB_KEY = 'billing.advance';

/**
 * The trial/billing reconcile job (monetization.md §7): the background half of
 * decision 10's "time-based transitions". Two phases per tick:
 *
 * 1. **Sample** (every instance): record a daily member-count sample for each
 *    guild in this instance's gateway cache — each instance covers exactly the
 *    guilds its shards own.
 * 2. **Advance** (cluster singleton): under the billing advisory lock +
 *    durable spacing (`billing_runs`), walk every guild in the DB, backfill
 *    missing trial windows, run the pure leniency machine, validate any
 *    billing-affecting transition against a fresh authoritative member count
 *    (§5), apply it via `transitionAuth`, and deliver+record notifications.
 *
 * Every step is idempotent and per-guild fault-isolated; the whole job is a
 * no-op under `global.pause` or `billing.reconcile_disabled`.
 */
export class BillingReconciler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private inflight: Promise<void> | undefined;
  private readonly intervalMs: number;
  private readonly advanceSpacingMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  /** Per-guild UTC day of the last recorded sample (skip re-sampling all day). */
  private readonly sampledDay = new Map<string, string>();
  readonly stats: BillingRunStats = {
    lastRunAt: null,
    lastAdvanceAt: null,
    sampled: 0,
    advanced: 0,
    transitions: 0,
    notificationsSent: 0,
    errors: 0,
  };

  constructor(private readonly deps: BillingReconcilerDeps) {
    this.intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
    this.advanceSpacingMs = deps.advanceSpacingMs ?? 55 * 60 * 1000;
    this.batchSize = deps.batchSize ?? 200;
    this.now = deps.now ?? (() => new Date());
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  /** Starts the periodic tick. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      void this.runOnce().catch((err: unknown) => {
        this.deps.logger.error({ err }, 'billing reconcile tick failed');
      });
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Stops the timer AND awaits any in-flight pass (checked per guild via the
   * stopping flag, so a long fleet sweep bails within one guild's work) —
   * graceful drain must not close the DB pool under a running pass.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    await this.inflight;
  }

  /** One full tick: sample, then (if this instance wins the lock) advance. */
  runOnce(): Promise<void> {
    if (this.running || this.stopping) return this.inflight ?? Promise.resolve();
    this.inflight = this.runGuarded();
    return this.inflight;
  }

  private async runGuarded(): Promise<void> {
    this.running = true; // a slow pass must never overlap itself
    try {
      if (await this.deps.flags.getBool(RUNTIME_FLAGS.BILLING_RECONCILE_DISABLED)) return;
      if (await this.deps.flags.getBool(RUNTIME_FLAGS.GLOBAL_PAUSE)) return;
      this.stats.lastRunAt = this.now().toISOString();

      await this.samplePhase();

      const reserved = await this.deps.runs.reserveRun(
        JOB_KEY,
        this.advanceSpacingMs,
        this.deps.instanceId,
      );
      if (!reserved.ok) return;
      await this.advancePhase();
    } finally {
      this.running = false;
      this.inflight = undefined;
    }
  }

  /** Phase 1 — record today's member-count sample for this instance's guilds. */
  private async samplePhase(): Promise<void> {
    const at = this.now();
    const today = utcDayKey(at);
    for (const { guildId, memberCount } of this.deps.listCachedGuildCounts()) {
      if (this.stopping) return;
      if (memberCount <= 0) continue; // an uncached/empty count is no signal
      if (this.sampledDay.get(guildId) === today) continue;
      try {
        await this.deps.guilds.recordMemberCountSample(guildId, memberCount, { at });
        this.sampledDay.set(guildId, today);
        this.stats.sampled += 1;
      } catch (err) {
        this.stats.errors += 1;
        this.deps.logger.warn({ err, guildId }, 'member-count sample failed');
      }
    }
  }

  /** Phase 2 — advance the leniency ladder for every guild (cluster singleton). */
  private async advancePhase(): Promise<void> {
    const config = await this.readConfig();
    this.stats.lastAdvanceAt = this.now().toISOString();
    let after: string | undefined;
    for (;;) {
      // Termination is on RAW-page exhaustion (lastGuildId), not parsed rows:
      // a page whose rows all failed validation is quarantined, not a stop.
      const { rows, lastGuildId } = await this.deps.guilds.listBatch(after, this.batchSize);
      for (const row of rows) {
        if (this.stopping) return;
        try {
          await this.advanceGuild(row, config);
          this.stats.advanced += 1;
        } catch (err) {
          // Per-guild isolation: one bad guild never stops the sweep.
          this.stats.errors += 1;
          this.deps.logger.error(
            { err, guildId: row.guildId },
            'billing advance failed (isolated)',
          );
        }
      }
      if (!lastGuildId) break;
      after = lastGuildId;
    }
  }

  /** Leniency durations/windows from runtime flags (tunable without a deploy). */
  private async readConfig(): Promise<LeniencyConfig> {
    const flags = await this.deps.flags.getAll();
    const num = (key: string, fallback: number): number => {
      const value = flags[key];
      return typeof value === 'number' && value > 0 ? value : fallback;
    };
    return {
      ...DEFAULT_LENIENCY_CONFIG,
      graceDays: num(RUNTIME_FLAGS.BILLING_GRACE_DAYS, DEFAULT_LENIENCY_CONFIG.graceDays),
      upgradeBreachSamples: num(
        RUNTIME_FLAGS.BILLING_UPGRADE_BREACH_SAMPLES,
        DEFAULT_LENIENCY_CONFIG.upgradeBreachSamples,
      ),
      downgradeDropSamples: num(
        RUNTIME_FLAGS.BILLING_DOWNGRADE_DROP_SAMPLES,
        DEFAULT_LENIENCY_CONFIG.downgradeDropSamples,
      ),
      hardGateDisabled: flags[RUNTIME_FLAGS.BILLING_HARD_GATE_DISABLED] === true,
    };
  }

  private async advanceGuild(row: GuildRow, config: LeniencyConfig): Promise<void> {
    const now = this.now();
    if (row.authStatus === 'blocked') return;

    let current = row;
    // Backfill the trial window for rows that predate onboarding (§0 Phase 1:
    // the clock started when the bot was first added — the row's creation).
    if (current.authStatus === 'trial' && current.authExpiresAt === null) {
      // No sample yet → no signal to pick a policy; leave the row for
      // onboarding (fresh joins) or a later pass once sampling caught up.
      if (current.memberCount === null) return;
      const policy = trialPolicyFor(current.memberCount);
      // The at-add count is unrecorded for pre-onboarding rows, and §3 says a
      // guild that GREW past 10k keeps its year window (the 14-day clock is
      // only for servers that join already large) — so never retro-apply it.
      const effectivePolicy = policy === 'short' ? 'year' : policy;
      const duration = trialDurationMs(effectivePolicy);
      // hard_gate joins are handled by onboarding; a pre-existing giant guild
      // mid-beta is left alone rather than retro-gated by the backfill.
      if (duration !== null) {
        current = await this.deps.store.transitionAuth({
          guildId: current.guildId,
          toStatus: 'trial',
          reason: `trial_window_backfill:${effectivePolicy}`,
          actor: 'billing-reconciler',
          expiresAtIfNull: new Date(current.createdAt.getTime() + duration),
        });
      } else {
        return;
      }
    }

    let decision = await this.evaluate(current, now, config);

    if (decision.transition?.requiresCountValidation) {
      // §5 steps 3–5: the fresh authoritative read is THE tie-breaker before
      // any billing-affecting transition — always adopted and re-evaluated,
      // even inside the discrepancy threshold (a small disagreement can still
      // straddle a tier boundary). Unavailable → wait for the next run.
      const authoritative = await this.deps.fetchAuthoritativeCount(current.guildId);
      if (authoritative === null) {
        this.deps.logger.warn(
          { guildId: current.guildId, transition: decision.transition.reason },
          'authoritative member count unavailable; deferring transition',
        );
        return;
      }
      const cached = current.memberCount ?? 0;
      const { row: corrected } = await this.deps.guilds.recordMemberCountSample(
        current.guildId,
        authoritative,
        { at: now, authoritative: true },
      );
      if (isCountDiscrepant(cached, authoritative)) {
        await this.deps.opsAudit.record({
          actor: 'billing-reconciler',
          action: 'member_count.discrepancy',
          target: current.guildId,
          details: { cached, authoritative },
        });
      }
      current = corrected;
      decision = await this.evaluate(current, now, config);
    }

    if (decision.transition) {
      const t = decision.transition;
      await this.deps.store.transitionAuth({
        guildId: current.guildId,
        toStatus: t.toStatus,
        reason: t.reason,
        actor: 'billing-reconciler',
        ...(t.graceUntil !== undefined ? { graceUntil: t.graceUntil } : {}),
      });
      this.stats.transitions += 1;
    }

    for (const notification of decision.notifications) {
      const delivered = await this.deps.notifier.notifyGuild(
        current.guildId,
        notification,
        current.memberCount ?? 0,
      );
      if (delivered) {
        await this.deps.guilds.recordBillingNotification(current.guildId, notification.key, now);
        this.stats.notificationsSent += 1;
      }
    }
  }

  private async evaluate(
    row: GuildRow,
    now: Date,
    config: LeniencyConfig,
  ): Promise<LeniencyDecision> {
    // The subscription row only matters once a billed tier exists (Paddle).
    const subscription = row.tier
      ? await this.deps.subscriptions.getByGuild(row.guildId)
      : undefined;
    const meta = parseBillingMeta(row.metadata);
    const state: LeniencyState = {
      authStatus: row.authStatus,
      authExpiresAt: row.authExpiresAt,
      graceUntil: row.graceUntil,
      billedTier: row.tier,
      subscriptionOk: subscription ? SUBSCRIPTION_OK_STATUSES.has(subscription.status) : false,
      memberCount: row.memberCount,
      samples: meta.samples,
      guildCreatedAt: row.createdAt,
      notifications: meta.notifications,
    };
    return evaluateLeniency(state, now, config);
  }
}
