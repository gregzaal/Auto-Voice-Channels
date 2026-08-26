import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
} from 'discord.js';
import { TIER_IDS, tierById, tierFor, type AuthStatus, type TierId } from '@avc/core';
import { SITE_URL, subscribeUrl } from '../features/billing/messages.js';
import {
  permissionProblemSummary,
  type ProblemLike,
} from '../features/voice/permissionProblems.js';

/** Custom-id namespace for the `/setup` panel components. */
export const SETUP_PREFIX = 'avc:setup:';
export const setupId = (action: string): string => `${SETUP_PREFIX}${action}`;

/** Outbound links surfaced from `/setup`. */
/**
 * @deprecated `https://auto-voice.io/signup` does not exist and returns 404.
 * Every payment prompt must use `subscribeUrl(guildId)` from
 * `features/billing/messages.ts`, which deep-links to the guild's own dashboard
 * card. Kept only so an external import fails loudly rather than silently.
 */
export const SIGNUP_URL = 'https://auto-voice.io/signup';
export const DOCS_URL = 'https://auto-voice.io/docs';
export const SUPPORT_URL = 'https://discord.gg/jVm4tjrczE';

/**
 * The bot permissions AVC needs to function. Surfaced as a quick health-check in
 * `/setup` (guild-level base perms; a channel override could still block one,
 * but a missing base permission is the common, fixable setup mistake).
 */
const REQUIRED_PERMISSIONS: { flag: bigint; label: string }[] = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'View Channels' },
  { flag: PermissionFlagsBits.Connect, label: 'Connect' },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Manage Channels' },
  { flag: PermissionFlagsBits.MoveMembers, label: 'Move Members' },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Manage Roles' },
];

/** The human labels of all required permissions (used when the bot member is unknown). */
export const ALL_REQUIRED_PERMISSION_LABELS = REQUIRED_PERMISSIONS.map((p) => p.label);

/** Which required permissions are missing, given a `has(flag)` predicate. */
export function missingBotPermissions(has: (flag: bigint) => boolean): string[] {
  return REQUIRED_PERMISSIONS.filter((p) => !has(p.flag)).map((p) => p.label);
}

/**
 * What AVC needs to manage one channel's *name*: see it, and edit it.
 *
 * Deliberately narrower than {@link REQUIRED_PERMISSIONS} — renaming a standalone
 * adopted channel needs neither Move Members nor Manage Roles, and demanding the
 * full set here would refuse setups that work perfectly well.
 */
const RENAME_PERMISSIONS: { flag: bigint; label: string }[] = [
  { flag: PermissionFlagsBits.ViewChannel, label: 'View Channel' },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Manage Channels' },
];

/** Which name-management permissions are missing, given a `has(flag)` predicate. */
export function missingRenamePermissions(has: (flag: bigint) => boolean): string[] {
  return RENAME_PERMISSIONS.filter((p) => !has(p.flag)).map((p) => p.label);
}

const DAY_MS = 86_400_000;
function daysUntil(now: Date, then: Date): number {
  return Math.ceil((then.getTime() - now.getTime()) / DAY_MS);
}

export interface PlanInput {
  /** Needed so payment prompts deep-link to THIS server's dashboard card. */
  guildId: string;
  memberCount: number;
  status: AuthStatus;
  expiresAt: Date | null;
  /** End of the grace window, so the grace line can name the days left. */
  graceUntil?: Date | null;
  selfHosted: boolean;
  now: Date;
  /**
   * `guilds.tier`: what the subscription covering this server actually pays
   * for, whichever axis it bills on.
   *
   * **Unconditional, not only for a shared subscription.** Deriving the price
   * from this one server's live member count misreported every subscriber who
   * had grown since paying: a guild that went from 900 to 1,500 members on an S
   * subscription was told "Subscribed, M tier ($59/yr)" while paying $19, right
   * as it entered over-limit grace. Billed tier and required tier are separate
   * values everywhere else for exactly this reason (§5.1) and this surface has
   * to keep them separate too.
   */
  billedTier?: TierId | null;
  /**
   * Whether the subscription covering this server also covers others, so the
   * copy can say so and can avoid quoting a per-server price for something
   * billed on a sum this surface cannot see.
   */
  shared?: boolean;
}

function priceOf(tier: { pricePerYear: number | null }): string {
  if (tier.pricePerYear === 0) return 'free';
  if (tier.pricePerYear === null) return 'contact us';
  return `$${tier.pricePerYear}/yr`;
}

/**
 * A one-line, friendly summary of where this server sits in the pricing model
 * (see `plans/monetization.md`). **Display only** — it never gates anything; the
 * `isEntitled` machinery remains the source of truth for access.
 */
export function formatPlan(opts: PlanInput): string {
  const { guildId, memberCount, status, expiresAt, graceUntil, selfHosted, now } = opts;
  const link = subscribeUrl(guildId);
  if (selfHosted) return '🏠 **Self-hosted**, every feature unlocked, no subscription needed.';

  const shared = opts.shared === true;
  const billed = opts.billedTier ? tierById(opts.billedTier) : null;
  /** What this server's own size would require, ignoring any subscription. */
  const own = tierFor(memberCount);

  /**
   * Order matters, and it is status-first for a reason.
   *
   * This previously checked the free tier before any status, and had no branch
   * at all for `grace` or `blocked`, so both fell through to the trial wording
   * below. A subscriber whose payment lapsed was told "your free trial has
   * lapsed" (they never had one), and a blocked server under 100 members was
   * told "Free forever, enjoy!". The dashboard's `planView` has always ordered
   * these correctly; this is the surface that drifted.
   */
  if (status === 'blocked') {
    return '🚫 AVC is **blocked** on this server. Contact support if you think that is a mistake.';
  }

  /**
   * A free-sized server on a shared subscription, checked before any status.
   *
   * Under 100 members contributes nothing to that subscription's sum (§5.5)
   * and stays entitled whatever happens to it (§5.3), so the subscription's
   * tier is never this server's price. Before this branch, a 40-member server
   * inside an L subscription read "Subscribed through a server pool, L tier
   * ($399/yr)": `guilds.tier` is stamped at add time while the reconciler
   * deliberately leaves free guilds out of the fan-out, so its status stayed
   * `trial` and fell straight through to the shared line.
   *
   * Deliberately NOT generalised to the unshared case, where status-first
   * ordering is still right: an `expired` or `blocked` server has automation
   * actually stopped, and "free forever, enjoy" would be a cheerful lie about
   * a bot that is not running.
   */
  if (shared && own.id === 'free') {
    return '🆓 **Free forever**, under 100 members, so AVC is free on this server and it does not count toward your subscription.';
  }

  if (status === 'active') {
    if (shared) {
      const tierLine = billed ? `${billed.label} tier (${priceOf(billed)})` : 'your plan';
      return (
        `✅ **Subscribed** · ${tierLine}, covering this server along with the others on the ` +
        `same subscription. Manage it from the dashboard at ${link}`
      );
    }
    const tier = billed ?? own;
    return `✅ **Subscribed** · ${tier.label} tier (${priceOf(tier)}). Thanks for supporting AVC!`;
  }
  if (status === 'grace') {
    const graceDays = graceUntil ? daysUntil(now, graceUntil) : null;
    const left =
      graceDays !== null && graceDays > 0
        ? `**Grace period**, ${graceDays} day${graceDays === 1 ? '' : 's'} left.`
        : '**Grace period.**';
    if (shared) {
      /**
       * No tier and no price here on purpose. A shared subscription is billed
       * on a sum this surface cannot see, and the reason for the grace window
       * (a failed payment, or the sum outgrowing the plan) decides which
       * number is the relevant one. The dashboard knows both.
       */
      return (
        `🕊️ ${left} This server is covered by a subscription that also covers your other ` +
        `servers. Sort it out from the dashboard at ${link}`
      );
    }
    /**
     * The HIGHER of billed and required, because grace has two causes and they
     * want opposite numbers: a lapsed payment needs the tier they already pay
     * for, an outgrown plan needs the one they now need. Quoting the lower of
     * the two would tell someone over their limit to buy what they already have.
     */
    const tier = billed && TIER_IDS.indexOf(billed.id) > TIER_IDS.indexOf(own.id) ? billed : own;
    return `🕊️ ${left} Everything still works. Keep AVC on the ${tier.label} tier (${priceOf(tier)}) at ${link}`;
  }
  if (status === 'expired') {
    return shared
      ? `⏳ The subscription covering this server has **ended**, so automation has stopped. Whoever manages it can switch it back on from the dashboard at ${link}`
      : `⏳ Your AVC trial or subscription has **ended**. Reactivate at ${link} to switch automation back on.`;
  }

  const tier = own;
  const priceLabel = priceOf(tier);
  // Only reachable on `trial` now, which is what "free forever" actually means
  // for a server billed on its own: too small to ever be billed.
  if (tier.id === 'free') {
    return '🆓 **Free forever**, under 100 members, so AVC is free on this server. Enjoy!';
  }

  /**
   * Still `trial` while a subscription already covers it. Reachable in the gap
   * between the webhook writing `pool_id` and the next hourly pass fanning
   * entitlement out (§6.4 keeps the webhook from fanning out deliberately), so
   * it is a real state a customer can open `/setup` in, and quoting a
   * per-server trial price to someone who has just paid is the last thing it
   * should say.
   */
  if (shared) {
    return (
      '✅ This server is covered by a subscription that also covers your other servers. ' +
      `Manage it from the dashboard at ${link}`
    );
  }

  if (tier.id === 'xxl') {
    return (
      '🏛️ This server is **very large**, and we run servers this size on dedicated ' +
      `infrastructure. Let's set you up: ${SITE_URL}`
    );
  }

  // Trial: the common 100 to 1M case.
  const days = expiresAt ? daysUntil(now, expiresAt) : null;
  if (days !== null && days > 0) {
    return (
      `🎟️ **Free trial**, ${days} day${days === 1 ? '' : 's'} left, then the ${tier.label} ` +
      `tier (${priceLabel}). Manage anytime at ${link}`
    );
  }
  if (days !== null) {
    return `🎟️ Your free trial has lapsed. Keep AVC on the ${tier.label} tier (${priceLabel}) at ${link}`;
  }
  return `🎟️ **Free trial active**, the ${tier.label} tier (${priceLabel}) when it ends. Manage at ${link}`;
}

export interface SetupPanelInput {
  enabled: boolean;
  /** Whether the viewer has Manage Channels (admin actions are shown only to them). */
  isAdmin: boolean;
  /** Pre-formatted plan line (see {@link formatPlan}). */
  plan: string;
  /** Missing required bot permissions (empty → all good). */
  missingPermissions: string[];
  primaries: { channelId: string }[];
  managed: { channelId: string }[];
  /**
   * Channels with a recent permission incident, and what was being attempted.
   *
   * The operation is load-bearing: "I could not create a room here" and "I have
   * lost access to this channel" are both Discord `50013` and have completely
   * different fixes. Reporting them with one message sends an admin chasing
   * permissions the bot already holds.
   */
  problems?: ProblemLike[];
  /**
   * Whether `/templateassistant` is available on this instance. Off is the
   * self-host default (no model endpoint configured), and the button is hidden
   * rather than shown-and-broken.
   */
  assistant?: boolean;
}

const INTRO =
  '**Open-source and self-hostable.**\n' +
  'Members join a **creator channel** and AVC spins up a personal voice channel for ' +
  'them, auto-named, and cleaned up when empty.';

function channelList(ids: { channelId: string }[], empty: string): string {
  if (ids.length === 0) return empty;
  const shown = ids.slice(0, 10).map((c) => `• <#${c.channelId}>`);
  if (ids.length > 10) shown.push(`…and ${ids.length - 10} more`);
  return shown.join('\n');
}

/** Renders the `/setup` panel — info, plan/permissions status, and first-step buttons. */
export function buildSetupPanel(input: SetupPanelInput): InteractionReplyOptions {
  const permsValue =
    input.missingPermissions.length === 0
      ? '✅ Permissions look good.'
      : `⚠️ Missing **${input.missingPermissions.join('**, **')}** . Re-invite me with the correct ` +
        'permissions, or grant them on my role.';

  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('Auto-Voice-Channels · Setup')
    .setColor(input.enabled ? 0x4caf50 : 0x9e9e9e)
    .setDescription(INTRO)
    .addFields(
      { name: 'Your plan', value: input.plan },
      { name: 'Permissions', value: permsValue },
      {
        name: 'Automation',
        value: input.enabled ? '🟢 Enabled' : '⚪ Disabled',
        inline: true,
      },
      {
        name: `Creator channels (${input.primaries.length})`,
        value: channelList(input.primaries, '_None yet, use the "New creator channel" button._'),
      },
      {
        name: `Managed channels (${input.managed.length})`,
        value: channelList(
          input.managed,
          '_None. The "Manage a channel" button adopts an existing one._',
        ),
      },
    )
    .toJSON();

  // Surface recent permission incidents with the fix that actually matches
  // what failed, so admins aren't left guessing why automation stalled.
  //
  // Rendered by the shared summariser, which the push notice also uses: an
  // admin who got the notice and then opens this panel must read the same
  // advice, or one of the two is teaching them the wrong fix.
  if (input.problems && input.problems.length > 0) {
    embed.fields!.push({
      name: `⚠️ Needs attention (${input.problems.length})`,
      value: permissionProblemSummary(input.problems).join('\n\n'),
    });
  }

  const components = input.isAdmin
    ? adminRows(input.enabled, input.assistant === true)
    : memberRows();
  return { embeds: [embed], components, ephemeral: true };
}

function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label);
  if (emoji) b.setEmoji(emoji);
  return b;
}

// A disabled placeholder until i18n lands.
// TODO(i18n): enable this button and wire a language picker once i18n is implemented.
function languageButton(): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(setupId('lang'))
    .setLabel('Language (soon)')
    .setEmoji('🌐')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
}

function adminRows(enabled: boolean, assistant: boolean): ReturnType<typeof rowOf>[] {
  const row1 = rowOf(
    new ButtonBuilder()
      .setCustomId(setupId('toggle'))
      .setLabel(enabled ? 'Disable' : 'Enable')
      .setStyle(enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(setupId('create'))
      .setLabel('New creator channel')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(setupId('manage'))
      .setLabel('Manage a channel')
      .setEmoji('🛠️')
      .setStyle(ButtonStyle.Primary),
    ...(assistant
      ? [
          new ButtonBuilder()
            .setCustomId(setupId('assistant'))
            .setLabel('Name it for me')
            .setEmoji('✨')
            .setStyle(ButtonStyle.Primary),
        ]
      : []),
  );
  const row2 = rowOf(
    new ButtonBuilder()
      .setCustomId(setupId('logging'))
      .setLabel('Set up logging')
      .setEmoji('🪵')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(setupId('general'))
      .setLabel('"No game" label')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Primary),
    languageButton(),
  );
  const row3 = rowOf(
    linkButton('Learn more', DOCS_URL, '📖'),
    linkButton('Community support', SUPPORT_URL, '💬'),
  );
  return [row1, row2, row3];
}

function memberRows(): ReturnType<typeof rowOf>[] {
  return [
    rowOf(
      linkButton('Learn more', DOCS_URL, '📖'),
      linkButton('Community support', SUPPORT_URL, '💬'),
      languageButton(),
    ),
  ];
}

function rowOf(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/**
 * A voice-channel select menu used by the "command → pick a channel → execute"
 * house style: when a channel-targeting action is invoked and the caller isn't
 * already in a voice channel, we offer this picker instead of dead-ending. The
 * chosen action is encoded in the custom id (`avc:setup:pick:<command>`).
 */
export function channelPickerRow(command: string): ActionRowBuilder<ChannelSelectMenuBuilder> {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(setupId(`pick:${command}`))
    .setChannelTypes(ChannelType.GuildVoice)
    .setPlaceholder('Choose a voice channel')
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu);
}

export function buildChannelPickerMessage(
  command: string,
  prompt: string,
): InteractionUpdateOptions {
  return { content: prompt, embeds: [], components: [channelPickerRow(command)] };
}

/** Parses the command out of a `avc:setup:pick:<command>` channel-select id. */
export function parseSetupPick(customId: string): string | null {
  if (!customId.startsWith(SETUP_PREFIX)) return null;
  const [, , kind, command] = customId.split(':');
  return kind === 'pick' && command ? command : null;
}

/**
 * The extra segment a picker may carry, as in `pick:defaultlimit:5`.
 *
 * A select-menu interaction has no access to the options of the slash command
 * that opened it, so a command with a required option would otherwise lose it
 * the moment the user was shown a channel picker. Carrying it in the custom id
 * is the only place it survives the round trip.
 */
export function parseSetupPickArg(customId: string): string | null {
  if (!customId.startsWith(SETUP_PREFIX)) return null;
  const parts = customId.split(':');
  return parts[2] === 'pick' && parts[4] ? parts[4] : null;
}

/** Custom id for the `/setup` "no game" label modal. */
export const GENERAL_MODAL_ID = 'avc:setup:label:set';

/**
 * The modal behind the "no game" label button: the word shown by `@@game_name@@`
 * when no game is detected (prefilled with the current value).
 */
export function buildGeneralModal(current?: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId('label')
    .setLabel('"No game" label')
    .setPlaceholder('General')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  if (current) input.setValue(current.slice(0, 80));
  return new ModalBuilder()
    .setCustomId(GENERAL_MODAL_ID)
    .setTitle('Set the "no game" label')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}
