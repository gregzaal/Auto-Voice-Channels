import type {
  Logger,
  MemberPrefPrivacy,
  MemberRoomPrefsRepository,
  SecondaryChannelRow,
} from '@avc/core';

/**
 * Saving what a member chose for their room, so the next room they make from the same creator
 * channel can start the same way (`rememberedStart.ts` is the other direction).
 *
 * It lives apart from the commands that call it because three services save (`/limit` and
 * `/name` in `VoiceCommands`, and the four privacy changes in `PrivacyService`), and the rules
 * below have to be the same wherever it is called from.
 */

/** The longest name the room panel's Name box prefills and accepts, which is Discord's own cap. */
export const PANEL_NAME_MAX = 100;

/**
 * Whether a submitted name is only the panel's prefill of a longer name the room already has.
 *
 * The panel's Name box shows the first {@link PANEL_NAME_MAX} characters of the room's template
 * and stops there, while `/name` accepts a template ten times as long. A member who opens the box
 * on a long template and presses Save without touching it submits the cut version, and saving
 * that would overwrite the whole template they wrote with its beginning. The room's own template
 * is cut by that submit whatever happens here, as it always was, but what they REMEMBER must not
 * be, so this is the one submit that is not remembered.
 *
 * Compared as the room would store it: the box's value is trimmed and has its line breaks
 * flattened by the time it arrives, so the prefill is cut and trimmed the same way.
 */
export function isTruncatedPrefill(submitted: string, existing: unknown): boolean {
  if (typeof existing !== 'string' || existing.length <= PANEL_NAME_MAX) return false;
  return submitted === existing.slice(0, PANEL_NAME_MAX).trim();
}

/** What a member's own choice can be remembered as. `null` takes the remembered value back out. */
export type RememberedSetting =
  | { field: 'name'; value: string | null }
  | { field: 'limit'; value: number | null }
  | { field: 'privacy'; value: MemberPrefPrivacy | null };

/**
 * What saving needs. Each service hands over only the writes it makes, so a construction that
 * predates remembering, and every test that builds one, keeps working: absent means off.
 */
export interface RememberedSaveDeps {
  memberPrefs?:
    | Partial<Pick<MemberRoomPrefsRepository, 'saveName' | 'saveLimit' | 'savePrivacy'>>
    | undefined;
  /**
   * Whether `member_prefs.disabled` is on, through the creation gate's cached snapshot (never an
   * uncached flag read: a save follows every `/name`, `/limit` and `/private` in every server).
   * Absent means not disabled, and a read that throws counts as not disabled.
   */
  memberPrefsDisabled?: (() => Promise<boolean>) | undefined;
  logger: Logger;
}

/** A thrown value as log fields: what failed, never what the database echoed of the statement. */
function failureFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { errorName: typeof err };
  const code = (err as { code?: unknown }).code;
  return {
    errorName: err.name,
    ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
    errorMessage: err.message,
  };
}

/**
 * Remembers (or forgets) one setting for the member who owns a room, for the creator channel it
 * came from. Resolves once it is done and **never throws**.
 *
 * **Who it saves for is the room's OWNER, by equality.** Not "somebody who passed the owner
 * check": `/name` lets any moderator rename any room, so a moderator renaming somebody else's
 * room would otherwise save that name as their own, and a room with no owner passes every owner
 * check, so anyone present would save against themselves. A moderator renaming their OWN room
 * is its owner and does save.
 *
 * **It is called only after the command it follows has succeeded**, and a failure here is
 * logged and nothing else. The member's room is already as they asked, so a save that failed
 * costs them next time's convenience and must not turn their command into an error, count
 * against the guild's circuit breaker or throw out of a task in its queue. What is logged is
 * ids and the error, never the name they typed.
 *
 * **The lever stops what is STORED, and never what is taken back out.** A value is saved only
 * while `member_prefs.disabled` is off, and a `null` always goes through: a member resetting
 * their name or going public must be able to, and refusing it would leave a value they cleared
 * waiting to come back the day the lever is lifted. The creator channel's opt-in is not read
 * here: the repository's one statement checks it, so this adds no read of `auto_channels`.
 */
export async function rememberSetting(
  deps: RememberedSaveDeps,
  room: Pick<SecondaryChannelRow, 'guildId' | 'channelId' | 'primaryChannelId' | 'ownerId'>,
  userId: string,
  setting: RememberedSetting,
): Promise<void> {
  const prefs = deps.memberPrefs;
  if (!prefs || room.ownerId === null || room.ownerId !== userId) return;
  try {
    if (setting.value !== null && (await paused(deps))) return;
    const { guildId, primaryChannelId } = room;
    const result =
      setting.field === 'name'
        ? await prefs.saveName?.(guildId, primaryChannelId, userId, setting.value)
        : setting.field === 'limit'
          ? await prefs.saveLimit?.(guildId, primaryChannelId, userId, setting.value)
          : await prefs.savePrivacy?.(guildId, primaryChannelId, userId, setting.value);
    // Neither is a fault in the member's command, and both are worth knowing about in the logs:
    // the repository refuses what a later restore could not apply.
    if (result?.status === 'invalid' || result?.status === 'tooLong') {
      deps.logger.info(
        { guildId, channelId: room.channelId, userId, field: setting.field, status: result.status },
        'did not remember a room setting',
      );
    }
  } catch (err) {
    deps.logger.warn(
      {
        guildId: room.guildId,
        channelId: room.channelId,
        userId,
        field: setting.field,
        ...failureFields(err),
      },
      'could not remember a room setting',
    );
  }
}

/** Whether the lever is on. Fails open, whatever the accessor does. */
async function paused(deps: RememberedSaveDeps): Promise<boolean> {
  try {
    return (await deps.memberPrefsDisabled?.()) === true;
  } catch {
    return false;
  }
}
