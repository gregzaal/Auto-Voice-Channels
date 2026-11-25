import type { Logger } from '@avc/core';
import type { ChannelLimit } from './discordAdapter.js';

const MINUTE = 60 * 1000;

/**
 * How long a creator channel whose create Discord refused for a full category or server is
 * skipped without asking again.
 *
 * Without it every member who joins, and every sweep catching up on the members still waiting,
 * costs one refused create, and a busy server waiting on a full category joins faster than an
 * admin can make space. Short, because the space can come back at any moment, and ended early by
 * a channel deletion that may have made it ({@link ChannelLimitTracker.release}).
 */
export const CHANNEL_LIMIT_COOLDOWN_MS = 2 * MINUTE;

/**
 * How long the member message stays in the creator channel's chat, counted from when it was
 * posted. It is deleted at once when a room is next made from that creator channel, and this
 * is the bound for when nothing ever is.
 */
export const LIMIT_MESSAGE_TTL_MS = 10 * MINUTE;

/**
 * How long a member stays told, so the sweep that catches up on the members still waiting does
 * not mention them again every five minutes. A fresh join always tells the member who joined.
 */
export const LIMIT_TOLD_MS = 60 * MINUTE;

/**
 * How long a creator channel must go without a refusal, after a room was made from it, before
 * the incident is over.
 *
 * A room made is not proof the category has space: a busy one hovers at its limit, because the
 * bot's own rooms come and go, and is refused and then not refused minutes apart all evening.
 * Resolving on the first success reset the notifier's backoff each time, so every refusal after
 * one was a fresh first notice to the server's admins, and a fresh `/logging` line. Half an
 * hour outlasts the churn of an evening's rooms (each is made and emptied within minutes) and
 * several sweeps, while a category an admin really did clear stops being listed under `/setup`
 * soon after.
 */
export const LIMIT_QUIET_MS = 30 * MINUTE;

/** Most members one message mentions. Discord caps a message's allowed users at 100. */
export const MAX_LIMIT_MENTIONS = 20;

/** What the tracker needs from Discord, as two functions so they fake in a line each. */
export interface LimitChat {
  /**
   * Posts into a channel's chat, allowing exactly the user mentions in `mentionIds` and nothing
   * else. Resolves to the message id.
   */
  send(channelId: string, content: string, mentionIds: readonly string[]): Promise<string>;
  remove(channelId: string, messageId: string): Promise<void>;
}

export interface ChannelLimitTrackerDeps {
  /** Absent: nothing is posted, and the cooldown still applies. */
  chat?: LimitChat;
  /**
   * Whether notices the bot sends on its own are switched off (`problems.notify_disabled`).
   * Asked before every post. Absent means not disabled.
   */
  noticesDisabled?: () => Promise<boolean>;
  logger: Logger;
  now?: () => number;
}

interface PostedMessage {
  id: string;
  mentionedIds: ReadonlySet<string>;
  timer?: ReturnType<typeof setTimeout>;
}

interface Entry {
  guildId: string;
  limit: ChannelLimit;
  /** Until when a create from this creator channel is skipped without a request. */
  coolUntil: number;
  /** When Discord last refused a room from it. */
  refusedAt: number;
  /** Whether a room has been made from it since that refusal: the quiet window is running. */
  madeSince: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
  message?: PostedMessage;
  /** When each member was last told. See {@link LIMIT_TOLD_MS}. */
  told: Map<string, number>;
  /** Until when no post is tried again after one failed. */
  quietUntil: number;
}

/**
 * What the members waiting in a creator channel are told when Discord refuses their rooms.
 * Mentions each of them by id, so the send must allow exactly those user mentions.
 */
export function channelLimitMemberMessage(
  memberIds: readonly string[],
  limit: ChannelLimit,
): string {
  const mentions = memberIds.map((id) => `<@${id}>`).join(' ');
  const room = memberIds.length === 1 ? 'your room' : 'your rooms';
  return limit === 'category'
    ? `${mentions} I couldn't make ${room} because this category is full. Discord allows 50 ` +
        'channels in a category. Ask a moderator to make space.'
    : `${mentions} I couldn't make ${room} because this server has reached Discord's limit of ` +
        '500 channels. Ask a moderator to make space.';
}

/**
 * Creator channels Discord refused a room for because a category or the server is full, in
 * memory and per process: a guild lives on one instance, which is the only one that creates its
 * rooms.
 *
 * Holds per creator channel: the cooldown during which a create is skipped without a request,
 * the incident's lifetime (it ends after {@link LIMIT_QUIET_MS} without a refusal once a room has
 * been made, which is when {@link onSettled} fires), and the one message at a time that tells the
 * waiting members why they have no room.
 *
 * **Chat work never holds the guild's queue.** A post or a delete is queued here, one at a time
 * per creator channel, and the call returns at once, so a message rate limit cannot delay the
 * guild's next event or a new room's companion and panel.
 *
 * **A restart forgets the message it posted**, so a message posted just before one stays in the
 * chat until somebody deletes it. Remembering it would need a table, and it is one message in a
 * channel whose chat the server's mods read.
 *
 * Never throws: every call site is on the create path, where a failure to tell somebody must not
 * become a failed task that counts against the guild's circuit breaker.
 */
export class ChannelLimitTracker {
  /**
   * Called when an incident is over: a room was made from the creator channel and nothing has
   * been refused for {@link LIMIT_QUIET_MS}, or nothing has happened there for an hour. The owner
   * clears the guild's problem entry here. Synchronous and contained: a throw is swallowed.
   */
  onSettled: ((guildId: string, creatorId: string) => void) | undefined;

  private readonly entries = new Map<string, Entry>();
  /** The chat work queued per creator channel, so two posts for one never race. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly now: () => number;
  /** Counters for `GET /diagnostics`. Monotonic for the life of the process. */
  private readonly counters = {
    refused: 0,
    skipped: 0,
    posted: 0,
    deleted: 0,
    failed: 0,
    settled: 0,
  };

  constructor(private readonly deps: ChannelLimitTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Records that Discord refused a room from this creator channel, and starts its cooldown.
   * Returns whether this is news: the first refusal of this incident, or of a different limit,
   * which is when the guild's `/logging` channel is told. A refusal inside the quiet window that
   * follows a room being made is the same incident.
   */
  refused(guildId: string, creatorId: string, limit: ChannelLimit): boolean {
    this.counters.refused += 1;
    const now = this.now();
    this.prune(now);
    let entry = this.entries.get(creatorId);
    // Quiet for long enough after a room was made, and its timer has not run yet: that incident
    // is over, and this is a new one.
    if (entry?.madeSince && now - entry.refusedAt >= LIMIT_QUIET_MS) {
      this.settle(creatorId, entry);
      entry = undefined;
    }
    const news = !entry || entry.limit !== limit;
    if (entry) {
      entry.limit = limit;
      entry.coolUntil = now + CHANNEL_LIMIT_COOLDOWN_MS;
      entry.refusedAt = now;
      entry.madeSince = false;
      clearTimeout(entry.settleTimer);
      delete entry.settleTimer;
      trimTold(entry, now);
    } else {
      this.entries.set(creatorId, {
        guildId,
        limit,
        coolUntil: now + CHANNEL_LIMIT_COOLDOWN_MS,
        refusedAt: now,
        madeSince: false,
        told: new Map(),
        quietUntil: 0,
      });
    }
    return news;
  }

  /** The limit this creator channel is cooling down on, or undefined when a create may go ahead. */
  coolingDown(creatorId: string): ChannelLimit | undefined {
    const limit = this.coolingLimit(creatorId);
    if (limit !== undefined) this.counters.skipped += 1;
    return limit;
  }

  /** Whether this creator channel is cooling down, without counting a skipped create. */
  isCoolingDown(creatorId: string): boolean {
    return this.coolingLimit(creatorId) !== undefined;
  }

  /**
   * Tells the members waiting in the creator channel why they have no room, in that channel's
   * own chat. One message per creator channel at a time, mentioning everyone in `waitingIds`
   * (the joining member first): a member it does not mention yet gets a new message, which
   * replaces the old one, because an edit that adds a mention notifies nobody.
   *
   * `joined` is a fresh join. The sweep passes false, and tells only when someone waiting has
   * not been told in the last {@link LIMIT_TOLD_MS}. Returns at once: the post is queued.
   */
  tellMember(
    creatorId: string,
    memberId: string,
    waitingIds: readonly string[],
    joined: boolean,
  ): void {
    if (!this.deps.chat || !this.entries.has(creatorId)) return;
    this.enqueue(creatorId, () => this.tell(creatorId, memberId, waitingIds, joined));
  }

  /**
   * A room was made from this creator channel: its cooldown ends, the member message goes, and
   * the quiet window starts, at the end of which the incident is over unless Discord refuses a
   * room again meanwhile.
   */
  roomMade(creatorId: string): void {
    const entry = this.entries.get(creatorId);
    if (!entry) return;
    entry.coolUntil = 0;
    entry.told.clear();
    this.dropMessage(creatorId, entry);
    entry.madeSince = true;
    const wait = entry.refusedAt + LIMIT_QUIET_MS - this.now();
    if (wait <= 0) {
      this.settle(creatorId, entry);
      return;
    }
    clearTimeout(entry.settleTimer);
    entry.settleTimer = setTimeout(() => {
      if (this.entries.get(creatorId) === entry && entry.madeSince) this.settle(creatorId, entry);
    }, wait);
    entry.settleTimer.unref?.();
  }

  /**
   * A channel was deleted, which may have made the space: ends the cooldown of the creator
   * channels it could have made space for, and returns them, so the caller can make rooms for
   * whoever is waiting there.
   *
   * A full server is waiting for any channel to go. A full category only for one of its own:
   * `parentId` is the deleted channel's category and `categoryOf` the creator channel's. Either
   * unknown counts as a match, because a create too many costs one refused request and a missed
   * one leaves somebody waiting.
   */
  release(
    guildId: string,
    parentId: string | null | undefined,
    categoryOf: (channelId: string) => string | null | undefined,
  ): string[] {
    const released: string[] = [];
    for (const [creatorId, entry] of this.entries) {
      if (entry.guildId !== guildId) continue;
      if (entry.limit === 'category' && parentId !== undefined) {
        const category = categoryOf(creatorId);
        if (category !== undefined && category !== parentId) continue;
      }
      entry.coolUntil = 0;
      released.push(creatorId);
    }
    return released;
  }

  /** The creator channel itself is gone, and its chat and message with it. */
  forget(creatorId: string): void {
    const entry = this.entries.get(creatorId);
    if (!entry) return;
    if (entry.message) clearTimeout(entry.message.timer);
    clearTimeout(entry.settleTimer);
    this.entries.delete(creatorId);
  }

  /** Resolves once every queued post and delete has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** The `/diagnostics` block. */
  snapshot(): Record<string, number> {
    let messages = 0;
    for (const entry of this.entries.values()) if (entry.message) messages += 1;
    return { ...this.counters, creatorChannels: this.entries.size, messages };
  }

  private coolingLimit(creatorId: string): ChannelLimit | undefined {
    const entry = this.entries.get(creatorId);
    if (!entry || this.now() >= entry.coolUntil) return undefined;
    return entry.limit;
  }

  private async tell(
    creatorId: string,
    memberId: string,
    waitingIds: readonly string[],
    joined: boolean,
  ): Promise<void> {
    const entry = this.entries.get(creatorId);
    const chat = this.deps.chat;
    if (!entry || !chat) return;
    const now = this.now();
    trimTold(entry, now);
    const waiting = [memberId, ...waitingIds.filter((id) => id !== memberId)].slice(
      0,
      MAX_LIMIT_MENTIONS,
    );
    // Everyone waiting is already mentioned: a member rejoining, or a sweep finding the same
    // people. Nothing to say.
    if (entry.message && waiting.every((id) => entry.message!.mentionedIds.has(id))) {
      for (const id of waiting) entry.told.set(id, now);
      return;
    }
    if (!joined && waiting.every((id) => now - (entry.told.get(id) ?? -Infinity) < LIMIT_TOLD_MS)) {
      return;
    }
    if (now < entry.quietUntil) return;
    try {
      if (await this.deps.noticesDisabled?.()) return;
    } catch {
      // Fail open, as the problem notifier does: a database blip must not silence it.
    }
    // Marked before the request, so nobody is asked about twice for one failure.
    for (const id of waiting) entry.told.set(id, now);
    try {
      const id = await chat.send(
        creatorId,
        channelLimitMemberMessage(waiting, entry.limit),
        waiting,
      );
      this.counters.posted += 1;
      // The room may have been made while this was in flight. Then this message is stale too.
      if (this.entries.get(creatorId) !== entry || entry.madeSince) {
        await this.deleteMessage(creatorId, id);
        return;
      }
      const previous = entry.message;
      const message: PostedMessage = { id, mentionedIds: new Set(waiting) };
      entry.message = message;
      message.timer = setTimeout(() => {
        if (entry.message !== message) return;
        this.dropMessage(creatorId, entry);
      }, LIMIT_MESSAGE_TTL_MS);
      message.timer.unref?.();
      if (previous) {
        clearTimeout(previous.timer);
        await this.deleteMessage(creatorId, previous.id);
      }
    } catch (err) {
      this.counters.failed += 1;
      // Missing Send Messages or View Channel, most likely, which nothing here can fix. Not
      // tried again for a while, so it costs one failed request per creator channel per window.
      entry.quietUntil = now + LIMIT_MESSAGE_TTL_MS;
      this.deps.logger.warn(
        { guildId: entry.guildId, primaryId: creatorId, memberId, code: errorCode(err) },
        'could not tell a member their room could not be made',
      );
    }
  }

  /** Takes the entry's message down, queued like a post. */
  private dropMessage(creatorId: string, entry: Entry): void {
    const message = entry.message;
    if (!message) return;
    clearTimeout(message.timer);
    delete entry.message;
    this.enqueue(creatorId, () => this.deleteMessage(creatorId, message.id));
  }

  /** The incident is over: forget the creator channel and tell the owner. */
  private settle(creatorId: string, entry: Entry): void {
    clearTimeout(entry.settleTimer);
    this.dropMessage(creatorId, entry);
    this.entries.delete(creatorId);
    this.counters.settled += 1;
    try {
      this.onSettled?.(entry.guildId, creatorId);
    } catch {
      // Settling must not fail because the owner's hook did.
    }
  }

  /** Runs `work` after this creator channel's earlier chat work, never rejecting. */
  private enqueue(creatorId: string, work: () => Promise<void>): void {
    const previous = this.chains.get(creatorId) ?? Promise.resolve();
    const next = previous.then(work).catch((err: unknown) => {
      this.deps.logger.debug({ primaryId: creatorId, err }, 'channel limit chat work failed');
    });
    this.chains.set(creatorId, next);
    void next.finally(() => {
      if (this.chains.get(creatorId) === next) this.chains.delete(creatorId);
    });
  }

  private async deleteMessage(creatorId: string, messageId: string): Promise<void> {
    try {
      await this.deps.chat?.remove(creatorId, messageId);
      this.counters.deleted += 1;
    } catch (err) {
      // Already deleted by somebody, or the bot can no longer manage the chat. Nothing to do.
      this.deps.logger.debug(
        { primaryId: creatorId, code: errorCode(err) },
        'could not delete a channel limit message',
      );
    }
  }

  /**
   * Ends incidents nobody has been refused or told about for {@link LIMIT_TOLD_MS}, so the map
   * is bounded by live incidents. One still being refused, by the sweep if nobody else, is kept,
   * and so is said to `/logging` once.
   */
  private prune(now: number): void {
    for (const [creatorId, entry] of this.entries) {
      if (entry.message) continue;
      const last = Math.max(entry.refusedAt, ...entry.told.values());
      if (now - last >= LIMIT_TOLD_MS) this.settle(creatorId, entry);
    }
  }
}

/** Forgets members told longer ago than {@link LIMIT_TOLD_MS}, so the map stays small. */
function trimTold(entry: Entry, now: number): void {
  for (const [id, at] of entry.told) if (now - at >= LIMIT_TOLD_MS) entry.told.delete(id);
}

/** The Discord error code, for a log line that carries ids only and never a message body. */
function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}
