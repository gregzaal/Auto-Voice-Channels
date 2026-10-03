import {
  ChannelType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
  type SlashCommandMentionableOption,
  type SlashCommandStringOption,
  type SlashCommandUserOption,
} from 'discord.js';
import type { Logger } from '@avc/core';
import { MAX_USER_LIMIT } from '../features/voice/index.js';
import {
  AVAILABLE_FEATURES,
  FEATURE_LABELS,
  RESTRICT_ENFORCED,
} from '../features/voice/commandAccess.js';

/**
 * Slash-command surface. A hybrid: direct commands for
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
   * sees a command that could only apologise.
   */
  includeAssistant?: boolean;
  /**
   * Include `/restrict`. Defaults to `RESTRICT_ENFORCED`, which is true while the
   * guard reads the restrictions, so a build without one never lists a command
   * that promises what nothing does. Tests can pass it explicitly.
   */
  includeRestrict?: boolean;
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
  /**
   * One tier above {@link adminOnly}, for the two commands that move a whole
   * configuration.
   *
   * `ManageChannels` is deliberately generous, which is right for `/template`
   * and `/create`. `/import` replaces another admin's work from a file the bot
   * cannot vouch for, and `/export` discloses channel ids, the recorded contact
   * and every nickname members chose for themselves.
   *
   * The default is a DEFAULT, not a gate: a server admin can re-open either
   * command to any role in Server Settings > Integrations, so the in-code
   * `requireManageGuild` is what actually enforces this.
   */
  const serverAdminOnly = (b: SlashCommandBuilder): SlashCommandBuilder =>
    guildOnly(b).setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild,
    ) as SlashCommandBuilder;

  /** `/restrict add`, `remove` and `clear` take the same feature, and the first two the same who. */
  const restrictFeatureOption = (o: SlashCommandStringOption): SlashCommandStringOption =>
    o
      .setName('feature')
      .setDescription('Which room command.')
      .setRequired(true)
      .addChoices(...AVAILABLE_FEATURES.map((f) => ({ name: FEATURE_LABELS[f], value: f })));
  const restrictWhoOption = (o: SlashCommandMentionableOption): SlashCommandMentionableOption =>
    o.setName('who').setDescription('The person, or the role.').setRequired(true);
  /** `/access trust`, `block`, `admit` and `remove` all name one member. */
  const accessMemberOption = (o: SlashCommandUserOption): SlashCommandUserOption =>
    o.setName('member').setDescription('The member.').setRequired(true);

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
        .setName('hide')
        .setDescription('Hide your voice channel from the channel list.'),
    ),
    guildOnly(
      new SlashCommandBuilder()
        .setName('unhide')
        .setDescription('Show your hidden voice channel in the channel list again.'),
    ),
    /**
     * The second command here with subcommands, after `/restrict`, and open to every
     * member: the saved lists are a member's own, per server, and are not gated by
     * Manage Channels. `trust`, `block` and `admit` are what a `/restrict` rule on
     * Saved lists stops, and `remove`, `clear` and `list` never are.
     */
    guildOnly(
      new SlashCommandBuilder()
        .setName('access')
        .setDescription('Keep lists of who may join the rooms you create.')
        .addSubcommand((s) =>
          s
            .setName('trust')
            .setDescription('Always let someone into your locked and hidden rooms.')
            .addUserOption(accessMemberOption),
        )
        .addSubcommand((s) =>
          s
            .setName('block')
            .setDescription('Keep someone out of every room you create.')
            .addUserOption(accessMemberOption),
        )
        .addSubcommand((s) =>
          s
            .setName('admit')
            .setDescription('Let someone into this room only.')
            .addUserOption(accessMemberOption),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Take someone off your lists.')
            .addUserOption(accessMemberOption),
        )
        .addSubcommand((s) => s.setName('list').setDescription('See who is on your lists.'))
        .addSubcommand((s) =>
          s
            .setName('clear')
            .setDescription('Empty one of your lists, or both.')
            .addStringOption((o) =>
              o
                .setName('list')
                .setDescription('Which list. Leave it out to empty both.')
                .addChoices(
                  { name: 'Trusted', value: 'trusted' },
                  { name: 'Blocked', value: 'blocked' },
                ),
            ),
        ) as unknown as SlashCommandBuilder,
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
        .setDescription('Set the name shown for you in @@owner@@ rooms (or "reset").')
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
    /**
     * Open to everyone, deliberately, and the one admin-shaped command that is
     * not `adminOnly`.
     *
     * The question it answers ("why is my room called this") belongs to whoever
     * is standing in the room, and the legacy bot's `channelinfo` was open to
     * every member for the eight years it existed. The `channel` OPTION is
     * gated to Manage Channels in `handleChannelInfo`, because that is the half
     * that can name a channel the caller is not in.
     */
    guildOnly(
      new SlashCommandBuilder()
        .setName('channelinfo')
        .setDescription("See what AVC knows about a voice channel, and why it's named what it is.")
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Another voice channel to look at (needs Manage Channels).')
            .addChannelTypes(ChannelType.GuildVoice),
        ) as SlashCommandBuilder,
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('create')
        .setDescription('Create a new "creator" voice channel members can join to spawn rooms.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('alias')
        .setDescription('Add, edit or remove shorter aliases for game names in channel names.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('template')
        .setDescription("Open a panel to set the name template for the creator channel you're in."),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('position')
        .setDescription(
          'Choose whether new rooms appear above or below the creator channel, and their start number.',
        ),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('alwaysprivate')
        .setDescription('Toggle whether this creator channel spawns private rooms by default.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('textchannels')
        .setDescription('Toggle a private text channel for each room from this creator channel.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('controlpanel')
        .setDescription('Set up the buttons new rooms get in their chat, or turn them off.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('defaultlimit')
        .setDescription('Set the user limit new rooms from this creator channel start with.')
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription(`Maximum members in new rooms (0 to ${MAX_USER_LIMIT}, 0 = no limit).`)
            .setMinValue(0)
            .setMaxValue(MAX_USER_LIMIT)
            .setRequired(true),
        ) as SlashCommandBuilder,
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('group')
        .setDescription("Group this category's rooms into one numbered block (or turn it off)."),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('inheritpermissions')
        .setDescription('Choose where new rooms copy their permissions from.'),
    ),
    adminOnly(
      new SlashCommandBuilder()
        .setName('logging')
        .setDescription('Configure event logging to a text channel (or turn it off).'),
    ),
    /**
     * The first command here with subcommands, and the first to take an option
     * Discord resolves to either a user or a role (the mentionable picker).
     *
     * Enforced again in code (`requireManageChannels`), since the default is a
     * DEFAULT, and the in-code gate is also what keeps a role that Server Settings
     * > Integrations re-opened it to from rewriting who may use a room command.
     * The feature choices are `AVAILABLE_FEATURES`, so a feature whose command
     * does not exist yet cannot be offered. `clear` is the way out of a list that
     * has filled with people who left and roles that were deleted, which `remove`
     * cannot name because Discord's picker cannot offer them.
     *
     * Registered only while `RESTRICT_ENFORCED`: see the filter below.
     */
    adminOnly(
      new SlashCommandBuilder()
        .setName('restrict')
        .setDescription('Stop a person, or everyone with a role, from using some room commands.')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Stop a person or a role from using a room command.')
            .addStringOption(restrictFeatureOption)
            .addMentionableOption(restrictWhoOption),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Let a person or a role use a room command again.')
            .addStringOption(restrictFeatureOption)
            .addMentionableOption(restrictWhoOption),
        )
        .addSubcommand((s) =>
          s
            .setName('clear')
            .setDescription('Let everyone use a room command again.')
            .addStringOption(restrictFeatureOption),
        )
        .addSubcommand((s) =>
          s.setName('list').setDescription('See who is restricted from which room commands.'),
        ) as unknown as SlashCommandBuilder,
    ),
    /**
     * Manage Server rather than Manage Channels: this changes how the bot looks
     * to everyone in the server, which is `/import`'s reach, not `/template`'s.
     * Enforced again in code (`requireManageGuild`), since this is a default.
     */
    serverAdminOnly(
      new SlashCommandBuilder()
        .setName('botprofile')
        .setDescription('Give the bot its own avatar, banner, name and bio in this server.'),
    ),
    serverAdminOnly(
      new SlashCommandBuilder()
        .setName('export')
        .setDescription("Download this server's AVC configuration as a file."),
    ),
    serverAdminOnly(
      new SlashCommandBuilder()
        .setName('import')
        .setDescription('Load a configuration file, with a preview before anything is written.')
        .addAttachmentOption((o) =>
          o
            .setName('file')
            .setDescription('A file from /export, or a config from the old Python bot.')
            .setRequired(true),
        ) as SlashCommandBuilder,
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

  // `/restrict` is registered only by a build whose guard reads the map: its
  // replies tell an admin a member "can no longer use" something.
  const includeRestrict = options.includeRestrict ?? RESTRICT_ENFORCED;
  return commands.filter((c) => includeRestrict || c.name !== 'restrict').map((c) => c.toJSON());
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
