import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
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
  type EditorField,
  type EditorScope,
  type EditorState,
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
import {
  buildEditorModal,
  EDITOR_PREFIX,
  parseEditorId,
  renderEditorPanel,
} from './templatePanel.js';
import {
  buildCreateModal,
  CREATE_AGAIN_ID,
  CREATE_MODAL_ID,
  parseCreateModal,
} from './createModal.js';
import {
  buildPositionModal,
  parsePositionModal,
  positionChannelId,
  POSITION_MODAL_PREFIX,
} from './positionModal.js';
import {
  buildInheritModal,
  inheritChannelId,
  INHERIT_MODAL_PREFIX,
  parseInheritModal,
} from './inheritModal.js';
import { buildLoggingModal, LOGGING_MODAL_ID, parseLoggingModal } from './loggingModal.js';

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
        return openNamePanel(interaction);
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
      case 'template':
        return openTemplatePanel(interaction);
      case 'position':
        return openPositionModal(interaction);
      case 'inheritpermissions':
        return openInheritModal(interaction);
      case 'logging':
        return openLoggingModal(interaction);
      case 'ping':
        return handlePing(interaction);
      case 'invite':
        return handleInvite(interaction);
      case 'debug':
        return handleDebug(interaction);
      case 'create':
        return openCreateModal(interaction);
      case 'settings':
        return openSettings(interaction);
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
    }
  }

  // -- /name + /template editor panel --------------------------------------

  async function openTemplatePanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = currentVoiceChannelId(interaction);
    if (!channelId) {
      await interaction.reply({
        content: 'Join one of that creator channel’s voice channels first.',
        ephemeral: true,
      });
      return;
    }
    const state = await run(guildId, 'cmd:template', () =>
      deps.feature.getEditorState('primary', guildId, channelId),
    );
    if (!state.found) {
      await interaction.reply({
        content: 'This isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply(renderEditorPanel('primary', channelId, state));
  }

  /** `/position` → a modal to pick above/below for the creator channel you're in. */
  async function openPositionModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = currentVoiceChannelId(interaction);
    if (!channelId) {
      await interaction.reply({
        content: 'Join one of that creator channel’s voice channels first.',
        ephemeral: true,
      });
      return;
    }
    const pos = await run(guildId, 'cmd:position', () =>
      deps.settings.getPosition(guildId, channelId),
    );
    if (!pos.found) {
      await interaction.reply({
        content: 'This isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
      return;
    }
    await interaction.showModal(buildPositionModal(channelId, pos.above));
  }

  /**
   * The `/position` modal submit: persist the above/below choice, then reposition
   * the primary's existing secondaries to match (only when the setting changed).
   */
  async function handlePositionSubmit(
    interaction: ModalSubmitInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!hasManageChannels(interaction)) {
      await interaction.reply({
        content: 'You need the Manage Channels permission.',
        ephemeral: true,
      });
      return;
    }
    const above = parsePositionModal(interaction.fields);
    const before = await run(guildId, 'cmd:position:get', () =>
      deps.settings.getPosition(guildId, channelId),
    );
    const res = await run(guildId, 'cmd:position:set', () =>
      deps.settings.setPosition(guildId, channelId, above),
    );
    let message = res.message;
    if (res.ok && before.primaryChannelId && before.above !== above) {
      const moved = await run(guildId, 'cmd:position:reposition', () =>
        deps.feature.repositionSecondaries(guildId, before.primaryChannelId!, above),
      );
      if (moved > 0) message += ` Moved ${moved} existing channel${moved === 1 ? '' : 's'}.`;
    }
    await interaction.reply({
      content: `${res.ok ? '✅' : '⚠️'} ${message}`,
      ephemeral: true,
    });
  }

  /** `/inheritpermissions` → a modal to choose the permission source. */
  async function openInheritModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = currentVoiceChannelId(interaction);
    if (!channelId) {
      await interaction.reply({
        content: 'Join one of that creator channel’s voice channels first.',
        ephemeral: true,
      });
      return;
    }
    const pos = await run(guildId, 'cmd:inherit', () =>
      deps.settings.getPosition(guildId, channelId),
    );
    if (!pos.found) {
      await interaction.reply({
        content: 'This isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
      return;
    }
    await interaction.showModal(buildInheritModal(channelId));
  }

  /** The `/inheritpermissions` modal submit. */
  async function handleInheritSubmit(
    interaction: ModalSubmitInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!hasManageChannels(interaction)) {
      await interaction.reply({
        content: 'You need the Manage Channels permission.',
        ephemeral: true,
      });
      return;
    }
    const source = parseInheritModal(interaction.fields);
    const res = await run(guildId, 'cmd:inheritpermissions', () =>
      deps.settings.setInheritPermissions(guildId, channelId, source),
    );
    await interaction.reply({
      content: `${res.ok ? '✅' : '⚠️'} ${res.message}`,
      ephemeral: true,
    });
  }

  /** `/logging` → a modal to set the log channel + detail level (or turn it off). */
  async function openLoggingModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const current = await run(guildId, 'cmd:logging:get', () => deps.settings.getLogging(guildId));
    await interaction.showModal(buildLoggingModal(current));
  }

  /** The `/logging` modal submit. */
  async function handleLoggingSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (!hasManageChannels(interaction)) {
      await interaction.reply({
        content: 'You need the Manage Channels permission.',
        ephemeral: true,
      });
      return;
    }
    const parsed = parseLoggingModal(interaction.fields);
    const target = parsed.disable ? null : (parsed.channelId ?? interaction.channelId);
    const res = await run(guildId, 'cmd:logging', () =>
      deps.settings.setLogging(guildId, target, parsed.level),
    );
    await interaction.reply({
      content: `${res.ok ? '✅' : '⚠️'} ${res.message}`,
      ephemeral: true,
    });
  }

  async function openNamePanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const target = currentVoiceChannelId(interaction);
    if (!target) {
      await interaction.reply({
        content: 'Join the voice channel you want to rename first.',
        ephemeral: true,
      });
      return;
    }
    const state = await run(guildId, 'cmd:name', () =>
      deps.feature.getEditorState('channel', guildId, target),
    );
    if (!state.found) {
      await interaction.reply({
        content: 'That isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
      return;
    }
    // Anyone may edit their own channel; editing another's needs admin.
    if (!hasManageChannels(interaction) && state.ownerId && state.ownerId !== userId) {
      await interaction.reply({
        content: 'Only the channel’s owner or a server admin can edit it.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply(renderEditorPanel('channel', target, state));
  }

  async function handleEditorButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseEditorId(interaction.customId);
    if (!parsed) return;
    const { action, scope, field, channelId } = parsed;
    if (action === 'close') {
      await interaction.update({ content: 'Closed.', embeds: [], components: [] });
      return;
    }
    if (action === 'edit') {
      const state = await run(interaction.guildId!, 'editor:state', () =>
        deps.feature.getEditorState(scope, interaction.guildId!, channelId),
      );
      await interaction.showModal(buildEditorModal(scope, field, channelId, state));
      return;
    }
    if (action === 'reset') {
      // Defer first: the rerender can hit the rate-limit probe and brush the 3s ack.
      await interaction.deferUpdate();
      await refreshEditorPanel(interaction, scope, field, channelId, 'reset');
    }
  }

  async function handleEditorModal(interaction: ModalSubmitInteraction): Promise<void> {
    const parsed = parseEditorId(interaction.customId);
    if (!parsed || parsed.action !== 'save') return;
    if (!interaction.isFromMessage()) return; // editor modals are always panel-driven
    const value = interaction.fields.getTextInputValue('template');
    await interaction.deferUpdate();
    await refreshEditorPanel(interaction, parsed.scope, parsed.field, parsed.channelId, value);
  }

  /** Applies a change and edits the (already-deferred) panel in place. */
  async function refreshEditorPanel(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    scope: EditorScope,
    field: EditorField,
    channelId: string,
    value: string,
  ): Promise<void> {
    const applied = await applyEditor(interaction, scope, field, channelId, value);
    if (applied.ok) {
      await interaction.editReply(
        toUpdate(renderEditorPanel(scope, channelId, applied.state, applied.opts)),
      );
    } else {
      await interaction.followUp({ content: `⚠️ ${applied.message}`, ephemeral: true });
    }
  }

  /** Applies a name/status change for a channel override or a primary template. */
  async function applyEditor(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    scope: EditorScope,
    field: EditorField,
    channelId: string,
    value: string,
  ): Promise<
    | { ok: true; state: EditorState; opts: { updated: true; note?: string } }
    | { ok: false; message: string }
  > {
    const guildId = interaction.guildId!;
    const admin = hasManageChannels(interaction);
    let result: CommandResult;
    if (scope === 'channel') {
      const userId = interaction.user.id;
      result = await run(guildId, `editor:channel:${field}`, () =>
        field === 'name'
          ? deps.voiceCommands.setName(guildId, channelId, userId, value, { admin })
          : deps.voiceCommands.setStatus(guildId, channelId, userId, value, { admin }),
      );
    } else {
      result = await run(guildId, `editor:primary:${field}`, () =>
        field === 'name'
          ? deps.settings.setTemplate(guildId, channelId, value)
          : deps.settings.setStatusTemplate(guildId, channelId, value),
      );
      if (result.ok) {
        const summary = await run(guildId, 'editor:primary:render', () =>
          deps.feature.rerenderSiblings(guildId, channelId),
        );
        result = { ok: true, message: result.message + rateLimitNote(summary.rateLimited) };
      }
    }
    if (!result.ok) return { ok: false, message: result.message };
    const state = await run(guildId, 'editor:refresh', () =>
      deps.feature.getEditorState(scope, guildId, channelId),
    );
    return {
      ok: true,
      state,
      opts: { updated: true, ...(result.message ? { note: result.message } : {}) },
    };
  }

  function hasManageChannels(interaction: Interaction): boolean {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) ?? false;
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

  /** `/create` (and the "Create another" button) → open the setup modal. */
  async function openCreateModal(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await deps.guilds.isEntitled(guildId, deps.selfHosted))) {
      await interaction.reply({
        content: 'This server isn’t currently entitled.',
        ephemeral: true,
      });
      return;
    }
    if (!hasManageChannels(interaction)) {
      await interaction.reply({
        content: 'You need the Manage Channels permission.',
        ephemeral: true,
      });
      return;
    }
    // Prefill the template fields with the guild's current defaults (a quick read,
    // well within the 3s window before showModal — which must be the first response).
    const config = await deps.settings.getConfig(guildId);
    await interaction.showModal(
      buildCreateModal({
        nameTemplate: config.defaultTemplate,
        statusTemplate: config.defaultStatus,
      }),
    );
  }

  /** The `/create` modal submit: create the primary from the selections, confirm. */
  async function handleCreateSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await isEntitledOrReject(interaction, guildId))) return;
    const config = await deps.settings.getConfig(guildId);
    const opts = parseCreateModal(interaction.fields, {
      nameTemplate: config.defaultTemplate,
      statusTemplate: config.defaultStatus,
    });
    const result = await run(guildId, 'create:submit', () =>
      deps.settings.createPrimary(guildId, opts),
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(CREATE_AGAIN_ID)
        .setLabel('Create another')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: `${result.ok ? '✅' : '⚠️'} ${result.message}`,
      components: [row],
      ephemeral: true,
    });
  }

  async function isEntitledOrReject(
    interaction: ModalSubmitInteraction,
    guildId: string,
  ): Promise<boolean> {
    if (await deps.guilds.isEntitled(guildId, deps.selfHosted)) return true;
    await interaction.reply({ content: 'This server isn’t currently entitled.', ephemeral: true });
    return false;
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
    if (interaction.customId === CREATE_AGAIN_ID) return openCreateModal(interaction);
    if (interaction.customId.startsWith(KICK_PREFIX)) return handleKickVote(interaction);
    if (interaction.customId.startsWith(JOIN_PREFIX)) return handleJoinDecision(interaction);
    if (interaction.customId.startsWith(EDITOR_PREFIX)) return handleEditorButton(interaction);
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
    if (interaction.customId === CREATE_MODAL_ID) return handleCreateSubmit(interaction);
    if (interaction.customId.startsWith(POSITION_MODAL_PREFIX)) {
      const channelId = positionChannelId(interaction.customId);
      if (channelId) return handlePositionSubmit(interaction, channelId);
    }
    if (interaction.customId.startsWith(INHERIT_MODAL_PREFIX)) {
      const channelId = inheritChannelId(interaction.customId);
      if (channelId) return handleInheritSubmit(interaction, channelId);
    }
    if (interaction.customId === LOGGING_MODAL_ID) return handleLoggingSubmit(interaction);
    if (interaction.customId.startsWith(EDITOR_PREFIX)) return handleEditorModal(interaction);
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
