import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { AiUsageRepository, utcMonthKey } from './aiUsage.js';

const GUILD = 'g-1';
const MONTH = '2026-07';

describe('AiUsageRepository (integration)', () => {
  let env: PgTestEnv;
  let usage: AiUsageRepository;

  beforeAll(async () => {
    env = await startPostgres();
    usage = new AiUsageRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(schema.aiUsage);
  });

  it('derives the month key from a UTC calendar month', () => {
    expect(utcMonthKey(new Date('2026-07-26T23:59:59Z'))).toBe('2026-07');
    expect(utcMonthKey(new Date('2026-08-01T00:00:00Z'))).toBe('2026-08');
  });

  it('counts builds up to the cap and then refuses', async () => {
    const first = await usage.reserveBuild(GUILD, MONTH, 3);
    expect(first).toEqual({ allowed: true, used: 1, limit: 3 });
    expect((await usage.reserveBuild(GUILD, MONTH, 3)).used).toBe(2);
    expect((await usage.reserveBuild(GUILD, MONTH, 3)).used).toBe(3);

    const over = await usage.reserveBuild(GUILD, MONTH, 3);
    expect(over).toEqual({ allowed: false, used: 3, limit: 3 });
    // A refused reservation must not have incremented anything.
    expect((await usage.guildUsage(GUILD, MONTH)).builds).toBe(3);
  });

  /**
   * The reservation is a single compare-and-swap statement precisely so this
   * holds. A read-then-write would let concurrent interactions in one guild
   * both observe "under the cap" and both spend.
   */
  it('never lets concurrent reservations exceed the cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => usage.reserveBuild(GUILD, MONTH, 5)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(new Set(results.filter((r) => r.allowed).map((r) => r.used))).toEqual(
      new Set([1, 2, 3, 4, 5]),
    );
    expect((await usage.guildUsage(GUILD, MONTH)).builds).toBe(5);
  });

  it('treats a non-positive cap as unlimited but still counts', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await usage.reserveBuild(GUILD, MONTH, 0)).allowed).toBe(true);
    }
    expect((await usage.guildUsage(GUILD, MONTH)).builds).toBe(4);
  });

  it('refunds a build and records why, without going negative', async () => {
    await usage.reserveBuild(GUILD, MONTH, 10);
    await usage.refundBuild(GUILD, MONTH);
    expect(await usage.guildUsage(GUILD, MONTH)).toMatchObject({ builds: 0, refunds: 1 });

    // A stray refund must not push the counter below zero.
    await usage.refundBuild(GUILD, MONTH);
    expect((await usage.guildUsage(GUILD, MONTH)).builds).toBe(0);
  });

  // The calendar-month key IS the reset: nothing has to run on the 1st.
  it('starts a fresh allowance in a new month', async () => {
    for (let i = 0; i < 3; i++) await usage.reserveBuild(GUILD, MONTH, 3);
    expect((await usage.reserveBuild(GUILD, MONTH, 3)).allowed).toBe(false);

    const next = await usage.reserveBuild(GUILD, '2026-08', 3);
    expect(next).toEqual({ allowed: true, used: 1, limit: 3 });
    // The old month is untouched history.
    expect((await usage.guildUsage(GUILD, MONTH)).builds).toBe(3);
  });

  it('accumulates tokens, including for a guild that has not reserved yet', async () => {
    await usage.recordTokens(GUILD, MONTH, 3_500, 60);
    await usage.recordTokens(GUILD, MONTH, 3_400, 40);
    expect(await usage.guildUsage(GUILD, MONTH)).toMatchObject({
      promptTokens: 6_900,
      completionTokens: 100,
    });
    // A zero-usage report (some providers omit it) is a no-op, not a write.
    await usage.recordTokens('g-2', MONTH, 0, 0);
    expect((await usage.guildUsage('g-2', MONTH)).promptTokens).toBe(0);
  });

  it('totals the fleet for a month, which is what the spend ceiling reads', async () => {
    await usage.reserveBuild('g-1', MONTH, 10);
    await usage.recordTokens('g-1', MONTH, 3_500, 60);
    await usage.reserveBuild('g-2', MONTH, 10);
    await usage.recordTokens('g-2', MONTH, 3_500, 40);
    // A different month must not leak into the total.
    await usage.reserveBuild('g-3', '2026-06', 10);
    await usage.recordTokens('g-3', '2026-06', 9_999, 999);

    expect(await usage.monthTotals(MONTH)).toEqual({
      builds: 2,
      refunds: 0,
      promptTokens: 7_000,
      completionTokens: 100,
    });
    expect(await usage.monthTotals('2026-09')).toEqual({
      builds: 0,
      refunds: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
  });
});
