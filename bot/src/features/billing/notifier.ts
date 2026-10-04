import type { GuildSettingsReader, LeniencyNotification, Logger } from '@avc/core';
import type { Client, Guild } from 'discord.js';
import { readContact } from '../voice/guildSettings.js';
import {
  coveredWelcomeMessage,
  notificationMessage,
  onboardingMessage,
  publicNoticeMessage,
  SITE_URL,
  subscribeUrl,
  type NotificationAudience,
} from './messages.js';
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
    /**
     * Set when this is one copy of a fan-out into a server on a shared
     * subscription. Changes the copy, not the delivery: these readers were
     * never sent the warnings that came first, and cannot act on the
     * subscription themselves.
     */
    audience?: NotificationAudience,
  ): Promise<boolean>;
  welcomeGuild(guildId: string, policy: TrialPolicy, memberCount: number): Promise<boolean>;
  /**
   * The welcome for a server a subscription already covers, which must not
   * announce a trial or quote a second price.
   */
  welcomeCoveredGuild(guildId: string): Promise<boolean>;
  /**
   * DMs a pool's purchaser directly, for a billing event that concerns the
   * pool as a whole rather than any one server. Unlike {@link notifyGuild}
   * there is no system-channel fallback
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
  /**
   * The guild's recorded settings, for `contact_user_id`.
   *
   * Optional so a construction without it degrades to the owner-only ladder
   * rather than failing. Production always passes it; the tests are what
   * exercise its absence.
   */
  guilds?: GuildSettingsReader;
  /**
   * This fleet's creator channels for a guild, for the last rung. Fleet-scoped
   * by the repository, which matters: a row belongs to the bot that registered
   * it, and posting into another fleet's creator channel is that fleet's job.
   */
  creatorChannels?: { listByGuild(guildId: string): Promise<{ channelId: string }[]> };
}

/** How many creator channels are worth trying before giving up on a guild. */
const MAX_CREATOR_ATTEMPTS = 3;

/**
 * Discord delivery, on the same ladder the other two senders use: the guild's
 * system channel, then a DM to whoever set the bot up, then the owner, then
 * the built-in text chat of a creator channel — and that last one carries a
 * public-safe form of the notice, never the notice itself.
 *
 * The ladder used to stop after the owner DM, which made billing notices —
 * the messages that decide whether somebody keeps the service — the weakest
 * delivered thing in the bot, weaker than a permissions warning. All failures
 * are contained: billing messaging must never become a failure mode for the
 * bot.
 */
export class DiscordBillingNotifier implements BillingNotifier {
  constructor(private readonly opts: DiscordBillingNotifierOptions) {}

  async notifyGuild(
    guildId: string,
    notification: LeniencyNotification,
    memberCount: number,
    audience: NotificationAudience = 'guild',
  ): Promise<boolean> {
    return this.deliver(
      guildId,
      notificationMessage(notification, memberCount, guildId, subscribeUrl(guildId), audience),
      publicNoticeMessage(guildId),
    );
  }

  async welcomeGuild(guildId: string, policy: TrialPolicy, memberCount: number): Promise<boolean> {
    // A welcome is written to be read by the server it lands in, so it is its
    // own public form. It barely reaches that rung anyway: a guild has no
    // creator channels at the moment it adds the bot.
    const content = onboardingMessage(policy, memberCount, guildId);
    return this.deliver(guildId, content, content);
  }

  async welcomeCoveredGuild(guildId: string): Promise<boolean> {
    const content = coveredWelcomeMessage(guildId);
    return this.deliver(guildId, content, content);
  }

  async notifyPurchaser(
    discordUserId: string,
    notification: LeniencyNotification,
    memberCount: number,
  ): Promise<boolean> {
    // No single guild to deep-link to; the plain dashboard shows the pool panel.
    const content = notificationMessage(
      notification,
      memberCount,
      '',
      `${SITE_URL}/dashboard`,
      'purchaser',
    );
    try {
      // No guild to name it against, unlike `deliver`'s owner-DM fallback:
      // this message is about the purchaser's pool, not one server.
      const user = await this.opts.client.users.fetch(discordUserId, { cache: false });
      await user.send({ content });
      return true;
    } catch (err) {
      // Warn, for the same reason as `deliver` below: a purchaser who never
      // hears that their subscription lapsed is a customer lost silently.
      this.opts.logger.warn({ err, discordUserId }, 'pool purchaser notification delivery failed');
      return false;
    }
  }

  private async deliver(
    guildId: string,
    content: string,
    /**
     * What the public last rung may say. Omitted means this notice has no
     * public form, and the ladder stops at the private rungs rather than
     * inventing one.
     */
    publicContent?: string,
  ): Promise<boolean> {
    try {
      // REST fetch works for any guild the bot is in, even off this instance's
      // shards — the reconcile job notifies fleet-wide from one instance.
      // `cache: false`, deliberately: without it, a fetched foreign guild is
      // inserted into `client.guilds.cache` permanently (discord.js's
      // `GuildManager.fetch` default), which corrupts the "my cache only
      // covers my own shards" invariant every other partial-cache fix here
      // depends on. Once that guild is cached, its channels read as real to
      // `channelExists` too, allowing cross-shard channel deletion.
      const guild = await this.opts.client.guilds.fetch({ guild: guildId, cache: false });

      if (guild.systemChannelId) {
        if (await this.post(guild, guild.systemChannelId, content)) return true;
        // Falling through is fine, but it must never be SILENT: the usual
        // cause is the bot lacking Send Messages in the system channel, which
        // is a one-click fix an admin will never make if nobody reports it.
        // Swallowing this made every notification look like it was
        // DM-by-design.
        this.opts.logger.warn(
          { guildId, channelId: guild.systemChannelId },
          'cannot post billing notification in the system channel, trying a DM instead',
        );
      }

      /**
       * Both private recipients, in order: whoever set this bot up, then the
       * guild's owner.
       *
       * The contact goes first because the owner is a guess by construction —
       * a great many guilds were inherited at cutover and their owner may not
       * remember installing anything — while a recorded contact ran `/setup`
       * themselves. Plenty of guilds name someone who is not the owner, and
       * until now every one of those billing DMs went to the owner instead.
       *
       * The owner is still TRIED, and an earlier draft of this dropped them:
       * preferring the contact by REPLACING the owner meant a guild whose
       * contact has DMs closed lost a private route that worked and went
       * straight to a public channel. On a message that can carry payment
       * status, exhausting every private rung first is the point of having
       * them.
       */
      const recipients = await this.resolveRecipients(guild);
      if (recipients === 'unknown') {
        /**
         * The settings read itself failed, so a guild with no contact and one
         * whose contact could not be looked up are indistinguishable. Falling
         * back anyway would stamp the dedupe key on a delivery to the wrong
         * person, permanently. Leaving the row queued costs an hour and gets
         * it right, and a database that cannot answer is not a state to make
         * billing decisions in.
         */
        this.opts.logger.warn({ guildId }, 'cannot resolve who to tell; leaving the notice queued');
        return false;
      }
      for (const recipient of recipients) {
        try {
          const user = await this.opts.client.users.fetch(recipient, { cache: false });
          // A DM has no surrounding server, so the message's "this server"
          // wording would have no antecedent. Name the guild up front instead.
          await user.send({
            content: `**${guild.name}**\n\n${content}`,
            allowedMentions: { parse: [] },
          });
          return true;
        } catch (err) {
          this.opts.logger.warn({ err, guildId, recipient }, 'cannot DM the billing notice');
        }
      }

      /**
       * Last resort: the built-in text chat of a creator channel.
       *
       * Publicly visible, so it runs only once both private routes are gone,
       * and it carries no mention — pinging a whole server on the strength of
       * a guessed recipient is how a bot reads as misbehaving. Several are
       * tried, because one may sit in a category that denies Send Messages
       * while another does not.
       *
       * **An arbitrary text channel is never tried, at any point.** Picking
       * the first channel we can write to is what spam bots do, and servers
       * defend with honeypot channels that auto-ban anything posting in them.
       * A creator channel is different: an admin configured it for this bot
       * specifically, and this fleet holds a row for it.
       *
       * It carries `publicContent`, never the notice itself. Several of these
       * kinds tell an admin in private that their payment failed or how many
       * unpaid days are left, and broadcasting that to a server is a worse
       * outcome than not delivering at all.
       */
      let listed = 0;
      let tried = 0;
      if (publicContent) {
        const creators = await this.opts.creatorChannels
          ?.listByGuild(guildId)
          .catch((err: unknown) => {
            // Logged, because silently reading this as "no creator channels"
            // is how a database blip would have been reported to the operator
            // as a guild refusing to take its messages.
            this.opts.logger.warn({ err, guildId }, 'could not list creator channels');
            return null;
          });
        listed = creators?.length ?? 0;
        for (const creator of (creators ?? []).slice(0, MAX_CREATOR_ATTEMPTS)) {
          tried += 1;
          if (await this.post(guild, creator.channelId, publicContent)) return true;
        }
      }

      // Counted rather than asserted: "creator channels refused" about a guild
      // that has none, or whose listing failed, is the kind of false
      // diagnostic this ladder's logging exists to stop producing.
      this.opts.logger.warn(
        {
          guildId,
          hasPublicForm: Boolean(publicContent),
          creatorsListed: listed,
          creatorsTried: tried,
        },
        'billing notice undeliverable: no rung of the ladder accepted it',
      );
      return false;
    } catch (err) {
      /**
       * Warn, not debug. Every rung of this ladder failing is a customer who
       * will never hear that their trial is ending, and at `debug` the reason
       * was absent from production logs entirely: two servers spent three
       * notices and 70+ attempts each being unreachable for a reason nobody
       * could name. Billing notices are rare enough that a per-attempt line
       * costs nothing.
       */
      this.opts.logger.warn({ err, guildId }, 'billing notification delivery failed');
      return false;
    }
  }

  /**
   * Posts one message into a guild channel, or reports that it could not.
   *
   * `cache: false` for the same reason the guild fetch above uses it: this
   * runs fleet-wide from one instance, and a cached foreign channel is an
   * unbounded leak that also makes another shard's channel read as real to
   * `channelExists`.
   *
   * Never carries a mention. The system-channel rung never has, and the
   * creator-channel rung must not: it is public, and the person it would ping
   * is a guess.
   */
  private async post(guild: Guild, channelId: string, content: string): Promise<boolean> {
    const channel = await guild.channels.fetch(channelId, { cache: false }).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return false;
    try {
      await channel.send({ content, allowedMentions: { parse: [] } });
      return true;
    } catch (err) {
      this.opts.logger.debug({ err, guildId: guild.id, channelId }, 'billing post refused');
      return false;
    }
  }

  /**
   * Who to DM, best first: the recorded contact while they are still a member,
   * then the guild's owner.
   *
   * The membership check is what makes the contact worth preferring rather
   * than a second way to fail — a fifth of the contacts inherited at cutover
   * have already left the server they were recorded for. A failed membership
   * check demotes them, because that one is a fact about Discord; a failed
   * SETTINGS read returns `'unknown'` instead, because that one is a fact
   * about our own database and the caller must not turn it into a delivery.
   */
  private async resolveRecipients(guild: Guild): Promise<string[] | 'unknown'> {
    const owner = guild.ownerId || null;
    const fallback = owner ? [owner] : [];
    if (!this.opts.guilds) return fallback;

    let contact: string | null;
    try {
      contact = readContact((await this.opts.guilds.ensure(guild.id)).settings);
    } catch {
      return 'unknown';
    }
    if (!contact || contact === owner) return fallback;

    const member = await guild.members.fetch({ user: contact, cache: false }).catch(() => null);
    return member ? [contact, ...fallback] : fallback;
  }
}
