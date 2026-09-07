import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  isEntitled,
  RUNTIME_FLAGS,
  type AutoChannelRepository,
  type Database,
  type Fleet,
  type GuildRepository,
  type Logger,
  type ManagedChannelRepository,
  type OpsAuditRepository,
  type RuntimeFlagsRepository,
} from '@avc/core';
import type { GuildDispatcher } from '../runtime/dispatcher.js';
import { COMMIT, VERSION } from '../version.js';
import {
  handleExport,
  handleImportButton,
  handleImportCommand,
  type ImportCommandDeps,
  type ImportCounters,
} from './importCommand.js';
import { IMPORT_PREFIX, type ImportSessionStore } from './importPanel.js';
import {
  expiredInteractionMessage,
  SITE_URL,
  STATUS_PAGE_URL,
} from '../features/billing/messages.js';
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
  buildChannelInfoView,
  CHANNELINFO_PREFIX,
  parseInfoId,
  type ChannelInfoPanelInput,
} from './channelInfoPanel.js';
import {
  ALIAS_INPUT_MAX,
  ALIAS_PREFIX,
  ALIAS_SELECT_ID,
  buildAliasDetailPanel,
  buildAliasEditModal,
  buildAliasListPanel,
  findAliasByHash,
  parseAliasEditModal,
  parseAliasId,
} from './aliasPanel.js';
import {
  ALL_REQUIRED_PERMISSION_LABELS,
  buildChannelPickerMessage,
  buildGeneralModal,
  buildSetupPanel,
  channelPickerRow,
  formatPlan,
  GENERAL_MODAL_ID,
  GITHUB_URL,
  missingBotPermissions,
  missingRenamePermissions,
  parseSetupPick,
  parseSetupPickArg,
  SETUP_PREFIX,
  SETUP_SETTINGS_ID,
  setupId,
  type SetupEntitlement,
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
  CREATE_FROM_SETUP_MODAL_ID,
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
  buildListDetailPanel,
  buildListEditModal,
  buildListsPanel,
  findList,
  LISTS_PREFIX,
  LISTS_SELECT_ID,
  parseListEditModal,
  parseListsId,
} from './listsPanel.js';
import { buildTimeZoneModal, parseTimeZoneModal, TIMEZONE_MODAL_ID } from './timezoneModal.js';
import { adviseTemplate, lintTemplate } from '../features/templateAssistant/validate.js';
import {
  ASSISTANT_PREFIX,
  buildAssistantModal,
  buildProposalPanel,
  parseAssistantId,
} from './assistantPanel.js';
import type {
  AssistantTurn,
  Proposal,
  TemplateAssistant,
} from '../features/templateAssistant/index.js';
import { assistantUnavailableMessage } from '../features/templateAssistant/index.js';
import {
  buildGroupDisablePanel,
  buildGroupEnablePanel,
  GROUP_PREFIX,
  parseGroupId,
} from './groupPanel.js';
import { groupKeyFor, ROOT_GROUP_KEY } from '../features/voice/guildSettings.js';
import { describeError } from '../ops/describeError.js';
import { reinviteUrlFor } from '../ops/announce.js';

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
  /** Creator channels, which `/export` reads and `/import` writes. */
  autoChannels?: AutoChannelRepository;
  /** Recent "I lost access to this channel" incidents, surfaced in `/setup`. */
  permissionProblems?: PermissionProblemTracker;
  /**
   * This fleet's runtime flags, for `/channelinfo`'s kill-switch.
   *
   * Top level rather than inside {@link configTransfer}'s bundle, even though
   * that bundle already carries a reader: a lever hidden behind another
   * feature's optional dependency is a lever that silently does nothing in any
   * deployment without that feature. Optional so a test fixture stays small,
   * and absent means the switch is off.
   */
  flags?: RuntimeFlagsRepository;
  /**
   * The natural-language template assistant. Absent when no model endpoint is
   * configured, which is the self-host default — the command isn't registered
   * in that case, so this only has to cover the "flag flipped after boot" path.
   */
  assistant?: TemplateAssistant;
  /**
   * Everything `/export` and `/import` need beyond what the rest of this
   * handler already holds.
   *
   * One optional bundle rather than eight optional fields, so a test that does
   * not care about config transfer stays a two-line fixture and the two
   * commands refuse honestly instead of throwing when it is absent.
   */
  configTransfer?: {
    db: Database;
    fleet: Fleet;
    flags: RuntimeFlagsRepository;
    opsAudit: OpsAuditRepository;
    serverLog: (guildId: string, level: 1 | 2 | 3, message: string) => void;
    reconcileGuild: (guildId: string) => Promise<void>;
    sessions: ImportSessionStore;
    /** Live occupants of a voice channel, for seeding a first-time adopt. */
    membersInChannel: (channelId: string) => string[];
    counters?: ImportCounters;
  };
  selfHosted: boolean;
  /** Discord application id, for building the `/invite` link. */
  clientId: string;
  logger: Logger;
  /** Optional sink for significant interaction failures (admin reporting). */
  reportError?: (message: string, context?: Record<string, unknown>) => void;
  /**
   * Counts a command invocation. Optional so tests and a self-host with the
   * collector switched off need not supply one.
   *
   * This is the one product question nothing else in the schema can answer:
   * every other metric in the plan's §4.6 is derivable from a table after the
   * fact, and "which commands do people actually use" leaves no trace at all
   * unless it is counted as it happens.
   */
  countCommand?: (commandName: string) => void;
}

const KICK_PREFIX = 'avc:kick:';
const VOTE_TIMEOUT_MS = 2 * 60 * 1000;
/** How long a failed-`/create`'s saved selections stay retry-able (in memory). */
const CREATE_RETRY_TTL_MS = 15 * 60 * 1000;
/** How long a pending assistant proposal stays applicable (in memory). */
const ASSISTANT_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * `/channelinfo`'s refusals, kept together so the two callers word them the
 * same. Deliberately vague about WHY a channel cannot be shown: naming the
 * difference between "no such channel" and "you cannot see that one" is how a
 * refusal becomes a way to probe for hidden channels.
 */
const CANNOT_SEE_CHANNEL = "I can't show you that channel.";
const CHANNELINFO_OFF = 'Channel info is switched off right now. Try again a bit later.';
const CHANNELINFO_BUSY =
  "I couldn't read that channel just now. AVC is backing off in this server after repeated " +
  'errors, which usually clears on its own within a few minutes.';
/** Shown above the panel in a hard-gated guild, so it reads as paused, not broken. */
const GATED_INFO_NOTE =
  'AVC is paused on this server, so it is not creating or renaming anything right now. ' +
  'Everything below is still what it would use.';

/** One admin's in-flight `/templateassistant` conversation. */
interface AssistantSession {
  scope: Exclude<EditorScope, 'channel'>;
  channelId: string;
  userId: string;
  /** Earlier turns, so "Refine" is a correction rather than a fresh ask. */
  history: AssistantTurn[];
  proposal?: Proposal;
  expiresAt: number;
}

/** Interactions that can drive the "manage a channel" flow (command + components). */
type ManageableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ChannelSelectMenuInteraction
  | StringSelectMenuInteraction;

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
  // Pending assistant proposals. A proposal can be a thousand characters, so it
  // cannot ride in a custom id; the id carries a session key instead. Losing
  // these on restart just means the admin re-asks, which is the safe direction.
  const assistantSessions = new Map<string, AssistantSession>();

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

    const guildRow = await deps.guilds.get(guildId);

    // Per-guild kill-switch: a blocked guild gets nothing.
    if (guildRow?.authStatus === 'blocked') {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This server is currently blocked.', ephemeral: true });
      }
      return;
    }

    // Hard gate (monetization.md §6): in an expired guild every interaction
    // gets the friendly reactivation message — except the read-only surfaces
    // that let an admin see the gated state and fix it (`/setup` & friends).
    const entitled = isEntitled({
      status: guildRow?.authStatus ?? 'trial',
      selfHosted: deps.selfHosted,
    });
    if (!entitled && !allowedWhileExpired(interaction)) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: expiredInteractionMessage(guildId, guildRow?.poolId != null),
          ephemeral: true,
        });
      }
      return;
    }

    // `entitled` rides along rather than being re-derived: it cost a guild-row
    // read here, and a handler that wants it would otherwise read the same row
    // again (see `buildChannelInfoInput`).
    if (interaction.isChatInputCommand()) return handleCommand(interaction, entitled);
    if (interaction.isButton()) return handleButton(interaction, entitled);
    if (interaction.isChannelSelectMenu()) return handleChannelSelect(interaction);
    if (interaction.isStringSelectMenu()) return handleStringSelect(interaction);
    if (interaction.isModalSubmit()) return handleModal(interaction);
  }

  /**
   * Interactions that still work in a hard-gated guild: the informational
   * commands plus the `/setup` panel (which shows the gated plan state and its
   * logging/settings modals) — mirroring the dashboard's "show the gated state
   * with a prominent reactivate path" behavior.
   */
  function allowedWhileExpired(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand()) {
      /**
       * `/export` is on this list and `/import` deliberately is not.
       *
       * Refusing to let someone take their own configuration with them because
       * they stopped paying is exactly the behaviour the AGPL positioning rules
       * out. `/import` is a write path, and the hard gate is non-destructive by
       * design: it stops writes and destroys nothing.
       *
       * Both are still refused in a `blocked` guild, which `route` handles
       * above this point, and that stays: `blocked` is the abuse switch.
       */
      return [
        'setup',
        'ping',
        'invite',
        'source',
        'debug',
        'logging',
        'export',
        /**
         * `/channelinfo` is on this list for `/export`'s reason: it is a read
         * path that writes nothing and destroys nothing, and refusing to tell
         * someone how their own server is configured because a payment lapsed
         * is not what the hard gate is for. The panel says the server is paused
         * rather than pretending the automation is running.
         */
        'channelinfo',
      ].includes(interaction.commandName);
    }
    if (interaction.isButton()) {
      // The assistant writes a template, so it is a write path like `/create`
      // and must not slip through on the `/setup` panel's blanket exemption.
      // (It is free on every tier — see the assistant's own docs — but an
      // expired guild has no automation for a template to drive.)
      if (interaction.customId === `${SETUP_PREFIX}assistant`) return false;
      // A `/channelinfo` view button, or the command's own exemption stops at
      // the first click and the panel answers with the reactivation notice.
      if (interaction.customId.startsWith(CHANNELINFO_PREFIX)) return true;
      return interaction.customId.startsWith(SETUP_PREFIX);
    }
    if (interaction.isStringSelectMenu()) {
      /**
       * The panel's "More settings" select carries the same actions its buttons
       * used to, so it needs the same exemption and the same carve-out. Without
       * this branch an expired guild loses the logging and label modals the
       * panel is exempt in order to provide.
       *
       * The assistant is refused here exactly as it is above: the select hides
       * that option in an expired guild, but the option is chosen by the client
       * and this is the half that enforces it.
       */
      if (interaction.customId !== SETUP_SETTINGS_ID) return false;
      return !interaction.values.includes(setupId('assistant'));
    }
    if (interaction.isModalSubmit()) {
      // `CREATE_FROM_SETUP_MODAL_ID` is deliberately absent: it creates a
      // channel, so it is a write path like `CREATE_MODAL_ID` beside it.
      // Every settings modal the "More settings" select can open, since the
      // select itself is exempt: allowing the panel but refusing the modal it
      // just opened would strand a gated admin mid-edit.
      return (
        interaction.customId === GENERAL_MODAL_ID ||
        interaction.customId === LOGGING_MODAL_ID ||
        interaction.customId === TIMEZONE_MODAL_ID ||
        interaction.customId.startsWith(LISTS_PREFIX)
      );
    }
    return false;
  }

  async function handleCommand(
    interaction: ChatInputCommandInteraction,
    entitled: boolean,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const channelId = currentVoiceChannelId(interaction);

    /**
     * Counted here rather than in `route`, so the number means "commands that
     * ran". `route` also sees buttons, modals and selects, and it refuses
     * blocked and hard-gated guilds above this point - counting there would fold
     * refusals into usage and make a gated guild look like an active one.
     */
    deps.countCommand?.(interaction.commandName);

    /**
     * Commands that talk to Discord before they can answer.
     *
     * **Discord kills an interaction token after 3 seconds**, and every one of
     * these spends that budget on REST calls against the CHANNEL's bucket, which
     * is the same bucket a rename uses (`PATCH /channels/{id}`). So AVC's own
     * queued rename delays the next command's call and the reply arrives at a
     * dead token: the work all succeeds, and the user sees "The application did
     * not respond". Observed live on `/limit` behind a rate-limited rename.
     *
     * Deferring first buys 15 minutes, and it is done HERE rather than in each
     * branch so a new command cannot be added without it. `/nick` is in the list
     * for the same reason and is the worst of them: it awaits a re-render of
     * every channel the caller owns.
     */
    if (DEFERRED_COMMANDS.has(interaction.commandName)) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

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
      case 'reclaim':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:reclaim', () =>
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
        // Re-render the user's channels so `@@owner@@` picks up the new name.
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
      case 'templateassistant':
        return openAssistant(interaction);
      case 'position':
        return openPositionModal(interaction);
      case 'alwaysprivate':
        return handleAlwaysPrivate(interaction);
      case 'defaultlimit':
        return handleDefaultLimit(interaction);
      case 'group':
        return openGroupPanel(interaction);
      case 'inheritpermissions':
        return openInheritModal(interaction);
      case 'logging':
        return openLoggingModal(interaction);
      case 'export':
        return handleConfigTransfer(interaction, 'export');
      case 'import':
        return handleConfigTransfer(interaction, 'import');
      case 'ping':
        return handlePing(interaction);
      case 'invite':
        return handleInvite(interaction);
      case 'source':
        return handleSource(interaction);
      case 'debug':
        return handleDebug(interaction);
      case 'channelinfo':
        return handleChannelInfo(interaction, entitled);
      case 'create':
        return openCreateModal(interaction);
      case 'alias':
        return openAliasPanel(interaction);
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
   * Refuses an adopted-channel template flow when AVC cannot actually rename the
   * channel, *before* the admin is asked to write anything. Composing a template
   * only to have the rename fail afterwards wastes their effort, and the failure
   * arrives too late to hand their input back.
   *
   * Resolved on the channel itself, because a category or channel override can
   * remove what the role grants guild-wide. An unknown (channel or bot member not
   * cached) is not treated as a denial: better to try and report than to refuse a
   * setup that would have worked.
   *
   * @returns true when it replied and the caller should stop.
   */
  async function blockedByRenamePermissions(
    interaction: ManageableInteraction,
    channelId: string,
  ): Promise<boolean> {
    const me = interaction.guild?.members.me ?? null;
    const channel = interaction.guild?.channels.cache.get(channelId) ?? null;
    if (!me || !channel || !('permissionsFor' in channel)) return false;
    const perms = channel.permissionsFor(me);
    if (!perms) return false;
    const missing = missingRenamePermissions((flag) => perms.has(flag));
    if (missing.length === 0) return false;
    await respond(interaction, {
      content:
        `⚠️ I cannot manage <#${channelId}>'s name, I am missing ` +
        `**${missing.join('**, **')}** on it. Grant those on the channel or its ` +
        'category, then run this again.',
      ephemeral: true,
    });
    return true;
  }

  /**
   * The "manage a channel" flow, reusable from `/template`, the `/setup`
   * "Edit room names" button, and the channel picker. Routes to the right
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
    // Past here the template names THIS channel, which AVC renames directly — so
    // check it can before asking for any input (a primary's template, above,
    // applies to the secondaries it spawns, not to the channel in hand).
    if (await blockedByRenamePermissions(interaction, channelId)) return;
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

  // -- /templateassistant ----------------------------------------------------

  /** `/templateassistant` → act on the channel you're in, else pick one. */
  async function openAssistant(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'templateassistant',
      '✨ Pick a voice channel to name:',
    );
    if (!channelId) return;
    await assistantCore(interaction, channelId);
  }

  /**
   * Opens the "describe it" modal for a channel, resolving which templates the
   * assistant would be writing. Mirrors `manageChannelCore`: a creator
   * channel's secondary writes the primary's templates, an adopted standalone
   * writes its own, and anything else is offered for adoption first (the
   * assistant has nothing to write to until AVC manages the channel).
   */
  async function assistantCore(
    interaction: ManageableInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!deps.assistant) {
      return respond(interaction, {
        content: assistantUnavailableMessage(deps.selfHosted),
        ephemeral: true,
      });
    }
    if (!(await requireManageChannels(interaction))) return;

    const primaryState = await run(guildId, 'cmd:assistant', () =>
      deps.feature.getEditorState('primary', guildId, channelId),
    );
    let scope: Exclude<EditorScope, 'channel'> | undefined;
    if (primaryState.found) scope = 'primary';
    else {
      // Past here the assistant writes THIS channel's own template, so check AVC
      // can rename it before the admin describes anything — and before a model
      // call is spent producing a template that could never be applied.
      if (await blockedByRenamePermissions(interaction, channelId)) return;
      const managedState = await run(guildId, 'cmd:assistant:managed', () =>
        deps.feature.getManagedEditorState(guildId, channelId),
      );
      if (managedState.found) scope = 'adopted';
    }
    if (!scope) {
      const name = interaction.guild?.channels.cache.get(channelId)?.name ?? 'this channel';
      return respond(interaction, buildAdoptPrompt(channelId, name));
    }

    const sessionId = newAssistantSession({
      scope,
      channelId,
      userId: interaction.user.id,
      history: [],
      expiresAt: Date.now() + ASSISTANT_SESSION_TTL_MS,
    });
    await interaction.showModal(buildAssistantModal(sessionId, false));
  }

  function newAssistantSession(session: AssistantSession): string {
    pruneAssistantSessions();
    const sessionId = randomUUID().replace(/-/g, '').slice(0, 12);
    assistantSessions.set(sessionId, session);
    return sessionId;
  }

  function pruneAssistantSessions(): void {
    const now = Date.now();
    for (const [id, session] of assistantSessions) {
      if (session.expiresAt <= now) assistantSessions.delete(id);
    }
  }

  /**
   * Resolves the session behind a component id, enforcing that it belongs to
   * the person clicking. Ephemeral messages are already private, so this is
   * belt and braces against a stale or shared id.
   */
  function assistantSessionFor(
    interaction: ButtonInteraction | ModalSubmitInteraction,
  ): { sessionId: string; session: AssistantSession } | null {
    const parsed = parseAssistantId(interaction.customId);
    if (!parsed) return null;
    const session = assistantSessions.get(parsed.sessionId);
    if (!session || session.expiresAt <= Date.now()) return null;
    if (session.userId !== interaction.user.id) return null;
    return { sessionId: parsed.sessionId, session };
  }

  /** The "describe it" / "what should change" modal submit → build a proposal. */
  async function handleAssistantModal(interaction: ModalSubmitInteraction): Promise<void> {
    const found = assistantSessionFor(interaction);
    if (!found) {
      await interaction.reply({
        content: '⚠️ That assistant session has expired. Run `/templateassistant` again.',
        ephemeral: true,
      });
      return;
    }
    if (!deps.assistant) {
      await interaction.reply({
        content: assistantUnavailableMessage(deps.selfHosted),
        ephemeral: true,
      });
      return;
    }
    const { sessionId, session } = found;
    const request = interaction.fields.getTextInputValue('request');
    // A model round-trip is far past the 3s ack window.
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId!;
    const state = await run(guildId, 'assistant:state', () =>
      deps.feature.getEditorState(session.scope, guildId, session.channelId),
    );
    if (!state.found) {
      await interaction.editReply({ content: '⚠️ That channel is no longer bot-managed.' });
      return;
    }
    const config = await run(guildId, 'assistant:config', () => deps.settings.getConfig(guildId));

    const result = await deps.assistant.propose(
      {
        guildId,
        standalone: session.scope === 'adopted',
        general: config.general,
        aliases: config.aliases,
        creatorName: interaction.user.displayName || interaction.user.username,
        ...(state.name.currentTemplate !== undefined
          ? { currentName: state.name.currentTemplate }
          : {}),
        ...(state.status.currentTemplate !== undefined
          ? { currentStatus: state.status.currentTemplate }
          : {}),
        ...(interaction.locale ? { locale: interaction.locale } : {}),
        // Both are things the prompt promises to tell the model about: an unset
        // zone makes a date token render in UTC, and an invented list name
        // prints literally.
        ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
        lists: config.lists,
      },
      request,
      session.history,
    );

    if (!result.ok) {
      await interaction.editReply({ content: `⚠️ ${result.message}` });
      return;
    }
    session.proposal = result.proposal;
    session.history = [
      ...session.history,
      { request, name: result.proposal.name, status: result.proposal.status },
    ].slice(-3);
    session.expiresAt = Date.now() + ASSISTANT_SESSION_TTL_MS;
    await interaction.editReply(
      toUpdate(
        buildProposalPanel(sessionId, result.proposal, {
          ...(result.capNotice ? { capNotice: result.capNotice } : {}),
        }),
      ),
    );
  }

  /** Apply / Refine / Cancel on a proposal. */
  async function handleAssistantButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseAssistantId(interaction.customId);
    if (!parsed) return;
    const found = assistantSessionFor(interaction);
    if (!found) {
      await interaction.update({
        content: '⚠️ That assistant session has expired. Run `/templateassistant` again.',
        embeds: [],
        components: [],
      });
      return;
    }
    const { sessionId, session } = found;

    if (parsed.action === 'cancel') {
      assistantSessions.delete(sessionId);
      await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
      return;
    }
    if (parsed.action === 'refine') {
      await interaction.showModal(buildAssistantModal(sessionId, true));
      return;
    }
    if (parsed.action !== 'apply') return;
    if (!(await requireManageChannels(interaction))) return;

    const proposal = session.proposal;
    if (!proposal || proposal.fields.length === 0) {
      await interaction.update({
        content: '⚠️ There is nothing to apply.',
        embeds: [],
        components: [],
      });
      return;
    }

    // Applying can rename every sibling channel, which brushes the 3s ack.
    await interaction.deferUpdate();
    const notes: string[] = [];
    for (const field of proposal.fields) {
      // The assistant only *produces* a template. Landing it goes through the
      // exact same path `/template`'s editor uses, so there is one apply route
      // to reason about and the assistant can never take a shortcut past it.
      const applied = await applyEditor(
        interaction,
        session.scope,
        field.field,
        session.channelId,
        field.template,
      );
      if (!applied.ok) {
        await interaction.followUp({ content: `⚠️ ${applied.message}`, ephemeral: true });
        return;
      }
      if (applied.opts.note) notes.push(applied.opts.note);
    }
    assistantSessions.delete(sessionId);

    // Drop the admin into the familiar editor panel, already saved, so the next
    // tweak is a normal edit rather than another round-trip to a model.
    const state = await run(interaction.guildId!, 'assistant:refresh', () =>
      deps.feature.getEditorState(session.scope, interaction.guildId!, session.channelId),
    );
    await interaction.editReply(
      toUpdate(
        renderEditorPanel(session.scope, session.channelId, state, {
          updated: true,
          ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
        }),
      ),
    );
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
      // A grouped category numbers across every primary in it, so a per-primary
      // start would be ambiguous. The field is still shown, prefilled from this
      // primary, because the submit path below persists it per primary either
      // way and an admin who ungroups later keeps what they set.
      const grouped = await run(guildId, 'cmd:position:startat', () =>
        deps.settings.getPosition(guildId, channelId),
      );
      await interaction.showModal(buildPositionModal(channelId, group.above, grouped.startAt));
      return;
    }
    const pos = await run(guildId, 'cmd:position', () =>
      deps.settings.getPosition(guildId, channelId),
    );
    if (!pos.found) {
      return respond(interaction, {
        content: "This isn't a bot-managed voice channel.",
        ephemeral: true,
      });
    }
    await interaction.showModal(buildPositionModal(channelId, pos.above, pos.startAt));
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
    const { above, startAt } = parsePositionModal(interaction.fields);

    const categoryKey = categoryKeyForChannel(interaction, channelId);
    const group = await run(guildId, 'cmd:position:group:get', () =>
      deps.settings.getGroup(guildId, categoryKey),
    );
    if (group) {
      const summary = await run(guildId, 'cmd:position:group:set', async () => {
        await deps.settings.setGroup(guildId, categoryKey, above);
        await deps.settings.setPosition(guildId, channelId, above, startAt);
        return deps.feature.resyncCategory(guildId, categoryKey);
      });
      await interaction.reply({
        content:
          `✅ This category's rooms are now grouped **${above ? 'above' : 'below'}** the ` +
          `creator channels.${rateLimitNote(summary.rateLimited)}`,
        ephemeral: true,
      });
      return;
    }

    // Read → set → reposition in ONE dispatched task so it's ordered atomically
    // against other guild work (no interleaving between the read and the writes).
    const { res, moved } = await run(guildId, 'cmd:position', async () => {
      const before = await deps.settings.getPosition(guildId, channelId);
      const result = await deps.settings.setPosition(guildId, channelId, above, startAt);
      const count =
        result.ok && before.primaryChannelId && before.above !== above
          ? await deps.feature.repositionSecondaries(guildId, before.primaryChannelId, above)
          : 0;
      // A changed start renumbers every room under this primary. Repositioning
      // does not, so this is a separate re-render rather than a wider one.
      if (result.ok && before.primaryChannelId && before.startAt !== startAt) {
        await deps.feature.rerenderSiblings(guildId, before.primaryChannelId);
      }
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

  /** `/defaultlimit` → the user limit new rooms from this creator channel start with. */
  async function handleDefaultLimit(interaction: ChatInputCommandInteraction): Promise<void> {
    // Read the option before the picker, so it can be carried in the custom id.
    const limit = interaction.options.getInteger('limit', true);
    const channelId = await resolveOrPick(
      interaction,
      'defaultlimit',
      '👥 Pick a creator channel to set the default limit for:',
      String(limit),
    );
    if (!channelId) return;
    await defaultLimitCore(interaction, channelId, limit);
  }

  async function defaultLimitCore(
    interaction: ManageableInteraction,
    channelId: string,
    limit: number,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const res = await run(guildId, 'cmd:defaultlimit', () =>
      deps.settings.setDefaultLimit(guildId, channelId, limit),
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
        content: 'Cancelled, nothing changed.',
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
      ? `✅ Grouped this category's rooms **${above ? 'above' : 'below'}** the creator ` +
        `channels${summary.considered ? ` (${summary.considered} room${summary.considered === 1 ? '' : 's'})` : ''}.${note}`
      : `✅ Turned grouping off. Each creator channel goes back to its own numbering and ` +
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
        content: "This isn't a bot-managed voice channel.",
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
        content: 'I cannot post there, pick a text channel I can send messages in.',
        ephemeral: true,
      });
      return;
    }
    /**
     * Opened from the `/setup` panel, so the panel is what should carry the
     * result. Reached from `/logging` there is no message behind the modal, and
     * a plain reply is the only thing that works.
     *
     * Both the validation above and the two gates before it `reply`, so they
     * stay ahead of this branch: nothing may defer before they have run.
     */
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
      const res = await run(guildId, 'cmd:logging', () =>
        deps.settings.setLogging(guildId, target, parsed.level, parsed.alerts),
      );
      await refreshSetupPanel(interaction, { note: formatResult(res) });
      return;
    }
    const res = await run(guildId, 'cmd:logging', () =>
      deps.settings.setLogging(guildId, target, parsed.level, parsed.alerts),
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
        content: "That isn't a bot-managed voice channel.",
        ephemeral: true,
      });
    }
    // Anyone may edit their own channel; editing another's needs admin.
    if (!hasManageChannels(interaction) && state.ownerId && state.ownerId !== userId) {
      return respond(interaction, {
        content: "Only the channel's owner or a server admin can edit it.",
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
        content: 'Cancelled, AVC will not manage this channel.',
        embeds: [],
        components: [],
      });
      return;
    }
    const adoptGate = await gateCheck(guildId);
    if (!adoptGate.entitled) {
      await interaction.update({
        content: adoptGate.reply,
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
    /**
     * Adoption writes a template WITHOUT going through `applyEditor`, so it needs
     * its own hook. It is also the strongest signal of the three: taking an
     * existing channel under management is unambiguously an act of setup.
     *
     * Not awaited, for the same reason as `handleCreateSubmit`: nothing has
     * acknowledged the interaction yet.
     */
    void deps.settings.recordContact(guildId, interaction.user.id);
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
    /**
     * Advise on a hand-typed template, never refuse one.
     *
     * `validate.ts` only ever ran inside the assistant's propose loop, so
     * `/template` and `/name` accepted anything and an unknown `{{VARIABLE}}`
     * silently rendered the false branch. The admin got a plausible wrong name
     * with nothing telling them why, which is the harm class this whole release
     * is about (`plans/name-tokens.md` §6.8). An admin with Manage Channels may
     * still set any name they like, so this only ever appends to the note.
     */
    const guildConfig = await run(guildId, 'editor:advice', () => deps.settings.getConfig(guildId));
    const advice = [
      ...lintTemplate(value, field === 'name' ? 'name' : 'status').map((issue) => issue.message),
      // The two things a structural lint cannot see, both of which render
      // something plausible and wrong: a date token with no zone set, and a
      // `[[list:name]]` naming a pool this guild does not have.
      ...adviseTemplate(value, {
        timezone: guildConfig.timezone,
        listNames: Object.keys(guildConfig.lists),
      }),
    ]
      .map((message) => `⚠️ ${message}`)
      .join('\n');
    /**
     * Record who set this up, for the two ADMIN scopes only.
     *
     * `scope === 'channel'` is `/name`, the per-channel override, and `nameCore`
     * deliberately lets any channel OWNER use it without ManageChannels. Writing
     * the guild-wide contact from there inverts the whole point of the field: on
     * a fleet where renaming your own room is an everyday user action and
     * creating a creator channel happens once, the contact would converge on
     * "the last person to rename a room" and never point at an admin. It would
     * also make a common user command fire a fleet-wide settings-cache NOTIFY.
     */
    if (scope !== 'channel') await deps.settings.recordContact(guildId, interaction.user.id);
    const state = await run(guildId, 'editor:refresh', () =>
      deps.feature.getEditorState(scope, guildId, channelId),
    );
    const note = [result.message, advice].filter((part) => part !== '').join('\n');
    return {
      ok: true,
      state,
      opts: { updated: true, ...(note ? { note } : {}) },
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
      | StringSelectMenuInteraction
      | ModalSubmitInteraction,
  ): Promise<boolean> {
    if (hasManageChannels(interaction)) return true;
    await interaction.reply({
      content: 'You need the Manage Channels permission.',
      ephemeral: true,
    });
    return false;
  }

  /**
   * Gate the two config-transfer commands.
   *
   * **Not a copy of `requireManageChannels`.** That one always calls
   * `interaction.reply`, and the confirm handler has already updated the message
   * by the time it re-checks, so a verbatim copy would throw into `route`'s
   * catch and show a generic error on the one path whose entire job is refusing
   * an unauthorized destructive write. `safeReply` picks the right method.
   */
  async function requireManageGuild(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
  ): Promise<boolean> {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true) return true;
    await safeReply(interaction, 'You need the Manage Server permission to use that.');
    return false;
  }

  /**
   * Assembles the full dependency set for `/export` and `/import`.
   *
   * Returns undefined when the bundle is absent, which in production cannot
   * happen (both commands register unconditionally) but keeps every existing
   * test fixture valid.
   */
  function importDeps(): ImportCommandDeps | undefined {
    const bundle = deps.configTransfer;
    if (!bundle || !deps.autoChannels) return undefined;
    return {
      db: bundle.db,
      fleet: bundle.fleet,
      guilds: deps.guilds,
      autoChannels: deps.autoChannels,
      managed: deps.managed,
      settings: deps.settings,
      flags: bundle.flags,
      opsAudit: bundle.opsAudit,
      serverLog: bundle.serverLog,
      reconcileGuild: bundle.reconcileGuild,
      dispatchRun: run,
      membersInChannel: (channelId) => deps.configTransfer?.membersInChannel(channelId) ?? [],
      applicationId: deps.clientId,
      logger: deps.logger,
      sessions: bundle.sessions,
      ...(bundle.counters ? { counters: bundle.counters } : {}),
    };
  }

  async function handleConfigTransfer(
    interaction: ChatInputCommandInteraction,
    which: 'export' | 'import',
  ): Promise<void> {
    if (!(await requireManageGuild(interaction))) return;
    const importDependencies = importDeps();
    if (!importDependencies) {
      await safeReply(interaction, 'Configuration transfer is not available on this instance.');
      return;
    }
    return which === 'export'
      ? handleExport(interaction, importDependencies)
      : handleImportCommand(interaction, importDependencies);
  }

  async function handlePing(interaction: ChatInputCommandInteraction): Promise<void> {
    const ws = Math.round(deps.client.ws.ping);
    await interaction.reply({ content: '🏓 Pinging…', ephemeral: true });
    const sent = await interaction.fetchReply();
    const rtt = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(
      `🏓 Pong! Round-trip ${rtt}ms · gateway ${ws < 0 ? '—' : `${ws}ms`}. ` +
        `v${VERSION} (${COMMIT.slice(0, 7)}) · Status page: ${STATUS_PAGE_URL}`,
    );
  }

  async function handleInvite(interaction: ChatInputCommandInteraction): Promise<void> {
    // View + Connect + Move Members + Manage Channels + Manage Roles (+ messaging for
    // join requests) — the permission set the bot needs, matching the legacy invite.
    const url =
      `https://discord.com/oauth2/authorize?client_id=${deps.clientId}` +
      `&permissions=286280784&scope=bot%20applications.commands`;
    await interaction.reply({
      /**
       * The second line matters under member-based billing: a new server
       * otherwise starts its own trial and eventually meets its own gate,
       * when the customer already has a subscription that could cover it.
       */
      content:
        `📫 [Invite me to another server!](${url})

Already subscribed? Add the new server ` +
        `to your subscription at ${SITE_URL}/dashboard so it is covered from day one.`,
      ephemeral: true,
    });
  }

  async function handleSource(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({
      content: `📜 AVC is open source, licensed AGPL-3.0: ${GITHUB_URL}`,
      ephemeral: true,
    });
  }

  /** Dev-only: dump the data behind a channel's name + config + permissions. */
  async function handleDebug(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    /**
     * Re-gated in code, not only by `default_member_permissions`.
     *
     * That default is a DEFAULT: a server admin can re-open any command to any
     * role in Server Settings > Integrations, and every sibling admin command
     * here re-checks for exactly that reason. This one did not, which is one of
     * the two things that made "just open `/debug` up" the wrong move.
     */
    if (!(await requireManageChannels(interaction))) return;
    const requested = interaction.options.getChannel('channel')?.id;
    if (requested && !callerCanSee(interaction, requested)) {
      await interaction.reply({ content: CANNOT_SEE_CHANNEL, ephemeral: true });
      return;
    }
    const channelId = requested ?? currentVoiceChannelId(interaction);
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
    interaction: ChatInputCommandInteraction | ButtonInteraction,
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

  // -- /channelinfo ----------------------------------------------------------

  /**
   * Whether the CALLER can see a channel they named by id.
   *
   * Discord's picker only offers channels the member can see, but the API does
   * not enforce that, so a crafted interaction can name any channel in the
   * guild. Both commands that take a channel id report who is sitting in it and
   * what they are playing, so without this the option is a way to watch a
   * private voice channel from outside it. Fails CLOSED on an unknown channel.
   */
  function callerCanSee(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    channelId: string,
  ): boolean {
    const channel = interaction.guild?.channels.cache.get(channelId);
    if (!channel || !('permissionsFor' in channel)) return false;
    /**
     * The MEMBER, resolved the way `currentVoiceChannelId` does it, rather than
     * `interaction.user`. `permissionsFor` accepts a user, but only by looking
     * the member up in the guild cache, and it returns null on a miss - which
     * this reads as "cannot see" and refuses. Correct, and the wrong answer:
     * refusing a legitimate admin because a cache was cold. `interaction.member`
     * is the member Discord sent with this very interaction.
     */
    const member =
      interaction.member instanceof GuildMember
        ? interaction.member
        : (interaction.guild?.members.cache.get(interaction.user.id) ?? interaction.user);
    return channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
  }

  /**
   * Gathers the panel input for one channel.
   *
   * Shared by the command and its buttons so a re-render cannot disagree with
   * the first render about who the viewer is or what the channel looks like.
   */
  async function buildChannelInfoInput(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    channelId: string,
    entitled: boolean,
  ): Promise<ChannelInfoPanelInput> {
    const guildId = interaction.guildId!;
    const info = await run(guildId, 'cmd:channelinfo', () =>
      deps.feature.channelInfo(guildId, channelId),
    );
    const isAdmin = hasManageChannels(interaction);
    return {
      info,
      currentName: interaction.guild?.channels.cache.get(channelId)?.name ?? '',
      isAdmin,
      botPermissions: isAdmin ? botPermissions(interaction, channelId) : {},
      problems: isAdmin
        ? (deps.permissionProblems?.recent(guildId) ?? []).filter((p) => p.channelId === channelId)
        : [],
      /**
       * `entitled` is threaded down from `route`, which already read the guild
       * row to apply the hard gate. Calling `gateCheck` here would read the
       * SAME row a second time per invocation, and every view button repeats
       * it, on the one command any member can run.
       */
      ...(entitled ? {} : { gatedNote: GATED_INFO_NOTE }),
    };
  }

  /**
   * `/channelinfo` — what AVC thinks this voice channel is, and why it is named
   * what it is named.
   *
   * Open to everyone for the channel they are standing in, which is the legacy
   * `channelinfo` behaviour and the whole point: the person asking "why is my
   * room called this" is usually not an admin. The `channel` option is the half
   * that needs a permission, because it can name a channel the caller is not in.
   */
  async function handleChannelInfo(
    interaction: ChatInputCommandInteraction,
    entitled: boolean,
  ): Promise<void> {
    /**
     * Every check that can answer WITHOUT a database read happens above the
     * defer, and the kill-switch happens below it.
     *
     * The switch exists for load shedding, and reading it before acknowledging
     * would spend an uncached `SELECT` on the interaction's three-second budget
     * during exactly the incident it was added for: the member would get "The
     * application did not respond" instead of the polite notice the flag is
     * supposed to produce. `route` has already spent one read getting here.
     */
    const requested = interaction.options.getChannel('channel')?.id;
    if (requested) {
      // Manage Channels for the option itself, then the caller's own view of the
      // target. Both are needed: the first is who may look elsewhere at all, the
      // second binds the id they supplied to what they can already see.
      if (!(await requireManageChannels(interaction))) return;
      if (!callerCanSee(interaction, requested)) {
        await interaction.reply({ content: CANNOT_SEE_CHANNEL, ephemeral: true });
        return;
      }
    }
    const channelId = requested ?? currentVoiceChannelId(interaction);
    if (!channelId) {
      await interaction.reply({
        content: 'Join a voice channel first, and run this again to see what AVC knows about it.',
        ephemeral: true,
      });
      return;
    }

    /**
     * Deferred here rather than through `DEFERRED_COMMANDS`, whose documented
     * reason is REST-bucket contention. This makes no REST calls. The hazard is
     * the per-guild queue: `run()` is strictly serial per guild, so a reconcile
     * or a rate-limited rename in flight can hold this past three seconds and
     * the member sees "The application did not respond". Same reasoning as
     * `openSetup`, different cause.
     */
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (await channelInfoDisabled(interaction.guildId!)) {
      await interaction.editReply({ content: CHANNELINFO_OFF });
      return;
    }
    const input = await channelInfoInputOrExcuse(interaction, channelId, entitled);
    if (!input) return;
    const { embeds, components } = buildChannelInfoView('summary', input);
    await interaction.editReply({ embeds: embeds ?? [], components: components ?? [] });
  }

  /** A view button: re-reads and re-renders in place. */
  async function handleChannelInfoButton(
    interaction: ButtonInteraction,
    entitled: boolean,
  ): Promise<void> {
    const parsed = parseInfoId(interaction.customId);
    if (!parsed) {
      /**
       * Answering matters: `handleButton` claimed this id on its prefix, so
       * falling off the end leaves the interaction unacknowledged and Discord
       * shows a bare "This interaction failed". Unreachable with today's three
       * views, and it is the rolling-deploy path for a fourth (golden rule 4):
       * a new instance publishes a view an older one cannot parse.
       */
      await safeReply(interaction, 'That button is out of date. Run the command again.');
      return;
    }
    /**
     * Re-checked on the button, not trusted from the panel that carried it.
     * A panel is ephemeral but long-lived, and the caller's access can be taken
     * away between opening it and clicking. The channel id rides in the custom
     * id, so this is the same caller-supplied id the command already binds.
     */
    if (!callerCanSee(interaction, parsed.channelId)) {
      await safeReply(interaction, CANNOT_SEE_CHANNEL);
      return;
    }
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    if (await channelInfoDisabled(interaction.guildId!)) {
      await interaction.editReply({ content: CHANNELINFO_OFF, embeds: [], components: [] });
      return;
    }
    const input = await channelInfoInputOrExcuse(interaction, parsed.channelId, entitled);
    if (!input) return;
    await interaction.editReply(toUpdate(buildChannelInfoView(parsed.view, input)));
  }

  /**
   * The panel input, or `undefined` after answering with why there is none.
   *
   * A REFUSED dispatch is the case worth catching. `run()` rejects while the
   * guild's circuit breaker is tripped or its queue is draining, and that is
   * precisely the guild where somebody is running this command to find out what
   * is wrong. Letting it fall into `route`'s catch would answer "something went
   * wrong" to a question whose answer we know.
   */
  async function channelInfoInputOrExcuse(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    channelId: string,
    entitled: boolean,
  ): Promise<ChannelInfoPanelInput | undefined> {
    try {
      return await buildChannelInfoInput(interaction, channelId, entitled);
    } catch (err) {
      deps.logger.info(
        { guildId: interaction.guildId, channelId, err },
        'channelinfo could not read the channel',
      );
      await interaction.editReply({ content: CHANNELINFO_BUSY, embeds: [], components: [] });
      return undefined;
    }
  }

  /**
   * The kill-switch, read on THIS fleet.
   *
   * A load lever rather than a safety one, and it exists because the two
   * alternatives are both wrong shapes: `global.pause` stops no slash command at
   * all, and withdrawing a global command means a deploy plus up to an hour of
   * Discord propagation.
   */
  async function channelInfoDisabled(guildId: string): Promise<boolean> {
    try {
      return (await deps.flags?.getBool(RUNTIME_FLAGS.CHANNELINFO_DISABLED)) === true;
    } catch (err) {
      // A flag read that fails must not take the command with it: this switch
      // guards load, and failing closed would turn a database blip into an
      // outage of the command people run when something looks wrong.
      deps.logger.debug({ guildId, err }, 'channelinfo flag read failed, treating as enabled');
      return false;
    }
  }

  /**
   * `/create` (and the "Create another" button, and the panel) → the setup modal.
   *
   * `fromSetup` stamps the modal with its own custom id so the submit knows there
   * is a panel behind it to refresh. It cannot be inferred at submit time:
   * "Create another" and "Retry" are buttons on their own result messages, so
   * every one of the three paths looks message-borne.
   */
  async function openCreateModal(
    interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
    opts: { fromSetup?: boolean } = {},
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const gate = await gateCheck(guildId);
    if (!gate.entitled) {
      await interaction.reply({
        content: gate.reply,
        ephemeral: true,
      });
      return;
    }
    if (!(await requireManageChannels(interaction))) return;
    // Prefill the template fields with the guild's current defaults (a quick read,
    // well within the 3s window before showModal — which must be the first response).
    const config = await deps.settings.getConfig(guildId);
    await interaction.showModal(
      buildCreateModal(
        {
          nameTemplate: config.defaultTemplate,
          statusTemplate: config.defaultStatus,
        },
        undefined,
        opts.fromSetup ? CREATE_FROM_SETUP_MODAL_ID : CREATE_MODAL_ID,
      ),
    );
  }

  /** The `/create` modal submit: create the primary from the selections, confirm. */
  async function handleCreateSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (!(await requireManageChannels(interaction))) return;
    if (!(await isEntitledOrReject(interaction, guildId))) return;
    /**
     * Whether there is a `/setup` panel behind this modal to update in place.
     *
     * Both halves are needed. The id says the modal was opened from the panel;
     * `isFromMessage` says this submit still has that message to edit. Checked
     * only after the two gates above, which reply rather than update.
     */
    const fromPanel =
      interaction.customId === CREATE_FROM_SETUP_MODAL_ID && interaction.isFromMessage();
    if (fromPanel) await interaction.deferUpdate();
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
    if (fromPanel) {
      /**
       * Back to the panel, carrying the outcome as its note. No "Create another"
       * button: the refreshed panel has the create button on it, now beside a
       * creator channel list that includes what was just made.
       */
      await refreshSetupPanel(interaction, { note: formatResult(outcome.result) });
    } else {
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
     * After the answer, and not awaited before it. Reached from `/create` this
     * handler never defers, so everything ahead of the first `reply` sits inside
     * Discord's 3-second acknowledgement budget, behind an entitlement read, a
     * `getConfig` and a channel-create REST call. Bookkeeping must not be what
     * pushes an already-successful create into "This interaction failed".
     *
     * The panel path defers up front and so has fifteen minutes, but the
     * ordering stays the same for both: there is no reason to make the admin
     * wait on a contact write either way.
     */
    void deps.settings.recordContact(guildId, interaction.user.id);
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

    const lines = [`⚠️ I couldn't create the creator channel${where}.`];
    if (missing.length) {
      lines.push(`I'm missing these permissions: **${missing.join('**, **')}**.`);
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
          'blocking me. Adjust it, then hit **Retry**.',
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
    const payload = { content: lines.join('\n'), components: [row], ephemeral: true };
    /**
     * `followUp` once the panel path has already deferred, since `reply` would
     * throw on an acknowledged interaction. The error goes in its own message
     * rather than replacing the panel deliberately: nothing was created, so the
     * panel behind it is still accurate, and Retry re-opens the modal with the
     * admin's selections intact.
     */
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  }

  /** "Retry" after a failed `/create`: re-open the modal with the saved selections. */
  async function handleCreateRetry(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const gate = await gateCheck(guildId);
    if (!gate.entitled) {
      await interaction.reply({
        content: gate.reply,
        ephemeral: true,
      });
      return;
    }
    if (!(await requireManageChannels(interaction))) return;
    pruneCreateRetries();
    const saved = createRetries.get(interaction.customId.slice(CREATE_RETRY_PREFIX.length));
    const config = await deps.settings.getConfig(guildId);
    const defaults = { nameTemplate: config.defaultTemplate, statusTemplate: config.defaultStatus };
    /**
     * The saved prefill expires (and is lost on restart); fall back to the guild
     * defaults so Retry still opens a usable modal.
     *
     * Deliberately the PLAIN modal id even when the create started from the
     * panel. Retry lives on the error message, so a modal opened from it has
     * that message as its `@original`: refreshing "the panel" would render a
     * second one where the error was and leave the first still stale. A plain
     * reply is the honest answer, and the panel is one `/setup` away.
     */
    await interaction.showModal(buildCreateModal(defaults, saved?.prefill));
  }

  /** Drops expired saved-create entries so the map stays bounded. */
  function pruneCreateRetries(): void {
    const now = Date.now();
    for (const [token, entry] of createRetries) {
      if (entry.expiresAt <= now) createRetries.delete(token);
    }
  }

  /**
   * Entitlement plus the wording its refusal needs, from ONE row read.
   *
   * `GuildRepository.isEntitled` throws the row away, and the refusal has to
   * know whether this server is covered by a subscription spanning several
   * servers: its admins are then very often not the person who can pay, so
   * "reactivate at ..." is a dead end for them (§6.6).
   */
  async function gateCheck(guildId: string): Promise<{ entitled: boolean; reply: string }> {
    const row = await deps.guilds.get(guildId);
    return {
      entitled: isEntitled({
        status: row?.authStatus ?? 'trial',
        selfHosted: deps.selfHosted,
      }),
      reply: expiredInteractionMessage(guildId, row?.poolId != null),
    };
  }

  async function isEntitledOrReject(
    interaction: ModalSubmitInteraction,
    guildId: string,
  ): Promise<boolean> {
    const gate = await gateCheck(guildId);
    if (gate.entitled) return true;
    await interaction.reply({ content: gate.reply, ephemeral: true });
    return false;
  }

  /**
   * Reads the guild's aliases WITHOUT the per-guild dispatcher, deliberately.
   *
   * Same call `openCreateModal` makes for the same reason: `GuildQueue` is
   * serial per guild, so a queued read sits behind every channel create and
   * rename already in flight, and this read has to complete before a
   * `showModal` that cannot be deferred first. The queue also fails fast while
   * a guild's circuit breaker is tripped, which would deny an admin the config
   * surface exactly when they came to fix something. It buys nothing here
   * either: this is a `SettingsCache` hit, not a query. Alias WRITES stay on
   * the dispatcher, where the ordering actually matters.
   */
  const readAliases = (guildId: string): Promise<Record<string, string>> =>
    deps.settings.listAliases(guildId);

  /** `/alias` → the panel listing this guild's aliases. */
  async function openAliasPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    // Admin-gated by Discord; every button and the modal submit re-gate.
    await respond(interaction, buildAliasListPanel(await readAliases(interaction.guildId!)));
  }

  /** Re-renders the alias list in place, after a mutation or a page change. */
  async function refreshAliasPanel(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    opts: { page?: number; note?: string } = {},
  ): Promise<void> {
    // Guarded the way refreshSetupPanel is: every caller defers today, and a
    // future one that forgets would throw InteractionNotReplied here.
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const aliases = await readAliases(interaction.guildId!);
    await interaction.editReply(toUpdate(buildAliasListPanel(aliases, opts)));
  }

  /** The `/alias` panel's buttons: add, edit, remove, back, page, close. */
  async function handleAliasButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseAliasId(interaction.customId);
    if (!parsed) return;
    const guildId = interaction.guildId!;
    const { action, arg } = parsed;

    if (action === 'close') {
      await interaction.update({ content: 'Closed.', embeds: [], components: [] });
      return;
    }
    // Showing a modal is itself the acknowledgement, so this must not defer first.
    if (action === 'add') {
      await interaction.showModal(buildAliasModal(currentGameName(interaction)));
      return;
    }
    if (action === 'back') {
      await interaction.deferUpdate();
      await refreshAliasPanel(interaction);
      return;
    }
    if (action === 'page') {
      await interaction.deferUpdate();
      await refreshAliasPanel(interaction, { page: Number(arg) || 0 });
      return;
    }

    // edit / remove both address one alias by hash, which may be gone by now.
    if (!arg) return;

    // Remove acknowledges FIRST, then reads. Edit cannot: showModal has to be
    // the first response, so its read runs unqueued (see readAliases).
    if (action === 'remove') {
      await interaction.deferUpdate();
      const found = findAliasByHash(await readAliases(guildId), arg);
      if (!found) {
        await refreshAliasPanel(interaction, { note: 'That alias is no longer there.' });
        return;
      }
      const res = await run(guildId, 'alias:remove', () =>
        deps.settings.removeAlias(guildId, found.game),
      );
      await refreshAliasPanel(interaction, { note: formatResult(res) });
      return;
    }
    if (action === 'edit') {
      const found = findAliasByHash(await readAliases(guildId), arg);
      if (!found) {
        await interaction.deferUpdate();
        await refreshAliasPanel(interaction, { note: 'That alias is no longer there.' });
        return;
      }
      await interaction.showModal(buildAliasEditModal(found.game, found.alias));
    }
  }

  /**
   * Reads the guild's named lists WITHOUT the per-guild dispatcher, for the same
   * reasons {@link readAliases} documents: a `showModal` cannot be deferred, and
   * this is a `SettingsCache` hit rather than a query. WRITES stay on it.
   */
  const readLists = (guildId: string): Promise<Record<string, string[]>> =>
    deps.settings.listNamedLists(guildId);

  /** Re-renders the named-lists panel in place, after a mutation or a Back. */
  async function refreshListsPanel(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    opts: { note?: string } = {},
  ): Promise<void> {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    const lists = await readLists(interaction.guildId!);
    await interaction.editReply(toUpdate(buildListsPanel(lists, opts)));
  }

  /** The named-lists panel buttons: add, edit, remove, back, close. */
  async function handleListsButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseListsId(interaction.customId);
    if (!parsed) return;
    const guildId = interaction.guildId!;
    const { action, name } = parsed;

    if (action === 'close') {
      await interaction.update({ content: 'Closed.', embeds: [], components: [] });
      return;
    }
    // Showing a modal is itself the acknowledgement, so this must not defer.
    if (action === 'add') {
      await interaction.showModal(buildListEditModal());
      return;
    }
    if (action === 'back') {
      await interaction.deferUpdate();
      await refreshListsPanel(interaction);
      return;
    }
    // edit / remove both address one list, which may be gone by now.
    if (name === null) return;
    if (action === 'remove') {
      await interaction.deferUpdate();
      const res = await run(guildId, 'lists:remove', () =>
        deps.settings.removeNamedList(guildId, name),
      );
      await refreshListsPanel(interaction, { note: formatResult(res) });
      return;
    }
    if (action === 'edit') {
      const options = findList(await readLists(guildId), name);
      if (!options) {
        await interaction.deferUpdate();
        await refreshListsPanel(interaction, { note: 'That list is no longer there.' });
        return;
      }
      await interaction.showModal(buildListEditModal(name, options));
    }
  }

  /** The `/setup` "More settings" select, and the alias picker. */
  async function handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === SETUP_SETTINGS_ID) {
      const chosen = interaction.values[0];
      if (!chosen || !chosen.startsWith(SETUP_PREFIX)) {
        // Values are chosen client-side, so this is either a forged submit or a
        // panel from a build this one does not share. Either way it gets an
        // answer rather than a silent "This interaction failed".
        await safeReply(interaction, 'That option is out of date. Run `/setup` again.');
        return;
      }
      // Gated here as well as inside, mirroring the alias branch below: this is
      // the boundary, and `runSetupAction` re-checks for the button path.
      if (!(await requireManageChannels(interaction))) return;
      return runSetupAction(interaction, chosen.slice(SETUP_PREFIX.length));
    }
    if (interaction.customId === LISTS_SELECT_ID) {
      if (!(await requireManageChannels(interaction))) return;
      const name = interaction.values[0];
      if (!name) return;
      const lists = await readLists(interaction.guildId!);
      const options = findList(lists, name);
      if (!options) {
        await respond(
          interaction,
          buildListsPanel(lists, { note: 'That list is no longer there.' }),
        );
        return;
      }
      await respond(interaction, buildListDetailPanel(name, options));
      return;
    }
    if (interaction.customId !== ALIAS_SELECT_ID) return;
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    // The option value IS the hash (see buildAliasListPanel), so this resolves
    // the same way the buttons do, including the "no longer there" path.
    const hash = interaction.values[0];
    if (!hash) return;
    const aliases = await readAliases(guildId);
    const found = findAliasByHash(aliases, hash);
    if (!found) {
      await respond(
        interaction,
        buildAliasListPanel(aliases, { note: 'That alias is no longer there.' }),
      );
      return;
    }
    await respond(interaction, buildAliasDetailPanel(found.game, found.alias));
  }

  // -- /setup : the primary entry point ------------------------------------

  /** Gathers everything the `/setup` panel shows for this guild + viewer. */
  async function buildSetupReply(
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | StringSelectMenuInteraction
      | ModalSubmitInteraction,
    opts: { note?: string } = {},
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
    const status = guildRow?.authStatus ?? 'trial';
    /**
     * Self-host renders no plan line at all.
     *
     * `formatPlan` still has its self-hosted branch for any other caller, but
     * on a panel whose whole purpose is to stop showing fields that can only
     * ever say "fine", a billing line for a deployment with no billing is the
     * clearest example of one.
     */
    const plan = deps.selfHosted
      ? null
      : formatPlan({
          guildId,
          memberCount: interaction.guild?.memberCount ?? 0,
          status,
          expiresAt: guildRow?.authExpiresAt ?? null,
          graceUntil: guildRow?.graceUntil ?? null,
          selfHosted: false,
          now: new Date(),
          // Both unconditional: the billed tier is what any subscriber pays for,
          // pooled or not, and `shared` only changes the wording.
          billedTier: guildRow?.tier ?? null,
          shared: guildRow?.poolId != null,
        });
    /**
     * Self-host is always `ok`: `isEntitled` short-circuits on it, so there is
     * no state a self-hoster can reach where the panel should be telling them
     * to pay for something.
     */
    const entitlement: SetupEntitlement = deps.selfHosted
      ? 'ok'
      : status === 'expired'
        ? 'expired'
        : status === 'grace'
          ? 'grace'
          : 'ok';
    /**
     * Creator channels whose Discord channel is gone are hidden from the panel,
     * never deleted (owner, 2026-08-27, and see the note in `reconcileGuild`).
     * Nothing anywhere removes an `auto_channels` row except a `channelDelete`
     * dispatch, so a row can outlive its channel: an admin who deletes a creator
     * channel while a shard is down leaves one behind. Keeping the row is
     * deliberate, because cache absence is not proof of deletion. Naming a
     * channel that is not there is the half a user could actually see, and
     * Discord renders the stale mention as "#deleted-channel", which reads as a
     * bug in AVC.
     *
     * Safe here in a way the background sweep is not: this interaction arrived
     * through the guild, so its channel cache is populated. It still fails open
     * on an empty cache rather than telling an admin their setup has vanished.
     */
    const channelCache = interaction.guild?.channels.cache;
    const primaries =
      channelCache && channelCache.size > 0
        ? config.primaries.filter((p) => channelCache.has(p.channelId))
        : config.primaries;

    return buildSetupPanel({
      enabled: config.enabled,
      isAdmin: hasManageChannels(interaction),
      plan,
      guildId,
      missingPermissions,
      primaries,
      managed: managedRows,
      problems: deps.permissionProblems?.recent(guildId) ?? [],
      assistant: Boolean(deps.assistant),
      listCount: Object.keys(config.lists).length,
      ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
      entitlement,
      // Guild-scoped, so an admin clicking it cannot authorize into the wrong
      // server. Self-host grants permissions on the role instead, so there is
      // no OAuth screen worth sending them to.
      ...(deps.selfHosted ? {} : { inviteUrl: reinviteUrlFor(deps.clientId, guildId) }),
      ...(opts.note ? { note: opts.note } : {}),
    });
  }

  /**
   * Opens the panel, acknowledging FIRST.
   *
   * Discord gives an interaction three seconds to be acknowledged, and this
   * handler cannot promise that. `buildSetupReply` already runs its queries
   * in parallel, but it goes through `run()`, which puts the work on the
   * guild's own queue behind whatever else that guild is doing, and a guild
   * retrying failed channel creations (each a Discord round trip) can hold
   * the queue for seconds.
   *
   * When it is missed the admin sees "The application did not respond", and
   * the reply that eventually arrives is thrown away with `Unknown
   * interaction` (10062), reading as a broken bot rather than a slow one.
   *
   * Deferring converts three seconds into fifteen minutes. It costs a
   * visible "thinking" state, which is the correct trade for a panel that
   * reads the database.
   */
  async function openSetup(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });
    const { embeds, components } = await buildSetupReply(interaction);
    await interaction.editReply({ embeds: embeds ?? [], components: components ?? [] });
  }

  /**
   * Re-renders the (already-open) panel in place, acknowledging first.
   *
   * Same three-second budget as {@link openSetup} and the same queue behind it.
   * `deferUpdate` keeps the existing message on screen while the work runs,
   * which is what an in-place refresh should look like.
   */
  async function refreshSetupPanel(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    opts: { note?: string } = {},
  ): Promise<void> {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    await interaction.editReply(toUpdate(await buildSetupReply(interaction, opts)));
  }

  /** The `/setup` panel buttons. */
  async function handleSetupButton(interaction: ButtonInteraction): Promise<void> {
    return runSetupAction(interaction, interaction.customId.slice(SETUP_PREFIX.length));
  }

  /**
   * One panel action, whether it arrived as a button or as a "More settings"
   * option.
   *
   * The select's option values ARE the button ids, so both entry points hand the
   * same `action` string to the same body. That is what keeps the gating honest:
   * there is one place an action can be reached from, not two that have to be
   * kept in step.
   */
  async function runSetupAction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    action: string,
  ): Promise<void> {
    // Create runs its own entitlement + permission gating (and opens a modal).
    if (action === 'create') return openCreateModal(interaction, { fromSetup: true });
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    // "Back to setup" from a picker that replaced the panel. Read-only, so it
    // needs nothing beyond the Manage Channels check above.
    if (action === 'open') return refreshSetupPanel(interaction);
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
    if (action === 'timezone') {
      // Undispatched, like `readLists` and `readAliases`: `showModal` cannot be
      // deferred, so a queued read would sit behind every rename in flight.
      const config = await deps.settings.getConfig(guildId);
      await interaction.showModal(buildTimeZoneModal(config.timezone));
      return;
    }
    if (action === 'lists') {
      // Always reached from the panel, so the panel is what it replaces.
      // `refreshListsPanel` defers for us if this branch ever gains a caller
      // that has not.
      await refreshListsPanel(interaction);
      return;
    }
    if (action === 'manage') {
      // House style: act on the channel you're in, else offer a picker.
      const channelId = currentVoiceChannelId(interaction);
      if (channelId) return manageChannelCore(interaction, channelId);
      await interaction.update(
        // `back`, because this picker REPLACES the panel. Without it the admin
        // has no way back short of running `/setup` again.
        buildChannelPickerMessage('manage', '🛠️ Pick a voice channel to manage:', { back: true }),
      );
      return;
    }
    if (action === 'assistant') {
      const channelId = currentVoiceChannelId(interaction);
      if (channelId) return assistantCore(interaction, channelId);
      await interaction.update(
        buildChannelPickerMessage('templateassistant', '✨ Pick a voice channel to name:', {
          back: true,
        }),
      );
      return;
    }
    /**
     * An action this build does not know. `handleButton` has the same fallback
     * for an unclaimed custom id, but setup ids never reach it because the
     * prefix check routes them here first.
     *
     * Reachable during a rolling deploy, which is what makes it worth answering:
     * a panel rendered by a new machine can be clicked while an older one still
     * owns the shard, and falling off the end silently is what Discord shows as
     * "This interaction failed".
     */
    await safeReply(
      interaction,
      'That control is out of date. Run `/setup` again to get a fresh panel.',
    );
  }

  // Picker commands that require Manage Channels (the open `name` command self-gates
  // on channel ownership in nameCore, so it isn't listed here).
  const ADMIN_PICK_COMMANDS = new Set([
    'manage',
    'position',
    'alwaysprivate',
    'defaultlimit',
    'inheritpermissions',
    'group',
    'templateassistant',
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
      case 'defaultlimit': {
        const raw = parseSetupPickArg(interaction.customId);
        const limit = raw === null ? Number.NaN : Number(raw);
        if (!Number.isInteger(limit)) return;
        return defaultLimitCore(interaction, channelId, limit);
      }
      case 'inheritpermissions':
        return inheritCore(interaction, channelId);
      case 'group':
        return groupCore(interaction, channelId);
      case 'name':
        return nameCore(interaction, channelId);
      case 'templateassistant':
        return assistantCore(interaction, channelId);
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
        `${reason ? `, _${reason}_` : ''}.\n` +
        `Need **${result.required}** votes. (1 so far)`,
      components: [row],
    });
  }

  async function handleButton(interaction: ButtonInteraction, entitled: boolean): Promise<void> {
    if (interaction.customId === CREATE_AGAIN_ID) return openCreateModal(interaction);
    if (interaction.customId.startsWith(CREATE_RETRY_PREFIX)) return handleCreateRetry(interaction);
    if (interaction.customId.startsWith(KICK_PREFIX)) return handleKickVote(interaction);
    if (interaction.customId.startsWith(JOIN_PREFIX)) return handleJoinDecision(interaction);
    if (interaction.customId.startsWith(ADOPT_PREFIX)) return handleAdoptButton(interaction);
    if (interaction.customId.startsWith(GROUP_PREFIX)) return handleGroupButton(interaction);
    if (interaction.customId.startsWith(ALIAS_PREFIX)) return handleAliasButton(interaction);
    if (interaction.customId.startsWith(LISTS_PREFIX)) return handleListsButton(interaction);
    if (interaction.customId.startsWith(CHANNELINFO_PREFIX))
      return handleChannelInfoButton(interaction, entitled);
    if (interaction.customId.startsWith(EDITOR_PREFIX)) return handleEditorButton(interaction);
    if (interaction.customId.startsWith(ASSISTANT_PREFIX))
      return handleAssistantButton(interaction);
    if (interaction.customId.startsWith(IMPORT_PREFIX)) {
      const importDependencies = importDeps();
      if (!importDependencies) {
        await safeReply(interaction, 'Configuration transfer is not available on this instance.');
        return;
      }
      // The ManageGuild re-check lives inside, after the session is claimed, so
      // a click from someone whose roles changed cannot leave the plan claimable
      // by a second click either.
      return handleImportButton(interaction, importDependencies);
    }
    if (interaction.customId.startsWith(SETUP_PREFIX)) return handleSetupButton(interaction);

    /**
     * Nothing claimed this id. Answering matters because falling off the end
     * leaves the interaction unacknowledged, and Discord shows the member a
     * bare "This interaction failed" with no hint of what to do.
     *
     * The reachable case is a rolling deploy: commands register globally and
     * appear instantly, so a panel rendered by a new machine can be clicked
     * while an older one still owns that guild's shard and has no branch for
     * the prefix. Also covers a message left open across a release that
     * retired a prefix. `handleCommand` has had this for the same reason.
     */
    deps.logger.debug(
      { guildId: interaction.guildId, customId: interaction.customId },
      'button with no handler',
    );
    await interaction.reply({
      content: 'That button is out of date. Run the command again to get a fresh one.',
      ephemeral: true,
    });
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
    if (
      interaction.customId === CREATE_MODAL_ID ||
      interaction.customId === CREATE_FROM_SETUP_MODAL_ID
    ) {
      return handleCreateSubmit(interaction);
    }
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
    if (interaction.customId.startsWith(ASSISTANT_PREFIX)) return handleAssistantModal(interaction);
    if (interaction.customId === GENERAL_MODAL_ID) return handleGeneralSubmit(interaction);
    if (interaction.customId === TIMEZONE_MODAL_ID) return handleTimeZoneSubmit(interaction);
    if (interaction.customId.startsWith(LISTS_PREFIX)) return handleListSaveSubmit(interaction);
    // `avc:alias` is the pre-panel id of the Add modal, still accepted so a
    // modal opened on an old instance mid-deploy can submit against a new one.
    // It covers only that direction: a panel opened on a NEW instance whose
    // guild then lands on an old one has buttons that old build cannot route,
    // and the admin has to re-run `/alias`. That is deliberate, since the fix
    // would be shipping the routing ahead of the feature in an earlier release.
    // Removal is tracked in command-parity.md 3.1.
    if (interaction.customId === 'avc:alias') return handleAliasSubmit(interaction);
    if (interaction.customId === ALIAS_MODAL_ID) return handleAliasSubmit(interaction);
    if (interaction.customId.startsWith(ALIAS_PREFIX)) return handleAliasEditSubmit(interaction);
  }

  /** The `/setup` "no game" label modal submit. */
  async function handleGeneralSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const label = interaction.fields.getTextInputValue('label');
    // Always opened from the panel today. The plain-reply branch is the same
    // defence `handleAliasSubmit` keeps: a modal with no message behind it
    // cannot be answered with an update.
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
      const res = await run(guildId, 'setup:general', () =>
        deps.settings.setGeneral(guildId, label),
      );
      await refreshSetupPanel(interaction, { note: formatResult(res) });
      return;
    }
    const res = await run(guildId, 'setup:general', () => deps.settings.setGeneral(guildId, label));
    await interaction.reply({ content: formatResult(res), ephemeral: true });
  }

  /** The `/setup` time zone modal submit. Blank clears the setting. */
  async function handleTimeZoneSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const zone = parseTimeZoneModal(interaction.fields);
    // Same shape as `handleGeneralSubmit`: opened from the panel today, with the
    // plain-reply branch as the defence for a modal that has no message behind it.
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
      const res = await run(guildId, 'setup:timezone', () =>
        deps.settings.setTimeZone(guildId, zone),
      );
      await refreshSetupPanel(interaction, { note: formatResult(res) });
      return;
    }
    const res = await run(guildId, 'setup:timezone', () =>
      deps.settings.setTimeZone(guildId, zone),
    );
    await interaction.reply({ content: formatResult(res), ephemeral: true });
  }

  /**
   * The named-list add/edit modal submit.
   *
   * The custom id carries the name the modal was OPENED on, so a name change in
   * the box is a rename rather than a second list, and the service does the
   * delete and the set in one write.
   */
  async function handleListSaveSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseListsId(interaction.customId);
    if (!parsed || parsed.action !== 'save') return;
    const guildId = interaction.guildId!;
    const { name, options } = parseListEditModal(interaction.fields);
    const previous = parsed.name;
    const res = await run(guildId, 'lists:save', () =>
      previous === null
        ? deps.settings.setNamedList(guildId, name, options)
        : deps.settings.setNamedList(guildId, name, options, previous),
    );
    if (!interaction.isFromMessage()) {
      await interaction.reply({ content: formatResult(res), ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    await refreshListsPanel(interaction, { note: formatResult(res) });
  }

  /** The alias panel's Add modal submit. */
  async function handleAliasSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const { game, alias } = parseAliasModal(interaction.fields);
    // A modal opened from the panel can edit it in place. The retired bare
    // `avc:alias` id was opened straight from the slash command, so it has no
    // message behind it and gets a plain reply instead.
    if (!interaction.isFromMessage()) {
      const res = await run(guildId, 'cmd:alias', () =>
        deps.settings.addAlias(guildId, game, alias),
      );
      await interaction.reply({ content: formatResult(res), ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const res = await run(guildId, 'alias:add', () => deps.settings.addAlias(guildId, game, alias));
    await refreshAliasPanel(interaction, { note: formatResult(res) });
  }

  /** The alias panel's Edit modal submit (`avc:alias:save:<hash>`). */
  async function handleAliasEditSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const parsed = parseAliasId(interaction.customId);
    if (!parsed || parsed.action !== 'save' || !parsed.arg) return;
    const guildId = interaction.guildId!;
    const { game, alias } = parseAliasEditModal(interaction.fields);
    // The edit modal is only ever opened from the panel, so this is defensive.
    // It answers rather than returning silently, which Discord renders as a red
    // "This interaction failed" with nothing explaining it.
    if (!interaction.isFromMessage()) {
      await interaction.reply({ content: 'Run `/alias` and try again.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const found = findAliasByHash(await readAliases(guildId), parsed.arg);
    if (!found) {
      await refreshAliasPanel(interaction, { note: 'That alias is no longer there.' });
      return;
    }
    // A text input caps at 100 characters, but an imported game name is bounded
    // by nothing, so the modal prefills a truncation of anything longer. Reading
    // that back as a new name would delete the real key and store the truncated
    // one, silently breaking an alias the admin only opened to retitle.
    const unchanged = game === found.game.slice(0, ALIAS_INPUT_MAX);
    const res = await run(guildId, 'alias:edit', () =>
      deps.settings.replaceAlias(guildId, found.game, unchanged ? found.game : game, alias),
    );
    await refreshAliasPanel(interaction, { note: formatResult(res) });
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
    assistantSessions.clear();
  };
}

function currentVoiceChannelId(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ChannelSelectMenuInteraction
    | StringSelectMenuInteraction,
): string | undefined {
  // `interaction.member` may be the raw API shape (no `.voice`) when uncached;
  // use it only when it's a real GuildMember, else resolve from the guild cache.
  if (interaction.member instanceof GuildMember) {
    return interaction.member.voice.channelId ?? undefined;
  }
  return interaction.guild?.members.cache.get(interaction.user.id)?.voice.channelId ?? undefined;
}

/** The caller's current game (Playing/Streaming activity name), if any — for `/alias` prefill. */
function currentGameName(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): string | undefined {
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
    | StringSelectMenuInteraction
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
  /** Carried through the picker for commands with a required option. */
  arg?: string,
): Promise<string | undefined> {
  const channelId = currentVoiceChannelId(interaction);
  if (channelId) return channelId;
  await interaction.reply({
    content: prompt,
    components: [channelPickerRow(arg === undefined ? command : `${command}:${arg}`)],
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
  const kind = info.isSecondary ? 'secondary' : info.isPrimary ? 'creator' : 'unmanaged';
  const lines = [
    `**Debug** <#${info.channelId}>  ·  _${kind}_`,
    info.renderedName !== undefined ? `**Rendered name:** \`${info.renderedName}\`` : null,
    `**Effective template:** \`${info.effectiveTemplate}\``,
    info.primaryTemplate ? `**Creator channel template:** \`${info.primaryTemplate}\`` : null,
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
      return `• ${m.bot ? '🤖 ' : ''}${m.displayName}${acts ? `: ${acts}` : ''}`;
    }),
  ].filter((l): l is string => l !== null);
  return lines.join('\n').slice(0, 1900);
}

/**
 * Commands routed through {@link replyResult} that make Discord REST calls
 * before they can answer, so they must defer (see the note at the call site).
 */
const DEFERRED_COMMANDS = new Set([
  'limit',
  'unlimit',
  'private',
  'public',
  'reclaim',
  'transfer',
  'nick',
]);

async function replyResult(
  interaction: ChatInputCommandInteraction,
  result: CommandResult,
): Promise<void> {
  const content = formatResult(result);
  // `editReply` for a deferred command, `reply` for the rest. Not
  // interchangeable: replying to a deferred interaction throws.
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
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

/**
 * Strips `ephemeral` (invalid on `update`/`editReply`) but keeps embeds/components.
 *
 * `content: null` for the same reason {@link respond} carries it: an omitted
 * `content` is dropped from the request body rather than cleared, so editing an
 * embed-only panel over a message that HAD text leaves that text stranded above
 * it. The channel picker sets a prompt ("Pick a voice channel to manage:"), and
 * its "Back to setup" button edits the panel straight back over it.
 */
function toUpdate(
  reply: InteractionReplyOptions,
): Pick<InteractionUpdateOptions, 'content' | 'embeds' | 'components'> {
  return { content: null, embeds: reply.embeds ?? [], components: reply.components ?? [] };
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
