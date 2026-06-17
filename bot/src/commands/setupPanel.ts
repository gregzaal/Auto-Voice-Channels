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
import { tierFor, type AuthStatus } from '@avc/core';

/** Custom-id namespace for the `/setup` panel components. */
export const SETUP_PREFIX = 'avc:setup:';
export const setupId = (action: string): string => `${SETUP_PREFIX}${action}`;

/** Outbound links surfaced from `/setup`. */
export const SIGNUP_URL = 'https://avc.dotsbots.com/signup';
export const DOCS_URL = 'https://wiki.dotsbots.com';
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

const DAY_MS = 86_400_000;
function daysUntil(now: Date, then: Date): number {
  return Math.ceil((then.getTime() - now.getTime()) / DAY_MS);
}

export interface PlanInput {
  memberCount: number;
  status: AuthStatus;
  expiresAt: Date | null;
  selfHosted: boolean;
  now: Date;
}

/**
 * A one-line, friendly summary of where this server sits in the pricing model
 * (see `plans/monetization.md`). **Display only** — it never gates anything; the
 * `isEntitled` machinery remains the source of truth for access.
 */
export function formatPlan(opts: PlanInput): string {
  const { memberCount, status, expiresAt, selfHosted, now } = opts;
  if (selfHosted) return '🏠 **Self-hosted** — every feature unlocked, no subscription needed.';

  const tier = tierFor(memberCount);
  const priceLabel =
    tier.pricePerYear === 0
      ? 'free'
      : tier.pricePerYear === null
        ? 'contact us'
        : `$${tier.pricePerYear}/yr`;

  if (tier.id === 'free') {
    return '🆓 **Free forever** — under 100 members, so AVC is free on this server. Enjoy!';
  }
  if (status === 'active') {
    return `✅ **Subscribed** · ${tier.label} tier (${priceLabel}). Thanks for supporting AVC!`;
  }
  if (status === 'expired') {
    return `⏳ Your AVC trial/subscription has **ended** — reactivate at ${SIGNUP_URL} to switch automation back on.`;
  }
  if (tier.id === 'xxl') {
    return (
      '🏛️ This server is **very large** — we run servers this size on dedicated ' +
      `infrastructure. Let's set you up: ${SIGNUP_URL}`
    );
  }

  // Trial — the common 100 – 1M case.
  const days = expiresAt ? daysUntil(now, expiresAt) : null;
  if (days !== null && days > 0) {
    return (
      `🎟️ **Free trial** — ${days} day${days === 1 ? '' : 's'} left, then the ${tier.label} ` +
      `tier (${priceLabel}). Manage anytime at ${SIGNUP_URL}.`
    );
  }
  if (days !== null) {
    return `🎟️ Your free trial has lapsed — keep AVC on the ${tier.label} tier (${priceLabel}) at ${SIGNUP_URL}.`;
  }
  return `🎟️ **Free trial active** — the ${tier.label} tier (${priceLabel}) when it ends. Manage at ${SIGNUP_URL}.`;
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
}

const INTRO =
  '**The original auto–voice-channel bot** — open-source & self-hostable.\n' +
  'Members join a **creator channel** and AVC spins up a personal voice channel for ' +
  'them — auto-named, and cleaned up when empty.';

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
      : `⚠️ Missing **${input.missingPermissions.join('**, **')}** — re-invite me with the correct ` +
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
        value: channelList(input.primaries, '_None yet — use “➕ New creator channel”._'),
      },
      {
        name: `Managed channels (${input.managed.length})`,
        value: channelList(input.managed, '_None — “🛠️ Manage a channel” adopts an existing one._'),
      },
    )
    .toJSON();

  const components = input.isAdmin ? adminRows(input.enabled) : memberRows();
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

function adminRows(enabled: boolean): ReturnType<typeof rowOf>[] {
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
  );
  const row2 = rowOf(
    new ButtonBuilder()
      .setCustomId(setupId('logging'))
      .setLabel('Set up logging')
      .setEmoji('🪵')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(setupId('general'))
      .setLabel('“No game” label')
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

/** Custom id for the `/setup` "no game" label modal. */
export const GENERAL_MODAL_ID = 'avc:setup:label:set';

/**
 * The modal behind the "no game" label button: the word shown by `@@game_name@@`
 * when no game is detected (prefilled with the current value).
 */
export function buildGeneralModal(current?: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId('label')
    .setLabel('“No game” label')
    .setPlaceholder('General')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  if (current) input.setValue(current.slice(0, 80));
  return new ModalBuilder()
    .setCustomId(GENERAL_MODAL_ID)
    .setTitle('Set the “no game” label')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}
