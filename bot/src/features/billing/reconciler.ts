import {
  DEFAULT_LENIENCY_CONFIG,
  evaluateLeniency,
  ENTITLED_STATUSES,
  guildFloor,
  isCountDiscrepant,
  parseBillingMeta,
  RUNTIME_FLAGS,
  subscriptionInGoodStanding,
  tierFor,
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
  type LeniencyNotification,
  type LeniencyState,
  type Logger,
  type MemberPoolGuildRepository,
  type MemberPoolRepository,
  type MemberPoolRow,
  type OpsAuditRepository,
  type PoolSubscriptionRow,
  type RuntimeFlagsRepository,
  NOTIFICATION_TTL_MS,
  type SubscriptionRepository,
} from '@avc/core';
import type { BillingNotifier } from './notifier.js';

/**
 * Leniency reasons whose notification stops service (or is the flip side of
 * that: service resuming) rather than merely nudging the purchaser about
 * money. These fan out to every live member guild, one row each, through the
 * ordinary guild-scoped queue (`plans/member-based-pricing.md` §6.6) — every
 * affected server must hear it, not one representative. Everything else
 * (payment failed, over limit, renewal reminders) is a billing event and goes
 * to the purchaser alone.
 *
 * **Adding a kind here needs `shared_member` copy for it in `messages.ts`.**
 * A fan-out row is guild-scoped but carries the POOL's member sum in
 * `memberCount`, and `notificationMessage` falls back to
 * `tierFor(memberCount)` whenever a notification has no explicit
 * `requiredTier`. Both kinds below are safe: the `shared_member` branch renders
 * no tier for either. A new kind without that branch would quote the whole
 * subscription's tier as if it were this one server's.
 */
const POOL_FAN_OUT_KINDS: ReadonlySet<LeniencyNotification['kind']> = new Set([
  'hard_gate',
  'reactivated',
]);

/**
 * Where a pool's members actually landed this tick.
 *
 * Notifications are derived from THIS rather than from the pool's own ladder
 * history, because a refund produces no ladder history at all: `applyRefund`
 * writes the pool `expired` straight from `active`, and `evaluateExpired` gates
 * its `hard_gate` on a `grace_*` key that a healthy subscription never had. So
 * today a refund tells nobody on either axis while `/refunds` promises the bot
 * stops. Both kinds are needed: narrowing only the stop notice would silently
 * kill reactivation notices too.
 */
interface PoolLanding {
  entitled: string[];
  gated: string[];
}

/** Leniency transition reasons that make things WORSE for the customer if the count is wrong. */
const POOL_UPGRADE_REASONS: ReadonlySet<string> = new Set(['over_limit', 'grace_elapsed']);

export interface BillingReconcilerDeps {
  guilds: GuildRepository;
  /** Write-through store (SettingsCache) so transitions invalidate cluster-wide. */
  store: GuildSettingsStore;
  subscriptions: SubscriptionRepository;
  runs: BillingRunRepository;
  /** The durable hand-off between the advance pass and whoever can deliver. */
  notifications: BillingNotificationRepository;
  flags: RuntimeFlagsRepository;
  memberPools: MemberPoolRepository;
  memberPoolGuilds: MemberPoolGuildRepository;
  /** The Discord snowflake behind an Auth.js user id, for purchaser DMs (§6.6). */
  resolveDiscordUserId: (authUserId: string) => Promise<string | null>;
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
  /**
   * Reports a significant condition to the operational alert channel. A tick
   * that throws silently stops sampling, advancing and delivering for this
   * instance until the next hour, with no user-visible symptom until
   * somebody's expiry notice never arrives, weeks later and untraceable.
   */
  report?: (kind: string, message: string, context: Record<string, unknown>) => void;
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
 * not be: a single loop would mean a guild advanced by a fleet that cannot
 * see it is never told, silently and permanently, whenever more than one
 * fleet is running.
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
        this.deps.report?.('billing.tick', 'Billing reconcile tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Stops the timer AND awaits any in-flight pass (checked per guild via the
   * stopping flag, so a long fleet sweep bails within one guild's work):
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

    /**
     * Pools first: pool aggregation is a prerequisite computation for the same
     * walk, not a separate job, so it belongs inside this one reservation
     * rather than racing it (`plans/member-based-pricing.md` §6.5). Standard,
     * unconditional behaviour — `global.pause` and
     * `billing.reconcile_disabled` already gate the whole job upstream of
     * this, and pooling carries no kill-switch of its own.
     */
    await this.advancePoolsPhase(config);

    let after: string | undefined;
    for (;;) {
      // Termination is on RAW-page exhaustion (lastGuildId), not parsed rows:
      // a page whose rows all failed validation is quarantined, not a stop.
      const { rows, lastGuildId } = await this.deps.guilds.listBatch(after, this.batchSize);
      for (const row of rows) {
        if (this.stopping) return;
        // Pooled guilds are evaluated exactly once per tick, by the pool pass
        // above, never by this walk too (§6.5). A guild whose OWN size is
        // still free (§5.3) is excluded from that pass and stays here,
        // because pooling never touches a free-forever guild's own state.
        if (row.poolId && tierFor(row.memberCount ?? 0).id !== 'free') continue;
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

  /**
   * Pool aggregation, walked before the per-guild loop
   * (`plans/member-based-pricing.md` §6.5). Runs inside the SAME reservation
   * as the per-guild walk — the pool pass is a prerequisite computation for
   * that walk, not a separate job — and must therefore be idempotent under
   * concurrent execution: the advisory lock only serializes the *reservation*
   * (`billingRuns.ts`), not the work, so a pass exceeding the 55-minute
   * spacing can overlap the next one.
   */
  private async advancePoolsPhase(config: LeniencyConfig): Promise<void> {
    let after: string | undefined;
    for (;;) {
      const { rows: pools, lastPoolId } = await this.deps.memberPools.listBatch(
        after,
        this.batchSize,
      );
      for (const pool of pools) {
        if (this.stopping) return;
        try {
          await this.advancePool(pool, config);
          this.stats.advanced += 1;
        } catch (err) {
          this.stats.errors += 1;
          this.deps.logger.error(
            { err, poolId: pool.id },
            'pool billing advance failed (isolated)',
          );
        }
      }
      if (!lastPoolId) break;
      after = lastPoolId;
    }
  }

  /**
   * Evaluates and converges ONE pool: aggregate its live, billable members'
   * counts, run the SAME pure leniency machine the per-guild walk uses (§5.2,
   * treating the pool as a single virtual entity), then fan the result out to
   * every member guild it actually changes something for.
   */
  private async advancePool(pool: MemberPoolRow, config: LeniencyConfig): Promise<void> {
    const now = this.now();
    const liveMemberships = await this.deps.memberPoolGuilds.listLive(pool.id);

    const memberGuilds: GuildRow[] = [];
    for (const membership of liveMemberships) {
      const guild = await this.deps.guilds.get(membership.guildId);
      if (guild) memberGuilds.push(guild);
    }
    /**
     * §5.3: a guild whose OWN count is still free-forever is entitled
     * regardless of the pool and contributes 0 to the pooled sum, whatever
     * else happens. Excluded here rather than merely zero-valued, so it is
     * never a fan-out target either — its own dormant trial state is untouched.
     */
    let billableGuilds = memberGuilds.filter((g) => tierFor(g.memberCount ?? 0).id !== 'free');
    const pooledSum = billableGuilds.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);

    /**
     * The pool's own forward-only sampler (§5.2a). `authoritative: true`
     * always: this sum is freshly derived from every live member's own count
     * on every tick, never a cached hint, so there is nothing for the anomaly
     * clamps to protect against.
     */
    let { row: current } = await this.deps.memberPools.recordMemberCountSample(pool.id, pooledSum, {
      at: now,
      authoritative: true,
    });

    const subscription = await this.deps.subscriptions.getByPoolId(pool.id);
    let state = this.poolLeniencyState(current, subscription, pooledSum);
    let decision = evaluateLeniency(state, now, config);

    if (decision.transition?.requiresCountValidation) {
      /**
       * The asymmetric resolution (§5.2b): capping the reads breaks the
       * upgrade invariant, so an upgrade needs a fresh read for EVERY live
       * member and defers the whole pool if any is unavailable. A downgrade
       * or reactivation proceeds on the samples alone — it fails in the
       * customer's favour either way.
       */
      if (POOL_UPGRADE_REASONS.has(decision.transition.reason)) {
        let freshSum = 0;
        for (const guild of billableGuilds) {
          const authoritative = await this.deps.fetchAuthoritativeCount(guild.guildId);
          if (authoritative === null) {
            this.deps.logger.warn(
              { poolId: pool.id, guildId: guild.guildId, transition: decision.transition.reason },
              'authoritative member count unavailable for a pool member; deferring pool transition',
            );
            return;
          }
          freshSum += authoritative;
          // Keep the guild's own recorded count current while we are here —
          // it is what the dashboard and `/setup` quote for this one server.
          await this.deps.guilds.recordMemberCountSample(guild.guildId, authoritative, {
            at: now,
            authoritative: true,
          });
        }
        ({ row: current } = await this.deps.memberPools.recordMemberCountSample(pool.id, freshSum, {
          at: now,
          authoritative: true,
        }));
        state = this.poolLeniencyState(current, subscription, freshSum);
        decision = evaluateLeniency(state, now, config);
        /**
         * Re-read the member rows, because the loop above just corrected their
         * counts and the array below was snapshotted BEFORE it.
         *
         * Harmless while the fan-out only used a stale count for a status diff.
         * Not harmless now: `guildFloor` reads `memberCount` to decide a STATUS,
         * so a member the same pass measured at 80 could be floored to `expired`
         * off a stale 5,000 and a free-forever server would be gated for a day.
         */
        billableGuilds = await this.reloadBillable(billableGuilds);
      }
    }

    if (decision.transition) {
      // A pool never holds `trial` (§5.4) or `blocked`. `evaluateLeniency`'s
      // free-forever reactivation path returns `trial`, which for a POOL
      // (a paid construct that shrank to nothing billable) means "keep
      // billing, nothing to gate" rather than a state the enum even has.
      const toStatus =
        decision.transition.toStatus === 'trial' ? 'active' : decision.transition.toStatus;
      const nextGraceUntil = decision.transition.graceUntil;
      if (toStatus !== current.status || nextGraceUntil !== current.graceUntil) {
        current = await this.deps.memberPools.transitionStatus({
          poolId: pool.id,
          toStatus: toStatus as 'active' | 'grace' | 'expired',
          reason: decision.transition.reason,
          actor: 'billing-reconciler',
          ...(nextGraceUntil !== undefined ? { graceUntil: nextGraceUntil } : {}),
        });
        this.stats.transitions += 1;
      }
    }

    const landed = await this.convergePoolMembers(
      pool.id,
      billableGuilds,
      current,
      subscription,
      now,
      config,
    );
    await this.queuePoolNotifications(
      current,
      decision.notifications,
      state.pooledMemberCount ?? 0,
      landed,
    );
  }

  private poolLeniencyState(
    pool: MemberPoolRow,
    subscription: PoolSubscriptionRow | undefined,
    pooledSum: number,
  ): LeniencyState {
    const meta = parseBillingMeta(pool.metadata);
    return {
      authStatus: pool.status,
      authExpiresAt: null, // a pool has no trial window, ever (§5.4)
      graceUntil: pool.graceUntil,
      billedTier: pool.billedTier,
      hasSubscription: subscription !== undefined,
      subscriptionOk: subscription ? subscriptionInGoodStanding(subscription) : false,
      memberCount: null,
      pooledMemberCount: pooledSum,
      samples: meta.samples,
      guildCreatedAt: null,
      notifications: meta.notifications,
    };
  }

  /**
   * Lands every billable member of a pool on the right state, and reports where
   * they landed.
   *
   * The old `fanOutToPoolMembers` wrote `pool.status` verbatim to every member.
   * That is correct while the subscription is paying and wrong the moment it is
   * not: a per-guild floor written by the refund webhook was overwritten within
   * the hour, and re-applying it would have thrashed forever, since the two
   * values genuinely differ so `skipIfUnchanged` could not help.
   *
   * **The first branch tests the SUBSCRIPTION, not `pool.status`.** Reading the
   * stored status as "the subscription's standing" was the defect: an expired
   * pool promotes itself back to `active` through `evaluateExpired`'s
   * member-count branch, and the pass-through then wrote that onto a server
   * whose customer had been refunded.
   *
   * A null floor hands the guild to its own ladder, which is where the trial
   * warnings, the 60-day grace, `hard_gate_disabled` and the notification dedupe
   * all live. That is the part of this design with the least margin: §6.5 and
   * the pooled-skip in the per-guild walk exist to say a pooled guild is
   * evaluated by exactly one thing, and this points that hazard the other way.
   * Every branch was checked, but it is still an argument that a documented
   * hazard is safe in one direction.
   */
  private async convergePoolMembers(
    poolId: string,
    billableGuilds: readonly GuildRow[],
    pool: MemberPoolRow,
    subscription: PoolSubscriptionRow | undefined,
    now: Date,
    config: LeniencyConfig,
  ): Promise<PoolLanding> {
    const landing: PoolLanding = { entitled: [], gated: [] };
    /**
     * Only a subscription that EXISTS and is not paying its way triggers the
     * floor. A pool with no subscription row at all is the `no_subscription`
     * operator condition (entitled with nothing behind it), and gating those
     * servers is a different decision from this one, so it keeps today's
     * behaviour and stays visible on the operator queue.
     */
    const useFloor = subscription !== undefined && !subscriptionInGoodStanding(subscription);

    for (const guild of billableGuilds) {
      try {
        /**
         * `blocked` outranks billing, and this pass had no guard for it. The
         * per-guild ladder does guard it but deliberately skips pooled non-free
         * guilds, so this is their ONLY evaluator: a guild blocked for abuse was
         * written back to the pool's status, lifting the kill-switch.
         *
         * The tier write below is deliberately NOT skipped: skipping both would
         * let a blocked member's billed tier drift, and `guilds.tier` entitles
         * nothing on its own.
         */
        if (guild.authStatus !== 'blocked') {
          if (useFloor) {
            const floor = guildFloor(
              {
                authStatus: guild.authStatus,
                memberCount: guild.memberCount,
                authExpiresAt: guild.authExpiresAt,
                createdAt: guild.createdAt,
              },
              now,
            );
            if (floor) {
              await this.deps.store.transitionAuth({
                guildId: guild.guildId,
                toStatus: floor.toStatus,
                reason: `${floor.reason}:${poolId}`,
                actor: 'billing-reconciler',
                skipIfUnchanged: true,
                ...(floor.expiresAtIfNull ? { expiresAtIfNull: floor.expiresAtIfNull } : {}),
              });
              this.stats.transitions += 1;
              (floor.toStatus === 'expired' ? landing.gated : landing.entitled).push(guild.guildId);
            } else {
              // Already at or above its floor. Its own ladder decides what
              // happens next, which is what stops a resumed trial running
              // forever with no warnings and no grace.
              await this.advanceGuild(guild, config);
              (ENTITLED_STATUSES.has(guild.authStatus) ? landing.entitled : landing.gated).push(
                guild.guildId,
              );
            }
          } else {
            if (
              guild.authStatus !== pool.status ||
              datesDiffer(guild.graceUntil, pool.graceUntil)
            ) {
              await this.deps.store.transitionAuth({
                guildId: guild.guildId,
                toStatus: pool.status,
                reason: `pool:${poolId}`,
                actor: 'billing-reconciler',
                graceUntil: pool.graceUntil,
                skipIfUnchanged: true,
              });
            }
            (ENTITLED_STATUSES.has(pool.status) ? landing.entitled : landing.gated).push(
              guild.guildId,
            );
          }
        }
        if (guild.tier !== pool.billedTier) {
          await this.deps.store.setBilledTier(guild.guildId, pool.billedTier);
        }
      } catch (err) {
        // Per-guild isolation inside the pool pass too: one bad member must
        // never stop the rest of the pool, or the whole pass, from converging.
        this.stats.errors += 1;
        this.deps.logger.error(
          { err, poolId, guildId: guild.guildId },
          'pool convergence failed for one member (isolated)',
        );
      }
    }
    return landing;
  }

  /**
   * Re-reads member rows after the pass has corrected their counts, keeping only
   * the ones still billable. See the call site for why the stale array is not
   * safe once a member count decides a status.
   */
  private async reloadBillable(previous: readonly GuildRow[]): Promise<GuildRow[]> {
    const out: GuildRow[] = [];
    for (const stale of previous) {
      const fresh = await this.deps.guilds.get(stale.guildId);
      if (fresh && tierFor(fresh.memberCount ?? 0).id !== 'free') out.push(fresh);
    }
    return out;
  }

  /**
   * Splits the pool's due notifications by audience (§6.6): service-stopping
   * kinds fan out to every live member guild through the ordinary per-guild
   * queue (each gets its own dedupe/retry/expiry, and carries `sourcePoolId`
   * so the deliverer knows which pool to stamp); everything else is a billing
   * event, queued once for the purchaser alone.
   *
   * **The pool's own dedupe stamp for a fan-out notification is written at
   * DELIVERY, not enqueue** — the first version of this stamped as soon as
   * enqueueing succeeded, which is wrong: if every one of the N per-guild
   * copies then failed to deliver within its TTL, the pool's dedupe map was
   * already marked sent, so `evaluateExpired`'s "re-emit hard_gate until a
   * delivery succeeds" guarantee (the exact promise that machine's own
   * comment states) silently broke for the case that guarantee exists for.
   * `deliverPhase` stamps it once any single copy is confirmed delivered.
   */
  private async queuePoolNotifications(
    current: MemberPoolRow,
    notifications: readonly LeniencyNotification[],
    memberCount: number,
    landed: PoolLanding,
  ): Promise<void> {
    for (const notification of notifications) {
      if (POOL_FAN_OUT_KINDS.has(notification.kind)) {
        /**
         * The servers that actually landed there, not every live member.
         *
         * `listLive` included free-sized members, whose service never stopped,
         * so a lapse told them it had. It also now excludes a blocked member and
         * one the floor lifted rather than gated, neither of which experienced
         * the thing being announced.
         */
        const targets = (notification.kind === 'hard_gate' ? landed.gated : landed.entitled).map(
          (guildId) => ({ guildId }),
        );
        for (const membership of targets) {
          const queued = await this.deps.notifications.enqueue(
            membership.guildId,
            notification,
            memberCount,
            { at: this.now(), ttlMs: this.notificationTtlMs, sourcePoolId: current.id },
          );
          if (queued) this.stats.notificationsQueued += 1;
        }
      } else {
        const queued = await this.deps.notifications.enqueueForPool(
          current.id,
          notification,
          memberCount,
          { at: this.now(), ttlMs: this.notificationTtlMs },
        );
        if (queued) this.stats.notificationsQueued += 1;
      }
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
          { guildId: row.guildId, poolId: row.poolId, key: row.key, attempts: row.attempts },
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
            target: row.guildId ?? row.poolId ?? '',
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
          // A row carrying a source pool is one copy of a fan-out, read by a
          // server whose admins may not be the buyer and who never saw the
          // warnings that came before it.
          row.poolId ? 'shared_member' : 'guild',
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
        // This row is one copy of a pool's fan-out (§6.6). Stamp the POOL's
        // own dedupe key on this, the first confirmed delivery — restamping
        // on a later copy's delivery is harmless (same key, newer timestamp).
        // Never stamped at enqueue time: a pool whose every copy fails must
        // keep re-deriving the notification, exactly like a single guild's.
        if (row.poolId) {
          await this.deps.memberPools.recordNotification(row.poolId, row.key, now).catch((err) => {
            this.deps.logger.warn(
              { err, poolId: row.poolId, key: row.key },
              'pool dedupe stamp failed after a fan-out delivery succeeded',
            );
          });
        }
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

    await this.deliverPoolNotifications(now);

    try {
      this.stats.notificationQueueDepth = await this.deps.notifications.pending(now);
    } catch (err) {
      this.deps.logger.debug({ err }, 'billing notification depth read failed');
    }
  }

  /**
   * The pool-axis sibling of the delivery loop above: purchaser-targeted
   * billing notifications (grace_started, grace_nudge — §6.6). Service-
   * stopping notifications never reach here; `queuePoolNotifications` already
   * fanned those out as ordinary guild-scoped rows, delivered by the loop
   * above like any other guild notice.
   */
  private async deliverPoolNotifications(now: Date): Promise<void> {
    let claimed;
    try {
      claimed = await this.deps.notifications.claimPoolForFleet(
        this.deps.fleet,
        this.deliverBatch,
        now,
      );
    } catch (err) {
      this.stats.errors += 1;
      this.deps.logger.error({ err }, 'pool billing notification claim failed');
      return;
    }

    for (const row of claimed) {
      if (this.stopping) return;
      try {
        if (await this.alreadyDeliveredForPool(row.poolId, row.key, row.enqueuedAt)) {
          await this.deps.notifications.markDelivered(row.id, this.deps.fleet, now);
          continue;
        }

        const pool = await this.deps.memberPools.get(row.poolId);
        if (!pool) {
          // The pool was deleted from under a queued row. Nothing to deliver
          // to and nothing to retry either.
          await this.deps.notifications.markDelivered(row.id, this.deps.fleet, now);
          continue;
        }
        const subscription = await this.deps.subscriptions.getByPoolId(row.poolId);
        const purchaserUserId = subscription?.purchaserUserId;
        const discordUserId = purchaserUserId
          ? await this.deps.resolveDiscordUserId(purchaserUserId)
          : null;
        const delivered = discordUserId
          ? await this.deps.notifier.notifyPurchaser(
              discordUserId,
              row.notification,
              row.memberCount,
            )
          : false;
        if (!delivered) {
          await this.deps.notifications.markFailed(row.id, 'no reachable purchaser DM', now);
          continue;
        }
        await this.deps.memberPools.recordNotification(row.poolId, row.key, now);
        await this.deps.notifications.markDelivered(row.id, this.deps.fleet, now);
        this.stats.notificationsSent += 1;
      } catch (err) {
        this.stats.errors += 1;
        this.deps.logger.error(
          { err, poolId: row.poolId, key: row.key },
          'pool billing notification delivery failed (isolated)',
        );
      }
    }
  }

  /** The pool-axis sibling of {@link alreadyDelivered}. */
  private async alreadyDeliveredForPool(
    poolId: string,
    key: string,
    enqueuedAt: Date,
  ): Promise<boolean> {
    const pool = await this.deps.memberPools.get(poolId);
    if (!pool) return false;
    const stampedAt = parseBillingMeta(pool.metadata).notifications[key];
    if (stampedAt === undefined) return false;
    const at = Date.parse(stampedAt);
    return !Number.isNaN(at) && at >= enqueuedAt.getTime();
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

/** Null-safe date equality, for the fan-out's diff-before-write check. */
function datesDiffer(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a !== b;
  return a.getTime() !== b.getTime();
}
