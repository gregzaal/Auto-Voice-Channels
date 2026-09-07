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
/**
 * Every tier id any build in the fleet may legitimately hold, which during a
 * repricing is deliberately a SUPERSET of the ids {@link TIERS} prices.
 *
 * This is the expand half of an expand/contract change (`plans/pricing-ladder.md`
 * §8.2, phase A). Ids are stored text in `guilds.tier`, `subscriptions.tier` and
 * `member_pools.billed_tier`, and **every read of those columns is a
 * `z.enum(TIER_IDS)` with no `.catch()`**: `GuildRepository.ensure`/`.get`
 * `.parse` it and would throw on the hot path behind the entitlement gate
 * (silencing the guild), while `listBatch` in the guild, subscription and pool
 * repositories `safeParse` and **drop** the row, which in the reconciler's
 * ladder walk and the pool fan-out means a customer on a newer tier silently
 * never gets entitlement. So every instance must accept an id before any
 * instance writes it, and this list is how.
 *
 * `epic`/`legendary`/`mythic`/`exotic` are therefore accepted here a release
 * before {@link TIERS} prices them, and `l`/`xl`/`xxl` stay accepted a release
 * after it stops (phase 7 retires them). **Append only** -- never insert, and
 * never reorder: nothing derives size from this array's order (see
 * {@link tierRank}), but `z.enum` and the admin surfaces both read it.
 */
export const TIER_IDS = [
  'free',
  's',
  'm',
  'l',
  'xl',
  'xxl',
  'epic',
  'legendary',
  'mythic',
  'exotic',
] as const;
export type TierId = (typeof TIER_IDS)[number];

/** Whether an arbitrary value is a tier id this build accepts. */
export function isTierId(value: unknown): value is TierId {
  return typeof value === 'string' && (TIER_IDS as readonly string[]).includes(value);
}

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
 * The ids {@link TIERS} actually prices, ascending by size.
 *
 * Use this, never {@link TIER_IDS}, wherever the ladder itself is being
 * rendered or enumerated: during a repricing `TIER_IDS` also carries the ids of
 * the neighbouring release, and {@link tierById} answers `free` for those, so
 * iterating `TIER_IDS` paints phantom rows labelled "Free".
 */
export const PRICED_TIER_IDS: readonly TierId[] = TIERS.map((t) => t.id);

/**
 * Ids {@link TIER_IDS} accepts that {@link TIERS} does not price.
 *
 * Empty in the steady state. Non-empty only mid-repricing, when it holds the
 * ids of the release either side of this one.
 */
export const ACCEPT_ONLY_TIER_IDS: readonly TierId[] = TIER_IDS.filter(
  (id) => !PRICED_TIER_IDS.includes(id),
);

/**
 * Tiers that can carry a supporter role: every accepted id except `free`.
 *
 * `free` has no entry by construction. It is not a purchase, and a "supporter"
 * role on it would be the one badge that means nothing. Retired ids stay in the
 * list so a customer still stamped with one keeps their badge until phase 7.
 */
export const SUPPORTER_ROLE_TIER_IDS = TIER_IDS.filter(
  (id): id is Exclude<TierId, 'free'> => id !== 'free',
);

/** `epic` -> `SUPPORT_ROLE_EPIC`. The one place that mapping is spelled out. */
export function envKeyForSupporterRole(id: Exclude<TierId, 'free'>): string {
  return `SUPPORT_ROLE_${id.toUpperCase()}`;
}

/** Every `SUPPORT_ROLE_*` env key, in tier order. Read on boot, so it stays wide. */
export const SUPPORTER_ROLE_ENV_KEYS: readonly string[] =
  SUPPORTER_ROLE_TIER_IDS.map(envKeyForSupporterRole);

/**
 * The subset of {@link SUPPORTER_ROLE_ENV_KEYS} worth telling an operator about.
 *
 * `SUPPORTER_ROLE_ENV_KEYS` is read from the environment and must accept a key
 * for any tier a customer could still be stamped with. Advice is the other
 * direction: a key for a tier {@link TIERS} does not price can badge nobody, so
 * naming it in a boot error sends someone to set a variable that does nothing.
 */
export const SUPPORTER_ROLE_ADVICE_KEYS: readonly string[] = PRICED_TIER_IDS.filter(
  (id) => id !== 'free',
).map((id) => envKeyForSupporterRole(id as Exclude<TierId, 'free'>));

/**
 * Size rank of a tier, and **the single ordering authority** for tiers.
 *
 * There used to be two, which is why this exists: `compareTiers` ranked by
 * `TIERS.findIndex` while four call sites ranked by `TIER_IDS.indexOf`, and the
 * two agreed only because the two literals happened to be in the same order.
 * The moment `TIER_IDS` gained the rarity ids by appending them, `epic` ranked
 * *above* `xxl` in the second ordering and below it in the first, which inverts
 * the over-limit comparison in `web/src/lib/billing/pools.ts`. Neither literal
 * is a size measure; this function is.
 *
 * An **accept-only** id (one this build does not price) ranks one past the
 * largest priced tier, so it never compares as *smaller* than a priced tier.
 * That direction is deliberate. The comparison this feeds is
 * `compareTiers(required, billed) > 0` meaning "over limit", and `required`
 * always comes from {@link tierFor} over {@link TIERS}, so the only mixed case
 * is a billed tier written by a newer build. Ranking it last makes that read as
 * "not over limit": during a rolling deploy we under-escalate a guild for one
 * release rather than telling a paying customer they have outgrown a plan they
 * just bought and starting their upgrade-breach clock.
 */
export function tierRank(id: TierId): number {
  const index = TIERS.findIndex((t) => t.id === id);
  return index >= 0 ? index : TIERS.length;
}

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

/**
 * Lookup a tier by its stable id, falling back to the LARGEST priced tier.
 *
 * **The fallback is a live branch, not a formality.** It used to say "ids are a
 * closed union, so a match always exists" and return `TIERS[0]`, which was true
 * until {@link TIER_IDS} became a superset of {@link TIERS}. It now answers for
 * every {@link ACCEPT_ONLY_TIER_IDS} member, and the direction it answers in
 * decides what a dozen call sites do with a stored billed tier.
 *
 * `TIERS[0]` was the harmful direction, because it is `free`: `maxExclusive`
 * 100, so every ceiling test against a real guild fails. Traced consequences of
 * the old fallback, all silent: `evaluateGrace` could never let a guild leave
 * `grace` (`sustainedUnder(state, 100)` is false above 100 members), the
 * dashboard and `/setup` told a paying customer they were on the free tier, and
 * `addGuildToSubscription` refused to add any server because the projected
 * count already exceeded the ceiling.
 *
 * The largest tier is the lenient direction and matches {@link tierRank}, which
 * ranks the same ids last for the same reason: an id this build does not price
 * was written by a build that does, so under-enforcing for one release beats
 * charging, gating or mislabelling a customer against a ceiling of 100. Its
 * `pricePerYear` is `null`, so a price surface renders "contact us" rather than
 * "$0" -- visibly odd instead of plausibly wrong.
 *
 * Use {@link pricedTierById} where a caller can act on "no such tier" instead.
 */
export function tierById(id: TierId): Tier {
  return TIERS.find((t) => t.id === id) ?? TIERS[TIERS.length - 1]!;
}

/**
 * Lookup a tier by id, or null when this build does not price it.
 *
 * The honest form of {@link tierById} for a caller reading a **stored** id
 * (`guilds.tier`, `subscriptions.tier`, `member_pools.billed_tier`), which
 * during a repricing may name a tier from the release either side of this one.
 */
export function pricedTierById(id: TierId): Tier | null {
  return TIERS.find((t) => t.id === id) ?? null;
}

/**
 * Orders tiers by size: negative when `a` is a smaller tier than `b`, zero when
 * equal, positive when larger. Used for the over-limit check (`required > billed`).
 */
export function compareTiers(a: TierId, b: TierId): number {
  return tierRank(a) - tierRank(b);
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
