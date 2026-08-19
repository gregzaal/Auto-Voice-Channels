import { describe, expect, it } from 'vitest';
import { hasLeft, mapInheritPerms, planGuild, snowflakeToDate, trialStartFor } from './legacy.js';

const GUILD = '460459401086763010';
const PRIMARY = '605724722902204416';
const SECONDARY = '700000000000000000';

describe('hasLeft', () => {
  /**
   * The filter that sizes the whole migration: 2781 of 4644 files are guilds
   * the bot has left, and importing them would start trial clocks on servers
   * we are not in.
   */
  it('treats every truthy shape the legacy bot wrote as departed', () => {
    expect(hasLeft({ left: true })).toBe(true);
    expect(hasLeft({ left: '2020-07-18 15:36' })).toBe(true);
  });

  it('treats absent, null and false as still installed', () => {
    expect(hasLeft({})).toBe(false);
    expect(hasLeft({ left: null })).toBe(false);
    expect(hasLeft({ left: false })).toBe(false);
  });
});

describe('snowflakeToDate', () => {
  it('recovers a real channel creation time', () => {
    // 605724722902204416 was created in late July 2019.
    const d = snowflakeToDate('605724722902204416');
    expect(d?.getUTCFullYear()).toBe(2019);
  });

  it('rejects things that are not snowflakes', () => {
    expect(snowflakeToDate('abc')).toBeNull();
    expect(snowflakeToDate('')).toBeNull();
    expect(snowflakeToDate('1')).toBeNull();
  });

  /** A corrupt key must not become a channel dated 1970. */
  it('rejects a snowflake that predates Discord', () => {
    expect(snowflakeToDate('00000000000000001')).toBeNull();
  });
});

describe('planGuild', () => {
  it('skips a guild the bot has left, writing nothing', () => {
    const plan = planGuild(GUILD, { left: '2020-07-18 15:36', auto_channels: {} });
    expect(plan.importable).toBe(false);
    expect(plan.skipReason).toMatch(/left/);
    expect(plan.primaries).toEqual([]);
  });

  /**
   * `left` has no false positives and 858 false negatives against the live
   * fleet, so the dump alone cannot say which guilds we are in. Without this
   * filter the importer starts trial clocks on 858 servers it was removed from.
   */
  describe('live guild list', () => {
    it('skips a guild the bot is not actually in, however the dump looks', () => {
      const plan = planGuild(
        GUILD,
        { left: false, enabled: true },
        { liveGuildIds: new Set(['999']) },
      );
      expect(plan.importable).toBe(false);
      expect(plan.skipReason).toMatch(/stale/);
      expect(plan.primaries).toEqual([]);
    });

    it('imports a guild that is on the list', () => {
      const plan = planGuild(
        GUILD,
        { left: false, enabled: true },
        { liveGuildIds: new Set([GUILD]) },
      );
      expect(plan.importable).toBe(true);
    });

    it('still honours left even when the guild is on the list', () => {
      const plan = planGuild(
        GUILD,
        { left: '2020-07-18 15:36' },
        { liveGuildIds: new Set([GUILD]) },
      );
      expect(plan.importable).toBe(false);
      expect(plan.skipReason).toMatch(/left/);
    });

    it('falls back to the left flag alone when no list is given', () => {
      expect(planGuild(GUILD, { left: false }).importable).toBe(true);
    });
  });

  it('maps settings, converting the logging id to text and clamping the level', () => {
    const plan = planGuild(GUILD, {
      enabled: true,
      general: 'General',
      channel_name_template: '## [@@game_name@@]',
      aliases: { 'Counter-Strike 2': 'CS2' },
      custom_nicks: { '123': 'Pix' },
      logging: '605724722902204416',
      log_level: 9,
    });
    expect(plan.settings).toEqual({
      enabled: true,
      general: 'General',
      channel_name_template: '## [@@game_name@@]',
      aliases: { 'Counter-Strike 2': 'CS2' },
      custom_nicks: { '123': 'Pix' },
      logging: '605724722902204416',
      log_level: 3,
    });
  });

  it('omits empty alias and nick maps rather than storing empty objects', () => {
    const plan = planGuild(GUILD, { aliases: {}, custom_nicks: {} });
    expect(plan.settings.aliases).toBeUndefined();
    expect(plan.settings.custom_nicks).toBeUndefined();
  });

  /**
   * The position inversion. Legacy defaults to above, the rewrite defaults to
   * below, and 3380 primaries rely on the absent-means-above default. Getting
   * this wrong moves the spawned channel for most of the install base.
   */
  describe('position', () => {
    it('writes above=true when the key is absent, not the new default', () => {
      const plan = planGuild(GUILD, { auto_channels: { [PRIMARY]: {} } });
      expect(plan.primaries[0]!.template.above).toBe(true);
    });

    it('honours an explicit false', () => {
      const plan = planGuild(GUILD, { auto_channels: { [PRIMARY]: { above: false } } });
      expect(plan.primaries[0]!.template.above).toBe(false);
    });

    it('honours an explicit true', () => {
      const plan = planGuild(GUILD, { auto_channels: { [PRIMARY]: { above: true } } });
      expect(plan.primaries[0]!.template.above).toBe(true);
    });

    /** Never left unset, or the new default silently applies. */
    it('is always written explicitly', () => {
      for (const primary of [{}, { above: true }, { above: false }, { template: 'x' }]) {
        const plan = planGuild(GUILD, { auto_channels: { [PRIMARY]: primary } });
        expect(plan.primaries[0]!.template.above).toBeTypeOf('boolean');
      }
    });
  });

  describe('template', () => {
    it('carries the name and the user limit', () => {
      const plan = planGuild(GUILD, {
        auto_channels: { [PRIMARY]: { template: '@@game_name@@', limit: 5 } },
      });
      expect(plan.primaries[0]!.template.name).toBe('@@game_name@@');
      expect(plan.primaries[0]!.template.limit).toBe(5);
    });

    it('omits a zero or missing limit rather than storing zero', () => {
      const a = planGuild(GUILD, { auto_channels: { [PRIMARY]: { limit: 0 } } });
      const b = planGuild(GUILD, { auto_channels: { [PRIMARY]: {} } });
      expect(a.primaries[0]!.template.limit).toBeUndefined();
      expect(b.primaries[0]!.template.limit).toBeUndefined();
    });

    it('clamps a limit above what Discord accepts', () => {
      const plan = planGuild(GUILD, { auto_channels: { [PRIMARY]: { limit: 500 } } });
      expect(plan.primaries[0]!.template.limit).toBe(99);
    });

    it('omits an empty template so the guild default applies', () => {
      const plan = planGuild(GUILD, { auto_channels: { [PRIMARY]: { template: '' } } });
      expect(plan.primaries[0]!.template.name).toBeUndefined();
    });
  });

  describe('secondaries', () => {
    const withSecondary = (secondary: unknown): ReturnType<typeof planGuild> =>
      planGuild(GUILD, {
        auto_channels: { [PRIMARY]: { secondaries: { [SECONDARY]: secondary } } },
      });

    it('adopts a live channel with its owner and parent', () => {
      const plan = withSecondary({ creator: '291185187105275904' });
      expect(plan.secondaries).toHaveLength(1);
      expect(plan.secondaries[0]).toMatchObject({
        channelId: SECONDARY,
        primaryChannelId: PRIMARY,
        ownerId: '291185187105275904',
        private: false,
      });
    });

    /**
     * createdAt comes from the snowflake, not from now(). The reconciler derives
     * `##` numbering from sibling createdAt order, so anything else renumbers
     * every channel on the first reconcile.
     */
    it('dates the channel from its snowflake', () => {
      const plan = withSecondary({});
      expect(plan.secondaries[0]!.createdAt.getTime()).toBe(snowflakeToDate(SECONDARY)!.getTime());
    });

    it('carries the private flag', () => {
      expect(withSecondary({ priv: true }).secondaries[0]!.private).toBe(true);
    });

    it('adopts the join companion for a private channel', () => {
      const plan = withSecondary({ priv: true, jc: '700000000000000001', creator: 42 });
      expect(plan.joinChannels).toEqual([
        { channelId: '700000000000000001', secondaryChannelId: SECONDARY, creatorId: '42' },
      ]);
    });

    it('collects Gold text channels and roles for Discord-side deletion', () => {
      const plan = withSecondary({ tc: '700000000000000002', tcr: '700000000000000003' });
      expect(plan.orphanedTextChannels).toEqual(['700000000000000002']);
      expect(plan.orphanedRoles).toEqual(['700000000000000003']);
    });

    it('skips a secondary whose key is not a snowflake, and says so', () => {
      const plan = planGuild(GUILD, {
        auto_channels: { [PRIMARY]: { secondaries: { 'not-an-id': {} } } },
      });
      expect(plan.secondaries).toEqual([]);
      expect(plan.warnings.join(' ')).toMatch(/unusable id/);
    });

    it('tolerates a null secondary entry', () => {
      const plan = withSecondary(null);
      expect(plan.secondaries).toHaveLength(1);
      expect(plan.secondaries[0]!.ownerId).toBeNull();
    });
  });

  /**
   * Regression: `logging: false` (two real guilds) made the first draft's schema
   * reject the entire guild, so both were silently counted as departed and would
   * never have been imported. A schema strict enough to reject a field we
   * already know how to ignore is a schema that loses guilds.
   */
  it('imports a guild whose logging is a boolean rather than an id', () => {
    const plan = planGuild(GUILD, { logging: false, enabled: true, left: false });
    expect(plan.importable).toBe(true);
    expect(plan.settings.logging).toBeUndefined();
    expect(plan.settings.enabled).toBe(true);
  });

  it('survives any field being the wrong type', () => {
    const plan = planGuild(GUILD, {
      enabled: 'yes',
      general: 42,
      aliases: { a: 1, b: 'ok' },
      custom_nicks: 'nope',
      log_level: 'two',
      auto_channels: { [PRIMARY]: { template: 99, limit: 'five', above: 'up' } },
    });
    expect(plan.importable).toBe(true);
    expect(plan.settings.enabled).toBeUndefined();
    expect(plan.settings.general).toBeUndefined();
    // Only the usable half of a mixed alias map survives.
    expect(plan.settings.aliases).toEqual({ b: 'ok' });
    expect(plan.settings.custom_nicks).toBeUndefined();
    // 'up' is not false, so it maps to the legacy default of above.
    expect(plan.primaries[0]!.template.above).toBe(true);
    expect(plan.primaries[0]!.template.name).toBeUndefined();
  });

  it('reports which dropped fields a guild actually loses', () => {
    const plan = planGuild(GUILD, { custom_bitrates: { a: 1 }, uniquenames: true, prefix: 'vc/' });
    expect(plan.droppedFields.sort()).toEqual(['custom_bitrates', 'prefix', 'uniquenames']);
  });

  /** Eight years of files written by several bot versions. Never reject one. */
  it('tolerates unknown keys rather than refusing the guild', () => {
    const plan = planGuild(GUILD, { somethingNobodyRemembers: 1, enabled: true });
    expect(plan.importable).toBe(true);
    expect(plan.settings.enabled).toBe(true);
  });

  it('handles a completely empty file', () => {
    const plan = planGuild(GUILD, {});
    expect(plan.importable).toBe(true);
    expect(plan.primaries).toEqual([]);
  });
});

describe('trialStartFor', () => {
  const importedAt = new Date('2026-09-01T00:00:00Z');
  const days = (guildId: string): number =>
    (trialStartFor(guildId, importedAt).getTime() - importedAt.getTime()) / 86_400_000;

  it('always adds at least 10 days and never more than 30', () => {
    for (let i = 0; i < 3000; i++) {
      const d = days(`10000000000000${i}`);
      expect(d).toBeGreaterThanOrEqual(10);
      expect(d).toBeLessThanOrEqual(30);
    }
  });

  /**
   * The importer is idempotent and meant to be re-runnable. A random jitter
   * would reshuffle every guild's billing clock on every run.
   */
  it('is stable for the same guild', () => {
    expect(days(GUILD)).toBe(days(GUILD));
    expect(trialStartFor(GUILD, importedAt).toISOString()).toBe(
      trialStartFor(GUILD, importedAt).toISOString(),
    );
  });

  it('spreads guilds across the window rather than clumping', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i++) buckets.add(days(`20000000000000${i}`));
    // 21 possible values; a bad hash would collapse to a handful.
    expect(buckets.size).toBeGreaterThan(15);
  });

  it('produces whole days, so starts land at the same time of day', () => {
    for (let i = 0; i < 50; i++) expect(Number.isInteger(days(`3000000000000${i}`))).toBe(true);
  });
});

/**
 * 90 guilds in the real dump set this, and it was being dropped by omission
 * rather than by decision: absent from the plan's mapping table *and* from its
 * dropped-fields list. The two systems agree exactly, so there was nothing to
 * decide once anyone looked.
 */
describe('mapInheritPerms', () => {
  it('lowercases the two legacy keywords', () => {
    expect(mapInheritPerms('CATEGORY')).toBe('category');
    expect(mapInheritPerms('PRIMARY')).toBe('primary');
  });

  it('keeps a channel id exactly', () => {
    expect(mapInheritPerms('580996833577271306')).toBe('580996833577271306');
  });

  /**
   * The dump stores these as JSON numbers, and `parseLegacyJson` quotes them
   * before parsing for exactly this reason. A number reaching here has already
   * lost its last digits, so converting it would hand back a channel id that
   * does not exist. The first version of this test proved the point by failing:
   * the literal below is `...300` by the time TypeScript is done with it.
   */
  it('rejects a number rather than returning a corrupted id', () => {
    // Exactly what an unquoted dump value becomes. Written as a parse rather
    // than a literal because eslint's no-loss-of-precision rejects the literal
    // outright, which is the same objection this test exists to make.
    const rounded = (JSON.parse('{"v":580996833577271306}') as { v: number }).v;
    expect(String(rounded)).toBe('580996833577271300');
    expect(mapInheritPerms(rounded)).toBeUndefined();
  });

  /** Unset beats guessed: `primary` is the runtime default anyway. */
  it('drops anything it does not recognise', () => {
    for (const value of [undefined, null, '', 'PARENT', 'yes', true, {}, '12']) {
      expect(mapInheritPerms(value)).toBeUndefined();
    }
  });
});
