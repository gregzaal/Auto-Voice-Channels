import type { LeniencyNotification, Logger } from '@avc/core';
import type { Client } from 'discord.js';
import { notificationMessage, onboardingMessage } from './messages.js';
import type { TrialPolicy } from '@avc/core';

/**
 * Delivery seam for monetization messaging, so the reconcile job and the
 * onboarding flow stay testable without Discord. `true` = delivered (the
 * caller records the dedupe key); `false` = nowhere to deliver / failed
 * (the caller leaves the key unrecorded so a later run retries).
 */
export interface BillingNotifier {
  notifyGuild(
    guildId: string,
    notification: LeniencyNotification,
    memberCount: number,
  ): Promise<boolean>;
  welcomeGuild(guildId: string, policy: TrialPolicy, memberCount: number): Promise<boolean>;
}

export interface DiscordBillingNotifierOptions {
  client: Client;
  logger: Logger;
}

/**
 * Discord delivery per monetization.md §6: post in the guild's system channel
 * where possible, else DM the owner. All failures are contained — billing
 * messaging must never become a failure mode for the bot.
 */
export class DiscordBillingNotifier implements BillingNotifier {
  constructor(private readonly opts: DiscordBillingNotifierOptions) {}

  async notifyGuild(
    guildId: string,
    notification: LeniencyNotification,
    memberCount: number,
  ): Promise<boolean> {
    return this.deliver(guildId, notificationMessage(notification, memberCount));
  }

  async welcomeGuild(guildId: string, policy: TrialPolicy, memberCount: number): Promise<boolean> {
    return this.deliver(guildId, onboardingMessage(policy, memberCount));
  }

  private async deliver(guildId: string, content: string): Promise<boolean> {
    try {
      // REST fetch works for any guild the bot is in, even off this instance's
      // shards — the reconcile job notifies fleet-wide from one instance.
      const guild = await this.opts.client.guilds.fetch(guildId);
      if (guild.systemChannelId) {
        const channel = await guild.channels.fetch(guild.systemChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          try {
            await channel.send({ content });
            return true;
          } catch {
            // fall through to the owner DM
          }
        }
      }
      const owner = await guild.fetchOwner();
      await owner.send({ content });
      return true;
    } catch (err) {
      this.opts.logger.debug({ err, guildId }, 'billing notification delivery failed');
      return false;
    }
  }
}
