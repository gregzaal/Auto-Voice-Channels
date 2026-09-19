import type { Logger, SecondaryChannelRepository } from '@avc/core';
import type { APIEmbed, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { buildControlPanel } from './controlPanel.js';
import { readControlPanel } from './guildSettings.js';
import { permissionProblemMessage, type PermissionProblemTracker } from './permissionProblems.js';

/** Just enough of the guild settings store to read one guild's blob. */
interface GuildSettingsReader {
  ensure(guildId: string): Promise<{ settings: Record<string, unknown> }>;
}

/** What the poster needs from Discord, as one function so it fakes in one line. */
export type PanelSender = (
  channelId: string,
  payload: { embeds: APIEmbed[]; components: ActionRowBuilder<ButtonBuilder>[] },
) => Promise<string>;

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
  guilds: GuildSettingsReader;
  secondaries: SecondaryChannelRepository;
  logger: Logger;
  /** Surfaces a failed post to the server's admins, like every other one. */
  permissionProblems?: PermissionProblemTracker;
  serverLog?: (guildId: string, level: 1 | 2 | 3, message: string) => void;
  count?: (outcome: 'posted' | 'failed', guildId: string) => void;
}

/**
 * Posts the room control panel into a new room's chat.
 *
 * **Never throws, and never fails a room create.** By the time this runs the
 * room exists and the member is in it, so the only thing a throw could
 * accomplish is turning a working room into a failed task that counts against
 * the guild's circuit breaker. A room with no panel is a working room, and the
 * commands the buttons stand in for all still work.
 *
 * **A failed post is the ordinary case for a large part of the install base,
 * not an edge case.** The bot grants itself View Channel, Connect, Manage
 * Channels and Move Members on the rooms it creates, and nothing more, so a
 * category that denies Send Messages produces a perfect room whose chat the
 * bot cannot write in. That is recorded against the creator channel through
 * `PermissionProblemTracker` like every other permission failure, so an admin
 * sees it in `/setup` instead of wondering where the buttons went. It must not
 * be fixed by widening what a created room grants the bot: that same bitmask
 * repairs inherited overwrites, and widening it changes every room.
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
   * keeps this off the join path's read budget. Same shape and same reason as
   * `CompanionTextService.syncRoom`'s `known`.
   */
  async postForRoom(
    guildId: string,
    roomId: string,
    primaryChannelId: string,
    destinationChannelId: string,
    known?: { guildId: string; state: { controlPanelMessageId?: string | undefined } },
  ): Promise<void> {
    let panel;
    try {
      /**
       * The replay guard, read BEFORE the post rather than written after it.
       *
       * `secondaries.create` is create-once, so anything that runs the create
       * path twice for one room - a redelivered voice event, a caught-up
       * reconcile, a direct call - would otherwise give that room a second
       * panel. Defence rather than a path anyone has walked: today's create
       * path re-checks the member is still in the creator channel before it
       * gets here, so the guard is cheap insurance, which is why it must also
       * be cheap.
       */
      const row = known ?? (await this.deps.secondaries.get(roomId));
      if (!row || row.guildId !== guildId) return;
      if (typeof row.state.controlPanelMessageId === 'string') return;

      const guild = await this.deps.guilds.ensure(guildId);
      panel = buildControlPanel(roomId, readControlPanel(guild.settings));
      if (!panel) {
        /**
         * Switched off, wholly or button by button. Not a failure, so nothing
         * is recorded and nothing is counted - but any incident this server
         * already has IS cleared, because the notice tells the admin to turn
         * the buttons off with `/controlpanel` and a notice that survives
         * being obeyed is worse than no notice. Nothing else ever removes a
         * `panel` incident, and while one sits there `onResolved` cannot fire,
         * which pins the notifier's escalating backoff at whatever rung it had
         * climbed to for every LATER problem in that guild.
         */
        this.deps.permissionProblems?.clear(guildId, primaryChannelId, ['panel']);
        return;
      }
    } catch (err) {
      /**
       * OUR failure, not the server's, so it is counted and logged and the
       * admin is told NOTHING.
       *
       * Everything above this line is a database read. Telling an admin to
       * grant Send Messages because Postgres blipped sends them to check a
       * permission they already hold, and advice that names the wrong fix is
       * worse than no advice: it is how a panel stops being believed.
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
       * Recorded against the CREATOR channel, not the room, for the reason
       * `companionText` records there: the tracker keeps ten incidents per
       * guild and every room has a fresh snowflake, so recording against the
       * room would evict every real incident within ten creates. It also keeps
       * the `<#id>` mention pointing at something that still exists once the
       * room empties.
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
     * recorded, because by here the server's side has plainly worked. A
     * failure below is ours.
     *
     * The clear is what lets a guild stop being told: nothing else ever
     * removes a `panel` incident, so without it one bad afternoon would leave
     * `/setup` reporting a problem forever and `onResolved` would never fire,
     * pinning the notifier's escalating backoff at whatever rung it had
     * climbed to. Narrowed to `panel` for the reason the create path's clear is
     * narrowed: a success speaks only for itself.
     */
    this.deps.count?.('posted', guildId);
    this.deps.permissionProblems?.clear(guildId, primaryChannelId, ['panel']);

    try {
      await this.deps.secondaries.setControlPanelMessage(roomId, messageId, destinationChannelId);
    } catch (err) {
      /**
       * The panel is posted and working; only the replay guard is missing, so
       * a caught-up reconcile could post a second one into this one room. That
       * is a far better outcome than telling an admin their permissions are
       * wrong when the buttons are sitting in the channel in front of them.
       */
      this.deps.logger.warn(
        { err, guildId, roomId, messageId },
        'posted the room control panel but could not record it',
      );
      return;
    }
    this.deps.logger.debug(
      { guildId, roomId, destinationChannelId, messageId },
      'posted room control panel',
    );
  }
}
