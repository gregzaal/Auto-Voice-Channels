import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import { secondaryChannels } from '../db/schema.js';
import {
  SecondaryChannelRepository,
  type SecondaryState,
} from '../repositories/secondaryChannels.js';

/**
 * The pre-seed pass (`plans/migration.md` §5.2).
 *
 * An adopted channel arrives with no `state.name`, and the reconciler renames
 * anything whose rendered name differs from what it has recorded
 * (`handler.ts:708`). Undefined differs from everything, so an adopted channel
 * is renamed on the first pass even when its name is already exactly right.
 * Writing the current Discord name in first prevents that: a channel that
 * already matches is left alone, and one that genuinely renders differently is
 * renamed once, which is correct.
 *
 * **This is a small pass, and the number matters more than the principle.**
 * Reconcile deletes empty secondaries before it renames anything
 * (`handler.ts:502`), and `rerenderSecondary` bails on an empty channel, so
 * only channels still *occupied* when reconcile runs are affected at all. The
 * cutover stops the old bot first, so rooms drain during the window, and
 * `migration.md` §2.1 measured 7 live secondaries fleet-wide. The realistic
 * count is zero to a handful. An earlier version of this comment called it a
 * "fleet-wide burst of writes", which contradicted §2.1 in the same document.
 * The command is still worth having, because it is cheap, correct and
 * re-runnable, but a failure here does not block a cutover.
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
/**
 * `Retry-After` in seconds, however Discord chose to express it.
 *
 * The header is allowed to be an HTTP date as well as a number, and Cloudflare
 * uses that form for the 1015 ban that a hammered token earns. `Number(date)`
 * is `NaN`, `Math.min(30, NaN)` is `NaN`, and `setTimeout(fn, NaN)` fires in
 * about three milliseconds: the back-off became a tight retry loop against
 * Discord, from the production token, in the middle of a cutover window. The
 * fallback is deliberately long rather than short, because the failure mode of
 * waiting too long is a slow migration and the failure mode of waiting too
 * little is a longer ban.
 */
export function retryAfterSeconds(header: string | null, now = Date.now()): number {
  if (!header) return DEFAULT_BACKOFF_SECONDS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, (at - now) / 1000);
  return DEFAULT_BACKOFF_SECONDS;
}

const DEFAULT_BACKOFF_SECONDS = 5;
/** Discord's own bans reach an hour; honour what it asks rather than guessing. */
const MAX_BACKOFF_SECONDS = 3600;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;

export function discordGuildChannels(
  token: string,
  options: { log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {},
): (guildId: string) => Promise<Map<string, string> | null> {
  const log = options.log ?? ((): void => {});
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (guildId: string) => {
    for (let attempt = 1; ; attempt++) {
      // Without a signal a hung connection blocks the entire sequential pass
      // for however long the OS takes to give up on the socket.
      const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
        headers: {
          Authorization: `Bot ${token}`,
          // Discord's edge rejects a request with no User-Agent with a 403 that
          // looks exactly like "the bot is not in this guild".
          'User-Agent': 'DiscordBot (https://auto-voice.io, 2.0) avc-migrate-preseed',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // The bot is not in this guild any more. Not an error: the dump is older
      // than the fleet and `left` is unreliable (§2.1).
      if (response.status === 403 || response.status === 404) return null;

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `Discord returned ${response.status} for guild ${guildId} after ${attempt} attempts`,
          );
        }
        const wait = Math.min(
          MAX_BACKOFF_SECONDS,
          response.status === 429
            ? retryAfterSeconds(response.headers.get('retry-after'))
            : DEFAULT_BACKOFF_SECONDS * attempt,
        );
        // Announced, because a silent multi-minute wait during a cutover reads
        // as a hang and gets killed by whoever is watching.
        log(`${guildId}: HTTP ${response.status}, waiting ${wait}s (attempt ${attempt})`);
        await sleep(wait * 1000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Discord returned ${response.status} for guild ${guildId}`);
      }

      const channels = (await response.json()) as { id: string; name: string }[];
      return new Map(channels.map((c) => [c.id, c.name]));
    }
  };
}

export async function preseedNames(opts: PreseedOptions): Promise<PreseedSummary> {
  const log = opts.log ?? ((): void => {});
  const fetchChannels = opts.fetchGuildChannels ?? discordGuildChannels(opts.token, { log });
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
        /**
         * Key absent, or present and useless.
         *
         * `state -> 'name' IS NULL` looks equivalent and is not: it is true for
         * a missing key but **false** for `{"name": null}`, which is SQL-null
         * only after `->>`. Such a row would be skipped here and then renamed
         * by the reconciler, which is precisely the outcome this pass exists to
         * prevent. Nothing writes that shape today, so this is a trap rather
         * than a bug, and traps in a once-run migration are worth closing.
         */
        sql`coalesce(${secondaryChannels.state} ->> 'name', '') = ''`,
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
      if (!opts.apply) {
        summary.named++;
        continue;
      }
      try {
        /**
         * The raw object is spread, not a parsed one.
         *
         * `updateState` replaces `state` wholesale, and `secondaryStateSchema`
         * is a bare `z.object`, so parsing first **strips every key the schema
         * does not know** and writes the truncated result back. That is silent
         * data loss dressed as validation, and it breaks expand/contract: an
         * older build running this against rows a newer bot wrote would drop
         * the new field. Only the shape actually being relied on is checked.
         */
        const existing = row.state;
        if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
          await repo.updateState(row.channelId, {
            ...(existing as SecondaryState),
            name,
          });
        } else {
          await repo.updateState(row.channelId, { name });
        }
        // Counted only once the write landed, so a row cannot appear in both
        // `named` and `failures`.
        summary.named++;
      } catch (error) {
        summary.failures.push({ channelId: row.channelId, error: (error as Error).message });
      }
    }
    log(`${guildId}: ${guildRows.length} adopted, ${channels.size} channels on Discord`);
  }

  return summary;
}
