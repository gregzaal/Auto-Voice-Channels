import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import { SETTINGS_INVALIDATE_CHANNEL } from '../db/notify.js';
import { AutoChannelRepository } from '../repositories/autoChannels.js';
import { GuildRepository } from '../repositories/guilds.js';
import { planGuild } from './legacy.js';
import { parseLegacyJson } from './parseLegacyJson.js';

/**
 * Restores the companion text channel opt-in for guilds imported before the
 * rewrite had anywhere to put it.
 *
 * `planGuild` maps `text_channels` / `text_channel_name` / `stct` as of
 * 2026-09-18, but it runs only inside `migrate:import`, and every hosted guild
 * was imported while those three keys were still in `DROPPED_FIELDS`. Measured
 * on the shared database the day this was written: zero `auto_channels` rows
 * carry `textChannel`, on any fleet. The mapping is correct and reaches nobody.
 *
 * **This is deliberately not a re-run of the importer.** `importer.ts` writes
 * templates through `AutoChannelRepository.upsert`, whose `onConflictDoUpdate`
 * sets `template` wholesale, so re-importing to recover one field would discard
 * every template an admin has edited since. This writes that one field, as a
 * jsonb merge, onto rows that already exist.
 *
 * Additive and idempotent throughout:
 *
 * - it never creates an `auto_channels` row, so a creator channel deleted since
 *   the import stays deleted;
 * - it fills the two guild settings only where the key is absent, DB-side, the
 *   same first-writer-wins rule `merge.ts` applies;
 * - a second run reports zero changes and rewrites nothing.
 *
 * **The one asymmetry, stated plainly:** "never had it" and "cleared it after
 * migrating" are the same stored state -- absent -- for all three values, so
 * this run would restore any of them.
 *
 * - `/textchannels` deletes `template.textChannel` when it turns the feature
 *   off (`settings.ts`), rather than storing `false`. An explicitly stored
 *   `false`, which only `/import` can produce, IS distinguishable and is left
 *   alone: see `AutoChannelRepository.enableTextChannel`.
 * - `/setup` REMOVES `text_channel_name` and `text_channel_role` when an admin
 *   clears them, so a cleared moderator role is indistinguishable from one never
 *   set. Refilling it re-grants that role read access to every companion in the
 *   guild, which is the same class of outcome the `@everyone` refusal exists to
 *   prevent, reached another way.
 *
 * All of this is acceptable only while nobody has any of the three set to turn
 * off, which was true on 2026-09-18, and is what `--only-guilds` exists to
 * bound once it is not.
 */

export interface CompanionBackfillOptions {
  db: Database;
  fleet: Fleet;
  /** Directory of `<guildId>.json` files from the legacy dump. */
  dir: string;
  /** Nothing is written unless this is true. */
  apply: boolean;
  /**
   * Set the flag on every creator channel the guild has now, not only the ones
   * the legacy config named.
   *
   * Off by default. A creator channel an admin created after migrating was
   * created under a model where this feature is off, so turning it on there is
   * a new decision rather than a restoration.
   */
  allCreatorChannels?: boolean;
  /** Process only these guild ids, ignoring every other file in the dump. */
  onlyGuildIds?: ReadonlySet<string>;
  log?: (line: string) => void;
}

export interface CompanionBackfillGuild {
  guildId: string;
  /** Creator channels the legacy config named. */
  legacyChannelIds: string[];
  /** Creator channels this run changed, or would change. */
  channelIds: string[];
  name?: string;
  roleId?: string;
}

export interface CompanionBackfillSummary {
  files: number;
  unreadable: string[];
  /** Guilds whose legacy config had the feature on. */
  candidates: number;
  /** Candidates with at least one creator channel on this fleet. */
  matched: number;
  /** Candidates this fleet has no creator channel for: another fleet's, or gone. */
  unmatched: number;
  /** Creator channels the flag was set on, or would be on a dry run. */
  channels: number;
  /** Guilds whose `text_channel_name` was filled in. */
  namesFilled: number;
  /** Guilds whose `text_channel_role` was filled in. */
  rolesFilled: number;
  /** Settings values left alone because the guild already had one. */
  settingsKept: number;
  skippedNotSelected: number;
  /**
   * Dump files `planGuild` declined before the mapping ran: unparseable, or
   * marked `left`. Reported rather than folded into "off", so the census cannot
   * silently understate what it looked at.
   */
  skippedByPlanner: number;
  failures: { guildId: string; error: string }[];
  /**
   * Guilds written successfully whose cache-invalidation broadcast did not go
   * out. Separate from `failures` because the rows ARE written: the only
   * consequence is up to one settings-cache TTL of staleness on the fleet.
   */
  notifyFailures: { guildId: string; error: string }[];
  guilds: CompanionBackfillGuild[];
}

export interface CompanionBackfillWant {
  legacyChannelIds: string[];
  name?: string;
  roleId?: string;
}

/**
 * What one dump file asks for, decided without touching the database.
 *
 * Three outcomes, not two, and the third is why this is not a plain
 * `| undefined`: `planGuild` returns no primaries at all for a file it cannot
 * parse or one marked `left`, which is indistinguishable from "the feature was
 * off" unless it is reported separately. A census that folded those into "off"
 * would quietly understate its own coverage.
 *
 * Skipping `left` is correct and deliberate: the flag has false negatives but
 * **no false positives** (`legacy.ts`, measured 2026-08-18), so a guild marked
 * left really was gone, and the original import skipped it for the same reason.
 * The database is the real authority either way -- a guild we do not serve has
 * no `auto_channels` row and is counted `unmatched`.
 *
 * "Off" is the overwhelming majority: legacy's `textchannels` command carried
 * `gold_required=True` and the feature was off by default.
 */
export type CompanionBackfillDecision =
  | { kind: 'wanted'; want: CompanionBackfillWant }
  | { kind: 'off' }
  | { kind: 'skipped'; reason: string };

export function planCompanionBackfill(guildId: string, raw: unknown): CompanionBackfillDecision {
  const plan = planGuild(guildId, raw);
  if (plan.skipReason) return { kind: 'skipped', reason: plan.skipReason };
  const on = plan.primaries.filter((p) => p.template.textChannel === true);
  if (on.length === 0) return { kind: 'off' };
  const name = plan.settings.text_channel_name;
  const roleId = plan.settings.text_channel_role;
  // `planGuild` clamps the name to 100 characters (`legacy.ts`) and refuses a
  // role equal to the guild id -- `@everyone`, granting which would publish
  // every room chat to the server. Both are load-bearing and both were checked.
  // It does NOT fully validate the snowflake: `asId` length-checks strings but
  // not numbers, so a legacy `"stct": 0` would arrive as role id "0". Harmless
  // (it resolves to no role) and unreachable while `parseLegacyJson` quotes
  // every long integer, but not a guarantee to lean on.
  // Narrowed rather than revalidated here, because `settings` is a loose record.
  return {
    kind: 'wanted',
    want: {
      legacyChannelIds: on.map((p) => p.channelId),
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof roleId === 'string' ? { roleId } : {}),
    },
  };
}

export async function backfillCompanionChannels(
  opts: CompanionBackfillOptions,
): Promise<CompanionBackfillSummary> {
  const log = opts.log ?? (() => {});
  const autoChannels = new AutoChannelRepository(opts.db, opts.fleet);
  // Guild rows are shared across fleets, which is exactly why the settings half
  // gap-fills instead of overwriting: another fleet may have written them first.
  const guilds = new GuildRepository(opts.db);

  const summary: CompanionBackfillSummary = {
    files: 0,
    unreadable: [],
    candidates: 0,
    matched: 0,
    unmatched: 0,
    channels: 0,
    namesFilled: 0,
    rolesFilled: 0,
    settingsKept: 0,
    skippedNotSelected: 0,
    skippedByPlanner: 0,
    failures: [],
    notifyFailures: [],
    guilds: [],
  };

  const files = readdirSync(opts.dir).filter((f) => f.endsWith('.json'));
  summary.files = files.length;

  for (const file of files) {
    const guildId = file.replace(/\.json$/, '');
    if (opts.onlyGuildIds && !opts.onlyGuildIds.has(guildId)) {
      summary.skippedNotSelected++;
      continue;
    }

    let raw: unknown;
    try {
      raw = parseLegacyJson(readFileSync(join(opts.dir, file), 'utf8'));
    } catch (err) {
      summary.unreadable.push(`${file}: ${(err as Error).message}`);
      continue;
    }

    let decision: CompanionBackfillDecision;
    try {
      decision = planCompanionBackfill(guildId, raw);
    } catch (err) {
      summary.failures.push({ guildId, error: (err as Error).message });
      continue;
    }
    if (decision.kind === 'skipped') {
      summary.skippedByPlanner++;
      continue;
    }
    if (decision.kind === 'off') continue;
    const wanted = decision.want;
    summary.candidates++;

    try {
      const existing = await autoChannels.listByGuild(guildId);
      if (existing.length === 0) {
        // Another fleet serves this guild, or the bot is no longer in it. Either
        // way this run must not create the row: a creator channel deleted since
        // the import stays deleted.
        summary.unmatched++;
        continue;
      }
      summary.matched++;

      const scope = opts.allCreatorChannels
        ? existing
        : existing.filter((row) => wanted.legacyChannelIds.includes(row.channelId));
      // `=== undefined`, matching `enableTextChannel`'s `is null` exactly. A
      // dry run that counted a stored `false` would promise a change the apply
      // then declines to make.
      const pending = scope
        .filter((row) => row.template.textChannel === undefined)
        .map((row) => row.channelId);

      const changed = opts.apply
        ? await autoChannels.enableTextChannel(
            guildId,
            opts.allCreatorChannels ? undefined : wanted.legacyChannelIds,
          )
        : pending;
      summary.channels += changed.length;

      // Read only to report what a real run would keep. The write itself does
      // not depend on this read: `fillSettingsGaps` decides DB-side, so an admin
      // editing these settings between the two cannot lose their change.
      const stored = (await guilds.get(guildId))?.settings ?? {};
      const patch: Record<string, unknown> = {};
      if (wanted.name !== undefined) {
        if (stored.text_channel_name === undefined) patch.text_channel_name = wanted.name;
        else summary.settingsKept++;
      }
      if (wanted.roleId !== undefined) {
        if (stored.text_channel_role === undefined) patch.text_channel_role = wanted.roleId;
        else summary.settingsKept++;
      }
      if (patch.text_channel_name !== undefined) summary.namesFilled++;
      if (patch.text_channel_role !== undefined) summary.rolesFilled++;

      if (opts.apply && Object.keys(patch).length > 0) {
        await guilds.fillSettingsGaps(guildId, patch);
      }

      // Report only what moved, so an idempotent re-run is silent rather than
      // printing a no-op line for every guild it looked at.
      if (changed.length > 0 || Object.keys(patch).length > 0) {
        summary.guilds.push({
          guildId,
          legacyChannelIds: wanted.legacyChannelIds,
          channelIds: changed,
          ...(patch.text_channel_name !== undefined ? { name: wanted.name } : {}),
          ...(patch.text_channel_role !== undefined ? { roleId: wanted.roleId } : {}),
        });
        log(
          `${guildId}: ${changed.length} creator channel(s)` +
            (patch.text_channel_name !== undefined ? ', name' : '') +
            (patch.text_channel_role !== undefined ? ', role' : ''),
        );
      }
    } catch (err) {
      summary.failures.push({ guildId, error: (err as Error).message });
      continue;
    }

    /**
     * Announce OUTSIDE the guild's try, and unconditionally for a guild whose
     * settings this run asserted.
     *
     * Running instances hold these settings in a TTL-bounded cache, so without
     * this they serve the old values until it expires. `auto_channels` needs no
     * equivalent: channel reads always hit Postgres.
     *
     * It sits outside the try, and its condition reads the DUMP rather than what
     * this pass wrote, for one reason: a throw here would otherwise be reported
     * as the guild having FAILED -- wrong, because the rows are written and
     * committed -- and would be unrecoverable by the obvious response, since a
     * re-run finds the settings already present and would write, and announce,
     * nothing. Keyed on the dump, a re-run announces again. An eviction the
     * fleet did not need is free; a broadcast it needed and never got costs one
     * cache TTL of stale settings.
     */
    if (opts.apply && (wanted.name !== undefined || wanted.roleId !== undefined)) {
      try {
        await opts.db.execute(sql`select pg_notify(${SETTINGS_INVALIDATE_CHANNEL}, ${guildId})`);
      } catch (err) {
        summary.notifyFailures.push({ guildId, error: (err as Error).message });
      }
    }
  }

  return summary;
}
