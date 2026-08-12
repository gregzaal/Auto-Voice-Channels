import type { AutoChannelRepository, GuildSettingsReader, Logger } from '@avc/core';
import type { Client } from 'discord.js';
import { gatedCreatorChannelNotice } from './messages.js';

export interface ExpiredJoinNotifierOptions {
  autoChannels: AutoChannelRepository;
  /** Row source (SettingsCache) — to stay silent for `blocked` guilds. */
  guilds: GuildSettingsReader;
  client: Client;
  logger: Logger;
  /** Min time between notices per guild. Default 6h. */
  throttleMs?: number;
  now?: () => number;
}

/**
 * The one carve-out from the hard-gate short-circuit (§4): when someone joins
 * a *creator channel* in a non-entitled guild, post a friendly "AVC is paused
 * here — reactivate at auto-voice.io" notice into that channel's text chat.
 * Heavily throttled per guild so a gated guild costs ~nothing and nobody gets
 * spammed; everything is fire-and-forget and failure-contained.
 *
 * The throttle slot is only claimed once the join is KNOWN to be a creator
 * channel (and the guild isn't `blocked` — that's the abuse kill-switch, not
 * a billing state): ordinary VC joins must never consume the slot, or the
 * notice would effectively never fire in an active gated guild. A per-guild
 * in-flight set keeps join bursts from stampeding the checks.
 */
export class ExpiredJoinNotifier {
  private readonly lastNotice = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: ExpiredJoinNotifierOptions) {
    this.throttleMs = opts.throttleMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Sync hook for the gateway; all the work happens off the event path. */
  handleGatedJoin(guildId: string, channelId: string): void {
    const now = this.now();
    const last = this.lastNotice.get(guildId) ?? 0;
    if (now - last < this.throttleMs) return;
    if (this.inFlight.has(guildId)) return;
    this.inFlight.add(guildId);
    void this.post(guildId, channelId)
      .catch((err: unknown) => {
        this.opts.logger.debug({ err, guildId, channelId }, 'gated-join notice failed');
      })
      .finally(() => this.inFlight.delete(guildId));
  }

  private async post(guildId: string, channelId: string): Promise<void> {
    // Only creator channels get the notice — a random VC join stays silent.
    if (!(await this.opts.autoChannels.isPrimary(guildId, channelId))) return;
    // `blocked` guilds get nothing: the notice's billing copy would be false.
    const row = await this.opts.guilds.ensure(guildId);
    if (row.authStatus === 'blocked') return;
    // Claim the slot only now that we know a notice will actually be sent.
    this.lastNotice.set(guildId, this.now());
    const channel = await this.opts.client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && 'send' in channel) {
      await channel.send(gatedCreatorChannelNotice(guildId)).catch(() => undefined);
    }
  }
}
