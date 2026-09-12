/**
 * Pricing tiers use the member count covered by a subscription. For a pool,
 * this is the sum across its billable servers.
 *
 * `tierFor` derives the required tier. The billed tier is stored separately
 * on the subscription or member pool and mirrored onto guilds. Deriving the
 * billed tier from current size would silently disable over-limit detection.
 * Trial policy is evaluated separately at the first bot add.
 */
/**
 * Accepted stored tier ids. During a repricing this can be a superset of the
 * ids {@link TIERS} prices.
 *
 * Expand before writing: every instance must accept a new id before any
 * instance stores it. Repository `z.enum(TIER_IDS)` parsing otherwise throws
 * on a single read or drops the row from batch reads, skipping entitlement.
 *
 * Append new ids without reordering. Size comparisons use {@link tierRank},
 * never this array's position. Remove an id only after verifying that stored
 * rows, live subscriptions and active catalogue prices can no longer supply it.
 * The accepted and priced sets are equal in the steady state.
 */
export const TIER_IDS = ['free', 's', 'm', 'epic', 'legendary', 'mythic', 'exotic'] as const;
export type TierId = (typeof TIER_IDS)[number];

/** Whether an arbitrary value is a tier id this build accepts. */
export function isTierId(value: unknown): value is TierId {
  return typeof value === 'string' && (TIER_IDS as readonly string[]).includes(value);
}

export interface Tier {
  /** Stable id (also the Paddle price-id key). */
  id: TierId;
  /** Short display label. */
  label: string;
  /** Upper bound (exclusive). A guild is in this tier when `members < maxExclusive`. */
  maxExclusive: number;
  /** USD list price per year, or `null` for the bespoke "contact us" tier. `0` = free forever. */
  pricePerYear: number | null;
  /**
   * USD list price per month when billed MONTHLY, or `null` where monthly
   * billing is not offered (`free`, `s` and `exotic`, plus every retired id).
   *
   * **Not the headline.** The headline is {@link headlinePerMonth}, which is
   * the yearly price over 12 and is what every surface shows by default. This
   * is the higher figure a customer pays for the convenience of paying monthly,
   * exactly one tenth of the yearly price, so "pay yearly, get two months free"
   * is arithmetically exact rather than approximately true.
   *
   * Uncommon has none because below a yearly price of $28.95 Paddle's fixed 50
   * cents per transaction eats the difference: twelve charges would net less
   * than one.
   */
  pricePerMonth: number | null;
}

/**
 * The tier table, ascending by size, ending in an unbounded bespoke tier.
 *
 * Yearly prices are multiples of six so the monthly headline is a whole dollar
 * or half dollar. Where monthly billing is offered, yearly prices are also
 * multiples of thirty so the monthly charge is a whole dollar.
 *
 * `s` and `m` retain stable storage ids despite their customer-facing labels.
 * Renaming a label does not require renaming persisted ids.
 */
export const TIERS: readonly Tier[] = [
  { id: 'free', label: 'Free', maxExclusive: 100, pricePerYear: 0, pricePerMonth: null },
  { id: 's', label: 'Uncommon', maxExclusive: 1_000, pricePerYear: 18, pricePerMonth: null },
  { id: 'm', label: 'Rare', maxExclusive: 10_000, pricePerYear: 30, pricePerMonth: 3 },
  { id: 'epic', label: 'Epic', maxExclusive: 30_000, pricePerYear: 90, pricePerMonth: 9 },
  {
    id: 'legendary',
    label: 'Legendary',
    maxExclusive: 100_000,
    pricePerYear: 180,
    pricePerMonth: 18,
  },
  { id: 'mythic', label: 'Mythic', maxExclusive: 300_000, pricePerYear: 390, pricePerMonth: 39 },
  {
    id: 'exotic',
    label: 'Exotic',
    maxExclusive: Number.POSITIVE_INFINITY,
    pricePerYear: null,
    pricePerMonth: null,
  },
] as const;

/**
 * A tier's price as one line of prose, for every message the bot sends.
 *
 * The HEADLINE with the billed total beside it, never the yearly figure alone: "$7.50 a month,
 * billed yearly ($90)".
 * A bot message has no room for a two-line card and no toggle to offer, so it
 * states the default and the total it comes from.
 *
 * In core rather than in the bot, because `/setup`'s panel and the billing
 * notices both quote a price and were two hand-written formatters that had
 * already drifted apart once. Never "from $X": it is that server's own tier
 * price, not a floor.
 */
export function priceSentence(tier: Tier): string {
  if (tier.pricePerYear === 0) return 'free';
  if (tier.pricePerYear === null) return 'custom pricing';
  // Not null by here: `headlinePerMonth` returns null for exactly the zero and
  // null prices the two lines above already returned for.
  const headline = headlinePerMonth(tier)!;
  const money = (n: number): string => `$${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
  return `${money(headline)} a month, billed yearly (${money(tier.pricePerYear)})`;
}

/**
 * The headline price: the monthly figure for a tier paid YEARLY.
 *
 * **This is what every customer-facing surface shows**, with the billed yearly
 * total beside it in the same line and never as a footnote. Derived here rather
 * than stored, so it never disagrees with `pricePerYear`. The tier table keeps
 * it exact to the cent.
 *
 * `null` for Free (there is no monthly framing of nothing) and Exotic (quoted).
 */
export function headlinePerMonth(tier: Tier): number | null {
  if (tier.pricePerYear === null || tier.pricePerYear === 0) return null;
  return tier.pricePerYear / 12;
}

/**
 * Priced tier ids, ascending by size. Use this list to render or enumerate the
 * price ladder. {@link TIER_IDS} can include compatibility ids with no price in
 * this build; {@link tierById}'s lenient largest-tier fallback is an access
 * safeguard, not a purchasable row to display.
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
 * role on it would be the one badge that means nothing.
 *
 * Deriving from {@link TIER_IDS} rather than from `TIERS` is deliberate: while
 * an id is accept-only, a customer stamped with it keeps their badge. The
 * corollary bit when phase 7 retired three ids, and is worth knowing before
 * retiring any more: dropping an id here drops its `SUPPORT_ROLE_<ID>` env key,
 * so the bot stops MANAGING that Discord role and can no longer strip it from
 * anyone still holding it. Check who holds it before retiring, not after.
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
 * A tier's name for CUSTOMER-FACING copy, given a possibly-stored id.
 *
 * Use this, never `tierById(id).label`, wherever the id came out of the
 * database (`guilds.tier`, `subscriptions.tier`, `member_pools.billed_tier`).
 * `tierById`'s fallback answers with the largest priced tier, which is the
 * right direction for a CEILING (see its docstring) and confidently wrong for a
 * NAME: a customer still stamped `l` was told they were on the "Exotic" plan,
 * and one message read "more members than the Exotic plan covers", which is
 * impossible since Exotic is unbounded.
 *
 * The fallback is the bare id, which is terse but true. `guilds.tier` is never
 * cleared when a subscription lapses, so whether any such row exists is a data
 * question rather than something the code can promise.
 */
export function tierLabel(id: TierId): string {
  return pricedTierById(id)?.label ?? id.toUpperCase();
}

/**
 * Orders tiers by size: negative when `a` is a smaller tier than `b`, zero when
 * equal, positive when larger. Used for the over-limit check (`required > billed`).
 */
export function compareTiers(a: TierId, b: TierId): number {
  return tierRank(a) - tierRank(b);
}

// ---------------------------------------------------------------------------
// Trial policy — how the trial applies at bot-add time,
// by member count. The trial clock starts the moment the bot is FIRST added
// and runs 1 year; a large guild instead gets a short taste; a huge guild is
// hard-gated until a subscription is arranged.
// ---------------------------------------------------------------------------

export const TRIAL_YEAR_DAYS = 365;
/**
 * The short trial, for guilds already large when the bot is added.
 *
 * The warning cadence must cover this whole window: `leniency.ts` selects
 * short-trial offsets for windows of 30 days or less. Changing the duration
 * without reviewing those offsets can leave most of the trial silent.
 */
export const TRIAL_SHORT_DAYS = 30;

export type TrialPolicy =
  /** `< 100` members — free forever; the trial clock runs but is never needed. */
  | 'dormant'
  /** `100 – 9,999` members — 1-year free trial, fully entitled. */
  | 'year'
  /** `10,000 – 299,999` members — 30-day free trial, then subscribe. */
  | 'short'
  /** `≥ 300,000` members — no trial; a subscription must be arranged first. */
  | 'hard_gate';

/**
 * The trial policy for a guild of `memberCount` members at bot-add time.
 *
 * Keyed off the tier id rather than the count so the bounds live in exactly one
 * place. Exotic requires an arranged subscription before the bot is enabled;
 * smaller paid tiers receive the trial window defined below.
 */
export function trialPolicyFor(memberCount: number): TrialPolicy {
  const tier = tierFor(memberCount);
  if (tier.id === 'free') return 'dormant';
  if (tier.id === 's' || tier.id === 'm') return 'year';
  if (tier.id === 'exotic') return 'hard_gate';
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
