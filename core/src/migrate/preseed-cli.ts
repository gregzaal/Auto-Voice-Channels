/**
 * `migrate-preseed` (`plans/migration.md` §5.2).
 *
 *   migrate-preseed [--apply]
 *
 * Reads the current Discord name of every adopted channel that has none
 * recorded, and writes it into `state.name` so the first reconcile after an
 * import does not rename the entire fleet back to names it already has.
 *
 * Dry by default. Needs `DISCORD_TOKEN` and `DATABASE_URL`, unlike
 * `migrate-import`, which deliberately needs neither for a dry run. Run it
 * **after** the import and **before** starting the bot on those guilds.
 */
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/client.js';
import { DEFAULT_FLEET, type Fleet } from '../domain/fleets.js';
import { preseedNames } from './preseed.js';

/* eslint-disable no-console */

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const fleet: Fleet = config.fleet ?? DEFAULT_FLEET;
  const handle = createDatabase({ connectionString: config.databaseUrl });

  try {
    console.log(
      apply
        ? `Pre-seeding names into fleet "${fleet}". This writes.\n`
        : 'DRY RUN. Nothing will be written.\n',
    );

    const summary = await preseedNames({
      db: handle.db,
      fleet,
      token: config.discordToken,
      apply,
      log: (line) => console.log(`  ${line}`),
    });

    console.log(`\n  guilds:            ${summary.guilds}`);
    console.log(`  adopted, unnamed:  ${summary.candidates}`);
    console.log(`  names found:       ${summary.named}`);
    console.log(`  channels gone:     ${summary.missing}`);
    console.log(`  guilds unreachable: ${summary.unreachable.length}`);
    console.log(`  failures:           ${summary.failures.length}`);

    /**
     * The ids, not just the count. An unreachable guild means the import
     * adopted rows for a server the bot is not in, which is a finding worth
     * chasing, and "200 unreachable" with nothing to grep is not actionable at
     * three in the morning.
     */
    for (const g of summary.unreachable.slice(0, 40)) console.log(`  UNREACHABLE ${g}`);
    if (summary.unreachable.length > 40) {
      console.log(`  ... and ${summary.unreachable.length - 40} more`);
    }
    for (const f of summary.failures.slice(0, 20))
      console.log(`  FAILED ${f.channelId}: ${f.error}`);

    if (!apply) console.log('\nRe-run with --apply to write.');
    if (summary.failures.length > 0) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
