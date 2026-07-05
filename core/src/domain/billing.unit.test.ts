import { describe, expect, it } from 'vitest';
import {
  isCountDiscrepant,
  parseBillingMeta,
  sanitizeMemberCountSample,
  utcDayKey,
} from './billing.js';

describe('parseBillingMeta', () => {
  it('returns defaults for missing/corrupt metadata', () => {
    expect(parseBillingMeta({})).toEqual({ samples: [], notifications: {} });
    expect(parseBillingMeta({ billing: 'garbage' })).toEqual({ samples: [], notifications: {} });
    expect(parseBillingMeta({ billing: { samples: 'nope', notifications: 3 } })).toEqual({
      samples: [],
      notifications: {},
    });
  });

  it('parses well-formed billing metadata', () => {
    const meta = parseBillingMeta({
      billing: {
        samples: [{ day: '2026-07-01', count: 150 }],
        notifications: { grace_nudge: '2026-07-01T00:00:00.000Z' },
        onboardedAt: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(meta.samples).toHaveLength(1);
    expect(meta.notifications['grace_nudge']).toBe('2026-07-01T00:00:00.000Z');
    expect(meta.onboardedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('sanitizeMemberCountSample (§12 clamps)', () => {
  const day = '2026-07-04';

  it('accepts the first sample ever', () => {
    expect(sanitizeMemberCountSample(null, 5, day)).toMatchObject({ accept: true });
    expect(sanitizeMemberCountSample(null, 0, day)).toMatchObject({ accept: true });
  });

  it('accepts small absolute moves regardless of percentage', () => {
    // 5 → 12 is +140% but only 7 members — tiny guilds swing wildly.
    expect(sanitizeMemberCountSample(5, 12, day)).toMatchObject({ accept: true });
    expect(sanitizeMemberCountSample(120, 80, day)).toMatchObject({ accept: true });
  });

  it('clamps a lone drop to ~0', () => {
    const res = sanitizeMemberCountSample(5_000, 0, day);
    expect(res.accept).toBe(false);
    expect(res.clamped).toBe(true);
    expect(res.pendingAnomaly).toEqual({ day, count: 0 });
  });

  it('clamps a lone >50% single-day spike', () => {
    const res = sanitizeMemberCountSample(1_000, 2_000, day);
    expect(res.accept).toBe(false);
    expect(res.pendingAnomaly).toEqual({ day, count: 2_000 });
  });

  it('accepts a within-50% move', () => {
    expect(sanitizeMemberCountSample(1_000, 1_400, day)).toMatchObject({ accept: true });
    expect(sanitizeMemberCountSample(1_000, 600, day)).toMatchObject({ accept: true });
  });

  it('a next-day repeat confirms a clamped anomaly', () => {
    const first = sanitizeMemberCountSample(1_000, 2_100, '2026-07-04');
    expect(first.accept).toBe(false);
    const second = sanitizeMemberCountSample(1_000, 2_050, '2026-07-05', first.pendingAnomaly);
    expect(second.accept).toBe(true);
  });

  it('a same-day retry does NOT confirm the anomaly', () => {
    const first = sanitizeMemberCountSample(1_000, 2_100, day);
    const retry = sanitizeMemberCountSample(1_000, 2_100, day, first.pendingAnomaly);
    expect(retry.accept).toBe(false);
  });

  it('a disagreeing follow-up stays clamped (new pending value)', () => {
    const first = sanitizeMemberCountSample(10_000, 0, '2026-07-04');
    const second = sanitizeMemberCountSample(10_000, 25_000, '2026-07-05', first.pendingAnomaly);
    expect(second.accept).toBe(false);
    expect(second.pendingAnomaly).toEqual({ day: '2026-07-05', count: 25_000 });
  });
});

describe('isCountDiscrepant (§5 authoritative-read threshold)', () => {
  it('uses max(50, 5%) of the cached count', () => {
    expect(isCountDiscrepant(100, 149)).toBe(false); // within 50
    expect(isCountDiscrepant(100, 151)).toBe(true);
    expect(isCountDiscrepant(10_000, 10_400)).toBe(false); // within 5%
    expect(isCountDiscrepant(10_000, 10_501)).toBe(true);
  });
});

describe('utcDayKey', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(utcDayKey(new Date('2026-07-04T23:59:59.000Z'))).toBe('2026-07-04');
    expect(utcDayKey(new Date('2026-07-04T00:00:00.000Z'))).toBe('2026-07-04');
  });
});
