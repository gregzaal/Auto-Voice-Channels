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
  /**
   * Include `/templateassistant`. Registered only when a model endpoint is
   * configured (`AVC_AI_API_KEY`), so a self-hoster who hasn't set one never
   * sees a command that could only apologise (`plans/assisted_templates.md` §3).
   */
  includeAssistant?: boolean;
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
            .setDescription(`Maximum members (0 to ${MAX_USER_LIMIT}).`)
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
        .setDescription('Open a panel to rename your voice channel.'),
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
        .setName('reclaim')
        .setDescription('Reclaim your channel from a caretaker, or claim one whose owner left.'),
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
        .setDescription('Set the name shown for you in @@creator@@ channels (or "reset").')
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Your custom name, or "reset".')
            .setRequired(true)
            .setMaxLength(80),
        ) as SlashCommandBuilder,
    ),
    guildOnly(
      new SlashCommandBuilder().setName('ping').setDescription("Check the bot's responsiveness."),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get a link to invite this bot to another server.'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('source')
        .setDescription("Get a link to this bot's source code."),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Get started with Auto-Voice-Channels: status, setup, and quick actions.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('create')
        .setDescription('Create a new "creator" voice channel members can join to spawn channels.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('alias')
        .setDescription('Add a shorter alias for a game name shown in channel names.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('template')
        .setDescription("Open a panel to set the name template for the creator channel you're in."),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('position')
        .setDescription('Choose whether new channels appear above or below the creator channel.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('alwaysprivate')
        .setDescription('Toggle whether this creator channel spawns private channels by default.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('defaultlimit')
        .setDescription('Set the user limit new channels from this creator start with.')
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription(
              `Maximum members in new channels (0 to ${MAX_USER_LIMIT}, 0 = no limit).`,
            )
            .setMinValue(0)
            .setMaxValue(MAX_USER_LIMIT)
            .setRequired(true),
        ) as SlashCommandBuilder,
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('group')
        .setDescription("Group this category's channels into one numbered block (or turn it off)."),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('inheritpermissions')
        .setDescription('Choose where new channels copy their permissions from.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('logging')
        .setDescription('Configure event logging to a text channel (or turn it off).'),
    ),
  ];

  if (options.includeAssistant) {
    commands.push(
      adminOnly(
        new SlashCommandBuilder()
          .setName('templateassistant')
          .setDescription(
            'Describe the channel names you want and AVC writes the template for you.',
          ),
      ),
    );
  }

  if (options.includeDebug) {
    commands.push(
      adminOnly(
        new SlashCommandBuilder()
          .setName('debug')
          .setDescription("Dev: dump a channel's name/template/presence/permission data.")
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
  options: CommandBuildOptions = {},
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  // The dev-only `/debug` command exists only when registering to a dev guild.
  const body = buildCommandDefinitions({ ...options, includeDebug: Boolean(guildId) });
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
