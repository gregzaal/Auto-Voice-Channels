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
 * expired-interaction replies. Pure builders — unit-tested, no Discord types.
 *
 * Tone: warm, plain, honest about *why* we charge (our costs scale per user),
 * never pushy. These are the bot-side surfaces of the Afterglow voice.
 */

export const SITE_URL = 'https://auto-voice.io';

/** Price label for the tier a guild of `memberCount` members needs. */
function priceLabel(memberCount: number): string {
  const tier = tierFor(memberCount);
  if (tier.pricePerYear === 0) return 'free';
  if (tier.pricePerYear === null) return 'custom pricing';
  return `$${tier.pricePerYear}/yr (${tier.label} tier)`;
}

/** The one-time welcome when the bot joins a guild, by trial policy (§6). */
export function onboardingMessage(policy: TrialPolicy, memberCount: number): string {
  switch (policy) {
    case 'dormant':
      return (
        `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
        `creator channel.\n\nYour server is under 100 members, so AVC is **free forever** here — ` +
        `every feature included. Enjoy!`
      );
    case 'year':
      return (
        `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
        `creator channel.\n\nYour **1-year free trial** just started — everything's unlocked, ` +
        `no card needed. After the year it's ${priceLabel(memberCount)}; we charge because our ` +
        `hosting costs scale with server size, and nothing is ever paywalled. ` +
        `Manage it anytime at ${SITE_URL}.`
      );
    case 'short':
      return (
        `👋 **Thanks for adding Auto Voice Channels!** Run \`/setup\` to create your first ` +
        `creator channel.\n\nYour server is on the larger side, so you're on a ` +
        `**${TRIAL_SHORT_DAYS}-day free trial** with everything unlocked. Keeping AVC running ` +
        `for a server this size costs real infrastructure, so after the trial it's ` +
        `${priceLabel(memberCount)} — that's the whole model: no feature paywalls, ever. ` +
        `Subscribe (or read why we charge) at ${SITE_URL}.`
      );
    case 'hard_gate':
      return (
        `👋 **Thanks for your interest in Auto Voice Channels!** This server is very large — ` +
        `we run servers this size on dedicated infrastructure, so let's set that up together ` +
        `before switching AVC on. Contact us at ${SITE_URL} and we'll get you going.`
      );
  }
}

/** Renders a leniency-ladder notification (the §4 grace ladder) as message text. */
export function notificationMessage(n: LeniencyNotification, memberCount: number): string {
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
        `Everything keeps working until then — and there's a generous grace period after. ` +
        `To keep AVC running (${tierLine.label} tier, ${price}), subscribe at ${SITE_URL}.`
      );
    }
    case 'grace_started': {
      const days = n.daysLeft ?? 60;
      if (n.reason === 'over_limit') {
        return (
          `🎉 **Your server has grown!** You're now in AVC's ${tierLine.label} tier (${price}). ` +
          `Nothing changes for ${days} days — everything keeps working while you upgrade at ` +
          `${SITE_URL}. Congrats on the growth!`
        );
      }
      if (n.reason === 'subscription_lapsed') {
        // Deliberately covers both a failed payment and a cancellation — from
        // here the two look identical, and guessing wrong reads badly either way.
        return (
          `🕊️ **Your AVC subscription has ended.** Nothing has stopped — you're in a ${days}-day ` +
          `grace period with everything still working. Resubscribe or update your payment ` +
          `details at ${SITE_URL} whenever you're ready.`
        );
      }
      return (
        `🕊️ **Your AVC trial has ended — and nothing broke.** You're in a ${days}-day grace ` +
        `period with everything still working. Whenever you're ready, keep AVC going ` +
        `(${tierLine.label} tier, ${price}) at ${SITE_URL}.`
      );
    }
    case 'grace_nudge': {
      const days = n.daysLeft ?? 0;
      return (
        `🕊️ Friendly reminder: **${days} day${days === 1 ? '' : 's'} left** in your AVC grace ` +
        `period — everything still works. Subscribe at ${SITE_URL} to keep it that way.`
      );
    }
    case 'hard_gate':
      return (
        `🌙 **AVC is now paused on this server.** The grace period ended, so voice automation ` +
        `has stopped — but nothing was deleted, and your settings are safe. Reactivate any ` +
        `time at ${SITE_URL} and everything picks up exactly where it left off.`
      );
    case 'reactivated':
      return `💜 **AVC is back on!** Voice automation has resumed on this server. Thanks for being here.`;
    case 'grew_into_xxl':
      return (
        `🏛️ **Your server has grown past one million members** — amazing! At this size we run ` +
        `AVC on dedicated infrastructure, so let's talk: reach us via ${SITE_URL} and we'll ` +
        `arrange the right setup. Nothing changes in the meantime.`
      );
  }
}

/** Ephemeral reply for any command in a hard-gated (expired) guild (§6). */
export function expiredInteractionMessage(): string {
  return (
    `🌙 AVC is paused on this server — the trial/subscription has ended. ` +
    `Nothing was deleted; reactivate at ${SITE_URL} and everything resumes instantly.`
  );
}

/** Posted (throttled) into a creator channel someone joined while hard-gated. */
export function gatedCreatorChannelNotice(): string {
  return (
    `🌙 AVC is paused on this server — its trial/subscription has ended, so this creator ` +
    `channel isn't spawning voice channels right now. An admin can reactivate at ${SITE_URL}.`
  );
}

/** Which trial policy applies to a guild joining at `memberCount` members. */
export { trialPolicyFor };
