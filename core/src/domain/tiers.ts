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
   * is arithmetically exact rather than approximately true
   * (`plans/pricing-ladder.md` §3).
   *
   * Uncommon has none because below a yearly price of $28.95 Paddle's fixed 50
   * cents per transaction eats the difference: twelve charges would net less
   * than one (§3.1).
   */
  pricePerMonth: number | null;
}

/**
 * The tier table, ascending by size. The last entry is the unbounded top tier.
 *
 * **The rarity ladder** (`plans/pricing-ladder.md` §3, approved 2026-09-07).
 * Every yearly price is a multiple of 6, so the headline (yearly over 12) is a
 * whole dollar or a half; where monthly billing is offered the yearly price is
 * a multiple of 30, so the monthly price is a whole dollar too. That is rule 4
 * of §4 and it is why these are the exact numbers rather than round-looking
 * yearly figures: $19 shows as $1.58, which the display decision forbids.
 *
 * `s` and `m` keep their ids: their member ranges are unchanged and only the
 * label and price move, so renaming them would be a data migration on three
 * rows for cosmetics. `l`, `xl` and `xxl` are gone from the ladder but stay in
 * {@link TIER_IDS} until phase 7, because rows still reference them.
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
 * The headline price: the monthly figure for a tier paid YEARLY.
 *
 * **This is what every customer-facing surface shows**, with the billed yearly
 * total beside it in the same line and never as a footnote
 * (`plans/pricing-ladder.md` §5.1). Derived here rather than stored, so it can
 * never disagree with `pricePerYear`, and exact to the cent by rule 4.
 *
 * `null` for Free (there is no monthly framing of nothing) and Exotic (quoted).
 */
export function headlinePerMonth(tier: Tier): number | null {
  if (tier.pricePerYear === null || tier.pricePerYear === 0) return null;
  return tier.pricePerYear / 12;
}

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
// Trial policy (monetization.md §3) — how the trial applies at bot-add time,
// by member count. The trial clock starts the moment the bot is FIRST added
// and runs 1 year; a large guild instead gets a short taste; a huge guild is
// hard-gated until a subscription is arranged.
// ---------------------------------------------------------------------------

export const TRIAL_YEAR_DAYS = 365;
/**
 * The short trial, for guilds already large when the bot is added.
 *
 * **30 days, up from 14** (`plans/pricing-ladder.md` §7). A $90-to-$360
 * decision inside a community team needs a purchase cycle, and 30 days of a
 * 300k server costs us about $20. Raising it also changes the warning cadence:
 * `leniency.ts` picks its short offsets for any window of 30 days or less, and
 * the old `[7, 2, 1]` would leave a 30-day trial silent for 23 days.
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
 * place. The hard gate moved from 1,000,000 to 300,000 with the rarity ladder
 * (§7, owner decision 5): self-serve ends where rule 2's quarter-margin closes,
 * and a server above it is a conversation before the bot is switched on.
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
