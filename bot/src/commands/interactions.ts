import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { GuildRepository, Logger } from '@avc/core';
import type { GuildDispatcher } from '../runtime/dispatcher.js';
import {
  rateLimitNote,
  type ChannelDebug,
  type CommandResult,
  type GuildSettingsService,
  type PrivacyService,
  type VoiceCommands,
  type VoiceFeature,
  type VoteKickManager,
} from '../features/voice/index.js';
import {
  modalForButton,
  renderSettingsPanel,
  SETTINGS_MODAL_IDS,
  SETTINGS_PREFIX,
  settingsId,
} from './settingsPanel.js';

export interface InteractionDeps {
  client: Client;
  dispatcher: GuildDispatcher;
  voiceCommands: VoiceCommands;
  settings: GuildSettingsService;
  votekick: VoteKickManager;
  privacy: PrivacyService;
  feature: VoiceFeature;
  guilds: GuildRepository;
  selfHosted: boolean;
  /** Discord application id, for building the `/invite` link. */
  clientId: string;
  logger: Logger;
  /** Optional sink for significant interaction failures (admin reporting). */
  reportError?: (message: string, context?: Record<string, unknown>) => void;
}

const KICK_PREFIX = 'avc:kick:';
const JOIN_PREFIX = 'avc:join:';
const VOTE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The command/interaction surface. Resolves each interaction's guild + caller +
 * current voice channel, applies the per-guild block gate, and routes the work
 * through the per-guild dispatcher (so it's ordered against voice events and
 * fault-isolated). Slash actions reuse the tested {@link VoiceCommands} /
 * {@link GuildSettingsService} / {@link VoteKickManager} logic.
 *
 * @returns a disposer detaching the listener.
 */
export function registerInteractionHandler(deps: InteractionDeps): () => void {
  const voteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const onInteraction = (interaction: Interaction): void => {
    void route(interaction).catch((err: unknown) => {
      deps.logger.error({ err }, 'interaction handling failed');
      deps.reportError?.('Interaction handling failed', {
        guildId: interaction.guildId ?? undefined,
        type: interaction.type,
        error: String(err),
      });
      void safeReply(interaction, '⚠️ Something went wrong handling that.');
    });
  };

  async function route(interaction: Interaction): Promise<void> {
    if (!interaction.inGuild()) return;
    const guildId = interaction.guildId;

    // Per-guild kill-switch: a blocked guild gets nothing.
    if (await isBlocked(deps.guilds, guildId)) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This server is currently blocked.', ephemeral: true });
      }
      return;
    }

    if (interaction.isChatInputCommand()) return handleCommand(interaction);
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
  }

  async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const channelId = currentVoiceChannelId(interaction);

    switch (interaction.commandName) {
      case 'limit':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:limit', () =>
            deps.voiceCommands.setLimit(
              guildId,
              channelId,
              userId,
              interaction.options.getInteger('count', true),
            ),
          ),
        );
      case 'unlimit':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:unlimit', () =>
            deps.voiceCommands.unlimit(guildId, channelId, userId),
          ),
        );
      case 'name':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:name', () =>
            deps.voiceCommands.setName(
              guildId,
              channelId,
              userId,
              interaction.options.getString('name', true),
            ),
          ),
        );
      case 'private':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:private', () =>
            deps.privacy.makePrivate(guildId, channelId, userId, interaction.channelId),
          ),
        );
      case 'public':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:public', () =>
            deps.privacy.makePublic(guildId, channelId, userId),
          ),
        );
      case 'claim':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:claim', () =>
            deps.voiceCommands.claim(guildId, channelId, userId),
          ),
        );
      case 'transfer':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:transfer', () =>
            deps.voiceCommands.transfer(
              guildId,
              channelId,
              userId,
              interaction.options.getUser('member', true).id,
            ),
          ),
        );
      case 'kick':
        return handleKickCommand(interaction);
      case 'nick': {
        const res = await run(guildId, 'cmd:nick', () =>
          deps.settings.setNick(guildId, userId, interaction.options.getString('name', true)),
        );
        if (!res.ok) return replyResult(interaction, res);
        // Re-render the user's channels so `@@creator@@` picks up the new name.
        const summary = await run(guildId, 'cmd:nick:render', () =>
          deps.feature.rerenderByOwner(guildId, userId),
        );
        return replyResult(interaction, {
          ok: true,
          message: res.message + rateLimitNote(summary.rateLimited),
        });
      }
      case 'template': {
        const res = await run(guildId, 'cmd:template', () =>
          deps.settings.setTemplate(
            guildId,
            channelId ?? '',
            interaction.options.getString('template', true),
          ),
        );
        if (!res.ok) return replyResult(interaction, res);
        // Re-render all of this creator channel's secondaries with the new template.
        const summary = await run(guildId, 'cmd:template:render', () =>
          deps.feature.rerenderSiblings(guildId, channelId ?? ''),
        );
        return replyResult(interaction, {
          ok: true,
          message: res.message + rateLimitNote(summary.rateLimited),
        });
      }
      case 'toggleposition':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:toggleposition', () =>
            deps.settings.togglePosition(guildId, channelId ?? ''),
          ),
        );
      case 'inheritpermissions':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:inheritpermissions', () =>
            deps.settings.setInheritPermissions(
              guildId,
              channelId ?? '',
              interaction.options.getString('source', true),
            ),
          ),
        );
      case 'rename':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:rename', () =>
            deps.voiceCommands.renameById(
              guildId,
              interaction.options.getChannel('channel', true).id,
              interaction.options.getString('name', true),
            ),
          ),
        );
      case 'logging':
        return handleLogging(interaction);
      case 'ping':
        return handlePing(interaction);
      case 'invite':
        return handleInvite(interaction);
      case 'debug':
        return handleDebug(interaction);
      case 'create':
        return handleCreate(interaction);
      case 'settings':
        return openSettings(interaction);
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
    }
  }

  async function handleLogging(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const disable = interaction.options.getBoolean('disable') ?? false;
    const target = disable
      ? null
      : (interaction.options.getChannel('channel')?.id ?? interaction.channelId);
    const level = (interaction.options.getInteger('level') ?? 1) as 1 | 2 | 3;
    await replyResult(
      interaction,
      await run(guildId, 'cmd:logging', () => deps.settings.setLogging(guildId, target, level)),
    );
  }

  async function handlePing(interaction: ChatInputCommandInteraction): Promise<void> {
    const ws = Math.round(deps.client.ws.ping);
    const sent = await interaction.reply({
      content: '🏓 Pinging…',
      ephemeral: true,
      fetchReply: true,
    });
    const rtt = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(
      `🏓 Pong! Round-trip ${rtt}ms · gateway ${ws < 0 ? '—' : `${ws}ms`}.`,
    );
  }

  async function handleInvite(interaction: ChatInputCommandInteraction): Promise<void> {
    // View + Connect + Move Members + Manage Channels + Manage Roles (+ messaging for
    // join requests) — the permission set the bot needs, matching the legacy invite.
    const url =
      `https://discord.com/oauth2/authorize?client_id=${deps.clientId}` +
      `&permissions=286280784&scope=bot%20applications.commands`;
    await interaction.reply({
      content: `📫 [Invite me to another server!](${url})`,
      ephemeral: true,
    });
  }

  /** Dev-only: dump the data behind a channel's name + config + permissions. */
  async function handleDebug(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId =
      interaction.options.getChannel('channel')?.id ?? currentVoiceChannelId(interaction);
    if (!channelId) {
      await interaction.reply({
        content: 'Join a voice channel or pass one with the `channel` option to debug it.',
        ephemeral: true,
      });
      return;
    }
    const info = await run(guildId, 'cmd:debug', () =>
      deps.feature.debugChannel(guildId, channelId),
    );
    const permissions = botPermissions(interaction, channelId);
    // Full structured dump goes to the logs; a readable summary to the user.
    deps.logger.info({ guildId, channelId, debug: info, permissions }, 'debug command');
    await interaction.reply({ content: formatDebug(info, permissions), ephemeral: true });
  }

  /** The bot's relevant permissions on a channel, for the debug dump. */
  function botPermissions(
    interaction: ChatInputCommandInteraction,
    channelId: string,
  ): Record<string, boolean> {
    const me = interaction.guild?.members.me;
    const channel = interaction.guild?.channels.cache.get(channelId);
    if (!me || !channel || !('permissionsFor' in channel)) return {};
    const p = channel.permissionsFor(me);
    if (!p) return {};
    return {
      ViewChannel: p.has('ViewChannel'),
      Connect: p.has('Connect'),
      ManageChannels: p.has('ManageChannels'),
      ManageRoles: p.has('ManageRoles'),
      MoveMembers: p.has('MoveMembers'),
    };
  }

  async function handleCreate(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await deps.guilds.isEntitled(guildId, deps.selfHosted))) {
      await interaction.reply({
        content: 'This server isn’t currently entitled.',
        ephemeral: true,
      });
      return;
    }
    await replyResult(
      interaction,
      await run(guildId, 'cmd:create', () => deps.settings.createPrimary(guildId)),
    );
  }

  async function openSettings(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const config = await run(guildId, 'settings:open', () => deps.settings.getConfig(guildId));
    await interaction.reply(renderSettingsPanel(config));
  }

  async function handleKickCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = currentVoiceChannelId(interaction);
    const target = interaction.options.getUser('member', true);
    const reason = interaction.options.getString('reason') ?? undefined;

    const result = await run(guildId, 'cmd:kick', () =>
      deps.votekick.start(guildId, channelId, interaction.user.id, target.id, reason),
    );
    if (!result.ok) {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    if (!deps.votekick.hasSession(channelId!)) {
      // Resolved immediately (1v1) — already kicked.
      await interaction.reply({ content: `✅ ${result.message}` });
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${KICK_PREFIX}${channelId}`)
        .setLabel('Vote to kick')
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({
      content:
        `🗳️ <@${interaction.user.id}> started a vote to kick <@${target.id}>` +
        `${reason ? ` — _${reason}_` : ''}.\n` +
        `Need **${result.required}** votes. (1 so far)`,
      components: [row],
    });
    armVoteTimeout(channelId!);
  }

  async function handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith(KICK_PREFIX)) return handleKickVote(interaction);
    if (interaction.customId.startsWith(JOIN_PREFIX)) return handleJoinDecision(interaction);
    if (interaction.customId.startsWith(SETTINGS_PREFIX)) return handleSettingsButton(interaction);
  }

  /** Owner approves/denies/blocks a "⇩ Join" request via the message buttons. */
  async function handleJoinDecision(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    // customId: avc:join:<approve|deny|block>:<joinChannelId>:<requesterId>
    const [, , action, joinChannelId, requesterId] = interaction.customId.split(':');
    if (!action || !joinChannelId || !requesterId) return;

    const ctx = await deps.privacy.getJoinContext(joinChannelId);
    if (!ctx) {
      await interaction.update({ content: 'This request has expired.', components: [] });
      return;
    }
    if (interaction.user.id !== ctx.creatorId) {
      await interaction.reply({
        content: 'Only the channel owner can answer this request.',
        ephemeral: true,
      });
      return;
    }
    const result = await run(guildId, `join:${action}`, () =>
      action === 'approve'
        ? deps.privacy.approveJoin(joinChannelId, requesterId)
        : deps.privacy.denyJoin(joinChannelId, requesterId, action === 'block'),
    );
    await interaction.update({
      content: `${result.ok ? '✅' : '⚠️'} ${result.message}`,
      components: [],
    });
  }

  async function handleKickVote(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = interaction.customId.slice(KICK_PREFIX.length);
    const res = await run(guildId, 'kick:vote', () =>
      deps.votekick.vote(channelId, interaction.user.id),
    );
    if (!res.ok) {
      await interaction.reply({ content: res.message, ephemeral: true });
      return;
    }
    if (res.resolved) {
      clearVoteTimeout(channelId);
      await interaction.update({ content: `✅ ${res.message}`, components: [] });
      return;
    }
    await interaction.reply({ content: res.message, ephemeral: true });
  }

  async function handleSettingsButton(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const modal = modalForButton(interaction);
    if (modal) {
      await interaction.showModal(modal);
      return;
    }
    if (interaction.customId === settingsId('toggle')) {
      await run(guildId, 'settings:toggle', async () => {
        const config = await deps.settings.getConfig(guildId);
        return deps.settings.setEnabled(guildId, !config.enabled);
      });
      const config = await deps.settings.getConfig(guildId);
      await interaction.update(toUpdate(renderSettingsPanel(config)));
      return;
    }
    if (interaction.customId === settingsId('create')) {
      const result = await run(guildId, 'settings:create', () =>
        deps.settings.createPrimary(guildId),
      );
      const config = await deps.settings.getConfig(guildId);
      await interaction.update(toUpdate(renderSettingsPanel(config)));
      await interaction.followUp({ content: result.message, ephemeral: true });
      return;
    }
  }

  async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    let result: CommandResult | undefined;
    if (interaction.customId === SETTINGS_MODAL_IDS.general) {
      result = await run(guildId, 'settings:general', () =>
        deps.settings.setGeneral(guildId, interaction.fields.getTextInputValue('label')),
      );
    } else if (interaction.customId === SETTINGS_MODAL_IDS.template) {
      result = await run(guildId, 'settings:template', () =>
        deps.settings.setDefaultTemplate(guildId, interaction.fields.getTextInputValue('template')),
      );
    } else if (interaction.customId === SETTINGS_MODAL_IDS.alias) {
      result = await run(guildId, 'settings:alias', () =>
        deps.settings.addAlias(
          guildId,
          interaction.fields.getTextInputValue('game'),
          interaction.fields.getTextInputValue('alias'),
        ),
      );
    }
    if (result) await interaction.reply({ content: result.message, ephemeral: true });
  }

  // -- helpers --------------------------------------------------------------

  /** Routes guild work through the per-guild queue (ordering + isolation). */
  function run<T>(guildId: string, name: string, task: () => Promise<T>): Promise<T> {
    return deps.dispatcher.dispatch(guildId, name, task);
  }

  function armVoteTimeout(channelId: string): void {
    clearVoteTimeout(channelId);
    const timer = setTimeout(() => {
      deps.votekick.cancel(channelId);
      voteTimers.delete(channelId);
    }, VOTE_TIMEOUT_MS);
    timer.unref?.();
    voteTimers.set(channelId, timer);
  }

  function clearVoteTimeout(channelId: string): void {
    const timer = voteTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      voteTimers.delete(channelId);
    }
  }

  deps.client.on('interactionCreate', onInteraction);
  return () => {
    deps.client.off('interactionCreate', onInteraction);
    for (const timer of voteTimers.values()) clearTimeout(timer);
    voteTimers.clear();
  };
}

function currentVoiceChannelId(interaction: ChatInputCommandInteraction): string | undefined {
  const member = interaction.member as GuildMember | null;
  return member?.voice?.channelId ?? undefined;
}

/** Renders a human-readable `/debug` summary (full detail goes to the logs). */
function formatDebug(info: ChannelDebug, permissions: Record<string, boolean>): string {
  const perms = Object.entries(permissions)
    .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`)
    .join('  ');
  const kind = info.isSecondary ? 'secondary' : info.isPrimary ? 'primary' : 'unmanaged';
  const lines = [
    `**Debug** <#${info.channelId}>  ·  _${kind}_`,
    info.renderedName !== undefined ? `**Rendered name:** \`${info.renderedName}\`` : null,
    `**Effective template:** \`${info.effectiveTemplate}\``,
    info.primaryTemplate ? `**Primary template:** \`${info.primaryTemplate}\`` : null,
    `**Server default:** \`${info.guildSettings.defaultTemplate}\``,
    `**Computed game:** ${info.computedGame}  ·  **enabled:** ${info.guildSettings.enabled}` +
      `  ·  **aliases:** ${info.guildSettings.aliasCount}  ·  **seed:** ${info.seed ?? '—'}`,
    info.secondary
      ? `**Owner:** ${info.secondary.ownerId ? `<@${info.secondary.ownerId}>` : '—'}`
      : null,
    `**Bot perms:** ${perms || '—'}`,
    `**Members (${info.members.length}):**`,
    ...info.members.slice(0, 8).map((m) => {
      const acts = m.activities
        .map(
          (a) =>
            `${a.kind === 'streaming' ? '🔴' : ''}${a.name}${a.party?.size ? ` [${a.party.size.join('/')}]` : ''}`,
        )
        .join(', ');
      return `• ${m.bot ? '🤖 ' : ''}${m.displayName}${acts ? ` — ${acts}` : ''}`;
    }),
  ].filter((l): l is string => l !== null);
  return lines.join('\n').slice(0, 1900);
}

async function isBlocked(guilds: GuildRepository, guildId: string): Promise<boolean> {
  const row = await guilds.get(guildId);
  return row?.authStatus === 'blocked';
}

async function replyResult(
  interaction: ChatInputCommandInteraction,
  result: CommandResult,
): Promise<void> {
  await interaction.reply({
    content: `${result.ok ? '✅' : '⚠️'} ${result.message}`,
    ephemeral: true,
  });
}

async function safeReply(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch {
    // The interaction token may have expired; nothing more we can do.
  }
}

/** Strip `ephemeral` (invalid on `update`) but keep embeds/components. */
function toUpdate(reply: ReturnType<typeof renderSettingsPanel>): {
  embeds: NonNullable<typeof reply.embeds>;
  components: NonNullable<typeof reply.components>;
} {
  return {
    embeds: reply.embeds ?? [],
    components: reply.components ?? [],
  } as never;
}
