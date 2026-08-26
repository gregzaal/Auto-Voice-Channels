import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql as raw } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { autoChannels, guilds, joinChannels, secondaryChannels } from '../db/schema.js';
import { AutoChannelRepository } from '../repositories/autoChannels.js';
import { GuildRepository } from '../repositories/guilds.js';
import { parseBillingMeta } from '../domain/billing.js';
import { importDump } from './importer.js';
import { snowflakeToDate, trialStartFor } from './legacy.js';
import { TRIAL_YEAR_DAYS } from '../domain/tiers.js';

/**
 * The write path, against a real database.
 *
 * The first real run of this touches 1004 live guilds, so the properties under
 * test are the ones that would be expensive to get wrong: idempotency, that a
 * departed or phantom guild is never written, that adopted channels keep their
 * original creation time, and that a re-run cannot move a billing clock.
 */

const LIVE = '111111111111111111';
const PHANTOM = '222222222222222222';
const DEPARTED = '333333333333333333';
const PRIMARY = '605724722902204416';
const SECONDARY = '700000000000000000';
const COMPANION = '700000000000000001';
const OWNER = '291185187105275904';
const IMPORTED_AT = new Date('2026-09-01T00:00:00Z');

describe('importDump (integration)', () => {
  let pg: PgTestEnv;
  let dir: string;

  beforeAll(async () => {
    pg = await startPostgres();
    dir = mkdtempSync(join(tmpdir(), 'avc-import-'));

    /**
     * Written as raw text, not via `JSON.stringify`.
     *
     * The first version of this fixture used an object literal, and the ids
     * were already rounded by the time `stringify` saw them: TypeScript parses
     * `605724722902204416` as a double. The fixture reproduced the very bug it
     * was meant to prove was fixed. Legacy files are text on disk, so the test
     * has to start from text too.
     */
    writeFileSync(
      join(dir, `${LIVE}.json`),
      `{
        "enabled": true,
        "general": "General",
        "channel_name_template": "## [@@game_name@@]",
        "aliases": { "Counter-Strike 2": "CS2" },
        "logging": 605724722902204416,
        "left": false,
        "auto_channels": {
          "${PRIMARY}": {
            "template": "@@creator@@ room",
            "limit": 5,
            "secondaries": {
              "${SECONDARY}": { "creator": 291185187105275904, "priv": true, "jc": 700000000000000001 }
            }
          }
        }
      }`,
    );
    // Not marked left, but the bot is not in it. 858 real guilds look like this.
    writeFileSync(
      join(dir, `${PHANTOM}.json`),
      JSON.stringify({ enabled: true, left: false, auto_channels: { [PRIMARY]: {} } }),
    );
    writeFileSync(
      join(dir, `${DEPARTED}.json`),
      JSON.stringify({ left: '2020-07-18 15:36', auto_channels: { [PRIMARY]: {} } }),
    );
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const run = (apply: boolean) =>
    importDump({
      db: pg.handle.db,
      fleet: 'prod',
      dir,
      liveGuildIds: new Set([LIVE]),
      apply,
      importedAt: IMPORTED_AT,
    });

  it('writes nothing on a dry run', async () => {
    const summary = await run(false);
    expect(summary.imported).toBe(1);
    expect(summary.skippedNotLive).toBe(1);
    expect(summary.skippedLeft).toBe(1);

    const rows = await pg.handle.db.select().from(guilds);
    expect(rows).toHaveLength(0);
  }, 300_000);

  it('imports the live guild and only the live guild', async () => {
    const summary = await run(true);
    expect(summary.failures).toEqual([]);
    expect(summary.imported).toBe(1);

    const rows = await pg.handle.db.select().from(guilds);
    expect(rows.map((r) => r.guildId)).toEqual([LIVE]);
  }, 300_000);

  it('keeps snowflake ids exact through the whole path', async () => {
    const [guild] = await pg.handle.db.select().from(guilds).where(eq(guilds.guildId, LIVE));
    // Rounded by JSON.parse this would be ...400.
    expect((guild!.settings as Record<string, unknown>).logging).toBe('605724722902204416');

    const [secondary] = await pg.handle.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.channelId, SECONDARY));
    expect(secondary!.ownerId).toBe(OWNER);

    const [companion] = await pg.handle.db
      .select()
      .from(joinChannels)
      .where(eq(joinChannels.channelId, COMPANION));
    expect(companion!.creatorId).toBe(OWNER);
    expect(companion!.secondaryChannelId).toBe(SECONDARY);
  }, 300_000);

  it('writes the primary template, including the position and the limit', async () => {
    const [primary] = await pg.handle.db
      .select()
      .from(autoChannels)
      .where(eq(autoChannels.channelId, PRIMARY));
    const template = primary!.template as Record<string, unknown>;
    expect(template.name).toBe('@@creator@@ room');
    expect(template.limit).toBe(5);
    // Legacy default is above; the rewrite's default is below, so this must be
    // written explicitly or every room moves.
    expect(template.above).toBe(true);
  }, 300_000);

  /**
   * The reconciler derives `##` numbering from sibling createdAt order, so an
   * adopted channel dated "now" would renumber the whole guild on first
   * reconcile.
   */
  it('dates an adopted channel from its snowflake, not the import time', async () => {
    const [secondary] = await pg.handle.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.channelId, SECONDARY));
    expect(secondary!.createdAt.getTime()).toBe(snowflakeToDate(SECONDARY)!.getTime());
    expect(secondary!.createdAt.getTime()).toBeLessThan(IMPORTED_AT.getTime());
  }, 300_000);

  it('carries the private flag onto the adopted channel', async () => {
    const [secondary] = await pg.handle.db
      .select()
      .from(secondaryChannels)
      .where(eq(secondaryChannels.channelId, SECONDARY));
    expect((secondary!.state as Record<string, unknown>).private).toBe(true);
  }, 300_000);

  /** The jitter is the whole point: without it 1004 guilds expire the same day. */
  it('sets a jittered trial expiry rather than one shared date', async () => {
    const repo = new GuildRepository(pg.handle.db);
    const row = await repo.get(LIVE);
    const expected = new Date(
      trialStartFor(LIVE, IMPORTED_AT).getTime() + TRIAL_YEAR_DAYS * 86_400_000,
    );
    expect(row!.authExpiresAt?.getTime()).toBe(expected.getTime());

    // At least 60 days later than an unjittered clock would have been.
    const unjittered = IMPORTED_AT.getTime() + TRIAL_YEAR_DAYS * 86_400_000;
    expect(row!.authExpiresAt!.getTime() - unjittered).toBeGreaterThanOrEqual(60 * 86_400_000);
  }, 300_000);

  /**
   * The property that makes the whole thing safe to run twice, which is the
   * natural response to a partial failure against 1004 guilds.
   */
  describe('idempotency', () => {
    it('re-running changes no counts', async () => {
      const before = await pg.handle.db.select().from(secondaryChannels);
      const summary = await run(true);
      expect(summary.failures).toEqual([]);
      const after = await pg.handle.db.select().from(secondaryChannels);
      expect(after).toHaveLength(before.length);
      expect(await pg.handle.db.select().from(guilds)).toHaveLength(1);
      expect(await pg.handle.db.select().from(autoChannels)).toHaveLength(1);
      expect(await pg.handle.db.select().from(joinChannels)).toHaveLength(1);
    }, 300_000);

    /** A clock that is already ticking must never be moved by a re-run. */
    it('does not move a trial clock that is already set', async () => {
      const repo = new GuildRepository(pg.handle.db);
      const before = (await repo.get(LIVE))!.authExpiresAt;
      await importDump({
        db: pg.handle.db,
        fleet: 'prod',
        dir,
        liveGuildIds: new Set([LIVE]),
        apply: true,
        // A later import moment would compute a different expiry.
        importedAt: new Date('2026-12-25T00:00:00Z'),
      });
      expect((await repo.get(LIVE))!.authExpiresAt?.getTime()).toBe(before?.getTime());
    }, 300_000);

    /** An adopted channel's creation time must survive a re-run too. */
    it('does not reset an adopted channel to the re-run time', async () => {
      const [secondary] = await pg.handle.db
        .select()
        .from(secondaryChannels)
        .where(eq(secondaryChannels.channelId, SECONDARY));
      expect(secondary!.createdAt.getTime()).toBe(snowflakeToDate(SECONDARY)!.getTime());
    }, 300_000);
  });

  it('reports what each guild loses, rather than dropping it silently', async () => {
    const summary = await run(false);
    expect(summary.files).toBe(3);
    expect(summary.unreadable).toEqual([]);
    expect(summary.orphanedTextChannels).toEqual([]);
  }, 300_000);
  /**
   * The welcome-suppression stamp (`plans/fleets.md` §7.1, owner decision
   * 2026-08-19).
   *
   * Onboarding's welcome fires when a guild is on `trial`, has no
   * `onboardedAt`, and its row is under a week old. An imported guild is all
   * three by construction, because the importer creates the row, so without
   * this every migrated server would be told its free trial had just started
   * the first time the bot connected.
   *
   * The consequence is asserted on the bot side, where `decideOnboarding`
   * lives (`onboarding.unit.test.ts`); core cannot import from bot. What is
   * checked here is the only half core owns: the stamp is written.
   */
  it('marks an imported guild as already onboarded, so it gets no welcome', async () => {
    const repo = new GuildRepository(pg.handle.db);
    const row = await repo.getOrThrow(LIVE);
    expect(parseBillingMeta(row.metadata).onboardedAt).toBeDefined();
  }, 300_000);

  /**
   * Stamped at the import moment, not at wall-clock now.
   *
   * Only matters for readability of the row, but a stamp dated after the run
   * that wrote it is the kind of thing that makes a later investigator doubt
   * the whole table.
   */
  it('stamps the onboarding flag with the import moment', async () => {
    const repo = new GuildRepository(pg.handle.db);
    const row = await repo.getOrThrow(LIVE);
    const stamped = parseBillingMeta(row.metadata).onboardedAt;
    expect(stamped).toBe(IMPORTED_AT.toISOString());
  }, 300_000);

  /** A re-run must not disturb a stamp that is already there. */
  it('leaves an existing onboarding stamp alone on a re-run', async () => {
    const repo = new GuildRepository(pg.handle.db);
    const before = parseBillingMeta((await repo.getOrThrow(LIVE)).metadata).onboardedAt;
    await run(true);
    const after = parseBillingMeta((await repo.getOrThrow(LIVE)).metadata).onboardedAt;
    expect(after).toBe(before);
  }, 300_000);

  /**
   * The first-writer-wins merge (`plans/migration.md` §3.6).
   *
   * `guilds.settings` and `guilds.auth_status` are shared columns, and this
   * importer runs once per bot identity: beta 2026-08-19, prod at the cutover,
   * Gold days later. Every case here is a guild that appears in more than one
   * dump, and every one of them was silent before the merge existed - the write
   * succeeded, the row validated, and the guild was reconfigured or re-entitled
   * by whichever dump ran last.
   *
   * Its own dump directory, so the counts the tests above assert on stay
   * describing the three-file fixture they were written for.
   */
  describe('first-writer-wins merge', () => {
    const M_TRIAL = '444444444444444444';
    const M_ACTIVE = '555555555555555555';
    const M_BLOCKED = '666666666666666666';
    const M_FRESH = '777777777777777777';
    const all = new Set([M_TRIAL, M_ACTIVE, M_BLOCKED, M_FRESH]);
    let mergeDir: string;

    const runMerge = (
      apply: boolean,
      extra: { onlyGuildIds?: ReadonlySet<string> } = {},
    ): ReturnType<typeof importDump> =>
      importDump({
        db: pg.handle.db,
        fleet: 'prod',
        dir: mergeDir,
        liveGuildIds: all,
        apply,
        inspectExisting: true,
        importedAt: IMPORTED_AT,
        ...extra,
      });

    beforeAll(async () => {
      mergeDir = mkdtempSync(join(tmpdir(), 'avc-import-merge-'));
      for (const id of all) {
        writeFileSync(
          join(mergeDir, `${id}.json`),
          `{
            "enabled": true,
            "general": "From the dump",
            "channel_name_template": "dump template",
            "aliases": { "apex": "Apex Legends" },
            "left": false,
            "auto_channels": {}
          }`,
        );
      }

      // Three guilds another fleet's dump already landed. M_FRESH is left
      // absent, which is what the ~4000 guilds only prod has look like.
      const repo = new GuildRepository(pg.handle.db);
      await repo.updateSettings(M_TRIAL, {
        general: 'Already here',
        aliases: { valorant: 'Valorant' },
      });
      await repo.transitionAuth({
        guildId: M_TRIAL,
        toStatus: 'trial',
        expiresAt: new Date('2027-06-01T00:00:00Z'),
      });
      await repo.transitionAuth({ guildId: M_ACTIVE, toStatus: 'active' });
      await repo.transitionAuth({ guildId: M_BLOCKED, toStatus: 'blocked', reason: 'abuse' });
    }, 300_000);

    it('reports the merge on a dry run without writing anything', async () => {
      const summary = await runMerge(false);
      expect(summary.merge.existed).toBe(3);
      expect(summary.merge.keptStatus).toEqual({ active: 1, blocked: 1 });
      expect(summary.merge.keptSettingKeys.general).toBe(1);

      const repo = new GuildRepository(pg.handle.db);
      expect(await repo.get(M_FRESH)).toBeUndefined();
    }, 300_000);

    /**
     * The one that costs money. `expiresAtIfNull` guards the date, not the
     * status, so before this guard a paying customer in prod's dump was
     * downgraded to `trial` by the import, with a tidy audit row saying so.
     */
    it('never downgrades a paying guild to trial', async () => {
      await runMerge(true);
      const repo = new GuildRepository(pg.handle.db);
      expect((await repo.get(M_ACTIVE))!.authStatus).toBe('active');
    }, 300_000);

    /** The per-guild kill-switch is not something an import gets to turn off. */
    it('never un-blocks a blocked guild', async () => {
      const repo = new GuildRepository(pg.handle.db);
      expect((await repo.get(M_BLOCKED))!.authStatus).toBe('blocked');
    }, 300_000);

    it('leaves a clock alone for a guild it does not transition', async () => {
      const repo = new GuildRepository(pg.handle.db);
      // Set by the pre-seed above, and not by any jitter this run computes.
      expect((await repo.get(M_TRIAL))!.authExpiresAt?.toISOString()).toBe(
        '2027-06-01T00:00:00.000Z',
      );
    }, 300_000);

    it('keeps a setting the guild already had and fills in the ones it did not', async () => {
      const repo = new GuildRepository(pg.handle.db);
      const settings = (await repo.get(M_TRIAL))!.settings;
      expect(settings.general).toBe('Already here');
      expect(settings.channel_name_template).toBe('dump template');
    }, 300_000);

    /**
     * `updateSettings` merges only at the top level, so a scalar-style write
     * would replace the whole alias map and silently lose whichever dump got
     * here second. Both are real configuration a real admin typed.
     */
    it('unions the alias maps rather than replacing one with the other', async () => {
      const repo = new GuildRepository(pg.handle.db);
      expect((await repo.get(M_TRIAL))!.settings.aliases).toEqual({
        valorant: 'Valorant',
        apex: 'Apex Legends',
      });
    }, 300_000);

    it('imports a guild no other dump has reached, normally', async () => {
      const repo = new GuildRepository(pg.handle.db);
      const row = await repo.get(M_FRESH);
      expect(row!.authStatus).toBe('trial');
      expect(row!.settings.general).toBe('From the dump');
      // The full jittered clock, since nothing was here to protect.
      expect(row!.authExpiresAt?.getTime()).toBe(
        trialStartFor(M_FRESH, IMPORTED_AT).getTime() + TRIAL_YEAR_DAYS * 86_400_000,
      );
    }, 300_000);

    /**
     * The delta pass (§6 step 3). The bulk import runs for as long as it takes
     * while the old bot is still serving; only the guilds whose config moved in
     * that window are re-imported during the dark minutes.
     */
    it('processes only the named guilds when given a subset', async () => {
      const summary = await runMerge(false, { onlyGuildIds: new Set([M_TRIAL]) });
      expect(summary.imported).toBe(1);
      expect(summary.skippedNotSelected).toBe(3);
      expect(summary.merge.existed).toBe(1);
    }, 300_000);
  });

  /**
   * The delta pass (`plans/migration.md` §6 step 3).
   *
   * §6 moved the bulk import ahead of the freeze, which makes the bulk pass its
   * own first writer: gap-filling then declines to apply exactly the settings the
   * delta pass exists for, while the per-primary templates DO update (same fleet,
   * wholesale upsert), leaving two halves of one guild's config disagreeing.
   */
  describe('the delta pass', () => {
    const D_GUILD = '888888888888888888';
    const D_PRIMARY = '888000000000000001';
    let deltaDir: string;

    const write = (general: string, template: string): void =>
      writeFileSync(
        join(deltaDir, `${D_GUILD}.json`),
        `{
          "general": "${general}",
          "left": false,
          "auto_channels": { "${D_PRIMARY}": { "template": "${template}" } }
        }`,
      );

    const runDelta = (extra: Record<string, unknown> = {}): ReturnType<typeof importDump> =>
      importDump({
        db: pg.handle.db,
        fleet: 'prod',
        dir: deltaDir,
        liveGuildIds: new Set([D_GUILD]),
        apply: true,
        importedAt: IMPORTED_AT,
        ...extra,
      });

    beforeAll(() => {
      deltaDir = mkdtempSync(join(tmpdir(), 'avc-import-delta-'));
    }, 300_000);

    it('cannot apply a changed setting without being told to, and that is the trap', async () => {
      write('bulk', 'bulk template');
      await runDelta();
      write('delta', 'delta template');
      await runDelta({ onlyGuildIds: new Set([D_GUILD]) });

      const repo = new GuildRepository(pg.handle.db);
      const [primary] = await pg.handle.db
        .select()
        .from(autoChannels)
        .where(eq(autoChannels.channelId, D_PRIMARY));

      // The template moved (same fleet, wholesale upsert) and the setting did not.
      expect((primary!.template as Record<string, unknown>).name).toBe('delta template');
      expect((await repo.get(D_GUILD))!.settings.general).toBe('bulk');
    }, 300_000);

    it('applies it with overwriteSettings, which is what the delta pass passes', async () => {
      await runDelta({ onlyGuildIds: new Set([D_GUILD]), overwriteSettings: true });
      const repo = new GuildRepository(pg.handle.db);
      expect((await repo.get(D_GUILD))!.settings.general).toBe('delta');
    }, 300_000);

    /**
     * Authoritative about configuration is not authoritative about money, and
     * the flag must not become a way to reach the status guard.
     */
    it('still refuses to reset a paying guild, even with overwriteSettings', async () => {
      const repo = new GuildRepository(pg.handle.db);
      await repo.transitionAuth({ guildId: D_GUILD, toStatus: 'active' });
      await runDelta({ onlyGuildIds: new Set([D_GUILD]), overwriteSettings: true });
      expect((await repo.get(D_GUILD))!.authStatus).toBe('active');
    }, 300_000);

    /** Whole-dump overwrite would discard whatever the other fleets are serving. */
    it('refuses overwriteSettings without a named subset', async () => {
      await expect(runDelta({ overwriteSettings: true })).rejects.toThrow(/requires onlyGuildIds/);
    }, 300_000);
  });

  /**
   * The live-list shortfall guard.
   *
   * `GET /users/@me/guilds` returns short pages MID-STREAM, so the obvious
   * "paginate until a short page" loop stops early. At the production cutover on
   * 2026-08-26 it reported 4,999 against a real 5,556 and 557 guilds were
   * silently skipped: the bot was in them, so the runtime gave them rows and the
   * billing sampler picked them up, and the only visible symptom was that they
   * had no creator channels, which looks exactly like never having set one up.
   *
   * The gateway knows the install base. This asserts the importer says so.
   */
  describe('live list vs what the gateway is in', () => {
    const L_LISTED = '121212121212121212';
    const L_UNLISTED = '131313131313131313';
    let listDir: string;

    beforeAll(async () => {
      listDir = mkdtempSync(join(tmpdir(), 'avc-import-list-'));
      for (const id of [L_LISTED, L_UNLISTED]) {
        writeFileSync(
          join(listDir, `${id}.json`),
          `{ "general": "General", "left": false, "auto_channels": {} }`,
        );
      }
      // The fleet's gateway reports being in BOTH.
      await pg.handle.db.execute(
        raw`insert into guild_fleet_presence (guild_id, fleet) values
              (${L_LISTED}, 'prod'), (${L_UNLISTED}, 'prod')
            on conflict (guild_id, fleet) do update set removed_at = null`,
      );
    }, 300_000);

    it('reports a guild it is in that the live list omits', async () => {
      const summary = await importDump({
        db: pg.handle.db,
        fleet: 'prod',
        dir: listDir,
        // Deliberately short, the way a stop-at-the-first-short-page loop is.
        liveGuildIds: new Set([L_LISTED]),
        apply: false,
        inspectExisting: true,
        importedAt: IMPORTED_AT,
      });
      expect(summary.presentButNotListed).toContain(L_UNLISTED);
      expect(summary.presentButNotListed).not.toContain(L_LISTED);
    }, 300_000);

    /**
     * A `--only-guilds` subset omits nearly the whole base on purpose, so the
     * same check there would cry wolf on every delta pass.
     */
    it('stays quiet for a deliberate subset run', async () => {
      const summary = await importDump({
        db: pg.handle.db,
        fleet: 'prod',
        dir: listDir,
        liveGuildIds: new Set([L_LISTED, L_UNLISTED]),
        onlyGuildIds: new Set([L_LISTED]),
        apply: false,
        inspectExisting: true,
        importedAt: IMPORTED_AT,
      });
      expect(summary.presentButNotListed).toEqual([]);
    }, 300_000);
  });

  /**
   * Channel ids another fleet already owns (`plans/migration.md` §3.6).
   *
   * `channel_id` is the SOLE primary key on all four channel tables and `fleet`
   * is an ordinary column, so two dumps naming one channel collide rather than
   * getting a row each, and the repositories' cross-fleet guards throw. Landing
   * that throw mid-guild left the guild half imported -- settings written, no
   * trial clock, no onboarded stamp -- and a dry run could not see it coming.
   */
  describe('channels owned by another fleet', () => {
    const F_GUILD = '999999999999999999';
    const F_PRIMARY = '999000000000000001';
    let foreignDir: string;

    const runForeign = (apply: boolean): ReturnType<typeof importDump> =>
      importDump({
        db: pg.handle.db,
        fleet: 'prod',
        dir: foreignDir,
        liveGuildIds: new Set([F_GUILD]),
        apply,
        inspectExisting: true,
        importedAt: IMPORTED_AT,
      });

    beforeAll(async () => {
      foreignDir = mkdtempSync(join(tmpdir(), 'avc-import-foreign-'));
      writeFileSync(
        join(foreignDir, `${F_GUILD}.json`),
        `{
          "general": "General",
          "left": false,
          "auto_channels": { "${F_PRIMARY}": { "template": "prod wants this" } }
        }`,
      );
      // The same channel, already a creator channel on the beta fleet.
      await new AutoChannelRepository(pg.handle.db, 'beta').upsert(F_GUILD, F_PRIMARY, {
        name: 'beta owns this',
      });
    }, 300_000);

    it('reports the collision on a dry run, before anything is written', async () => {
      const summary = await runForeign(false);
      expect(summary.foreignFleetChannels).toEqual([
        { channelId: F_PRIMARY, fleet: 'beta', guildId: F_GUILD },
      ]);
    }, 300_000);

    /**
     * The whole point of catching it: the guild imports completely apart from the
     * one row that cannot be shared, instead of throwing between the settings
     * write and the trial clock.
     */
    it('skips the row and still imports the rest of the guild', async () => {
      const summary = await runForeign(true);
      expect(summary.failures).toEqual([]);

      const repo = new GuildRepository(pg.handle.db);
      const row = await repo.get(F_GUILD);
      expect(row!.settings.general).toBe('General');
      expect(row!.authExpiresAt).not.toBeNull();
      expect(parseBillingMeta(row!.metadata).onboardedAt).toBeDefined();

      // And beta's row is untouched, not rewritten to prod's template.
      const [primary] = await pg.handle.db
        .select()
        .from(autoChannels)
        .where(eq(autoChannels.channelId, F_PRIMARY));
      expect(primary!.fleet).toBe('beta');
      expect((primary!.template as Record<string, unknown>).name).toBe('beta owns this');
    }, 300_000);
  });
});
