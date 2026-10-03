import { RUNTIME_FLAGS, type Logger, type RuntimeFlagsRepository } from '@avc/core';
import type { CreateGateDecision, CreationGate } from '../features/voice/index.js';

export interface RuntimeCreationGateOptions {
  flags: RuntimeFlagsRepository;
  logger: Logger;
  /**
   * Whether this instance can still prove it holds the shard lease.
   *
   * **Live creation needs its own ownership guard.** `ownsGuild` is
   * consulted by the reconcile sweep and by nothing on the live join path, so an
   * instance whose lease had aged out would stop pruning rows and carry on
   * creating rooms. Discord delivers the same VOICE_STATE_UPDATE to every open
   * session for a shard, so once a peer has claimed the same shard both
   * instances create a room on the same join.
   *
   * Optional, so a self-host and every existing test are unchanged: absent means
   * ownership is never in doubt, which for one instance holding every shard is
   * true.
   */
  leasesProven?: () => boolean;
  /** Sliding throttle window (ms). Defaults to 60s (limit is "per minute"). */
  windowMs?: number;
  /** How long to cache the flag snapshot to avoid a DB read per create (ms). */
  flagCacheMs?: number;
}

/**
 * The live creation gate backing the runtime control plane. Denies creation when
 * `global.pause` is set, and enforces `create.rate_limit_per_min` as a per-guild
 * sliding window. Flag reads are cached briefly so a join storm doesn't hammer
 * Postgres; the throttle window is kept in memory per guild.
 *
 * Per-guild isolation: one guild hitting its throttle never affects another.
 */
export class RuntimeCreationGate implements CreationGate {
  private readonly windowMs: number;
  private readonly flagCacheMs: number;
  private readonly events = new Map<string, number[]>();
  private flagCache:
    | {
        at: number;
        paused: boolean;
        limit: number;
        orderRepairDisabled: boolean;
        companionTextDisabled: boolean;
        controlPanelDisabled: boolean;
        commandAccessDisabled: boolean;
        roomAccessDisabled: boolean;
        memberPrefsDisabled: boolean;
      }
    | undefined;

  constructor(private readonly opts: RuntimeCreationGateOptions) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.flagCacheMs = opts.flagCacheMs ?? 2_000;
  }

  async allowCreate(guildId: string): Promise<CreateGateDecision> {
    /**
     * Checked FIRST, and before the flag read, because it needs no I/O and
     * because creating a room this instance may not own is the worst of the
     * outcomes this gate exists to prevent.
     *
     * Costs nothing real when it fires: the create path needs
     * `autoChannels.get` per join, so if the lease cannot be refreshed the
     * database is almost certainly unreachable and the create would fail a
     * moment later anyway. The difference is that it fails here, once, with a
     * reason, instead of racing a peer.
     */
    if (this.opts.leasesProven && !this.opts.leasesProven()) {
      return { allowed: false, reason: 'shard lease could not be refreshed' };
    }

    const { paused, limit, orderRepairDisabled, companionTextDisabled, controlPanelDisabled } =
      await this.readFlags();
    if (paused) return { allowed: false, reason: 'global pause' };
    // Carried on every allowed decision, so the caller reads one consistent
    // snapshot rather than racing a second flag read against this one.
    const extra = {
      ...(orderRepairDisabled ? { orderRepairDisabled: true } : {}),
      ...(companionTextDisabled ? { companionTextDisabled: true } : {}),
      ...(controlPanelDisabled ? { controlPanelDisabled: true } : {}),
    };
    if (limit <= 0) return { allowed: true, ...extra };

    const now = Date.now();
    const recent = (this.events.get(guildId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= limit) {
      this.events.set(guildId, recent);
      return { allowed: false, reason: `throttled (${limit}/min)` };
    }
    recent.push(now);
    this.events.set(guildId, recent);
    return { allowed: true, ...extra };
  }

  /**
   * The companion lever on its own, for the reconciler's repair path.
   *
   * Shares the cached snapshot, so it costs no extra query, and **fails open**:
   * `allowCreate` lets a flag-read failure refuse the whole room create, which is
   * right for a gate whose job is refusing, and wrong for a feature a guild has
   * switched on. A database blip must not withdraw it.
   */
  async companionTextDisabled(): Promise<boolean> {
    try {
      return (await this.readFlags()).companionTextDisabled;
    } catch (err) {
      this.opts.logger.warn({ err }, 'companion text flag read failed; treating as enabled');
      return false;
    }
  }

  /**
   * The control panel lever alone, for the re-render path, which runs far more
   * often than a create and must not spend a throttle slot to ask.
   *
   * Fails OPEN like the companion's, and for the same reason: a database blip
   * must not withdraw a feature that is on by default. Shares the cached
   * snapshot, so asking costs no extra query.
   */
  async controlPanelDisabled(): Promise<boolean> {
    try {
      return (await this.readFlags()).controlPanelDisabled;
    } catch (err) {
      this.opts.logger.warn({ err }, 'control panel flag read failed; treating as enabled');
      return false;
    }
  }

  /**
   * The restriction lever alone, for the guards, the panel poster and
   * `/restrict list`, none of which is a room create and none of which may spend
   * a throttle slot to ask.
   *
   * Fails OPEN like the two above, and for their reason: a database blip must
   * not quietly withdraw a rule an admin wrote, so a failed read counts as NOT
   * disabled and the rules stay in force. Shares the cached snapshot, so asking
   * costs no extra query. This is NOT `deps.flags.getBool`, which is an uncached
   * SELECT per call, and a guard can run on every interaction.
   */
  async commandAccessDisabled(): Promise<boolean> {
    try {
      return (await this.readFlags()).commandAccessDisabled;
    } catch (err) {
      this.opts.logger.warn({ err }, 'command access flag read failed; treating as enforced');
      return false;
    }
  }

  /**
   * The room access lever alone, for the commands that hide a room or save who may
   * be let in, the knock card's Always allow and the code that applies a saved list.
   * None of them is a room create, and none may spend a throttle slot to ask.
   *
   * Fails OPEN like the three above, and for their reason: a database blip must not
   * quietly withdraw a feature that is on by default, so a failed read counts as NOT
   * disabled. Shares the cached snapshot, so asking costs no extra query. This is NOT
   * `deps.flags.getBool`, which is an uncached SELECT per call, and a command or a
   * knock card can run in a busy room.
   */
  async roomAccessDisabled(): Promise<boolean> {
    try {
      return (await this.readFlags()).roomAccessDisabled;
    } catch (err) {
      this.opts.logger.warn({ err }, 'room access flag read failed; treating as enabled');
      return false;
    }
  }

  /**
   * The remembered room settings lever alone, for the code that saves a member's settings
   * after a command and the code that restores them into a room as it is made. Neither is a
   * room create that may spend a throttle slot to ask, and the save runs after every `/name`,
   * `/limit` and `/private` a member types.
   *
   * Fails OPEN like the four above, and for their reason: remembering is something an admin
   * switched on for a creator channel, and a database blip must not quietly withdraw it, so a
   * failed read counts as NOT disabled. Shares the cached snapshot, so asking costs no extra
   * query. This is NOT `deps.flags.getBool`, which is an uncached SELECT per call.
   */
  async memberPrefsDisabled(): Promise<boolean> {
    try {
      return (await this.readFlags()).memberPrefsDisabled;
    } catch (err) {
      this.opts.logger.warn({ err }, 'member prefs flag read failed; treating as enabled');
      return false;
    }
  }

  private async readFlags(): Promise<{
    paused: boolean;
    limit: number;
    orderRepairDisabled: boolean;
    companionTextDisabled: boolean;
    controlPanelDisabled: boolean;
    commandAccessDisabled: boolean;
    roomAccessDisabled: boolean;
    memberPrefsDisabled: boolean;
  }> {
    const now = Date.now();
    if (this.flagCache && now - this.flagCache.at < this.flagCacheMs) {
      const {
        paused,
        limit,
        orderRepairDisabled,
        companionTextDisabled,
        controlPanelDisabled,
        commandAccessDisabled,
        roomAccessDisabled,
        memberPrefsDisabled,
      } = this.flagCache;
      return {
        paused,
        limit,
        orderRepairDisabled,
        companionTextDisabled,
        controlPanelDisabled,
        commandAccessDisabled,
        roomAccessDisabled,
        memberPrefsDisabled,
      };
    }
    const all = await this.opts.flags.getAll();
    const paused = all[RUNTIME_FLAGS.GLOBAL_PAUSE] === true;
    const rawLimit = all[RUNTIME_FLAGS.CREATE_RATE_LIMIT];
    const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : 0;
    const orderRepairDisabled = all[RUNTIME_FLAGS.VOICE_ORDER_REPAIR_DISABLED] === true;
    const companionTextDisabled = all[RUNTIME_FLAGS.COMPANION_TEXT_DISABLED] === true;
    const controlPanelDisabled = all[RUNTIME_FLAGS.CONTROL_PANEL_DISABLED] === true;
    const commandAccessDisabled = all[RUNTIME_FLAGS.COMMAND_ACCESS_DISABLED] === true;
    const roomAccessDisabled = all[RUNTIME_FLAGS.ROOM_ACCESS_DISABLED] === true;
    const memberPrefsDisabled = all[RUNTIME_FLAGS.MEMBER_PREFS_DISABLED] === true;
    this.flagCache = {
      at: now,
      paused,
      limit,
      orderRepairDisabled,
      companionTextDisabled,
      controlPanelDisabled,
      commandAccessDisabled,
      roomAccessDisabled,
      memberPrefsDisabled,
    };
    return {
      paused,
      limit,
      orderRepairDisabled,
      companionTextDisabled,
      controlPanelDisabled,
      commandAccessDisabled,
      roomAccessDisabled,
      memberPrefsDisabled,
    };
  }
}
