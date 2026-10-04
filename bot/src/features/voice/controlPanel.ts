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
  CONTROL_PANEL_CREATOR_TOKEN,
  CONTROL_PANEL_DESCRIPTION_MAX,
  CONTROL_PANEL_OWNER_TOKEN,
  CONTROL_PANEL_TITLE_MAX,
  type ControlPanelConfig,
  type ControlPanelControl,
} from './guildSettings.js';
import {
  mayUse,
  OCCUPANT_LEVEL_ACTIONS,
  PANEL_ACTION_FEATURE,
  type CommandAccess,
  type CommandCaller,
  type CommandFeature,
} from './commandAccess.js';
import { MAX_USER_LIMIT } from './commands.js';
import { SITE_URL } from '../billing/messages.js';
import { PANEL_FOOTER, PANEL_LINKS_FIELD } from '../panelBranding.js';

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
 * rather than both of them, the description names the current owner, who
 * changes when one leaves, and a control a `/restrict` rule denies the current
 * owner is absent (see {@link hiddenControls}). What it can never follow is the
 * READER: a channel message is one object rendered identically to everyone who
 * can see it, so hiding an owner-only button from a non-owner is not something
 * Discord can do. Ownership, and any restriction on whoever clicks, therefore
 * gate the click, in an ephemeral reply, and not the panel: an occupant who is
 * not the owner still sees the owner's buttons and is refused on pressing one.
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
 * thing to press, which is `/setup`'s one-Success rule
 * arriving at "no Success button at all" rather than a departure from it.
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
 * transition the room has already made. `hide` is the same kind of control, with
 * `hide` and `unhide` for its two faces.
 */
export type ControlPanelAction =
  | Exclude<ControlPanelControl, 'privacy' | 'hide'>
  | 'lock'
  | 'unlock'
  | 'hide'
  | 'unhide'
  | 'transferpick'
  | 'kickpick'
  | 'limitset'
  | 'renameset';

const ACTIONS: readonly string[] = [
  ...CONTROL_PANEL_CONTROLS.filter((c) => c !== 'privacy' && c !== 'hide'),
  'lock',
  'unlock',
  'hide',
  'unhide',
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

/** Where the Name field's "templates" link points. */
const TEMPLATES_DOC_URL = `${SITE_URL}/docs/name-templates`;

/**
 * Resolves the two variables an admin may write into the title or description.
 *
 * A function replacement rather than a string one: `String.replaceAll` reads
 * `$&` and friends in a replacement string, and while a mention never contains
 * one, the function form cannot be surprised by a future replacement that does.
 *
 * A room with no owner renders `nobody` rather than a broken mention. That is
 * not the same condition as the name engine's `@@owner@@`, which renders
 * `Unknown` when the owner is merely not in the room; here the room genuinely
 * has nobody in charge, which is exactly when Claim is the button that matters.
 */
export function renderPanelText(text: string, view: RoomPanelView): string {
  return text
    .replaceAll(CONTROL_PANEL_OWNER_TOKEN, () => (view.ownerId ? `<@${view.ownerId}>` : 'nobody'))
    .replaceAll(CONTROL_PANEL_CREATOR_TOKEN, () => `<#${view.primaryChannelId}>`);
}

/**
 * What is known about the room owner's standing under `/restrict`: their raw
 * identity (id, role ids, whether they can manage channels), or `unknown` when
 * it could not be read, for instance because the member is not in the cache.
 *
 * Raw rather than a verdict, so the rules are applied in ONE place (the poster)
 * for the create-time post and every later re-render, and the two cannot
 * diverge. `unknown` is a different answer from "nothing is restricted" and the
 * panel treats it differently, see {@link hiddenControls}.
 */
export type PanelOwnerAccess = CommandCaller | 'unknown';

/** What the room's current state does to the panel. */
export interface RoomPanelView {
  /** The current owner, or null when the room has none (Claim's case). */
  ownerId: string | null;
  /** The creator channel, for the "make your own" pointer. */
  primaryChannelId: string;
  /**
   * Whether the room is locked right now, which decides the privacy button. True for
   * a hidden room too: a hidden room is a locked one, so its button offers Public.
   */
  isPrivate: boolean;
  /**
   * Whether the room is hidden from the channel list, which decides whether the Hide
   * control offers Hide or Unhide. `unknown` when the room's access record could not
   * be read: it may be hidden, and the panel never offers a transition on a guess, so
   * the control is left off until the record can be read. Not optional, so that a
   * builder cannot forget it and draw a hidden room's panel as a public one.
   */
  isHidden: boolean | 'unknown';
  /** The live user limit, 0 for none, shown on the Size field. */
  userLimit: number;
  /**
   * The owner's standing under `/restrict`. Absent reads as `unknown`, which is
   * what every caller that predates restrictions gets, so nothing is hidden.
   */
  ownerAccess?: PanelOwnerAccess | undefined;
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
  lock: { label: 'Private', emoji: '🔒', blurb: 'Lock the room, people ask to enter' },
  unlock: { label: 'Public', emoji: '🔓', blurb: 'Open the room up to everyone again' },
};

/**
 * The two faces of the hide control: the transition the room can actually make, as
 * with privacy, and what "hidden" means said in no stronger words than the channel
 * list. Who still sees a hidden room is the `/hide` reply's to say.
 */
const HIDE_FACES: Record<'hide' | 'unhide', ControlFace> = {
  hide: { label: 'Hide', emoji: '🙈', blurb: 'Hide the room in the channel list' },
  unhide: { label: 'Unhide', emoji: '👁️', blurb: 'Show the room in the channel list again' },
};

/**
 * Label, emoji and description for every control but the two that flip with the room
 * (privacy and hide, which have faces of their own above).
 *
 * Exported because `/controlpanel` lists the same set, and an admin switching
 * one off has to be looking at the word the member sees on the button.
 */
export const CONTROL_PANEL_FACES: Record<
  Exclude<ControlPanelControl, 'privacy' | 'hide'>,
  ControlFace
> = {
  limit: { label: 'Size', emoji: '👥', blurb: 'Set a limit on the room size' },
  rename: {
    label: 'Name',
    emoji: '✏️',
    blurb: `Rename your room, supports [templates](${TEMPLATES_DOC_URL})`,
  },
  claim: { label: 'Claim', emoji: '👑', blurb: 'Take over a room with nobody in charge' },
  transfer: { label: 'Transfer', emoji: '🤝', blurb: 'Hand the room to someone else in it' },
  kick: { label: 'Kick', emoji: '🥾', blurb: 'Start a vote to remove someone' },
  info: { label: 'Info', emoji: 'ℹ️', blurb: 'See how this room is configured' },
};

/**
 * How one control looks right now: its action id and its face, or null when the room
 * cannot be offered it at all (see {@link RoomPanelView.isHidden}).
 */
function faceOf(
  control: ControlPanelControl,
  view: RoomPanelView,
): { action: ControlPanelAction; face: ControlFace } | null {
  if (control === 'privacy') {
    const action = view.isPrivate ? 'unlock' : 'lock';
    return { action, face: PRIVACY_FACES[action] };
  }
  if (control === 'hide') {
    // A record this build cannot read may be a hidden room's. Offering Hide would be
    // refused and offering Unhide would be a guess, so the control is left off.
    if (view.isHidden === 'unknown') return null;
    const action = view.isHidden ? 'unhide' : 'hide';
    return { action, face: HIDE_FACES[action] };
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
 * what the toggle does. Hide is the same: one switch for both Hide and Unhide.
 */
export function settingsFaceOf(control: ControlPanelControl): ControlFace {
  if (control === 'privacy') {
    return {
      label: 'Private and Public',
      emoji: '🔒',
      blurb: 'Lock the room, and open it again. One button, whichever applies',
    };
  }
  if (control === 'hide') {
    return {
      label: 'Hide and Unhide',
      emoji: '🙈',
      blurb: 'Hide the room in the channel list, and show it again. One button, whichever applies',
    };
  }
  return CONTROL_PANEL_FACES[control];
}

/**
 * Whether `/restrict` denies this room's owner the feature behind a control.
 *
 * Three answers, which is the point of reading the owner as raw access:
 *
 * - **A resolved owner** is judged exactly as the slash command would judge them,
 *   so an owner an allow list leaves out loses the control as one a deny list
 *   names does.
 * - **An ownerless room** hides every control whose feature has any rule, an allow
 *   list or a deny list, since either can refuse somebody. There is nobody to
 *   judge, and the panel cannot tell who will press it, so the control that some
 *   members would be refused on is withdrawn. The slash commands still gate by
 *   the caller's own identity.
 * - **An owner who could not be resolved** hides nothing. A cold member cache is
 *   routine, and withdrawing a button on a guess is worse than leaving one that
 *   the click-time guard will refuse for the people it applies to.
 */
function ownerRestricted(
  feature: CommandFeature,
  view: RoomPanelView,
  access: CommandAccess,
): boolean {
  if (!access[feature]) return false;
  if (view.ownerId === null) return true;
  const owner = view.ownerAccess;
  if (owner === undefined || owner === 'unknown') return false;
  return !mayUse(feature, owner, access);
}

/**
 * The controls a `/restrict` rule withdraws from this room's panel.
 *
 * Decided from the action each control would CARRY right now, not from the
 * control, so the undo direction is never hidden: a locked room still shows
 * Public, because opening a room again is never restricted, and Private is
 * hidden only while the room is public. The same goes for Hide: an already
 * hidden room shows Unhide to everyone, and Hide is withdrawn only while the room
 * is not hidden. Size, Name and Transfer are hidden when the owner is denied.
 * Claim, Kick and Info are occupant-level ({@link OCCUPANT_LEVEL_ACTIONS}) and
 * never hidden, whatever the owner's standing: anyone in the room presses them, so
 * a rule on Kick or Claim is refused at the click, for whoever it covers.
 * `PANEL_ACTION_FEATURE` is a `Record` over every action, so a control added
 * later cannot reach here without a decision about it.
 */
export function hiddenControls(
  view: RoomPanelView,
  access: CommandAccess,
): ReadonlySet<ControlPanelControl> {
  const hidden = new Set<ControlPanelControl>();
  for (const control of CONTROL_PANEL_CONTROLS) {
    const face = faceOf(control, view);
    if (face === null || OCCUPANT_LEVEL_ACTIONS.has(face.action)) continue;
    const feature = PANEL_ACTION_FEATURE[face.action];
    if (feature !== null && ownerRestricted(feature, view, access)) hidden.add(control);
  }
  return hidden;
}

/**
 * Buttons per row. Three, not Discord's ceiling of five: Discord draws inline embed
 * fields three to a row, so three buttons put each row under the fields that describe it.
 * Eight controls make three rows, well inside Discord's five.
 */
const PANEL_ROW_SIZE = 3;

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
 *
 * **Null is decided from the admin's configuration, BEFORE any restriction is
 * applied.** The caller turns null into "post nothing" or into an edit to the
 * line saying the panel was switched off for the server, and a room whose owner
 * is merely denied every button is not that. When restrictions leave no buttons
 * the embed is still rendered, with no component rows, so the panel stays and
 * says who owns the room and where to make one's own.
 */
export function buildControlPanel(
  roomId: string,
  config: ControlPanelConfig,
  view: RoomPanelView,
  access: CommandAccess = {},
): ControlPanelMessage | null {
  if (!config.enabled) return null;
  const enabled = CONTROL_PANEL_CONTROLS.filter((c) => config.controls[c]);
  if (enabled.length === 0) return null;

  const hidden = hiddenControls(view, access);
  const faces = enabled
    .filter((c) => !hidden.has(c))
    .map((c) => faceOf(c, view))
    // A control the room cannot be offered at all (the Hide control of a room whose
    // access record cannot be read) is left off, like one a rule withdraws.
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const fields: APIEmbedField[] = faces.map(({ face }) => ({
    name: `${face.emoji} ${face.label}`,
    value: face.blurb,
    inline: true,
  }));
  fields.push(PANEL_LINKS_FIELD);

  /**
   * Mentions render inside an embed and never notify, so the owner is named
   * without being pinged on every re-render.
   *
   * Sliced to Discord's caps AFTER substitution, not before: the stored text is
   * within them, and a mention is longer than the token it replaces, so a
   * description sitting just under the limit would otherwise grow past it and
   * 400 the message.
   */
  const embed: APIEmbed = new EmbedBuilder()
    .setColor(config.color)
    /**
     * As typed, with NO substitution. Discord renders an embed title as plain
     * text: no markdown, no mentions. `@@owner@@` there would print the raw
     * `<@2234...>` at the top of every panel in the server, so the title takes
     * no variables at all and the modal that edits it says so. An admin who
     * types one anyway sees it standing literally and removes it, which is the
     * same way an unknown token behaves in the description.
     */
    .setTitle(config.title.slice(0, CONTROL_PANEL_TITLE_MAX))
    .setDescription(
      renderPanelText(config.description, view).slice(0, CONTROL_PANEL_DESCRIPTION_MAX),
    )
    .addFields(fields)
    .setFooter(PANEL_FOOTER)
    .toJSON();

  // Three per row, so each row of buttons sits under the row of three inline
  // fields that describes it. Chunking rather than a fixed layout so a server
  // that switches some off gets full rows rather than gaps.
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < faces.length; i += PANEL_ROW_SIZE) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        faces
          .slice(i, i + PANEL_ROW_SIZE)
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
