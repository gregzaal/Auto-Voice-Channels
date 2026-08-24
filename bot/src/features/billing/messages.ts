import {
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

/** Price label for the tier a guild of `memberCount` members needs. */
function priceLabel(memberCount: number): string {
  const tier = tierFor(memberCount);
  if (tier.pricePerYear === 0) return 'free';
  if (tier.pricePerYear === null) return 'custom pricing';
  return `$${tier.pricePerYear}/yr (${tier.label} tier)`;
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
      return (
        `👋 **Thanks for your interest in Auto Voice Channels!** This server is very large, and ` +
        `we run servers this size on dedicated infrastructure, so let's set that up together ` +
        `before switching AVC on. Contact us at ${SITE_URL} and we'll get you going.`
      );
  }
}

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
): string {
  const tierLine = n.requiredTier ? tierById(n.requiredTier) : tierFor(memberCount);
  const price =
    tierLine.pricePerYear === null
      ? 'custom pricing'
      : tierLine.pricePerYear === 0
        ? 'free'
        : `$${tierLine.pricePerYear}/yr`;
  switch (n.kind) {
    case 'trial_warning': {
      const days = n.daysLeft ?? 0;
      return (
        `⏳ **Your AVC free trial ends in ${days} day${days === 1 ? '' : 's'}.** ` +
        `Everything keeps working until then, and there's a generous grace period after. ` +
        `To keep AVC running (${tierLine.label} tier, ${price}), subscribe at ${link}`
      );
    }
    case 'grace_started': {
      const days = n.daysLeft ?? 60;
      if (n.reason === 'over_limit') {
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
      return (
        `🏛️ **Your server has grown past one million members.** Amazing! At this size we run ` +
        `AVC on dedicated infrastructure, so let's talk: reach us via ${SITE_URL} and we'll ` +
        `arrange the right setup. Nothing changes in the meantime.`
      );
  }
}

/** Ephemeral reply for any command in a hard-gated (expired) guild (§6). */
export function expiredInteractionMessage(guildId: string): string {
  return (
    `🌙 AVC is paused on this server, the trial or subscription has ended. ` +
    `Nothing was deleted. Reactivate at ${subscribeUrl(guildId)} and everything resumes instantly.`
  );
}

/** Posted (throttled) into a creator channel someone joined while hard-gated. */
export function gatedCreatorChannelNotice(guildId: string): string {
  return (
    `🌙 AVC is paused on this server, its trial or subscription has ended, so this creator ` +
    `channel isn't spawning voice channels right now. An admin can reactivate at ` +
    `${subscribeUrl(guildId)}`
  );
}

/** Which trial policy applies to a guild joining at `memberCount` members. */
export { trialPolicyFor };
