import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
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
  ALWAYS_PREFIX,
  isPermissionError,
  JOIN_PREFIX,
  MAX_USER_LIMIT,
  parseAlwaysId,
  parseJoinId,
  rateLimitNote,
  type AccessCommands,
  type AccessTarget,
  type ChannelDebug,
  type CommandResult,
  type EditorField,
  type EditorScope,
  type EditorState,
  type RoomPanelState,
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
  PRIVACY_URL,
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
import {
  buildTextChannelsModal,
  parseTextChannelsModal,
  TEXT_CHANNELS_MODAL_ID,
} from './textChannelsModal.js';
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
import {
  CONTROL_PANEL_COLOR_KEY,
  CONTROL_PANEL_ENABLED_KEY,
  parsePanelColor,
  groupKeyFor,
  ROOT_GROUP_KEY,
  type ControlPanelAppearanceKey,
  type ControlPanelEntry,
} from '../features/voice/guildSettings.js';
import {
  buildLimitModal,
  buildMemberPicker,
  buildRenameModal,
  CONTROL_PANEL_INPUT_ID,
  CONTROL_PANEL_PREFIX,
  parseControlPanelId,
} from '../features/voice/controlPanel.js';
import {
  accessFeatureFor,
  FEATURE_LABELS,
  featureForCommand,
  isAvailableFeature,
  limitFeatureFor,
  mayUse,
  nickFeatureFor,
  PANEL_ACTION_FEATURE,
  readCommandAccess,
  savedListsInert,
  type CommandFeature,
  type RestrictTarget,
} from '../features/voice/commandAccess.js';
import { ACCESS_REFUSALS } from '../features/voice/accessListsCopy.js';
import {
  RESTRICT_NOTE,
  RESTRICT_PAUSED,
  RESTRICT_REFUSALS,
  renderRestrictionList,
  restrictedRefusal,
} from '../features/voice/commandAccessCopy.js';
import {
  buildAppearanceModal,
  buildControlSettingsPanel,
  CONTROL_APPEARANCE_INPUT_ID,
  CONTROL_SETTINGS_PREFIX,
  parseControlAppearanceId,
  parseControlSettingsId,
  parseControlToggleId,
} from './controlPanelSettings.js';
import {
  BOT_PROFILE_FILE_ID,
  BOT_PROFILE_PREFIX,
  BOT_PROFILE_TEXT_ID,
  buildBotProfileModal,
  buildBotProfilePanel,
  botProfileViewOf,
  parseBotProfileId,
  type BotProfileMember,
  type BotProfileView,
} from './botProfilePanel.js';
import {
  isImageField,
  loadProfileImage,
  profileAuditReason,
  profileEdit,
  profileFailure,
  type BotProfileField,
} from '../features/botProfile.js';
import { describeError } from '../ops/describeError.js';
import { reinviteUrlFor } from '../ops/announce.js';

export interface InteractionDeps {
  client: Client;
  dispatcher: GuildDispatcher;
  voiceCommands: VoiceCommands;
  settings: GuildSettingsService;
  votekick: VoteKickManager;
  privacy: PrivacyService;
  /** A member's saved trusted and blocked lists: `/access trust`, `block`, `remove`, `clear` and `list`. */
  access: AccessCommands;
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
  /**
   * Posts a line to the server's own `/logging` channel, where it has one.
   *
   * Top level rather than read out of {@link configTransfer}'s bundle, for the
   * reason {@link flags} gives: a line hidden behind another feature's optional
   * dependency silently goes unposted in any deployment without that feature.
   * Optional so a test fixture stays small, and absent means nothing is posted.
   */
  serverLog?: (guildId: string, level: 1 | 2 | 3, message: string) => void;
  /**
   * Whether `/restrict` enforcement is switched off (`command_access.disabled`).
   *
   * A function over the creation gate's cached 2 second snapshot, and not
   * {@link flags}: `RuntimeFlagsRepository.getBool` is an uncached SELECT per
   * call, and a guard can run on every restricted interaction. Asked only when a
   * refusal is about to happen, so a server with no rules never pays for it, and
   * it never throws (a failed read counts as not disabled). Top level for the
   * reason {@link flags} gives, and optional so a test fixture stays small:
   * absent means not disabled.
   */
  commandAccessDisabled?: () => Promise<boolean>;
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
   * most state metrics are derivable from a table after the
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

/**
 * The guild's stored settings blob, as the router read it for this interaction.
 *
 * Undefined when the row carries none, which every guard reads as "no
 * restrictions" and a test fixture without a `settings` field gets for free.
 */
type StoredSettings = Record<string, unknown> | undefined;

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
  // Guilds whose room panels are being brought back into line after a
  // `/controlpanel` change, so several toggles in a row cost one sweep and not
  // one each. See `refreshPanelsSoon`.
  const panelRefreshes = new Map<string, 'running' | 'again'>();

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

    // Hard gate: in an expired guild every interaction
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
    //
    // So does the row's settings, for the restriction guards, for the same reason
    // and a second one: this read is uncached, so it is never staler than the
    // `/restrict` write that preceded this click, which a cache hit could be.
    const settings = guildRow?.settings;
    if (interaction.isChatInputCommand()) return handleCommand(interaction, entitled, settings);
    if (interaction.isButton()) return handleButton(interaction, entitled, settings);
    if (interaction.isChannelSelectMenu()) return handleChannelSelect(interaction, settings);
    if (interaction.isStringSelectMenu()) {
      return handleStringSelect(interaction, entitled, settings);
    }
    if (interaction.isModalSubmit()) return handleModal(interaction, settings);
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
       * `/restrict list`, `remove` and `clear` stay open and `add` is refused,
       * which is `/botprofile`'s resets and sets over again: the hard gate stops
       * writes and destroys nothing, so a gated admin can still see who is
       * restricted and lift a restriction, and cannot put a new one up. Decided
       * here and not in the list below because it is the subcommand that differs.
       */
      if (interaction.commandName === 'restrict') {
        return interaction.options.getSubcommand(false) !== 'add';
      }
      /**
       * `/unhide` is open and `/hide` is not: the hard gate stops writes and destroys
       * nothing, and showing a room again is an undo that only removes. A gated owner
       * whose room is hidden can bring it back, and cannot hide another.
       */
      if (interaction.commandName === 'unhide') return true;
      /**
       * `/public` is open for the same reason, and for one more: `/unhide` puts a hidden
       * room back to LOCKED, and in a guild that has since been gated a locked room is
       * a trap. Its "⇩ Join" channel is made but nobody can knock on it (the join listener
       * drops knocks in a gated guild), and an owner who could not then open the room
       * would have a room nobody else can enter. Opening only ever removes: it takes the
       * lock off, deletes the Join channel and restores what the room had, and the guild
       * ends up with fewer restrictions and no new automation. A guild that is gated
       * while rooms are hidden or locked therefore never strands one.
       */
      if (interaction.commandName === 'public') return true;
      /**
       * `/access remove`, `clear` and `list` stay open and `trust`, `block` and `admit`
       * are refused, `/restrict`'s split again: the hard gate stops writes and destroys
       * nothing, so a member can still see their lists and erase what they saved, and
       * cannot put anyone new on one. Decided here because it is the subcommand that
       * differs.
       */
      if (interaction.commandName === 'access') {
        return ['remove', 'clear', 'list'].includes(interaction.options.getSubcommand(false) ?? '');
      }
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
        /**
         * The panel opens so a gated admin can still take the bot's custom
         * face off their server: the hard gate stops writes and destroys
         * nothing, and a reset only removes. Its four set buttons are hidden
         * in this state and refused below, so nothing new can go up.
         */
        'botprofile',
      ].includes(interaction.commandName);
    }
    if (interaction.isButton()) {
      // The assistant writes a template, so it is a write path like `/create`
      // and must not slip through on the `/setup` panel's blanket exemption.
      // (It is free on every tier — see the assistant's own docs — but an
      // expired guild has no automation for a template to drive.)
      // The named-lists panel is reachable from the exempt settings select, so
      // its own buttons have to be exempt too. Without this a gated admin
      // is shown a panel whose every button, Close included, answers with
      // the reactivation notice.
      if (interaction.customId.startsWith(LISTS_PREFIX)) return true;
      if (interaction.customId === `${SETUP_PREFIX}assistant`) return false;
      // A `/channelinfo` view button, or the command's own exemption stops at
      // the first click and the panel answers with the reactivation notice.
      if (interaction.customId.startsWith(CHANNELINFO_PREFIX)) return true;
      /**
       * The room panel's Info button, and the two below it that only open: Unhide and
       * Unlock. Every other button on the panel is a write and stays refused, which is
       * why each of these matches its whole action id and not the namespace.
       *
       * Info runs `/channelinfo`, which is on the command list above for
       * `/export`'s reason: refusing to tell somebody how their own server is
       * configured because a payment lapsed is not what the hard gate is for.
       * A button that did the same thing and was refused would make the
       * exemption depend on which surface you reached it from.
       */
      if (interaction.customId.startsWith(`${CONTROL_PANEL_PREFIX}info:`)) return true;
      // Unhide, the button of the `/unhide` command above, for the same reason. Hide is
      // a write and stays refused, with every other button on the panel.
      if (interaction.customId.startsWith(`${CONTROL_PANEL_PREFIX}unhide:`)) return true;
      // And Unlock, the button of `/public`, which is open for the reason given there: a
      // locked or hidden room must always have a way back to open in a gated guild.
      if (interaction.customId.startsWith(`${CONTROL_PANEL_PREFIX}unlock:`)) return true;
      // The bot profile's resets, not its set buttons: see the command's
      // entry above. The set MODALS are absent from the modal branch
      // below for the same reason.
      if (interaction.customId.startsWith(BOT_PROFILE_PREFIX)) {
        return parseBotProfileId(interaction.customId)?.action !== 'set';
      }
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
      if (interaction.customId === LISTS_SELECT_ID) return true;
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
        interaction.customId === TEXT_CHANNELS_MODAL_ID ||
        interaction.customId.startsWith(LISTS_PREFIX)
      );
    }
    return false;
  }

  async function handleCommand(
    interaction: ChatInputCommandInteraction,
    entitled: boolean,
    settings: StoredSettings,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const channelId = currentVoiceChannelId(interaction);

    /**
     * `/restrict` rules, checked FIRST: before the usage count and before the
     * defer below.
     *
     * Before the count, so a refused command is not counted. The number means
     * "commands that ran", and an admin turning a feature off for somebody must
     * not make it look busier.
     *
     * Before the defer, because a refusal is a plain ephemeral reply and a
     * deferred interaction would have to be edited into one. The one thing this
     * can wait on is the lever read, and only when a refusal is about to happen,
     * through the creation gate's cached snapshot, so a server with no rules
     * costs nothing. `/limit 0` and `/nick reset` are undo directions and are
     * never restricted.
     */
    if (!(await allowed(interaction, settings, guardedFeatureOf(interaction)))) return;

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
        return openNamePanel(interaction, settings);
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
      case 'access':
        return handleAccess(interaction, channelId, settings);
      case 'hide':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:hide', () => deps.privacy.hide(guildId, channelId, userId)),
        );
      case 'unhide':
        return replyResult(
          interaction,
          await run(guildId, 'cmd:unhide', () => deps.privacy.unhide(guildId, channelId, userId)),
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
      case 'textchannels':
        return handleTextChannels(interaction);
      case 'defaultlimit':
        return handleDefaultLimit(interaction);
      case 'restrict':
        return handleRestrict(interaction);
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
      case 'controlpanel':
        return openControlSettings(interaction);
      case 'botprofile':
        return openBotProfile(interaction, entitled);
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
        gameNameMode: config.gameNameMode,
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
  async function handleAssistantButton(
    interaction: ButtonInteraction,
    settings: StoredSettings,
  ): Promise<void> {
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
        settings,
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

  /**
   * `/textchannels` → toggle per-room companion text channels for a creator
   * channel (yours, or picked).
   *
   * The legacy command of the same name, narrowed from per guild to per creator
   * channel: a companion costs a slot in a category Discord caps at 50, so the
   * guilds that want it pay only where they asked for it.
   */
  async function handleTextChannels(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelId = await resolveOrPick(
      interaction,
      'textchannels',
      '💬 Pick a creator channel to toggle text channels for:',
    );
    if (!channelId) return;
    await textChannelsCore(interaction, channelId);
  }

  async function textChannelsCore(
    interaction: ManageableInteraction,
    channelId: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const res = await run(guildId, 'cmd:textchannels', () =>
      deps.settings.toggleTextChannel(guildId, channelId),
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

  // -- /restrict ------------------------------------------------------------

  /**
   * `/restrict add`, `remove`, `clear` and `list`: who may not use which room
   * command.
   *
   * **Re-gated in code, not only by `default_member_permissions`.** That default
   * is a DEFAULT: a server admin can re-open any command to any role in Server
   * Settings > Integrations, and this one decides who may use every owner-level
   * room command in the server.
   *
   * **Ephemeral, and no mention pings anyone.** A reply names the people and
   * roles the admin asked about and nobody else, and `allowedMentions` is empty
   * so looking at a list can never notify the people on it.
   *
   * **Not deferred**, since it is a settings write and no Discord call. The one
   * exception is the re-render after a nickname is removed, which runs AFTER the
   * reply for that reason: it spends rename budget, and an admin should not wait
   * on it or be told it failed when the restriction itself landed.
   *
   * **The write has landed by the time the reply is sent, and the reply can
   * still throw.** The write waits its turn in the guild's queue and the
   * interaction token lasts three seconds, so a busy guild can expire it. The
   * audit line is therefore posted BEFORE the reply, and the re-render runs in a
   * `finally`, so neither is lost with the reply.
   *
   * This only edits the map. Enforcing it is the guard's job, not this command's.
   */
  async function handleRestrict(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const sub = interaction.options.getSubcommand(false);

    if (sub === 'list') {
      const access = await run(guildId, 'cmd:restrict:list', () =>
        deps.settings.getCommandAccess(guildId),
      );
      // Said at the top, because a list that shows rules which nobody is being
      // refused by is a list that misleads. Asked here whatever the rules are: the
      // lever is a fact about this fleet, and a rule added now is paused too.
      const paused = (await deps.commandAccessDisabled?.()) === true;
      return replyRestrict(interaction, renderRestrictionList(access, { paused }));
    }
    if (sub !== 'add' && sub !== 'remove' && sub !== 'clear') {
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
      return;
    }

    // Client input even though Discord offers choices: a hand-built request can
    // send anything, and `hide` has an id but no command yet.
    const feature = interaction.options.getString('feature', true);
    if (!isAvailableFeature(feature)) {
      return replyRestrict(
        interaction,
        formatResult({ ok: false, message: RESTRICT_REFUSALS.unknownFeature }),
      );
    }

    /**
     * The audit trail, in the server's own `/logging` channel and only for a
     * change that happened. Deliberately not an `ops_audit` row: that table is
     * operator-facing and retained, and its one customer-written row is the
     * import snapshot, so a member id from here would be a new kind of thing in it.
     *
     * **It names the admin and the feature, not the person or role.** The log
     * channel is read by whoever the admin chose, often more people than the
     * admins, and `/restrict list` already tells an admin who is restricted.
     */
    const audit = (line: string): void => deps.serverLog?.(guildId, 1, line);
    const label = FEATURE_LABELS[feature];
    const admin = `<@${interaction.user.id}>`;

    if (sub === 'clear') {
      const cleared = await run(guildId, 'cmd:restrict:clear', () =>
        deps.settings.clearCommandRestrictions(guildId, feature),
      );
      if (cleared.changed) {
        audit(`🔓 ${admin} lifted every restriction on **${label}**.`);
        refreshPanelsSoon(guildId);
      }
      return replyRestrict(interaction, formatResult(cleared));
    }

    const picked = pickedWho(interaction);
    if (!picked) {
      return replyRestrict(
        interaction,
        formatResult({ ok: false, message: RESTRICT_REFUSALS.unusable }),
      );
    }
    const { target } = picked;

    /**
     * Only `add` is refused on who the target is. Removing is the way out of a
     * rule that no longer makes sense, and the person may since have become a
     * manager, so it must never be blocked by a check that only applies going in.
     */
    if (sub === 'add') {
      const refusal =
        target.kind === 'role' && target.id === guildId
          ? RESTRICT_REFUSALS.everyone
          : picked.isBot
            ? RESTRICT_REFUSALS.bot(target)
            : carriesManageChannels(picked.permissions)
              ? RESTRICT_REFUSALS.manager(target)
              : null;
      if (refusal) {
        return replyRestrict(interaction, formatResult({ ok: false, message: refusal }));
      }
    }

    const res = await run(guildId, `cmd:restrict:${sub}`, () =>
      sub === 'add'
        ? deps.settings.addCommandRestriction(guildId, feature, target)
        : deps.settings.removeCommandRestriction(guildId, feature, target),
    );
    // A repeat that still removed a saved nickname changed stored data, so it is
    // logged too, as the same line.
    if (res.changed || res.nicknameCleared) {
      audit(
        sub === 'add'
          ? `🔒 ${admin} added a restriction on **${label}**.`
          : `🔓 ${admin} lifted a restriction on **${label}**.`,
      );
    }
    // Every write that changed who is restricted brings the posted panels into
    // line, as `/controlpanel` edits do: a room whose owner this rule now covers
    // loses the button, and one it no longer covers gets it back. Detached and
    // coalesced, so several edits in a row cost one sweep. A repeat that only
    // removed a saved nickname changed no panel.
    if (res.changed) refreshPanelsSoon(guildId);
    try {
      // The note rides on a successful add only: it is what an admin should hear
      // before relying on a rule, and a refusal put nothing in place to rely on.
      // While enforcement is paused the same reply has to say so, or "can no
      // longer use" would be untrue in the sentence above it.
      const paused = sub === 'add' && res.ok && (await deps.commandAccessDisabled?.()) === true;
      await replyRestrict(
        interaction,
        sub === 'add' && res.ok
          ? `${formatResult(res)}${paused ? `\n\n${RESTRICT_PAUSED}` : ''}\n\n${RESTRICT_NOTE}`
          : formatResult(res),
      );
    } finally {
      if (res.nicknameCleared) {
        // `/nick` re-renders the caller's rooms so `@@owner@@` picks up the change,
        // and this removes a nickname, so the same rooms need the same re-render.
        try {
          await run(guildId, 'cmd:restrict:render', () =>
            deps.feature.rerenderByOwner(guildId, target.id),
          );
        } catch (err) {
          deps.logger.warn({ err, guildId }, 'could not re-render rooms after removing a nickname');
        }
      }
    }
  }

  // -- /access ----------------------------------------------------------------

  /**
   * `/access trust`, `block`, `admit`, `remove`, `clear` and `list`: a member's saved
   * trusted and blocked lists, and one-off admission to the room they are in.
   *
   * **The lists are the member's own, per server, and apply to the rooms they create
   * here.** An Administrator is never stopped by a block, which every reply that
   * saves one says. `trust`, `block` and `admit` are what a `/restrict` rule on Saved
   * lists stops, decided before the defer by `guardedFeatureOf`, and `remove`, `clear`
   * and `list` never are: they are how a member erases what they saved.
   *
   * **Deferred by the router, so every answer is an edit**, with mentions suppressed:
   * a reply names the people on a list and pings none of them. Each subcommand returns
   * a result and none can throw into the guild's queue (see `AccessCommands`).
   * `admit` is the privacy service's, since it is about the one room the member is in,
   * and the service refuses an ownerless room, one they do not own and a public one.
   */
  async function handleAccess(
    interaction: ChatInputCommandInteraction,
    channelId: string | undefined,
    settings: StoredSettings,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand(false);
    const answer = (result: CommandResult): Promise<void> =>
      replyAccess(interaction, formatResult(result));

    if (sub === 'list') {
      // Open to a member who is denied the feature, as an undo direction, so the reply must
      // not tell them their lists apply when they do not.
      const inert = await listsInertFor(interaction, settings);
      return answer(
        await run(guildId, 'cmd:access:list', () => deps.access.list(guildId, userId, { inert })),
      );
    }
    if (sub === 'clear') {
      // Client input even though Discord offers choices: anything else empties both.
      const which = interaction.options.getString('list');
      const kind = which === 'trusted' || which === 'blocked' ? which : undefined;
      return answer(
        await run(guildId, 'cmd:access:clear', () => deps.access.clear(guildId, userId, kind)),
      );
    }
    if (sub !== 'trust' && sub !== 'block' && sub !== 'admit' && sub !== 'remove') {
      return replyAccess(interaction, 'Unknown command.');
    }
    const member = pickedMember(interaction);
    if (!member) return answer({ ok: false, message: ACCESS_REFUSALS.unusable });

    switch (sub) {
      case 'trust':
      case 'block':
        return answer(
          await run(guildId, `cmd:access:${sub}`, () =>
            deps.access.save(guildId, userId, member, sub === 'trust' ? 'trusted' : 'blocked'),
          ),
        );
      case 'admit':
        return answer(
          await run(guildId, 'cmd:access:admit', () =>
            deps.privacy.admit(guildId, channelId, userId, member.id),
          ),
        );
      case 'remove':
        return answer(
          await run(guildId, 'cmd:access:remove', () =>
            deps.access.remove(guildId, userId, member.id),
          ),
        );
    }
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

  async function openNamePanel(
    interaction: ChatInputCommandInteraction,
    settings: StoredSettings,
  ): Promise<void> {
    const target = await resolveOrPick(interaction, 'name', '✏️ Pick a voice channel to rename:');
    if (!target) return;
    await nameCore(interaction, target, settings);
  }

  /**
   * Opens the `/name` editor for a channel.
   *
   * Guarded here as well as in `handleCommand`, because the out-of-voice-channel
   * picker reaches this without passing through the command's guard: `/name`
   * answers with a picker, and the chosen channel arrives as a separate select
   * interaction. The editor's own buttons and modal are guarded in
   * {@link applyEditor}, which every write goes through.
   */
  async function nameCore(
    interaction: ManageableInteraction,
    channelId: string,
    settings: StoredSettings,
  ): Promise<void> {
    if (!(await allowed(interaction, settings, PANEL_ACTION_FEATURE.rename))) return;
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

  async function handleEditorButton(
    interaction: ButtonInteraction,
    settings: StoredSettings,
  ): Promise<void> {
    const parsed = parseEditorId(interaction.customId);
    if (!parsed) return;
    const { action, scope, field, channelId } = parsed;
    if (action === 'close') {
      await interaction.update({ content: 'Closed.', embeds: [], components: [] });
      return;
    }
    if (action === 'edit') {
      // The panel may have been opened before a rule was added, and the modal is
      // the first response, so a denied member is turned away before it opens
      // rather than after they have typed something. `applyEditor` still checks
      // the submit.
      if (
        scope === 'channel' &&
        !(await allowed(interaction, settings, PANEL_ACTION_FEATURE.rename))
      ) {
        return;
      }
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
      await refreshEditorPanel(interaction, scope, field, channelId, 'reset', settings);
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

  async function handleEditorModal(
    interaction: ModalSubmitInteraction,
    settings: StoredSettings,
  ): Promise<void> {
    const parsed = parseEditorId(interaction.customId);
    if (!parsed || parsed.action !== 'save') return;
    if (!interaction.isFromMessage()) return; // editor modals are always panel-driven
    const value = interaction.fields.getTextInputValue('template');
    await interaction.deferUpdate();
    await refreshEditorPanel(
      interaction,
      parsed.scope,
      parsed.field,
      parsed.channelId,
      value,
      settings,
    );
  }

  /** Applies a change and edits the (already-deferred) panel in place. */
  async function refreshEditorPanel(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    scope: EditorScope,
    field: EditorField,
    channelId: string,
    value: string,
    settings: StoredSettings,
  ): Promise<void> {
    const applied = await applyEditor(interaction, scope, field, channelId, value, settings);
    if (applied.ok) {
      await interaction.editReply(
        toUpdate(renderEditorPanel(scope, channelId, applied.state, applied.opts)),
      );
    } else {
      await interaction.followUp({ content: `⚠️ ${applied.message}`, ephemeral: true });
    }
  }

  /**
   * Applies a name/status change for a channel override or a primary template.
   *
   * **The `channel` scope is guarded here because it is the one write path for
   * a room's name AND its voice status**, reached by `/name`'s editor, its
   * buttons and its modal, so a restriction on Name has to hold at this seam and
   * not only at the command. A refusal comes back as a failed result like every
   * other, which the callers already answer ephemerally. The two admin scopes
   * are not restrictable: they are governed by Manage Channels, which a rule
   * cannot stop.
   */
  async function applyEditor(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    scope: EditorScope,
    field: EditorField,
    channelId: string,
    value: string,
    settings: StoredSettings,
  ): Promise<
    | { ok: true; state: EditorState; opts: { updated: true; note?: string } }
    | { ok: false; message: string }
  > {
    const guildId = interaction.guildId!;
    if (scope === 'channel') {
      const refusal = await refusalFor(interaction, settings, PANEL_ACTION_FEATURE.rename);
      if (refusal !== null) return { ok: false, message: refusal };
    }
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
     * is about. An admin with Manage Channels may
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

  // -- /restrict : the guard -------------------------------------------------

  /**
   * The sentence to refuse the caller with, or null when they may proceed.
   *
   * **One guard, on every path that does what a restricted command does**: the
   * slash command, the room panel's buttons, modals and pickers, and the
   * `/template` channel editor that `/name` opens. A rule that stopped only the
   * command would leave the same act one click away.
   *
   * **Fails OPEN on a problem reading the rules.** A rule that locks out people it
   * was never meant to is the failure an admin cannot diagnose from inside
   * Discord, so a settings blob of the wrong shape, a missing row and anything
   * that throws while checking all read as "no restriction", and a throw is
   * logged by id. The one exception is the lever: its accessor never throws, and
   * a failed flag read counts as NOT disabled, so the rules keep applying.
   *
   * **Ordered so the common case costs nothing.** The permission bit and the
   * stored map are checked first and are pure. The `command_access.disabled`
   * lever is asked about only once a refusal is certain, so a server with no
   * rules, and every caller a rule does not name, never reads it.
   *
   * The reply says only that a server admin turned the feature off for this
   * member: never why, and never who else is restricted.
   */
  async function refusalFor(
    interaction: Interaction,
    settings: StoredSettings,
    feature: CommandFeature | null,
  ): Promise<string | null> {
    if (feature === null) return null;
    const guildId = interaction.guildId;
    try {
      if (guildId === null) return null;
      const caller = {
        userId: interaction.user.id,
        roleIds: callerRoleIds(interaction),
        canManage: callerCanManage(interaction),
      };
      if (mayUse(feature, caller, readCommandAccess(settings ?? {}, guildId))) return null;
      if (await deps.commandAccessDisabled?.()) return null;
      // The only trace of a refusal an operator gets, since it is seen from the
      // member's side alone. Ids only, never what they typed.
      deps.logger.info({ guildId, userId: caller.userId, feature }, 'refused by a restriction');
      return restrictedRefusal(feature);
    } catch (err) {
      deps.logger.warn({ err, guildId, feature }, 'could not check a restriction, allowing it');
      return null;
    }
  }

  /**
   * Whether the caller is denied Saved lists, so what they saved applies to nothing (the
   * rule every place that applies a list asks, see `savedListsInert`), for the one reply
   * that would otherwise say it does. Not a refusal, so it logs nothing as one. Fails open,
   * like the guard, and is off while `command_access.disabled` is on, when nobody's lists
   * are inert.
   */
  async function listsInertFor(
    interaction: Interaction,
    settings: StoredSettings,
  ): Promise<boolean> {
    const guildId = interaction.guildId;
    try {
      if (guildId === null) return false;
      const inert = savedListsInert(readCommandAccess(settings ?? {}, guildId), {
        userId: interaction.user.id,
        roleIds: callerRoleIds(interaction),
        canManage: callerCanManage(interaction),
      });
      return inert && !(await deps.commandAccessDisabled?.());
    } catch (err) {
      deps.logger.warn({ err, guildId }, 'could not check a restriction for a list, allowing it');
      return false;
    }
  }

  /**
   * Whether to proceed, answering a refusal ephemerally.
   *
   * `safeReply` rather than `interaction.reply`: the interaction may already be
   * deferred or replied to, and it never edits or updates a message, which on the
   * room panel would replace the one public message every occupant reads.
   */
  async function allowed(
    interaction: Interaction,
    settings: StoredSettings,
    feature: CommandFeature | null,
  ): Promise<boolean> {
    const refusal = await refusalFor(interaction, settings, feature);
    if (refusal === null) return true;
    await safeReply(interaction, `⚠️ ${refusal}`);
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
    interaction:
      | ChatInputCommandInteraction
      | ButtonInteraction
      | StringSelectMenuInteraction
      | ModalSubmitInteraction,
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
      content: [
        `📜 AVC is open source, licensed AGPL-3.0: ${GITHUB_URL}`,
        `🔒 What it stores, and what it never touches: ${PRIVACY_URL}`,
      ].join('\n'),
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
   * "reactivate at ..." is a dead end for them.
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
  async function handleStringSelect(
    interaction: StringSelectMenuInteraction,
    entitled: boolean,
    settings: StoredSettings,
  ): Promise<void> {
    if (interaction.customId.startsWith(CONTROL_PANEL_PREFIX))
      return handleControlPanelSelect(interaction, settings);
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
      return runSetupAction(interaction, chosen.slice(SETUP_PREFIX.length), entitled);
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
      gameNameMode: config.gameNameMode,
      // Resolved from the guild's own cache so the panel can name the role
      // rather than printing a snowflake. A role that no longer exists simply
      // has no name, and the option still reports that one is configured.
      ...(config.textChannelRoleId
        ? {
            textChannelRoleId: config.textChannelRoleId,
            ...(interaction.guild?.roles.cache.get(config.textChannelRoleId)?.name
              ? {
                  textChannelRoleName: interaction.guild.roles.cache.get(config.textChannelRoleId)!
                    .name,
                }
              : {}),
          }
        : {}),
      ...(config.timezone !== undefined ? { timezone: config.timezone } : {}),
      canManageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true,
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
  async function handleSetupButton(
    interaction: ButtonInteraction,
    entitled: boolean,
  ): Promise<void> {
    return runSetupAction(interaction, interaction.customId.slice(SETUP_PREFIX.length), entitled);
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
    entitled: boolean,
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
    if (action === 'gamemode') {
      // Re-reads rather than trusting the panel it was clicked from, exactly
      // as `toggle` above does: a stale panel would otherwise flip the setting
      // to the value the admin is already looking at.
      const res = await run(guildId, 'setup:gamemode', async () => {
        const config = await deps.settings.getConfig(guildId);
        return deps.settings.setGameNameMode(
          guildId,
          config.gameNameMode === 'top' ? 'shared' : 'top',
        );
      });
      // The note is the only feedback there is. Unlike the pause toggle beside
      // this, nothing on the refreshed panel changes visibly: the new value is
      // reported inside a CLOSED select's option description, so without this
      // the admin picks the setting and sees no answer at all.
      await refreshSetupPanel(interaction, { note: formatResult(res) });
      return;
    }
    if (action === 'timezone') {
      // Undispatched, like `readLists` and `readAliases`: `showModal` cannot be
      // deferred, so a queued read would sit behind every rename in flight.
      const config = await deps.settings.getConfig(guildId);
      await interaction.showModal(buildTimeZoneModal(config.timezone));
      return;
    }
    if (action === 'textchannels') {
      // Undispatched for the same reason as `timezone` above: `showModal`
      // cannot be deferred, so a queued read would sit behind every rename in
      // flight.
      const config = await deps.settings.getConfig(guildId);
      await interaction.showModal(
        buildTextChannelsModal({
          name: config.textChannelName,
          roleId: config.textChannelRoleId ?? null,
        }),
      );
      return;
    }
    if (action === 'lists') {
      // Always reached from the panel, so the panel is what it replaces.
      // `refreshListsPanel` defers for us if this branch ever gains a caller
      // that has not.
      await refreshListsPanel(interaction);
      return;
    }
    if (action === 'botprofile') {
      // One tier above the Manage Channels check above, as `/botprofile` is.
      if (!(await requireManageGuild(interaction))) return;
      // Replaces the panel, as the named lists do.
      await interaction.deferUpdate();
      await showBotProfile(interaction, { canChange: entitled });
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
    'textchannels',
    'defaultlimit',
    'inheritpermissions',
    'group',
    'templateassistant',
  ]);

  /** A voice-channel was chosen from a `avc:setup:pick:<command>` menu → run the command. */
  async function handleChannelSelect(
    interaction: ChannelSelectMenuInteraction,
    settings: StoredSettings,
  ): Promise<void> {
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
      case 'textchannels':
        return textChannelsCore(interaction, channelId);
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
        return nameCore(interaction, channelId, settings);
      case 'templateassistant':
        return assistantCore(interaction, channelId);
    }
  }

  async function handleKickCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = currentVoiceChannelId(interaction);
    const target = interaction.options.getUser('member', true);
    const reason = interaction.options.getString('reason') ?? undefined;

    /**
     * Deferred before the vote is started, and PUBLIC because the vote message is
     * this reply. A vote that resolves at once (one other person in the room) kicks
     * before it answers, and a kick is a record write, an overwrite write and a
     * disconnect against the room's channel bucket, which can outlast the 3 seconds
     * an interaction token lives. A refusal cannot be made ephemeral after a public
     * defer, so it is deleted and said again in a reply only the caller sees.
     */
    await interaction.deferReply();
    let result;
    try {
      result = await run(guildId, 'cmd:kick', () =>
        deps.votekick.start(guildId, channelId, interaction.user.id, target.id, reason),
      );
    } catch (err) {
      // `route`'s catch follows up, and would leave this public spinner behind it.
      await interaction.deleteReply().catch(() => undefined);
      throw err;
    }
    if (!result.ok) {
      await interaction.deleteReply();
      await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral });
      return;
    }
    // `start` only succeeds with a channel, so narrow explicitly (no `!`).
    if (!channelId) {
      await interaction.deleteReply().catch(() => undefined);
      return;
    }
    if (!deps.votekick.hasSession(channelId)) {
      // Resolved immediately (1v1) — already kicked.
      await interaction.editReply({ content: `✅ ${result.message}` });
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
    await interaction.editReply({
      content:
        `🗳️ <@${interaction.user.id}> started a vote to kick <@${target.id}>` +
        `${reason ? `, _${reason}_` : ''}.\n` +
        `Need **${result.required}** votes. (1 so far)`,
      components: [row],
    });
  }

  async function handleButton(
    interaction: ButtonInteraction,
    entitled: boolean,
    settings: StoredSettings,
  ): Promise<void> {
    if (interaction.customId === CREATE_AGAIN_ID) return openCreateModal(interaction);
    if (interaction.customId.startsWith(CREATE_RETRY_PREFIX)) return handleCreateRetry(interaction);
    if (interaction.customId.startsWith(KICK_PREFIX)) return handleKickVote(interaction);
    if (
      interaction.customId.startsWith(JOIN_PREFIX) ||
      interaction.customId.startsWith(ALWAYS_PREFIX)
    ) {
      return handleJoinDecision(interaction, settings);
    }
    if (interaction.customId.startsWith(ADOPT_PREFIX)) return handleAdoptButton(interaction);
    if (interaction.customId.startsWith(GROUP_PREFIX)) return handleGroupButton(interaction);
    if (interaction.customId.startsWith(ALIAS_PREFIX)) return handleAliasButton(interaction);
    if (interaction.customId.startsWith(LISTS_PREFIX)) return handleListsButton(interaction);
    if (interaction.customId.startsWith(CHANNELINFO_PREFIX))
      return handleChannelInfoButton(interaction, entitled);
    if (interaction.customId.startsWith(EDITOR_PREFIX))
      return handleEditorButton(interaction, settings);
    if (interaction.customId.startsWith(ASSISTANT_PREFIX))
      return handleAssistantButton(interaction, settings);
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
    if (interaction.customId.startsWith(CONTROL_PANEL_PREFIX))
      return handleControlPanelButton(interaction, entitled, settings);
    if (interaction.customId.startsWith(CONTROL_SETTINGS_PREFIX))
      return handleControlSettingsButton(interaction);
    if (interaction.customId.startsWith(BOT_PROFILE_PREFIX))
      return handleBotProfileButton(interaction, entitled);
    if (interaction.customId.startsWith(SETUP_PREFIX))
      return handleSetupButton(interaction, entitled);

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

  /**
   * Owner approves, always allows, denies or blocks a "⇩ Join" request via the message
   * buttons. Always allow has its own custom-id prefix (see `ALWAYS_PREFIX`) and the
   * same card, owner check and acknowledgement as the other three.
   */
  async function handleJoinDecision(
    interaction: ButtonInteraction,
    settings: StoredSettings,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    const always = parseAlwaysId(interaction.customId);
    const parsed = always
      ? { ...always, action: 'always' as const }
      : parseJoinId(interaction.customId);
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
    // Always allow saves the member on the owner's trusted list, so the rule that stops
    // `/access trust` stops it. Before the acknowledgement: a refusal is a plain
    // ephemeral reply, and the card keeps its buttons.
    if (action === 'always' && !(await allowed(interaction, settings, 'access'))) return;
    // Deferred first. A block saves to the owner's list, applies it to the room and
    // moves the requester out, and an approval grants and moves: several calls
    // against the room's channel bucket, which can outlast the 3 seconds a token
    // lives. The buttons stay on the card until there is a result to put there.
    await interaction.deferUpdate();
    const result = await run(guildId, `join:${action}`, () =>
      action === 'approve'
        ? deps.privacy.approveJoin(joinChannelId, requesterId)
        : action === 'always'
          ? deps.privacy.approveJoin(joinChannelId, requesterId, true)
          : deps.privacy.denyJoin(joinChannelId, requesterId, action === 'block'),
    );
    // Nothing was decided (the lever refused an Always allow, and the answer says to use
    // Approve), so the card keeps every button and the refusal is for the owner alone.
    if (!result.ok && 'keepCard' in result && result.keepCard) {
      await interaction.followUp({ content: formatResult(result), flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.editReply({
      content: formatResult(result),
      components: [],
    });
    // The requester can't see the private channel, so post the rejection outcome
    // to the public "⇩ Join" companion's chat (which they can see). On approve
    // they're pulled into the channel, so no companion message is needed. Note a
    // *blocked* user loses access to the companion too, so may not see it — that's
    // inherent to blocking.
    if (result.ok && (action === 'deny' || action === 'block')) {
      await notifyChannel(
        deps.client,
        joinChannelId,
        action === 'block'
          ? `⛔ <@${requesterId}>, your request to join was blocked.`
          : `🚫 <@${requesterId}>, your request to join was declined.`,
      );
    }
  }

  // -- the room control panel ------------------------------------------------

  /**
   * A button on a room's control panel.
   *
   * **Every branch answers ephemerally, and none of them edits the message it
   * was pressed on.** The panel is a persistent public message in a channel
   * many people can read, so the `respond()` / `interaction.update()` shape the
   * ephemeral admin panels use would replace it for everyone, permanently, on
   * the first press.
   *
   * **The room comes from the custom id, not from `interaction.channelId` and
   * not from the clicker's voice state.** When a creator channel has companion
   * text channels switched on the panel is posted into the companion, and that
   * channel names no `secondary_channels` row; reading the clicker's voice
   * state instead would act on whatever room a moderator with companion access
   * happened to be sitting in. The id is ours, it came from a message we
   * posted, and every action below re-resolves the row and re-checks ownership
   * from it, so it is an identity and never a permission.
   */
  async function handleControlPanelButton(
    interaction: ButtonInteraction,
    entitled: boolean,
    settings: StoredSettings,
  ): Promise<void> {
    const parsed = parseControlPanelId(interaction.customId);
    if (!parsed) {
      /**
       * A panel outlives a deploy, unlike every ephemeral panel here: it stays
       * clickable for the whole life of its room. So this is the one
       * out-of-date path that is genuinely likely, and it must not tell the
       * member to "run the command again" when there is no command to run.
       */
      await safeReply(
        interaction,
        'That button is from an older version. Try the command instead.',
      );
      return;
    }
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const { action, roomId } = parsed;

    /**
     * The four ids that are never on a button: two modal submits and two
     * select values. Handled here so the switch below is over the CONTROLS
     * alone and can be made exhaustive.
     */
    if (
      action === 'limitset' ||
      action === 'renameset' ||
      action === 'transferpick' ||
      action === 'kickpick'
    ) {
      await safeReply(interaction, 'That button is from an older version.');
      return;
    }

    /**
     * The `/restrict` guard for every button, before anything else is done with
     * it. This is what makes the panel and the slash command one policy: the
     * action decides the feature (`PANEL_ACTION_FEATURE`, which has a decision
     * for every action), and the undo direction, Claim, Kick and Info map to
     * none. It sits ahead of the switch so it covers `openPanelModal` and
     * `openPanelPicker`, which are reachable only from here, and it runs before
     * `showModal`, which has to be the first response. A refusal is a new
     * ephemeral reply: this message is the shared panel, and no handler here may
     * edit it.
     */
    if (!(await allowed(interaction, settings, PANEL_ACTION_FEATURE[action]))) return;

    switch (action) {
      case 'lock':
        return replyPanelResult(
          interaction,
          () => deps.privacy.makePrivate(guildId, roomId, userId),
          'panel:lock',
        );
      case 'unlock':
        return replyPanelResult(
          interaction,
          () => deps.privacy.makePublic(guildId, roomId, userId),
          'panel:unlock',
        );
      case 'hide':
        return replyPanelResult(
          interaction,
          () => deps.privacy.hide(guildId, roomId, userId),
          'panel:hide',
        );
      case 'unhide':
        return replyPanelResult(
          interaction,
          () => deps.privacy.unhide(guildId, roomId, userId),
          'panel:unhide',
        );
      case 'claim':
        return replyPanelResult(
          interaction,
          () => deps.voiceCommands.claim(guildId, roomId, userId),
          'panel:claim',
        );
      case 'limit':
        return openPanelModal(interaction, roomId, 'limit');
      case 'rename':
        return openPanelModal(interaction, roomId, 'rename');
      case 'transfer':
        return openPanelPicker(interaction, roomId, 'transferpick');
      case 'kick':
        return openPanelPicker(interaction, roomId, 'kickpick');
      case 'info':
        return panelChannelInfo(interaction, roomId, entitled);
      default: {
        /**
         * A compile error, not a runtime message.
         *
         * Appending to `CONTROL_PANEL_CONTROLS` is documented as the way to add
         * another button, and `buildControlPanel` renders one for every entry
         * in that list. Without this, adding one shipped a button that rendered,
         * was pressable, and answered "that button is from an older version"
         * forever.
         */
        const unreachable: never = action;
        await safeReply(interaction, `That button is not one I know: ${String(unreachable)}.`);
      }
    }
  }

  /**
   * Runs one panel action and answers with exactly what the slash command
   * would have said.
   *
   * The message is passed through verbatim rather than replaced with one shared
   * refusal, because the four ownership refusals are deliberately worded
   * differently ("can make it private", "can do that. Use `/reclaim`…") and the
   * panel is meant to be the same thing as the command, not a paraphrase of it.
   *
   * Deferred first: every one of these makes a Discord REST call on the
   * channel's bucket, which is the bucket a queued rename holds, and the reply
   * must land inside the three-second window.
   */
  async function replyPanelResult(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    task: () => Promise<CommandResult>,
    name: string,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    try {
      const result = await run(guildId, name, task);
      await interaction.editReply({ content: formatResult(result), components: [] });
    } catch (err) {
      /**
       * Caught here rather than in `route` because the interaction is already
       * DEFERRED: `route`'s catch reaches for `safeReply`, which follows up on
       * a deferred interaction and leaves the member looking at a spinner that
       * never resolves above the answer.
       *
       * The wording covers both reasons `run` rejects and claims neither. A
       * tripped circuit breaker or a draining queue is one, and it is exactly
       * the guild where somebody is pressing buttons to work out what is
       * wrong; the task simply failing is the other, and `describeError` is
       * what every command says about that.
       */
      deps.logger.warn({ err, guildId, name }, 'control panel action failed');
      deps.reportError?.('Control panel action failed', { guildId, name, error: String(err) });
      await interaction.editReply({
        content:
          `⚠️ I couldn't do that: ${describeError(err)}. If this keeps happening, AVC may be ` +
          'backing off in this server after repeated errors, which usually clears on its own ' +
          'within a few minutes.',
        components: [],
      });
    }
  }

  /**
   * The Limit and Rename modals.
   *
   * `showModal` IS the acknowledgement, so nothing here may defer, and the
   * pre-fill read has to be UNDISPATCHED: a queued read sits behind every
   * create and rename in flight for this guild and would blow the three-second
   * budget before the modal ever opened. Same reasoning as the alias and lists
   * panels, which say so at their own reads.
   */
  async function openPanelModal(
    interaction: ButtonInteraction,
    roomId: string,
    field: 'limit' | 'rename',
  ): Promise<void> {
    const room = await roomOrExcuse(interaction, roomId);
    if (!room) return;
    await interaction.showModal(
      field === 'limit'
        ? buildLimitModal(roomId, room.userLimit)
        : buildRenameModal(roomId, room.nameOverride),
    );
  }

  /**
   * The room behind a panel button, or `undefined` after answering with why
   * there is none.
   *
   * The two cases are told apart deliberately. A room that is gone is an
   * ordinary thing for a panel to outlive, and saying so is the answer. A read
   * that THREW is a database problem, and telling a member their room is not
   * managed when it plainly is sends them to an admin with the wrong story.
   */
  async function roomOrExcuse(
    interaction: ButtonInteraction,
    roomId: string,
  ): Promise<RoomPanelState | undefined> {
    const guildId = interaction.guildId!;
    try {
      const room = await deps.feature.getRoomPanelState(guildId, roomId);
      if (room) return room;
      await interaction.reply({
        content: "This room isn't being managed by AVC any more.",
        ephemeral: true,
      });
      return undefined;
    } catch (err) {
      deps.logger.info({ err, guildId, roomId }, 'control panel could not read the room');
      await interaction.reply({
        content: "⚠️ I couldn't read that room just now. Try again in a moment.",
        ephemeral: true,
      });
      return undefined;
    }
  }

  /** The Limit and Rename modal submits. */
  async function handleControlPanelModal(
    interaction: ModalSubmitInteraction,
    settings: StoredSettings,
  ): Promise<void> {
    const parsed = parseControlPanelId(interaction.customId);
    if (!parsed || (parsed.action !== 'limitset' && parsed.action !== 'renameset')) {
      /**
       * A modal opened by a newer instance and submitted against an older one
       * mid-deploy. Answering matters more here than on the panels beside it:
       * an unanswered modal submit shows a bare "This interaction failed" over
       * whatever the member just typed, and they have no way to tell that the
       * text was never going to be saved.
       */
      await safeReply(interaction, 'That form is from an older version. Try the command instead.');
      return;
    }
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const raw = interaction.fields.getTextInputValue(CONTROL_PANEL_INPUT_ID).trim();

    if (parsed.action === 'limitset') {
      // Blank is "no limit", which is what `/unlimit` does, so the panel needs
      // no ninth button for it.
      const limit = raw === '' ? 0 : Number(raw);
      // Checked again here, not only at the button: a modal outlives the rule
      // that was added after it opened. A limit of 0 or a blank box removes a
      // limit, which is the undo direction and is never restricted.
      if (!(await allowed(interaction, settings, limitFeatureFor(limit)))) return;
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
        await interaction.reply({
          content: `⚠️ The limit must be a whole number between 0 and ${MAX_USER_LIMIT}.`,
          ephemeral: true,
        });
        return;
      }
      return replyPanelResult(
        interaction,
        () => deps.voiceCommands.setLimit(guildId, parsed.roomId, userId, limit),
        'panel:limit',
      );
    }
    if (parsed.action === 'renameset') {
      if (!(await allowed(interaction, settings, PANEL_ACTION_FEATURE.renameset))) return;
      return replyPanelResult(
        interaction,
        () =>
          deps.voiceCommands.setName(guildId, parsed.roomId, userId, raw === '' ? 'reset' : raw, {
            admin: hasManageChannels(interaction),
          }),
        'panel:rename',
      );
    }
  }

  /**
   * The Transfer and Kick member pickers.
   *
   * A string select built from the room's live occupants rather than Discord's
   * own user select: the router has no user-select branch, and both actions
   * already refuse anyone who is not in the room, so offering the whole server
   * would be offering choices that cannot work.
   */
  async function openPanelPicker(
    interaction: ButtonInteraction,
    roomId: string,
    action: 'transferpick' | 'kickpick',
  ): Promise<void> {
    const userId = interaction.user.id;
    const room = await roomOrExcuse(interaction, roomId);
    if (!room) return;
    // The owner is excluded from a kick because `VoteKickManager` refuses to
    // target them, and offering a name that is always refused is worse than
    // not offering it.
    const candidates = room.members.filter(
      (m) => !m.bot && m.id !== userId && (action === 'transferpick' || m.id !== room.ownerId),
    );
    if (candidates.length === 0) {
      await interaction.reply({
        content:
          action === 'transferpick'
            ? 'There is nobody else in the room to hand it to.'
            : 'There is nobody in the room you can start a vote about.',
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content:
        action === 'transferpick'
          ? 'Who should own this room?'
          : 'Who should the room vote on removing?',
      components: [buildMemberPicker(action, roomId, candidates)],
      ephemeral: true,
    });
  }

  /** A choice from one of those pickers. */
  async function handleControlPanelSelect(
    interaction: StringSelectMenuInteraction,
    settings: StoredSettings,
  ): Promise<void> {
    const parsed = parseControlPanelId(interaction.customId);
    const targetId = interaction.values[0];
    if (!parsed || !targetId) {
      await safeReply(interaction, 'That menu is from an older version. Try the command instead.');
      return;
    }
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    // A picker outlives the rule that was added after it opened, so the choice is
    // checked again here. Kick maps to no feature, so this is Transfer's alone.
    if (!(await allowed(interaction, settings, PANEL_ACTION_FEATURE[parsed.action]))) return;

    if (parsed.action === 'transferpick') {
      return replyPanelResult(
        interaction,
        () => deps.voiceCommands.transfer(guildId, parsed.roomId, userId, targetId),
        'panel:transfer',
      );
    }
    if (parsed.action !== 'kickpick') {
      // Only the two pickers are selects, so this needs a crafted id or a
      // deploy that retired one. Answered rather than dropped either way: a
      // dropped select shows a bare "This interaction failed".
      await safeReply(interaction, 'That menu is from an older version. Try the command instead.');
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    /**
     * Its own dispatch rather than `replyPanelResult`, because a vote is not a
     * `CommandResult`: it has three outcomes, one of which posts a public
     * message. The rejection is caught HERE for the reason that helper catches
     * it - the interaction is already deferred, and `route`'s catch reaches for
     * `safeReply`, which follows up and leaves a spinner that never resolves.
     */
    let result;
    try {
      result = await run(guildId, 'panel:kick', () =>
        deps.votekick.start(guildId, parsed.roomId, userId, targetId),
      );
    } catch (err) {
      deps.logger.warn({ err, guildId, roomId: parsed.roomId }, 'panel votekick failed');
      deps.reportError?.('Control panel action failed', {
        guildId,
        name: 'panel:kick',
        error: String(err),
      });
      await interaction.editReply({
        content: `⚠️ I couldn't start that vote: ${describeError(err)}.`,
        components: [],
      });
      return;
    }
    if (!result.ok) {
      await interaction.editReply({ content: `⚠️ ${result.message}`, components: [] });
      return;
    }
    if (!deps.votekick.hasSession(parsed.roomId)) {
      // Resolved immediately (1v1) - already kicked.
      await interaction.editReply({ content: `✅ ${result.message}`, components: [] });
      await notifyChannel(deps.client, interaction.channelId, `✅ ${result.message}`);
      return;
    }
    armVoteTimeout(parsed.roomId, result.epoch);
    /**
     * The vote itself is PUBLIC, in the channel the panel is in, because the
     * people who have to vote are the ones who can read it. That is the one
     * place the panel cannot be ephemeral, and it matches `/kick`, whose reply
     * is public for the same reason.
     */
    const posted = await postVoteMessage(
      interaction.channelId,
      parsed.roomId,
      userId,
      targetId,
      // `required` is optional on the result type and is always present on a
      // success, so this narrows rather than guesses: a vote needing one more
      // than the initiator is the smallest a real session can be.
      result.required ?? 2,
    );
    await interaction.editReply({
      content: posted
        ? '🗳️ Started. The vote is in this channel for everyone to see.'
        : "⚠️ I started the vote but couldn't post it here, so nobody can vote. " +
          'I need **Send Messages** in this channel.',
      components: [],
    });
  }

  /** Posts the public vote message. Returns false when it could not. */
  async function postVoteMessage(
    channelId: string,
    roomId: string,
    initiatorId: string,
    targetId: string,
    required: number,
  ): Promise<boolean> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${KICK_PREFIX}${roomId}`)
        .setLabel('Vote to kick')
        .setStyle(ButtonStyle.Danger),
    );
    const channel = await deps.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return false;
    return channel
      .send({
        content:
          `🗳️ <@${initiatorId}> started a vote to kick <@${targetId}>.\n` +
          `Need **${required}** votes. (1 so far)`,
        components: [row],
      })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * The Info button.
   *
   * Answers with a NEW ephemeral message rather than reusing an `avc:info:`
   * custom id, which would put the info panel's own in-place edit over the
   * shared control panel.
   *
   * The kill-switch and the caller-visibility check are both applied, and the
   * hard gate exempts this button the way it exempts the command
   * (`allowedWhileExpired`). What is NOT applied is the `ManageChannels` gate
   * on `/channelinfo`'s explicit `channel` option, and deliberately: that gate
   * asks who may look ELSEWHERE, and this asks about the room whose chat the
   * caller is reading. `callerCanSee` is what binds it to what they can
   * already see.
   */
  async function panelChannelInfo(
    interaction: ButtonInteraction,
    roomId: string,
    entitled: boolean,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (await channelInfoDisabled(interaction.guildId!)) {
      await interaction.editReply({ content: CHANNELINFO_OFF });
      return;
    }
    if (!callerCanSee(interaction, roomId)) {
      await interaction.editReply({ content: CANNOT_SEE_CHANNEL });
      return;
    }
    const input = await channelInfoInputOrExcuse(interaction, roomId, entitled);
    if (!input) return;
    const { embeds, components } = buildChannelInfoView('summary', input);
    await interaction.editReply({ embeds: embeds ?? [], components: components ?? [] });
  }

  // -- /controlpanel : configuring what the panel carries --------------------

  /** `/controlpanel` -> the configuration panel for this server. */
  async function openControlSettings(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const config = await deps.settings.getControlPanel(interaction.guildId!);
    await interaction.reply(buildControlSettingsPanel(config));
  }

  /**
   * The configuration panel's buttons: one per control, plus on, off and close.
   *
   * The per-control toggles are checked first, because `avc:cp:t:` shares the
   * namespace with them and {@link parseControlSettingsId} deliberately does
   * not claim it.
   */
  async function handleControlSettingsButton(interaction: ButtonInteraction): Promise<void> {
    const control = parseControlToggleId(interaction.customId);
    if (control) {
      if (!(await requireManageChannels(interaction))) return;
      await interaction.deferUpdate();
      const config = await deps.settings.getControlPanel(interaction.guildId!);
      await refreshControlSettings(interaction, control, !config.controls[control]);
      return;
    }
    /**
     * The three appearance buttons open a modal, so they are answered BEFORE
     * anything is deferred: `showModal` has to be the first response to the
     * interaction, and a `deferUpdate` above it makes the modal unopenable.
     */
    const appearance = parseControlAppearanceId(interaction.customId);
    if (appearance) {
      if (!(await requireManageChannels(interaction))) return;
      const config = await deps.settings.getControlPanel(interaction.guildId!);
      await interaction.showModal(buildAppearanceModal(appearance, config));
      return;
    }
    const action = parseControlSettingsId(interaction.customId);
    if (!action) {
      await safeReply(interaction, 'That button is out of date. Run `/controlpanel` again.');
      return;
    }
    if (!(await requireManageChannels(interaction))) return;
    if (action === 'close') {
      await interaction.update({ content: 'Closed.', embeds: [], components: [] });
      return;
    }
    await interaction.deferUpdate();
    await refreshControlSettings(interaction, CONTROL_PANEL_ENABLED_KEY, action === 'on');
  }

  /**
   * A submitted title, description or colour.
   *
   * A blank submit is the reset, which is why the modal's input is not
   * required. The colour is parsed here rather than in the writer so a typo
   * gets a sentence about hex codes instead of a generic refusal, and the
   * writer validates the parsed number again anyway: it is the only seam that
   * also covers `/import` and any future caller.
   */
  async function handleControlAppearanceModal(interaction: ModalSubmitInteraction): Promise<void> {
    const key = parseControlAppearanceId(interaction.customId);
    if (!key) {
      await safeReply(interaction, 'That panel is out of date. Run `/controlpanel` again.');
      return;
    }
    if (!(await requireManageChannels(interaction))) return;
    const raw = interaction.fields.getTextInputValue(CONTROL_APPEARANCE_INPUT_ID).trim();
    let value: string | number | null = raw === '' ? null : raw;
    if (key === CONTROL_PANEL_COLOR_KEY && raw !== '') {
      const parsed = parsePanelColor(raw);
      if (parsed === null) {
        await safeReply(
          interaction,
          'That is not a colour I can use. Give me a hex code like `#c43bff`, or submit it blank to go back to the default.',
        );
        return;
      }
      value = parsed;
    }
    // Always opened from the configuration panel, so the update branch is the
    // real one. The plain-reply fallback is the same defence every other modal
    // here keeps: a modal with no message behind it cannot be answered with an
    // update, and answering nothing leaves the admin on a dead spinner.
    if (!interaction.isFromMessage()) {
      const guildId = interaction.guildId!;
      const res = await run(guildId, 'cmd:controlpanel', () =>
        deps.settings.setControlPanelAppearance(guildId, key, value),
      );
      await interaction.reply({ content: formatResult(res), ephemeral: true });
      if (res.ok) refreshPanelsSoon(guildId);
      return;
    }
    await interaction.deferUpdate();
    await refreshControlAppearance(interaction, key, value);
  }

  /**
   * Applies one appearance change and re-renders the configuration panel.
   *
   * Its own function rather than a branch inside {@link refreshControlSettings}
   * because that one's whole signature is `(entry, on: boolean)`, and widening
   * it to carry a string or a number would make every existing caller pass a
   * value it has no opinion about.
   *
   * The rejection is caught here for the reason that one documents: the
   * interaction is already deferred, so `route`'s catch would follow up on it
   * and leave a spinner that never resolves.
   */
  async function refreshControlAppearance(
    interaction: ModalSubmitInteraction,
    key: ControlPanelAppearanceKey,
    value: string | number | null,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    try {
      const res = await run(guildId, 'cmd:controlpanel', () =>
        deps.settings.setControlPanelAppearance(guildId, key, value),
      );
      const config = await deps.settings.getControlPanel(guildId);
      await interaction.editReply(
        toUpdate(buildControlSettingsPanel(config, { note: formatResult(res) })),
      );
      // Only on success: a refused value changed nothing, and re-rendering
      // every panel in the guild to prove it is traffic for no reason.
      if (res.ok) refreshPanelsSoon(guildId);
    } catch (err) {
      deps.logger.warn({ err, guildId, entry: key }, 'control panel setting could not be saved');
      deps.reportError?.('Control panel setting failed', {
        guildId,
        entry: key,
        error: String(err),
      });
      await interaction.followUp({
        content: `⚠️ I couldn't save that: ${describeError(err)}.`,
        ephemeral: true,
      });
    }
  }

  /**
   * Applies one change and re-renders the configuration panel in place.
   *
   * The rejection is caught here for the same reason the panel's own actions
   * catch it: `deferUpdate` has already run, so `route`'s catch would follow up
   * on a deferred interaction and leave the admin looking at a panel that never
   * changed and a spinner that never resolves.
   */
  async function refreshControlSettings(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    entry: ControlPanelEntry,
    on: boolean,
  ): Promise<void> {
    const guildId = interaction.guildId!;
    try {
      const res = await run(guildId, 'cmd:controlpanel', () =>
        deps.settings.setControlPanelEntry(guildId, entry, on),
      );
      const config = await deps.settings.getControlPanel(guildId);
      await interaction.editReply(
        toUpdate(buildControlSettingsPanel(config, { note: formatResult(res) })),
      );
      refreshPanelsSoon(guildId);
    } catch (err) {
      deps.logger.warn({ err, guildId, entry }, 'control panel setting could not be saved');
      deps.reportError?.('Control panel setting failed', {
        guildId,
        entry,
        error: String(err),
      });
      await interaction.followUp({
        content: `⚠️ I couldn't save that: ${describeError(err)}.`,
        ephemeral: true,
      });
    }
  }

  /**
   * Brings the panels already posted into line with a `/controlpanel` change,
   * once, however many buttons the admin presses.
   *
   * **Coalesced, because an admin configures several controls in a row.** Each
   * press would otherwise queue a whole-guild sweep onto that guild's SERIAL
   * work queue: seven presses against a thirty-room server is two hundred
   * sequential edits, and the guild's voice events - room creation, cleanup -
   * wait behind all of them. So a sweep already in flight is not joined by a
   * second; it is asked to run once more when it finishes, which is enough
   * because the sweep re-reads the settings and therefore always finishes on
   * the latest answer.
   *
   * Detached from the interaction on purpose: the admin has their reply, and
   * nothing about somebody else's room should hold it open.
   */
  function refreshPanelsSoon(guildId: string): void {
    if (panelRefreshes.has(guildId)) {
      panelRefreshes.set(guildId, 'again');
      return;
    }
    panelRefreshes.set(guildId, 'running');
    void run(guildId, 'controlpanel:refresh', () => deps.feature.refreshGuildPanels(guildId))
      .then((r) => {
        deps.logger.debug({ guildId, ...r }, 'refreshed room panels after a settings change');
      })
      .catch((err: unknown) => {
        deps.logger.warn({ err, guildId }, 'could not refresh room panels');
      })
      .finally(() => {
        const again = panelRefreshes.get(guildId) === 'again';
        panelRefreshes.delete(guildId);
        if (again) refreshPanelsSoon(guildId);
      });
  }

  // -- /botprofile : the bot's own profile in this server ------------------

  type BotProfileInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | ModalSubmitInteraction;

  const PROFILE_UNAVAILABLE =
    "I can't read my profile in this server right now. Try again in a moment.";

  /**
   * The bot's own member, read from Discord rather than from the cache.
   *
   * `editMe` returns a patched CLONE and leaves `guild.members.me` alone, so
   * the cache lags every change until the gateway's member update arrives,
   * and `fetchMe` without `force` answers from that same cache. Null when it
   * cannot be read, which every caller turns into a sentence.
   */
  async function readBotProfile(
    interaction: BotProfileInteraction,
  ): Promise<BotProfileView | null> {
    const guild = interaction.guild;
    if (!guild) return null;
    try {
      return botProfileViewOf(await guild.members.fetchMe({ force: true }));
    } catch (err) {
      deps.logger.warn({ err, guildId: guild.id }, 'could not read the bot profile');
      return null;
    }
  }

  /** Renders the panel into an interaction that has already been deferred. */
  async function showBotProfile(
    interaction: BotProfileInteraction,
    opts: { canChange: boolean; note?: string },
    view?: BotProfileView | null,
  ): Promise<void> {
    const current = view ?? (await readBotProfile(interaction));
    if (!current) {
      await interaction.editReply({
        content: opts.note ? `${opts.note}\n\n${PROFILE_UNAVAILABLE}` : PROFILE_UNAVAILABLE,
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.editReply(toUpdate(buildBotProfilePanel(current, opts)));
  }

  /**
   * `/botprofile` -> the panel.
   *
   * Gated before deferring, because the gate is local and a refusal after a
   * defer would strand the "thinking" state above it. Deferred before reading,
   * because the read is a Discord round trip (see {@link readBotProfile}).
   */
  async function openBotProfile(
    interaction: ChatInputCommandInteraction,
    entitled: boolean,
  ): Promise<void> {
    if (!(await requireManageGuild(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await showBotProfile(interaction, { canChange: entitled });
  }

  /**
   * The panel's buttons: a set and a reset per field.
   *
   * A set button opens a modal, which has to be the FIRST response, so nothing
   * above it defers or waits on Discord. The name's modal is prefilled from the
   * cached member for that reason: it lags a change by the moment the gateway
   * takes to report it, which is harmless in a prefill, where a fresh read
   * could outlast the three-second window.
   */
  async function handleBotProfileButton(
    interaction: ButtonInteraction,
    entitled: boolean,
  ): Promise<void> {
    const parsed = parseBotProfileId(interaction.customId);
    if (!parsed) {
      await safeReply(interaction, 'That button is out of date. Run `/botprofile` again.');
      return;
    }
    if (!(await requireManageGuild(interaction))) return;
    if (parsed.action === 'set') {
      const me = parsed.field === 'name' ? (interaction.guild?.members.me ?? null) : null;
      await interaction.showModal(
        buildBotProfileModal(parsed.field, me ? botProfileViewOf(me) : null),
      );
      return;
    }
    await interaction.deferUpdate();
    await applyBotProfile(interaction, parsed.field, null, entitled);
  }

  /**
   * Profile images being downloaded or uploaded on this instance right now.
   *
   * Each one holds the file and its base64 copy, about 14 MB at the limit and
   * several times that in transient copies, so an instance takes a couple at a
   * time and refuses the rest with a sentence rather than letting a burst of
   * admins find the memory ceiling (`/import` bounds its held work for the
   * same reason).
   */
  let profileUploads = 0;
  const MAX_PROFILE_UPLOADS = 2;

  /**
   * A submitted avatar, banner, name or bio.
   *
   * The fields are read BEFORE deferring, so a submit from an older build whose
   * modal lacks the field answers "out of date" instead of falling to `route`'s
   * generic catch. Then deferred: an image is a download of up to 10 MB and an
   * upload of a third more as base64, and three seconds does not cover that.
   * Always entitled here, because the gate refuses these modals in a gated
   * guild.
   */
  async function handleBotProfileModal(interaction: ModalSubmitInteraction): Promise<void> {
    const parsed = parseBotProfileId(interaction.customId);
    if (!parsed || parsed.action !== 'set') {
      await safeReply(interaction, 'That panel is out of date. Run `/botprofile` again.');
      return;
    }
    if (!(await requireManageGuild(interaction))) return;
    const image = isImageField(parsed.field);
    let file: { url: string; size: number } | undefined;
    let text = '';
    try {
      if (image) file = interaction.fields.getUploadedFiles(BOT_PROFILE_FILE_ID)?.first();
      else text = interaction.fields.getTextInputValue(BOT_PROFILE_TEXT_ID).trim();
    } catch {
      await safeReply(interaction, 'That panel is out of date. Run `/botprofile` again.');
      return;
    }
    if (image && profileUploads >= MAX_PROFILE_UPLOADS) {
      await safeReply(
        interaction,
        'A lot of profile images are being uploaded right now. Try again in a minute.',
      );
      return;
    }
    // Opened from the panel, so the panel is what gets updated. The plain
    // reply is the defence every modal here keeps for one with no message
    // behind it, which cannot be answered with an update.
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!image) {
      if (!text) {
        await showBotProfile(interaction, {
          canChange: true,
          note: '⚠️ That was blank. Use the reset button to go back to the default.',
        });
        return;
      }
      await applyBotProfile(interaction, parsed.field, text, true);
      return;
    }
    if (!file) {
      await showBotProfile(interaction, { canChange: true, note: '⚠️ Attach an image first.' });
      return;
    }
    profileUploads += 1;
    try {
      const loaded = await loadProfileImage(file);
      if (!loaded.ok) {
        await showBotProfile(interaction, { canChange: true, note: `⚠️ ${loaded.message}` });
        return;
      }
      await applyBotProfile(interaction, parsed.field, loaded.dataUri, true);
    } finally {
      profileUploads -= 1;
    }
  }

  const PROFILE_DONE: Record<BotProfileField, { set: string; reset: string }> = {
    avatar: { set: 'Avatar updated.', reset: 'Avatar reset to the default.' },
    banner: { set: 'Banner updated.', reset: 'Banner reset to the default.' },
    name: { set: 'Name updated.', reset: 'Name reset to the default.' },
    bio: { set: 'Bio updated.', reset: 'Bio reset to the default.' },
  };

  /**
   * After every change that worked: Discord clients cache a member's profile,
   * so the admin looking at the panel is often the last to see it change.
   */
  const PROFILE_RELOAD =
    'This may take some time for everyone to see it. Press Ctrl-R to reload now.';

  /**
   * Writes one field (`null` resets it) and re-renders the panel with the
   * outcome, into an interaction that has already been deferred.
   *
   * **Outside the guild's queue, deliberately**, for `/import`'s reason and one
   * of its own. Nothing bounds a REST call under discord.js's automatic 429
   * retry, and a queued one would hold every voice event for the guild behind
   * an admin's upload; this writes no AVC state, so the queue orders nothing.
   * And the queue logs a failed task as `{ err }`, which for a refused
   * `editMe` is the whole request body: the image or the bio, in the logs the
   * privacy policy says hold neither. Queued, admin mistakes like a missing
   * Change Nickname would also count toward that guild's circuit breaker.
   *
   * The failure is caught here rather than left to `route`, whose catch would
   * log it the same way and follow up on a deferred interaction, leaving the
   * panel under a spinner.
   */
  async function applyBotProfile(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    field: BotProfileField,
    value: string | null,
    entitled: boolean,
  ): Promise<void> {
    const guild = interaction.guild;
    const guildId = interaction.guildId!;
    if (!guild) {
      await interaction.editReply({ content: PROFILE_UNAVAILABLE, embeds: [], components: [] });
      return;
    }
    let member: BotProfileMember | null = null;
    let note: string;
    try {
      member = await guild.members.editMe(
        profileEdit(field, value, profileAuditReason(interaction.user)),
      );
      note = formatResult({
        ok: true,
        message: `${PROFILE_DONE[field][value === null ? 'reset' : 'set']} ${PROFILE_RELOAD}`,
      });
    } catch (err) {
      const failure = profileFailure(err, field);
      /**
       * Never `{ err }`. A discord.js API error carries the request body, and
       * pino's error serializer copies every enumerable property, so logging
       * the error object would write the uploaded image (up to 13 MB of base64)
       * or the bio into the logs. The privacy policy says we keep no copy.
       */
      deps.logger.warn({ guildId, field, error: describeError(err) }, 'bot profile change failed');
      if (!failure.expected) {
        deps.reportError?.('Bot profile change failed', {
          guildId,
          field,
          error: describeError(err),
        });
      }
      note = formatResult({ ok: false, message: failure.message });
    }
    await showBotProfile(
      interaction,
      { canChange: entitled, note },
      member ? botProfileViewOf(member) : null,
    );
  }

  async function handleKickVote(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const channelId = interaction.customId.slice(KICK_PREFIX.length);
    // Deferred first: the vote that decides it kicks before it answers (a record
    // write, an overwrite write and a disconnect), which can outlast the 3 seconds
    // a token lives. The message stays as it is until there is something to say.
    await interaction.deferUpdate();
    const res = await run(guildId, 'kick:vote', () =>
      deps.votekick.vote(channelId, interaction.user.id),
    );
    if (!res.ok) {
      await interaction.followUp({ content: res.message, flags: MessageFlags.Ephemeral });
      return;
    }
    if (res.resolved) {
      clearVoteTimeout(channelId);
      await interaction.editReply({ content: `✅ ${res.message}`, components: [] });
      return;
    }
    await interaction.followUp({ content: res.message, flags: MessageFlags.Ephemeral });
  }

  async function handleModal(
    interaction: ModalSubmitInteraction,
    settings: StoredSettings,
  ): Promise<void> {
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
    if (interaction.customId.startsWith(EDITOR_PREFIX))
      return handleEditorModal(interaction, settings);
    if (interaction.customId.startsWith(ASSISTANT_PREFIX)) return handleAssistantModal(interaction);
    if (interaction.customId === GENERAL_MODAL_ID) return handleGeneralSubmit(interaction);
    if (interaction.customId === TIMEZONE_MODAL_ID) return handleTimeZoneSubmit(interaction);
    if (interaction.customId === TEXT_CHANNELS_MODAL_ID)
      return handleTextChannelsSubmit(interaction);
    if (interaction.customId.startsWith(CONTROL_PANEL_PREFIX))
      return handleControlPanelModal(interaction, settings);
    if (interaction.customId.startsWith(CONTROL_SETTINGS_PREFIX))
      return handleControlAppearanceModal(interaction);
    if (interaction.customId.startsWith(BOT_PROFILE_PREFIX))
      return handleBotProfileModal(interaction);
    if (interaction.customId.startsWith(LISTS_PREFIX)) return handleListSaveSubmit(interaction);
    // `avc:alias` is the pre-panel id of the Add modal, still accepted so a
    // modal opened on an old instance mid-deploy can submit against a new one.
    // It covers only that direction: a panel opened on a NEW instance whose
    // guild then lands on an old one has buttons that old build cannot route,
    // and the admin has to re-run `/alias`. That is deliberate, since the fix
    // would be shipping the routing ahead of the feature in an earlier release.
    // Retire this compatibility route only after old instances and modals expire.
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

  /** The `/setup` room text channel settings modal submit (name + moderator role). */
  async function handleTextChannelsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await requireManageChannels(interaction))) return;
    const guildId = interaction.guildId!;
    const { name, roleId } = parseTextChannelsModal(interaction.fields);
    // Both writes, then one note. Two separate notes would be two panel
    // refreshes for one submit.
    const res = await run(guildId, 'setup:textchannels', async () => {
      const nameResult = await deps.settings.setTextChannelName(guildId, name);
      if (!nameResult.ok) return nameResult;
      return deps.settings.setTextChannelRole(guildId, roleId);
    });
    // Same shape as `handleTimeZoneSubmit`: opened from the panel today, with
    // the plain-reply branch as the defence for a modal with no message behind it.
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
      await refreshSetupPanel(interaction, { note: formatResult(res) });
      return;
    }
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
    panelRefreshes.clear();
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

/**
 * An ephemeral `/restrict` reply that pings nobody.
 *
 * Not `replyResult`: that one has no `allowedMentions`, and these replies are
 * made of mentions of the very people an admin is restricting.
 */
async function replyRestrict(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

/**
 * An ephemeral `/access` reply that pings nobody, edited over the deferral the router
 * made. Not `replyResult`: that one has no `allowedMentions`, and these replies are made
 * of mentions of the people on a list.
 */
async function replyAccess(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

/**
 * Who a `/access` subcommand was pointed at: the user option, with Discord's own answers
 * about the account (a bot) and about membership (Discord resolves a member only for
 * somebody who is in this server, so a user picked by id alone has none). `null` when
 * the option carries no user, which only a hand-built request sends.
 *
 * Also what Discord's answer says about the two members a block cannot stop: the
 * resolved member's permissions (a `GuildMember` when the guild is cached, the raw API
 * member when not) and the guild's owner id, which needs no member cache. Neither is
 * a reason to refuse here, only facts for the service to refuse on.
 */
function pickedMember(interaction: ChatInputCommandInteraction): AccessTarget | null {
  const option = interaction.options.get('member');
  if (!option?.user) return null;
  const member = option.member;
  return {
    id: option.user.id,
    bot: option.user.bot === true,
    inServer: member != null,
    ...(member && 'permissions' in member && carriesAdministrator(member.permissions)
      ? { administrator: true }
      : {}),
    ...(interaction.guild?.ownerId === option.user.id ? { guildOwner: true } : {}),
  };
}

/**
 * Who `/restrict` was pointed at, resolved to a user or a role.
 *
 * The mentionable picker hands back either, and the option's own `user`, `member`
 * and `role` say which, so a role id is never mistaken for a user id (the two
 * share one id space and one picker). `permissions` is whatever Discord or the
 * cache can say about what they hold: a role carries its own, and a member is the
 * resolved one, which is a `GuildMember` when the guild is cached and the raw API
 * shape when it is not. Absent when neither is known, which reads as "cannot tell"
 * and is allowed through, since a rule on a manager is harmless (`mayUse` skips
 * them) and refusing on a guess would not be.
 */
function pickedWho(
  interaction: ChatInputCommandInteraction,
): { target: RestrictTarget; isBot: boolean; permissions: unknown } | null {
  const option = interaction.options.get('who', true);
  if (option.role) {
    return {
      target: { kind: 'role', id: option.role.id },
      isBot: false,
      permissions: option.role.permissions,
    };
  }
  if (option.user) {
    const member = option.member ?? interaction.guild?.members.cache.get(option.user.id);
    return {
      target: { kind: 'user', id: option.user.id },
      isBot: option.user.bot === true,
      permissions: member && 'permissions' in member ? member.permissions : undefined,
    };
  }
  return null;
}

/**
 * Whether a resolved permission set holds Manage Channels or Administrator, the
 * two things a restriction cannot stop.
 *
 * Takes a `PermissionsBitField`, or the decimal string the raw API sends, and
 * checks Administrator explicitly rather than trusting `has` to imply it, so a
 * wrapper that does not behaves the same as one that does.
 */
function carriesManageChannels(permissions: unknown): boolean {
  if (permissions === undefined || permissions === null) return false;
  const bits =
    typeof permissions === 'object' && 'has' in permissions
      ? (permissions as { has: (permission: bigint) => boolean })
      : new PermissionsBitField(permissions as never);
  return (
    bits.has(PermissionFlagsBits.ManageChannels) || bits.has(PermissionFlagsBits.Administrator)
  );
}

/**
 * Whether a resolved permission set holds Administrator, which no channel overwrite can
 * stop. Takes the same two shapes as {@link carriesManageChannels}.
 */
function carriesAdministrator(permissions: unknown): boolean {
  if (permissions === undefined || permissions === null) return false;
  const bits =
    typeof permissions === 'object' && 'has' in permissions
      ? (permissions as { has: (permission: bigint) => boolean })
      : new PermissionsBitField(permissions as never);
  return bits.has(PermissionFlagsBits.Administrator);
}

/**
 * The feature a slash command is guarded as, or null when no rule can stop it.
 *
 * Size and Nickname are decided by their value, because each has a direction that
 * undoes it: `/limit 0` and `/nick reset` are never restricted, so a rule cannot
 * leave a member holding something they have no way to remove.
 */
function guardedFeatureOf(interaction: ChatInputCommandInteraction): CommandFeature | null {
  switch (interaction.commandName) {
    case 'limit':
      return limitFeatureFor(interaction.options.getInteger('count'));
    case 'nick':
      return nickFeatureFor(interaction.options.getString('name'));
    case 'access':
      // Three of its six subcommands: the ones that put somebody on a list or let them in.
      return accessFeatureFor(interaction.options.getSubcommand(false));
    default:
      return featureForCommand(interaction.commandName);
  }
}

/**
 * The caller's role ids, without `@everyone`, from either member shape.
 *
 * `interaction.member` is a `GuildMember` when the guild is cached, whose roles
 * are in `roles.cache` and include the guild id (that is `@everyone`), and the
 * raw API member otherwise, whose `roles` is a plain id list without it. Both
 * happen in production, and a null member (no guild context) has no roles. The
 * guild id is dropped either way: a rule can never name it, so leaving it in
 * would only ever matter if a stored one slipped past the writer.
 */
function callerRoleIds(interaction: Interaction): string[] {
  const member = interaction.member;
  if (!member) return [];
  const roles = member.roles;
  const ids = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  return ids.filter((id) => id !== interaction.guildId);
}

/**
 * Whether the caller holds Manage Channels or Administrator, which no rule can
 * stop. From the interaction's own resolved permissions, so it needs no member
 * fetch and no cache.
 */
function callerCanManage(interaction: Interaction): boolean {
  return carriesManageChannels(interaction.memberPermissions);
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
  'hide',
  'unhide',
  'access',
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
