/**
 * `migrate-import` (`plans/migration.md` §5.1).
 *
 *   migrate-import <dir> --live-guilds <file> [--apply]
 *
 * Dry by default. Nothing is written without `--apply`, and the dry run prints
 * exactly what a real run would do, so the decision to apply is made from
 * evidence rather than hope.
 *
 * **DB-only, no Discord token**, as §5.1 requires. The live guild list is a
 * file, produced separately by whoever does hold a token:
 *
 *   curl -H "Authorization: Bot $TOKEN" \
 *     'https://discord.com/api/v10/users/@me/guilds?limit=200' | jq -r '.[].id'
 *
 * (paginating with `after=<last id>` until a short page comes back)
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { importDump, planDump } from './importer.js';

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

/**
 * Positional arguments, with pnpm's `--` separator dropped.
 *
 * `pnpm --filter @avc/core run migrate:import -- <dir>` is the documented
 * invocation, and pnpm 9 forwards the `--` as a literal argument rather than
 * consuming it, so the first positional was `--` and the command printed its
 * own usage instead of running. Found by running exactly what the plan tells
 * someone to type, which is not the same thing as running the CLI.
 */
function positionals(): string[] {
  return process.argv.slice(2).filter((a) => a !== '--');
}

async function main(): Promise<void> {
  const dir = positionals()[0];
  const apply = process.argv.includes('--apply');
  const listPath = arg('live-guilds');

  if (!dir || dir.startsWith('--')) {
    console.log(
      'Usage:\n' +
        '  migrate-import <dir> --live-guilds <file> [--apply]\n\n' +
        '  <dir>           directory of <guildId>.json files from the legacy dump\n' +
        '  --live-guilds   file of guild ids the bot is actually in, one per line\n' +
        '  --apply         actually write (default is a dry run)',
    );
    process.exit(dir ? 1 : 0);
  }

  /**
   * The live list is mandatory for a real run and only advisory for a dry one.
   *
   * The dump's `left` flag has 858 false negatives against the live fleet, so
   * importing without the list starts trial clocks on servers we were removed
   * from. A dry run without it is still useful for inspecting the mapping, and
   * says loudly that its numbers are not the ones a real run would produce.
   */
  if (apply && !listPath) {
    throw new Error(
      '--live-guilds is required with --apply.\n' +
        "  The dump's `left` flag is stale: 858 guilds are marked as still installed when the\n" +
        '  bot is not in them. Importing those would create rows, and trial clocks, for servers\n' +
        '  we are not in. Supply the list Discord reports rather than trusting the files.',
    );
  }

  const liveGuildIds = listPath ? readGuildList(listPath) : undefined;

  /**
   * A dry run needs no configuration at all: no database, no Discord token,
   * nothing but the directory. Calling `loadConfig()` up front made inspecting
   * the mapping impossible without a full production environment, which is
   * exactly backwards for the command whose job is to be run first, by someone
   * deciding whether to trust it.
   */
  if (!apply) {
    const { plans, unreadable, files } = planDump({
      dir,
      ...(liveGuildIds ? { liveGuildIds } : {}),
    });
    const importable = plans.filter((p) => p.importable);
    console.log(`DRY RUN. Nothing will be written.\n`);
    if (!liveGuildIds) {
      console.log('  WARNING: no --live-guilds given, so these counts include phantom guilds.\n');
    }
    console.log(`  files:              ${files}`);
    console.log(`  unreadable:         ${unreadable.length}`);
    console.log(`  would import:       ${importable.length}`);
    console.log(`  skipped:            ${plans.length - importable.length}`);
    console.log(`  primaries:          ${importable.reduce((n, p) => n + p.primaries.length, 0)}`);
    console.log(
      `  secondaries:        ${importable.reduce((n, p) => n + p.secondaries.length, 0)}`,
    );
    console.log(
      `  join companions:    ${importable.reduce((n, p) => n + p.joinChannels.length, 0)}`,
    );
    console.log(
      `  Discord objects to purge later: ${importable.reduce((n, p) => n + p.orphanedTextChannels.length + p.orphanedRoles.length, 0)}`,
    );
    for (const u of unreadable.slice(0, 20)) console.log(`  UNREADABLE ${u}`);
    const warnings = importable.flatMap((p) => p.warnings.map((w) => `${p.guildId}: ${w}`));
    for (const w of warnings.slice(0, 20)) console.log(`  WARN ${w}`);
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more warnings`);
    console.log(`\nRe-run with --apply to write.`);
    return;
  }

  const config = loadConfig();
  const fleet: Fleet = config.fleet ?? DEFAULT_FLEET;
  const handle = createDatabase({ connectionString: config.databaseUrl });
  try {
    console.log(`Importing into fleet "${fleet}". This writes.\n`);
    const summary = await importDump({
      db: handle.db,
      fleet,
      dir,
      liveGuildIds: liveGuildIds!,
      apply: true,
      log: (line) => console.log(line),
    });

    console.log(`\n  files:            ${summary.files}`);
    console.log(`  imported:         ${summary.imported}`);
    console.log(`  skipped (left):   ${summary.skippedLeft}`);
    console.log(`  skipped (gone):   ${summary.skippedNotLive}`);
    console.log(`  primaries:        ${summary.primaries}`);
    console.log(`  secondaries:      ${summary.secondaries}`);
    console.log(`  join companions:  ${summary.joinChannels}`);
    console.log(`  unreadable:       ${summary.unreadable.length}`);
    console.log(`  failures:         ${summary.failures.length}`);
    for (const f of summary.failures.slice(0, 20)) console.log(`  FAILED ${f.guildId}: ${f.error}`);

    const purge = summary.orphanedTextChannels.length + summary.orphanedRoles.length;
    if (purge > 0) {
      console.log(
        `\n  ${purge} legacy Gold text channels and roles need deleting on Discord ` +
          `(migration.md §5.3). They are not cleaned up by the new bot.`,
      );
    }
    if (summary.failures.length > 0) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
