/**
 * What `/hide`, `/unhide`, `/access` and the lock and open commands say about who
 * can see and join a room, kept out of the service so every reply is worded once
 * and one render-time test covers all of them.
 *
 * **What hidden means, and the one claim this file never makes.** A hidden room is
 * hidden from the channel list. What a person's profile or the friend activity
 * feed shows someone who is not in the room about a member inside it has not been
 * checked, so no reply here says more than the channel list.
 *
 * Role mentions (`<@&id>`) are for the reader of an ephemeral reply, and the
 * caller sends it with mentions suppressed so nothing here can ping.
 */

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Role ids as mentions, in a sentence. */
export function roleMentions(roleIds: readonly string[]): string {
  return listOf(roleIds.map((id) => `<@&${id}>`));
}

const plural = (ids: readonly string[], one: string, many: string): string =>
  ids.length === 1 ? one : many;

/** Said after a change that could not touch some role, whatever the change was. */
export function skippedRolesNote(roleIds: readonly string[]): string {
  if (roleIds.length === 0) return '';
  return (
    ` I could not change ${roleMentions(roleIds)} because ${plural(roleIds, 'it sits', 'they sit')} ` +
    `above my role, so ${plural(roleIds, 'it is', 'they are')} left as ${plural(roleIds, 'it was', 'they were')}. ` +
    `Move my role above ${plural(roleIds, 'it', 'them')} and run this again to fix that.`
  );
}

export const ROOM_ACCESS_REPLIES = {
  noChannel: "You need to be in one of this server's voice channels.",
  notManaged: "This isn't a bot-managed voice channel.",
  ownerless: 'This room has no owner right now. Use `/reclaim` to take it, then try again.',
  notOwnerPrivate: 'Only the channel owner can make it private.',
  notOwnerPublic: 'Only the channel owner can make it public.',
  notOwnerHide: 'Only the room owner can hide it.',
  notOwnerUnhide: 'Only the room owner can show it in the channel list again.',
  notOwnerAdmit: 'Only the room owner can let someone in.',
  unreadable:
    "I can't read this room's access settings, so I have left the room exactly as it is. A newer version of AVC probably wrote them. Try again in a few minutes.",
  notReady: "I'm not ready to change this room yet. Try again in a moment.",
  gone: 'That room no longer exists.',
  alreadyPrivate: 'This channel is already private.',
  alreadyPublic: 'This channel is already public.',
  alreadyHidden: 'This room is already hidden.',
  notHidden: "This room isn't hidden.",
  privateOnHidden:
    'This room is hidden. Use `/unhide` to show it in the channel list again and keep it locked, or `/public` to open it to everyone.',
  locked: '🔒 Your channel is now private. Others can ask to join via the **⇩ Join** channel.',
  public: '🔓 Your channel is now public.',
  openToEveryone:
    'It is open to everyone, so there is no need to let anyone in. Lock or hide the room first if you want a guest list.',
  admitSelf: 'You already have access to your own room.',
  admitBot: 'I always have access to this room.',
  deferred:
    "Discord is slowing down changes to this room, so I've queued this one. It hasn't taken effect yet and should within a minute or so.",
} as const;

/** What a refused hide says: which roles still show the room, and how to fix that. */
export function roleDefeatsHide(roleIds: readonly string[]): string {
  return (
    `I can't hide this room because ${roleMentions(roleIds)} would still show it. ` +
    `${plural(roleIds, 'That role sits', 'Those roles sit')} above mine, so I can't change what ` +
    `${plural(roleIds, 'it', 'they')} can see here. Move my role above ` +
    `${plural(roleIds, 'it', 'them')} in the server's role settings, then try again.`
  );
}

export const TOO_MANY_OVERWRITES =
  "This room has too many permission overrides for me to change who can see it. Remove some in the room's permission settings and try again.";

/** An unexpected failure, with the reason Discord or the code gave. */
export function accessFailed(reason: string): string {
  return `I couldn't change who can see or join this room: ${reason}.`;
}

/**
 * Said when a room is hidden.
 *
 * Says what hidden means (the channel list), who always sees it, and how to let
 * someone in. `viewerRoleId` is the moderator role the plan actually granted, not
 * the one the server has set: a role that no longer exists, or that the bot cannot
 * edit, is not one that can see the room, and saying it was would be false.
 */
export function hiddenMessage(opts: {
  viewerRoleId: string | null;
  skippedRoleIds?: readonly string[];
}): string {
  const who = opts.viewerRoleId
    ? `Administrators always see everything, and so do members with <@&${opts.viewerRoleId}>.`
    : 'Administrators always see everything, and nobody else sees it unless you let them in.';
  return (
    '🙈 Your room is now hidden from the channel list. ' +
    `${who} Let people in with \`/access trust\` or \`/access admit\`.` +
    skippedRolesNote(opts.skippedRoleIds ?? [])
  );
}

export function unhiddenMessage(skippedRoleIds: readonly string[] = []): string {
  return (
    '👁 Your room shows in the channel list again and is still locked. ' +
    'Others can ask to join via the **⇩ Join** channel.' +
    skippedRolesNote(skippedRoleIds)
  );
}

/** A lock or an open that did not touch some role. */
export function withSkipped(message: string, skippedRoleIds: readonly string[]): string {
  return message + skippedRolesNote(skippedRoleIds);
}

/** Locked, but the Join channel could not be made. */
export function lockedWithoutJoin(reason: string): string {
  return `🔒 Your room is locked, but I couldn't create its **⇩ Join** channel (${reason}). Run \`/public\` and then \`/private\` to try again.`;
}

/** Shown again, but the Join channel could not be made. */
export function unhiddenWithoutJoin(reason: string): string {
  return `👁 Your room shows in the channel list again and is still locked, but I couldn't create its **⇩ Join** channel (${reason}). Run \`/public\` and then \`/private\` to try again.`;
}

export function admitBlocked(memberId: string): string {
  return `<@${memberId}> is on your blocked list, so I did not let them in. Take them off it first if you want them in.`;
}

export function admitKicked(memberId: string): string {
  return `<@${memberId}> was voted out of this room, so I did not let them in.`;
}

export function admitted(memberId: string, mode: 'locked' | 'hidden'): string {
  return mode === 'hidden'
    ? `Let <@${memberId}> into this room. They can see it and join it until the room is deleted.`
    : `Let <@${memberId}> into this room. They can join it until the room is deleted.`;
}

export function admitFailed(memberId: string, reason: string): string {
  return `I couldn't let <@${memberId}> in: ${reason}.`;
}
