import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { autoChannels, guilds, joinChannels, secondaryChannels } from '../db/schema.js';
import { GuildRepository } from '../repositories/guilds.js';
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

    // At least 10 days later than an unjittered clock would have been.
    const unjittered = IMPORTED_AT.getTime() + TRIAL_YEAR_DAYS * 86_400_000;
    expect(row!.authExpiresAt!.getTime() - unjittered).toBeGreaterThanOrEqual(10 * 86_400_000);
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
});
