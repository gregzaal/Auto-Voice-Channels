import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { GuildRepository, Logger, ManagedChannelRepository } from '@avc/core';
import type { GuildDispatcher } from '../runtime/dispatcher.js';
import {
  isPermissionError,
  JOIN_PREFIX,
  parseJoinId,
  rateLimitNote,
  type ChannelDebug,
  type CommandResult,
  type EditorField,
  type EditorScope,
  type EditorState,
  type GuildSettingsService,
  type PermissionProblemTracker,
  type PrivacyService,
  type VoiceCommands,
  type VoiceFeature,
  type VoteKickManager,
} from '../features/voice/index.js';
import { ALIAS_MODAL_ID, buildAliasModal, parseAliasModal } from './aliasModal.js';
import {
  ALL_REQUIRED_PERMISSION_LABELS,
  buildChannelPickerMessage,
  buildGeneralModal,
  buildSetupPanel,
  channelPickerRow,
  formatPlan,
  GENERAL_MODAL_ID,
  missingBotPermissions,
  parseSetupPick,
  SETUP_PREFIX,
} from './setupPanel.js';
import {
  ADOPT_PREFIX,
  buildAdoptPrompt,
  buildEditorModal,
  EDITOR_PREFIX,
  parseAdoptId,
  parseEditorId,
  renderEditorPanel,
} from './templatePanel.js';
import {
  buildCreateModal,
  CREATE_AGAIN_ID,
  CREATE_MODAL_ID,
  CREATE_RETRY_PREFIX,
  parseCreateModal,
  readCreateModalRaw,
  type CreatePrefill,
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
import {
  buildGroupDisablePanel,
  buildGroupEnablePanel,
  GROUP_PREFIX,
  parseGroupId,
} from './groupPanel.js';
import { groupKeyFor, ROOT_GROUP_KEY } from '../features/voice/guildSettings.js';
import { describeError } from '../ops/describeError.js';

export interface InteractionDeps {
  client: Client;
  dispatcher: GuildDispatcher;
  voiceCommands: VoiceCommands;
  settings: GuildSettingsService;
  votekick: VoteKickManager;
  privacy: PrivacyService;
  feature: VoiceFeature;
  guilds: GuildRepository;
  managed: ManagedChannelRepository;
  /** Recent "I lost access to this channel" incidents, surfaced in `/setup`. */
  permissionProblems?: PermissionProblemTracker;
  selfHosted: boolean;
  /** Discord application id, for building the `/invite` link. */
  clientId: string;
  logger: Logger;
  /** Optional sink for significant interaction failures (admin reporting). */
  reportError?: (message: string, context?: Record<string, unknown>) => void;
}

const KICK_PREFIX = 'avc:kick:';
const VOTE_TIMEOUT_MS = 2 * 60 * 1000;
/** How long a failed-`/create`'s saved selections stay retry-able (in memory). */
const CREATE_RETRY_TTL_MS = 15 * 60 * 1000;

/** Interactions that can drive the "manage a channel" flow (command + components). */
type ManageableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ChannelSelectMenuInteraction;

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
  // Saved `/create` selections, keyed by the failing interaction's id, so the
  // "Retry" button can re-open the modal with the user's choices intact.
  const createRetries = new Map<string, { prefill: CreatePrefill; expiresAt: number }>();

  const onInteraction = (interaction: Interaction): void => {
    void route(interaction).catch((err: unknown) => {
      deps.logger.error({ err }, 'interaction handling failed');
      deps.reportError?.('Interaction handling failed', {
        guildId: interaction.guildId ?? undefined,
        type: interaction.type,
        error: String(err),
      });
      void safeReply(interaction, `⚠️ Something went wrong handling that: ${describeError(err)}`);
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
    if (interaction.isChannelSelectMenu()) return handleChannelSelect(interaction);
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
            deps.privacy.makePrivate(guildId, channelId, userId),
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
      case 'alwaysprivate':
        return handleAlwaysPrivate(interaction);
      case 'group':
        return openGroupPanel(interaction);
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
      case 'alias':
        return openAliasModal(interaction);
      case 'setup':
        return openSetup(interaction);
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
    }
  }

  // -- /name + /template editor panel --------------------------------------

  async function openTemplatePanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'manage',
      '🛠️ Pick a voice channel to manage:',
    );
    if (!channelId) return;
    await manageChannelCore(interaction, channelId);
  }

  /**
   * The "manage a channel" flow, reusable from `/template`, the `/setup`
   * "Manage a channel" button, and the channel picker. Routes to the right
   * editor for what the channel *is*: a creator-channel secondary edits the
   * primary's templates; an adopted standalone edits its own; anything else is
   * offered for adoption. Responds in place via {@link respond} (a fresh reply
   * for a command, an in-place update for a component interaction).
   */
  async function manageChannelCore(
    interaction: ManageableInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    // A creator channel's secondary → edit the primary's templates (the usual case).
    const primaryState = await run(guildId, 'cmd:template', () =>
      deps.feature.getEditorState('primary', guildId, channelId),
    );
    if (primaryState.found) {
      return respond(interaction, renderEditorPanel('primary', channelId, primaryState));
    }
    // Already an adopted standalone channel → edit its templates.
    const managedState = await run(guildId, 'cmd:template:managed', () =>
      deps.feature.getManagedEditorState(guildId, channelId),
    );
    if (managedState.found) {
      return respond(interaction, renderEditorPanel('adopted', channelId, managedState));
    }
    // An otherwise-unmanaged voice channel → offer to adopt it (explicit confirm).
    const name = interaction.guild?.channels.cache.get(channelId)?.name ?? 'this channel';
    return respond(interaction, buildAdoptPrompt(channelId, name));
  }

  /** `/position` → act on the channel you're in, else pick one. */
  async function openPositionModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'position',
      '↕️ Pick a creator channel to position:',
    );
    if (!channelId) return;
    await positionCore(interaction, channelId);
  }

  /** Opens the above/below modal for a creator channel (or its whole group). */
  async function positionCore(
    interaction: ManageableInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    // If this channel's category is grouped, /position sets the whole group's direction.
    const categoryKey = categoryKeyForChannel(interaction, channelId);
    const group = await run(guildId, 'cmd:position:group', () =>
      deps.settings.getGroup(guildId, categoryKey),
    );
    if (group) {
      await interaction.showModal(buildPositionModal(channelId, group.above));
      return;
    }
    const pos = await run(guildId, 'cmd:position', () =>
      deps.settings.getPosition(guildId, channelId),
    );
    if (!pos.found) {
      return respond(interaction, {
        content: 'This isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
    }
    await interaction.showModal(buildPositionModal(channelId, pos.above));
  }

  /**
   * The `/position` modal submit. For a **grouped** category it sets the group's
   * direction and re-syncs the whole group; otherwise it persists the per-primary
   * choice and repositions that primary's secondaries (only when it changed).
   */
  async function handlePositionSubmit(
    interaction: ModalSubmitInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await requireManageChannels(interaction))) return;
    const above = parsePositionModal(interaction.fields);

    const categoryKey = categoryKeyForChannel(interaction, channelId);
    const group = await run(guildId, 'cmd:position:group:get', () =>
      deps.settings.getGroup(guildId, categoryKey),
    );
    if (group) {
      const summary = await run(guildId, 'cmd:position:group:set', async () => {
        await deps.settings.setGroup(guildId, categoryKey, above);
        return deps.feature.resyncCategory(guildId, categoryKey);
      });
      await interaction.reply({
        content:
          `✅ This category’s channels are now grouped **${above ? 'above' : 'below'}** the ` +
          `creator channels.${rateLimitNote(summary.rateLimited)}`,
        ephemeral: true,
      });
      return;
    }

    // Read → set → reposition in ONE dispatched task so it's ordered atomically
    // against other guild work (no interleaving between the read and the writes).
    const { res, moved } = await run(guildId, 'cmd:position', async () => {
      const before = await deps.settings.getPosition(guildId, channelId);
      const result = await deps.settings.setPosition(guildId, channelId, above);
      const count =
        result.ok && before.primaryChannelId && before.above !== above
          ? await deps.feature.repositionSecondaries(guildId, before.primaryChannelId, above)
          : 0;
      return { res: result, moved: count };
    });
    const message =
      moved > 0
        ? `${res.message} Moved ${moved} existing channel${moved === 1 ? '' : 's'}.`
        : res.message;
    await interaction.reply({
      content: `${res.ok ? '✅' : '⚠️'} ${message}`,
      ephemeral: true,
    });
  }

  /** `/alwaysprivate` → toggle default-private for a creator channel (yours, or picked). */
  async function handleAlwaysPrivate(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'alwaysprivate',
      '🔒 Pick a creator channel to toggle default-private:',
    );
    if (!channelId) return;
    await alwaysPrivateCore(interaction, channelId);
  }

  async function alwaysPrivateCore(
    interaction: ManageableInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const res = await run(guildId, 'cmd:alwaysprivate', () =>
      deps.settings.toggleDefaultPrivate(guildId, channelId),
    );
    await respond(interaction, { content: formatResult(res), ephemeral: true });
  }

  /** `/group` → explain + confirm grouping (or offer to turn it off) for this category. */
  async function openGroupPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'group',
      '🧱 Pick a voice channel in the category you want to group:',
    );
    if (!channelId) return;
    await groupCore(interaction, channelId);
  }

  async function groupCore(interaction: ManageableInteraction, channelId: string): Promise<void> {
    const guildId = interaction.guildId!;
    const categoryKey = categoryKeyForChannel(interaction, channelId);
    const primaryIds = await run(guildId, 'cmd:group:info', () =>
      deps.feature.categoryPrimaryIds(guildId, categoryKey),
    );
    if (primaryIds.length === 0) {
      return respond(interaction, {
        content:
          'This category has no creator channels to group. Pick (or join) a voice channel in ' +
          'the category you want to group, then run `/group` again.',
        ephemeral: true,
      });
    }
    const categoryName =
      categoryKey === ROOT_GROUP_KEY
        ? null
        : (interaction.guild?.channels.cache.get(categoryKey)?.name ?? null);
    const group = await run(guildId, 'cmd:group:get', () =>
      deps.settings.getGroup(guildId, categoryKey),
    );
    await respond(
      interaction,
      group
        ? buildGroupDisablePanel(categoryKey, categoryName, group.above)
        : buildGroupEnablePanel(categoryKey, categoryName, primaryIds.length),
    );
  }

  /** The `/group` buttons: enable (below/above), turn off, or cancel. */
  async function handleGroupButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseGroupId(interaction.customId);
    if (!parsed) return;
    const guildId = interaction.guildId!;
    const { action, categoryKey } = parsed;
    if (action === 'cancel') {
      await interaction.update({
        content: 'Cancelled — nothing changed.',
        embeds: [],
        components: [],
      });
      return;
    }
    const enabling = action !== 'off';
    const above = action === 'above';
    const summary = await run(guildId, `group:${action}`, async () => {
      await deps.settings.setGroup(guildId, categoryKey, enabling ? above : null);
      return deps.feature.resyncCategory(guildId, categoryKey);
    });
    const note = rateLimitNote(summary.rateLimited);
    const message = enabling
      ? `✅ Grouped this category’s channels **${above ? 'above' : 'below'}** the creator ` +
        `channels${summary.considered ? ` (${summary.considered} channel${summary.considered === 1 ? '' : 's'})` : ''}.${note}`
      : `✅ Turned grouping off — each creator channel goes back to its own numbering and ` +
        `placement.${note}`;
    await interaction.update({ content: message, embeds: [], components: [] });
  }

  /** `/inheritpermissions` → choose the permission source for a creator channel. */
  async function openInheritModal(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'inheritpermissions',
      '🔑 Pick a creator channel to set permission inheritance:',
    );
    if (!channelId) return;
    await inheritCore(interaction, channelId);
  }

  async function inheritCore(interaction: ManageableInteraction, channelId: string): Promise<void> {
    const guildId = interaction.guildId!;
    const pos = await run(guildId, 'cmd:inherit', () =>
      deps.settings.getPosition(guildId, channelId),
    );
    if (!pos.found) {
      return respond(interaction, {
        content: 'This isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
    }
    await interaction.showModal(buildInheritModal(channelId));
  }

  /** The `/inheritpermissions` modal submit. */
  async function handleInheritSubmit(
    interaction: ModalSubmitInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await requireManageChannels(interaction))) return;
    const source = parseInheritModal(interaction.fields);
    const res = await run(guildId, 'cmd:inheritpermissions', () =>
      deps.settings.setInheritPermissions(guildId, channelId, source),
    );
    await interaction.reply({
      content: formatResult(res),
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
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseLoggingModal(interaction.fields);
    const target = parsed.disable ? null : (parsed.channelId ?? interaction.channelId);
    // Validate the bot can actually post to the chosen/fallback channel before saving.
    if (target !== null && !canPostTo(interaction, target)) {
      await interaction.reply({
        content: 'I can’t post there — pick a text channel I can send messages in.',
        ephemeral: true,
      });
      return;
    }
    const res = await run(guildId, 'cmd:logging', () =>
      deps.settings.setLogging(guildId, target, parsed.level),
    );
    await interaction.reply({
      content: formatResult(res),
      ephemeral: true,
    });
  }

  /** Whether the bot can view + send messages in `channelId` (a guild text channel). */
  function canPostTo(interaction: ModalSubmitInteraction, channelId: string): boolean {
    const channel = interaction.guild?.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return false;
    const me = interaction.guild?.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    return (
      (perms?.has(PermissionFlagsBits.ViewChannel) &&
        perms.has(PermissionFlagsBits.SendMessages)) ??
      false
    );
  }

  async function openNamePanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const target = await resolveOrPick(interaction, 'name', '✏️ Pick a voice channel to rename:');
    if (!target) return;
    await nameCore(interaction, target);
  }

  async function nameCore(interaction: ManageableInteraction, channelId: string): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const state = await run(guildId, 'cmd:name', () =>
      deps.feature.getEditorState('channel', guildId, channelId),
    );
    if (!state.found) {
      return respond(interaction, {
        content: 'That isn’t a bot-managed voice channel.',
        ephemeral: true,
      });
    }
    // Anyone may edit their own channel; editing another's needs admin.
    if (!hasManageChannels(interaction) && state.ownerId && state.ownerId !== userId) {
      return respond(interaction, {
        content: 'Only the channel’s owner or a server admin can edit it.',
        ephemeral: true,
      });
    }
    await respond(interaction, renderEditorPanel('channel', channelId, state));
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
      // The channel may have been deleted / unmanaged since the panel opened.
      if (!state.found) {
        await interaction.reply({
          content: 'That channel is no longer bot-managed.',
          ephemeral: true,
        });
        return;
      }
      await interaction.showModal(buildEditorModal(scope, field, channelId, state));
      return;
    }
    if (action === 'reset') {
      // Defer first: the rerender can hit the rate-limit probe and brush the 3s ack.
      await interaction.deferUpdate();
      await refreshEditorPanel(interaction, scope, field, channelId, 'reset');
      return;
    }
    if (action === 'stop') {
      // Adopted channels only: stop managing the name and close the panel.
      const res = await run(interaction.guildId!, 'editor:stop', () =>
        deps.feature.stopManaging(interaction.guildId!, channelId),
      );
      await interaction.update({ content: formatResult(res), embeds: [], components: [] });
    }
  }

  /** The "AVC will manage this channel's name" confirm/cancel buttons (`/template`). */
  async function handleAdoptButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseAdoptId(interaction.customId);
    if (!parsed) return;
    const guildId = interaction.guildId!;
    const { action, channelId } = parsed;
    if (action === 'cancel') {
      await interaction.update({
        content: 'Cancelled — AVC won’t manage this channel.',
        embeds: [],
        components: [],
      });
      return;
    }
    if (!(await deps.guilds.isEntitled(guildId, deps.selfHosted))) {
      await interaction.update({
        content: 'This server isn’t currently entitled.',
        embeds: [],
        components: [],
      });
      return;
    }
    const name = interaction.guild?.channels.cache.get(channelId)?.name ?? 'this channel';
    const res = await run(guildId, 'adopt:confirm', () =>
      deps.feature.adoptChannel(guildId, channelId, name),
    );
    if (!res.ok) {
      await interaction.update({ content: formatResult(res), embeds: [], components: [] });
      return;
    }
    // Drop straight into the managed-channel editor so they can tweak the template.
    const state = await run(guildId, 'adopt:state', () =>
      deps.feature.getManagedEditorState(guildId, channelId),
    );
    await interaction.update(
      toUpdate(
        renderEditorPanel('adopted', channelId, state, { updated: true, note: res.message }),
      ),
    );
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
    } else if (scope === 'adopted') {
      // Adopted standalone channel: edit + re-render happen inside the feature.
      result = await run(guildId, `editor:adopted:${field}`, () =>
        field === 'name'
          ? deps.feature.setManagedName(guildId, channelId, value)
          : deps.feature.setManagedStatus(guildId, channelId, value),
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

  /** Best-effort: posts `content` into a channel by id (no-op if it can't). */
  async function notifyChannel(client: Client, channelId: string, content: string): Promise<void> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && 'send' in channel) {
      await channel.send(content).catch(() => undefined);
    }
  }

  /** Gate an admin action: replies with the permission notice and returns false if lacking it. */
  async function requireManageChannels(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | ChannelSelectMenuInteraction
      | ModalSubmitInteraction,
  ): Promise<boolean> {
    if (hasManageChannels(interaction)) return true;
    await interaction.reply({
      content: 'You need the Manage Channels permission.',
      ephemeral: true,
    });
    return false;
  }

  async function handlePing(interaction: ChatInputCommandInteraction): Promise<void> {
    const ws = Math.round(deps.client.ws.ping);
    await interaction.reply({ content: '🏓 Pinging…', ephemeral: true });
    const sent = await interaction.fetchReply();
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
    if (!(await requireManageChannels(interaction))) return;
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
    if (!(await requireManageChannels(interaction))) return;
    if (!(await isEntitledOrReject(interaction, guildId))) return;
    const config = await deps.settings.getConfig(guildId);
    const defaults = { nameTemplate: config.defaultTemplate, statusTemplate: config.defaultStatus };
    const prefill = readCreateModalRaw(interaction.fields);
    const opts = parseCreateModal(interaction.fields, defaults);
    // Catch a permissions failure *inside* the task: nothing is persisted before the
    // create throws, so it's an expected, deterministic config error that shouldn't
    // trip the guild's circuit breaker — and we want to offer a tailored retry.
    const outcome = await run(guildId, 'create:submit', async () => {
      try {
        return { ok: true as const, result: await deps.settings.createPrimary(guildId, opts) };
      } catch (err) {
        if (isPermissionError(err)) return { ok: false as const, err };
        throw err;
      }
    });
    if (!outcome.ok) {
      await replyCreatePermissionError(interaction, prefill, outcome.err);
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(CREATE_AGAIN_ID)
        .setLabel('Create another')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: formatResult(outcome.result),
      components: [row],
      ephemeral: true,
    });
  }

  /**
   * The chosen category (or the guild) refused the create for lack of permission.
   * Reply with exactly which permissions I'm missing there — and which I do hold —
   * plus a "Retry" button that re-opens the modal with their selections intact.
   */
  async function replyCreatePermissionError(
    interaction: ModalSubmitInteraction,
    prefill: CreatePrefill,
    err: unknown,
  ): Promise<void> {
    const me = interaction.guild?.members.me ?? null;
    const category =
      prefill.parentId != null
        ? (interaction.guild?.channels.cache.get(prefill.parentId) ?? null)
        : null;
    // Resolve permissions where the channel would land: inside the chosen category
    // (base perms + that category's overrides) or, with no category, guild-wide.
    const has = (flag: bigint): boolean => {
      if (!me) return false;
      if (category && 'permissionsFor' in category) {
        return category.permissionsFor(me)?.has(flag) ?? false;
      }
      return me.permissions.has(flag);
    };
    const missing = missingBotPermissions(has);
    const held = ALL_REQUIRED_PERMISSION_LABELS.filter((l) => !missing.includes(l));
    const where = category ? ` in **${category.name}**` : '';

    const lines = [`⚠️ I couldn’t create the creator channel${where}.`];
    if (missing.length) {
      lines.push(`I’m missing these permissions: **${missing.join('**, **')}**.`);
      if (held.length) lines.push(`Permissions I already have: ${held.join(', ')}.`);
      lines.push(
        category
          ? 'Grant me those permissions on that category (or server-wide), then hit **Retry**.'
          : 'Grant me those permissions, then hit **Retry**.',
      );
    } else {
      // Discord refused but my base perms look fine — a role/channel override is the
      // likely culprit. Surface the raw detail so it's still actionable.
      lines.push(
        `Discord refused with: ${describeError(err)}. A role or channel override may be ` +
          'blocking me — adjust it, then hit **Retry**.',
      );
    }
    lines.push('_Your selections are saved._');

    const token = interaction.id;
    pruneCreateRetries();
    createRetries.set(token, { prefill, expiresAt: Date.now() + CREATE_RETRY_TTL_MS });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CREATE_RETRY_PREFIX}${token}`)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary),
    );
    await interaction.reply({ content: lines.join('\n'), components: [row], ephemeral: true });
  }

  /** "Retry" after a failed `/create`: re-open the modal with the saved selections. */
  async function handleCreateRetry(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await deps.guilds.isEntitled(guildId, deps.selfHosted))) {
      await interaction.reply({
        content: 'This server isn’t currently entitled.',
        ephemeral: true,
      });
      return;
    }
    if (!(await requireManageChannels(interaction))) return;
    pruneCreateRetries();
    const saved = createRetries.get(interaction.customId.slice(CREATE_RETRY_PREFIX.length));
    const config = await deps.settings.getConfig(guildId);
    const defaults = { nameTemplate: config.defaultTemplate, statusTemplate: config.defaultStatus };
    // The saved prefill expires (and is lost on restart); fall back to the guild
    // defaults so Retry still opens a usable modal.
    await interaction.showModal(buildCreateModal(defaults, saved?.prefill));
  }

  /** Drops expired saved-create entries so the map stays bounded. */
  function pruneCreateRetries(): void {
    const now = Date.now();
    for (const [token, entry] of createRetries) {
      if (entry.expiresAt <= now) createRetries.delete(token);
    }
  }

  async function isEntitledOrReject(
    interaction: ModalSubmitInteraction,
    guildId: string,
  ): Promise<boolean> {
    if (await deps.guilds.isEntitled(guildId, deps.selfHosted)) return true;
    await interaction.reply({ content: 'This server isn’t currently entitled.', ephemeral: true });
    return false;
  }

  /** `/alias` → a modal to alias a game name, prefilled with your current game. */
  async function openAliasModal(interaction: ChatInputCommandInteraction): Promise<void> {
    // Admin-gated by Discord; the modal submit re-gates. Prefill from presence.
    await interaction.showModal(buildAliasModal(currentGameName(interaction)));
  }

  // -- /setup : the primary entry point ------------------------------------

  /** Gathers everything the `/setup` panel shows for this guild + viewer. */
  async function buildSetupReply(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
  ): Promise<InteractionReplyOptions> {
    const guildId = interaction.guildId!;
    const [config, managedRows, guildRow] = await Promise.all([
      run(guildId, 'setup:config', () => deps.settings.getConfig(guildId)),
      run(guildId, 'setup:managed', () => deps.managed.listByGuild(guildId)),
      deps.guilds.get(guildId),
    ]);
    const me = interaction.guild?.members.me ?? null;
    const missingPermissions = me
      ? missingBotPermissions((flag) => me.permissions.has(flag))
      : ALL_REQUIRED_PERMISSION_LABELS;
    const plan = formatPlan({
      memberCount: interaction.guild?.memberCount ?? 0,
      status: guildRow?.authStatus ?? 'trial',
      expiresAt: guildRow?.authExpiresAt ?? null,
      selfHosted: deps.selfHosted,
      now: new Date(),
    });
    return buildSetupPanel({
      enabled: config.enabled,
      isAdmin: hasManageChannels(interaction),
      plan,
      missingPermissions,
      primaries: config.primaries,
      managed: managedRows,
      problems: deps.permissionProblems?.recent(guildId) ?? [],
    });
  }

  async function openSetup(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply(await buildSetupReply(interaction));
  }

  /** Re-render the (already-open) setup panel in place after a panel action. */
  async function refreshSetupPanel(interaction: ButtonInteraction): Promise<void> {
    await interaction.update(toUpdate(await buildSetupReply(interaction)));
  }

  /** The `/setup` panel buttons. (`lang` is disabled and never fires.) */
  async function handleSetupButton(interaction: ButtonInteraction): Promise<void> {
    const action = interaction.customId.slice(SETUP_PREFIX.length);
    // Create runs its own entitlement + permission gating (and opens a modal).
    if (action === 'create') return openCreateModal(interaction);
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    if (action === 'toggle') {
      await run(guildId, 'setup:toggle', async () => {
        const config = await deps.settings.getConfig(guildId);
        return deps.settings.setEnabled(guildId, !config.enabled);
      });
      await refreshSetupPanel(interaction);
      return;
    }
    if (action === 'logging') {
      const current = await run(guildId, 'setup:logging:get', () =>
        deps.settings.getLogging(guildId),
      );
      await interaction.showModal(buildLoggingModal(current));
      return;
    }
    if (action === 'general') {
      const config = await run(guildId, 'setup:general:get', () =>
        deps.settings.getConfig(guildId),
      );
      await interaction.showModal(buildGeneralModal(config.general));
      return;
    }
    if (action === 'manage') {
      // House style: act on the channel you're in, else offer a picker.
      const channelId = currentVoiceChannelId(interaction);
      if (channelId) return manageChannelCore(interaction, channelId);
      await interaction.update(
        buildChannelPickerMessage('manage', '🛠️ Pick a voice channel to manage:'),
      );
      return;
    }
  }

  // Picker commands that require Manage Channels (the open `name` command self-gates
  // on channel ownership in nameCore, so it isn't listed here).
  const ADMIN_PICK_COMMANDS = new Set([
    'manage',
    'position',
    'alwaysprivate',
    'inheritpermissions',
    'group',
  ]);

  /** A voice-channel was chosen from a `avc:setup:pick:<command>` menu → run the command. */
  async function handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    const command = parseSetupPick(interaction.customId);
    if (!command) return;
    const channelId = interaction.values[0];
    if (!channelId) return;
    if (ADMIN_PICK_COMMANDS.has(command) && !(await requireManageChannels(interaction))) return;
    switch (command) {
      case 'manage':
        return manageChannelCore(interaction, channelId);
      case 'position':
        return positionCore(interaction, channelId);
      case 'alwaysprivate':
        return alwaysPrivateCore(interaction, channelId);
      case 'inheritpermissions':
        return inheritCore(interaction, channelId);
      case 'group':
        return groupCore(interaction, channelId);
      case 'name':
        return nameCore(interaction, channelId);
    }
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
    // `start` only succeeds with a channel, so narrow explicitly (no `!`).
    if (!channelId) return;
    if (!deps.votekick.hasSession(channelId)) {
      // Resolved immediately (1v1) — already kicked.
      await interaction.reply({ content: `✅ ${result.message}` });
      return;
    }
    // Arm the lapse timer (tagged with the session epoch) before replying, so a
    // concurrent vote resolution can't race an un-armed timer.
    armVoteTimeout(channelId, result.epoch);
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
  }

  async function handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId === CREATE_AGAIN_ID) return openCreateModal(interaction);
    if (interaction.customId.startsWith(CREATE_RETRY_PREFIX)) return handleCreateRetry(interaction);
    if (interaction.customId.startsWith(KICK_PREFIX)) return handleKickVote(interaction);
    if (interaction.customId.startsWith(JOIN_PREFIX)) return handleJoinDecision(interaction);
    if (interaction.customId.startsWith(ADOPT_PREFIX)) return handleAdoptButton(interaction);
    if (interaction.customId.startsWith(GROUP_PREFIX)) return handleGroupButton(interaction);
    if (interaction.customId.startsWith(EDITOR_PREFIX)) return handleEditorButton(interaction);
    if (interaction.customId.startsWith(SETUP_PREFIX)) return handleSetupButton(interaction);
  }

  /** Owner approves/denies/blocks a "⇩ Join" request via the message buttons. */
  async function handleJoinDecision(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const parsed = parseJoinId(interaction.customId);
    if (!parsed) return;
    const { action, joinChannelId, requesterId } = parsed;

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
      content: formatResult(result),
      components: [],
    });
    // The requester can't see the private channel, so post the rejection outcome
    // to the public "⇩ Join" companion's chat (which they can see). On approve
    // they're pulled into the channel, so no companion message is needed. Note a
    // *blocked* user loses access to the companion too, so may not see it — that's
    // inherent to blocking.
    if (result.ok && action !== 'approve') {
      await notifyChannel(
        deps.client,
        joinChannelId,
        action === 'block'
          ? `⛔ <@${requesterId}>, your request to join was blocked.`
          : `🚫 <@${requesterId}>, your request to join was declined.`,
      );
    }
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
    if (interaction.customId === GENERAL_MODAL_ID) return handleGeneralSubmit(interaction);
    if (interaction.customId === ALIAS_MODAL_ID) return handleAliasSubmit(interaction);
  }

  /** The `/setup` "no game" label modal submit. */
  async function handleGeneralSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const res = await run(guildId, 'setup:general', () =>
      deps.settings.setGeneral(guildId, interaction.fields.getTextInputValue('label')),
    );
    await interaction.reply({ content: formatResult(res), ephemeral: true });
  }

  /** The `/alias` modal submit. */
  async function handleAliasSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const { game, alias } = parseAliasModal(interaction.fields);
    const res = await run(guildId, 'cmd:alias', () => deps.settings.addAlias(guildId, game, alias));
    await interaction.reply({ content: formatResult(res), ephemeral: true });
  }

  // -- helpers --------------------------------------------------------------

  /** Routes guild work through the per-guild queue (ordering + isolation). */
  function run<T>(guildId: string, name: string, task: () => Promise<T>): Promise<T> {
    return deps.dispatcher.dispatch(guildId, name, task);
  }

  function armVoteTimeout(channelId: string, epoch?: number): void {
    clearVoteTimeout(channelId);
    const timer = setTimeout(() => {
      // Pass the epoch so a lapsed timer only cancels *its* session, never a
      // newer vote that started on the same channel in the meantime.
      deps.votekick.cancel(channelId, epoch);
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
    createRetries.clear();
  };
}

function currentVoiceChannelId(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ChannelSelectMenuInteraction,
): string | undefined {
  // `interaction.member` may be the raw API shape (no `.voice`) when uncached;
  // use it only when it's a real GuildMember, else resolve from the guild cache.
  if (interaction.member instanceof GuildMember) {
    return interaction.member.voice.channelId ?? undefined;
  }
  return interaction.guild?.members.cache.get(interaction.user.id)?.voice.channelId ?? undefined;
}

/** The caller's current game (Playing/Streaming activity name), if any — for `/alias` prefill. */
function currentGameName(interaction: ChatInputCommandInteraction): string | undefined {
  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : interaction.guild?.members.cache.get(interaction.user.id);
  const activity = member?.presence?.activities.find(
    (a) => a.type === ActivityType.Playing || a.type === ActivityType.Streaming,
  );
  return activity?.name;
}

/** The grouping `categoryKey` for a channel: its parent category id, or the root sentinel. */
function categoryKeyForChannel(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ChannelSelectMenuInteraction
    | ModalSubmitInteraction,
  channelId: string,
): string {
  const channel = interaction.guild?.channels.cache.get(channelId);
  return groupKeyFor(channel && 'parentId' in channel ? channel.parentId : null);
}

/**
 * House style for channel-targeting commands: act on the channel you're in; if
 * you're not in one, reply with a voice-channel picker (`command → pick →
 * execute`) instead of dead-ending. Returns the channel id to act on, or
 * undefined when it showed the picker (the chosen channel arrives later via the
 * `avc:setup:pick:<command>` select menu).
 */
async function resolveOrPick(
  interaction: ChatInputCommandInteraction,
  command: string,
  prompt: string,
): Promise<string | undefined> {
  const channelId = currentVoiceChannelId(interaction);
  if (channelId) return channelId;
  await interaction.reply({
    content: prompt,
    components: [channelPickerRow(command)],
    ephemeral: true,
  });
  return undefined;
}

/** Standard `✅/⚠️ message` formatting for a CommandResult reply. */
function formatResult(result: CommandResult): string {
  return `${result.ok ? '✅' : '⚠️'} ${result.message}`;
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
  await interaction.reply({ content: formatResult(result), ephemeral: true });
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

/** Strips `ephemeral` (invalid on `update`/`editReply`) but keeps embeds/components. */
function toUpdate(
  reply: InteractionReplyOptions,
): Pick<InteractionUpdateOptions, 'embeds' | 'components'> {
  return { embeds: reply.embeds ?? [], components: reply.components ?? [] };
}

/**
 * Responds to a manage-flow interaction in place: a fresh ephemeral reply for a
 * slash command, or an in-place edit of the existing message for a button /
 * channel-select (so the panel transforms rather than stacking a new message).
 */
async function respond(
  interaction: ManageableInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await interaction.reply(payload);
  } else {
    // An in-place edit: carry content too (a `null` clears any prior prompt text,
    // e.g. the channel-picker question, when swapping in an embed-only panel).
    await interaction.update({
      content: payload.content ?? null,
      embeds: payload.embeds ?? [],
      components: payload.components ?? [],
    });
  }
}
