import { describe, expect, it } from 'vitest';
import {
  ACCEPT_ONLY_TIER_IDS,
  compareTiers,
  headlinePerMonth,
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
    expect(tierFor(10_000).id).toBe('epic');
    expect(tierFor(29_999).id).toBe('epic');
    expect(tierFor(30_000).id).toBe('legendary');
    expect(tierFor(99_999).id).toBe('legendary');
    expect(tierFor(100_000).id).toBe('mythic');
    expect(tierFor(299_999).id).toBe('mythic');
    expect(tierFor(300_000).id).toBe('exotic');
    expect(tierFor(50_000_000).id).toBe('exotic');
  });

  it('clamps negative / non-finite counts to the free tier', () => {
    expect(tierFor(-5).id).toBe('free');
    expect(tierFor(Number.NaN).id).toBe('free');
  });

  it('exposes the rarity ladder prices', () => {
    expect(tierFor(50).pricePerYear).toBe(0);
    expect(tierFor(500).pricePerYear).toBe(18);
    expect(tierFor(5_000).pricePerYear).toBe(30);
    expect(tierFor(20_000).pricePerYear).toBe(90);
    expect(tierFor(50_000).pricePerYear).toBe(180);
    expect(tierFor(200_000).pricePerYear).toBe(390);
    expect(tierFor(500_000).pricePerYear).toBeNull();
  });

  /**
   * Rule 4: the headline is a whole dollar or a half, and where monthly
   * billing is offered the monthly price is a whole dollar. This is the test
   * that makes a price nobody can display fail the build, which is the whole
   * reason the yearly figures are multiples of 6 and 30 rather than round.
   */
  it('every price is round in all three framings', () => {
    for (const tier of TIERS) {
      if (tier.pricePerYear === null || tier.pricePerYear === 0) {
        expect(headlinePerMonth(tier)).toBeNull();
        expect(tier.pricePerMonth).toBeNull();
        continue;
      }
      expect(tier.pricePerYear % 6).toBe(0);
      const headline = headlinePerMonth(tier)!;
      expect(headline * 2).toBe(Math.round(headline * 2));
      if (tier.pricePerMonth !== null) {
        expect(tier.pricePerYear % 30).toBe(0);
        expect(tier.pricePerMonth).toBe(tier.pricePerYear / 10);
        expect(tier.pricePerMonth).toBe(Math.round(tier.pricePerMonth));
      }
    }
  });

  it('offers monthly billing only where twelve charges beat one', () => {
    // Below a yearly price of $28.95 Paddle's fixed 50c per transaction eats
    // the difference, so Uncommon is deliberately yearly-only.
    for (const tier of TIERS) {
      const monthlyOffered = tier.pricePerMonth !== null;
      const clearsTheLine = (tier.pricePerYear ?? 0) > 28.95;
      expect(monthlyOffered).toBe(clearsTheLine);
    }
  });

  it('headlines read as the plan states them', () => {
    expect(headlinePerMonth(tierFor(500))).toBeCloseTo(1.5, 10);
    expect(headlinePerMonth(tierFor(5_000))).toBeCloseTo(2.5, 10);
    expect(headlinePerMonth(tierFor(20_000))).toBeCloseTo(7.5, 10);
    expect(headlinePerMonth(tierFor(50_000))).toBeCloseTo(15, 10);
    expect(headlinePerMonth(tierFor(200_000))).toBeCloseTo(32.5, 10);
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
    expect(compareTiers('legendary', 'm')).toBeGreaterThan(0);
    expect(compareTiers('exotic', 'mythic')).toBeGreaterThan(0);
  });
});

describe('trialPolicyFor', () => {
  it('maps size bands at their boundaries', () => {
    expect(trialPolicyFor(0)).toBe('dormant');
    expect(trialPolicyFor(99)).toBe('dormant');
    expect(trialPolicyFor(100)).toBe('year');
    expect(trialPolicyFor(9_999)).toBe('year');
    expect(trialPolicyFor(10_000)).toBe('short');
    expect(trialPolicyFor(299_999)).toBe('short');
    expect(trialPolicyFor(300_000)).toBe('hard_gate');
  });

  it('trial durations: a year for small/dormant, 30 days for large, none for the gate', () => {
    const day = 86_400_000;
    expect(trialDurationMs('dormant')).toBe(365 * day);
    expect(trialDurationMs('year')).toBe(365 * day);
    expect(trialDurationMs('short')).toBe(30 * day);
    expect(trialDurationMs('hard_gate')).toBeNull();
  });
});

/**
 * The accept set against the price table.
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

  it('has NO accept-only ids, which is the steady state', () => {
    /**
     * Phase A accepted the four rarity ids a release before `TIERS` priced
     * them, phase 1 priced them, and phase 7 (2026-09-08) dropped `l`, `xl` and
     * `xxl` once every fleet was past phase 1. So the accept set and the priced
     * set are the same list again.
     *
     * **Empty is the state to defend, not a milestone reached.** A non-empty
     * accept-only set means a repricing is mid-flight, and that is the only
     * time it should be non-empty: every id in it is one that a read can
     * encounter and no code can price, which is why both fallbacks around it
     * lean lenient. If this assertion starts failing, either a repricing began
     * or somebody widened the accept set without meaning to.
     *
     * Retiring these three was safe because all three write vectors were
     * checked against production first, not reasoned about: zero rows in
     * `guilds`, `subscriptions` or `member_pools` carried them, both live
     * subscriptions are stamped `s` and `m` in Paddle so no renewal resolves
     * one, and zero ACTIVE Paddle prices carry a retired `avc_tier`, so no new
     * checkout can mint one either.
     */
    expect([...ACCEPT_ONLY_TIER_IDS]).toEqual([]);
    expect([...PRICED_TIER_IDS].sort()).toEqual([...TIER_IDS].sort());
  });

  it('isTierId accepts every id and rejects anything else', () => {
    for (const id of TIER_IDS) expect(isTierId(id)).toBe(true);
    for (const bad of ['', 'xxxl', 'Epic', 'free ', null, undefined, 7, {}]) {
      expect(isTierId(bad)).toBe(false);
    }
  });
});

/**
 * Ids this build cannot price, which is what every fallback below is about.
 *
 * **Why it is not just `ACCEPT_ONLY_TIER_IDS`.** That array is empty in the
 * steady state, and phase 7 emptied it, so six tests here started looping zero
 * times and passing while verifying nothing. An adversarial review caught it.
 * They are the pin for a real phase-A defect (`tierRank` lenient while
 * `tierById` still collapsed the same ids to `free`), so going dark between
 * repricings is exactly when they are least likely to be missed and most
 * likely to be needed.
 *
 * The synthetic entry is a genuinely retired id cast past the type. That is not
 * a cheat: from the code's point of view an accept-only id IS a string it can
 * encounter and cannot price, and `tierRank`, `tierById` and `pricedTierById`
 * all key on "not found in `TIERS`", so it exercises the same branch a real one
 * does. Real accept-only ids are included too, so a repricing tests both.
 */
const UNPRICEABLE_IDS: readonly TierId[] = [...ACCEPT_ONLY_TIER_IDS, 'l' as unknown as TierId];

describe('tierRank', () => {
  it('ranks the priced tiers ascending, matching TIERS order', () => {
    const ranks = PRICED_TIER_IDS.map(tierRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('ranks an unpriceable tier past every priced one', () => {
    for (const id of UNPRICEABLE_IDS) {
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
  it('never reads an unpriceable billed tier as over limit', () => {
    for (const billed of UNPRICEABLE_IDS) {
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
    for (const id of UNPRICEABLE_IDS) {
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
  it('leaves a real guild under the ceiling of an unpriceable billed tier', () => {
    for (const id of UNPRICEABLE_IDS) {
      expect(tierById(id).maxExclusive).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('pricedTierById is the honest form and returns null instead', () => {
    for (const id of UNPRICEABLE_IDS) expect(pricedTierById(id)).toBeNull();
    for (const tier of TIERS) expect(pricedTierById(tier.id)).toBe(tier);
  });

  it('advises only on supporter keys that can badge somebody', () => {
    /**
     * The real array here, not {@link UNPRICEABLE_IDS}, because this is the one
     * property retirement genuinely changes rather than leaves intact: while an
     * id is accept-only the env reader stays wide so a customer stamped with it
     * keeps their badge, and retiring the id is precisely what drops its key.
     * A synthetic id would assert the pre-retirement rule forever.
     */
    for (const id of ACCEPT_ONLY_TIER_IDS) {
      expect(SUPPORTER_ROLE_ADVICE_KEYS).not.toContain(envKeyForSupporterRole(id));
      expect(SUPPORTER_ROLE_ENV_KEYS).toContain(envKeyForSupporterRole(id));
    }
    // In the steady state the two lists coincide: every accepted tier can be
    // badged, so there is no key an operator would be sent to set in vain.
    if (ACCEPT_ONLY_TIER_IDS.length === 0) {
      expect([...SUPPORTER_ROLE_ADVICE_KEYS].sort()).toEqual([...SUPPORTER_ROLE_ENV_KEYS].sort());
    }
    expect(SUPPORTER_ROLE_ADVICE_KEYS).toContain('SUPPORT_ROLE_S');
  });
});
