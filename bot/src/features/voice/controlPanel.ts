import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type APIEmbedField,
} from 'discord.js';
import {
  CONTROL_PANEL_CONTROLS,
  type ControlPanelConfig,
  type ControlPanelControl,
} from './guildSettings.js';
import { MAX_USER_LIMIT } from './commands.js';
import { SITE_URL } from '../billing/messages.js';

/**
 * The room control panel: the buttons posted into a new room's chat so a member
 * never has to learn a command name.
 *
 * Pure, like `joinPanel.ts` and for the same reason: everything here is a
 * function of the room id, the guild's configuration and the room's current
 * state, so it unit-tests with no client, no database and no interaction.
 *
 * **The panel follows the room.** It is re-rendered whenever the room changes,
 * which is why {@link buildControlPanel} takes a {@link RoomPanelView} rather
 * than only a config: the privacy button shows the action that is available
 * rather than both of them, and the description names the current owner, who
 * changes when one leaves. What it can never follow is the READER: a channel
 * message is one object rendered identically to everyone who can see it, so
 * hiding an owner-only button from a non-owner is not something Discord can do.
 * Ownership therefore gates the click, in an ephemeral reply, and not the panel.
 *
 * **Editing is cheap; drifting is not.** A message edit is not on the
 * `PATCH /channels/{id}` bucket that caps a rename at 2 per 10 minutes, and it
 * notifies nobody and does not bump the channel. The risk is a panel that
 * silently stops matching its room, which is worse than a static one because it
 * states things that are false. {@link controlPanelFingerprint} is the answer:
 * every re-render re-derives the whole payload and writes only when it differs,
 * the same shape `rerenderSecondary` uses for the channel name.
 *
 * **The room id rides in every custom id.** The panel does not always sit in
 * the room it controls: when a creator channel has companion text channels
 * switched on, it is posted into the companion, and `interaction.channelId`
 * there is a text channel that no `secondary_channels` row names. Deriving the
 * room from the clicker's current voice channel would be wrong for the other
 * reason - a moderator with companion access can read a room's chat without
 * being in it, and their click would land on whatever room they happen to be in.
 *
 * **Every button is Secondary.** These are peer actions and none of them is the
 * thing to press, which is `/setup`'s one-Success rule (`rewrite.md` decision
 * 11) arriving at "no Success button at all" rather than a departure from it.
 * Nothing here is ever disabled either: a control a server has switched off, or
 * that does not apply to the room right now, is absent rather than greyed out.
 */

/** Custom-id namespace for the room control panel. */
export const CONTROL_PANEL_PREFIX = 'avc:panel:';

/**
 * What a panel interaction is asking for.
 *
 * The controls, plus the two member pickers the Transfer and Kick buttons open
 * (a button cannot carry a member id, so it has to ask) and the two modals Size
 * and Name open. `privacy` is never a custom id: the button carries `lock` or
 * `unlock`, whichever it currently offers, so a stale panel cannot ask for the
 * transition the room has already made.
 */
export type ControlPanelAction =
  | Exclude<ControlPanelControl, 'privacy'>
  | 'lock'
  | 'unlock'
  | 'transferpick'
  | 'kickpick'
  | 'limitset'
  | 'renameset';

const ACTIONS: readonly string[] = [
  ...CONTROL_PANEL_CONTROLS.filter((c) => c !== 'privacy'),
  'lock',
  'unlock',
  'transferpick',
  'kickpick',
  'limitset',
  'renameset',
];

/** Builds `avc:panel:<action>:<roomId>`. */
export function controlPanelId(action: ControlPanelAction, roomId: string): string {
  return `${CONTROL_PANEL_PREFIX}${action}:${roomId}`;
}

/**
 * Parses `avc:panel:<action>:<roomId>`, or null when it is not one of ours.
 *
 * Both fields are validated. A panel posted by a newer build and clicked while
 * an older one owns the guild's shard is the reachable case, and the caller
 * answers it with the standard out-of-date notice rather than leaving the
 * interaction unacknowledged.
 */
export function parseControlPanelId(
  customId: string,
): { action: ControlPanelAction; roomId: string } | null {
  if (!customId.startsWith(CONTROL_PANEL_PREFIX)) return null;
  const [, , action, roomId] = customId.split(':');
  if (!action || !roomId || !ACTIONS.includes(action)) return null;
  return { action: action as ControlPanelAction, roomId };
}

/** The text input id inside the Size and Name modals. */
export const CONTROL_PANEL_INPUT_ID = 'input';

/** Discord's own cap on a voice channel name. */
const NAME_INPUT_MAX = 100;

/** AVC blurple, matching every other panel. */
const BLURPLE = 0x5865f2;

/** The logo, served from the site. Verified live before it was put here. */
const LOGO_URL = `${SITE_URL}/logo.png`;
const LOGO_ICON_URL = `${SITE_URL}/logo-64.png`;

/** Where the Name field's "templates" link points. */
const TEMPLATES_DOC_URL = `${SITE_URL}/docs/name-templates`;

/** What the room's current state does to the panel. */
export interface RoomPanelView {
  /** The current owner, or null when the room has none (Claim's case). */
  ownerId: string | null;
  /** The creator channel, for the "make your own" pointer. */
  primaryChannelId: string;
  /** Whether the room is locked right now, which decides the privacy button. */
  isPrivate: boolean;
  /** The live user limit, 0 for none, shown on the Size field. */
  userLimit: number;
}

/** Label and emoji for a control, as the button and the field both show it. */
interface ControlFace {
  label: string;
  emoji: string;
  blurb: string;
}

/**
 * The two faces of the privacy control.
 *
 * One button, not two. It offers the transition the room can actually make,
 * which is what "do not show buttons that are not relevant" means for the one
 * control whose relevance is a fact about the room rather than about the reader.
 */
const PRIVACY_FACES: Record<'lock' | 'unlock', ControlFace> = {
  lock: { label: 'Private', emoji: '🔒', blurb: 'Lock the room, people must ask to enter' },
  unlock: { label: 'Public', emoji: '🔓', blurb: 'Open the room up to everyone again' },
};

/**
 * Label, emoji and description for every control but privacy.
 *
 * Exported because `/controlpanel` lists the same set, and an admin switching
 * one off has to be looking at the word the member sees on the button.
 */
export const CONTROL_PANEL_FACES: Record<Exclude<ControlPanelControl, 'privacy'>, ControlFace> = {
  limit: { label: 'Size', emoji: '👥', blurb: 'Set a limit on the room size' },
  rename: {
    label: 'Name',
    emoji: '✏️',
    blurb: `Rename your room, supports [templates](${TEMPLATES_DOC_URL})`,
  },
  claim: { label: 'Claim', emoji: '👑', blurb: 'Take over a room with nobody in charge' },
  transfer: { label: 'Transfer', emoji: '🤝', blurb: 'Hand the room to someone else in it' },
  kick: { label: 'Kick', emoji: '🗳️', blurb: 'Start a vote to remove someone' },
  info: { label: 'Info', emoji: 'ℹ️', blurb: 'See how this room is named and configured' },
};

/** How one control looks right now: its action id and its face. */
function faceOf(
  control: ControlPanelControl,
  view: RoomPanelView,
): { action: ControlPanelAction; face: ControlFace } {
  if (control === 'privacy') {
    const action = view.isPrivate ? 'unlock' : 'lock';
    return { action, face: PRIVACY_FACES[action] };
  }
  const face = CONTROL_PANEL_FACES[control];
  // The one other field that reads the room: a limit nobody set says nothing,
  // and a limit somebody set is the thing you want to know before changing it.
  if (control === 'limit' && view.userLimit > 0) {
    return { action: control, face: { ...face, blurb: `${face.blurb} (now ${view.userLimit})` } };
  }
  return { action: control, face };
}

/**
 * The face `/controlpanel` shows for a control, which has no room to read.
 *
 * Privacy gets its own, naming BOTH sides. An admin switching it off is not
 * taking away "Private", they are taking away the only way a locked room gets
 * opened again from the panel, and a label reading just "Private" hides half of
 * what the toggle does.
 */
export function settingsFaceOf(control: ControlPanelControl): ControlFace {
  if (control !== 'privacy') return CONTROL_PANEL_FACES[control];
  return {
    label: 'Private and Public',
    emoji: '🔒',
    blurb: 'Lock the room, and open it again. One button, whichever applies',
  };
}

/** The panel message: an embed and its button rows, or null when there is none to show. */
export interface ControlPanelMessage {
  embeds: APIEmbed[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/**
 * The panel message for a room, or null when this server has nothing to show.
 *
 * Null rather than an empty message for the two cases that mean the same thing
 * to a reader: the panel switched off, and every single button switched off.
 * The caller skips the post entirely, so a server that does not want this gets
 * no message in its rooms rather than an empty embed.
 */
export function buildControlPanel(
  roomId: string,
  config: ControlPanelConfig,
  view: RoomPanelView,
): ControlPanelMessage | null {
  if (!config.enabled) return null;
  const shown = CONTROL_PANEL_CONTROLS.filter((c) => config.controls[c]);
  if (shown.length === 0) return null;

  const faces = shown.map((c) => faceOf(c, view));

  /**
   * Mentions render inside an embed and never notify, so the owner is named
   * without being pinged on every re-render. A room with no owner says so
   * rather than rendering a broken mention, and that is exactly when Claim is
   * the button that matters.
   */
  const fields: APIEmbedField[] = faces.map(({ face }) => ({
    name: `${face.emoji} ${face.label}`,
    value: face.blurb,
    inline: true,
  }));

  const embed: APIEmbed = new EmbedBuilder()
    .setColor(BLURPLE)
    .setTitle('Control your room')
    .setThumbnail(LOGO_URL)
    .setDescription(
      (view.ownerId
        ? `This room belongs to <@${view.ownerId}>.`
        : 'This room has no owner right now.') + ` Make your own with <#${view.primaryChannelId}>`,
    )
    .addFields(fields)
    .setFooter({
      text: 'auto-voice.io  ·  Free and open source, dynamic voice channels.',
      iconURL: LOGO_ICON_URL,
    })
    .toJSON();

  // Five per row is Discord's ceiling. Chunking rather than a fixed layout so a
  // server that switches some off gets full rows rather than gaps.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < faces.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        faces
          .slice(i, i + 5)
          .map(({ action, face }) =>
            new ButtonBuilder()
              .setCustomId(controlPanelId(action, roomId))
              .setLabel(face.label)
              .setEmoji(face.emoji)
              .setStyle(ButtonStyle.Secondary),
          ),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

/**
 * A short digest of a rendered panel, for deciding whether to edit it.
 *
 * Over the WHOLE serialised payload rather than over the inputs that feed it,
 * deliberately: a fingerprint of hand-listed inputs stops matching the moment
 * somebody renders something new and forgets to add it, and the symptom is a
 * panel that silently never updates again. Hashing the output cannot drift from
 * the output.
 */
export function controlPanelFingerprint(panel: ControlPanelMessage | null): string {
  if (!panel) return 'none';
  const payload = JSON.stringify({
    embeds: panel.embeds,
    components: panel.components.map((r) => r.toJSON()),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The Size button's modal.
 *
 * A modal rather than the up and down buttons VoiceMaster uses: those cost two
 * of the five slots in a row and still take four presses to get from 0 to 4.
 * Blank means no limit, which is what `/unlimit` does, so the panel needs no
 * extra button for it.
 */
export function buildLimitModal(roomId: string, current?: number): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(CONTROL_PANEL_INPUT_ID)
    .setLabel('How many people, 0 or blank for no limit')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(2)
    .setPlaceholder(`0 to ${MAX_USER_LIMIT}`);
  if (current !== undefined && current > 0) input.setValue(String(current));
  return new ModalBuilder()
    .setCustomId(controlPanelId('limitset', roomId))
    .setTitle('Room size')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/**
 * The Name button's modal.
 *
 * Its own modal rather than the `/name` editor panel, which is an in-place
 * editing surface that replaces the message it was opened from. Opening that
 * from a panel posted in a public channel would replace the panel itself, for
 * everybody, permanently.
 */
export function buildRenameModal(roomId: string, current?: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(CONTROL_PANEL_INPUT_ID)
    .setLabel('Room name')
    .setStyle(TextInputStyle.Short)
    // NOT required: an empty submit is how the member clears their override and
    // gets the server's template back, and Discord refuses to submit a required
    // field left blank, so marking it required makes the placeholder a lie.
    .setRequired(false)
    .setMaxLength(NAME_INPUT_MAX)
    .setPlaceholder('Leave blank and submit to go back to the default');
  if (current) input.setValue(current.slice(0, NAME_INPUT_MAX));
  return new ModalBuilder()
    .setCustomId(controlPanelId('renameset', roomId))
    .setTitle('Rename this room')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

/** One member a picker can offer. */
export interface PickableMember {
  id: string;
  displayName: string;
}

/**
 * The member picker the Transfer and Kick buttons open, as an ephemeral reply.
 *
 * A string select built from the room's live occupants rather than Discord's
 * own user select, for two reasons: the router has no user-select branch, and
 * both actions are already refused for anyone who is not in the room, so
 * offering the whole server would be offering choices that cannot work.
 *
 * Capped at Discord's 25 options. A room past that is past the point where
 * picking a name from a list is the right interface anyway, and the command
 * still takes anyone by mention.
 */
export function buildMemberPicker(
  action: 'transferpick' | 'kickpick',
  roomId: string,
  members: readonly PickableMember[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(controlPanelId(action, roomId))
      .setPlaceholder(action === 'transferpick' ? 'Who should own the room?' : 'Who should go?')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        members.slice(0, 25).map((m) =>
          new StringSelectMenuOptionBuilder()
            .setValue(m.id)
            // Discord caps an option label at 100 characters and throws at
            // call time past it, which would take the whole picker down for
            // one long nickname.
            .setLabel(m.displayName.slice(0, 100) || m.id),
        ),
      ),
  );
}
