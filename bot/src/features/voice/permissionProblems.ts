/**
 * Tracks "I can't manage this channel" incidents so they can be surfaced to
 * admins (in `/setup` and the `/logging` channel) instead of failing silently in
 * the logs and retrying forever.
 *
 * In-memory and per-guild: a guild always lives on a single shard/instance, so
 * the same process that records an incident also serves that guild's `/setup` —
 * no cross-instance sharing is needed.
 */
export type PermissionOperation = 'create' | 'move' | 'delete' | 'rename' | 'privacy';

export interface PermissionProblem {
  channelId: string;
  operation: PermissionOperation;
  /** Epoch ms when last seen (passed in by the caller; bot code, so `Date.now()` is fine). */
  at: number;
}

const MAX_PER_GUILD = 10;

/** One guild's live incidents, as {@link PermissionProblemTracker.activeGuilds} reports them. */
export interface PermissionProblemSummary {
  guildId: string;
  problems: PermissionProblem[];
  /** Epoch ms of the most recent incident in `problems`. */
  lastAt: number;
}

export class PermissionProblemTracker {
  private readonly byGuild = new Map<string, PermissionProblem[]>();

  /**
   * Notified after an incident is recorded, so it can be pushed to the guild
   * rather than waiting for someone to run `/setup`.
   *
   * A settable property rather than a constructor option because the notifier
   * needs this tracker to render from, so one of the two has to be wired after
   * the other exists. Same late-binding shape as `countError.record` and
   * `opsReport.report` in `index.ts`.
   *
   * Must be synchronous, in-memory and incapable of throwing: every call site
   * is inside the catch that keeps one guild's failure inside that guild, so a
   * throw here escapes the very boundary it was raised behind. It is
   * try/caught below for that reason, exactly as `GuildQueue.onTaskFailure` is.
   */
  onRecord: ((guildId: string, problem: PermissionProblem) => void) | undefined;

  /**
   * Notified when a guild's last incident clears, i.e. the guild went from
   * having a problem to having none.
   *
   * This is what makes the notifier's escalating backoff resettable. Without
   * it, a guild that broke, was told, and was fixed would keep the backoff it
   * had climbed to, so the next unrelated problem months later would be
   * reported on a three-day delay or not at all.
   */
  onResolved: ((guildId: string) => void) | undefined;

  /** Records an incident, keeping only the latest per channel (most-recent first). */
  record(guildId: string, problem: PermissionProblem): void {
    const next = [
      problem,
      ...(this.byGuild.get(guildId) ?? []).filter((p) => p.channelId !== problem.channelId),
    ];
    this.byGuild.set(guildId, next.slice(0, MAX_PER_GUILD));
    this.fire(this.onRecord, guildId, problem);
  }

  recent(guildId: string): PermissionProblem[] {
    return this.byGuild.get(guildId) ?? [];
  }

  /**
   * Every guild with an incident seen within `sinceMs`, for the self-host
   * watcher (`plans/agentic_management.md` step 4).
   *
   * **Filtered on age rather than returning the whole map**, because the map is
   * only ever pruned by a SUCCESSFUL operation on the same channel. A guild
   * nobody has fixed and nobody has revisited keeps its entry indefinitely, so
   * an unfiltered read would grow monotonically across the install base and
   * report a guild that broke in March as broken today.
   *
   * Note what the age therefore means: `at` is stamped when an operation last
   * FAILED, not when the problem was last true. A guild nobody has joined for
   * seven hours reads as healthy here. That is the honest reading of what is
   * recorded, and it is the right bias for an alert -- a problem nobody is
   * hitting is not one to wake someone for.
   */
  activeGuilds(sinceMs: number, now = Date.now()): PermissionProblemSummary[] {
    const cutoff = now - sinceMs;
    const out: PermissionProblemSummary[] = [];
    for (const [guildId, problems] of this.byGuild) {
      const fresh = problems.filter((p) => p.at >= cutoff);
      if (fresh.length === 0) continue;
      out.push({
        guildId,
        problems: fresh,
        lastAt: Math.max(...fresh.map((p) => p.at)),
      });
    }
    return out;
  }

  /** Clears a channel's incident (e.g. once it's been resolved/cleaned up). */
  clear(guildId: string, channelId: string): void {
    if (!this.byGuild.has(guildId)) return;
    const remaining = (this.byGuild.get(guildId) ?? []).filter((p) => p.channelId !== channelId);
    if (remaining.length) {
      this.byGuild.set(guildId, remaining);
      return;
    }
    this.byGuild.delete(guildId);
    this.fire(this.onResolved, guildId, undefined);
  }

  /** Invokes a hook without ever letting it throw. See {@link onRecord}. */
  private fire<T>(
    hook: ((guildId: string, arg: T) => void) | undefined,
    guildId: string,
    arg: T,
  ): void {
    try {
      hook?.(guildId, arg);
    } catch {
      // Tracking must not fail because reporting did.
    }
  }
}

/**
 * The actionable message for an incident, tailored to the operation.
 *
 * **Creating and losing access are different failures and must not share
 * wording.** Both surface as Discord's `50013`, but the fixes have nothing in
 * common: sharing one wording sends an admin to check permissions the bot
 * already holds while the real cause is an overwrite it isn't allowed to
 * copy. Advice that names the wrong fix is worse than no advice, since it
 * burns the admin's trust in the panel.
 *
 * The create branch's wording must also track `maskOverwrites`: since that
 * masks every overwrite down to the bot's own bits before the create (and
 * sends none at all without Manage Roles), no copied override can refuse a
 * create any more, so this message must not blame one.
 */
export function permissionProblemMessage(
  channelId: string,
  operation: PermissionOperation | 'access' = 'access',
): string {
  if (operation === 'create') {
    return (
      `⚠️ I could not create a channel from <#${channelId}>. I need **Manage Channels** on it ` +
      'or on its category. If my role has it server-wide, check the category for an override ' +
      'that takes it away again, because a channel override beats a server-wide role. ' +
      '**Manage Roles** too, if new rooms should inherit permissions rather than just match ' +
      'the category.'
    );
  }
  if (operation === 'move') {
    return (
      `⚠️ I made a room from <#${channelId}> but could not move anyone into it, so I deleted ` +
      'it again. I need **Move Members**, on the category the rooms are made in or on my role.'
    );
  }
  if (operation === 'privacy') {
    return (
      `⚠️ I made a room from <#${channelId}> but could not make it private, so I deleted it ` +
      'again. I need **Manage Roles** (to set permission overrides) and **Connect**, on the ' +
      'category the rooms are made in or on my role.'
    );
  }
  return (
    `⚠️ I cannot manage <#${channelId}>, I have lost access to it (a permission override is ` +
    'hiding it from me). Grant my role **View Channel**, **Connect**, **Manage Channels** and ' +
    "**Move Members** on that channel or its category, then it'll work again. " +
    "(I've stopped managing it for now.)"
  );
}

/** How many channels a summary names before it stops listing them. */
const SUMMARY_LIST_CAP = 5;

/**
 * What {@link permissionProblemSummary} needs from an incident.
 *
 * Looser than {@link PermissionProblem} so `/setup` can pass its own panel
 * input straight in: that shape has no `at`, and its `operation` is optional
 * because a problem recorded before the operation was tracked has none.
 */
export interface ProblemLike {
  channelId: string;
  operation?: PermissionOperation;
}

/**
 * One guild's incidents as at most two lines: what could not be created, and
 * what was lost access to.
 *
 * Split on the same seam as {@link permissionProblemMessage} and for the same
 * reason — both failures are Discord's `50013` and their fixes have nothing in
 * common — but aggregated, because an admin with three broken creator channels
 * wants one message naming all three, not three messages.
 *
 * Shared with `/setup`, which rendered these lines inline until this was
 * extracted. There is exactly one wording of this advice on purpose: the panel
 * and the push notice disagreeing about the fix is how an admin ends up
 * distrusting both.
 */
export function permissionProblemSummary(problems: readonly ProblemLike[]): string[] {
  const list = (ps: readonly ProblemLike[]): string => {
    const shown = ps.slice(0, SUMMARY_LIST_CAP).map((p) => `<#${p.channelId}>`);
    const rest = ps.length - shown.length;
    // "at least", not an exact count: the tracker itself keeps only the 10
    // most recent per guild, so a guild with 40 broken channels has already
    // lost 30 before this ever sees them. An exact-looking number that is
    // wrong by an order of magnitude is worse than an honest lower bound.
    return rest > 0 ? `${shown.join(', ')} and at least ${rest} more` : shown.join(', ');
  };
  const creates = problems.filter((p) => p.operation === 'create');
  const moves = problems.filter((p) => p.operation === 'move');
  const privacyFails = problems.filter((p) => p.operation === 'privacy');
  const access = problems.filter(
    (p) => p.operation !== 'create' && p.operation !== 'move' && p.operation !== 'privacy',
  );
  const lines: string[] = [];
  if (creates.length > 0) {
    lines.push(
      `I could not create rooms from ${list(creates)}. I need **Manage Channels** there or on ` +
        'the category. If my role has it server-wide, check the category for an override that ' +
        'takes it away again, because a channel override beats a server-wide role. ' +
        '**Manage Roles** too, if new rooms should inherit permissions rather than just match ' +
        'the category.',
    );
  }
  /**
   * Its own line, because the other two would both be false here.
   *
   * A move failure means the room WAS created and then nobody could be put in
   * it, so "I could not create rooms" is wrong and "I lost access and stopped
   * managing it" is wrong twice over: the channel named is the creator channel,
   * which just worked, and nothing stopped being managed. The fix is one
   * permission and it is not in either of the other lists.
   */
  if (moves.length > 0) {
    lines.push(
      `I made rooms from ${list(moves)} but could not move anyone into them, so I deleted ` +
        'them again. I need **Move Members**, on the category the rooms are made in or on my ' +
        'role.',
    );
  }
  /**
   * Also its own line, for the same reason as `moves`: the room was created
   * (so "I could not create rooms" is wrong) and then deleted (so "I lost
   * access and stopped managing it" is wrong too). Only the permission named
   * differs from a move failure.
   */
  if (privacyFails.length > 0) {
    lines.push(
      `I made rooms from ${list(privacyFails)} but could not make them private, so I deleted ` +
        'them again. I need **Manage Roles** (to set permission overrides) and **Connect**, on ' +
        'the category the rooms are made in or on my role.',
    );
  }
  if (access.length > 0) {
    lines.push(
      `I lost access to ${list(access)} and stopped managing ` +
        `${access.length === 1 ? 'it' : 'them'}. Grant my role **View Channel**, ` +
        '**Connect**, **Manage Channels** and **Move Members** on the channel (or its ' +
        "category), then it'll work again.",
    );
  }
  return lines;
}
