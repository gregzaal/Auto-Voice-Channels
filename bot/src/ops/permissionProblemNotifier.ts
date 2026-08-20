import {
  isEntitled,
  RUNTIME_FLAGS,
  type AutoChannelRepository,
  type GuildSettingsReader,
  type Logger,
  type RuntimeFlagsRepository,
} from '@avc/core';
import type { Client, Guild } from 'discord.js';
import { readContact, readProblemAlerts } from '../features/voice/guildSettings.js';
import {
  permissionProblemSummary,
  type PermissionProblem,
  type PermissionProblemTracker,
} from '../features/voice/permissionProblems.js';

/** Where a notice landed, or why it did not go out. Counted for `/diagnostics`. */
export type ProblemNoticeOutcome =
  | 'system_channel'
  | 'contact_dm'
  | 'creator_channel'
  | 'undeliverable'
  | 'skipped';

/** The persistence seam. `GuildRepository` satisfies it structurally. */
export interface ProblemNoticeStore {
  markProblemNotified(guildId: string, at: Date, sends: number): Promise<void>;
  clearProblemNotified(guildId: string): Promise<void>;
}

export interface PermissionProblemNotifierOptions {
  client: Client;
  /** Row source (SettingsCache): settings, owner and auth status in one read. */
  guilds: GuildSettingsReader;
  /** Writes the notice history. Omit and the backoff is memory-only. */
  store?: ProblemNoticeStore;
  /** The incident store a notice is rendered from. */
  problems: PermissionProblemTracker;
  /** Creator channels, for the last-resort rung. */
  autoChannels: AutoChannelRepository;
  /** Runtime control plane. Omit to run with no kill switch (tests). */
  flags?: RuntimeFlagsRepository;
  selfHosted: boolean;
  logger: Logger;
  /** Reports a fleet-wide delivery failure to whoever runs the deployment. */
  report?: (kind: string, message: string, context: Record<string, unknown>) => void;
  /** How long a burst may accumulate before a notice is rendered. Default 30s. */
  coalesceMs?: number;
  /** Gap after a notice that landed in a channel. Default 250ms. */
  channelPaceMs?: number;
  /** Gap after a notice that landed in a DM. Default 3s. */
  dmPaceMs?: number;
  /** How long a flag snapshot is reused. Default 30s. */
  flagCacheMs?: number;
  now?: () => number;
  /** Sleep seam, so tests need not wait out the pacer. */
  wait?: (ms: number) => Promise<void>;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * How long to wait before saying it again, indexed by how many times it has
 * already been said in this run of the condition. Past the end, stop.
 *
 * A permission problem is a STATE, not an event: the safety-net sweep re-tests
 * every guild every five minutes, and the create path is not self-limiting on
 * failure, so a guild with one member parked in a broken creator channel
 * regenerates the same incident twelve times an hour indefinitely. A flat 6h
 * cooldown is therefore not a cooldown, it is a subscription: four messages a
 * day, forever, to a guild that has been ignoring them since the first one.
 *
 * Four notices spread over five days is enough for anyone who intends to act.
 * After that the silence is the message, and `/setup` is still there for
 * whoever comes back to it.
 */
const BACKOFF_MS = [6 * HOUR, 24 * HOUR, 72 * HOUR] as const;

/**
 * How long a stored notice history stays authoritative.
 *
 * The ladder ends in permanent silence, and that stop is durable while the
 * thing that lifts it, {@link PermissionProblemTracker.onResolved}, is an
 * in-memory event. A guild whose problem cleared while no process held its
 * state, which after a restart is every guild, would keep a `sends: 4` stamp
 * that nothing could ever clear, and would never be told about any future
 * problem for as long as the row lived.
 *
 * So a run of the condition also ends by simply going quiet: a stamp nobody has
 * refreshed in a month describes a problem that is over, whatever it says.
 */
const RUN_EXPIRY_MS = 30 * 24 * HOUR;

/** Cap on guilds waiting to be told, so a fleet-wide event cannot grow unbounded. */
const MAX_PENDING = 500;

/** How many creator channels the last-resort rung will try. */
const MAX_CREATOR_ATTEMPTS = 3;

/** Undeliverable notices before a failure rate is worth an operator's attention. */
const FLEETWIDE_MIN_FAILURES = 10;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** A guild's notice history, in memory and mirrored to `metadata.problems`. */
interface NoticeState {
  lastNotifiedAt: number;
  sends: number;
}

/**
 * Tells a guild's admins that the bot has stopped being able to do the thing
 * they installed it for.
 *
 * **The problem here was delivery, not wording.** These incidents were reported
 * only through `serverLog`, which posts to the `/logging` channel and nowhere
 * else. That is opt-in and 5 of 1008 guilds have one configured, so the single
 * most actionable message the bot produces reached effectively nobody, and
 * everyone else found out when a member complained that joining the creator
 * channel did nothing.
 *
 * `serverLog` is untouched and still fires per incident. A log is a log:
 * contemporaneous, unabridged, and in a channel its guild asked for. This is a
 * different object with a different audience, so it does not use that channel
 * as a rung and does not replace those lines.
 *
 * ## Why this is not a durable queue
 *
 * `billing_notifications` exists because the fleet that DECIDES a guild is owed
 * a message may not be in that guild, so the decision has to outlive the
 * process that made it. None of that applies here. Detection is
 * {@link PermissionProblemTracker}, which is in-memory and per instance
 * precisely because a guild lives on exactly one instance, so the process that
 * detects the problem is by construction a process that can deliver it. And the
 * message describes a level, not an edge: if this process dies with a notice
 * undelivered, the sweep re-detects the same still-true condition within five
 * minutes and the replacement sends it. A durable queue would add a table, a
 * migration, a claim query and a drain tick to solve a handoff that does not
 * exist, and to make an at-least-once guarantee out of something that
 * regenerates itself.
 *
 * ## Why this is not the `alerts` table
 *
 * `AlertAudience` is `hosted | self_host | both`: every value names whoever
 * OPERATES the deployment. A customer's channel overwrite is not our incident,
 * and putting a thousand guilds' misconfigurations in the operator's alert feed
 * would bury the alerts that are ours. The one thing here that IS operator
 * business is the aggregate, and that goes out through {@link report}.
 */
export class PermissionProblemNotifier {
  private readonly state = new Map<string, NoticeState>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private readonly coalesceMs: number;
  private readonly channelPaceMs: number;
  private readonly dmPaceMs: number;
  private readonly flagCacheMs: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private flagCache: { at: number; disabled: boolean } | undefined;
  /** Earliest instant the next notice may go out. See {@link takeSlot}. */
  private nextSlotAt = 0;
  /** Earliest instant the next DM may go out. See {@link takeDmSlot}. */
  private nextDmSlotAt = 0;
  private stopped = false;
  private lastReportAt = 0;

  /** Counters for `GET /diagnostics`. Monotonic for the life of the process. */
  private readonly counters = {
    attempted: 0,
    droppedOverflow: 0,
    suppressedFlag: 0,
    suppressedGate: 0,
    suppressedBackoff: 0,
    gaveUp: 0,
    system_channel: 0,
    contact_dm: 0,
    creator_channel: 0,
    undeliverable: 0,
  };

  constructor(private readonly opts: PermissionProblemNotifierOptions) {
    this.coalesceMs = opts.coalesceMs ?? 30_000;
    this.channelPaceMs = opts.channelPaceMs ?? 250;
    this.dmPaceMs = opts.dmPaceMs ?? 3_000;
    this.flagCacheMs = opts.flagCacheMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.wait = opts.wait ?? sleep;
  }

  /**
   * Sync hook for {@link PermissionProblemTracker.onRecord}.
   *
   * Every branch is an in-memory check and nothing here can throw, because the
   * call site is inside the catch that keeps a 50013 contained to its guild: a
   * throw would escape the very boundary that catch exists to hold, and the
   * per-guild queue would count it as a task failure and walk that guild
   * towards a tripped circuit breaker for being misconfigured.
   *
   * The timer is deliberately NOT rescheduled by a later incident in the same
   * window. Trailing-edge debouncing is right for renames and wrong here: a
   * guild failing continuously would push its own deadline forward forever and
   * never be told at all. The leading window instead lets one reconcile pass
   * accumulate, and 30s comfortably outlasts a pass.
   */
  record(guildId: string): void {
    if (this.stopped || this.pending.has(guildId)) return;
    if (this.pending.size >= MAX_PENDING) {
      this.counters.droppedOverflow += 1;
      return;
    }
    if (!this.dueAt(guildId, this.now())) return;
    const timer = setTimeout(() => {
      this.pending.delete(guildId);
      void this.send(guildId).catch((err: unknown) => {
        this.opts.logger.debug({ err, guildId }, 'problem notice failed');
      });
    }, this.coalesceMs);
    timer.unref?.();
    this.pending.set(guildId, timer);
  }

  /**
   * Sync hook for {@link PermissionProblemTracker.onResolved}: the guild's last
   * incident cleared, so the next problem starts from the shortest interval.
   */
  resolved(guildId: string): void {
    const timer = this.pending.get(guildId);
    if (timer) clearTimeout(timer);
    this.pending.delete(guildId);
    if (!this.state.delete(guildId)) return;
    void this.opts.store?.clearProblemNotified(guildId).catch((err: unknown) => {
      this.opts.logger.debug({ err, guildId }, 'clearing problem notice history failed');
    });
  }

  /** Cancels pending notices. Idempotent. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** The `/diagnostics` block. */
  snapshot(): Record<string, unknown> {
    return {
      ...this.counters,
      pending: this.pending.size,
      tracked: this.state.size,
      backoffHours: BACKOFF_MS.map((ms) => ms / HOUR),
    };
  }

  /**
   * Renders and delivers one guild's outstanding incidents.
   *
   * Exposed for tests. Production reaches it only through {@link record}.
   */
  async send(guildId: string): Promise<ProblemNoticeOutcome> {
    if (this.stopped || this.inFlight.has(guildId)) return 'skipped';
    /**
     * A notice fired during a graceful drain would post against a client that
     * is being torn down, fail, and still have burned the guild's window, on
     * every deploy. The notifier is not in `gracefulDrain`'s ordered sequence
     * (that file belongs to another change in flight), so it checks for itself.
     */
    if (!this.opts.client.isReady()) return 'skipped';

    if (await this.disabled()) {
      this.counters.suppressedFlag += 1;
      return 'skipped';
    }

    const row = await this.opts.guilds.ensure(guildId);
    /**
     * `blocked` is the abuse kill-switch, and a gated guild is paused on
     * purpose. Both matter here rather than at the call sites: `maybeCleanup`
     * is reached through `onGatedLeave` specifically so a gated guild's rooms
     * still get tidied, and its own comment promises that path processes
     * "nothing else about a gated guild". A system-channel post and a DM would
     * be very much something else, and the copy would be wrong besides, since
     * granting a permission fixes nothing while the bot is paused for billing.
     */
    if (!isEntitled({ status: row.authStatus, selfHosted: this.opts.selfHosted })) {
      this.counters.suppressedGate += 1;
      return 'skipped';
    }
    const mode = readProblemAlerts(row.settings);
    if (mode === 'off') {
      this.counters.suppressedGate += 1;
      return 'skipped';
    }

    const now = this.now();
    const state = this.hydrate(guildId, row.metadata);
    if (!this.dueAt(guildId, now)) {
      // `>` not `>=`, matching `dueAt`: a guild on its third notice is merely
      // waiting out 72 hours, and counting it as given up hides the difference
      // between "told recently" and "will never be told again".
      this.counters[state && state.sends > BACKOFF_MS.length ? 'gaveUp' : 'suppressedBackoff'] += 1;
      return 'skipped';
    }

    /**
     * Only incidents recent enough to still be happening.
     *
     * The tracker never ages entries out, and `clear()` only fires when an
     * operation on that exact channel succeeds, so a channel that broke, was
     * fixed, and has had nobody join it since keeps its entry. That is fine for
     * `/setup`, which a human pulled and can sanity-check, and not fine for a
     * push that asserts "this is happening now" and names somewhere to go fix.
     */
    const fresh = this.opts.problems
      .recent(guildId)
      .filter((p) => now - p.at < BACKOFF_MS[0]!) as PermissionProblem[];
    if (fresh.length === 0) return 'skipped';

    this.inFlight.add(guildId);
    const sends = (state?.sends ?? 0) + 1;
    /**
     * Stamped on ATTEMPT, before delivery.
     *
     * A guild whose permissions are broken is exactly the guild every rung can
     * fail for, and also the guild the sweep re-tests every five minutes. On
     * confirmed-delivery-only, that guild would re-walk guild fetch, channel
     * post, DM open and N creator-channel posts twelve times an hour forever.
     * The cost of this choice is that a genuine transient failure loses one
     * window, which the next window recovers.
     */
    this.state.set(guildId, { lastNotifiedAt: now, sends });
    this.counters.attempted += 1;
    try {
      const outcome = await this.deliver(guildId, row.settings, fresh, mode, sends);
      this.counters[outcome] += 1;
      /**
       * Only stamp if the guild was not resolved while this was in flight.
       *
       * Delivery takes REST calls and can sit in the pacer for a minute, and
       * `resolved()` fires from the voice path meanwhile. Both writes are
       * fire-and-forget on the same row and this one is issued last, so without
       * the check it resurrects a history that had just been cleared, and the
       * guild's NEXT problem is silenced for a backoff interval it never
       * earned. The identity check is the claim made at the top of this method:
       * if it is still ours, nothing else has touched it.
       */
      if (this.state.get(guildId)?.lastNotifiedAt === now) {
        void this.opts.store
          ?.markProblemNotified(guildId, new Date(now), sends)
          .catch((err: unknown) => {
            this.opts.logger.debug({ err, guildId }, 'stamping the problem notice failed');
          });
      }
      if (outcome === 'undeliverable') {
        /**
         * Warn, not debug, and reported to the operator.
         *
         * This codebase has already been bitten by containing a failure into
         * silence: swallowing a system-channel error "made every notification
         * look like it was DM-by-design". A fleet-wide inability to deliver and
         * a fleet with nothing broken look identical in the logs and completely
         * different in these counters.
         */
        this.opts.logger.warn(
          { guildId, problems: fresh.length },
          'nowhere to deliver a permission problem notice',
        );
        this.reportIfFleetwide();
      } else {
        this.opts.logger.info(
          { guildId, outcome, sends, problems: fresh.length },
          'problem notice sent',
        );
      }
      return outcome;
    } finally {
      this.inFlight.delete(guildId);
    }
  }

  /** Walks the ladder, stopping at the first rung that accepts the message. */
  private async deliver(
    guildId: string,
    settings: Record<string, unknown>,
    problems: readonly PermissionProblem[],
    mode: 'contact' | 'quiet',
    sends: number,
  ): Promise<Exclude<ProblemNoticeOutcome, 'skipped'>> {
    /**
     * From the cache, not REST. The guild is on this instance's shard by
     * definition, which is the same fact that lets the tracker be per process.
     * `DiscordBillingNotifier` fetches only because the reconcile job notifies
     * fleet-wide from one instance, which does not apply here.
     */
    const guild = this.opts.client.guilds.cache.get(guildId);
    if (!guild) return 'undeliverable';

    const contactId = await this.resolveContact(guild, settings);
    /**
     * Pinged only when the recipient is the RECORDED contact and is still a
     * member. Never the owner fallback.
     *
     * The fallback is a guess by construction: contacts were backfilled from
     * 2019-era legacy data, 20% have already left, and for 1008 inherited
     * guilds the owner may have no memory of installing this bot at all. An
     * unsolicited ping to that person reads as a misbehaving bot rather than as
     * help. Someone who ran `/setup` or wrote a template is a different case:
     * they asked for this, recently, by name.
     */
    const mentionId = mode === 'contact' ? contactId.mentionable : null;
    const body = problemNoticeBody(permissionProblemSummary(problems), sends, mode);

    await this.takeSlot();

    if (guild.systemChannelId) {
      if (await this.post(guild, guild.systemChannelId, body, mentionId)) return 'system_channel';
    }

    if (contactId.recipient) {
      /**
       * The DM rung books its own, much slower slot on top of the general one.
       *
       * It cannot be folded into {@link takeSlot}, which has to reserve before
       * it knows which rung will answer: reserving the DM rate for everything
       * would pace channel posts twelve times slower than they need to be, and
       * reserving the channel rate for everything would let a burst of guilds
       * with no system channel fire their DMs 250ms apart. Two gates, each
       * priced for what passes through it.
       */
      await this.takeDmSlot();
      if (await this.dm(guild, contactId.recipient, body)) return 'contact_dm';
    }

    /**
     * Last resort: a creator channel's built-in text chat.
     *
     * Publicly visible, so it runs only once both private routes are gone, and
     * it never carries the mention. Several are tried because one may sit in a
     * category that denies the bot Send Messages while another does not, and a
     * channel named in the incident is tried last, since the reason it is in
     * the incident may be that the bot cannot post there either.
     *
     * An arbitrary text channel is NOT tried, at any point. Picking the first
     * channel we can write to is what spam bots do, and servers defend with
     * honeypot channels that auto-ban anything posting in them (owner's call,
     * 2026-08-19). A creator channel is different: an admin configured it for
     * this bot specifically and we hold a row for it.
     */
    const broken = new Set(problems.map((p) => p.channelId));
    const creators = await this.opts.autoChannels.listByGuild(guildId).catch(() => []);
    const ordered = [
      ...creators.filter((c) => !broken.has(c.channelId)),
      ...creators.filter((c) => broken.has(c.channelId)),
    ];
    for (const creator of ordered.slice(0, MAX_CREATOR_ATTEMPTS)) {
      if (await this.post(guild, creator.channelId, body, null)) return 'creator_channel';
    }

    return 'undeliverable';
  }

  /**
   * Who to address, and whether they may be pinged.
   *
   * `recipient` is who gets the DM: the recorded contact if they are still
   * here, else the owner, because reaching a guess beats reaching nobody.
   * `mentionable` is only ever the contact, because a ping is a much stronger
   * act than a DM and a guess is not good enough for it.
   */
  private async resolveContact(
    guild: Guild,
    settings: Record<string, unknown>,
  ): Promise<{ recipient: string | null; mentionable: string | null }> {
    const owner = guild.ownerId || null;
    const contactId = readContact(settings);
    if (!contactId) return { recipient: owner, mentionable: null };
    /**
     * Cache first, then fetch, and only a failed FETCH means "left".
     *
     * The member cache is broad and unswept but populated lazily, so a miss
     * means "not cached", never "not a member". Treating a miss as departure
     * would silently reroute every notice to the owner fallback, which is the
     * recipient this is trying hardest to avoid.
     */
    const member =
      guild.members.cache.get(contactId) ??
      (await guild.members.fetch(contactId).catch(() => null));
    if (!member) return { recipient: owner, mentionable: null };
    return { recipient: contactId, mentionable: contactId };
  }

  /** Posts into a guild channel. Returns whether it landed. */
  private async post(
    guild: Guild,
    channelId: string,
    body: string,
    mentionId: string | null,
  ): Promise<boolean> {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return false;
    try {
      await channel.send({
        content: mentionId ? `<@${mentionId}>\n${body}` : body,
        /**
         * Opt in to exactly one mention, never the default. Defaulting would
         * let anything that reaches this content ping a whole server, and the
         * content is assembled from guild-controlled channel ids.
         */
        allowedMentions: mentionId ? { users: [mentionId] } : { parse: [] },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** DMs the recipient. Returns whether it landed. */
  private async dm(guild: Guild, userId: string, body: string): Promise<boolean> {
    try {
      const user = await this.opts.client.users.fetch(userId);
      // A DM has no surrounding server, so "here" would have no antecedent.
      // Name the guild first, exactly as the billing notifier does.
      await user.send({ content: `**${guild.name}**\n\n${body}`, allowedMentions: { parse: [] } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reports to the operator when the fleet stops being able to reach guilds at
   * all, and not one report per guild.
   *
   * One guild with no system channel, closed DMs and no creator channel we can
   * post in is that guild's own shape, and there are always some. Half of every
   * attempt failing is our bug, and it is the only version of this an operator
   * can act on. Rate-limited so a bad hour is one message, not a thousand.
   */
  private reportIfFleetwide(): void {
    const { attempted, undeliverable } = this.counters;
    if (undeliverable < FLEETWIDE_MIN_FAILURES) return;
    if (undeliverable * 2 < attempted) return;
    const now = this.now();
    if (now - this.lastReportAt < HOUR) return;
    this.lastReportAt = now;
    this.opts.report?.(
      'problem_notice_undeliverable',
      'most permission-problem notices are reaching nobody',
      { attempted, undeliverable, delivered: attempted - undeliverable },
    );
  }

  /** Whether this guild is due a notice, by the escalating backoff. */
  private dueAt(guildId: string, now: number): boolean {
    const state = this.state.get(guildId);
    if (!state) return true;
    const interval = BACKOFF_MS[state.sends - 1];
    // Past the end of the ladder: said four times over five days, and stopping
    // is the decision. `/setup` still reports it to anyone who comes looking.
    if (interval === undefined) return false;
    return now - state.lastNotifiedAt >= interval;
  }

  /**
   * Loads a guild's notice history from `metadata.problems` the first time this
   * process considers it, so a deploy does not reset every guild's backoff.
   *
   * Read once per guild per process rather than per notice, because the row is
   * served from a cache that metadata writes do not invalidate: this process
   * would read back its own pre-write value for up to the 60s TTL. The
   * in-memory map is authoritative from the first send onwards and the stored
   * value only has to answer the question the map cannot, which is what
   * happened before this process existed.
   *
   * It also dedupes across fleets for free: `guilds` is not fleet-scoped, so
   * two fleets in one guild during a transition see each other's history rather
   * than each telling the guild separately.
   */
  private hydrate(guildId: string, metadata: Record<string, unknown>): NoticeState | undefined {
    const known = this.state.get(guildId);
    if (known) return known;
    const stored = readNoticeState(metadata);
    // A stamp nobody has refreshed in a month belongs to a run of the condition
    // that ended. See RUN_EXPIRY_MS: without this, the ladder's permanent
    // silence outlives the problem that earned it.
    if (!stored || this.now() - stored.lastNotifiedAt > RUN_EXPIRY_MS) return undefined;
    this.state.set(guildId, stored);
    return stored;
  }

  private async disabled(): Promise<boolean> {
    if (!this.opts.flags) return false;
    const now = this.now();
    if (this.flagCache && now - this.flagCache.at < this.flagCacheMs)
      return this.flagCache.disabled;
    try {
      const all = await this.opts.flags.getAll();
      const disabled =
        all[RUNTIME_FLAGS.PROBLEM_NOTICE_DISABLED] === true ||
        all[RUNTIME_FLAGS.GLOBAL_PAUSE] === true;
      this.flagCache = { at: now, disabled };
      return disabled;
    } catch (err) {
      // Fail open: a DB blip must not silence the notices, and the guild-level
      // setting plus the backoff already bound how loud they can get.
      this.opts.logger.debug({ err }, 'reading problem-notice flags failed');
      return false;
    }
  }

  /**
   * Waits for this instance's next send slot.
   *
   * The per-guild backoff bounds how often ONE guild hears from us and says
   * nothing about how many guilds hear from us at once. Reconcile-on-READY
   * walks every guild, so a deploy makes every broken guild in the fleet
   * eligible within seconds, and a few hundred messages leaving in the same
   * second is both a rate-limit problem and the exact shape Discord's
   * anti-spam heuristics exist to catch.
   *
   * Per instance, not per fleet, which is the same assumption the tracker
   * makes for a different reason. At more than one instance the fleet-wide rate
   * is multiplied by the instance count, which is acceptable because the guild
   * population is divided by it too.
   */
  private async takeSlot(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextSlotAt);
    /**
     * Reserve BEFORE awaiting, not after delivering.
     *
     * Sends are not serialised: every guild has its own coalesce timer, so a
     * fleet-wide event fires N of them in the same tick and all N reach here
     * before any of them has finished. Booking the slot only on the way out
     * meant all N read the same free slot, nobody waited, and the whole burst
     * left at once, which is precisely what this exists to stop.
     */
    this.nextSlotAt = at + this.channelPaceMs;
    if (at > now) await this.wait(at - now);
  }

  /**
   * The DM rung's own, much slower gate.
   *
   * It cannot be folded into {@link takeSlot}, which has to reserve before it
   * knows which rung will answer. Reserving the DM rate for every notice would
   * pace channel posts twelve times slower than they need to be, and reserving
   * the channel rate for everything would let a burst of guilds that all lack a
   * system channel fire their DMs 250ms apart. Two gates, each priced for what
   * passes through it, and this is the rate `announce.ts` chose for the same
   * act: a few hundred quick unsolicited DMs is the exact shape of a spam
   * report.
   */
  private async takeDmSlot(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextDmSlotAt);
    this.nextDmSlotAt = at + this.dmPaceMs;
    if (at > now) await this.wait(at - now);
  }
}

/** Reads the stored notice history out of `metadata.problems`. */
export function readNoticeState(
  metadata: Record<string, unknown>,
): { lastNotifiedAt: number; sends: number } | undefined {
  const raw = metadata['problems'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const at = typeof obj['lastNotifiedAt'] === 'string' ? Date.parse(obj['lastNotifiedAt']) : NaN;
  if (Number.isNaN(at)) return undefined;
  const sends = typeof obj['sends'] === 'number' && obj['sends'] > 0 ? Math.floor(obj['sends']) : 1;
  return { lastNotifiedAt: at, sends };
}

/**
 * The notice body: what broke, how to change this, and, on the last one, that
 * it is the last one.
 *
 * Deliberately not one `permissionProblemMessage` per incident. An admin whose
 * category permissions changed has every channel under it fail at once, and
 * four near-identical paragraphs is how a real problem gets read as noise.
 *
 * The control is named in the copy because it cannot be offered as a button:
 * the interaction router drops anything not `inGuild()`, so a button on the DM
 * rung would silently do nothing, and making it work means changing the front
 * door every interaction passes through.
 */
export function problemNoticeBody(
  lines: readonly string[],
  sends: number,
  mode: 'contact' | 'quiet',
): string {
  /**
   * There are `BACKOFF_MS.length + 1` notices in total: the first is
   * unconditional and each interval buys one more. So the last one is number
   * four, not number three, which is what `>=` made it say.
   */
  const last = sends > BACKOFF_MS.length;
  const tail = last
    ? 'This is the last time I will bring it up. Run `/setup` any time to see it again.'
    : mode === 'contact'
      ? 'Run `/setup` for the full picture, or `/logging` to change who I tell about this.'
      : 'Run `/setup` for the full picture.';
  return ['⚠️ **Auto Voice Channels has stopped working here.**', ...lines, tail].join('\n\n');
}
