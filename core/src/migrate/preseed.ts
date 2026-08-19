import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import { secondaryChannels } from '../db/schema.js';
import {
  SecondaryChannelRepository,
  secondaryStateSchema,
  type SecondaryState,
} from '../repositories/secondaryChannels.js';

/**
 * The pre-seed pass (`plans/migration.md` §5.2).
 *
 * An adopted channel arrives with no `state.name`, and the reconciler renames
 * anything whose rendered name differs from what it has recorded
 * (`handler.ts:708`). Undefined differs from everything, so the first reconcile
 * after an import renames **every adopted channel in the fleet**, including the
 * overwhelming majority whose names are already exactly right. That is a
 * fleet-wide burst of writes against a per-channel rate limit Discord measures
 * in renames per ten minutes, and it is visible to every member sitting in one
 * of those rooms.
 *
 * Writing the current Discord name into `state.name` first turns that burst
 * into nothing: a channel whose name already matches what the new renderer
 * produces is left alone, and one that genuinely renders differently is renamed
 * once, which is correct.
 *
 * **Separate from the importer, on purpose.** The importer holds no token and
 * that is a property worth keeping: it can be run and re-run by anyone with a
 * database, and a dry run needs no configuration at all. This reads Discord, so
 * it is its own command, and it works from the rows that were imported rather
 * than from the dump, which makes it re-runnable and independent of where the
 * data came from.
 */

export interface PreseedOptions {
  db: Database;
  fleet: Fleet;
  token: string;
  apply: boolean;
  /** Injected so tests do not need a network. */
  fetchGuildChannels?: (guildId: string) => Promise<Map<string, string> | null>;
  log?: (line: string) => void;
}

export interface PreseedSummary {
  guilds: number;
  candidates: number;
  named: number;
  /** Rows whose channel Discord no longer has. */
  missing: number;
  /** Guilds Discord would not tell us about (bot removed, or an outage). */
  unreachable: string[];
  failures: { channelId: string; error: string }[];
}

/**
 * One call per guild, not one per channel.
 *
 * `GET /guilds/{id}/channels` returns every channel in a single request, so a
 * fleet-wide pre-seed costs one request per guild rather than one per adopted
 * room. At cutover scale that is the difference between a minute and an hour of
 * rate-limited paging.
 */
export function discordGuildChannels(
  token: string,
): (guildId: string) => Promise<Map<string, string> | null> {
  return async (guildId: string) => {
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${token}` },
    });

    // The bot is not in this guild any more. Not an error: the dump is older
    // than the fleet and `left` is unreliable (§2.1).
    if (response.status === 403 || response.status === 404) return null;

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '1');
      await new Promise((resolve) => setTimeout(resolve, Math.min(30, retryAfter) * 1000));
      return discordGuildChannels(token)(guildId);
    }
    if (!response.ok) {
      throw new Error(`Discord returned ${response.status} for guild ${guildId}`);
    }

    const channels = (await response.json()) as { id: string; name: string }[];
    return new Map(channels.map((c) => [c.id, c.name]));
  };
}

export async function preseedNames(opts: PreseedOptions): Promise<PreseedSummary> {
  const log = opts.log ?? ((): void => {});
  const fetchChannels = opts.fetchGuildChannels ?? discordGuildChannels(opts.token);
  const repo = new SecondaryChannelRepository(opts.db, opts.fleet);

  /**
   * Only rows with no name yet.
   *
   * Re-running must not overwrite a name the running bot has since recorded:
   * by then `state.name` is the bot's own view of what it last set, and
   * replacing it with whatever Discord currently says would hand a manual
   * rename back to the reconciler as if the bot had made it.
   */
  const rows = await opts.db
    .select({
      channelId: secondaryChannels.channelId,
      guildId: secondaryChannels.guildId,
      state: secondaryChannels.state,
    })
    .from(secondaryChannels)
    .where(
      and(
        eq(secondaryChannels.fleet, opts.fleet),
        isNull(sql`${secondaryChannels.state} -> 'name'`),
      ),
    );

  const byGuild = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byGuild.get(row.guildId) ?? [];
    list.push(row);
    byGuild.set(row.guildId, list);
  }

  const summary: PreseedSummary = {
    guilds: byGuild.size,
    candidates: rows.length,
    named: 0,
    missing: 0,
    unreachable: [],
    failures: [],
  };

  for (const [guildId, guildRows] of byGuild) {
    let channels: Map<string, string> | null;
    try {
      channels = await fetchChannels(guildId);
    } catch (error) {
      summary.failures.push({ channelId: `guild:${guildId}`, error: (error as Error).message });
      continue;
    }
    if (!channels) {
      summary.unreachable.push(guildId);
      continue;
    }

    for (const row of guildRows) {
      const name = channels.get(row.channelId);
      if (name === undefined) {
        // The channel is gone. Left alone deliberately: the reconciler removes
        // rows for channels that no longer exist, and inventing a name here
        // would only make that row look healthy for one sweep.
        summary.missing++;
        continue;
      }
      summary.named++;
      if (!opts.apply) continue;
      try {
        // Parsed rather than spread blind: the row is external data, and
        // `updateState` replaces the whole object, so a corrupt field here
        // would be written back as-is instead of quarantining to its guild.
        const existing: SecondaryState = secondaryStateSchema.parse(row.state ?? {});
        await repo.updateState(row.channelId, { ...existing, name });
      } catch (error) {
        summary.failures.push({ channelId: row.channelId, error: (error as Error).message });
      }
    }
    log(`${guildId}: ${guildRows.length} adopted, ${channels.size} channels on Discord`);
  }

  return summary;
}
