import type { CommandCaller } from './commandAccess.js';
import type {
  BotRoleAccess,
  GuildVoiceView,
  MemberFacts,
  VoiceChannelProperties,
  VoiceMember,
} from './types.js';

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
  /** channelId → bitrate/region/video-quality/nsfw. Unset → "cannot say". */
  private readonly voiceProperties = new Map<string, VoiceChannelProperties>();
  /** channelId → live user limit. Unset → "cannot say", read as unlimited. */
  private readonly userLimits = new Map<string, number>();
  /** ownerId → their standing under `/restrict`. Unset → "cannot say". */
  private readonly ownerAccess = new Map<string, CommandCaller>();
  /** memberId → what they are (bot, Administrator, server owner). Unset → "cannot say". */
  private readonly facts = new Map<string, MemberFacts>();
  /** The bot's role standing. Unset → "cannot say". */
  private roleAccess: { leaveRoleId: string | null; uneditableRoleIds: string[] } | undefined;
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
    // the order they were asked about in.
    //
    // This models the ordering the misorder check reasons about, which is OUR
    // intended one, and deliberately not what a client renders: a Discord client
    // was measured rendering a tied trio out of id order entirely. That is why a
    // tie cannot be detected here at all, and why `positionCollides` exists as a
    // separate question rather than being folded into this one.
    return known.sort((a, b) => this.positions.get(a)! - this.positions.get(b)!);
  }

  /** Sets a channel's raw position, enabling {@link displayOrderOf} for it. */
  setPosition(channelId: string, position: number): void {
    this.positions.set(channelId, position);
  }

  /**
   * Opt-in like {@link displayOrderOf}: a test that sets no limit gets
   * `undefined`, which every caller reads as unlimited, so `{{FULL}}` fails
   * open and no test that predates the capacity tokens changes behaviour.
   */
  userLimitOf(channelId: string): number | undefined {
    return this.userLimits.get(channelId);
  }

  /** Sets a channel's live user limit, for `@@limit@@`/`@@slots@@`/`{{FULL}}`. */
  setUserLimit(channelId: string, limit: number): void {
    this.userLimits.set(channelId, limit);
  }

  /**
   * Opt-in like {@link userLimitOf}: a test that never says who an owner is gets
   * `undefined`, which the panel reads as "cannot say" and hides nothing for, so
   * no test that predates `/restrict` changes behaviour.
   */
  ownerAccessOf(_channelId: string, ownerId: string): CommandCaller | undefined {
    return this.ownerAccess.get(ownerId);
  }

  /** Says who an owner is for `/restrict`: their roles and whether they can manage channels. */
  setOwnerAccess(ownerId: string, access: { roleIds?: string[]; canManage?: boolean }): void {
    this.ownerAccess.set(ownerId, {
      userId: ownerId,
      roleIds: access.roleIds ?? [],
      canManage: access.canManage ?? false,
    });
  }

  /** Forgets who an owner is, which reads as "cannot say" again. */
  clearOwnerAccess(ownerId: string): void {
    this.ownerAccess.delete(ownerId);
  }

  /**
   * Opt-in like {@link ownerAccessOf}: a member nobody described is "cannot say",
   * which is read as "not exempt", so no test that predates saved lists changes.
   */
  memberFacts(_guildId: string, memberId: string): MemberFacts | undefined {
    return this.facts.get(memberId);
  }

  /** Says what a member is: a bot, an Administrator, the server's owner. */
  setMemberFacts(memberId: string, facts: Partial<MemberFacts>): void {
    this.facts.set(memberId, {
      bot: facts.bot ?? false,
      administrator: facts.administrator ?? false,
      guildOwner: facts.guildOwner ?? false,
    });
  }

  /**
   * Opt-in as well: a test that never describes the bot's roles gets "cannot say",
   * so no role is treated as out of its reach.
   */
  botRoleAccess(_guildId: string, roleIds: readonly string[]): BotRoleAccess | undefined {
    if (!this.roleAccess) return undefined;
    return {
      leaveRoleId: this.roleAccess.leaveRoleId,
      uneditableRoleIds: roleIds.filter((id) => this.roleAccess!.uneditableRoleIds.includes(id)),
    };
  }

  /** Says which roles the bot cannot edit, and which is its own managed role. */
  setBotRoleAccess(access: { leaveRoleId?: string | null; uneditableRoleIds?: string[] }): void {
    this.roleAccess = {
      leaveRoleId: access.leaveRoleId ?? null,
      uneditableRoleIds: access.uneditableRoleIds ?? [],
    };
  }

  voicePropertiesOf(channelId: string): VoiceChannelProperties | undefined {
    return this.voiceProperties.get(channelId);
  }

  /** Sets a channel's live bitrate/region/video-quality/nsfw, enabling {@link voicePropertiesOf}. */
  setVoiceProperties(channelId: string, props: VoiceChannelProperties): void {
    this.voiceProperties.set(channelId, props);
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
