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
    return this.deliver(guildId, notificationMessage(notification, memberCount, guildId));
  }

  async welcomeGuild(guildId: string, policy: TrialPolicy, memberCount: number): Promise<boolean> {
    return this.deliver(guildId, onboardingMessage(policy, memberCount, guildId));
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
          } catch (err) {
            // Falling back to the owner DM is fine, but it must never be
            // SILENT: the usual cause is the bot lacking Send Messages in the
            // system channel, which is a one-click fix an admin will never make
            // if nobody reports it. Swallowing this made every notification
            // look like it was DM-by-design.
            this.opts.logger.warn(
              { err, guildId, channelId: guild.systemChannelId },
              'cannot post billing notification in the system channel, DMing the owner instead',
            );
          }
        }
      }
      const owner = await guild.fetchOwner();
      // A DM has no surrounding server, so the message's "this server" wording
      // would have no antecedent. Name the guild up front instead.
      await owner.send({ content: `**${guild.name}**\n\n${content}` });
      return true;
    } catch (err) {
      this.opts.logger.debug({ err, guildId }, 'billing notification delivery failed');
      return false;
    }
  }
}
