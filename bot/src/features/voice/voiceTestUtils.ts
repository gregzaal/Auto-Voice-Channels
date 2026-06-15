import type { GuildVoiceView, VoiceMember } from './types.js';

/**
 * Mutable in-memory voice view for tests. Tracks channel *existence* separately
 * from membership so reconciliation tests can simulate a vanished channel
 * (`removeChannel`) versus a merely empty one (`ensureChannel` / `drop`).
 */
export class FakeVoiceView implements GuildVoiceView {
  private readonly members = new Map<string, VoiceMember[]>();
  private readonly existing = new Set<string>();

  membersInChannel(channelId: string): VoiceMember[] {
    return this.members.get(channelId) ?? [];
  }

  channelExists(channelId: string): boolean {
    return this.existing.has(channelId);
  }

  /** Marks a channel as existing in Discord (possibly empty). */
  ensureChannel(channelId: string): void {
    this.existing.add(channelId);
  }

  /**
   * Adds (or replaces) a member in a channel; implicitly marks it as existing.
   * Re-putting the same id updates that member (e.g. a presence/game change).
   */
  put(channelId: string, member: VoiceMember): void {
    this.existing.add(channelId);
    const list = this.members.get(channelId) ?? [];
    const next = list.filter((m) => m.id !== member.id);
    next.push(member);
    this.members.set(channelId, next);
  }

  /** Removes a member but leaves the channel existing (empty). */
  drop(channelId: string, memberId: string): void {
    const list = (this.members.get(channelId) ?? []).filter((m) => m.id !== memberId);
    this.members.set(channelId, list);
  }

  /** Simulates the channel disappearing from Discord entirely. */
  removeChannel(channelId: string): void {
    this.existing.delete(channelId);
    this.members.delete(channelId);
  }
}

/** Builds a plain non-bot {@link VoiceMember} for tests. */
export function fakeMember(id: string, playing: string[] = []): VoiceMember {
  return { id, displayName: id, bot: false, playing };
}
