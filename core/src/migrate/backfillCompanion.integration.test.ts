import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { autoChannels, guilds } from '../db/schema.js';
import { AutoChannelRepository } from '../repositories/autoChannels.js';
import { GuildRepository } from '../repositories/guilds.js';
import { backfillCompanionChannels } from './backfillCompanion.js';

/**
 * The backfill, against a real database.
 *
 * The properties under test are the ones that would be expensive to get wrong
 * on 15,616 live creator-channel rows: that it merges rather than replaces a
 * template, that it never creates a row, that it gap-fills settings instead of
 * overwriting them, that a second run is a no-op, and that it stays inside its
 * own fleet.
 */

const ON = '111111111111111111';
const OFF = '222222222222222222';
const GONE = '333333333333333333';
const OTHER_FLEET = '444444444444444444';
/** One guild, a creator channel on prod AND one on beta. */
const BOTH = '555555555555555555';

// A channel id is the primary key and globally unique, so every guild here
// needs its own: two fixtures sharing one id is a cross-guild conflict, not a
// second row.
const LEGACY_PRIMARY = '605724722902204416';
const NEW_PRIMARY = '605724722902204417';
const OTHER_FLEET_PRIMARY = '605724722902204418';
const OFF_PRIMARY = '605724722902204419';
const GONE_PRIMARY = '605724722902204420';
const FALSE_PRIMARY = '605724722902204421';
const BOTH_PROD_PRIMARY = '605724722902204422';
const BOTH_BETA_PRIMARY = '605724722902204423';
const ROLE = '700000000000000009';

/** The legacy file for a guild that had the feature on, written as text. */
const dumpFor = (opts: { primaries: string[]; on: boolean; name?: string; stct?: string }) => `{
  "enabled": true,
  "left": false,
  ${opts.on ? '"text_channels": 1,' : ''}
  ${opts.name ? `"text_channel_name": "${opts.name}",` : ''}
  ${opts.stct ? `"stct": ${opts.stct},` : ''}
  "auto_channels": {
    ${opts.primaries.map((id) => `"${id}": { "template": "@@creator@@ room" }`).join(',\n    ')}
  }
}`;

describe('backfillCompanionChannels (integration)', () => {
  let pg: PgTestEnv;
  let dir: string;

  beforeAll(async () => {
    pg = await startPostgres();
    dir = mkdtempSync(join(tmpdir(), 'avc-companion-backfill-'));

    // `text_channels: 1` rather than `true` on purpose: eight years of
    // hand-edited files store the boolean three ways, and a strict `=== true`
    // would silently restore nothing.
    writeFileSync(
      join(dir, `${ON}.json`),
      dumpFor({
        primaries: [LEGACY_PRIMARY, FALSE_PRIMARY],
        on: true,
        name: 'vc chat',
        stct: ROLE,
      }),
    );
    writeFileSync(join(dir, `${OFF}.json`), dumpFor({ primaries: [OFF_PRIMARY], on: false }));
    writeFileSync(join(dir, `${GONE}.json`), dumpFor({ primaries: [GONE_PRIMARY], on: true }));
    writeFileSync(
      join(dir, `${OTHER_FLEET}.json`),
      dumpFor({ primaries: [OTHER_FLEET_PRIMARY], on: true }),
    );
    // Named on BOTH fleets in one file. The fleet predicate inside
    // `enableTextChannel` is the only thing standing between this run and beta's
    // row: the guild id and the channel id both match.
    writeFileSync(
      join(dir, `${BOTH}.json`),
      dumpFor({ primaries: [BOTH_PROD_PRIMARY, BOTH_BETA_PRIMARY], on: true }),
    );

    const prodChannels = new AutoChannelRepository(pg.handle.db, 'prod');
    const betaChannels = new AutoChannelRepository(pg.handle.db, 'beta');
    const guildRepo = new GuildRepository(pg.handle.db);

    // The legacy creator channel, plus one the admin made afterwards and a
    // template edit they made since the import. Neither may be disturbed.
    await prodChannels.upsert(ON, LEGACY_PRIMARY, { name: 'edited since the import', limit: 7 });
    await prodChannels.upsert(ON, NEW_PRIMARY, { name: 'made after migrating' });
    await prodChannels.upsert(OFF, OFF_PRIMARY, {});
    // An explicit `false`, which only `/import` can store: a recorded "off"
    // decision rather than an absent field, and the backfill must leave it alone.
    await prodChannels.upsert(ON, FALSE_PRIMARY, { textChannel: false });
    // Served by another fleet entirely. `GONE` gets no row at all.
    await betaChannels.upsert(OTHER_FLEET, OTHER_FLEET_PRIMARY, {});
    await prodChannels.upsert(BOTH, BOTH_PROD_PRIMARY, {});
    await betaChannels.upsert(BOTH, BOTH_BETA_PRIMARY, {});
    await guildRepo.ensure(ON);
  }, 300_000);

  afterAll(async () => {
    await pg?.stop();
  });

  const run = (apply: boolean, allCreatorChannels = false) =>
    backfillCompanionChannels({
      db: pg.handle.db,
      fleet: 'prod',
      dir,
      apply,
      ...(allCreatorChannels ? { allCreatorChannels } : {}),
    });

  it('writes nothing on a dry run but reports what it would do', async () => {
    const summary = await run(false);
    expect(summary.candidates).toBe(4); // ON, GONE, OTHER_FLEET, BOTH
    expect(summary.matched).toBe(2); // ON and BOTH have prod rows
    expect(summary.unmatched).toBe(2); // GONE, OTHER_FLEET
    // ON's legacy primary and BOTH's prod one. NOT ON's stored `false`, and
    // NOT beta's row for the same guild.
    expect(summary.channels).toBe(2);
    expect(summary.failures).toEqual([]);

    const [row] = await pg.handle.db
      .select()
      .from(autoChannels)
      .where(eq(autoChannels.channelId, LEGACY_PRIMARY));
    expect((row!.template as Record<string, unknown>).textChannel).toBeUndefined();
  }, 300_000);

  it('merges the flag in without disturbing the rest of the template', async () => {
    const summary = await run(true);
    expect(summary.failures).toEqual([]);
    expect(summary.channels).toBe(2);

    const rows = new AutoChannelRepository(pg.handle.db, 'prod');
    const legacy = await rows.get(LEGACY_PRIMARY);
    expect(legacy!.template).toMatchObject({
      textChannel: true,
      // The admin's own edits, still there. A re-run of `migrate:import` would
      // have replaced both with the dump's values.
      name: 'edited since the import',
      limit: 7,
    });
  }, 300_000);

  it('leaves a creator channel made after the import alone', async () => {
    const rows = new AutoChannelRepository(pg.handle.db, 'prod');
    const made = await rows.get(NEW_PRIMARY);
    expect(made!.template.textChannel).toBeUndefined();
  }, 300_000);

  it('fills the two settings and reads the legacy truthiness loosely', async () => {
    const [guild] = await pg.handle.db.select().from(guilds).where(eq(guilds.guildId, ON));
    const settings = guild!.settings as Record<string, unknown>;
    expect(settings.text_channel_name).toBe('vc chat');
    expect(settings.text_channel_role).toBe(ROLE);
  }, 300_000);

  it('never creates a row for a guild this fleet does not serve', async () => {
    const gone = await pg.handle.db
      .select()
      .from(autoChannels)
      .where(eq(autoChannels.guildId, GONE));
    expect(gone).toHaveLength(0);
    const guildRow = await pg.handle.db.select().from(guilds).where(eq(guilds.guildId, GONE));
    expect(guildRow).toHaveLength(0);
  }, 300_000);

  it('does not reach into another fleet', async () => {
    const other = new AutoChannelRepository(pg.handle.db, 'beta');
    const row = await other.get(OTHER_FLEET_PRIMARY);
    expect(row!.template.textChannel).toBeUndefined();
  }, 300_000);

  it('leaves a guild whose config had it off alone', async () => {
    const rows = new AutoChannelRepository(pg.handle.db, 'prod');
    const row = await rows.listByGuild(OFF);
    expect(row[0]!.template.textChannel).toBeUndefined();
  }, 300_000);

  it('is a no-op on a second run', async () => {
    const before = await new AutoChannelRepository(pg.handle.db, 'prod').get(LEGACY_PRIMARY);
    const summary = await run(true);
    expect(summary.channels).toBe(0);
    expect(summary.namesFilled).toBe(0);
    // Both settings were already there, so both are reported as kept.
    expect(summary.settingsKept).toBe(2);
    const after = await new AutoChannelRepository(pg.handle.db, 'prod').get(LEGACY_PRIMARY);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  }, 300_000);

  it('never overwrites a settings value an admin set since', async () => {
    await new GuildRepository(pg.handle.db).updateSettings(ON, {
      text_channel_name: 'renamed by an admin',
    });
    await run(true);
    const [guild] = await pg.handle.db.select().from(guilds).where(eq(guilds.guildId, ON));
    expect((guild!.settings as Record<string, unknown>).text_channel_name).toBe(
      'renamed by an admin',
    );
  }, 300_000);

  it('leaves an explicitly stored textChannel: false alone', async () => {
    // `/textchannels` DELETES the key when it turns the feature off, so absent
    // is ambiguous; `/import` stores the boolean verbatim, so `false` is an
    // admin's recorded decision and the one case that IS distinguishable.
    const row = await new AutoChannelRepository(pg.handle.db, 'prod').get(FALSE_PRIMARY);
    expect(row!.template.textChannel).toBe(false);
  }, 300_000);

  it('does not touch the same guild on another fleet', async () => {
    const prod = await new AutoChannelRepository(pg.handle.db, 'prod').get(BOTH_PROD_PRIMARY);
    expect(prod!.template.textChannel).toBe(true);
    const beta = await new AutoChannelRepository(pg.handle.db, 'beta').get(BOTH_BETA_PRIMARY);
    expect(beta!.template.textChannel).toBeUndefined();
  }, 300_000);

  it('fillSettingsGaps lets the stored value win a real collision', async () => {
    // The backfill's JS pre-filter means a collision never normally reaches the
    // SQL, so the operand order that IS the policy has to be exercised head-on:
    // reversing `patch || settings` to `settings || patch` must fail here.
    const repo = new GuildRepository(pg.handle.db);
    const guildId = '666666666666666666';
    await repo.updateSettings(guildId, { text_channel_name: 'mine', general: 'General' });
    await repo.fillSettingsGaps(guildId, {
      text_channel_name: 'the dump',
      text_channel_role: ROLE,
    });
    const [row] = await pg.handle.db.select().from(guilds).where(eq(guilds.guildId, guildId));
    const settings = row!.settings as Record<string, unknown>;
    expect(settings.text_channel_name).toBe('mine');
    expect(settings.text_channel_role).toBe(ROLE); // the absent key still lands
    expect(settings.general).toBe('General'); // untouched keys survive
  }, 300_000);

  it('can be widened to creator channels made after the import', async () => {
    const summary = await run(true, true);
    expect(summary.channels).toBe(1);
    const made = await new AutoChannelRepository(pg.handle.db, 'prod').get(NEW_PRIMARY);
    expect(made!.template.textChannel).toBe(true);
    expect(made!.template.name).toBe('made after migrating');
  }, 300_000);
});
