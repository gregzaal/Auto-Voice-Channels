import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ONLY_TIER_IDS,
  compareTiers,
  envKeyForSupporterRole,
  isTierId,
  PRICED_TIER_IDS,
  pricedTierById,
  SUPPORTER_ROLE_ADVICE_KEYS,
  SUPPORTER_ROLE_ENV_KEYS,
  SUPPORTER_ROLE_TIER_IDS,
  TIER_IDS,
  tierRank,
  isFreeForever,
  tierById,
  tierFor,
  TIERS,
  trialDurationMs,
  trialPolicyFor,
} from './tiers.js';

describe('tierFor', () => {
  it('maps boundary member counts to the right tier', () => {
    expect(tierFor(0).id).toBe('free');
    expect(tierFor(99).id).toBe('free');
    expect(tierFor(100).id).toBe('s');
    expect(tierFor(999).id).toBe('s');
    expect(tierFor(1_000).id).toBe('m');
    expect(tierFor(9_999).id).toBe('m');
    expect(tierFor(10_000).id).toBe('l');
    expect(tierFor(99_999).id).toBe('l');
    expect(tierFor(100_000).id).toBe('xl');
    expect(tierFor(999_999).id).toBe('xl');
    expect(tierFor(1_000_000).id).toBe('xxl');
    expect(tierFor(50_000_000).id).toBe('xxl');
  });

  it('clamps negative / non-finite counts to the free tier', () => {
    expect(tierFor(-5).id).toBe('free');
    expect(tierFor(Number.NaN).id).toBe('free');
  });

  it('exposes prices matching the monetization plan', () => {
    expect(tierFor(50).pricePerYear).toBe(0);
    expect(tierFor(500).pricePerYear).toBe(19);
    expect(tierFor(5_000).pricePerYear).toBe(59);
    expect(tierFor(50_000).pricePerYear).toBe(399);
    expect(tierFor(500_000).pricePerYear).toBe(1_999);
    expect(tierFor(2_000_000).pricePerYear).toBeNull();
  });

  it('isFreeForever tracks the <100 boundary', () => {
    expect(isFreeForever(99)).toBe(true);
    expect(isFreeForever(100)).toBe(false);
  });

  it('the table is ascending and exhaustive', () => {
    const bounds = TIERS.map((t) => t.maxExclusive);
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));
    expect(TIERS[TIERS.length - 1]!.maxExclusive).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('tier helpers', () => {
  it('tierById finds each tier', () => {
    for (const tier of TIERS) expect(tierById(tier.id)).toBe(tier);
  });

  it('compareTiers orders by size', () => {
    expect(compareTiers('free', 's')).toBeLessThan(0);
    expect(compareTiers('m', 'm')).toBe(0);
    expect(compareTiers('xl', 'm')).toBeGreaterThan(0);
    expect(compareTiers('xxl', 'xl')).toBeGreaterThan(0);
  });
});

describe('trialPolicyFor (monetization.md §3)', () => {
  it('maps size bands at their boundaries', () => {
    expect(trialPolicyFor(0)).toBe('dormant');
    expect(trialPolicyFor(99)).toBe('dormant');
    expect(trialPolicyFor(100)).toBe('year');
    expect(trialPolicyFor(9_999)).toBe('year');
    expect(trialPolicyFor(10_000)).toBe('short');
    expect(trialPolicyFor(999_999)).toBe('short');
    expect(trialPolicyFor(1_000_000)).toBe('hard_gate');
  });

  it('trial durations: a year for small/dormant, 14 days for large, none for the gate', () => {
    const day = 86_400_000;
    expect(trialDurationMs('dormant')).toBe(365 * day);
    expect(trialDurationMs('year')).toBe(365 * day);
    expect(trialDurationMs('short')).toBe(14 * day);
    expect(trialDurationMs('hard_gate')).toBeNull();
  });
});

/**
 * The accept set against the price table (`plans/pricing-ladder.md` §8.2).
 *
 * `TIER_IDS` and `TIERS` are two hand-maintained literals, and during a
 * repricing they deliberately disagree: the accept set is a superset. These
 * bind the relationship that must hold anyway, because the failure mode of a
 * drift is silent -- an id nothing prices, or an ordering that inverts the
 * over-limit check.
 */
describe('TIER_IDS against TIERS', () => {
  it('accepts every priced tier', () => {
    for (const tier of TIERS) expect(TIER_IDS).toContain(tier.id);
  });

  it('has no duplicates', () => {
    expect(new Set(TIER_IDS).size).toBe(TIER_IDS.length);
  });

  it('prices the tiers in TIERS order, and only those', () => {
    expect(PRICED_TIER_IDS).toEqual(TIERS.map((t) => t.id));
    for (const id of PRICED_TIER_IDS) expect(ACCEPT_ONLY_TIER_IDS).not.toContain(id);
  });

  it('partitions the accept set into priced and accept-only', () => {
    expect([...PRICED_TIER_IDS, ...ACCEPT_ONLY_TIER_IDS].sort()).toEqual([...TIER_IDS].sort());
  });

  it('carries exactly the rarity ids as accept-only during this repricing', () => {
    // Phase A accepts the four new ids a release before TIERS prices them.
    // Phase 1 moves them into TIERS and leaves l/xl/xxl here instead; phase 7
    // empties this list. Update it deliberately, one phase at a time.
    expect([...ACCEPT_ONLY_TIER_IDS]).toEqual(['epic', 'legendary', 'mythic', 'exotic']);
  });

  it('isTierId accepts every id and rejects anything else', () => {
    for (const id of TIER_IDS) expect(isTierId(id)).toBe(true);
    for (const bad of ['', 'xxxl', 'Epic', 'free ', null, undefined, 7, {}]) {
      expect(isTierId(bad)).toBe(false);
    }
  });
});

describe('tierRank', () => {
  it('ranks the priced tiers ascending, matching TIERS order', () => {
    const ranks = PRICED_TIER_IDS.map(tierRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('ranks an accept-only tier past every priced one', () => {
    for (const id of ACCEPT_ONLY_TIER_IDS) {
      for (const priced of PRICED_TIER_IDS) {
        expect(tierRank(id)).toBeGreaterThan(tierRank(priced));
      }
    }
  });

  /**
   * The direction matters, not just the magnitude. `compareTiers(required,
   * billed) > 0` means "over limit", and `required` always comes from
   * `tierFor` over `TIERS`, so a billed tier written by a newer build must
   * never read as over limit: under-escalating for one release beats telling a
   * paying customer they have outgrown the plan they just bought.
   */
  it('never reads an accept-only billed tier as over limit', () => {
    for (const billed of ACCEPT_ONLY_TIER_IDS) {
      for (const tier of TIERS) {
        expect(compareTiers(tier.id, billed)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('is the ordering compareTiers uses', () => {
    for (const a of TIER_IDS) {
      for (const b of TIER_IDS) {
        expect(Math.sign(compareTiers(a, b))).toBe(Math.sign(tierRank(a) - tierRank(b)));
      }
    }
  });
});

describe('supporter role keys', () => {
  it('covers every accepted tier except free', () => {
    expect([...SUPPORTER_ROLE_TIER_IDS]).toEqual(TIER_IDS.filter((id) => id !== 'free'));
  });

  it('maps each tier to its env key', () => {
    expect(envKeyForSupporterRole('s')).toBe('SUPPORT_ROLE_S');
    expect(envKeyForSupporterRole('epic')).toBe('SUPPORT_ROLE_EPIC');
    expect(envKeyForSupporterRole('exotic')).toBe('SUPPORT_ROLE_EXOTIC');
    expect(SUPPORTER_ROLE_ENV_KEYS).toHaveLength(SUPPORTER_ROLE_TIER_IDS.length);
    expect(new Set(SUPPORTER_ROLE_ENV_KEYS).size).toBe(SUPPORTER_ROLE_ENV_KEYS.length);
  });
});

/**
 * The two fallbacks an accept-only id reaches, and their DIRECTION.
 *
 * These are the finding an adversarial review of phase A turned up: `tierRank`
 * was given a lenient fallback while `tierById` still collapsed the same ids to
 * `free`, and `tierById` runs first at most call sites, so the lenient rank was
 * unreachable. Both now point the same way. The direction is the whole point,
 * so it is pinned rather than left to the next reader to re-derive.
 */
describe('accept-only fallbacks point the lenient way', () => {
  it('tierById falls back to the largest priced tier, never free', () => {
    const largest = TIERS[TIERS.length - 1]!;
    for (const id of ACCEPT_ONLY_TIER_IDS) {
      expect(tierById(id)).toBe(largest);
      expect(tierById(id).id).not.toBe('free');
      // The old fallback was `free`, whose ceiling of 100 is what made every
      // ceiling test fail for a real guild.
      expect(tierById(id).maxExclusive).toBeGreaterThan(100);
    }
  });

  /**
   * `evaluateGrace` gates reactivation on
   * `sustainedUnder(state, tierById(billedTier).maxExclusive)`. Under the old
   * fallback that ceiling was 100, so a guild of any real size could never
   * leave `grace` -- silently, and forever.
   */
  it('leaves a real guild under the ceiling of an accept-only billed tier', () => {
    for (const id of ACCEPT_ONLY_TIER_IDS) {
      expect(tierById(id).maxExclusive).toBeGreaterThan(300_000);
    }
  });

  it('pricedTierById is the honest form and returns null instead', () => {
    for (const id of ACCEPT_ONLY_TIER_IDS) expect(pricedTierById(id)).toBeNull();
    for (const tier of TIERS) expect(pricedTierById(tier.id)).toBe(tier);
  });

  it('advises only on supporter keys that can badge somebody', () => {
    // The env reader stays wide so a retired tier keeps its badge; the advice
    // string must not send an operator to set a key that does nothing.
    for (const id of ACCEPT_ONLY_TIER_IDS) {
      expect(SUPPORTER_ROLE_ADVICE_KEYS).not.toContain(envKeyForSupporterRole(id));
      expect(SUPPORTER_ROLE_ENV_KEYS).toContain(envKeyForSupporterRole(id));
    }
    expect(SUPPORTER_ROLE_ADVICE_KEYS).toContain('SUPPORT_ROLE_S');
  });
});
