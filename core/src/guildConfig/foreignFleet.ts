import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { Fleet } from '../domain/fleets.js';
import {
  autoChannels,
  guildFleetPresence,
  joinChannels,
  managedChannels,
  secondaryChannels,
} from '../db/schema.js';

/**
 * Channel ids in `ids` that another fleet already owns, mapped to that fleet.
 *
 * **Why an import needs this at all.** `channel_id` is the sole primary key on
 * every channel table and `fleet` is an ordinary column, so two fleets in one
 * guild do not get a row each, they collide. `autoChannels.upsert` throws
 * `auto channel <id> belongs to another fleet` and `managedChannels.create`
 * throws the equivalent, so without an up-front check the failure arrives
 * mid-apply, half way through a write sequence that is not one transaction.
 * **35 guilds have both beta and prod installed today.**
 *
 * **Why not `foreignFleetChannels` in `migrate/importer.ts`.** That one queries
 * `auto_channels`, `secondary_channels` and `join_channels` and misses
 * `managed_channels`, which is half of what `/import` writes. Copying it would
 * leave exactly the mid-apply throw the check exists to prevent, on the one
 * table whose write sequence has three steps.
 *
 * Reported and skipped rather than fatal, per row: the row genuinely belongs to
 * the other fleet, one row cannot serve two, and naming it lets the admin
 * decide. When EVERY channel in a file is foreign the caller refuses instead,
 * because "this import would change settings only" is a decision rather than a
 * long skip list.
 *
 * Needs an un-scoped query, which is why it takes a `Database` rather than
 * living on a repository: every repository here ANDs its own fleet onto reads,
 * which is precisely what would hide the answer.
 */
export async function foreignFleetChannelOwners(
  db: Database,
  fleet: Fleet,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  // Chunked because a file at the array caps plus a guild's own rows can exceed
  // what one parameter list should carry.
  for (let i = 0; i < ids.length; i += 1_000) {
    const chunk = ids.slice(i, i + 1_000);
    const [autos, managed, seconds, joins] = await Promise.all([
      db
        .select({ channelId: autoChannels.channelId, fleet: autoChannels.fleet })
        .from(autoChannels)
        .where(and(inArray(autoChannels.channelId, chunk), ne(autoChannels.fleet, fleet))),
      db
        .select({ channelId: managedChannels.channelId, fleet: managedChannels.fleet })
        .from(managedChannels)
        .where(and(inArray(managedChannels.channelId, chunk), ne(managedChannels.fleet, fleet))),
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
    for (const row of [...autos, ...managed, ...seconds, ...joins]) {
      out.set(row.channelId, row.fleet);
    }
  }

  return out;
}

/**
 * Fleets other than `fleet` that are present in this guild.
 *
 * Feeds the two-bots warning. Reads `guild_fleet_presence`, which has runtime
 * writers on `guildCreate`/`guildDelete` plus an hourly re-derive, so it is the
 * one place that answers "is another AVC bot here" without guessing from
 * channel rows.
 */
export async function otherFleetsInGuild(
  db: Database,
  fleet: Fleet,
  guildId: string,
): Promise<string[]> {
  const rows = await db
    .select({ fleet: guildFleetPresence.fleet, removedAt: guildFleetPresence.removedAt })
    .from(guildFleetPresence)
    .where(and(eq(guildFleetPresence.guildId, guildId), ne(guildFleetPresence.fleet, fleet)));
  return rows.filter((r) => r.removedAt === null).map((r) => r.fleet);
}
