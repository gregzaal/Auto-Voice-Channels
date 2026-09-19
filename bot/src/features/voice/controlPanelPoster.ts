import type { Logger, SecondaryChannelRepository } from '@avc/core';
import {
  buildControlPanel,
  controlPanelFingerprint,
  type ControlPanelMessage,
  type RoomPanelView,
} from './controlPanel.js';
import { readControlPanel } from './guildSettings.js';
import { permissionProblemMessage, type PermissionProblemTracker } from './permissionProblems.js';

/**
 * What a panel becomes when the server switches it off after it was posted.
 *
 * Content rather than an empty edit: Discord refuses to leave a message with no
 * content, no embeds and no components, and a blank ghost message in every room
 * would be worse than a line explaining itself.
 */
const PANEL_SWITCHED_OFF = 'The room controls were switched off for this server.';

/** Just enough of the guild settings store to read one guild's blob. */
interface GuildSettingsReader {
  ensure(guildId: string): Promise<{ settings: Record<string, unknown> }>;
}

/** What the poster needs from Discord, as two functions so they fake in a line each. */
export type PanelSender = (channelId: string, payload: ControlPanelMessage) => Promise<string>;
export type PanelEditor = (
  channelId: string,
  messageId: string,
  // `content` only for the switched-off line, which is the one edit that has no
  // embed to carry it and cannot be empty.
  payload: ControlPanelMessage & { content?: string },
) => Promise<void>;

/** The row fields the poster reads, so a caller can pass one it already holds. */
export interface PanelRoomRow {
  guildId: string;
  state: {
    controlPanelMessageId?: string | undefined;
    controlPanelChannelId?: string | undefined;
    controlPanelHash?: string | undefined;
  };
}

export interface ControlPanelPosterDeps {
  /**
   * Posts the panel and returns the new message id.
   *
   * A plain function rather than a `Client`, and deliberately NOT a widening of
   * `VoiceActions`: every write on that interface early-returns on a non-voice
   * channel and reports SUCCESS, which is the trap `createCompanionChannel`
   * was given its own seam to avoid. It would also make every handler
   * integration test build a Discord client fake.
   */
  send: PanelSender;
  /**
   * Edits a posted panel in place.
   *
   * Must reject when the message is gone (Discord's 10008), because that is how
   * {@link ControlPanelPoster.refreshForRoom} learns to stop trying.
   */
  edit: PanelEditor;
  guilds: GuildSettingsReader;
  secondaries: SecondaryChannelRepository;
  logger: Logger;
  /** Surfaces a failed post to the server's admins, like every other one. */
  permissionProblems?: PermissionProblemTracker;
  serverLog?: (guildId: string, level: 1 | 2 | 3, message: string) => void;
  count?: (outcome: 'posted' | 'failed' | 'updated', guildId: string) => void;
}

/**
 * Posts the room control panel into a new room's chat, and keeps it in step
 * with the room afterwards.
 *
 * **Never throws, and never fails a room create or a command.** By the time
 * either runs the room exists and the member is in it, so the only thing a
 * throw could accomplish is turning working state into a failed task that
 * counts against the guild's circuit breaker. A room with no panel, or with a
 * panel one edit behind, is a working room, and the commands the buttons stand
 * in for all still work.
 *
 * **A failed POST is the ordinary case for a large part of the install base,
 * not an edge case.** The bot grants itself View Channel, Connect, Manage
 * Channels and Move Members on the rooms it creates, and nothing more, so a
 * category that denies Send Messages or Embed Links produces a perfect room
 * whose chat the bot cannot write in. That is recorded against the creator
 * channel through `PermissionProblemTracker` like every other permission
 * failure. It must not be fixed by widening what a created room grants the bot:
 * that same bitmask repairs inherited overwrites, and widening it changes every
 * room.
 *
 * **A failed EDIT is not reported to anybody.** By then the panel was posted,
 * so permissions were fine; what changed is almost always that somebody deleted
 * the message. Telling an admin to grant Send Messages for that would name the
 * wrong fix, so the row is cleared of its message id instead and the room
 * simply stops having a panel.
 */
export class ControlPanelPoster {
  constructor(private readonly deps: ControlPanelPosterDeps) {}

  /**
   * Posts the panel for a freshly-created room, once.
   *
   * @param destinationChannelId where it goes: the room's own chat, or its
   * companion text channel when the creator channel has those switched on. The
   * caller decides, because only it knows whether a companion was created.
   * @param known the room's row, when the caller already holds one. The create
   * path does: `secondaries.create` returns it, and on a conflict returns the
   * live one, which is exactly what the replay guard has to read. Passing it
   * keeps this off the join path's read budget.
   */
  async postForRoom(
    guildId: string,
    roomId: string,
    primaryChannelId: string,
    destinationChannelId: string,
    view: RoomPanelView,
    known?: PanelRoomRow,
  ): Promise<void> {
    let panel: ControlPanelMessage | null;
    try {
      /**
       * The replay guard, read BEFORE the post rather than written after it.
       *
       * `secondaries.create` is create-once, so anything that runs the create
       * path twice for one room - a redelivered voice event, a caught-up
       * reconcile, a direct call - would otherwise give that room a second
       * panel.
       */
      const row = known ?? (await this.deps.secondaries.get(roomId));
      if (!row || row.guildId !== guildId) return;
      if (typeof row.state.controlPanelMessageId === 'string') return;

      const guild = await this.deps.guilds.ensure(guildId);
      panel = buildControlPanel(roomId, readControlPanel(guild.settings), view);
      if (!panel) {
        /**
         * Switched off, wholly or button by button. Not a failure, so nothing
         * is recorded and nothing is counted - but any incident this server
         * already has IS cleared, because the notice tells the admin to turn
         * the buttons off with `/controlpanel` and a notice that survives being
         * obeyed is worse than no notice. Nothing else removes a `panel`
         * incident, and while one sits there `onResolved` cannot fire, which
         * pins the notifier's escalating backoff for every LATER problem.
         */
        this.deps.permissionProblems?.clear(guildId, primaryChannelId, ['panel']);
        return;
      }
    } catch (err) {
      /**
       * OUR failure, not the server's, so it is counted and logged and the
       * admin is told NOTHING. Everything above is a database read, and telling
       * somebody to grant Send Messages because Postgres blipped names the
       * wrong fix, which is how a notice stops being believed.
       */
      this.deps.count?.('failed', guildId);
      this.deps.logger.warn(
        { err, guildId, roomId },
        'could not read what the room control panel should say',
      );
      return;
    }

    let messageId;
    try {
      messageId = await this.deps.send(destinationChannelId, panel);
    } catch (err) {
      this.deps.count?.('failed', guildId);
      /**
       * Recorded against the CREATOR channel, not the room: the tracker keeps
       * ten incidents per guild and every room has a fresh snowflake, so
       * recording against the room would evict every real incident within ten
       * creates. It also keeps the `<#id>` mention pointing at something that
       * still exists once the room empties.
       */
      this.deps.permissionProblems?.record(guildId, {
        channelId: primaryChannelId,
        operation: 'panel',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(primaryChannelId, 'panel'));
      this.deps.logger.warn(
        { err, guildId, roomId, primaryChannelId, destinationChannelId },
        'could not post the room control panel',
      );
      return;
    }

    /**
     * Counted and cleared as soon as the message EXISTS, before the id is
     * recorded, because by here the server's side has plainly worked. A failure
     * below is ours.
     */
    this.deps.count?.('posted', guildId);
    this.deps.permissionProblems?.clear(guildId, primaryChannelId, ['panel']);

    try {
      await this.deps.secondaries.setControlPanelMessage(
        roomId,
        messageId,
        destinationChannelId,
        controlPanelFingerprint(panel),
      );
    } catch (err) {
      /**
       * The panel is posted and working; only the replay guard and the
       * fingerprint are missing, so a caught-up reconcile could post a second
       * one into this one room and the first edit will be issued needlessly.
       * Both are better than telling an admin their permissions are wrong when
       * the buttons are in the channel in front of them.
       */
      this.deps.logger.warn(
        { err, guildId, roomId, messageId },
        'posted the room control panel but could not record it',
      );
    }
  }

  /**
   * Brings a posted panel back into step with its room, if it has drifted.
   *
   * **The fingerprint is what makes this free to call.** It is re-derived from
   * the rendered payload every time and compared with the one stored beside the
   * message id, so a call that would change nothing costs one hash and no
   * requests at all. That is what lets the caller hang this off every
   * `rerenderSecondary`, including the bulk sweeps that walk a whole guild.
   *
   * A room with no panel is left alone. The panel is posted once, at create,
   * and this is deliberately not a second way to create one: a room whose post
   * failed has an incident recorded against its creator channel, and quietly
   * posting later would resolve nothing and surprise everybody.
   */
  async refreshForRoom(
    guildId: string,
    roomId: string,
    row: PanelRoomRow,
    view: RoomPanelView,
  ): Promise<void> {
    const { controlPanelMessageId: messageId, controlPanelChannelId: channelId } = row.state;
    if (!messageId || !channelId) return;

    let panel: ControlPanelMessage | null;
    let fingerprint: string;
    try {
      const guild = await this.deps.guilds.ensure(guildId);
      panel = buildControlPanel(roomId, readControlPanel(guild.settings), view);
      fingerprint = controlPanelFingerprint(panel);
      if (fingerprint === row.state.controlPanelHash) return;
    } catch (err) {
      /**
       * A database read, so OURS and transient. Nothing is forgotten here: a
       * Postgres blip during a sweep would otherwise clear the panel binding
       * for every room in the guild at once, leaving the messages posted,
       * frozen and unreachable forever, since nothing re-posts outside create.
       */
      this.deps.logger.warn(
        { err, guildId, roomId },
        'could not work out what the room control panel should say',
      );
      return;
    }

    try {
      /**
       * Switched off after the panel was posted. Edited down to a line saying
       * so, not deleted and not blanked: deleting somebody's scrollback is a
       * bigger act than the setting asked for, and Discord refuses an edit that
       * would leave a message with no content, no embeds and no components at
       * all. A line with no buttons is what "off" has to mean.
       */
      await this.deps.edit(
        channelId,
        messageId,
        panel ?? { content: PANEL_SWITCHED_OFF, embeds: [], components: [] },
      );
    } catch (err) {
      /**
       * The edit itself failed, which is almost always a message somebody
       * deleted (10008). Forgetting the id is the honest response: nothing can
       * edit a message that is gone, and retrying on every rerender for the
       * life of the room would be a request per render forever.
       *
       * Deliberately NOT reported to the admin even when it is a permission
       * error: this is the quietest possible failure, the room and every
       * command still work, and the alternative is a notice on a channel the
       * panel was posted into successfully once.
       */
      this.deps.logger.info(
        { err, guildId, roomId, messageId },
        'could not update the room control panel; forgetting it',
      );
      await this.deps.secondaries.clearControlPanelMessage(roomId).catch(() => undefined);
      return;
    }

    this.deps.count?.('updated', guildId);
    try {
      await this.deps.secondaries.setControlPanelMessage(roomId, messageId, channelId, fingerprint);
    } catch (err) {
      /**
       * The panel on screen is already correct; only the fingerprint is stale,
       * so the next render issues one needless but harmless identical edit.
       * Forgetting the binding here - which the single catch this replaced did
       * - would have been far worse: a correct, live panel that nothing could
       * ever update or switch off again.
       */
      this.deps.logger.warn(
        { err, guildId, roomId, messageId },
        'updated the room control panel but could not record it',
      );
      return;
    }
    this.deps.logger.debug({ guildId, roomId, messageId }, 'updated room control panel');
  }
}
