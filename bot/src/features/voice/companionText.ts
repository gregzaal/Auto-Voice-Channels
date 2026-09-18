import type {
  AutoChannelRepository,
  CompanionChannelRepository,
  CompanionChannelRow,
  GuildSettingsReader,
  Logger,
  SecondaryChannelRepository,
} from '@avc/core';
import type { VoiceActions } from './actions.js';
import type { GuildVoiceView } from './types.js';
import type { PermissionProblemTracker } from './permissionProblems.js';
import {
  DEFAULT_TEXT_CHANNEL_NAME,
  readTextChannelName,
  readTextChannelRole,
} from './guildSettings.js';
import { isGoneError, isPermissionError } from './discordAdapter.js';
import { permissionProblemMessage } from './permissionProblems.js';

export interface CompanionTextDeps {
  companions: CompanionChannelRepository;
  secondaries: SecondaryChannelRepository;
  autoChannels: AutoChannelRepository;
  guilds: GuildSettingsReader;
  actions: VoiceActions;
  voice: GuildVoiceView;
  logger: Logger;
  permissionProblems?: PermissionProblemTracker;
  serverLog?: (guildId: string, level: 1 | 2 | 3, message: string) => void;
  /** Counts a companion outcome for the metric store. */
  count?: (outcome: 'created' | 'deleted' | 'failed', guildId: string) => void;
}

/**
 * Per-room private text channels: the legacy "voice context" feature.
 *
 * A room whose creator channel opts in gets one text channel in the same
 * category, denied to `@everyone` and granted per member to whoever is in the
 * room right now, plus the guild's optional moderator role.
 *
 * **What this is honestly worth, because the copy must not overstate it:** on an
 * open room anyone who can join can join, be added, read the backlog and leave.
 * It buys non-discoverability and makes reading a visible act. It is not
 * confidentiality, and only `/private` restricts who can get in.
 *
 * Every method is a no-op when the guild has not opted in, and every one of them
 * is safe to run twice: the row and the channel converge on the live voice
 * roster, never on a delta.
 */
export class CompanionTextService {
  constructor(private readonly deps: CompanionTextDeps) {}

  /** Whether this room's creator channel asked for a companion. */
  private async optedIn(guildId: string, primaryChannelId: string): Promise<boolean> {
    const primary = await this.deps.autoChannels.get(primaryChannelId);
    return !!primary && primary.guildId === guildId && primary.template.textChannel === true;
  }

  /**
   * Deletes one orphaned companion and drops its row. Reports whether it went.
   *
   * The row is only dropped when the failure is PERMANENT, exactly as
   * `removeForRoom` does and for the same reason: the row is the only index
   * this feature has, so dropping it after a 500 or an exhausted rate limit
   * means nothing can ever find that channel again. Keeping it costs one retry
   * on the next sweep. A guild the bot has left answers 50001 or 10003, which
   * are permanent, so the case this sweep exists for still clears in one pass.
   */
  private async deleteOrphan(guildId: string, channelId: string): Promise<boolean> {
    try {
      await this.deps.actions.deleteCompanionChannel(guildId, channelId);
    } catch (err) {
      if (!isPermissionError(err) && !isGoneError(err)) {
        this.deps.logger.warn(
          { err, guildId, channelId },
          'could not delete an orphaned companion; keeping the row to retry',
        );
        return false;
      }
      this.deps.logger.info(
        { err, guildId, channelId },
        'cannot delete an orphaned companion; dropping its row',
      );
    }
    await this.deps.companions.remove(channelId);
    this.deps.count?.('deleted', guildId);
    return true;
  }

  /** The non-bot members currently in a room: the desired viewer set. */
  private occupants(channelId: string): string[] {
    return this.deps.voice
      .membersInChannel(channelId)
      .filter((m) => !m.bot)
      .map((m) => m.id);
  }

  /**
   * Creates the companion for a freshly-made room, if its creator channel opted
   * in and one does not already exist.
   *
   * `initialMemberIds` is passed explicitly because the creating member's move
   * into the room has not reached the voice cache yet, the same reason the create
   * path seeds `roster` by id rather than reading the roster back.
   *
   * **Never throws.** A room with no chat is a working room, and there is no
   * outer try/catch on the create path to fall back on: the only rollbacks there
   * are scoped to the privacy and move calls and re-throw anything that is not a
   * permission error, so an escape from here would strand a room that has already
   * been created and moved into.
   */
  async createForRoom(
    guildId: string,
    roomId: string,
    primaryChannelId: string,
    initialMemberIds: readonly string[],
    opts: { optedIn?: boolean } = {},
  ): Promise<string | null> {
    try {
      // The reconciler has already asked, and asks for every room it walks.
      if (!opts.optedIn && !(await this.optedIn(guildId, primaryChannelId))) return null;
      const existing = await this.deps.companions.getBySecondary(roomId);
      if (existing) return existing.channelId;

      const guild = await this.deps.guilds.ensure(guildId);
      const roleId = readTextChannelRole(guild.settings);
      const channelId = await this.deps.actions.createCompanionChannel({
        guildId,
        name: readTextChannelName(guild.settings) ?? DEFAULT_TEXT_CHANNEL_NAME,
        secondaryChannelId: roomId,
        memberIds: initialMemberIds,
        roleId,
      });
      /**
       * From here the channel EXISTS on Discord and nothing knows about it.
       *
       * Every path out of this block has to either persist the id or delete the
       * channel, because the row is the only index the sweep has: a connection
       * blip on the insert would otherwise leak it permanently. That covers the
       * unique-conflict case (another pass got there first) and the throw case
       * alike, which is why the catch is here rather than only around the
       * conflict.
       */
      let row;
      try {
        row = await this.deps.companions.create({
          channelId,
          guildId,
          secondaryChannelId: roomId,
          // Written inline in the create payload above, so it is granted already.
          viewerRoleId: roleId,
        });
      } catch (err) {
        await this.deps.actions.deleteCompanionChannel(guildId, channelId).catch(() => undefined);
        throw err;
      }
      if (!row) {
        // Another pass recorded one for this room between our check and our
        // insert. Delete the duplicate while we still hold its id.
        await this.deps.actions.deleteCompanionChannel(guildId, channelId).catch(() => undefined);
        const existing = await this.deps.companions.getBySecondary(roomId);
        this.deps.logger.info(
          { guildId, roomId, discarded: channelId, kept: existing?.channelId },
          'another pass had already made this room a text channel; discarded the duplicate',
        );
        return existing?.channelId ?? null;
      }
      this.deps.count?.('created', guildId);
      this.deps.logger.debug({ guildId, roomId, channelId }, 'created companion text channel');
      return channelId;
    } catch (err) {
      this.deps.count?.('failed', guildId);
      /**
       * EVERY failure is reported to the guild, not only a permission one.
       *
       * The likeliest real failure of this feature is not a missing permission:
       * it is Discord's 50-channel category cap, which an opted-in creator
       * channel roughly halves its way into, and which returns `30013` rather
       * than a 403. Reporting only `isPermissionError` left that case with a
       * log line and nothing an admin could ever see, which is the one outcome
       * a feature that silently stops working must not have. The message names
       * what to check and says the rooms themselves are fine, which is true
       * whichever of the two it was.
       *
       * Recorded against the CREATOR channel, not the room: the advice names
       * what to grant where rooms are made, and `companion` has its own
       * `PermissionOperation` because the generic "I have lost access" text
       * names the wrong four permissions for this failure.
       */
      this.deps.permissionProblems?.record(guildId, {
        channelId: primaryChannelId,
        operation: 'companion',
        at: Date.now(),
      });
      this.deps.serverLog?.(guildId, 1, permissionProblemMessage(primaryChannelId, 'companion'));
      this.deps.logger.warn(
        { err, guildId, roomId, primaryChannelId },
        'could not create companion text channel',
      );
      return null;
    }
  }

  /**
   * Converges an existing companion's viewers on who is in the room now.
   *
   * Derived from the LIVE roster rather than from `state.roster`, which is
   * maintained only by the event paths and therefore still lists a departed
   * member after exactly the missed event this exists to repair.
   *
   * Never throws, for the same reason as the create: this hangs off a voice
   * event that has already done its real work.
   */
  async syncRoom(guildId: string, roomId: string, known?: CompanionChannelRow): Promise<void> {
    try {
      // The reconciler already holds the row; the voice paths do not.
      const row = known ?? (await this.deps.companions.getBySecondary(roomId));
      if (!row) return;
      const guild = await this.deps.guilds.ensure(guildId);
      const configuredRole = readTextChannelRole(guild.settings);
      const result = await this.deps.actions.syncCompanionMembers({
        guildId,
        channelId: row.channelId,
        memberIds: this.occupants(roomId),
        roleId: configuredRole,
        previousRoleId: row.viewerRoleId,
      });
      /**
       * Record what is granted NOW, so the next pass can revoke exactly it.
       *
       * Only when it changed, because this runs on every voice event in an
       * opted-in room and a blind write would be one update per join and leave.
       */
      const granted = result.grantedRoleId ?? null;
      if (!result.channelGone && granted !== row.viewerRoleId) {
        await this.deps.companions.setViewerRole(row.channelId, granted);
      }
      if (result.channelGone) {
        // A human deleted it. Drop the row rather than retrying forever; the
        // next reconcile makes a new one if the room is still opted in.
        await this.deps.companions.remove(row.channelId);
        this.deps.logger.info(
          { guildId, roomId, channelId: row.channelId },
          'companion text channel is gone; dropped its row',
        );
      }
    } catch (err) {
      this.deps.logger.warn({ err, guildId, roomId }, 'could not sync companion text channel');
    }
  }

  /**
   * Deletes a room's companion, if it has one. Called from the same hook every
   * other per-room cleanup hangs off, so it fires at every row-removal site.
   *
   * Deliberately NOT gated by the runtime lever: a lever that stopped deleting
   * would leave a row outliving its channel permanently, which is the same
   * reason `channelDelete` is ungated.
   */
  async removeForRoom(guildId: string, roomId: string): Promise<void> {
    try {
      const row = await this.deps.companions.getBySecondary(roomId);
      if (!row) return;
      await this.deps.actions.deleteCompanionChannel(guildId, row.channelId);
      await this.deps.companions.removeBySecondary(roomId);
      this.deps.count?.('deleted', guildId);
      this.deps.logger.debug(
        { guildId, roomId, channelId: row.channelId },
        'deleted companion text channel',
      );
    } catch (err) {
      /**
       * The row is dropped only when the failure is PERMANENT.
       *
       * A 403 means we have lost access and will never delete it, so keeping
       * the row would retry the impossible forever. Anything else - a 500, an
       * exhausted rate limit, a dropped socket - is transient, and dropping the
       * row there is unrecoverable rather than merely untidy: the row is the
       * only index this feature has, so the sweep can never see that channel
       * again and `/diagnostics` will never count it. Keeping it costs one
       * retry per sweep and is how the orphan gets reclaimed.
       */
      const permanent = isPermissionError(err) || isGoneError(err);
      if (permanent) await this.deps.companions.removeBySecondary(roomId).catch(() => undefined);
      this.deps.logger.warn(
        { err, guildId, roomId, permanent },
        permanent
          ? 'cannot delete companion text channel; dropped its row'
          : 'could not delete companion text channel; keeping the row to retry',
      );
    }
  }

  /**
   * A room's companion and who else can read it, for `/channelinfo`.
   *
   * Reads the role from settings rather than from the channel's overwrites, so
   * it reports what the guild CONFIGURED. The two agree once the next sync has
   * run, and disagreeing in favour of the configuration is the safer direction:
   * it discloses access that is about to exist rather than hiding it.
   */
  async describeRoom(
    guildId: string,
    roomId: string,
  ): Promise<{ channelId: string; roleId: string | null } | null> {
    try {
      const row = await this.deps.companions.getBySecondary(roomId);
      if (!row) return null;
      const guild = await this.deps.guilds.ensure(guildId);
      const roleId = readTextChannelRole(guild.settings);
      // `@everyone` can never be a viewer (the three write guards refuse it),
      // so reporting it would disclose access that does not exist.
      return { channelId: row.channelId, roleId: roleId === guildId ? null : roleId };
    } catch (err) {
      // `/channelinfo` is a read-only diagnostic. A failed lookup must cost the
      // companion LINE, never the panel, and never the caller's task.
      this.deps.logger.warn({ err, guildId, roomId }, 'could not describe the companion channel');
      return null;
    }
  }

  /**
   * Handles a `channelDelete` for a channel that may be a companion. Returns
   * whether it was one.
   */
  async handleChannelDeleted(guildId: string, channelId: string): Promise<boolean> {
    try {
      const row = await this.deps.companions.get(channelId);
      if (!row || row.guildId !== guildId) return false;
      await this.deps.companions.remove(channelId);
      this.deps.logger.info(
        { guildId, channelId, roomId: row.secondaryChannelId },
        'companion text channel deleted on Discord; dropped its row',
      );
      return true;
    } catch (err) {
      /**
       * Never throws, and the reason is the call site rather than this method.
       *
       * It runs between the room branch and the adopted-channel branch of
       * `handleChannelDeleted`, so a throw here would skip the adopted and
       * creator-channel cleanup below it AND count a failure against this
       * guild's circuit breaker, for a table the guild may not even use.
       * Returning false costs one stale row, which the orphan sweep reclaims.
       */
      this.deps.logger.warn({ err, guildId, channelId }, 'could not check for a companion row');
      return false;
    }
  }

  /**
   * Per-guild convergence, called from the reconcile sweep: creates what is
   * missing, syncs what exists, and removes what belongs to a room that is gone.
   *
   * `allowCreate` decides whether the missing half runs. It is passed in rather
   * than read here because the caller holds the gate and because a repair must
   * not spend a slot of the per-guild creation throttle.
   */
  async reconcileGuild(
    guildId: string,
    opts: { allowCreate: boolean; dryRun?: boolean } = { allowCreate: true },
  ): Promise<{ created: number; synced: number; removed: number }> {
    let created = 0;
    let synced = 0;
    let removed = 0;

    const rooms = await this.deps.secondaries.listByGuild(guildId);
    const roomIds = new Set(rooms.map((r) => r.channelId));
    /**
     * One query for the whole guild instead of one per room.
     *
     * The orphan pass below needs this list anyway, so reading it up front
     * turns an N+1 into a single read on a sweep that runs every five minutes
     * for every guild with rooms.
     */
    const rows = await this.deps.companions.listForGuild(guildId);
    const byRoom = new Map(rows.map((r) => [r.secondaryChannelId, r]));

    for (const room of rooms) {
      const row = byRoom.get(room.channelId);
      if (row) {
        if (!opts.dryRun) await this.syncRoom(guildId, room.channelId, row);
        synced += 1;
        continue;
      }
      if (!opts.allowCreate) continue;
      if (!(await this.optedIn(guildId, room.primaryChannelId))) continue;
      if (opts.dryRun) {
        created += 1;
        continue;
      }
      const madeId = await this.createForRoom(
        guildId,
        room.channelId,
        room.primaryChannelId,
        this.occupants(room.channelId),
        { optedIn: true },
      );
      if (madeId) created += 1;
    }

    // Companions whose room row is gone, within this guild. The fleet-wide
    // version of this is `sweepOrphans`, which reaches guilds this one cannot.
    for (const row of rows) {
      if (roomIds.has(row.secondaryChannelId)) continue;
      if (opts.dryRun) {
        removed += 1;
        continue;
      }
      if (await this.deleteOrphan(row.guildId, row.channelId)) removed += 1;
    }

    return { created, synced, removed };
  }

  /**
   * Fleet-wide orphan sweep: companions whose room row no longer exists.
   *
   * **Guild-agnostic on purpose.** Every other sweep here draws its guilds from
   * the channel tables and then filters by shard ownership, and `reconcileGuild`
   * bails on a guild the gateway has not hydrated. Both skip precisely the case
   * that leaks: a guild this bot has been removed from, whose rows are then
   * unreachable by any per-guild pass. The predicate is a single SQL existence
   * check, so it needs no cache, no hydration and no lease.
   *
   * The Discord delete is best-effort and the row is removed either way. A guild
   * we have left is one whose channel we cannot touch, and keeping the row would
   * mean retrying that forever.
   */
  async sweepOrphans(limit = 100): Promise<{ removed: number }> {
    let removed = 0;
    for (const row of await this.deps.companions.listOrphans(limit)) {
      if (await this.deleteOrphan(row.guildId, row.channelId)) removed += 1;
    }
    if (removed > 0) this.deps.logger.info({ removed }, 'swept orphaned companion text channels');
    return { removed };
  }
}
