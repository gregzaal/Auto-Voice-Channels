import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type ImageURLOptions,
  type InteractionReplyOptions,
} from 'discord.js';
import {
  BOT_BIO_MAX,
  BOT_NAME_MAX,
  BOT_PROFILE_FIELDS,
  isBotProfileField,
  type BotProfileField,
} from '../features/botProfile.js';

/**
 * `/botprofile`: the panel for the bot's own avatar, banner, name and bio in
 * this server, and the four modals behind it.
 *
 * Reached from the command and from `/setup`'s More settings, and both need
 * Manage Server: this changes how the bot looks to everyone in the server, which
 * is the same reach `/import` has.
 *
 * One row per field, each a set and a reset (owner, 2026-09-23), so the whole
 * surface is visible at once and no field's reset hides behind another's modal.
 * Every button is Secondary under `/setup`'s rules:
 * none of the eight is more the thing to press than the others.
 */

/** Custom-id namespace for the panel and its modals. */
export const BOT_PROFILE_PREFIX = 'avc:bp:';

export type BotProfileAction = 'set' | 'reset';

/** A set button, and the modal it opens: both answer to the same id. */
export const botProfileSetId = (field: BotProfileField): string =>
  `${BOT_PROFILE_PREFIX}set:${field}`;

export const botProfileResetId = (field: BotProfileField): string =>
  `${BOT_PROFILE_PREFIX}reset:${field}`;

/**
 * Parses a panel or modal id back into what it asks for, or null.
 *
 * The field is checked against the known list rather than trusted: the id comes
 * back from a message we posted, but it is still client input on the wire.
 */
export function parseBotProfileId(
  customId: string,
): { action: BotProfileAction; field: BotProfileField } | null {
  if (!customId.startsWith(BOT_PROFILE_PREFIX)) return null;
  const [action, field] = customId.slice(BOT_PROFILE_PREFIX.length).split(':');
  if ((action !== 'set' && action !== 'reset') || !field || !isBotProfileField(field)) return null;
  return { action, field };
}

/** The input inside the two upload modals. */
export const BOT_PROFILE_FILE_ID = 'file';
/** The input inside the name and bio modals. */
export const BOT_PROFILE_TEXT_ID = 'value';

/** What the panel reports, read from the bot's own guild member. */
export interface BotProfileView {
  /** This server's nickname for the bot, or null when it has none. */
  nickname: string | null;
  /** What the bot is called when it has no nickname. */
  defaultName: string;
  /** What members see: this server's avatar when set, the usual one otherwise. */
  avatarUrl: string;
  customAvatar: boolean;
  animatedAvatar: boolean;
  /** This server's banner, or null when there is none. */
  bannerUrl: string | null;
  /**
   * Whether the bot holds Change Nickname here, the one permission any of the
   * four needs. The invite does not ask for it, so the panel says so before an
   * admin types a name that is about to be refused.
   */
  canRename: boolean;
}

/** The slice of a discord.js `GuildMember` the view needs. */
export interface BotProfileMember {
  nickname: string | null;
  avatar: string | null;
  banner: string | null;
  user: { username: string; globalName?: string | null };
  permissions: { has(permission: bigint): boolean };
  displayAvatarURL(options?: ImageURLOptions): string;
  bannerURL(options?: ImageURLOptions): string | null;
}

/**
 * `bannerURL`, not `displayBannerURL`: the latter falls back to the bot's
 * global banner, and the panel's question is whether THIS server has one.
 */
export function botProfileViewOf(member: BotProfileMember): BotProfileView {
  return {
    nickname: member.nickname,
    defaultName: member.user.globalName ?? member.user.username,
    avatarUrl: member.displayAvatarURL({ size: 256 }),
    customAvatar: member.avatar !== null,
    animatedAvatar: member.avatar?.startsWith('a_') ?? false,
    bannerUrl: member.banner !== null ? member.bannerURL({ size: 1024 }) : null,
    canRename: member.permissions.has(PermissionFlagsBits.ChangeNickname),
  };
}

/** The Name field's warning, worded as the fix `profileFailure` gives. */
const NEEDS_CHANGE_NICKNAME =
  '⚠️ I need the Change Nickname permission to use a custom name. Give it to my role in ' +
  'Server Settings > Roles.';

/** Only the set buttons carry an emoji, so each row leads with what it changes. */
const FACES: Record<BotProfileField, { set: string; emoji: string; reset: string }> = {
  avatar: { set: 'Upload custom avatar', emoji: '👤', reset: 'Reset avatar' },
  banner: { set: 'Upload custom banner', emoji: '🖼️', reset: 'Reset banner' },
  name: { set: 'Set custom bot name', emoji: '🏷️', reset: 'Reset name' },
  bio: { set: 'Set custom bio', emoji: '📝', reset: 'Reset bio' },
};

const DESCRIPTION = 'Customize how this bot looks to members in this server.';

/**
 * Shown in a hard-gated server, whose panel keeps the four resets and loses the
 * four changes. Worded as a pause, like `/channelinfo`'s note for the same
 * state, so it reads as paused rather than broken.
 */
const PAUSED_NOTE = 'AVC is paused on this server, so the profile can be reset but not changed.';

/**
 * The panel.
 *
 * @param opts.canChange false in a hard-gated server: the gate refuses the four
 *   set buttons there and lets the resets through (`allowedWhileExpired`), and
 *   the panel must not offer a button it is about to refuse.
 */
export function buildBotProfilePanel(
  view: BotProfileView,
  opts: { canChange: boolean; note?: string },
): InteractionReplyOptions {
  const embed = new EmbedBuilder()
    .setTitle('Bot profile')
    .setColor(0x5865f2)
    .setDescription(opts.canChange ? DESCRIPTION : `${DESCRIPTION}\n\n${PAUSED_NOTE}`)
    .setThumbnail(view.avatarUrl)
    .addFields(
      {
        name: 'Avatar',
        value: view.customAvatar
          ? view.animatedAvatar
            ? 'Custom, animated'
            : 'Custom'
          : 'Default',
        inline: true,
      },
      {
        name: 'Banner',
        value: view.bannerUrl ? 'Custom, shown below' : 'Default',
        inline: true,
      },
      {
        name: 'Name',
        value:
          (view.nickname
            ? escapeMarkdown(view.nickname)
            : `Default, ${escapeMarkdown(view.defaultName)}`) +
          (view.canRename ? '' : `\n${NEEDS_CHANGE_NICKNAME}`),
        inline: true,
      },
      {
        name: 'Bio',
        // Discord does not hand a bot its own guild bio back, so the panel
        // cannot report it. This says where it can be seen instead.
        value: "Open the bot's profile to see it",
        inline: true,
      },
    );
  if (view.bannerUrl) embed.setImage(view.bannerUrl);
  const json: APIEmbed = embed.toJSON();
  if (opts.note) {
    json.fields = [...(json.fields ?? []), { name: '​', value: opts.note.slice(0, 1024) }];
  }

  const button = (id: string, label: string): ButtonBuilder =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary);

  /**
   * No Close button (owner, 2026-09-23): the panel is ephemeral, and Discord
   * already puts Dismiss under every ephemeral message.
   */
  const rows: ActionRowBuilder<ButtonBuilder>[] = opts.canChange
    ? BOT_PROFILE_FIELDS.map((field) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(botProfileSetId(field), FACES[field].set).setEmoji(FACES[field].emoji),
          button(botProfileResetId(field), FACES[field].reset),
        ),
      )
    : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...BOT_PROFILE_FIELDS.map((field) =>
            button(botProfileResetId(field), FACES[field].reset),
          ),
        ),
      ];
  return { embeds: [json], components: rows, ephemeral: true };
}

const IMAGE_RULES = 'PNG, JPG or GIF (animation supported), under 10 MB.';

/**
 * The modal behind one set button.
 *
 * Every input is required, because a blank submit has nothing to mean: each
 * field has its own reset button beside it. The name is prefilled with the
 * current nickname so an admin fixing a letter does not retype it. The bio
 * cannot be, since Discord does not return it, and a file upload cannot be
 * prefilled at all.
 *
 * @param view only read for the name, and null when it could not be read,
 *   which leaves that modal empty rather than refusing to open it.
 */
export function buildBotProfileModal(
  field: BotProfileField,
  view: BotProfileView | null,
): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(botProfileSetId(field));
  switch (field) {
    case 'avatar':
    case 'banner':
      return modal
        .setTitle(field === 'avatar' ? 'Custom avatar' : 'Custom banner')
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(IMAGE_RULES))
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(field === 'avatar' ? 'Avatar' : 'Banner')
            .setDescription(
              field === 'avatar'
                ? 'Square works best, gets circular crop like any avatar'
                : 'Wide, 5:2 works best, like 600x240',
            )
            .setFileUploadComponent(
              new FileUploadBuilder()
                .setCustomId(BOT_PROFILE_FILE_ID)
                .setRequired(true)
                .setMinValues(1)
                .setMaxValues(1),
            ),
        );
    case 'name': {
      const input = new TextInputBuilder()
        .setCustomId(BOT_PROFILE_TEXT_ID)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(BOT_NAME_MAX);
      if (view) input.setPlaceholder(view.defaultName.slice(0, 100));
      if (view?.nickname) input.setValue(view.nickname.slice(0, BOT_NAME_MAX));
      return modal
        .setTitle('Custom bot name')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Bot name')
            .setDescription("Shown in the member list and on the bot's messages in this server")
            .setTextInputComponent(input),
        );
    }
    case 'bio':
      return modal
        .setTitle('Custom bio')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel('Bio')
            .setDescription("Shown on the bot's profile in this server")
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId(BOT_PROFILE_TEXT_ID)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(1)
                .setMaxLength(BOT_BIO_MAX),
            ),
        );
  }
}
