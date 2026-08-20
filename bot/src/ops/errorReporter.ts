import { ChannelType, type Client } from 'discord.js';
import type { AlertAudience, AlertRepository, Logger } from '@avc/core';

/**
 * Reports significant operational errors to an admin Discord channel. This is a
 * thin seam (per rewrite.md): today it posts to `ADMIN_CHANNEL_ID`; a Sentry-style
 * sink can be slotted in behind the same interface later. A `null` channel id
 * (self-host default) makes it a no-op, and reporting failures never throw —
 * error reporting must not itself become a failure mode.
 */
export interface ErrorReporter {
  /**
   * `kind` is a short stable slug identifying the CONDITION, not the incident:
   * `db.ping`, `reconcile.failed`, `backup.failed`. It is the throttle key, so
   * an error storm of one kind can no longer hide an unrelated alert of
   * another, and it is the natural dedupe key for a persisted implementation.
   *
   * Deliberately still `void`. Callers are catch blocks on paths that have
   * already failed; none of them can do anything useful with a rejected
   * promise, and making them await it would put alerting on the critical path.
   */
  report(kind: string, message: string, context?: Record<string, unknown>): void;
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
  /** Per-kind throttle to avoid flooding the channel on error storms (ms). */
  throttleMs?: number;
}

/**
 * How long one condition stays quiet after it has been reported.
 *
 * Fifteen minutes, raised from five SECONDS, and the old value was not a
 * throttle in any useful sense. Every alert source here is a repeating check:
 * the db health ping runs every 15s, the metrics flush every 5 minutes, the
 * watcher every minute. A sustained outage under the old default would have
 * posted a message every fifteen seconds for as long as it lasted -- roughly
 * two thousand of them across the 2026-08-20 outage -- which is not alerting,
 * it is a denial of service against the person on call.
 *
 * A distinct condition is never delayed by this, because the window is per
 * kind. What it costs is a repeat: a problem that is still true is restated
 * every fifteen minutes, carrying the count of what it swallowed.
 */
const DEFAULT_THROTTLE_MS = 15 * 60_000;

export class AdminChannelReporter implements ErrorReporter {
  private readonly throttleMs: number;
  /**
   * Throttle state is PER KIND.
   *
   * It used to be a single global window, which meant a backup failure two
   * seconds after a gateway error was silently discarded: an error storm of one
   * kind suppressed every unrelated alert for as long as it lasted. That is the
   * opposite of what a throttle is for.
   */
  private readonly state = new Map<
    string,
    { lastSentAt: number; suppressed: number; inFlight: boolean }
  >();

  constructor(private readonly opts: AdminChannelReporterOptions) {
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  report(kind: string, message: string, context: Record<string, unknown> = {}): void {
    const now = Date.now();
    const entry = this.state.get(kind) ?? { lastSentAt: 0, suppressed: 0, inFlight: false };

    /**
     * Two gates, and both are needed.
     *
     * `inFlight` is the burst gate and it is set SYNCHRONOUSLY. Without it,
     * every report arriving during a send's Discord round trip (100-300ms)
     * reads the pre-send `lastSentAt`, passes the time gate, and fires its own
     * request. That is not a throttle, and a burst is exactly what a throttle
     * is for.
     *
     * `lastSentAt` is the rate gate.
     */
    if (entry.inFlight || now - entry.lastSentAt < this.throttleMs) {
      entry.suppressed += 1;
      this.state.set(kind, entry);
      return;
    }

    const carried = entry.suppressed;
    const suppressedNote = carried > 0 ? `\n_(+${carried} suppressed)_` : '';
    const detail = Object.keys(context).length ? `\n\`\`\`json\n${safeJson(context)}\n\`\`\`` : '';
    const content = `⚠️ **${message}**${detail}${suppressedNote}`;

    entry.inFlight = true;
    this.state.set(kind, entry);

    void this.send(content).then((sent) => {
      const current = this.state.get(kind) ?? entry;
      current.inFlight = false;
      /**
       * The rate gate arms either way.
       *
       * Arming only on success sounds right and is worse: a channel that never
       * accepts a message would never arm, so every subsequent report would
       * retry immediately and a storm into a misconfigured channel becomes an
       * equal-rate storm of failing REST calls plus a warn per report, during
       * an incident.
       */
      current.lastSentAt = Date.now();
      if (sent) {
        /**
         * Subtract what this message actually reported rather than zeroing.
         * Zeroing discarded every increment that landed while the send was in
         * flight, so those alerts were counted nowhere at all.
         */
        current.suppressed = Math.max(0, current.suppressed - carried);
      }
      this.state.set(kind, current);
    });
  }

  private async send(content: string): Promise<boolean> {
    try {
      const channel = await this.opts.client.channels.fetch(this.opts.channelId);
      if (!channel) {
        this.opts.logger.warn(
          { channelId: this.opts.channelId },
          'admin channel not found, operational alerts are going nowhere',
        );
        return false;
      }
      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement
      ) {
        /**
         * This used to fall through the `if` and return silently, so pointing
         * ADMIN_CHANNEL_ID at a thread, forum or voice text chat disabled
         * alerting completely with no indication anywhere.
         */
        this.opts.logger.warn(
          { channelId: this.opts.channelId, type: channel.type },
          'admin channel is not a text channel, operational alerts are going nowhere',
        );
        return false;
      }
      await channel.send({ content: content.slice(0, 1900) });
      return true;
    } catch (err) {
      this.opts.logger.warn({ err }, 'failed to report error to admin channel');
      return false;
    }
  }
}

/**
 * Writes every report to both of two reporters.
 *
 * The persisted reporter is the record and the channel reporter is the
 * notification, and neither is a substitute for the other: a row nobody sees
 * does not wake anyone, and a Discord message is not queryable next month.
 * Failures in either are contained by the reporters themselves.
 */
export class TeeErrorReporter implements ErrorReporter {
  constructor(private readonly reporters: readonly ErrorReporter[]) {}

  report(kind: string, message: string, context?: Record<string, unknown>): void {
    for (const r of this.reporters) {
      try {
        r.report(kind, message, context);
      } catch {
        /* a reporter that throws must not stop its siblings */
      }
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

export interface PersistentReporterOptions {
  alerts: AlertRepository;
  logger: Logger;
  /** Which population should see these. Hosted alerts by default. */
  audience?: AlertAudience;
}

/**
 * Writes every report to the `alerts` table.
 *
 * This is the half that makes an alert survivable: a Discord message is a
 * notification and this is the record. It also gives dedupe that outlives the
 * process, which the in-memory throttles never could -- a restart used to
 * re-arm every one of them.
 *
 * Still fire-and-forget at the interface, because `report` is void by contract
 * and every caller is a catch block on an already-failed path. A write failure
 * is logged and dropped rather than thrown: an alerter that can take down the
 * thing it watches is worse than no alerter.
 */
export class PersistentErrorReporter implements ErrorReporter {
  constructor(private readonly opts: PersistentReporterOptions) {}

  report(kind: string, message: string, context: Record<string, unknown> = {}): void {
    const target = typeof context.guildId === 'string' ? context.guildId : '';
    void this.opts.alerts
      .raise({
        key: kind,
        message,
        target,
        audience: this.opts.audience ?? 'hosted',
        details: context,
      })
      .catch((err: unknown) => {
        this.opts.logger.warn({ err, kind }, 'could not persist an operational alert');
      });
  }
}
