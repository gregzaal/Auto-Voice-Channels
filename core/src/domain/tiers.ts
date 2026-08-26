/**
 * Pricing tiers, derived from the member count a subscription covers (see
 * `plans/monetization.md` §2), plus the trial policy applied at bot-add (§3).
 *
 * That count is a sum across the servers on the subscription, not one server's
 * size: pooling is the default billing unit
 * (`plans/member-based-pricing.md`). `tierFor()` derives the **required**
 * tier from it; the **billed** tier (what the subscription actually covers) is
 * cached on `guilds.tier`, written from Paddle for a guild-keyed subscription
 * and fanned out from `member_pools.billed_tier` by the reconciler for a
 * pooled one. Keeping the two apart is load-bearing: computing one from the
 * other disables over-limit detection permanently (§5.1).
 */
export const TIER_IDS = ['free', 's', 'm', 'l', 'xl', 'xxl'] as const;
export type TierId = (typeof TIER_IDS)[number];

export interface Tier {
  /** Stable id (also the future Paddle price-id key). */
  id: TierId;
  /** Short display label. */
  label: string;
  /** Upper bound (exclusive). A guild is in this tier when `members < maxExclusive`. */
  maxExclusive: number;
  /** USD list price per year, or `null` for the bespoke "contact us" tier. `0` = free forever. */
  pricePerYear: number | null;
}

/** The tier table, ascending by size. The last entry is the unbounded XXL tier. */
export const TIERS: readonly Tier[] = [
  { id: 'free', label: 'Free', maxExclusive: 100, pricePerYear: 0 },
  { id: 's', label: 'S', maxExclusive: 1_000, pricePerYear: 19 },
  { id: 'm', label: 'M', maxExclusive: 10_000, pricePerYear: 59 },
  { id: 'l', label: 'L', maxExclusive: 100_000, pricePerYear: 399 },
  { id: 'xl', label: 'XL', maxExclusive: 1_000_000, pricePerYear: 1_999 },
  { id: 'xxl', label: 'XXL', maxExclusive: Number.POSITIVE_INFINITY, pricePerYear: null },
] as const;

/**
 * The tier a guild of `memberCount` members falls into. A negative/NaN count is
 * clamped to 0 (treated as the Free tier) so callers never get `undefined`.
 */
export function tierFor(memberCount: number): Tier {
  const count = Number.isFinite(memberCount) && memberCount > 0 ? memberCount : 0;
  // The table is exhaustive (the last bound is +Infinity), so a match always exists.
  return TIERS.find((t) => count < t.maxExclusive) ?? TIERS[TIERS.length - 1]!;
}

/** Whether a guild of this size is on the free-forever tier (< 100 members). */
export function isFreeForever(memberCount: number): boolean {
  return tierFor(memberCount).id === 'free';
}

/** Lookup a tier by its stable id. */
export function tierById(id: TierId): Tier {
  // Ids are a closed union, so a match always exists.
  return TIERS.find((t) => t.id === id) ?? TIERS[0]!;
}

/**
 * Orders tiers by size: negative when `a` is a smaller tier than `b`, zero when
 * equal, positive when larger. Used for the over-limit check (`required > billed`).
 */
export function compareTiers(a: TierId, b: TierId): number {
  return TIERS.findIndex((t) => t.id === a) - TIERS.findIndex((t) => t.id === b);
}

// ---------------------------------------------------------------------------
// Trial policy (monetization.md §3) — how the trial applies at bot-add time,
// by member count. The trial clock starts the moment the bot is FIRST added
// and runs 1 year; a large guild instead gets a short taste; a huge guild is
// hard-gated until a subscription is arranged.
// ---------------------------------------------------------------------------

export const TRIAL_YEAR_DAYS = 365;
export const TRIAL_SHORT_DAYS = 14;

export type TrialPolicy =
  /** `< 100` members — free forever; the trial clock runs but is never needed. */
  | 'dormant'
  /** `100 – 9,999` members — 1-year free trial, fully entitled. */
  | 'year'
  /** `10,000 – 999,999` members — 14-day free trial, then subscribe. */
  | 'short'
  /** `≥ 1,000,000` members — no trial; a subscription must be arranged first. */
  | 'hard_gate';

/** The trial policy for a guild of `memberCount` members at bot-add time. */
export function trialPolicyFor(memberCount: number): TrialPolicy {
  const tier = tierFor(memberCount);
  if (tier.id === 'free') return 'dormant';
  if (tier.id === 's' || tier.id === 'm') return 'year';
  if (tier.id === 'xxl') return 'hard_gate';
  return 'short';
}

const DAY_MS = 86_400_000;

/**
 * The trial window length for a policy, in milliseconds. `null` for the hard
 * gate (there is no trial window). The dormant policy still gets the 1-year
 * clock — it was always running; it just becomes relevant if the guild grows.
 */
export function trialDurationMs(policy: TrialPolicy): number | null {
  switch (policy) {
    case 'dormant':
    case 'year':
      return TRIAL_YEAR_DAYS * DAY_MS;
    case 'short':
      return TRIAL_SHORT_DAYS * DAY_MS;
    case 'hard_gate':
      return null;
  }
}
