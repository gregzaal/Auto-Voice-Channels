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
} from 'discord.js';
import {
  CONTROL_PANEL_CONTROLS,
  type ControlPanelConfig,
  type ControlPanelControl,
} from './guildSettings.js';
import { MAX_USER_LIMIT } from './commands.js';

/**
 * The room control panel: the buttons posted into a new room's chat so a member
 * never has to learn a command name.
 *
 * Pure, like `joinPanel.ts` and for the same reason: everything here is a
 * function of the room id and the guild's configuration, so it unit-tests with
 * no client, no database and no interaction.
 *
 * **The room id rides in every custom id.** The panel does not always sit in
 * the room it controls: when a creator channel has companion text channels
 * switched on, it is posted into the companion instead, and
 * `interaction.channelId` there is a text channel that no `secondary_channels`
 * row names. Deriving the room from the clicker's current voice channel would
 * be wrong for the other reason - a moderator with companion access can read a
 * room's chat without being in it, and their click would land on whatever room
 * they happen to be in.
 *
 * **Every button is Secondary.** These are eight peer actions and none of them
 * is the thing to press, which is `/setup`'s one-Success rule (`rewrite.md`
 * decision 11) arriving at "no Success button at all" rather than a departure
 * from it. Nothing here is ever disabled either: a control a server has
 * switched off is absent, not greyed out. The sibling `/alias` and `/lists`
 * panels do use Primary and Danger, and they are admin panels with one obvious
 * action each; this is not.
 *
 * **Lock and Unlock are both always shown**, rather than the panel being
 * re-rendered as the room's privacy changes. A message kept in step with room
 * state is a second thing to keep convergent, and nothing in the codebase edits
 * a posted message.
 */

/** Custom-id namespace for the room control panel. */
export const CONTROL_PANEL_PREFIX = 'avc:panel:';

/**
 * What a panel interaction is asking for.
 *
 * The eight controls, plus the two member pickers the Transfer and Kick buttons
 * open (a button cannot carry a member id, so it has to ask) and the two modals
 * Limit and Rename open.
 */
export type ControlPanelAction =
  | ControlPanelControl
  | 'transferpick'
  | 'kickpick'
  | 'limitset'
  | 'renameset';

const ACTIONS: readonly string[] = [
  ...CONTROL_PANEL_CONTROLS,
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

/** The text input id inside the Limit and Rename modals. */
export const CONTROL_PANEL_INPUT_ID = 'input';

/** Discord's own cap on a voice channel name. */
const NAME_INPUT_MAX = 100;

/** AVC blurple, matching every other panel. */
const BLURPLE = 0x5865f2;

/**
 * Label and emoji for each control, in panel order.
 *
 * Exported because `/controlpanel` lists the same eight, and an admin switching
 * "Kick" off has to be looking at the word the member sees on the button.
 */
export const CONTROL_PANEL_LABELS: Record<ControlPanelControl, { label: string; emoji: string }> = {
  lock: { label: 'Lock', emoji: '🔒' },
  unlock: { label: 'Unlock', emoji: '🔓' },
  limit: { label: 'Limit', emoji: '👥' },
  rename: { label: 'Rename', emoji: '✏️' },
  claim: { label: 'Claim', emoji: '👑' },
  transfer: { label: 'Transfer', emoji: '🤝' },
  kick: { label: 'Kick', emoji: '🗳️' },
  info: { label: 'Info', emoji: 'ℹ️' },
};

/** What each control does, as the line beside it in the panel's own embed. */
const CONTROL_BLURBS: Record<ControlPanelControl, string> = {
  lock: 'close the room, and others can ask to join',
  unlock: 'open the room to everyone again',
  limit: 'set how many people fit in here',
  rename: 'give the room a different name',
  // Not "once its owner has left": when an owner leaves, the longest-present
  // member becomes the owner, so a third party pressing this is refused. What
  // it is actually for is getting your own room back.
  claim: 'take your room back, or take over one with nobody in charge',
  transfer: 'hand the room to someone else in it',
  kick: 'start a vote to remove someone',
  info: 'see how this room is named and configured',
};

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
): { embeds: APIEmbed[]; components: ActionRowBuilder<ButtonBuilder>[] } | null {
  if (!config.enabled) return null;
  const shown = CONTROL_PANEL_CONTROLS.filter((c) => config.controls[c]);
  if (shown.length === 0) return null;

  const embed: APIEmbed = new EmbedBuilder()
    .setColor(BLURPLE)
    .setTitle('🎛️ Room controls')
    .setDescription(
      // Not "your room", and not "whoever made it". Everybody in here can read
      // this and only one of them owns it, and ownership moves: it passes to
      // the longest-present member when an owner leaves, and Transfer and Claim
      // are two of the buttons below. "The owner" is the only phrasing that
      // stays true after any of that.
      'The room belongs to its owner. These do the same as the commands, for ' +
        'anyone who would rather not type.\n\n' +
        shown
          .map(
            (c) =>
              `${CONTROL_PANEL_LABELS[c].emoji} **${CONTROL_PANEL_LABELS[c].label}** ${CONTROL_BLURBS[c]}`,
          )
          .join('\n'),
    )
    .toJSON();

  // Five per row is Discord's ceiling, and eight controls therefore land as
  // five and three. Chunking rather than a fixed layout so a server that
  // switches some off gets full rows rather than gaps.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < shown.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        shown
          .slice(i, i + 5)
          .map((c) =>
            new ButtonBuilder()
              .setCustomId(controlPanelId(c, roomId))
              .setLabel(CONTROL_PANEL_LABELS[c].label)
              .setEmoji(CONTROL_PANEL_LABELS[c].emoji)
              .setStyle(ButtonStyle.Secondary),
          ),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

/**
 * The Limit button's modal.
 *
 * A modal rather than the up/down buttons VoiceMaster uses: those cost two of
 * the five slots in a row and still take four presses to get from 0 to 4.
 * Blank means no limit, which is what `/unlimit` does, so the panel needs no
 * ninth button for it.
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
 * The Rename button's modal.
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
