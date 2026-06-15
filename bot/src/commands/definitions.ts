import {
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import type { Logger } from '@avc/core';
import { MAX_USER_LIMIT } from '../features/voice/index.js';

/**
 * Slash-command surface. A hybrid (rewrite.md decision 11): direct commands for
 * the frequent per-channel actions, plus an admin `/settings` panel for guild
 * configuration. Admin commands are gated with `ManageChannels`; the per-channel
 * owner check lives in the command logic.
 */
export interface CommandBuildOptions {
  /** Include the dev-only `/debug` command (registered only when DEV_GUILD_ID is set). */
  includeDebug?: boolean;
}

export function buildCommandDefinitions(
  options: CommandBuildOptions = {},
): RESTPostAPIApplicationCommandsJSONBody[] {
  const guildOnly = (b: SlashCommandBuilder): SlashCommandBuilder =>
    b.setDMPermission(false) as SlashCommandBuilder;
  const adminOnly = (b: SlashCommandBuilder): SlashCommandBuilder =>
    guildOnly(b).setDefaultMemberPermissions(
      PermissionFlagsBits.ManageChannels,
    ) as SlashCommandBuilder;

  const commands: SlashCommandBuilder[] = [
    guildOnly(
      new SlashCommandBuilder()
        .setName('limit')
        .setDescription('Set the user limit on your voice channel (0 = unlimited).')
        .addIntegerOption((o) =>
          o
            .setName('count')
            .setDescription(`Maximum members (0–${MAX_USER_LIMIT}).`)
            .setMinValue(0)
            .setMaxValue(MAX_USER_LIMIT)
            .setRequired(true),
        ) as SlashCommandBuilder,
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('unlimit')
        .setDescription('Remove the user limit on your voice channel.'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('name')
        .setDescription('Rename your voice channel (use “reset” to revert).')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('New name or template (or “reset”).')
            .setRequired(true)
            .setMaxLength(100),
        ) as SlashCommandBuilder,
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('private')
        .setDescription('Make your voice channel private (lock out @everyone).'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('public')
        .setDescription('Reopen your voice channel to @everyone.'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claim your voice channel when its owner has left.'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('transfer')
        .setDescription('Transfer ownership of your voice channel to another member.')
        .addUserOption((o) =>
          o
            .setName('member')
            .setDescription('The new owner (must be in the channel).')
            .setRequired(true),
        ) as SlashCommandBuilder,
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Start a vote to kick a member from your voice channel.')
        .addUserOption((o) =>
          o.setName('member').setDescription('The member to votekick.').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('reason').setDescription('Why (optional).').setRequired(false),
        ) as SlashCommandBuilder,
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('nick')
        .setDescription('Set the name shown for you in @@creator@@ channels (or “reset”).')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Your custom name, or “reset”.')
            .setRequired(true)
            .setMaxLength(80),
        ) as SlashCommandBuilder,
    ),
    guildOnly(
      new SlashCommandBuilder().setName('ping').setDescription('Check the bot’s responsiveness.'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get a link to invite this bot to another server.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('create')
        .setDescription('Create a new “creator” voice channel members can join to spawn channels.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Open the server configuration panel for Auto-Voice-Channels.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('template')
        .setDescription(
          'Set the name template for the creator channel you’re in (all its channels).',
        )
        .addStringOption((o) =>
          o
            .setName('template')
            .setDescription('Name template (tokens like @@game_name@@, ##), or “reset”.')
            .setRequired(true)
            .setMaxLength(100),
        ) as SlashCommandBuilder,
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('toggleposition')
        .setDescription('Toggle whether new channels appear above or below the creator channel.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('inheritpermissions')
        .setDescription('Set where new channels copy their permissions from.')
        .addStringOption((o) =>
          o
            .setName('source')
            .setDescription('“primary”, “category”, or a voice-channel id.')
            .setRequired(true),
        ) as SlashCommandBuilder,
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('rename')
        .setDescription('Rename a bot-managed voice channel by picking it (admin override).')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('The voice channel to rename.')
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('New name/template, or “reset”.')
            .setRequired(true)
            .setMaxLength(100),
        ) as SlashCommandBuilder,
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('logging')
        .setDescription('Log channel events to a text channel (or turn logging off).')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where to send logs (defaults to here).')
            .addChannelTypes(ChannelType.GuildText),
        )
        .addIntegerOption((o) =>
          o
            .setName('level')
            .setDescription('1: lifecycle · 2: changes · 3: joins/leaves.')
            .addChoices(
              { name: '1 — channel lifecycle', value: 1 },
              { name: '2 — + changes', value: 2 },
              { name: '3 — + joins/leaves', value: 3 },
            ),
        )
        .addBooleanOption((o) =>
          o.setName('disable').setDescription('Turn logging off.'),
        ) as SlashCommandBuilder,
    ),
  ];

  if (options.includeDebug) {
    commands.push(
      adminOnly(
        new SlashCommandBuilder()
          .setName('debug')
          .setDescription('Dev: dump a channel’s name/template/presence/permission data.')
          .addChannelOption((o) =>
            o
              .setName('channel')
              .setDescription('Channel to inspect (defaults to your current voice channel).')
              .addChannelTypes(ChannelType.GuildVoice),
          ) as SlashCommandBuilder,
      ),
    );
  }

  return commands.map((c) => c.toJSON());
}

/**
 * Self-registers the slash commands (idempotent — Discord upserts by name).
 *
 * - With a `guildId` (dev/test), commands register to that guild and appear
 *   **instantly**; the global set is cleared so the two don't show as duplicates.
 * - Without one (production), commands register globally (propagation up to ~1h).
 */
export async function registerCommands(
  token: string,
  clientId: string,
  logger: Logger,
  guildId?: string,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  // The dev-only `/debug` command exists only when registering to a dev guild.
  const body = buildCommandDefinitions({ includeDebug: Boolean(guildId) });
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    // Clear global commands so dev guild + global don't duplicate in the UI.
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    logger.info({ count: body.length, guildId }, 'registered guild slash commands (instant)');
    return;
  }
  await rest.put(Routes.applicationCommands(clientId), { body });
  logger.info({ count: body.length }, 'registered global slash commands');
}
