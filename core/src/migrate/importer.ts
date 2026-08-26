import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, inArray, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { autoChannels, joinChannels, secondaryChannels } from '../db/schema.js';
import type { Fleet } from '../domain/fleets.js';
import { AutoChannelRepository } from '../repositories/autoChannels.js';
import { GuildRepository } from '../repositories/guilds.js';
import { JoinChannelRepository } from '../repositories/joinChannels.js';
import { SecondaryChannelRepository } from '../repositories/secondaryChannels.js';
import { TRIAL_YEAR_DAYS } from '../domain/tiers.js';
import { planGuild, trialStartFor, type GuildPlan } from './legacy.js';
import { mergeIntoExisting } from './merge.js';
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
  /**
   * Read each guild's existing row and report what the first-writer-wins merge
   * (`merge.ts`) would keep, without writing anything. Only meaningful with
   * `apply: false` — a real run always inspects, because the merge is how it
   * decides what to write.
   *
   * This is what makes the cutover's step-1 dry run able to answer "how many of
   * these guilds is another fleet already serving, and what would we leave
   * alone", which is the question §3.6 exists for. It needs a database, so the
   * CLI keeps it behind a flag: the plain dry run stays runnable with no
   * configuration at all.
   */
  inspectExisting?: boolean;
  /**
   * Process only these guild ids, ignoring every other file in the dump.
   *
   * The cutover's delta pass (§6 step 3): the bulk import runs for as long as it
   * takes while the old bot is still serving, then only the handful of guilds
   * whose config changed in that window are re-imported during the dark
   * minutes. Absent, every file is processed.
   */
  onlyGuildIds?: ReadonlySet<string>;
  /**
   * Treat this dump's `guilds.settings` as authoritative instead of filling
   * gaps (§3.6). **Requires `onlyGuildIds`**, because the whole justification is
   * that a human diffed the dumps and named the guilds whose config moved.
   *
   * Without it the delta pass (§6 step 3) cannot apply a single changed
   * guild-level setting: the bulk pass hours earlier is now the first writer, so
   * gap-filling declines to touch exactly the keys the delta exists to update,
   * while the per-primary templates DO update (same fleet, wholesale upsert) --
   * leaving the two halves of one guild's config disagreeing.
   *
   * Settings only. The auth-status guard is never bypassed: no dump is
   * authoritative about whether someone is paying.
   */
  overwriteSettings?: boolean;
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
  /** Guilds skipped because `onlyGuildIds` was given and did not name them. */
  skippedNotSelected: number;
  /**
   * Channel rows another fleet already owns, so this run cannot write them
   * (`foreignFleetChannels`). Skipped with a warning naming each one.
   */
  foreignFleetChannels: { channelId: string; fleet: string; guildId: string }[];
  /**
   * The first-writer-wins outcomes (§3.6). Populated on any run that inspects
   * existing rows, so a dry run can report them before anything is written.
   */
  merge: {
    /**
     * Guilds that already had a row. NOT the same as "another fleet imported
     * this": a row can come from the web app, an admin action, or this fleet's
     * own earlier pass, which is every guild in a delta run.
     */
    existed: number;
    /** How many guilds kept a non-`trial` status, by status. */
    keptStatus: Record<string, number>;
    /** How many guilds kept each settings key rather than taking the dump's. */
    keptSettingKeys: Record<string, number>;
  };
}

/**
 * Channel ids in this dump that another fleet already owns.
 *
 * **`channel_id` is the sole primary key on all four channel tables; `fleet` is
 * an ordinary column.** So two dumps naming the same channel do not get a row
 * each, they collide, and the repositories' cross-fleet guards turn that into a
 * throw (`autoChannels.upsert`'s `setWhere`, and the same shape in the secondary
 * and join repos). Without this check the throw lands mid-guild, after the
 * settings write and before the trial clock, leaving the guild half imported --
 * and a dry run cannot see it coming, because it writes nothing.
 *
 * How it happens in practice: a guild that pointed **both** bots at the same
 * creator channel. That configuration is visibly broken while both bots run (two
 * rooms spawn for one join), so it should be rare, and live secondaries cannot
 * collide at all since each bot only ever knew its own. Rare is not zero across
 * thousands of guilds, and the cost of not knowing is a half-imported guild.
 *
 * Reported and skipped rather than fatal: the row genuinely belongs to the other
 * fleet, one row cannot serve two, and naming it lets a human decide. Skipping it
 * still imports the rest of that guild completely.
 */
async function foreignFleetChannels(
  db: Database,
  fleet: Fleet,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Chunked: a full dump carries more ids than one parameter list should hold.
  for (let i = 0; i < ids.length; i += 1_000) {
    const chunk = ids.slice(i, i + 1_000);
    const [autos, seconds, joins] = await Promise.all([
      db
        .select({ channelId: autoChannels.channelId, fleet: autoChannels.fleet })
        .from(autoChannels)
        .where(and(inArray(autoChannels.channelId, chunk), ne(autoChannels.fleet, fleet))),
      db
        .select({ channelId: secondaryChannels.channelId, fleet: secondaryChannels.fleet })
        .from(secondaryChannels)
        .where(
          and(inArray(secondaryChannels.channelId, chunk), ne(secondaryChannels.fleet, fleet)),
        ),
      db
        .select({ channelId: joinChannels.channelId, fleet: joinChannels.fleet })
        .from(joinChannels)
        .where(and(inArray(joinChannels.channelId, chunk), ne(joinChannels.fleet, fleet))),
    ]);
    for (const row of [...autos, ...seconds, ...joins]) out.set(row.channelId, row.fleet);
  }
  return out;
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
    skippedNotSelected: 0,
    foreignFleetChannels: [],
    merge: { existed: 0, keptStatus: {}, keptSettingKeys: {} },
  };

  const inspect = opts.apply || opts.inspectExisting === true;

  if (opts.overwriteSettings && !opts.onlyGuildIds) {
    throw new Error(
      'overwriteSettings requires onlyGuildIds. Treating a whole dump as authoritative would ' +
        'discard whatever the other fleets are currently serving; the delta pass is allowed to ' +
        'because a human diffed the dumps and named the guilds that moved.',
    );
  }

  const selected = plans.filter(
    (p) => p.importable && (!opts.onlyGuildIds || opts.onlyGuildIds.has(p.guildId)),
  );

  /**
   * One query up front rather than a surprise per guild. Runs on a dry run too,
   * which is the point: this is the one failure mode `--check-existing` could not
   * otherwise predict.
   */
  const foreign = inspect
    ? await foreignFleetChannels(
        opts.db,
        opts.fleet,
        selected.flatMap((p) => [
          ...p.primaries.map((c) => c.channelId),
          ...p.secondaries.map((c) => c.channelId),
          ...p.joinChannels.map((c) => c.channelId),
        ]),
      )
    : new Map<string, string>();

  for (const plan of plans) {
    /**
     * Checked before `importable`, so the delta pass's counts describe the
     * subset it was asked about rather than the whole dump.
     */
    if (opts.onlyGuildIds && !opts.onlyGuildIds.has(plan.guildId)) {
      summary.skippedNotSelected++;
      continue;
    }

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

    if (!inspect) continue;

    try {
      /**
       * Channel rows another fleet owns. Recorded and skipped for both a dry run
       * and a real one, so the report is the same either way and `--apply` holds
       * no surprises this check could have named (`foreignFleetChannels`).
       */
      const recordForeign = (channelId: string): void => {
        const other = foreign.get(channelId);
        if (other === undefined) return;
        summary.foreignFleetChannels.push({ channelId, fleet: other, guildId: plan.guildId });
        summary.warnings.push(
          `${plan.guildId}: channel ${channelId} is already fleet "${other}"'s, skipped`,
        );
      };

      /**
       * The merge decision, and what another dump has already put here (§3.6).
       *
       * `undefined` must mean "nobody has imported this guild", never "the row we
       * just created ourselves", so the read has to see the table as it was. On a
       * real run `mergeSettings` does the read and the write in one transaction
       * under `FOR UPDATE`, because §6's bulk pass now runs against guilds a live
       * fleet is serving. A dry run reads without creating anything.
       */
      const merged = opts.apply
        ? await guilds.mergeSettings(plan.guildId, (existing) => {
            const m = mergeIntoExisting(plan.settings, existing, {
              overwrite: opts.overwriteSettings === true,
            });
            return { patch: m.settingsPatch, result: m };
          })
        : mergeIntoExisting(
            plan.settings,
            await guilds
              .get(plan.guildId)
              .then((row) =>
                row ? { authStatus: row.authStatus, settings: row.settings } : undefined,
              ),
            { overwrite: opts.overwriteSettings === true },
          );

      if (merged.existed) summary.merge.existed++;
      if (merged.keptStatus) {
        summary.merge.keptStatus[merged.keptStatus] =
          (summary.merge.keptStatus[merged.keptStatus] ?? 0) + 1;
      }
      for (const key of merged.keptSettingKeys) {
        summary.merge.keptSettingKeys[key] = (summary.merge.keptSettingKeys[key] ?? 0) + 1;
      }

      // Recorded on a dry run too, so `--apply` holds no surprise this could
      // have named. The write loops below skip the same ids.
      for (const primary of plan.primaries) recordForeign(primary.channelId);
      for (const secondary of plan.secondaries) recordForeign(secondary.channelId);
      for (const join of plan.joinChannels) recordForeign(join.channelId);

      if (!opts.apply) continue;

      for (const primary of plan.primaries) {
        if (foreign.has(primary.channelId)) continue;
        await autoChannels.upsert(plan.guildId, primary.channelId, primary.template);
      }

      for (const secondary of plan.secondaries) {
        if (foreign.has(secondary.channelId)) continue;
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
        if (foreign.has(join.channelId)) continue;
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
       *
       * **Skipped entirely for a guild that is not on `trial`** (§3.6).
       * `expiresAtIfNull` protects the date, not the status, so without this
       * guard the second and third dumps downgrade a paying guild to `trial`,
       * reset a `grace`/`expired` guild to a fresh year, and un-block a
       * `blocked` one. `skipIfUnchanged` covers the remaining no-op: a guild
       * already on `trial` with a clock already ticking needs no audit row, and
       * this runs over thousands of guilds several times.
       */
      if (merged.writeTrial) {
        await guilds.transitionAuth({
          guildId: plan.guildId,
          toStatus: 'trial',
          reason: 'legacy-import',
          actor: 'migrate-import',
          skipIfUnchanged: true,
          expiresAtIfNull: new Date(
            trialStartFor(plan.guildId, importedAt).getTime() + TRIAL_YEAR_DAYS * 86_400_000,
          ),
        });
      }

      /**
       * No welcome message for an imported guild.
       *
       * Onboarding sends its one-time welcome when a guild is on `trial`, has
       * no `onboardedAt`, and its row is under a week old. Every imported
       * guild satisfies all three, because the importer creates the row: the
       * first time the bot connects, a four-figure burst of "your free trial
       * just started" goes out to servers that have been running AVC happily
       * for years. The copy is written for a new install and is wrong for a
       * migration, the volume is a rate-limit and trust problem, and a mass
       * message is the single most distinguishable thing a fleet whose whole
       * premise is being indistinguishable from production could do.
       *
       * Stamping the flag here is what suppresses it. Migrated servers get a
       * written announcement instead, at a time somebody chose.
       *
       * Written after the trial clock, deliberately: `markOnboarded` is a
       * no-op once set, so a re-run cannot un-suppress anything, and a guild
       * whose `transitionAuth` failed has no clock and is therefore not yet
       * onboarded either. The two stay consistent under partial failure.
       */
      await guilds.markOnboarded(plan.guildId, importedAt);
    } catch (error) {
      summary.failures.push({ guildId: plan.guildId, error: (error as Error).message });
      log(`FAILED ${plan.guildId}: ${(error as Error).message}`);
    }
  }

  return summary;
}
