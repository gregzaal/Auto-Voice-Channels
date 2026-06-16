import { type Client } from 'discord.js';
import type { GuildSettingsReader, Logger } from '@avc/core';
import { readLogging } from '../features/voice/guildSettings.js';

export interface ServerLoggerDeps {
  client: Client;
  guilds: GuildSettingsReader;
  logger: Logger;
}

const USER_MENTION_RE = /<@(\d+)>/g;
const PERM_TTL_MS = 5 * 60 * 1000; // 5 minutes

type PermEntry = { canRead: boolean; fetchedAt: number };

/**
 * Per-guild event logging (the `/logging` feature). Posts channel lifecycle
 * events to the guild's configured log channel when the event's level is within
 * the configured verbosity. Fire-and-forget — a logging failure never affects
 * the operation being logged.
 *
 * Settings (on `guilds.settings`): `logging` = channel id or `false`;
 * `log_level` = 1 (channels created/deleted) | 2 (+ renames & ownership changes) |
 * 3 (+ members joining/leaving), default 1.
 *
 * To avoid pinging members mentioned in log entries, messages containing
 * `<@userId>` are sent with bare IDs first, then immediately edited to restore
 * the full mention (Discord edits never trigger notifications). This only
 * applies when the mentioned user can actually read the log channel; otherwise
 * the message is sent with mentions suppressed outright.
 */
export class ServerLogger {
  private readonly permCache = new Map<string, PermEntry>();

  constructor(private readonly deps: ServerLoggerDeps) {}

  log(guildId: string, level: 1 | 2 | 3, message: string): void {
    void this.emit(guildId, level, message).catch((err: unknown) => {
      this.deps.logger.debug({ err, guildId }, 'server log emit failed');
    });
  }

  /** Returns true if `userId` has ViewChannel on `channelId`, with a 5-min TTL cache. */
  private async canUserReadChannel(
    guildId: string,
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    const key = `${guildId}:${userId}:${channelId}`;
    const hit = this.permCache.get(key);
    if (hit && Date.now() - hit.fetchedAt < PERM_TTL_MS) return hit.canRead;

    const guild = this.deps.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!guild || !channel) return false;

    const member = await guild.members.fetch(userId).catch(() => null);
    const canRead = member ? (channel.permissionsFor(member)?.has('ViewChannel') ?? false) : false;
    this.permCache.set(key, { canRead, fetchedAt: Date.now() });
    return canRead;
  }

  private async emit(guildId: string, level: number, message: string): Promise<void> {
    const guild = await this.deps.guilds.ensure(guildId);
    const { channelId, level: configured } = readLogging(guild.settings);
    if (channelId === null || level > configured) return;

    const channel = await this.deps.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return;

    const content = message.slice(0, 2000);
    const mentionedIds = [...message.matchAll(USER_MENTION_RE)].map((m) => m[1]!);

    // Only use send-then-edit when at least one mentioned user can see the log
    // channel — no point suppressing pings for users who'd never see the message.
    let anyCanRead = false;
    if (mentionedIds.length > 0) {
      const checks = await Promise.all(
        mentionedIds.map((id) => this.canUserReadChannel(guildId, id, channelId)),
      );
      anyCanRead = checks.some(Boolean);
    }

    if (!anyCanRead) {
      // Suppress all user mention pings — either no mentions, or no mentioned
      // user can read this channel, so notifications would be spurious.
      await channel.send({ content, allowedMentions: { parse: [] } });
      return;
    }

    // Send with bare IDs (no ping), then edit to the real mentions. Discord
    // never sends notifications for message edits.
    const noPing = content.replace(USER_MENTION_RE, '$1');
    const sent = await channel.send({ content: noPing, allowedMentions: { parse: [] } });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await sent.edit({ content });
  }
}
