/**
 * Tracks "I can't manage this channel" incidents so they can be surfaced to
 * admins (in `/setup` and the `/logging` channel) instead of failing silently in
 * the logs and retrying forever.
 *
 * In-memory and per-guild: a guild always lives on a single shard/instance, so
 * the same process that records an incident also serves that guild's `/setup` —
 * no cross-instance sharing is needed.
 */
export type PermissionOperation = 'create' | 'move' | 'delete' | 'rename';

export interface PermissionProblem {
  channelId: string;
  operation: PermissionOperation;
  /** Epoch ms when last seen (passed in by the caller; bot code, so `Date.now()` is fine). */
  at: number;
}

const MAX_PER_GUILD = 10;

export class PermissionProblemTracker {
  private readonly byGuild = new Map<string, PermissionProblem[]>();

  /** Records an incident, keeping only the latest per channel (most-recent first). */
  record(guildId: string, problem: PermissionProblem): void {
    const next = [
      problem,
      ...(this.byGuild.get(guildId) ?? []).filter((p) => p.channelId !== problem.channelId),
    ];
    this.byGuild.set(guildId, next.slice(0, MAX_PER_GUILD));
  }

  recent(guildId: string): PermissionProblem[] {
    return this.byGuild.get(guildId) ?? [];
  }

  /** Clears a channel's incident (e.g. once it's been resolved/cleaned up). */
  clear(guildId: string, channelId: string): void {
    const remaining = (this.byGuild.get(guildId) ?? []).filter((p) => p.channelId !== channelId);
    if (remaining.length) this.byGuild.set(guildId, remaining);
    else this.byGuild.delete(guildId);
  }
}

/**
 * The actionable message for an incident, tailored to the operation.
 *
 * **Creating and losing access are different failures and must not share
 * wording.** Both surface as Discord's `50013`, but the fixes have nothing in
 * common, and for months every one of them was reported as "I lost access to
 * this channel, grant me View Channel, Connect, Manage Channels and Move
 * Members". On 2026-08-19 that sent an admin to check four permissions the bot
 * already held, on the channel and on its category, while the real cause was
 * an overwrite the bot is not allowed to copy. Advice that names the wrong fix
 * is worse than no advice: it burns the admin's trust in the panel.
 */
export function permissionProblemMessage(
  channelId: string,
  operation: PermissionOperation | 'access' = 'access',
): string {
  if (operation === 'create') {
    return (
      `⚠️ I could not create a channel from <#${channelId}>. I need **Manage Channels** and ` +
      '**Manage Roles** on it or its category, and I can only copy permissions I hold myself, ' +
      'so an override there granting something I do not have will stop me. If my permissions ' +
      'look right already, that override is the thing to look at, or point me somewhere ' +
      'simpler with `/inheritpermissions`.'
    );
  }
  return (
    `⚠️ I cannot manage <#${channelId}>, I have lost access to it (a permission override is ` +
    'hiding it from me). Grant my role **View Channel**, **Connect**, **Manage Channels** and ' +
    "**Move Members** on that channel or its category, then it'll work again. " +
    "(I've stopped managing it for now.)"
  );
}
