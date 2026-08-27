import {
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';
import { RUNTIME_FLAGS, type RuntimeFlagsRepository, type TierId } from '@avc/core';
import type { Logger } from 'pino';

/**
 * Supporter roles in the support guild.
 *
 * **Recognition, never entitlement.** Nothing reads a role here to decide what
 * anyone may do, and nothing may start: every feature is on every plan, and a
 * role that gated something would spend that positioning to buy a colour.
 *
 * Event-driven, with the sweep as a safety net rather than the mechanism. Three
 * things move a badge, and the first is the one that does the work:
 *
 * 1. A Paddle webhook changes a subscription, so web NOTIFYs the purchaser's
 *    snowflake and {@link SupporterRoles.syncMember} writes one role.
 * 2. Someone joins the support guild (`guildMemberAdd`).
 * 3. {@link SupporterRoles.reconcile} runs on reconnect and daily, and converges
 *    whatever the first two missed.
 *
 * The reconcile can be dropped on the floor at any point without losing state,
 * because the desired badge is derivable from the database at any moment: there
 * is no queue to drain and nothing accumulates. That property is what lets the
 * sweep be daily instead of the every-few-minutes loop this would otherwise be.
 *
 * Cost is bounded by the support guild, not by the customer base. The guild
 * lives on exactly one shard however many shards exist, so exactly one instance
 * ever acts, and it acts on that one guild's membership.
 */

export interface SupporterRolesDeps {
  client: Client;
  guildId: string;
  /** Billed tier to role id. Partial: an unmapped tier is simply not badged. */
  byTier: { readonly [K in TierId]?: string | undefined };
  /**
   * The best tier each of these snowflakes is paying for. Absent from the map
   * means "owed no badge", which is a real answer the diff depends on.
   */
  lookup: (discordUserIds: readonly string[]) => Promise<Map<string, TierId>>;
  flags: RuntimeFlagsRepository;
  logger: Logger;
  report: (kind: string, message: string, context: Record<string, unknown>) => void;
  /** Delay between writes during a reconcile. See `config.supporterRoles`. */
  writeSpacingMs: number;
  reconcileIntervalHours: number;
  now?: () => Date;
}

export interface SupporterRolesStats {
  enabled: boolean;
  running: boolean;
  /** False on every instance except the one whose shard owns the support guild. */
  owned: boolean;
  lastReconcileAt: string | null;
  lastReconcileDurationMs: number | null;
  /**
   * Write ATTEMPTS in the last pass, not confirmed changes: a failed write
   * still cost a request and still paced the loop. Read it beside `errors`.
   */
  lastReconcileAttempts: number | null;
  /** Reconciles declined: inside the reconnect floor, or one already running. */
  skippedReconciles: number;
  /** Members the reconcile left alone because the live path had just synced them. */
  deferredToLivePath: number;
  added: number;
  removed: number;
  errors: number;
  /**
   * NOTIFYs received on the live path, and how many of those found a member of
   * the support guild.
   *
   * Split because a single number cannot tell "the NOTIFY path is dead" from
   * "nobody who bought a subscription is in the support server", and the second
   * is the ordinary case: most purchasers never join. `eventsReceived` moving
   * with `eventsApplied` flat is healthy; both flat is the thing to chase.
   */
  eventsReceived: number;
  eventsApplied: number;
  lastError: string | null;
  /**
   * Configured role ids that do not exist in the guild, and roles this bot
   * cannot assign because they sit at or above its own highest role.
   *
   * Both fail as a bare 403/404 per write, forever, which reads as "the feature
   * does nothing" rather than as a misconfiguration. Surfaced here so the
   * question is answerable without reading logs.
   */
  unusableRoles: string[];
}

/**
 * The role changes one member needs.
 *
 * Pure, and the only place the "exactly one badge at a time" rule lives.
 * Add/remove specific ids rather than setting a member's role list: a wholesale
 * set would strip moderator roles from the people most likely to have both.
 */
export function planRoleChange(input: {
  /** Every role id this feature manages, whether or not the member holds it. */
  managed: readonly string[];
  /** Role ids the member currently has (their full set is fine). */
  currentRoles: readonly string[];
  /** The single role they should hold, or undefined for none. */
  desired: string | undefined;
}): { add: string[]; remove: string[] } {
  const managed = new Set(input.managed);
  const current = new Set(input.currentRoles);
  const desired =
    input.desired !== undefined && managed.has(input.desired) ? input.desired : undefined;

  const add = desired !== undefined && !current.has(desired) ? [desired] : [];
  const remove = [...current].filter((id) => managed.has(id) && id !== desired);
  return { add, remove };
}

/** Discord's "Unknown Member": the snowflake is not in this guild. */
const UNKNOWN_MEMBER = 10007;

/** Shows up in the guild's audit log against every role change made here. */
const SYNC_REASON = 'AVC supporter role sync';

/**
 * Bound on the gateway member request, against discord.js's 120s default.
 *
 * The drain awaits an in-flight reconcile and this is its longest await, so the
 * default would let a SIGTERM landing mid-fetch outlive Fly's 5s kill timeout,
 * taking the lease release, the metrics final flush and the queue drain with it.
 * Failing the pass is free: the next one converges.
 *
 * **It is an INTER-CHUNK timeout, not a total one.** discord.js refreshes it on
 * every GUILD_MEMBERS_CHUNK, so a guild that keeps streaming can still exceed
 * it. It bounds a stall, which is the case that matters here, not the length of
 * a healthy fetch.
 */
const MEMBER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Floor between reconnect-driven reconciles.
 *
 * The notifier reconnect loop can cycle repeatedly (28 times in 4.5 hours, on
 * beta), and each reconcile is a gateway member request plus a query per 2000
 * members. Without a floor a flapping database connection turns the safety net
 * into the load.
 */
const RECONNECT_RECONCILE_FLOOR_MS = 10 * 60_000;

export class SupporterRoles {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;

  /**
   * Serializes writes per member, so a reconcile and a live NOTIFY cannot
   * interleave two decisions about the same person.
   *
   * Entries are deleted as they settle, so this holds only members with work in
   * flight.
   */
  private readonly memberChains = new Map<string, Promise<void>>();

  /**
   * The badge we last successfully wrote for a member, believed over the role
   * cache for the managed portion of a decision.
   *
   * **This exists because discord.js does not update the member you are holding
   * when you write to it.** `roles.add`/`roles.remove` patch a *clone* and
   * return it; `member.roles.cache` only moves when Discord echoes a
   * GUILD_MEMBER_UPDATE back over the gateway. So a second decision taken
   * inside that echo window reads pre-write state, and the dangerous outcome is
   * not a duplicate write (those are idempotent) but a decision that concludes
   * "nothing to do" and leaves the member wrong until the next daily pass.
   *
   * Cleared wholesale after each reconcile's `members.fetch()`, which
   * repopulates every cached member from Discord and is therefore authoritative
   * again. That also bounds this map, and it is what lets an out-of-band manual
   * role edit be picked up rather than believed away forever.
   */
  private readonly lastWritten = new Map<string, string | null>();

  /**
   * Monotonic tick, incremented once per live sync. Compared, never read as a
   * time: two events in the same millisecond must still be orderable.
   */
  private syncSeq = 0;

  /** The tick at which the live path last synced each member. */
  private readonly syncedAt = new Map<string, number>();

  /**
   * A reconcile snapshots every member's desired tier once and then walks the
   * guild paced at `writeSpacingMs`, so on a large guild the snapshot is minutes
   * old by the end. Without this, a customer who upgrades mid-pass is reverted
   * to the tier they held when the pass began, publicly, until tomorrow. The
   * live path is always fresher than the snapshot, so it wins.
   *
   * A sequence compared against the tick at pass start, rather than a set the
   * pass clears: a set has to be emptied somewhere, and anything that lands
   * between the pass starting and that clear has its mark erased by the very
   * pass that should have honoured it.
   */

  /** In-flight live-path syncs, so the drain waits for them (not just reconciles). */
  private readonly inFlightSyncs = new Set<Promise<void>>();

  private lastReconcileAt: Date | null = null;
  /**
   * When a pass last STARTED, successful or not.
   *
   * The reconnect floor reads this and not `lastReconcileAt`: stamping only on
   * success means a pass that throws leaves the floor disarmed, and the
   * condition that makes passes throw (a flapping database) is exactly the one
   * that drives repeated reconnects. The floor would fail open in the only
   * situation it exists for.
   */
  private lastReconcileAttemptAt: Date | null = null;
  private lastReconcileDurationMs: number | null = null;
  private lastReconcileAttempts: number | null = null;
  private skippedReconciles = 0;
  private deferredToLivePath = 0;
  private added = 0;
  private removed = 0;
  private errors = 0;
  private eventsReceived = 0;
  private eventsApplied = 0;
  private lastError: string | null = null;
  /** Role ids known to be unassignable, so nothing keeps trying them. */
  private unusableRoles = new Set<string>();
  /** The same thing said in words, for `/diagnostics`. */
  private unusableReasons: string[] = [];

  constructor(private readonly deps: SupporterRolesDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Every role id this feature manages. */
  private get managedRoleIds(): string[] {
    return Object.values(this.deps.byTier).filter((id): id is string => typeof id === 'string');
  }

  start(): void {
    this.deps.client.on('guildMemberAdd', (member) => {
      if (member.guild.id !== this.deps.guildId || member.user.bot) return;
      void this.syncMember(member.id).catch((err: unknown) => {
        this.recordError(err, 'supporter role sync on join failed', { userId: member.id });
      });
    });

    const intervalMs = this.deps.reconcileIntervalHours * 3_600_000;
    this.timer = setInterval(() => {
      void this.reconcile().catch((err: unknown) => {
        this.recordError(err, 'scheduled supporter role reconcile failed');
      });
    }, intervalMs);
    // Never the reason the process refuses to exit, like every other job here.
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    /**
     * Both paths are awaited, not just the reconcile.
     *
     * Each is a sequence of independent single-member writes, so stopping
     * between two of them is always consistent while abandoning one mid-write
     * is not: a swap interrupted after its removal leaves the member unbadged
     * until tomorrow. Waiting for the reconcile alone would protect the path
     * that is idle almost all the time and drop the one that actually runs.
     */
    const pending: Promise<unknown>[] = [...this.inFlightSyncs];
    if (this.inFlight) pending.push(this.inFlight);
    await Promise.allSettled(pending);
  }

  get stats(): SupporterRolesStats {
    return {
      enabled: true,
      running: this.inFlight !== undefined,
      owned: this.guild() !== undefined,
      lastReconcileAt: this.lastReconcileAt?.toISOString() ?? null,
      lastReconcileDurationMs: this.lastReconcileDurationMs,
      lastReconcileAttempts: this.lastReconcileAttempts,
      skippedReconciles: this.skippedReconciles,
      deferredToLivePath: this.deferredToLivePath,
      added: this.added,
      removed: this.removed,
      errors: this.errors,
      eventsReceived: this.eventsReceived,
      eventsApplied: this.eventsApplied,
      lastError: this.lastError,
      unusableRoles: [...this.unusableReasons],
    };
  }

  /**
   * The support guild, or undefined when this instance does not serve its shard.
   *
   * This IS the singleton election. The support guild lives on one shard like
   * any other guild, so exactly one instance holds it, and no lock, lease or
   * leader flag is needed to keep the others out.
   */
  private guild(): Guild | undefined {
    return this.deps.client.guilds.cache.get(this.deps.guildId);
  }

  /** Whether an operator has switched this off. Freezes writes, strips nothing. */
  private async suppressed(): Promise<boolean> {
    const [disabled, paused] = await Promise.all([
      this.deps.flags.getBool(RUNTIME_FLAGS.SUPPORT_ROLES_DISABLED),
      this.deps.flags.getBool(RUNTIME_FLAGS.GLOBAL_PAUSE),
    ]);
    return disabled || paused;
  }

  /**
   * Converge one member's badge. The live path, driven by a Paddle webhook or
   * by someone joining the guild.
   */
  async syncMember(discordUserId: string): Promise<void> {
    const guild = this.guild();
    if (!guild || this.stopping) return;
    /**
     * Counted before the switch is read, not after. The whole point of splitting
     * this from `eventsApplied` is to distinguish "the NOTIFY path is dead" from
     * "nobody who bought is in this server", and a suppressed fleet reporting
     * zero received says the first when the second is true.
     */
    this.eventsReceived += 1;
    if (await this.suppressed()) return;

    /**
     * Tracked so the drain waits for it. `inFlight` only ever holds a reconcile,
     * which is idle almost all the time -- this is the path that actually runs.
     */
    const work = this.runSync(guild, discordUserId);
    this.inFlightSyncs.add(work);
    try {
      await work;
    } finally {
      this.inFlightSyncs.delete(work);
    }
  }

  private async runSync(guild: Guild, discordUserId: string): Promise<void> {
    const member = await this.fetchMember(guild, discordUserId);
    /**
     * Not in the support guild, which is the common case: most people who buy
     * a subscription never join it. Nothing to do, and nothing wrong.
     */
    if (!member) return;

    const tiers = await this.deps.lookup([discordUserId]);
    if (this.stopping) return;
    // Marked before the write, so a reconcile that reaches this member later in
    // its pass defers to this fresher decision rather than reverting it.
    this.syncedAt.set(discordUserId, (this.syncSeq += 1));
    await this.withMemberChain(discordUserId, () => this.applyTo(member, tiers.get(discordUserId)));
    this.eventsApplied += 1;
  }

  /**
   * Runs `fn` after any work already queued for this member.
   *
   * Two decisions about one person must never be in flight at once: they read
   * the same role cache, and discord.js does not update it on write, so the
   * second would be taken against pre-write state. Chained per member rather
   * than globally, so one slow member cannot hold up the guild.
   */
  private async withMemberChain<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.memberChains.get(userId) ?? Promise.resolve();
    const settled = previous.then(fn, fn);
    const chained = settled.then(
      () => undefined,
      () => undefined,
    );
    this.memberChains.set(userId, chained);
    try {
      return await settled;
    } finally {
      // Only if nothing newer queued behind us, or the map grows forever.
      if (this.memberChains.get(userId) === chained) this.memberChains.delete(userId);
    }
  }

  /**
   * Converge every badge in the guild.
   *
   * Runs on reconnect and daily. Everything it does, the event paths already
   * did in real time: this exists for the webhook that was never delivered and
   * the NOTIFY that arrived while the listener was reconnecting.
   */
  async reconcile(opts: { minIntervalMs?: number } = {}): Promise<void> {
    /**
     * The floor is opt-in per caller, not global: a boot, a daily tick and a
     * re-add to the guild each want to run regardless, while a notifier that is
     * flapping must not be able to drive one pass per reconnect.
     */
    const floor = opts.minIntervalMs;
    if (floor !== undefined && this.lastReconcileAttemptAt) {
      if (this.now().getTime() - this.lastReconcileAttemptAt.getTime() < floor) {
        this.skippedReconciles += 1;
        return;
      }
    }
    if (this.inFlight) {
      // Counted too: a caller that arrived during a pass got no pass of its own,
      // and a stat that hid that would understate how often this declines.
      this.skippedReconciles += 1;
      return this.inFlight;
    }
    const run = this.runReconcile().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * Resync after the NOTIFY connection came back.
   *
   * This is the safety net that actually covers the live path's failure mode.
   * `PgNotifier.notify` drops a publish outright while disconnected, so every
   * subscription change during a reconnect window is simply lost, and there is
   * no smaller unit to replay than "check everyone". Neither `guildCreate` nor
   * `clientReady` fires again on a gateway reconnect (discord.js emits
   * `guildAvailable` for an already-cached guild, and `clientReady` is bound
   * with `once`), so without this the daily timer was the only recurring net.
   */
  async reconcileAfterReconnect(): Promise<void> {
    return this.reconcile({ minIntervalMs: RECONNECT_RECONCILE_FLOOR_MS });
  }

  private async runReconcile(): Promise<void> {
    // Captured before the first await, so a live sync racing the start of this
    // pass is counted as newer than it rather than older.
    const passStartSeq = this.syncSeq;
    const guild = this.guild();
    if (!guild || this.stopping) return;
    /**
     * Stamped before the flag read, not after it.
     *
     * `suppressed()` queries the database, and a database unwell enough to make
     * it throw is the same one making the notifier reconnect in a loop. Stamping
     * later would leave the floor disarmed in precisely that case.
     */
    this.lastReconcileAttemptAt = this.now();
    if (await this.suppressed()) return;

    const startedAt = Date.now();
    /**
     * Before the member fetch, not after: it reads only the role cache and this
     * instance's own member, both already in memory, and a fetch that throws
     * would otherwise leave a mis-positioned role unreported for another day.
     */
    this.checkRolesUsable(guild);
    /**
     * The gateway member request, not the cache. With the GuildMembers intent
     * Discord still only pushes an initial slice on GUILD_CREATE, so a cache
     * read would quietly reconcile a subset of the guild and report success.
     */
    const members = await guild.members.fetch({ time: MEMBER_FETCH_TIMEOUT_MS });
    /**
     * That fetch repatched every cached member from Discord, so the role cache
     * is authoritative again and anything this class believed about its own
     * past writes is now redundant. Dropping it here is also what lets an
     * out-of-band manual role edit be seen rather than believed away.
     */
    this.lastWritten.clear();

    const candidates = members.filter((m) => !m.user.bot);
    /**
     * One query for the whole guild, then a paced walk. The snapshot ages as the
     * walk proceeds, which is what `syncedDuringPass` exists to correct: the
     * live path is always fresher than this.
     */
    const desired = await this.deps.lookup([...candidates.keys()]);
    /**
     * A short read is silent and safe-directional (it under-converges, never
     * wrongly strips), which is exactly the shape that hid 557 missing guilds at
     * the cutover. Say so rather than logging "complete".
     */
    if (guild.memberCount > 0 && members.size < guild.memberCount) {
      this.deps.logger.warn(
        { fetched: members.size, expected: guild.memberCount },
        'supporter role reconcile saw fewer members than the guild reports',
      );
    }

    let attempts = 0;
    for (const member of candidates.values()) {
      if (this.stopping) break;
      if ((this.syncedAt.get(member.id) ?? 0) > passStartSeq) {
        this.deferredToLivePath += 1;
        continue;
      }
      const wrote = await this.withMemberChain(member.id, () =>
        this.applyTo(member, desired.get(member.id)),
      );
      if (!wrote) continue;
      attempts += 1;
      /**
       * Paced, because a reconcile after a long gap is the one case where this
       * is thousands of writes against a single guild's role rate limit, and an
       * unpaced burst parks every other REST call in the fleet behind it.
       */
      if (this.deps.writeSpacingMs > 0) await delay(this.deps.writeSpacingMs);
    }

    // Marks this pass has already accounted for are dead weight now.
    for (const [userId, seq] of this.syncedAt) {
      if (seq <= passStartSeq) this.syncedAt.delete(userId);
    }
    this.lastReconcileAt = this.now();
    this.lastReconcileDurationMs = Date.now() - startedAt;
    this.lastReconcileAttempts = attempts;
    this.deps.logger.info(
      { attempts, members: candidates.size, durationMs: this.lastReconcileDurationMs },
      'supporter role reconcile complete',
    );
  }

  private roleFor(tier: TierId | undefined): string | undefined {
    return tier ? this.deps.byTier[tier] : undefined;
  }

  /**
   * Applies one member's plan. Returns whether a write was attempted, which is
   * what the reconcile paces on -- a failed attempt still cost a request.
   *
   * **Every call passes a single role id, never an array, and that is not a
   * style choice.** discord.js's array overload of `roles.add`/`roles.remove`
   * does not use Discord's per-role routes at all: it falls through to
   * `GuildMemberRoleManager.set()`, which PATCHes the member's WHOLE role list
   * rebuilt from the local role cache. That cache is not updated by a preceding
   * write in the same pass, because `add`/`remove` patch a *clone* and return
   * it, so a remove-then-add swap re-sends the badge it just removed and the
   * member ends up holding both. It also means a wholesale set, which would
   * revert any role granted to that member since the cache was last patched --
   * the exact hazard `planRoleChange` computes a narrow diff to avoid.
   *
   * The singular form uses `PUT`/`DELETE .../members/:id/roles/:role`, which
   * touch one role, read no cache, and are idempotent.
   */
  private async applyTo(member: GuildMember, tier: TierId | undefined): Promise<boolean> {
    /**
     * Our own last write beats the role cache for the managed portion, because
     * the cache does not move until Discord echoes the change back and a second
     * decision inside that window would otherwise be taken on pre-write state.
     * Unmanaged roles always come from the cache: this never touches them, so
     * there is nothing to believe about them.
     */
    const believed = this.lastWritten.get(member.id);
    const cached = [...member.roles.cache.keys()];
    const managed = new Set(this.managedRoleIds);
    const currentRoles =
      believed === undefined
        ? cached
        : [...cached.filter((id) => !managed.has(id)), ...(believed ? [believed] : [])];

    const desiredRole = this.roleFor(tier);
    const plan = planRoleChange({
      managed: this.managedRoleIds,
      currentRoles,
      // A role we already know we cannot assign is not attempted: the write
      // would 403 once per owed member, every pass, and climb `errors` linearly
      // with membership while changing nothing.
      desired:
        desiredRole !== undefined && this.unusableRoles.has(desiredRole) ? undefined : desiredRole,
    });
    if (plan.add.length === 0 && plan.remove.length === 0) return false;

    try {
      /**
       * Removals first. A member briefly holding two badges looks like a bug to
       * everyone watching the member list, while briefly holding none does not.
       * The asymmetry is real though: if the add then fails, "briefly" becomes
       * a day. That is the trade, taken knowingly.
       */
      for (const roleId of plan.remove) {
        await member.roles.remove(roleId, SYNC_REASON);
        this.removed += 1;
        this.lastWritten.set(member.id, null);
      }
      for (const roleId of plan.add) {
        await member.roles.add(roleId, SYNC_REASON);
        this.added += 1;
        this.lastWritten.set(member.id, roleId);
      }
      this.deps.logger.info(
        { userId: member.id, tier: tier ?? null, add: plan.add, remove: plan.remove },
        'supporter roles updated',
      );
    } catch (err) {
      /**
       * A member who left mid-pass is ordinary churn, not a fault. Counting it
       * would inflate the one number an operator is told to read beside
       * `lastReconcileAttempts`.
       */
      if (err instanceof DiscordAPIError && err.code === UNKNOWN_MEMBER) {
        this.lastWritten.delete(member.id);
        return true;
      }
      // What we believe about this member is now unknown, so believe nothing.
      this.lastWritten.delete(member.id);
      this.recordError(err, 'supporter role write failed', { userId: member.id });
    }
    return true;
  }

  private async fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
    try {
      /**
       * Not cache-only. Someone who bought a subscription an hour ago may never
       * have triggered an event that would cache them, and a cache miss is
       * indistinguishable from "not a member", which would silently badge
       * nobody.
       */
      return await guild.members.fetch(userId);
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === UNKNOWN_MEMBER) return null;
      this.recordError(err, 'supporter role member fetch failed', { userId });
      return null;
    }
  }

  /**
   * Whether every configured role exists and is actually assignable.
   *
   * Both failures are silent per-write 403/404s that look exactly like the
   * feature being off, and a role can drop below the bot at any time because
   * somebody dragged it in the role list, so this is re-checked on every
   * reconcile rather than once at boot.
   */
  private checkRolesUsable(guild: Guild): void {
    const problems: string[] = [];
    const unusable = new Set<string>();
    const me = guild.members.me;
    /**
     * `members.me` never returns null here: `Partials.GuildMember` is enabled,
     * so it fabricates a partial member rather than answering "not cached". A
     * fabricated one has no roles, which would make `roles.highest` the
     * @everyone role at position 0 and report every configured role as
     * mis-positioned. Detect that and say what is actually true instead.
     */
    const meIsReal = me !== null && !me.partial;
    const highest: Role | undefined = meIsReal ? me.roles.highest : undefined;
    if (!meIsReal) {
      problems.push('this bot is not cached as a member here, so its permissions are unchecked');
    }
    /**
     * Manage Roles, checked here rather than inferred from a 403.
     *
     * Missing it and being positioned too low fail identically from the
     * outside: every write 403s and the feature looks switched off. This is the
     * likelier of the two on a first deploy, so a diagnostic that reported the
     * position and stayed silent about the permission would confirm the wrong
     * branch of exactly the question it exists to answer.
     */
    const canManageRoles = meIsReal && me.permissions.has(PermissionFlagsBits.ManageRoles);
    if (meIsReal && !canManageRoles) {
      problems.push('this bot does not have Manage Roles in this guild');
    }
    for (const roleId of this.managedRoleIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        problems.push(`${roleId} (no such role in the guild)`);
        unusable.add(roleId);
        continue;
      }
      /**
       * A role owned by an integration cannot be assigned by anyone, including
       * an administrator. Worth checking rather than assuming: this feature was
       * asked for on the back of the old Patreon channels, and Patreon's own
       * Discord integration creates exactly this kind of role, so pointing a
       * SUPPORT_ROLE_* at one is the most available configuration mistake here.
       */
      if (role.managed) {
        problems.push(
          `${role.name} (${roleId}) is managed by an integration and cannot be assigned`,
        );
        unusable.add(roleId);
        continue;
      }
      if (highest && role.comparePositionTo(highest) >= 0) {
        problems.push(`${role.name} (${roleId}) sits at or above the bot's own role`);
        unusable.add(roleId);
      }
      if (!canManageRoles) unusable.add(roleId);
    }
    const changed =
      problems.length !== this.unusableReasons.length ||
      problems.some((p, i) => p !== this.unusableReasons[i]);
    this.unusableReasons = problems;
    this.unusableRoles = unusable;
    if (!changed) return;
    /**
     * Reported only on change, so a standing misconfiguration is not a daily
     * repeat of the same alert -- and recovery is reported too, because an
     * operator who was told a role was unusable is owed the news that it is not.
     */
    if (problems.length > 0) {
      this.deps.report('supporter_roles', 'Supporter roles cannot be assigned', {
        guildId: guild.id,
        problems,
      });
    } else {
      this.deps.report('supporter_roles', 'Supporter roles are assignable again', {
        guildId: guild.id,
      });
    }
  }

  /**
   * Records a failure from a caller-owned trigger (the boot reconcile, the
   * guildCreate hook, the NOTIFY listener), so `/diagnostics` cannot report
   * `errors: 0` while every one of them has been throwing.
   */
  noteFailure(err: unknown, message: string, context: Record<string, unknown> = {}): void {
    this.recordError(err, message, context);
  }

  private recordError(err: unknown, message: string, context: Record<string, unknown> = {}): void {
    this.errors += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.deps.logger.warn({ err, ...context }, message);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
