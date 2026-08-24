import type { LeniencyNotification, Logger } from '@avc/core';
import type { Client } from 'discord.js';
import { notificationMessage, onboardingMessage, SITE_URL } from './messages.js';
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
  /**
   * DMs a pool's purchaser directly, for a billing event that concerns the
   * pool as a whole rather than any one server (`plans/member-based-pricing.md`
   * §6.6). Unlike {@link notifyGuild} there is no system-channel fallback
   * step: a pool has no one server whose channels would make sense here.
   */
  notifyPurchaser(
    discordUserId: string,
    notification: LeniencyNotification,
    memberCount: number,
  ): Promise<boolean>;
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

  async notifyPurchaser(
    discordUserId: string,
    notification: LeniencyNotification,
    memberCount: number,
  ): Promise<boolean> {
    // No single guild to deep-link to; the plain dashboard shows the pool panel.
    const content = notificationMessage(notification, memberCount, '', `${SITE_URL}/dashboard`);
    try {
      // No guild to name it against, unlike `deliver`'s owner-DM fallback:
      // this message is about the purchaser's pool, not one server.
      const user = await this.opts.client.users.fetch(discordUserId, { cache: false });
      await user.send({ content });
      return true;
    } catch (err) {
      this.opts.logger.debug({ err, discordUserId }, 'pool purchaser notification delivery failed');
      return false;
    }
  }

  private async deliver(guildId: string, content: string): Promise<boolean> {
    try {
      // REST fetch works for any guild the bot is in, even off this instance's
      // shards — the reconcile job notifies fleet-wide from one instance.
      // `cache: false`, deliberately: without it, a fetched foreign guild is
      // inserted into `client.guilds.cache` permanently (discord.js's
      // `GuildManager.fetch` default), which corrupts the "my cache only
      // covers my own shards" invariant every other partial-cache fix here
      // depends on (`plans/scaling.md` §9.1). Once that guild is cached, its
      // channels read as real to `channelExists` too, turning finding 1's
      // otherwise-harmless no-op into an actual cross-shard channel delete.
      const guild = await this.opts.client.guilds.fetch({ guild: guildId, cache: false });
      if (guild.systemChannelId) {
        // Same reasoning, same option: `GuildChannelManager.fetch` caches by
        // default too (into the client-level `channels.cache`, independent
        // of the guild-level cache this call already avoided) - low blast
        // radius on its own since a text channel's id never collides with a
        // tracked voice channel's, but it is an unbounded, never-swept leak,
        // and the whole point of the line above was leaving no cache trail.
        const channel = await guild.channels
          .fetch(guild.systemChannelId, { cache: false })
          .catch(() => null);
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
