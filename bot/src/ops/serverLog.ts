import { type Client } from 'discord.js';
import type { GuildRepository, Logger } from '@avc/core';

export interface ServerLoggerDeps {
  client: Client;
  guilds: GuildRepository;
  logger: Logger;
}

/**
 * Per-guild event logging (the `/logging` feature). Posts channel lifecycle
 * events to the guild's configured log channel when the event's level is within
 * the configured verbosity. Fire-and-forget — a logging failure never affects
 * the operation being logged.
 *
 * Settings (on `guilds.settings`): `logging` = channel id or `false`;
 * `log_level` = 1 (channels created/deleted) | 2 (+ renames & ownership changes) |
 * 3 (+ members joining/leaving), default 1.
 */
export class ServerLogger {
  constructor(private readonly deps: ServerLoggerDeps) {}

  log(guildId: string, level: 1 | 2 | 3, message: string): void {
    void this.emit(guildId, level, message).catch((err: unknown) => {
      this.deps.logger.debug({ err, guildId }, 'server log emit failed');
    });
  }

  private async emit(guildId: string, level: number, message: string): Promise<void> {
    const guild = await this.deps.guilds.get(guildId);
    if (!guild) return;
    const channelId = guild.settings.logging;
    const configured = typeof guild.settings.log_level === 'number' ? guild.settings.log_level : 1;
    if (typeof channelId !== 'string' || !channelId || level > configured) return;

    const channel = await this.deps.client.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isTextBased() && 'send' in channel) {
      await channel.send({ content: message.slice(0, 2000) });
    }
  }
}
