import {
  DEFAULT_LENIENCY_CONFIG,
  evaluateLeniency,
  isCountDiscrepant,
  parseBillingMeta,
  RUNTIME_FLAGS,
  subscriptionInGoodStanding,
  trialDurationMs,
  trialPolicyFor,
  utcDayKey,
  type BillingNotificationRepository,
  type BillingRunRepository,
  type Fleet,
  type GuildRepository,
  type GuildRow,
  type GuildSettingsStore,
  type LeniencyConfig,
  type LeniencyDecision,
  type LeniencyState,
  type Logger,
  type OpsAuditRepository,
  type RuntimeFlagsRepository,
  NOTIFICATION_TTL_MS,
  type SubscriptionRepository,
} from '@avc/core';
import type { BillingNotifier } from './notifier.js';

export interface BillingReconcilerDeps {
  guilds: GuildRepository;
  /** Write-through store (SettingsCache) so transitions invalidate cluster-wide. */
  store: GuildSettingsStore;
  subscriptions: SubscriptionRepository;
  runs: BillingRunRepository;
  /** The durable hand-off between the advance pass and whoever can deliver. */
  notifications: BillingNotificationRepository;
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
  /** Which fleet this instance belongs to. Decides what it may deliver. */
  fleet: Fleet;
  /** How often the job ticks. Default 60 min. */
  intervalMs?: number;
  /** Min spacing between cluster-wide advance passes. Default 55 min. */
  advanceSpacingMs?: number;
  /** Guilds per DB page in the advance pass. Default 200. */
  batchSize?: number;
  /** Notifications drained per tick, per instance. Default 200. */
  deliverBatch?: number;
  /** How long a queued notification stays worth sending. Default 3 days. */
  notificationTtlMs?: number;
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
  /** Newly queued by the advance pass (re-derived duplicates are not counted). */
  notificationsQueued: number;
  /** Delivered by THIS fleet. Not the same number as queued, by design. */
  notificationsSent: number;
  /** Given up on: nobody could reach the guild before the notice went stale. */
  notificationsExpired: number;
  /**
   * Undelivered notifications left in the queue after this instance's drain.
   *
   * The number that answers "is anything stuck". A non-zero depth that does not
   * fall is a guild no fleet can reach, or a fleet that cannot post in it.
   */
  notificationQueueDepth: number | null;
  errors: number;
}

const JOB_KEY = 'billing.advance';

/**
 * The trial/billing reconcile job (monetization.md §7): the background half of
 * decision 10's "time-based transitions". Three phases per tick:
 *
 * 1. **Sample** (every instance): record a daily member-count sample for each
 *    guild in this instance's gateway cache — each instance covers exactly the
 *    guilds its shards own.
 * 2. **Advance** (cluster singleton): under the billing advisory lock +
 *    durable spacing (`billing_runs`), walk every guild in the DB, backfill
 *    missing trial windows, run the pure leniency machine, validate any
 *    billing-affecting transition against a fresh authoritative member count
 *    (§5), apply it via `transitionAuth`, and **queue** the notifications due.
 * 3. **Deliver** (every instance, its own fleet only): drain the queue for
 *    guilds this fleet is actually in, send, and stamp the dedupe key.
 *
 * **Phases 2 and 3 are separate because different bots do them**
 * (`plans/fleets.md` §4). Advancement is fleet-wide work on shared rows, so
 * exactly one instance in the whole cluster may do it, across both fleets.
 * Delivery needs a bot that is in the guild, and the winner of that lock may
 * not be. They were one loop until 2026-08-19, which worked only for as long as
 * there was one fleet: with beta and prod both up, a guild advanced by the
 * fleet that cannot see it would never be told, silently and permanently.
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
  private readonly deliverBatch: number;
  private readonly notificationTtlMs: number;
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
    notificationsQueued: 0,
    notificationsSent: 0,
    notificationsExpired: 0,
    notificationQueueDepth: null,
    errors: 0,
  };

  constructor(private readonly deps: BillingReconcilerDeps) {
    this.intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
    this.advanceSpacingMs = deps.advanceSpacingMs ?? 55 * 60 * 1000;
    this.batchSize = deps.batchSize ?? 200;
    this.deliverBatch = deps.deliverBatch ?? 200;
    this.notificationTtlMs = deps.notificationTtlMs ?? NOTIFICATION_TTL_MS;
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

      /**
       * Advancing is opt-out per fleet, delivering is not.
       *
       * The shared advisory lock already makes advancement a cluster
       * singleton, so this flag is belt to that braces: it lets an operator
       * say which fleet is allowed to try, which is what `plans/fleets.md` §4
       * means by "config decides which". Checked here rather than inside
       * `advancePhase` so a disabled fleet does not consume the reservation
       * window and leave the enabled one waiting for the next one.
       */
      if (!(await this.deps.flags.getBool(RUNTIME_FLAGS.BILLING_ADVANCE_DISABLED))) {
        const reserved = await this.deps.runs.reserveRun(
          JOB_KEY,
          this.advanceSpacingMs,
          this.deps.instanceId,
        );
        if (reserved.ok) await this.advancePhase();
      }

      /**
       * Outside the reservation, deliberately.
       *
       * Delivery is this fleet's own work and must run on every tick of every
       * instance, whether or not it won the cluster-wide advance lock. Putting
       * it behind the reservation would hand delivery back to the single
       * instance that cannot necessarily reach the guilds, which is the bug
       * this phase exists to fix.
       */
      await this.deliverPhase();
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

    /**
     * Delivered rows are history, kept for a month.
     *
     * "Did that guild actually get the warning" is the first question asked
     * when a customer disputes a hard gate, and the dedupe map in guild
     * metadata records only that a key was stamped, not which fleet sent it or
     * how many attempts it took. Pruned here rather than in the deliver phase
     * so it runs once cluster-wide instead of once per instance per fleet.
     */
    try {
      const cutoff = new Date(this.now().getTime() - 30 * 86_400_000);
      await this.deps.notifications.pruneDelivered(cutoff);
    } catch (err) {
      this.deps.logger.warn({ err }, 'billing notification prune failed');
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

    /**
     * Queued, not sent. This pass is the cluster singleton and may be running
     * on a fleet that is not in this guild; whichever fleet is picks it up in
     * its own deliver phase. `enqueue` returns false for a notification already
     * pending, which is the common case rather than an error: the ladder keeps
     * re-deriving it every hour until a delivery stamps the dedupe key.
     */
    for (const notification of decision.notifications) {
      const queued = await this.deps.notifications.enqueue(
        current.guildId,
        notification,
        current.memberCount ?? 0,
        { at: now, ttlMs: this.notificationTtlMs },
      );
      if (queued) this.stats.notificationsQueued += 1;
    }
  }

  /**
   * Phase 3 — deliver what this fleet can reach.
   *
   * Runs on every instance every tick. The claim is fleet-scoped in SQL (a join
   * against `guild_fleet_presence`), so an instance never even sees a
   * notification for a guild its bot is not in, and `SKIP LOCKED` keeps two
   * instances of the same fleet from double-sending.
   */
  private async deliverPhase(): Promise<void> {
    const now = this.now();

    /**
     * Expire before claiming.
     *
     * A stale notice is worse than none: "your trial ends in 7 days" arriving
     * after it ended is actively misleading, and the guild has by then had the
     * hard-gate message too. Dropping them first also keeps a permanently
     * unreachable guild from occupying the head of the queue.
     */
    try {
      const expired = await this.deps.notifications.expire(now);
      for (const row of expired) {
        this.stats.notificationsExpired += 1;
        // Loud, because this is the giving-up path. A guild that silently never
        // heard it was about to be gated is the exact failure the queue exists
        // to prevent, so it must not also be the quiet one.
        this.deps.logger.warn(
          { guildId: row.guildId, key: row.key, attempts: row.attempts },
          'billing notification expired undelivered',
        );
        /**
         * Audited only if somebody actually tried.
         *
         * Zero attempts means no fleet could ever claim it, which is a
         * presence fact about the guild, not a delivery failure, and it
         * repeats: the dedupe stamp is written on delivery, so the ladder
         * re-derives an undelivered notification forever and `expire` deletes
         * it, so the pair re-runs every TTL. Auditing that would write an
         * `ops_audit` row per unreachable guild every few days, permanently,
         * until `v_recent_ops` and the admin activity feed showed nothing
         * else. The count still surfaces on `/diagnostics`, and the warn above
         * still fires.
         */
        if (row.attempts === 0) continue;
        await this.deps.opsAudit
          .record({
            actor: 'billing-reconciler',
            action: 'billing.notification.expired',
            target: row.guildId,
            details: { key: row.key, attempts: row.attempts },
          })
          .catch((err: unknown) => {
            this.deps.logger.warn({ err, guildId: row.guildId }, 'expiry audit failed');
          });
      }
    } catch (err) {
      this.stats.errors += 1;
      this.deps.logger.error({ err }, 'billing notification expiry failed');
    }

    let claimed;
    try {
      claimed = await this.deps.notifications.claimForFleet(
        this.deps.fleet,
        this.deliverBatch,
        now,
      );
    } catch (err) {
      this.stats.errors += 1;
      this.deps.logger.error({ err }, 'billing notification claim failed');
      return;
    }

    for (const row of claimed) {
      if (this.stopping) return;
      try {
        /**
         * Has somebody already sent this?
         *
         * The queue row and the dedupe stamp are separate records and can
         * disagree. The way they disagree in practice is a rolling deploy or a
         * fleet running an older build: a pre-split build delivers inline and
         * stamps the key without knowing this table exists, and the row it did
         * not enqueue is still sitting here waiting to be sent a second time.
         *
         * The comparison is "stamped at or after this row was queued", not
         * "stamped at all". `grace_nudge` is re-sent weekly and its stamp is
         * refreshed on every delivery, so a bare presence check would treat
         * last week's nudge as this week's and silence the ladder for good.
         */
        if (await this.alreadyDelivered(row.guildId, row.key, row.enqueuedAt)) {
          await this.deps.notifications.markDelivered(row.id, this.deps.fleet, now);
          continue;
        }

        const delivered = await this.deps.notifier.notifyGuild(
          row.guildId,
          row.notification,
          row.memberCount,
        );
        if (!delivered) {
          // Left pending on purpose. Presence said this fleet is in the guild,
          // so a failure here is a permissions or transient problem, not the
          // wrong fleet, and a later tick is a fair retry. Expiry is the stop.
          await this.deps.notifications.markFailed(row.id, 'delivery returned false', now);
          continue;
        }
        /**
         * Stamp the dedupe key first, then mark the row delivered.
         *
         * This order can double-send if the process dies between them, and the
         * other order can silence a notification that was never sent. A guild
         * seeing the same notice twice is a nuisance; a guild never warned
         * before its hard gate is the failure this phase exists to prevent.
         */
        await this.deps.guilds.recordBillingNotification(row.guildId, row.key, now);
        await this.deps.notifications.markDelivered(row.id, this.deps.fleet, now);
        this.stats.notificationsSent += 1;
      } catch (err) {
        this.stats.errors += 1;
        this.deps.logger.error(
          { err, guildId: row.guildId, key: row.key },
          'billing notification delivery failed (isolated)',
        );
        /**
         * The row is left exactly as the claim left it, on purpose.
         *
         * A throw can come from either side of the send, and `markFailed`
         * would shorten the lease on a row whose message may already have gone
         * out, so the next drain re-sends it. Letting the full lease stand
         * costs a few minutes of delay in the case where nothing was sent, and
         * buys the dedupe re-check above the time it needs to notice the case
         * where something was.
         */
      }
    }

    try {
      this.stats.notificationQueueDepth = await this.deps.notifications.pending(now);
    } catch (err) {
      this.deps.logger.debug({ err }, 'billing notification depth read failed');
    }
  }

  /**
   * Whether this notification key was stamped at or after the row was queued.
   *
   * Reads the guild's own dedupe map rather than trusting the queue, because
   * the two can disagree whenever something outside the queue delivered the
   * message (a pre-split build, or a crash between the stamp and the mark).
   */
  private async alreadyDelivered(guildId: string, key: string, enqueuedAt: Date): Promise<boolean> {
    const row = await this.deps.guilds.get(guildId);
    if (!row) return false;
    const stampedAt = parseBillingMeta(row.metadata).notifications[key];
    if (stampedAt === undefined) return false;
    const at = Date.parse(stampedAt);
    // An unparseable stamp is treated as absent: re-sending is recoverable,
    // silencing a warning that was never sent is not.
    return !Number.isNaN(at) && at >= enqueuedAt.getTime();
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
      hasSubscription: subscription !== undefined,
      subscriptionOk: subscription ? subscriptionInGoodStanding(subscription) : false,
      memberCount: row.memberCount,
      samples: meta.samples,
      guildCreatedAt: row.createdAt,
      notifications: meta.notifications,
    };
    return evaluateLeniency(state, now, config);
  }
}
