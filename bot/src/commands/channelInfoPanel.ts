import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type APIEmbed,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  renderChannelName,
  type ChannelInfo,
  type RenderContext,
  type TemplateSource,
} from '../features/voice/index.js';
import { permissionProblemSummary, type ProblemLike } from '../features/voice/index.js';
import { previewScenarios, renderPair } from '../features/templateAssistant/preview.js';
import { adviseTemplate, lintTemplate } from '../features/templateAssistant/validate.js';

/**
 * The `/channelinfo` panel: what AVC thinks a voice channel is, why it is named
 * what it is named, and what its template would do in the situations the person
 * asking cannot currently see.
 *
 * **Every value here is produced by rendering a probe through the real engine**
 * (`probeToken`, `probeVariable`), never by re-deriving what the engine would
 * say. A second implementation can drift while its own tests stay green.
 * Probing uses the same function that names the channel.
 *
 * This module never CONSTRUCTS a `RenderContext`. It receives one that
 * `VoiceFeature.buildRenderContext` assembled, which is what keeps
 * `renderContextGuard.unit.test.ts`'s invariant true past the edge of
 * `handler.ts`. `channelInfoPanel.unit.test.ts` reads this file and enforces it.
 */

/** Custom-id namespace for the `/channelinfo` panel. */
export const CHANNELINFO_PREFIX = 'avc:info:';

/** Which of the three views a button opens. */
export type ChannelInfoView = 'summary' | 'tokens' | 'scenarios';

export const infoId = (view: ChannelInfoView, channelId: string): string =>
  `${CHANNELINFO_PREFIX}${view}:${channelId}`;

/** Parses `avc:info:<view>:<channelId>`. */
export function parseInfoId(customId: string): { view: ChannelInfoView; channelId: string } | null {
  if (!customId.startsWith(CHANNELINFO_PREFIX)) return null;
  const [, , view, channelId] = customId.split(':');
  if ((view !== 'summary' && view !== 'tokens' && view !== 'scenarios') || !channelId) return null;
  return { view, channelId };
}

const BLURPLE = 0x5865f2;
const GREY = 0x9e9e9e;
const DOCS_LINK = 'https://auto-voice.io/docs/name-templates';

/**
 * The `@@…@@` and number tokens the readout shows, in reading order.
 *
 * Bound to the engine's own vocabulary by the unit test: every entry of
 * `AT_TOKENS` and `NUMBER_TOKENS` must appear here or in {@link EXCLUDED_TOKENS}
 * with a reason, so a token added to the engine cannot quietly go unreported.
 */
export const TOKEN_PROBES: readonly string[] = [
  '##',
  '@@nato@@',
  '@@game_name@@',
  '@@owner@@',
  '@@num@@',
  '@@num_others@@',
  '@@num_playing@@',
  '@@num_live@@',
  '@@limit@@',
  '@@slots@@',
  '@@party_size@@',
  '@@party_state@@',
  '@@party_details@@',
  '@@stream_name@@',
  '@@random_emoji@@',
  '@@original_creator@@',
  '@@weekday@@',
  '@@month@@',
  '@@hour@@',
];

/** Tokens deliberately not listed, each with the reason it would be noise. */
export const EXCLUDED_TOKENS: Record<string, string> = {
  '@@creator@@': 'the older name for @@owner@@, which renders identically',
  '$#': 'a padded spelling of the number ## already shows',
  '$0#': 'a padded spelling of the number ## already shows',
  '$00#': 'a padded spelling of the number ## already shows',
  '$000#': 'a padded spelling of the number ## already shows',
  '$0000#': 'a padded spelling of the number ## already shows',
  '+#': 'the roman spelling of the number ## already shows',
};

/**
 * Condition variables that carry a VALUE rather than a yes or no, shown through
 * the token that renders the same thing.
 *
 * Split out because `evalExpression`'s bare form is `Boolean(value)` for a
 * non-array, so `{{GAME}}` is true for any game at all and `{{PLAYERS}}` is
 * false only at zero. Reporting either as yes or no would be true and useless.
 */
export const VALUE_VARIABLES: Record<string, string> = {
  GAME: '@@game_name@@',
  PLAYERS: '@@num_playing@@',
  WEEKDAY: '@@weekday@@',
  MONTH: '@@month@@',
  MAX: '@@party_size@@',
};

/** Condition variables that really are a yes or a no. */
export const BOOLEAN_VARIABLES: readonly string[] = [
  'PLAYING',
  'LIVE',
  'LIVE_DISCORD',
  'LIVE_EXTERNAL',
  'ANY_LIVE',
  'RICH',
  'FULL',
  'PRIVATE',
  'WEEKEND',
];

/**
 * Condition variables holding a list of ids. Bare, they mean "the list is not
 * empty", which is what is reported. The useful form is `VAR:id`, and the copy
 * says so, because bare `{{ROLE}}` is true for practically everyone (a member's
 * roles always include @everyone).
 */
export const LIST_VARIABLES: readonly string[] = ['OWNER', 'MEMBER', 'ROLE', 'ANY_ROLE'];

/** Renders one token on its own, so an empty result stays empty. */
function probeToken(token: string, ctx: RenderContext): string {
  return renderChannelName(token, ctx, { allowEmpty: true });
}

/** Renders one conditional on its own and reads back which branch fired. */
function probeVariable(name: string, ctx: RenderContext): boolean {
  return renderChannelName(`{{${name} ?? y // n}}`, ctx, { allowEmpty: true }) === 'y';
}

/**
 * Cuts by CODE POINT, never by UTF-16 code unit.
 *
 * Every string reaching here is Discord-supplied (a game name, a party line, a
 * stream title, a display name, a rendered channel name), and slicing one mid
 * surrogate pair emits a lone surrogate into the embed JSON. Truncate by
 * code point so emoji and other characters above the BMP remain valid.
 */
function truncate(s: string, max = 60): string {
  const points = [...s];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : s;
}

/**
 * A value cell that stays legible when the engine renders nothing.
 *
 * **The code span is a security boundary here, not decoration.** Several of
 * these values are text a MEMBER wrote and can change at will: `@@owner@@` is
 * their `/nick` or nickname, `@@stream_name@@` their stream title, and both are
 * substituted at step 9, which collapses only `"` runs. So `[Verify your
 * account](https://evil.example)` reaches this function verbatim, and embed
 * field values DO render masked links. Inside a code span it renders as text.
 *
 * Backticks and newlines are therefore stripped rather than escaped: either one
 * closes the span early and hands the rest of the row to the markdown renderer,
 * and Discord has no in-span escape that survives every case. Removing the two
 * characters is the only version that cannot be broken from outside.
 */
function cell(value: string): string {
  if (value === '') return '_(empty)_';
  // Emptiness is judged on the ORIGINAL, so a value that was nothing but
  // backticks does not get reported as an empty token, which it is not.
  const safe = value.replace(/[`\r\n]/g, '');
  return safe === '' ? '_(not printable)_' : `\`${truncate(safe)}\``;
}

const SOURCE_LABEL: Record<TemplateSource, string> = {
  channel: 'set on this channel',
  creator: 'from the creator channel',
  server: 'the server default',
  managed: 'set on this channel',
};

const KIND_LABEL: Record<ChannelInfo['kind'], string> = {
  room: 'a room AVC created',
  creator: 'a creator channel',
  managed: 'a channel whose name AVC manages',
  unmanaged: 'not managed by AVC',
};

export interface ChannelInfoPanelInput {
  info: ChannelInfo;
  /** The channel's actual name in Discord, for the "does it match" line. */
  currentName: string;
  /** Whether the viewer holds Manage Channels, which adds the admin fields. */
  isAdmin: boolean;
  /** The bot's own permissions on this channel (admin view only). */
  botPermissions: Record<string, boolean>;
  /** Recent permission incidents on THIS channel (admin view only). */
  problems: readonly ProblemLike[];
  /** Set when the guild is hard-gated, so the panel says so rather than lying. */
  gatedNote?: string | undefined;
}

/** The default view: what this channel is, and whether its name is up to date. */
export function buildChannelInfoPanel(input: ChannelInfoPanelInput): InteractionReplyOptions {
  const { info, isAdmin } = input;
  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('🔎 Channel info')
    .setColor(info.kind === 'unmanaged' ? GREY : BLURPLE)
    .setDescription(`<#${info.channelId}> is **${KIND_LABEL[info.kind]}**.`)
    .toJSON();
  embed.fields = [];

  if (input.gatedNote) embed.fields.push({ name: 'Heads up', value: input.gatedNote });

  /**
   * The likeliest answer to the question this command exists for, and it was
   * collected and then never shown.
   *
   * `settings.enabled` false switches AVC off for the whole server. Without
   * this line the panel reports a room, its template and a name that is "up to
   * date", while nothing is being created or renamed at all.
   */
  if (!info.enabled) {
    embed.fields.push({
      name: '⏸️ Automation is off',
      value: isAdmin
        ? 'AVC is switched off for this whole server, so nothing is created or renamed. Turn it back on with `/setup`.'
        : 'AVC is switched off for this whole server, so nothing is created or renamed. An admin can turn it back on with `/setup`.',
    });
  }

  if (info.kind === 'room' || info.kind === 'managed') {
    const who = info.ownerId ? `<@${info.ownerId}>` : 'nobody right now';
    const claim =
      info.originalCreator && info.originalCreator !== info.ownerId
        ? `\nStarted by <@${info.originalCreator}>, who can take it back with \`/reclaim\`.`
        : '';
    embed.fields.push({ name: 'Owner', value: `${who}${claim}` });
  }

  /**
   * Occupancy, privacy and the detected game describe a ROOM, so they are
   * suppressed on a creator channel.
   *
   * They would otherwise be read off whoever is passing through the creator
   * channel at that instant, while the panel's own token view renders against
   * an empty room (`synthetic`). One click apart, the summary would say
   * "1 of 2, playing Halo" and the token view `@@num@@ 0`, `@@game_name@@
   * General`, with both correct and the pair incoherent. Nobody sits in a
   * creator channel, so there is no reading of these that is worth showing.
   */
  if (!info.render?.synthetic) {
    const people = info.members.total - info.members.bots;
    embed.fields.push(
      {
        name: 'People',
        value:
          info.userLimit >= 1
            ? `${people} of ${info.userLimit}`
            : `${people}, no limit set${info.members.bots > 0 ? ` (plus ${info.members.bots} bots)` : ''}`,
        inline: true,
      },
      {
        name: 'Access',
        value: info.isPrivate ? '🔒 Private' : '🔓 Open to everyone',
        inline: true,
      },
      { name: 'Game AVC sees', value: gameLine(info), inline: true },
    );
  }

  if (info.render) {
    // Destructured so the render reads `renderChannelName(template, ctx)`, which
    // is the shape this file's own guard test insists on: every render here uses
    // the assembled context it was handed, never one built locally.
    const { nameTemplate, ctx } = info.render;
    const rendered = renderChannelName(nameTemplate, ctx);
    embed.fields.push({ name: 'Name', value: nameLine(input, rendered) });
  } else {
    embed.fields.push({
      name: 'Name',
      value: isAdmin
        ? 'AVC does not rename this channel. Run `/template` here to let it.'
        : 'AVC does not rename this channel, so its name is whatever someone typed.',
    });
  }

  if (isAdmin) pushAdminFields(embed, input);

  return { embeds: [embed], components: rowsFor('summary', info), ephemeral: true };
}

/** "Why this name": the template, its source, and every token resolved live. */
export function buildTokenPanel(input: ChannelInfoPanelInput): InteractionReplyOptions {
  const { info } = input;
  if (!info.render) return buildChannelInfoPanel(input);
  const { ctx, nameTemplate, nameSource, statusTemplate, statusSource, synthetic } = info.render;

  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('🔎 Why this name')
    .setColor(BLURPLE)
    .setDescription(
      synthetic
        ? `These are the values a new room from <#${info.channelId}> would start with. ` +
            'A creator channel has no room of its own to read.'
        : `The values AVC is using for <#${info.channelId}> right now.`,
    )
    .toJSON();
  embed.fields = [];

  embed.fields.push({
    name: '📛 Name template',
    value:
      `${nameTemplate === '' ? '_(none, the name is left alone)_' : `\`${truncate(nameTemplate, 240)}\``}\n` +
      `_${SOURCE_LABEL[nameSource]}_`,
  });
  if (statusTemplate !== '') {
    embed.fields.push({
      name: '💬 Status template',
      value: `\`${truncate(statusTemplate, 240)}\`\n_${SOURCE_LABEL[statusSource]}_`,
    });
  }

  const advice = [
    ...lintTemplate(nameTemplate, 'name').map((issue) => issue.message),
    // Read off the render context rather than the settings blob, because that
    // is the zone and the pools this channel's own render actually used.
    ...adviseTemplate(nameTemplate, {
      timezone: ctx.timezone,
      listNames: Object.keys(ctx.lists ?? {}),
    }),
  ];
  if (advice.length > 0) {
    embed.fields.push({
      name: '⚠️ Worth checking',
      value: advice.join('\n').slice(0, 1024),
    });
  }

  embed.fields.push({
    name: 'Values',
    value: TOKEN_PROBES.map((t) => `\`${t}\` ${cell(probeToken(t, ctx))}`)
      .join('\n')
      .slice(0, 1024),
  });

  const conditions = [
    ...Object.entries(VALUE_VARIABLES).map(
      ([name, token]) => `\`{{${name}}}\` ${cell(probeToken(token, ctx))}`,
    ),
    ...BOOLEAN_VARIABLES.map(
      (name) => `\`{{${name}}}\` ${probeVariable(name, ctx) ? '✅ yes' : '❌ no'}`,
    ),
    ...LIST_VARIABLES.map(
      (name) => `\`{{${name}}}\` ${probeVariable(name, ctx) ? '✅ any' : '❌ none'}`,
    ),
  ];
  embed.fields.push({
    name: 'Conditions',
    value:
      `${conditions.join('\n')}\n_The last four take an id, like \`{{ROLE:123 ?? …}}\`._`.slice(
        0,
        1024,
      ),
  });

  if (info.seed !== undefined) {
    embed.fields.push({
      name: 'Random picks',
      value:
        `\`[[a/b/c]]\` is fixed for this channel by seed \`${info.seed}\`, so it never ` +
        'changes and never causes a rename.',
    });
  }

  const playing = playingLine(info);
  if (playing) embed.fields.push({ name: 'Who is playing what', value: playing });

  embed.fields.push({ name: '​', value: `**[All the variables ↗](${DOCS_LINK})**` });

  return { embeds: [embed], components: rowsFor('tokens', info), ephemeral: true };
}

/** "Other situations": this channel's own template across the fixture states. */
export function buildScenarioPanel(input: ChannelInfoPanelInput): InteractionReplyOptions {
  const { info } = input;
  if (!info.render) return buildChannelInfoPanel(input);
  const { nameTemplate, ctx } = info.render;

  const scenarios = previewScenarios({
    general: info.general,
    aliases: ctx.aliases ?? {},
    // The room's own owner reads better than "Unknown", and matches what
    // `@@owner@@` renders in the live panel beside this one.
    creatorName: ctx.creatorName ?? 'Someone',
    standalone: info.kind === 'managed',
    // Same room, same server: the fixtures must render in this guild's zone and
    // resolve this guild's `[[list:name]]` pools, or the "other situations"
    // view would disagree with the live one for no reason the reader can see.
    ...(ctx.lists ? { lists: ctx.lists } : {}),
    timezone: ctx.timezone,
    gameNameMode: ctx.gameNameMode,
    // Same room, different situation. Without this the previews would carry the
    // fixture's number and random picks, so a room called "Bravo" would preview
    // as "Alpha" and read as a bug.
    /**
     * Read off `ctx`, which is what the other two views actually rendered
     * with, NOT off `info`.
     *
     * `info.seed` is absent for every creator channel and for any room whose
     * seed was never stored, and the two sides then disagree by default: the
     * engine falls back to `0` (`ctx.seed ?? 0`) while `previewScenarios` falls
     * back to its own `PREVIEW_SEED` of 4. A template using `[[Red/Blue]]` then
     * says Red on the summary and Blue in every row here, which reads as
     * exactly the bug this panel exists to disprove.
     */
    identity: {
      index: ctx.index,
      seed: ctx.seed ?? 0,
      ...(ctx.numberOffset !== undefined ? { numberOffset: ctx.numberOffset } : {}),
    },
  });

  const lines = scenarios.map((s) => {
    const { rendered } = renderPair(nameTemplate, 'name', s.ctx);
    return `${cell(rendered)} · ${s.label}`;
  });

  const embed: APIEmbed = new EmbedBuilder()
    .setTitle('🔎 Other situations')
    .setColor(BLURPLE)
    .setDescription(
      `What <#${info.channelId}>'s template gives in states you cannot see right now. ` +
        'A template is only correct in the situations it will actually meet.',
    )
    .addFields({ name: 'This template', value: `\`${truncate(nameTemplate, 240)}\`` })
    .toJSON();
  embed.fields!.push({ name: 'Renders as', value: lines.join('\n').slice(0, 1024) });

  return { embeds: [embed], components: rowsFor('scenarios', info), ephemeral: true };
}

function gameLine(info: ChannelInfo): string {
  const raw = info.rawGames.filter((g) => g !== info.general && g !== info.game);
  return raw.length > 0
    ? `${escapeMarkdown(info.game)}\n_from ${escapeMarkdown(raw.join(', '))}, via an alias_`
    : escapeMarkdown(info.game);
}

/**
 * The rendered name against the real one.
 *
 * The mismatch case is the whole reason this line exists: it is the answer to
 * "the template is right, why has the channel not changed". Discord caps channel
 * renames at roughly two per ten minutes, so a correct template and a stale name
 * is the expected steady state for a busy room, not a fault.
 */
function nameLine(input: ChannelInfoPanelInput, rendered: string): string {
  const { info, currentName } = input;
  if (info.render?.synthetic) {
    return `The first room from here would be called ${cell(rendered)}.`;
  }
  if (rendered === currentName) return `${cell(rendered)}, which is up to date.`;
  return (
    `Renders as ${cell(rendered)}, but the channel is still called ` +
    `${cell(currentName)}.\nDiscord only allows about two renames every ten minutes, ` +
    'so a busy room can take a few minutes to catch up.'
  );
}

/**
 * Up to eight members and what each is playing, which is what picks the game.
 *
 * **Mirrors `playingNames` in the engine: `activities` when present, and the
 * flat `playing` list otherwise.** Reading `activities` alone is wrong in the
 * one way that matters here, because this field exists to explain the game
 * choice: a member carrying only `playing` still counts toward `getGameName`,
 * so listing them as playing nothing would name a game and then show nobody
 * playing it.
 */
function playingLine(info: ChannelInfo): string | undefined {
  const shown = info.render?.ctx.members.filter((m) => !m.bot).slice(0, 8) ?? [];
  if (shown.length === 0) return undefined;
  const lines = shown.map((m) => {
    const acts = (
      m.activities
        ? m.activities
            .filter((a) => a.kind !== 'other')
            .map((a) => `${a.kind === 'streaming' ? '🔴 ' : ''}${escapeMarkdown(a.name)}`)
        : m.playing.map((name) => escapeMarkdown(name))
    ).join(', ');
    return `• ${escapeMarkdown(m.displayName)}${acts ? `: ${acts}` : ': _nothing_'}`;
  });
  return lines.join('\n').slice(0, 1024);
}

function pushAdminFields(embed: APIEmbed, input: ChannelInfoPanelInput): void {
  const { info } = input;
  const perms = Object.entries(input.botPermissions)
    .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`)
    .join('  ');
  if (perms) embed.fields!.push({ name: 'What AVC can do here', value: perms });

  if (info.primary) {
    const p = info.primary;
    const bits = [
      `Creator channel: <#${p.channelId}>`,
      `New rooms appear ${p.above === true ? 'above' : 'below'} it, numbered from ${p.startAt ?? 1}`,
      `Default limit: ${p.limit && p.limit > 0 ? p.limit : 'none'}`,
      `New rooms start private: ${p.defaultPrivate === true ? 'yes' : 'no'}`,
      `Permissions copied from: ${p.inheritperms ? `\`${escapeMarkdown(p.inheritperms)}\`` : 'the creator channel'}`,
    ];
    embed.fields!.push({ name: 'Creator channel settings', value: bits.join('\n') });
  }

  if (input.problems.length > 0) {
    embed.fields!.push({
      name: '⚠️ Recent problems here',
      value: permissionProblemSummary(input.problems).join('\n\n').slice(0, 1024),
    });
  }
}

/** The button row for a view. Nothing to explore on an unmanaged channel. */
function rowsFor(view: ChannelInfoView, info: ChannelInfo): ActionRowBuilder<ButtonBuilder>[] {
  if (!info.render) return [];
  const button = (target: ChannelInfoView, label: string, emoji: string): ButtonBuilder =>
    new ButtonBuilder()
      .setCustomId(infoId(target, info.channelId))
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(ButtonStyle.Secondary);

  const buttons: ButtonBuilder[] = [];
  if (view !== 'summary') buttons.push(button('summary', 'Back', '↩️'));
  if (view !== 'tokens') buttons.push(button('tokens', 'Why this name', '🧩'));
  if (view !== 'scenarios') buttons.push(button('scenarios', 'Other situations', '🎲'));
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

/** Routes a view name to its builder, so the command and the buttons agree. */
export function buildChannelInfoView(
  view: ChannelInfoView,
  input: ChannelInfoPanelInput,
): InteractionReplyOptions {
  if (view === 'tokens') return buildTokenPanel(input);
  if (view === 'scenarios') return buildScenarioPanel(input);
  return buildChannelInfoPanel(input);
}
