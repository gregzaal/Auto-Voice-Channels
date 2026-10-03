import type { ControlPanelAction } from './controlPanel.js';
import { isSnowflake, SETTINGS_KEYS } from './guildSettings.js';

/**
 * Who may not use which room command: the policy half, with no I/O and no
 * Discord in it, so every edge unit-tests with plain objects.
 *
 * **Deny rules, not allow lists.** An admin names the users and roles that may
 * NOT use a feature, and everyone else keeps it. A feature nobody has said
 * anything about is open, which is what makes a new feature safe to ship: it
 * starts open, and no server has to be told about it before it works. Only a
 * departure is ever stored, so absent means nobody is denied.
 *
 * **Every failure direction is fail open**, on purpose. A role that was deleted
 * stops matching anybody, a rule this build cannot read is ignored, and the
 * `@everyone` role (whose id is the guild id) is refused at the writer and the
 * importer and dropped again by the reader, so even a value put in the database
 * by hand cannot match every member. The alternative failure, a rule that locks
 * the people it was never meant to, is the one an admin cannot diagnose from
 * inside Discord.
 *
 * **Members who can manage channels are never restricted.** Manage Channels or
 * Administrator already lets them rename any room, so a rule could not stop
 * them and would only mislead the admin who wrote it, and it means an admin can
 * never lock themselves out.
 *
 * **Undo directions are never restricted.** Opening a room again, removing a
 * limit (`/unlimit`, or a limit of 0), removing a saved nickname and (later)
 * showing a room or removing a saved member must always work:
 * a creator channel whose rooms start private has to leave its owner a way to
 * open one, and saved data is something a member must be able to erase.
 */

/**
 * The features a rule can name, as stored.
 *
 * Append only, and never rename: the stored map is keyed by these strings, so a
 * renamed id silently un-restricts everybody an admin named under the old one.
 *
 * Claim, Kick and Info are not features. They are occupant-level, so a
 * restriction on one could not be hidden from the people it does not apply to
 * and would only ever refuse. They stay switch-it-off-for-everyone in
 * `/controlpanel`.
 */
export const COMMAND_FEATURES = [
  'privacy',
  'hide',
  'limit',
  'rename',
  'transfer',
  'access',
  'nick',
] as const;

export type CommandFeature = (typeof COMMAND_FEATURES)[number];

/**
 * Whether the guard reads the restrictions, which decides whether `/restrict` is
 * registered. True: every command and panel path in `interactions.ts` checks the
 * map, and the room panel hides what a restricted owner cannot use.
 *
 * A constant and not a flag, because it describes the CODE and not the runtime.
 * `/restrict` tells an admin a member "can no longer use" something, so it must
 * never be listed by a build in which nothing enforces that, and it stays false
 * for any build that removes the guard. Stopping enforcement while the build
 * still has it is `command_access.disabled`, which `/restrict list` reports.
 */
export const RESTRICT_ENFORCED = true;

/**
 * The features `/restrict` offers today, in the order it lists them.
 *
 * A feature is offered only by a build whose commands enforce it, or an admin could
 * restrict nothing and be told they had: add one here in the commit that ships its
 * command. Every feature has a command now, and the order follows the stored ids.
 */
export const AVAILABLE_FEATURES = [
  'privacy',
  'hide',
  'limit',
  'rename',
  'transfer',
  'access',
  'nick',
] as const satisfies readonly CommandFeature[];

export type AvailableFeature = (typeof AVAILABLE_FEATURES)[number];

/** True only for a string `/restrict` offers, which is client input when it arrives. */
export function isAvailableFeature(value: unknown): value is AvailableFeature {
  return typeof value === 'string' && (AVAILABLE_FEATURES as readonly string[]).includes(value);
}

/**
 * How each feature reads in customer copy. The first five match the words on the
 * room panel's buttons, so an admin is looking at the word members see.
 */
export const FEATURE_LABELS: Record<CommandFeature, string> = {
  privacy: 'Private and Public',
  hide: 'Hide',
  limit: 'Size',
  rename: 'Name',
  transfer: 'Transfer',
  access: 'Saved lists',
  nick: 'Nickname',
};

/**
 * What a restriction covers, as a clause that finishes "That covers ...".
 *
 * A feature is more than one door, and the reply has to say which, because an
 * admin who restricts Name and then finds the template editor still open will
 * reasonably call it a bug. Name covers the `/template` editor for a room the
 * member owns and the voice status because all three share one write path.
 * Where a feature has an undo direction the clause says that stays open.
 */
export const FEATURE_COVERS: Record<CommandFeature, string> = {
  privacy:
    'the /private command and the Private button. Opening a room again stays open to everyone',
  hide: 'the /hide command and the Hide button. Showing a room again stays open to everyone',
  limit:
    'the /limit command and the Size button. The /unlimit command and /limit 0 stay open to everyone',
  rename:
    'the /name command, the Name button, the template editor for their own room and the voice status',
  transfer: 'the /transfer command and the Transfer button',
  access:
    'the /access trust, block and admit commands and the Always allow button on a join request. Removing, clearing and listing stay open to everyone',
  nick: 'the /nick command, and a saved nickname showing in a room name. Removing a nickname stays open to everyone, and a room name that already shows one changes the next time the room refreshes its name',
};

/**
 * Slash command to feature, for the commands a rule can stop.
 *
 * Absent means the command is never restricted: `public`, `unhide` and `unlimit` are
 * undo directions, `reclaim` and `kick` are occupant-level, and the admin commands
 * are governed by Discord permissions and not by this map. A lookup is by
 * `featureForCommand`, which is an own-property test, because the name is client
 * input and `constructor` is a property of every object.
 *
 * `access` is here because `/access` is the command Saved lists restricts, but a rule
 * stops only three of its six subcommands, so the command name alone is NOT enough:
 * the guard asks {@link accessFeatureFor} with the subcommand instead.
 */
export const COMMAND_FEATURE: Readonly<Record<string, CommandFeature>> = {
  private: 'privacy',
  hide: 'hide',
  limit: 'limit',
  name: 'rename',
  transfer: 'transfer',
  access: 'access',
  nick: 'nick',
};

/**
 * The `/access` subcommands a Saved lists rule stops: the ones that put somebody on a
 * list or let them in. `remove`, `clear` and `list` are never restricted, because they
 * are how a member erases or checks what they saved, and a member who is denied the
 * feature must still be able to empty a list they filled before the rule.
 */
const ACCESS_RESTRICTED_SUBCOMMANDS: readonly string[] = ['trust', 'block', 'admit'];

/** The feature a `/access` subcommand belongs to: none for the three that only take back or show. */
export function accessFeatureFor(subcommand: string | null): CommandFeature | null {
  return subcommand !== null && ACCESS_RESTRICTED_SUBCOMMANDS.includes(subcommand)
    ? 'access'
    : null;
}

/** The feature a slash command belongs to, or null when no rule can stop it. */
export function featureForCommand(commandName: string): CommandFeature | null {
  return Object.prototype.hasOwnProperty.call(COMMAND_FEATURE, commandName)
    ? COMMAND_FEATURE[commandName]!
    : null;
}

/**
 * The feature a Size action belongs to: none when it removes the limit.
 *
 * A limit of 0 is "no limit", which is `/unlimit` by another name and so the undo
 * direction. It is never restricted, whichever door it comes in by: `/limit 0`,
 * and the panel's Size box submitted blank or as 0. The box is only reachable
 * from the Size button, which a rule withdraws and refuses, so that last door
 * matters only for a box opened before the rule was added. Anything else,
 * including a value that is not a number, is a Size action and a rule can stop
 * it. `null` (a `/limit` with no count, which only a hand-built request sends) is
 * not 0.
 */
export function limitFeatureFor(count: number | null): CommandFeature | null {
  return count === 0 ? null : 'limit';
}

/**
 * Whether a `/nick` value removes the saved nickname, which is what `setNick`
 * does for `reset` in any case or for nothing but spaces. One predicate for both,
 * so the guard and the writer cannot disagree about which values are a removal.
 */
export function isNickReset(name: string): boolean {
  const value = name.trim();
  return value === '' || value.toLowerCase() === 'reset';
}

/**
 * The feature a `/nick` value belongs to: none when it removes the nickname.
 *
 * Removing is the undo direction, and the one a member needs when a rule names
 * one of their ROLES: `/restrict add` clears the saved nickname of a USER it
 * names, but it cannot list a role's members, so a member under a role rule
 * would otherwise be left with saved text they cannot erase.
 */
export function nickFeatureFor(name: string | null): CommandFeature | null {
  return name !== null && isNickReset(name) ? null : 'nick';
}

/**
 * Room panel action to feature, for the panel entry that performs the same act
 * as the command.
 *
 * A `Record` over every action, not a lookup that defaults, so a new panel action
 * cannot compile without a decision about whether a rule can stop it. `null` is a
 * decision: `unlock` and `unhide` are the undo directions, and Claim, Kick and Info are
 * occupant-level (see {@link COMMAND_FEATURES}). The two-step actions are the
 * same act as their button: `limitset` and `renameset` are the modals the Size
 * and Name buttons open, and `transferpick` is the member picker Transfer opens,
 * so a rule has to stop every step and not only the first.
 */
export const PANEL_ACTION_FEATURE: Record<ControlPanelAction, CommandFeature | null> = {
  lock: 'privacy',
  unlock: null,
  hide: 'hide',
  unhide: null,
  limit: 'limit',
  limitset: 'limit',
  rename: 'rename',
  renameset: 'rename',
  transfer: 'transfer',
  transferpick: 'transfer',
  claim: null,
  kick: null,
  kickpick: null,
  info: null,
};

/**
 * Most users and most roles one feature may deny, and most entries in the whole
 * map.
 *
 * These are `IMPORT_LIMITS.commandAccessUsers`, `commandAccessRoles` and
 * `commandAccessTotal` in core, which cannot be imported from here, and
 * `commandAccess.unit.test.ts` binds each pair. They exist because the denied ids
 * ride in the guild's settings blob, which every instance keeps resident and
 * which the router reads in full on every interaction.
 */
export const MAX_RESTRICTED_USERS = 50;
export const MAX_RESTRICTED_ROLES = 25;
export const MAX_RESTRICTIONS = 150;

/** The users and roles one feature denies. Never both empty: that is absent. */
export interface FeatureDenials {
  users: string[];
  roles: string[];
}

/** Every feature somebody is denied. A feature that is absent is open to everyone. */
export type CommandAccess = Partial<Record<CommandFeature, FeatureDenials>>;

/**
 * Somebody a rule can name: a user, or a role. `/restrict` resolves which from
 * the option Discord sent, since the two share one picker and one id space.
 */
export interface RestrictTarget {
  kind: 'user' | 'role';
  id: string;
}

/**
 * A list of snowflakes, deduplicated in the order stored. Anything else reads as
 * none. Exported for the writer, which counts against the caps with the same
 * rule the reader enforces, so the two cannot disagree about what a rule holds.
 */
export function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) if (isSnowflake(id)) ids.add(id);
  return [...ids];
}

/**
 * Reads the restrictions from the settings blob.
 *
 * Defensive on every level, because the blob is validated only as
 * `record(unknown)` at the repository and `/import` or a newer build can put
 * anything in it. Unknown feature ids are ignored by iterating the known ones
 * rather than the stored ones. A malformed entry, a list that is not a list and
 * an id that is not a snowflake are skipped, so the rest of the map still holds:
 * losing every restriction over one bad entry would be worse than ignoring it.
 *
 * **The guild id is dropped from every role list, and that is why this takes it.**
 * The `@everyone` role's id IS the guild id, and `GuildMember.roles.cache`
 * includes it for every member, so a stored one would deny the whole server. The
 * writer and importer refuse to store it, and this makes the reader the one place
 * that does not depend on them or on every caller stripping it from `roleIds`.
 *
 * The returned object, its entries and their arrays are all fresh on every call.
 * `SettingsCache` serves the same row object to every caller on the instance, so
 * returning anything stored by reference would let one caller's mutation corrupt
 * every other read in the process with no write behind it.
 */
export function readCommandAccess(
  settings: Record<string, unknown>,
  guildId: string,
): CommandAccess {
  const access: CommandAccess = {};
  const raw = settings[SETTINGS_KEYS.commandAccess];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return access;
  for (const feature of COMMAND_FEATURES) {
    if (!Object.prototype.hasOwnProperty.call(raw, feature)) continue;
    const entry = (raw as Record<string, unknown>)[feature];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const users = readIds((entry as { users?: unknown }).users);
    const roles = readIds((entry as { roles?: unknown }).roles).filter((id) => id !== guildId);
    if (users.length + roles.length > 0) access[feature] = { users, roles };
  }
  return access;
}

/** Who is asking: what a rule is checked against. */
export interface CommandCaller {
  userId: string;
  /**
   * The caller's role ids. May include the guild id, which is `@everyone`:
   * {@link readCommandAccess} never returns it as a denied role, so it cannot match.
   */
  roleIds: readonly string[];
  /** Manage Channels or Administrator, which no rule can restrict. */
  canManage: boolean;
}

/**
 * Whether the caller may use a feature.
 *
 * `null` is a feature that no rule can stop, so it passes, which lets a caller
 * pass `PANEL_ACTION_FEATURE[action]` straight in. A caller who can manage
 * channels always passes. Otherwise the caller fails if their id is denied or if
 * ANY of their roles is, and a feature with nothing stored passes.
 */
export function mayUse(
  feature: CommandFeature | null,
  caller: CommandCaller,
  access: CommandAccess,
): boolean {
  if (feature === null || caller.canManage) return true;
  const denied = access[feature];
  if (!denied) return true;
  if (denied.users.includes(caller.userId)) return false;
  return !caller.roleIds.some((roleId) => denied.roles.includes(roleId));
}

/**
 * Whether a member's SAVED lists are inert: they are denied Saved lists, so what they
 * saved applies to nothing until the rule is lifted.
 *
 * A restricted feature is inert for a denied member, saved data included, and this is the
 * one rule every place that applies a saved list asks (a room being made, a sweep, a
 * lock or a hide, a knock, the card's Block), so they cannot disagree. Inert is not
 * erased: the rows stay, and the lists apply again the moment the rule goes.
 *
 * **`standing` is who the list's owner is right now, and `undefined` means it could not
 * be resolved, which is NOT inert.** A cold cache or a member who has left says nothing
 * about their roles, and a saved block is protection for the people it names, so the
 * unknown direction keeps applying it: the same fail-open every other part of this file
 * takes, with the saved list as the thing it protects. The cost is that a denied member
 * whose standing the cache cannot show keeps their lists in force until it can.
 */
export function savedListsInert(
  access: CommandAccess,
  standing: CommandCaller | undefined,
): boolean {
  return standing !== undefined && !mayUse('access', standing, access);
}
