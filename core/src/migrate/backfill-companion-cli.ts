/**
 * `migrate-backfill-companion`.
 *
 *   migrate-backfill-companion <dir> [--apply] [--only-guilds <file>]
 *                                    [--all-creator-channels] [--census]
 *
 * Restores the companion text channel opt-in for guilds imported before the
 * rewrite carried it. See `backfillCompanion.ts` for why this exists and why it
 * is not a re-run of `migrate:import`.
 *
 * Dry by default, and `--census` is drier still: it reads the dump alone, needs
 * no database and no configuration, and answers "how many guilds had this on"
 * before anyone decides whether to run it for real. The plain dry run reads the
 * `auto_channels` and `guilds` rows too, so it can say how many of those guilds
 * this fleet actually serves and what a real run would leave alone.
 *
 * **Fleet comes from configuration, like every other tool here.** Stage it by
 * pointing `FLEET` at beta, running it, watching `companionText.tracked` in
 * `/diagnostics` climb as real rooms are created, and only then repeating for
 * prod and gold.
 *
 * Nothing here touches Discord. The companions themselves are created by the
 * running bot the next time a room is made, which is also what makes this safe
 * to stage: the write is a flag, and the fleet converges.
 *
 * A non-census run still needs the ordinary configuration, `DISCORD_TOKEN` and
 * `CLIENT_ID` included, because `loadConfig()` validates the whole environment
 * rather than the subset a given command uses. `--census` needs none of it and
 * returns before that call.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { backfillCompanionChannels, planCompanionBackfill } from './backfillCompanion.js';
import { parseLegacyJson } from './parseLegacyJson.js';

/* eslint-disable no-console */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readGuildList(path: string): Set<string> {
  const ids = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d{5,25}$/.test(l));
  if (ids.length === 0) {
    throw new Error(`No guild ids found in ${path}. Expected one snowflake per line.`);
  }
  return new Set(ids);
}

/** pnpm 9 forwards its `--` separator as a literal argument; drop it. */
function positionals(): string[] {
  return process.argv.slice(2).filter((a) => a !== '--' && !a.startsWith('--'));
}

/** Dump-only. No database, no configuration, nothing written. */
function census(dir: string, onlyGuildIds?: ReadonlySet<string>): void {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const unreadable: string[] = [];
  const skipped = new Map<string, number>();
  const found: { guildId: string; channels: number; name?: string; roleId?: string }[] = [];

  for (const file of files) {
    const guildId = file.replace(/\.json$/, '');
    if (onlyGuildIds && !onlyGuildIds.has(guildId)) continue;
    let raw: unknown;
    try {
      raw = parseLegacyJson(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      unreadable.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    let decision;
    try {
      decision = planCompanionBackfill(guildId, raw);
    } catch (err) {
      unreadable.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    if (decision.kind === 'skipped') {
      skipped.set(decision.reason, (skipped.get(decision.reason) ?? 0) + 1);
      continue;
    }
    if (decision.kind === 'off') continue;
    found.push({
      guildId,
      channels: decision.want.legacyChannelIds.length,
      ...(decision.want.name !== undefined ? { name: decision.want.name } : {}),
      ...(decision.want.roleId !== undefined ? { roleId: decision.want.roleId } : {}),
    });
  }

  console.log('CENSUS. Reads the dump only: no database, nothing written.\n');
  const notExamined = [...skipped.values()].reduce((a, b) => a + b, 0);
  console.log(`  files:                        ${files.length}`);
  console.log(`  unreadable:                   ${unreadable.length}`);
  console.log(`  not examined (see below):     ${notExamined}`);
  console.log(`  guilds with text_channels on: ${found.length}`);
  console.log(`  creator channels named:       ${found.reduce((n, g) => n + g.channels, 0)}`);
  console.log(`  with a custom name:           ${found.filter((g) => g.name).length}`);
  console.log(`  with a moderator role:        ${found.filter((g) => g.roleId).length}`);
  for (const u of unreadable.slice(0, 20)) console.log(`  UNREADABLE ${u}`);
  if (skipped.size > 0) {
    // Named rather than folded into "off": these files were never examined, so
    // the count above is over the REST of the dump. Skipping `left` is right --
    // the flag has no false positives, so a guild it excludes really is gone,
    // and the original import skipped it for the same reason -- but a census
    // that did not say so would overstate what it had looked at.
    console.log('');
    console.log('  Not examined:');
    for (const [reason, n] of [...skipped].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(6)}  ${reason}`);
    }
  }
  console.log('');
  for (const g of found) {
    console.log(
      `  ${g.guildId}  ${String(g.channels).padStart(3)} creator channel(s)` +
        (g.name ? `  name=${JSON.stringify(g.name)}` : '') +
        (g.roleId ? `  role=${g.roleId}` : ''),
    );
  }
  console.log('\nRun without --census to see which of these this fleet serves.');
}

async function main(): Promise<void> {
  const dir = positionals()[0];
  const apply = process.argv.includes('--apply');
  const censusOnly = process.argv.includes('--census');
  const allCreatorChannels = process.argv.includes('--all-creator-channels');
  const onlyPath = arg('only-guilds');

  if (!dir) {
    console.log(
      'Usage:\n' +
        '  migrate-backfill-companion <dir> [--apply] [--only-guilds <file>]\n' +
        '                                   [--all-creator-channels] [--census]\n\n' +
        '  <dir>                    directory of <guildId>.json files from the legacy dump\n' +
        '  --census                 dump-only report; no database, no configuration needed\n' +
        '  --only-guilds            restrict the run to these guild ids, one per line\n' +
        '  --all-creator-channels   also set it on creator channels made since the import\n' +
        '                           (default: only the ones the legacy config named)\n' +
        '  --apply                  actually write (default is a dry run)',
    );
    process.exit(0);
  }

  const onlyGuildIds = onlyPath ? readGuildList(onlyPath) : undefined;

  if (censusOnly) {
    census(dir, onlyGuildIds);
    return;
  }

  const config = loadConfig();
  const fleet: Fleet = config.fleet ?? DEFAULT_FLEET;
  const handle = createDatabase({ connectionString: config.databaseUrl });
  try {
    console.log(
      apply
        ? `Backfilling fleet "${fleet}". This writes.\n`
        : `DRY RUN against fleet "${fleet}". Reads the rows, writes nothing.\n`,
    );
    const summary = await backfillCompanionChannels({
      db: handle.db,
      fleet,
      dir,
      apply,
      ...(allCreatorChannels ? { allCreatorChannels } : {}),
      ...(onlyGuildIds ? { onlyGuildIds } : {}),
      log: (line) => console.log(`  ${line}`),
    });

    console.log(`\n  files:                       ${summary.files}`);
    console.log(`  unreadable:                  ${summary.unreadable.length}`);
    console.log(`  not examined (left/bad file):${' '.repeat(1)}${summary.skippedByPlanner}`);
    console.log(`  guilds with the setting on:  ${summary.candidates}`);
    console.log(`  served by this fleet:        ${summary.matched}`);
    console.log(`  not on this fleet:           ${summary.unmatched}`);
    console.log(
      `  ${apply ? 'creator channels changed:   ' : 'creator channels to change: '} ${summary.channels}`,
    );
    console.log(`  channel names filled in:     ${summary.namesFilled}`);
    console.log(`  moderator roles filled in:   ${summary.rolesFilled}`);
    console.log(`  settings left alone:         ${summary.settingsKept}`);
    if (onlyGuildIds) {
      console.log(`  skipped (not in --only-guilds): ${summary.skippedNotSelected}`);
    }
    console.log(`  failures:                    ${summary.failures.length}`);
    console.log(`  written but not announced:   ${summary.notifyFailures.length}`);
    for (const u of summary.unreadable.slice(0, 20)) console.log(`  UNREADABLE ${u}`);
    for (const f of summary.failures.slice(0, 20)) console.log(`  FAILED ${f.guildId}: ${f.error}`);
    // Rows written and committed; only the cache broadcast failed, which the
    // settings-cache TTL bounds and a re-run repeats. Not a failure.
    for (const f of summary.notifyFailures.slice(0, 20)) {
      console.log(`  NOT ANNOUNCED ${f.guildId}: ${f.error}`);
    }

    if (summary.unmatched > 0) {
      console.log(
        `\n  ${summary.unmatched} guild(s) had the setting on but have no creator channel on\n` +
          `  fleet "${fleet}". Expected: another fleet serves them, or the bot has left.\n` +
          `  Run this once per fleet rather than widening its scope.`,
      );
    }
    if (summary.failures.length > 0) process.exitCode = 1;
    if (!apply) console.log(`\nRe-run with --apply to write.`);
    else {
      console.log(
        `\n  Nothing is created on Discord by this command. Each guild's companions\n` +
          `  appear as its rooms are next created. Watch companionText.tracked in\n` +
          `  /diagnostics climb, and companionText.orphaned stay at zero.`,
      );
    }
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
