import { describe, expect, it } from 'vitest';
import { DEFAULT_FLEET, FLEETS, fleetAdvisoryKey, fleetOrdinal } from './fleets.js';

describe('fleets', () => {
  it('defaults to prod, which is what self-host and every pre-fleet row is', () => {
    expect(DEFAULT_FLEET).toBe('prod');
    expect(FLEETS[0]).toBe('prod');
  });

  /**
   * Ordinals are baked into live advisory-lock keys. Reordering FLEETS would
   * silently repoint a running fleet's locks at another fleet's namespace, which
   * is the one way two fleets could start serializing each other again.
   */
  it('pins the ordinals', () => {
    expect(fleetOrdinal('prod')).toBe(0);
    expect(fleetOrdinal('beta')).toBe(1);
  });
});

describe('fleetAdvisoryKey', () => {
  const IDENTIFY = 0x5a7c_0001;

  it('gives each fleet a distinct key for the same base and slot', () => {
    expect(fleetAdvisoryKey(IDENTIFY, 'prod', 3)).not.toBe(fleetAdvisoryKey(IDENTIFY, 'beta', 3));
  });

  it('gives each slot a distinct key within a fleet', () => {
    expect(fleetAdvisoryKey(IDENTIFY, 'prod', 0)).not.toBe(fleetAdvisoryKey(IDENTIFY, 'prod', 1));
  });

  it('keeps different bases apart', () => {
    expect(fleetAdvisoryKey(0x5a7c_0001, 'prod', 0)).not.toBe(
      fleetAdvisoryKey(0x5a7c_0002, 'prod', 0),
    );
  });

  it('packs as <base:32><fleet:16><slot:16>', () => {
    expect(fleetAdvisoryKey(0x1, 'prod', 0)).toBe(0x0000_0001_0000_0000n);
    expect(fleetAdvisoryKey(0x1, 'beta', 0)).toBe(0x0000_0001_0001_0000n);
    expect(fleetAdvisoryKey(0x1, 'beta', 0xffff)).toBe(0x0000_0001_0001_ffffn);
  });

  /**
   * Postgres advisory-lock keys are SIGNED 64-bit. A key that overflows into the
   * sign bit would either error or, worse, wrap onto another fleet's key.
   */
  it('stays inside signed 64-bit for the real lock bases', () => {
    const max = 2n ** 63n - 1n;
    for (const base of [0x5a7c_0001, 0x5a7c_0002]) {
      for (const fleet of FLEETS) {
        expect(fleetAdvisoryKey(base, fleet, 0xffff)).toBeLessThan(max);
        expect(fleetAdvisoryKey(base, fleet, 0)).toBeGreaterThan(0n);
      }
    }
  });

  it('rejects a slot that would overflow into the fleet bits', () => {
    expect(() => fleetAdvisoryKey(1, 'prod', 0x1_0000)).toThrow(RangeError);
    expect(() => fleetAdvisoryKey(1, 'prod', -1)).toThrow(RangeError);
  });
});
