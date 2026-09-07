import {
  priceSentence,
  tierById,
  tierFor,
  trialPolicyFor,
  TRIAL_SHORT_DAYS,
  type LeniencyNotification,
  type TrialPolicy,
} from '@avc/core';

/**
 * Every user-facing monetization string in one place (monetization.md §6):
 * onboarding per size band, the leniency-ladder notifications, and the
 * expired-interaction replies. Pure builders, unit-tested, no Discord types.
 *
 * Tone: warm, plain, honest about *why* we charge (our costs scale per user),
 * never pushy. These are the bot-side surfaces of the Afterglow voice.
 *
 * Copy rules (AGENTS.md "Writing rules for user-facing copy") apply to every
 * string in this file: no em or en dashes, no prose semicolons, straight
 * quotes. These are read by users, so they follow the same rules as the site.
 */

export const SITE_URL = 'https://auto-voice.io';
export const STATUS_PAGE_URL = 'https://status.auto-voice.io/';

/**
 * Deep link to the dashboard focused on ONE guild, so renewing is a single
 * click from the message rather than a hunt through the server list.
 *
 * Every payment prompt must use this rather than {@link SITE_URL}: an admin who
 * has just been told their subscription lapsed should land on the thing that
 * fixes it. The dashboard treats an unknown or absent `guild` as "just show the
 * list", so a stale link degrades instead of erroring.
 */
export function subscribeUrl(guildId: string): string {
  return `${SITE_URL}/dashboard?guild=${guildId}`;
}

/**
 * The support server invite, which is where a money message that cannot be
 * self-served has to send someone.
 *
 * **Lives here rather than in `setupPanel.ts` because both need it and the
 * import can only run one way**: the panel already imports `SITE_URL` and
 * `subscribeUrl` from this module, so putting it there and reaching back for it
 * would be a cycle. A third copy of the invite code was the alternative and is
 * the worse one: an expired invite cannot be recreated, so the only fix is a new
 * code, and the last time one expired it was dead in the panel, on all 15 pages
 * of the website and in a cutover announcement that had already reached
 * thousands of servers. `web/src/lib/env.ts` holds the second copy as
 * `SUPPORT_SERVER_URL`, deliberately, because that module cannot import a core
 * value without dragging Postgres into a browser bundle. Two constants checked
 * by hand, not three.
 */
export const SUPPORT_URL = 'https://discord.gg/HT6GNhJ';
/**
 * Price label for the tier a guild of `memberCount` members needs.
 *
 * The headline with its billed total, from core's one formatter (§5.1), plus
 * the tier NAME on every notice: "Rare" means nothing to somebody reading a
 * warning about their own server, and the price without the name means nothing
 * to somebody comparing it against the pricing page.
 */
function priceLabel(memberCount: number): string {
  const tier = tierFor(memberCount);
  if (tier.pricePerYear === 0) return 'free';
  if (tier.pricePerYear === null) return 'custom pricing';
  return `${priceSentence(tier)} on the ${tier.label} plan`;
}

/** The one-time welcome when the bot joins a guild, by trial policy (§6). */
export function onboardingMessage(
  policy: TrialPolicy,
  memberCount: number,
  guildId: string,
): string {
  switch (policy) {
    case 'dormant':
      return (
        `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
        `creator channel.\n\nYour server is under 100 members, so AVC is **free forever** here, ` +
        `every feature included. Enjoy!`
      );
    case 'year':
      return (
        `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
        `creator channel.\n\nYour **1-year free trial** just started, everything's unlocked, ` +
        `no card needed. After the year it's ${priceLabel(memberCount)}. We charge because our ` +
        `hosting costs scale with server size, and nothing is ever paywalled. ` +
        `Manage it anytime at ${subscribeUrl(guildId)}`
      );
    case 'short':
      return (
        `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
        `creator channel.\n\nYour server is on the larger side, so you're on a ` +
        `**${TRIAL_SHORT_DAYS}-day free trial** with everything unlocked. Keeping AVC running ` +
        `for a server this size costs real infrastructure, so after the trial it's ` +
        `${priceLabel(memberCount)}. That's the whole model: no feature paywalls, ever. ` +
        `Subscribe (or read why we charge) at ${subscribeUrl(guildId)}`
      );
    case 'hard_gate':
      /**
       * Promises nothing about infrastructure, and links the support server
       * rather than the homepage (§5.3).
       *
       * It used to say "we run servers this size on dedicated infrastructure",
       * which owner decision 5 retracted: we do not know yet that we can serve
       * a server that size, and saying so to the largest server that ever adds
       * the bot is the worst place to find out. The homepage also names no
       * contact route, so `SITE_URL` was an instruction to go looking.
       */
      return (
        `👋 **Thanks for your interest in Auto Voice Channels!** A server this size needs a ` +
        `conversation before we switch AVC on, so we can make sure it works well for you. ` +
        `Come and say hello at ${SUPPORT_URL} and we'll take it from there.`
      );
  }
}

/**
 * The welcome for a server that is already covered by a subscription.
 *
 * Needed because {@link onboardingMessage} announces a trial and quotes a
 * per-server price, and a customer can reach `GUILD_CREATE` after paying:
 * checkout can name servers the bot is not in yet, and the webhook sets
 * `pool_id` without fanning entitlement out (§6.4), so there is a real window
 * where a paid server joins and still reads `trial`. Telling someone who just
 * paid that their free trial has started, and then quoting them a second
 * price, is the worst thing this surface can say.
 */
export function coveredWelcomeMessage(guildId: string): string {
  return (
    `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
    `creator channel.\n\nThis server is already covered by your subscription, so there is ` +
    `nothing else to sort out. Manage it anytime at ${subscribeUrl(guildId)}`
  );
}

/**
 * Who a ladder notification is being read by, which changes what is true in it.
 *
 * `guild` is the ordinary case: this server's own subscription or trial, read
 * by its own admins. `purchaser` is a billing message about a subscription
 * covering several servers, DM'd to the one person who can pay it. Both of
 * those were already handled. `shared_member` is the one that was not, and it
 * is the awkward one: a service-stopping notice fanned out into every server on
 * a shared subscription (§6.6), read by admins who may have bought nothing and
 * who never received the warnings that came before it.
 */
export type NotificationAudience = 'guild' | 'purchaser' | 'shared_member';

/**
 * Renders a leniency-ladder notification (the §4 grace ladder) as message
 * text. `guildId` deep-links to that server's dashboard card; a pool
 * notification (`plans/member-based-pricing.md` §6.6) has no one server to
 * deep-link to, so `notifyPurchaser` passes the plain dashboard URL instead,
 * where the pool panel is what the purchaser actually needs to see.
 */
export function notificationMessage(
  n: LeniencyNotification,
  memberCount: number,
  guildId: string,
  link: string = subscribeUrl(guildId),
  audience: NotificationAudience = 'guild',
): string {
  const tierLine = n.requiredTier ? tierById(n.requiredTier) : tierFor(memberCount);
  // Core's one formatter, like every other price the bot quotes (§5.1). This
  // was a third hand-written copy of the same three branches.
  const price = priceSentence(tierLine);

  /**
   * A fan-out copy landing in a server whose admins are not the buyer.
   *
   * Two things have to change, and neither is cosmetic. The message cannot
   * refer back to a grace period these readers were never told about, because
   * `grace_started` and `grace_nudge` go to the purchaser alone. And it cannot
   * instruct them to reactivate, because they cannot: it has to name who can.
   */
  if (audience === 'shared_member') {
    switch (n.kind) {
      case 'hard_gate':
        return (
          `🌙 **AVC is paused on this server.** The subscription covering it has lapsed, so ` +
          `voice automation has stopped. Nothing was deleted, and your settings are safe. ` +
          `Whoever manages that subscription can switch it back on at ${link}`
        );
      case 'reactivated':
        return `💜 **AVC is back on!** The subscription covering this server is current again, and voice automation has resumed.`;
      default:
        break;
    }
  }

  switch (n.kind) {
    case 'trial_warning': {
      const days = n.daysLeft ?? 0;
      /**
       * Names the one thing that makes deciding early cost nothing
       * (`plans/pricing-ladder.md` §6.5). The warning used to offer only
       * "subscribe", which asked the admin to throw away the trial days they
       * had left in order to stop being reminded about them, so the rational
       * move was to ignore every warning until the last one.
       *
       * No date, deliberately. The exact first-charge date is a function of
       * when the customer opens checkout, not of when this was sent, and the
       * dashboard card the link lands on quotes it precisely. Naming one here
       * would be a second answer to the question the invoice settles.
       */
      return (
        `⏳ **Your AVC free trial ends in ${days} day${days === 1 ? '' : 's'}.** ` +
        `Everything keeps working until then, and there's a generous grace period after. ` +
        `Set up a subscription now and you keep every day of the trial: the first charge ` +
        `lands the day it ends. ${tierLine.label} tier, ${price}, at ${link}`
      );
    }
    case 'grace_started': {
      const days = n.daysLeft ?? 60;
      if (n.reason === 'over_limit') {
        /**
         * A shared subscription's sum can cross a band because one server
         * grew, because several grew a little, or because a server was added.
         * "Your server has grown" gives a purchaser with eight servers nothing
         * to look at, and §7.3 says the band step has to be said out loud, so
         * name the number that actually moved.
         */
        if (audience === 'purchaser') {
          return (
            `🎉 **Your servers have grown.** Their members now add up to ${memberCount}, more ` +
            `than your plan covers, so you're in AVC's ${tierLine.label} tier (${price}). ` +
            `Nothing changes for ${days} days, everything keeps working while you upgrade at ` +
            `${link}\n\nCongrats on the growth!`
          );
        }
        return (
          `🎉 **Your server has grown!** You're now in AVC's ${tierLine.label} tier (${price}). ` +
          `Nothing changes for ${days} days, everything keeps working while you upgrade at ` +
          `${link}\n\nCongrats on the growth!`
        );
      }
      if (n.reason === 'subscription_lapsed') {
        // Deliberately covers both a failed payment and a cancellation. From
        // here the two look identical, and guessing wrong reads badly either way.
        return (
          `🕊️ **Your AVC subscription has ended.** Nothing has stopped, you're in a ${days}-day ` +
          `grace period with everything still working. Resubscribe or update your payment ` +
          `details whenever you're ready: ${link}`
        );
      }
      return (
        `🕊️ **Your AVC trial has ended, and nothing broke.** You're in a ${days}-day grace ` +
        `period with everything still working. Whenever you're ready, keep AVC going ` +
        `(${tierLine.label} tier, ${price}) at ${link}`
      );
    }
    case 'grace_nudge': {
      const days = n.daysLeft ?? 0;
      return (
        `🕊️ Friendly reminder: **${days} day${days === 1 ? '' : 's'} left** in your AVC grace ` +
        `period, and everything still works. Subscribe to keep it that way: ${link}`
      );
    }
    case 'hard_gate':
      return (
        `🌙 **AVC is now paused on this server.** The grace period ended, so voice automation ` +
        `has stopped. Nothing was deleted, and your settings are safe. Reactivate any ` +
        `time at ${link} and everything picks up exactly where it left off.`
      );
    case 'reactivated':
      return `💜 **AVC is back on!** Voice automation has resumed on this server. Thanks for being here.`;
    case 'grew_into_xxl':
      /**
       * 300,000, which is where the ladder now ends, and no infrastructure
       * promise (§5.3, owner decision 5). The `grew_into_xxl` KEY keeps its old
       * name deliberately: it is stored text in `metadata.billing` and in
       * `billing_notifications.key`, so renaming it would re-send the notice to
       * every guild that has already had it.
       */
      return (
        `🏛️ **Your server has grown past 300,000 members.** Amazing! A server this size is ` +
        `past the plans we sell, so let's talk about what you need: come and find us at ` +
        `${SUPPORT_URL}. Nothing changes in the meantime.`
      );
  }
}

/**
 * Ephemeral reply for any command in a hard-gated (expired) guild (§6).
 *
 * `shared` when the server is covered by a subscription spanning several
 * servers: the admin running the command is then quite likely not the person
 * who can pay, and telling them to reactivate is a dead end.
 */
export function expiredInteractionMessage(guildId: string, shared = false): string {
  if (shared) {
    return (
      `🌙 AVC is paused on this server, because the subscription covering it has lapsed. ` +
      `Nothing was deleted. Whoever manages that subscription can switch it back on at ` +
      `${subscribeUrl(guildId)}`
    );
  }
  return (
    `🌙 AVC is paused on this server, the trial or subscription has ended. ` +
    `Nothing was deleted. Reactivate at ${subscribeUrl(guildId)} and everything resumes instantly.`
  );
}

/**
 * Posted (throttled) into a creator channel someone joined while hard-gated.
 *
 * This one is **public**, in the channel's own text chat, so it is read by
 * ordinary members as well as admins. For a shared subscription it must not
 * invite "an admin" to reactivate, because the admins of this server may have
 * no standing over the subscription at all.
 */
export function gatedCreatorChannelNotice(guildId: string, shared = false): string {
  if (shared) {
    return (
      `🌙 AVC is paused on this server, because the subscription covering it has lapsed, so ` +
      `this creator channel isn't spawning rooms right now. Whoever manages that ` +
      `subscription can switch it back on at ${subscribeUrl(guildId)}`
    );
  }
  return (
    `🌙 AVC is paused on this server, its trial or subscription has ended, so this creator ` +
    `channel isn't spawning rooms right now. An admin can reactivate at ` +
    `${subscribeUrl(guildId)}`
  );
}

/** Which trial policy applies to a guild joining at `memberCount` members. */
export { trialPolicyFor };
