import { ChannelType, type Client } from 'discord.js';
import type { Logger } from '@avc/core';

/**
 * Reports significant operational errors to an admin Discord channel. This is a
 * thin seam (per rewrite.md): today it posts to `ADMIN_CHANNEL_ID`; a Sentry-style
 * sink can be slotted in behind the same interface later. A `null` channel id
 * (self-host default) makes it a no-op, and reporting failures never throw —
 * error reporting must not itself become a failure mode.
 */
export interface ErrorReporter {
  report(message: string, context?: Record<string, unknown>): void;
}

/** No-op reporter, used when no admin channel is configured. */
export class NullErrorReporter implements ErrorReporter {
  report(): void {
    /* intentionally empty */
  }
}

export interface AdminChannelReporterOptions {
  client: Client;
  channelId: string;
  logger: Logger;
  /** Per-message throttle to avoid flooding the channel on error storms (ms). */
  throttleMs?: number;
}

export class AdminChannelReporter implements ErrorReporter {
  private readonly throttleMs: number;
  private lastSentAt = 0;
  private suppressed = 0;

  constructor(private readonly opts: AdminChannelReporterOptions) {
    this.throttleMs = opts.throttleMs ?? 5_000;
  }

  report(message: string, context: Record<string, unknown> = {}): void {
    const now = Date.now();
    if (now - this.lastSentAt < this.throttleMs) {
      this.suppressed += 1;
      return;
    }
    const suppressedNote = this.suppressed > 0 ? `\n_(+${this.suppressed} suppressed)_` : '';
    this.lastSentAt = now;
    this.suppressed = 0;

    const detail = Object.keys(context).length ? `\n\`\`\`json\n${safeJson(context)}\n\`\`\`` : '';
    void this.send(`⚠️ **${message}**${detail}${suppressedNote}`);
  }

  private async send(content: string): Promise<void> {
    try {
      const channel = await this.opts.client.channels.fetch(this.opts.channelId);
      if (
        channel &&
        (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      ) {
        await channel.send({ content: content.slice(0, 1900) });
      }
    } catch (err) {
      this.opts.logger.warn({ err }, 'failed to report error to admin channel');
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 1500);
  } catch {
    return String(value);
  }
}
