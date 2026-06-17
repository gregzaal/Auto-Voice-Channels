/**
 * Per-server pricing tiers, derived from member count (see
 * `plans/monetization.md` §2). This is the **display/derivation** half of the
 * model — a pure `tierFor()` over the tier table — used today only to *show*
 * a guild where it sits (e.g. in `/setup`). The billing machinery
 * (subscriptions, Paddle, the leniency ladder) is a separate, later effort;
 * when it lands it extends this table with Paddle price ids rather than
 * replacing it.
 *
 * Tier is never an authoritative stored value — it is always re-derived from
 * the current member count.
 */
export interface Tier {
  /** Stable id (also the future Paddle price-id key). */
  id: 'free' | 's' | 'm' | 'l' | 'xl' | 'xxl';
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
