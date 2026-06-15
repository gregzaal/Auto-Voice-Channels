import { AutoChannelRepository, createDatabase, runMigrations } from '@avc/core';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.TEST_GUILD_ID;
const connectionString = process.env.DATABASE_URL;
if (!token || !guildId || !connectionString) {
  // eslint-disable-next-line no-console
  console.error('Missing DISCORD_TOKEN / TEST_GUILD_ID / DATABASE_URL');
  process.exit(1);
}

const { db, close } = createDatabase({ connectionString });
await runMigrations(db);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
await new Promise<void>((resolve) => client.once('clientReady', () => resolve()));

const guild = await client.guilds.fetch(guildId);
const channel = await guild.channels.create({
  name: '➕ Join to Create',
  type: ChannelType.GuildVoice,
});

const repo = new AutoChannelRepository(db);
await repo.upsert(guildId, channel.id, { name: '## [@@game_name@@]' });

// eslint-disable-next-line no-console
console.log(`PRIMARY_ID=${channel.id}`);

await client.destroy();
await close();
process.exit(0);
