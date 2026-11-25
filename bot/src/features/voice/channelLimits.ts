import type { Logger } from '@avc/core';
import type { ChannelLimit } from './discordAdapter.js';

const MINUTE = 60 * 1000;

/**
 * How long a creator channel whose create Discord refused for a full category or server is
 * skipped without asking again.
 *
 * Without it every member who joins, and every sweep catching up on the members still waiting,
 * costs one refused create (two, before the adapter stopped retrying it), and a busy server
 * waiting on a full category joins faster than an admin can make space. Short, because the
 * space can come back at any moment, and ended early by any channel deletion in the server
 * ({@link ChannelLimitTracker.releaseGuild}).
 */
export const CHANNEL_LIMIT_COOLDOWN_MS = 2 * MINUTE;

/**
 * How long the member's message stays in the creator channel's chat, counted from its last post
 * or edit. It is deleted at once when a room is next made from that creator channel, and this
 * is the bound for when nothing ever is.
 */
export const LIMIT_MESSAGE_TTL_MS = 10 * MINUTE;

/**
 * How long a member stays told, so the sweep that catches up on the members still waiting does
 * not mention them again every five minutes. A fresh join always tells the member who joined.
 */
export const LIMIT_TOLD_MS = 60 * MINUTE;

/** What the tracker needs from Discord, as three functions so they fake in a line each. */
export interface LimitChat {
  /** Posts into a channel's chat, mentioning only `mentionId`. Resolves to the message id. */
  send(channelId: string, content: string, mentionId: string): Promise<string>;
  /** Edits a posted message, mentioning only `mentionId`. Rejects when the message is gone. */
  edit(channelId: string, messageId: string, content: string, mentionId: string): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
}

export interface ChannelLimitTrackerDeps {
  /** Absent: nothing is posted, and the cooldown still applies. */
  chat?: LimitChat;
  /**
   * Whether notices the bot sends on its own are switched off (`problems.notify_disabled`).
   * Asked before every post or edit. Absent means not disabled.
   */
  noticesDisabled?: () => Promise<boolean>;
  logger: Logger;
  now?: () => number;
}

interface PostedMessage {
  id: string;
  mentionedId: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface Entry {
  guildId: string;
  limit: ChannelLimit;
  /** Until when a create from this creator channel is skipped without a request. */
  coolUntil: number;
  /** When Discord last refused a room from it. */
  refusedAt: number;
  message?: PostedMessage;
  /** When each member was last told. See {@link LIMIT_TOLD_MS}. */
  told: Map<string, number>;
  /** Until when no post is tried again after one failed. */
  quietUntil: number;
}

/**
 * What the member waiting in a creator channel is told when Discord refuses their room. Mentions
 * them by id, so the send must allow that one user mention and nothing else.
 */
export function channelLimitMemberMessage(memberId: string, limit: ChannelLimit): string {
  return limit === 'category'
    ? `<@${memberId}> I couldn't make your room because this category is full. Discord allows ` +
        '50 channels in a category. Ask a moderator to make space.'
    : `<@${memberId}> I couldn't make your room because this server has reached Discord's ` +
        'limit of 500 channels. Ask a moderator to make space.';
}

/**
 * Creator channels Discord refused a room for because a category or the server is full, in
 * memory and per process: a guild lives on one instance, which is the only one that creates its
 * rooms.
 *
 * Holds two things per creator channel: the cooldown during which a create is skipped without a
 * request, and the one message at a time that tells the waiting member why they have no room.
 * Only the guild's own queue calls in, apart from the message's expiry timer, which only deletes.
 *
 * **A restart forgets the message it posted**, so a message posted just before one stays in the
 * chat until somebody deletes it. Remembering it would need a table, and it is one message in a
 * channel whose chat the server's mods read.
 *
 * Never throws: every call site is on the create path, where a failure to tell somebody must not
 * become a failed task that counts against the guild's circuit breaker.
 */
export class ChannelLimitTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  /** Counters for `GET /diagnostics`. Monotonic for the life of the process. */
  private readonly counters = {
    refused: 0,
    skipped: 0,
    posted: 0,
    edited: 0,
    deleted: 0,
    failed: 0,
  };

  constructor(private readonly deps: ChannelLimitTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Records that Discord refused a room from this creator channel, and starts its cooldown.
   * Returns whether this is news: the first refusal since the last room made from it, or of
   * a different limit, which is when the guild's `/logging` channel is told.
   */
  refused(guildId: string, creatorId: string, limit: ChannelLimit): boolean {
    this.counters.refused += 1;
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(creatorId);
    const news = !entry || entry.limit !== limit;
    if (entry) {
      entry.limit = limit;
      entry.coolUntil = now + CHANNEL_LIMIT_COOLDOWN_MS;
      entry.refusedAt = now;
    } else {
      this.entries.set(creatorId, {
        guildId,
        limit,
        coolUntil: now + CHANNEL_LIMIT_COOLDOWN_MS,
        refusedAt: now,
        told: new Map(),
        quietUntil: 0,
      });
    }
    return news;
  }

  /** The limit this creator channel is cooling down on, or undefined when a create may go ahead. */
  coolingDown(creatorId: string): ChannelLimit | undefined {
    const entry = this.entries.get(creatorId);
    if (!entry || this.now() >= entry.coolUntil) return undefined;
    this.counters.skipped += 1;
    return entry.limit;
  }

  /**
   * Tells the member waiting in the creator channel why they have no room, in that channel's own
   * chat. One message per creator channel at a time: a second member is mentioned by editing it.
   *
   * `joined` is a fresh join, which always tells the member who joined. The sweep passes false,
   * and tells only a member nobody has told in the last {@link LIMIT_TOLD_MS}.
   */
  async tellMember(creatorId: string, memberId: string, joined: boolean): Promise<void> {
    const entry = this.entries.get(creatorId);
    const chat = this.deps.chat;
    if (!entry || !chat) return;
    const now = this.now();
    const toldAt = entry.told.get(memberId);
    if (!joined && toldAt !== undefined && now - toldAt < LIMIT_TOLD_MS) return;
    if (entry.message?.mentionedId === memberId) {
      // Already the one mentioned. Kept for its full time again rather than edited for nothing.
      entry.told.set(memberId, now);
      this.expireLater(creatorId, entry, entry.message);
      return;
    }
    if (now < entry.quietUntil) return;
    try {
      if (await this.deps.noticesDisabled?.()) return;
    } catch {
      // Fail open, as the problem notifier does: a database blip must not silence it.
    }
    // Marked before the request, so a member is never asked about twice for one failure.
    entry.told.set(memberId, now);
    const content = channelLimitMemberMessage(memberId, entry.limit);
    const posted = entry.message;
    if (posted) {
      try {
        await chat.edit(creatorId, posted.id, content, memberId);
        this.counters.edited += 1;
        // Only if it is still the message this edited: the expiry timer may have taken it.
        if (entry.message === posted) {
          posted.mentionedId = memberId;
          this.expireLater(creatorId, entry, posted);
        }
        return;
      } catch {
        // Somebody deleted it. Posted again below.
        if (entry.message === posted) {
          clearTimeout(posted.timer);
          delete entry.message;
        }
      }
    }
    try {
      const id = await chat.send(creatorId, content, memberId);
      this.counters.posted += 1;
      const message: PostedMessage = { id, mentionedId: memberId };
      if (entry.message) {
        // A second post landed while this one was in flight, which the guild's queue rules out.
        // Keep the newer and delete the older rather than leave two.
        clearTimeout(entry.message.timer);
        void this.deleteMessage(creatorId, entry.message.id);
      }
      entry.message = message;
      this.expireLater(creatorId, entry, message);
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

  /**
   * A room was made from this creator channel, so the limit is over: forget it and delete the
   * member's message.
   */
  async resolved(creatorId: string): Promise<void> {
    const entry = this.entries.get(creatorId);
    if (!entry) return;
    this.entries.delete(creatorId);
    if (!entry.message) return;
    clearTimeout(entry.message.timer);
    await this.deleteMessage(creatorId, entry.message.id);
  }

  /**
   * A channel was deleted in this server, which may have made the space: end the cooldown of
   * every creator channel there, so the next join asks Discord again. The messages stay until a
   * room is made or they expire.
   */
  releaseGuild(guildId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.guildId === guildId) entry.coolUntil = 0;
    }
  }

  /** The creator channel itself is gone, and its chat and message with it. */
  forget(creatorId: string): void {
    const entry = this.entries.get(creatorId);
    if (entry?.message) clearTimeout(entry.message.timer);
    this.entries.delete(creatorId);
  }

  /** The `/diagnostics` block. */
  snapshot(): Record<string, number> {
    let messages = 0;
    for (const entry of this.entries.values()) if (entry.message) messages += 1;
    return { ...this.counters, creatorChannels: this.entries.size, messages };
  }

  /** (Re)starts the message's expiry. */
  private expireLater(creatorId: string, entry: Entry, message: PostedMessage): void {
    clearTimeout(message.timer);
    message.timer = setTimeout(() => {
      if (entry.message !== message) return;
      delete entry.message;
      void this.deleteMessage(creatorId, message.id);
    }, LIMIT_MESSAGE_TTL_MS);
    message.timer.unref?.();
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
   * Forgets creator channels nobody has been refused or told about for {@link LIMIT_TOLD_MS}, so
   * the map is bounded by live incidents. One still being refused, by the sweep if nobody else,
   * is kept, and so is said to `/logging` once.
   */
  private prune(now: number): void {
    for (const [creatorId, entry] of this.entries) {
      if (entry.message) continue;
      const last = Math.max(entry.refusedAt, ...entry.told.values());
      if (now - last >= LIMIT_TOLD_MS) this.entries.delete(creatorId);
    }
  }
}

/** The Discord error code, for a log line that carries ids only and never a message body. */
function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}
