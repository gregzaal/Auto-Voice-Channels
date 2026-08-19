import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import { AutoChannelRepository } from '../repositories/autoChannels.js';
import { GuildRepository } from '../repositories/guilds.js';
import { JoinChannelRepository } from '../repositories/joinChannels.js';
import { SecondaryChannelRepository } from '../repositories/secondaryChannels.js';
import { TRIAL_YEAR_DAYS } from '../domain/tiers.js';
import { planGuild, trialStartFor, type GuildPlan } from './legacy.js';
import { parseLegacyJson } from './parseLegacyJson.js';

/**
 * The write half of the importer (`plans/migration.md` §5.1).
 *
 * Everything that *decides* anything lives in `legacy.ts` and is pure. This
 * only writes, through the same repositories the bot uses, so imported rows go
 * through the same zod validation as rows the bot creates itself.
 *
 * **Idempotent.** Every write is an upsert or a conflict-do-nothing, so a
 * re-run converges rather than duplicating. That matters more than usual here:
 * the first real run is against 1004 live guilds and the natural response to a
 * partial failure is to run it again.
 */

export interface ImportOptions {
  db: Database;
  fleet: Fleet;
  /** Directory of `<guildId>.json` files from the legacy dump. */
  dir: string;
  /**
   * The guilds the bot is actually in. **Required for a real run.**
   *
   * The dump's own `left` flag has 858 false negatives against the live fleet
   * (`legacy.ts`), so without this the importer creates rows, and trial clocks,
   * for servers we were removed from while offline.
   */
  liveGuildIds: ReadonlySet<string>;
  /** Nothing is written unless this is true. */
  apply: boolean;
  /** The moment the trial clocks are measured from. */
  importedAt?: Date;
  log?: (line: string) => void;
}

export interface ImportSummary {
  files: number;
  unreadable: string[];
  imported: number;
  skippedLeft: number;
  skippedNotLive: number;
  primaries: number;
  secondaries: number;
  joinChannels: number;
  orphanedTextChannels: string[];
  orphanedRoles: string[];
  warnings: string[];
  droppedFieldCounts: Record<string, number>;
  /** Guilds that failed to write, by id, with the reason. */
  failures: { guildId: string; error: string }[];
}

/** Reads and plans every file in the dump. No database access. */
export function planDump(opts: { dir: string; liveGuildIds?: ReadonlySet<string> }): {
  plans: GuildPlan[];
  unreadable: string[];
  files: number;
} {
  const files = readdirSync(opts.dir).filter((f) => f.endsWith('.json'));
  const plans: GuildPlan[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    const guildId = file.replace(/\.json$/, '');
    let raw: unknown;
    try {
      raw = parseLegacyJson(readFileSync(join(opts.dir, file), 'utf8'));
    } catch (error) {
      // A file we cannot read is reported, never silently skipped: a guild
      // missing from the import is invisible until its owner complains.
      unreadable.push(`${file}: ${(error as Error).message}`);
      continue;
    }
    plans.push(
      planGuild(guildId, raw, opts.liveGuildIds ? { liveGuildIds: opts.liveGuildIds } : {}),
    );
  }
  return { plans, unreadable, files: files.length };
}

/**
 * Imports a dump. Dry by default: `apply` must be explicitly true.
 *
 * Ordering within a guild is deliberate. The guild row exists before anything
 * references it, primaries before the secondaries that point at them, and the
 * join companion after its secondary, so a partial failure never leaves a row
 * pointing at a parent that was never written.
 */
export async function importDump(opts: ImportOptions): Promise<ImportSummary> {
  const log = opts.log ?? ((): void => {});
  const importedAt = opts.importedAt ?? new Date();
  const { plans, unreadable, files } = planDump({
    dir: opts.dir,
    liveGuildIds: opts.liveGuildIds,
  });

  const guilds = new GuildRepository(opts.db);
  const autoChannels = new AutoChannelRepository(opts.db, opts.fleet);
  const secondaries = new SecondaryChannelRepository(opts.db, opts.fleet);
  const joins = new JoinChannelRepository(opts.db, opts.fleet);

  const summary: ImportSummary = {
    files,
    unreadable,
    imported: 0,
    skippedLeft: 0,
    skippedNotLive: 0,
    primaries: 0,
    secondaries: 0,
    joinChannels: 0,
    orphanedTextChannels: [],
    orphanedRoles: [],
    warnings: [],
    droppedFieldCounts: {},
    failures: [],
  };

  for (const plan of plans) {
    if (!plan.importable) {
      // Matched on a distinct marker, not the word "left": the phantom-guild
      // message also contains it, which quietly folded both counts into one.
      if (plan.skipReason?.startsWith('bot has left')) summary.skippedLeft++;
      else summary.skippedNotLive++;
      continue;
    }

    summary.imported++;
    summary.primaries += plan.primaries.length;
    summary.secondaries += plan.secondaries.length;
    summary.joinChannels += plan.joinChannels.length;
    summary.orphanedTextChannels.push(...plan.orphanedTextChannels);
    summary.orphanedRoles.push(...plan.orphanedRoles);
    for (const w of plan.warnings) summary.warnings.push(`${plan.guildId}: ${w}`);
    for (const f of plan.droppedFields) {
      summary.droppedFieldCounts[f] = (summary.droppedFieldCounts[f] ?? 0) + 1;
    }

    if (!opts.apply) continue;

    try {
      await guilds.ensure(plan.guildId);
      if (Object.keys(plan.settings).length > 0) {
        await guilds.updateSettings(plan.guildId, plan.settings);
      }

      for (const primary of plan.primaries) {
        await autoChannels.upsert(plan.guildId, primary.channelId, primary.template);
      }

      for (const secondary of plan.secondaries) {
        await secondaries.create({
          channelId: secondary.channelId,
          guildId: plan.guildId,
          primaryChannelId: secondary.primaryChannelId,
          ...(secondary.ownerId ? { ownerId: secondary.ownerId } : {}),
          state: secondary.private ? { private: true } : {},
          // The channel's real creation time, so `##` numbering survives.
          createdAt: secondary.createdAt,
        });
      }

      for (const join of plan.joinChannels) {
        // creatorId is not nullable on the row, and a companion without one
        // cannot answer a knock. Skipping is better than inventing an owner.
        if (!join.creatorId) {
          summary.warnings.push(
            `${plan.guildId}: join companion ${join.channelId} has no creator, skipped`,
          );
          continue;
        }
        await joins.create({
          channelId: join.channelId,
          guildId: plan.guildId,
          secondaryChannelId: join.secondaryChannelId,
          creatorId: join.creatorId,
        });
      }

      /**
       * The trial clock. Written last, so a guild whose rows failed is never
       * left billable for a config it does not have.
       *
       * **The importer must set this, not onboarding.** `authExpiresAt` is what
       * the leniency ladder measures, and onboarding derives it from
       * `row.createdAt` when it is null. For imported guilds that is the import
       * moment, so leaving it to onboarding would give all 1004 the same expiry
       * date and produce exactly the synchronized warning, grace and expiry
       * waves the jitter exists to prevent (`migration.md` §5.1).
       *
       * `expiresAtIfNull` is the DB-level "set exactly once" invariant, so a
       * re-run cannot move a clock that is already ticking. That is what makes
       * the whole importer safe to run twice.
       *
       * 365 days for everyone (`TRIAL_YEAR_DAYS`, §5.1) rather than the
       * member-count bands: the importer has no token and cannot count members,
       * and erring long is the only direction that cannot shorten someone's
       * trial.
       */
      await guilds.transitionAuth({
        guildId: plan.guildId,
        toStatus: 'trial',
        reason: 'legacy-import',
        actor: 'migrate-import',
        expiresAtIfNull: new Date(
          trialStartFor(plan.guildId, importedAt).getTime() + TRIAL_YEAR_DAYS * 86_400_000,
        ),
      });
    } catch (error) {
      summary.failures.push({ guildId: plan.guildId, error: (error as Error).message });
      log(`FAILED ${plan.guildId}: ${(error as Error).message}`);
    }
  }

  return summary;
}
