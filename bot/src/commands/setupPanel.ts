import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type APIEmbedField,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
} from 'discord.js';
import {
  priceSentence,
  tierById,
  tierFor,
  tierLabel,
  tierRank,
  type AuthStatus,
  type Tier,
  type TierId,
} from '@avc/core';
import { SITE_URL, SUPPORT_URL, subscribeUrl } from '../features/billing/messages.js';
import {
  permissionProblemSummary,
  type ProblemLike,
} from '../features/voice/permissionProblems.js';
import type { GameNameMode } from '../features/voice/nameTemplate.js';

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
/**
 * The privacy policy, surfaced as a link button on every `/setup` panel and
 * from `/source`.
 *
 * Discord's Developer Terms section 5(a) requires the policy to be "easily
 * accessible to users from your Application", which the website footer alone
 * does not satisfy: nothing in the bot linked it. Both surfaces are deliberate.
 * `/setup` is where an admin already is, and the link row renders for members
 * too, so the one person whose presence data the game tokens read can reach it
 * without being an admin.
 */
export const PRIVACY_URL = 'https://auto-voice.io/privacy';
/**
 * The support server invite lives in `features/billing/messages.ts`, which this
 * module already imports from, because the billing notices need it too and the
 * import can only run one way. Its comment there carries the history: an
 * expired invite cannot be recreated, and the last one was dead in three
 * places at once.
 */

/**
 * The public source repo, for `/source` (AGPL-3.0 §13's network-use clause).
 * Matches `GITHUB_URL` in `web/src/lib/env.ts` exactly -- the bot cannot import
 * from `web/`, so this is a second literal by necessity, not a second source of
 * truth. Check both if it ever changes.
 */
export const GITHUB_URL = 'https://github.com/GregZaal/Auto-Voice-Channels';

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
   * values everywhere else for exactly this reason and this surface has
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

/**
 * The panel's price line, from core's one formatter.
 *
 * "contact us" rather than core's "custom pricing" for the quoted tier: the
 * panel's sentence reads "your plan would be contact us" otherwise.
 */
function priceOf(tier: Tier): string {
  if (tier.pricePerYear === null) return 'contact us';
  return priceSentence(tier);
}

/**
 * A one-line, friendly summary of where this server sits in the pricing model.
 * **Display only** — it never gates anything; the
 * `isEntitled` machinery remains the source of truth for access.
 */
export function formatPlan(opts: PlanInput): string {
  const { guildId, memberCount, status, expiresAt, graceUntil, selfHosted, now } = opts;
  const link = subscribeUrl(guildId);
  if (selfHosted) return '🏠 **Self-hosted**, every feature unlocked, no subscription needed.';

  const shared = opts.shared === true;
  const billed = opts.billedTier ? tierById(opts.billedTier) : null;
  /** The billed tier's NAME, honest about an id this build no longer prices. */
  const billedName = opts.billedTier ? tierLabel(opts.billedTier) : null;
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
   * Under 100 members contributes nothing to that subscription's sum
   * and stays entitled whatever happens to it, so the subscription's
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
      const tierLine =
        billedName && billed ? `${billedName} tier (${priceOf(billed)})` : 'your plan';
      return (
        `✅ **Subscribed** · ${tierLine}, covering this server along with the others on the ` +
        `same subscription. Manage it from the dashboard at ${link}`
      );
    }
    const tier = billed ?? own;
    const name = billed && billedName ? billedName : own.label;
    return `✅ **Subscribed** · ${name} tier (${priceOf(tier)}). Thanks for supporting AVC!`;
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
    const useBilled = billed !== null && tierRank(billed.id) > tierRank(own.id);
    const tier = useBilled ? billed! : own;
    const name = useBilled ? (billedName ?? billed!.label) : own.label;
    return `🕊️ ${left} Everything still works. Keep AVC on the ${name} tier (${priceOf(tier)}) at ${link}`;
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
   * entitlement out, so
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

  /**
   * The hard-gated top tier, keyed on "has no self-serve price" rather than on
   * an id.
   *
   * This was `tier.id === 'xxl'`, which the rarity ladder turned into dead
   * code: a server above the gate fell through to the trial copy and was
   * quoted a price that does not exist. `pricePerYear === null` is the
   * definitional property of a quoted tier and cannot go stale that way.
   *
   * Do not promise dedicated infrastructure: capacity for a server this size
   * needs individual verification before an offer can be made.
   */
  if (tier.pricePerYear === null) {
    return (
      '🏛️ This server is **larger than our self-serve plans cover**. Here is how to get in ' +
      `touch so we can work out the right arrangement: ${SITE_URL}/pricing#xxl`
    );
  }

  // Trial: the common 100 to 300k case.
  const days = expiresAt ? daysUntil(now, expiresAt) : null;
  if (days !== null && days > 0) {
    /**
     * Says that deciding early costs nothing,
     * the same fact the trial warnings now carry. "Manage anytime" was true and
     * useless: the panel's own reader is the admin weighing whether to subscribe
     * before the trial runs out, and the answer they need is that they do not
     * have to wait for it to.
     */
    return (
      `🎟️ **Free trial**, ${days} day${days === 1 ? '' : 's'} left, then the ${tier.label} ` +
      `tier (${priceLabel}). Subscribe now and the first charge waits until the trial ` +
      `ends: ${link}`
    );
  }
  if (days !== null) {
    return `🎟️ Your free trial has lapsed. Keep AVC on the ${tier.label} tier (${priceLabel}) at ${link}`;
  }
  return `🎟️ **Free trial active**, the ${tier.label} tier (${priceLabel}) when it ends. Manage at ${link}`;
}

/**
 * How the hosted billing state affects the panel, reduced to the three cases it
 * renders differently. `ok` covers every entitled status a customer never has to
 * act on; self-host is always `ok`.
 */
export type SetupEntitlement = 'ok' | 'grace' | 'expired';

export interface SetupPanelInput {
  enabled: boolean;
  /** Whether the viewer has Manage Channels (admin actions are shown only to them). */
  isAdmin: boolean;
  /**
   * Pre-formatted plan line (see {@link formatPlan}), or `null` when there is no
   * plan to speak of.
   *
   * Self-host passes `null` rather than the "every feature unlocked" line: a
   * server with no billing has nothing to check, and a status line that can only
   * ever say one thing is the kind of always-fine field this panel exists to
   * stop rendering. `formatPlan` keeps its self-hosted branch for any other
   * caller.
   */
  plan: string | null;
  /** Needed so the expired and grace states can deep-link to THIS server's card. */
  guildId: string;
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
  /**
   * How `@@game_name@@` resolves a tie for most-played game, so the settings
   * select can report the current value and say what selecting it does.
   */
  gameNameMode?: GameNameMode;
  /** Hosted billing state, reduced to what the panel renders differently. */
  entitlement?: SetupEntitlement;
  /**
   * Re-invite URL, so the missing-permissions state can offer the one-click fix
   * instead of only describing it. Absent on self-host, where nobody is going
   * through an OAuth screen to fix their own bot.
   */
  inviteUrl?: string;
  /**
   * A one-off result line from the action that just refreshed this panel (a
   * creator channel created, logging saved). Rendered in a nameless field so the
   * outcome and the new state arrive in one message rather than two.
   */
  note?: string;
  /**
   * The guild's IANA zone, absent when it has never been set.
   *
   * Carried so the settings select can report it: unlike every other option
   * here, the default is not merely a default, it is a value that is wrong for
   * most servers and invisible until a date token renders.
   */
  timezone?: string;
  /** How many named `[[list:name]]` pools the guild has, for the select's label. */
  listCount?: number;
}

/**
 * Which situation the server is in, highest first. Every difference the panel
 * renders -- colour, headline, which action is recommended, which settings are
 * offered -- is derived from this one value, so a state is added in one place
 * rather than in six conditionals.
 *
 * Order is not cosmetic. `expired` outranks everything because no other action
 * works until it is fixed; missing permissions outrank a pause because turning
 * automation back on would change nothing; and `problems` outranks `firstRun`
 * because a guild reporting failures has channels to fix, whatever the creator
 * channel count says.
 */
export type SetupState =
  | 'expired'
  | 'permissions'
  | 'paused'
  | 'problems'
  | 'grace'
  | 'firstRun'
  | 'healthy';

export function setupState(input: SetupPanelInput): SetupState {
  if (input.entitlement === 'expired') return 'expired';
  if (input.missingPermissions.length > 0) return 'permissions';
  if (!input.enabled) return 'paused';
  if ((input.problems?.length ?? 0) > 0) return 'problems';
  if (input.entitlement === 'grace') return 'grace';
  if (input.primaries.length === 0) return 'firstRun';
  return 'healthy';
}

const STATE_COLOR: Record<SetupState, number> = {
  expired: 0xed4245,
  permissions: 0xed4245,
  paused: 0x9e9e9e,
  problems: 0xfaa61a,
  grace: 0xfaa61a,
  firstRun: 0x5865f2,
  healthy: 0x4caf50,
};

/**
 * Shown once, to the only person who has never seen AVC work: an admin with no
 * creator channel yet. Every other state assumes they know what the bot does.
 */
const FIRST_RUN_INTRO =
  'Members join a **creator channel** and get their own room, named ' +
  'automatically and removed when it empties. Start by making one.';

function channelList(ids: { channelId: string }[]): string {
  const shown = ids.slice(0, 10).map((c) => `• <#${c.channelId}>`);
  if (ids.length > 10) shown.push(`…and ${ids.length - 10} more`);
  return shown.join('\n');
}

/** The one line describing what is missing, and the two ways to grant it. */
function missingPermissionsLine(missing: string[]): string {
  return (
    `⚠️ Missing **${missing.join('**, **')}**. Re-invite me with the correct ` +
    'permissions, or grant them on my role.'
  );
}

/**
 * The description, top to bottom.
 *
 * Only the state's own story goes here, then the plan line. Every "everything is
 * fine" line the old panel rendered unconditionally is now the absence of a
 * problem line, which is what lets a healthy panel be two lines instead of six
 * fields.
 */
function headlineLines(input: SetupPanelInput, state: SetupState): string[] {
  const lines: string[] = [];
  switch (state) {
    case 'expired':
    case 'grace':
      // The plan line already names the problem and carries the dashboard
      // link, so repeating it above would say the same thing twice.
      break;
    case 'permissions':
      lines.push(missingPermissionsLine(input.missingPermissions));
      break;
    case 'paused':
      lines.push('⏸️ **Paused.** AVC is not making new rooms on this server.');
      break;
    case 'problems':
      // Deliberately no status line. The "Needs attention" field below is the
      // message, and "permissions look good" above it reads as a contradiction
      // to someone whose rooms are not being made.
      break;
    case 'firstRun':
      lines.push(FIRST_RUN_INTRO, '✅ Permissions look good.');
      break;
    case 'healthy':
      lines.push('✅ Permissions look good, automation is on.');
      break;
  }
  if (input.plan) lines.push(input.plan);
  return lines;
}

/** Renders the `/setup` panel for the state the server is actually in. */
export function buildSetupPanel(input: SetupPanelInput): InteractionReplyOptions {
  const state = setupState(input);
  const problems = input.problems ?? [];
  const fields: APIEmbedField[] = [];

  // Surface recent permission incidents with the fix that actually matches
  // what failed, so admins aren't left guessing why automation stalled. First,
  // because in this state it is the only thing worth reading.
  //
  // Rendered by the shared summariser, which the push notice also uses: an
  // admin who got the notice and then opens this panel must read the same
  // advice, or one of the two is teaching them the wrong fix.
  if (problems.length > 0) {
    fields.push({
      name: `⚠️ Needs attention (${problems.length})`,
      value: permissionProblemSummary(problems).join('\n\n'),
    });
  }
  // Both lists are omitted when empty rather than explaining themselves. The
  // empty "Managed channels (0)" hint advertised adopting an existing channel
  // to every server on every open, which is an advanced path most never take.
  if (input.primaries.length > 0) {
    fields.push({
      name: `Creator channels (${input.primaries.length})`,
      value: channelList(input.primaries),
    });
  }
  if (input.managed.length > 0) {
    fields.push({
      name: `Managed channels (${input.managed.length})`,
      value: channelList(input.managed),
    });
  }
  // The outcome of whatever action refreshed this panel, in a nameless field so
  // it reads as a footnote to the new state rather than a section of its own.
  if (input.note) fields.push({ name: '​', value: input.note.slice(0, 1024) });

  const builder = new EmbedBuilder()
    .setTitle('Auto-Voice-Channels · Setup')
    .setColor(STATE_COLOR[state]);
  const description = headlineLines(input, state).join('\n');
  if (description) builder.setDescription(description);
  if (fields.length > 0) builder.addFields(...fields);
  const embed: APIEmbed = builder.toJSON();

  const components = input.isAdmin ? adminRows(input, state) : memberRows();
  return { embeds: [embed], components, ephemeral: true };
}

function linkButton(label: string, url: string, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel(label);
  if (emoji) b.setEmoji(emoji);
  return b;
}

/** Custom id of the "More settings" select. */
export const SETUP_SETTINGS_ID = setupId('settings');

type PanelRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

/**
 * The settings nobody opens `/setup` for, behind one select.
 *
 * Every option's VALUE is the button id the action already had, so the routing,
 * the gating and the tests all key off the same string whether the action was
 * reached from a button or from here. The descriptions are the point: they are
 * where "no game label" and "template assistant" stop being jargon, which a row
 * of buttons has nowhere to put.
 *
 * A future language picker needs its own select rather than an entry in this
 * settings menu. Keep the spare row available for it.
 */
function settingsRow(
  input: SetupPanelInput,
  state: SetupState,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel('Event logging')
      .setValue(setupId('logging'))
      .setDescription('Post room events to a text channel, and how to hear about problems')
      .setEmoji('🪵'),
    new StringSelectMenuOptionBuilder()
      .setLabel('"No game" label')
      .setValue(setupId('general'))
      .setDescription('What room names show when nobody is playing a game. Default: General')
      .setEmoji('🎮'),
    new StringSelectMenuOptionBuilder()
      .setLabel('Tied games')
      .setValue(setupId('gamemode'))
      // Reports state, like the time zone option below and for the same
      // reason: this one toggles on selection rather than opening a modal, so
      // the description is the only place it can say what selecting it does.
      .setDescription(
        input.gameNameMode === 'top'
          ? 'Room names pick one game when several are tied. Switch back to show both'
          : 'A two-way tie shows both games. Switch to name the room after one of them',
      )
      .setEmoji('🎯'),
    new StringSelectMenuOptionBuilder()
      .setLabel('Time zone')
      .setValue(setupId('timezone'))
      // The one description here that reports state rather than explaining the
      // setting. An unset zone renders the date tokens in UTC silently, which is
      // the wrong day for most of the install base, so the panel has to be able
      // to say so without being opened.
      .setDescription(
        input.timezone === undefined
          ? 'Date and time tokens use UTC. Set yours so the days line up'
          : `Date and time tokens use ${input.timezone}`.slice(0, 100),
      )
      .setEmoji('🕓'),
    new StringSelectMenuOptionBuilder()
      .setLabel('Named lists')
      .setValue(setupId('lists'))
      .setDescription(
        (input.listCount ?? 0) === 0
          ? 'Sets of words a template can pick one of, as [[list:name]]'
          : `${input.listCount} set${input.listCount === 1 ? '' : 's'} of words a template ` +
              'can pick from, as [[list:name]]',
      )
      .setEmoji('🎲'),
  ];
  // The assistant is hidden in an expired guild because `allowedWhileExpired`
  // refuses it, and the panel must not offer an action it is about to refuse.
  // The pause toggle below is hidden for consistency only: that flag IS still
  // writable while expired, deliberately, since `/setup` and its settings modals
  // are the exemption that lets a gated admin see and fix their state.
  if (input.assistant === true && state !== 'expired') {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Write a name template for me')
        .setValue(setupId('assistant'))
        .setDescription('Describe the room names you want and AVC writes the template')
        .setEmoji('✨'),
    );
  }
  // Only when there is something to pause. When it is already paused, turning it
  // back on is the recommended action and sits on the row above.
  if (input.enabled && state !== 'expired') {
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Pause on this server')
        .setValue(setupId('toggle'))
        .setDescription('Stop making new rooms until you turn it back on')
        .setEmoji('⏸️'),
    );
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SETUP_SETTINGS_ID)
    .setPlaceholder('More settings')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(...options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/**
 * At most ONE Success button, and never a Primary, a Danger or a disabled one.
 *
 * The old panel had five blues, a green and a greyed-out placeholder, so nothing
 * read as the thing to press. Here the single green button is whatever this
 * state's answer is, and where the answer is a link (reactivate, re-invite) or
 * there is no answer, there is no green button at all.
 */
function adminRows(input: SetupPanelInput, state: SetupState): PanelRow[] {
  const actions: ButtonBuilder[] = [];

  if (state === 'expired') {
    // Nothing else on the panel would do anything, so nothing else is offered.
    actions.push(linkButton('Reactivate', subscribeUrl(input.guildId), '💳'));
  } else {
    if (state === 'grace') {
      actions.push(linkButton('Manage subscription', subscribeUrl(input.guildId), '💳'));
    }
    if (state === 'permissions' && input.inviteUrl) {
      actions.push(linkButton('Fix permissions', input.inviteUrl, '🔑'));
    }
    if (state === 'paused') {
      actions.push(
        new ButtonBuilder()
          .setCustomId(setupId('toggle'))
          .setLabel('Turn back on')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success),
      );
    }
    actions.push(
      new ButtonBuilder()
        .setCustomId(setupId('create'))
        .setLabel('New creator channel')
        .setEmoji('➕')
        // Steps down wherever the recommended action is something else, so the
        // green button is never ambiguous.
        .setStyle(
          state === 'paused' || state === 'permissions'
            ? ButtonStyle.Secondary
            : ButtonStyle.Success,
        ),
    );
    if (input.primaries.length > 0 || input.managed.length > 0) {
      actions.push(
        new ButtonBuilder()
          .setCustomId(setupId('manage'))
          .setLabel('Edit room names')
          .setEmoji('🛠️')
          .setStyle(ButtonStyle.Secondary),
      );
    }
  }

  const rows: PanelRow[] = [rowOf(...actions)];
  /**
   * The first-run panel offers exactly one thing, which is the point of it.
   *
   * Except when the guild already has managed channels: it is then not a first
   * run in any real sense, and the "no game" label has **no other entry point in
   * the product** (there is no slash command for it), so hiding the select would
   * make a setting those channels' templates depend on unreachable. A guild with
   * nothing at all loses nothing, since the label has no channel to affect until
   * it makes one, at which point this state no longer applies.
   */
  if (state !== 'firstRun' || input.managed.length > 0) rows.push(settingsRow(input, state));
  rows.push(linkRow());
  return rows;
}

function memberRows(): PanelRow[] {
  return [linkRow()];
}

function linkRow(): ActionRowBuilder<ButtonBuilder> {
  return rowOf(
    linkButton('Docs', DOCS_URL, '📖'),
    linkButton('Support server', SUPPORT_URL, '💬'),
    linkButton('Privacy', PRIVACY_URL, '🔒'),
  );
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
  opts: { back?: boolean } = {},
): InteractionUpdateOptions {
  const components: (
    | ActionRowBuilder<ChannelSelectMenuBuilder>
    | ActionRowBuilder<ButtonBuilder>
  )[] = [channelPickerRow(command)];
  /**
   * Only when the picker REPLACED a panel, which is the case that used to
   * dead-end: `/setup` was gone and nothing brought it back short of running the
   * command again. Reached from a slash command there is no panel to return to,
   * so the button would be a lie.
   */
  if (opts.back) {
    components.push(
      rowOf(
        new ButtonBuilder()
          .setCustomId(setupId('open'))
          .setLabel('Back to setup')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return { content: prompt, embeds: [], components };
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
    .setLabel('Shown instead of a game name')
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
