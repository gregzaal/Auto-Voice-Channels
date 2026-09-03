import type { GuildVoiceView, VoiceMember } from './types.js';

/**
 * Mutable in-memory voice view for tests. Tracks channel *existence* separately
 * from membership so reconciliation tests can simulate a vanished channel
 * (`removeChannel`) versus a merely empty one (`ensureChannel` / `drop`).
 */
export class FakeVoiceView implements GuildVoiceView {
  private readonly members = new Map<string, VoiceMember[]>();
  private readonly existing = new Set<string>();
  /** channelId → parent category id (or null = server root). Unset → undefined. */
  private readonly parents = new Map<string, string | null>();
  /** channelId → raw position. Unset → ordering is not knowable for it. */
  private readonly positions = new Map<string, number>();
  /** Whether Discord has handed us this guild. True unless a test says otherwise. */
  private available = true;

  membersInChannel(channelId: string): VoiceMember[] {
    return this.members.get(channelId) ?? [];
  }

  channelExists(channelId: string): boolean {
    return this.existing.has(channelId);
  }

  categoryOf(channelId: string): string | null | undefined {
    return this.parents.get(channelId);
  }

  /**
   * Ordering is opt-in: a test that sets no positions gets `undefined`, i.e.
   * "cannot say", which is what every test that predates channel ordering wants.
   */
  displayOrderOf(channelIds: string[]): string[] | undefined {
    const known = channelIds.filter((id) => this.positions.has(id));
    if (known.length === 0) return undefined;
    // Position only, and the sort is stable, so channels sharing a position keep
    // the order they were asked about in. That models Discord's id tie-break
    // rather than dodging it: callers ask in creation order, ids ascend with
    // creation, and a primary is always older than its own rooms. Test ids are
    // rarely snowflakes, so comparing them directly would model nothing.
    return known.sort((a, b) => this.positions.get(a)! - this.positions.get(b)!);
  }

  /** Sets a channel's raw position, enabling {@link displayOrderOf} for it. */
  setPosition(channelId: string, position: number): void {
    this.positions.set(channelId, position);
  }

  guildAvailable(): boolean {
    return this.available;
  }

  /** Simulates a guild the gateway has not hydrated, so nothing is knowable. */
  setGuildAvailable(available: boolean): void {
    this.available = available;
  }

  /** Sets a channel's parent category (or `null` for the server root), for grouping tests. */
  setParent(channelId: string, categoryId: string | null): void {
    this.parents.set(channelId, categoryId);
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
