import type { GuildRepository, Logger } from '@avc/core';
import type { Client, Guild } from 'discord.js';

export interface GuildIdentityDeps {
  client: Client;
  guilds: GuildRepository;
  logger: Logger;
}

/**
 * Keeps the denormalized guild identity (`guilds.name` / `icon_hash` /
 * `owner_id`) in step with Discord.
 *
 * Nothing in the product reads these — they exist so the service can be
 * *operated*. Every other view of a guild resolves its name through a signed-in
 * user's OAuth token, which only ever covers guilds that user is in, so without
 * this the operator console is a list of snowflakes.
 *
 * Deliberately not routed through the per-guild dispatcher. This is a single
 * conditional UPDATE of public metadata with no ordering relationship to voice
 * events, and putting it in the queue would make every guild edit in every guild
 * contend with channel automation for the same lane.
 *
 * @returns a disposer detaching the listeners.
 */
export function registerGuildIdentity(deps: GuildIdentityDeps): () => void {
  const capture = (guild: Guild, source: string): void => {
    void deps.guilds
      .recordIdentity(guild.id, {
        name: guild.name,
        iconHash: guild.icon,
        ownerId: guild.ownerId,
      })
      .catch((err: unknown) => {
        // Never escalate: this is operator convenience, and a guild whose name
        // we cannot record must still get its voice channels.
        deps.logger.warn({ err, guildId: guild.id, source }, 'failed to record guild identity');
      });
  };

  const onCreate = (guild: Guild): void => capture(guild, 'guildCreate');
  const onUpdate = (_before: Guild, after: Guild): void => capture(after, 'guildUpdate');

  deps.client.on('guildCreate', onCreate);
  deps.client.on('guildUpdate', onUpdate);
  return () => {
    deps.client.off('guildCreate', onCreate);
    deps.client.off('guildUpdate', onUpdate);
  };
}

/**
 * Captures identity for every guild already in cache.
 *
 * The `guildCreate` listener above misses the entire existing fleet: the initial
 * GUILD_CREATE burst arrives before READY, and re-delivered guilds on reconnect
 * are not new. This runs once at READY so a guild the bot was already in gets a
 * name without waiting for someone to rename their server.
 *
 * Sequential on purpose. It is a one-shot backfill over a cold cache with no
 * deadline, and firing thousands of concurrent writes at the pool at exactly the
 * moment the initial reconcile is also running is the one way this could hurt.
 */
export async function backfillGuildIdentities(deps: GuildIdentityDeps): Promise<number> {
  let recorded = 0;
  for (const guild of deps.client.guilds.cache.values()) {
    try {
      await deps.guilds.recordIdentity(guild.id, {
        name: guild.name,
        iconHash: guild.icon,
        ownerId: guild.ownerId,
      });
      recorded += 1;
    } catch (err) {
      deps.logger.warn({ err, guildId: guild.id }, 'failed to backfill guild identity');
    }
  }
  return recorded;
}
