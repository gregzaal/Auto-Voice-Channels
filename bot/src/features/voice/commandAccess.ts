import type { ControlPanelAction } from './controlPanel.js';
import { isSnowflake, SETTINGS_KEYS } from './guildSettings.js';

/**
 * Who may use which room command: the policy half, with no I/O and no Discord
 * in it, so every edge unit-tests with plain objects.
 *
 * **An allow list and a deny list per feature, and deny wins.** An admin can keep
 * a feature to some users and roles (`/restrict allow`, "make Name moderator
 * only", which is what the old Python bot's `restrict` did), and can name users
 * and roles that may never use it (`/restrict deny`). A caller named on the deny
 * list, by id or by any role, is refused. Otherwise a feature with an allow list
 * is refused to anyone it does not name, and a feature with neither is open. A
 * feature nobody has said anything about is open, which is what makes a new
 * feature safe to ship: it starts open, and no server has to be told about it
 * before it works. Only a departure is ever stored, so absent means open.
 * Decided by the owner on 2026-10-04, replacing the deny-only first build.
 *
 * **Failure directions.** A rule this build cannot read is ignored, so a malformed
 * entry fails open. A deleted role on a DENY list stops matching anybody, which
 * fails open, and a deleted role on an ALLOW list lets nobody in, which fails
 * closed: the feature is left to the rest of its allow list and to whoever can
 * manage channels, and `/restrict list` flags the role so an admin can see why.
 * The `@everyone` role (whose id is the guild id) is refused on both lists at the
 * writer and the importer. The reader drops it from a deny list, so even a value
 * put in the database by hand cannot deny every member, and reads an allow list
 * holding it as absent, since allowing everyone is no rule at all.
 *
 * **Members who can manage channels are never restricted.** Manage Channels or
 * Administrator already lets them rename any room, so a rule could not stop
 * them and would only mislead the admin who wrote it, and it means an admin can
 * never lock themselves out. **Where that is judged differs by door.** The guard reads
 * the permissions Discord resolved for the channel the interaction came from, the room
 * panel reads them for the room, and a snapshot of a member (a name in a room title,
 * a remembered setting at creation) knows only what they hold server-wide. A moderator
 * who has Manage Channels through one category or room overwrite is therefore exempt at
 * the first two and held to a rule at the third.
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
 * Kick and Claim are occupant-level: anyone in a room can press them, not only its
 * owner. So a rule on one is never shown on the room panel (the buttons stay, see
 * {@link OCCUPANT_LEVEL_ACTIONS}) and is refused at the click instead. Info is not a
 * feature at all: it only reads, and it stays switch-it-off-for-everyone in
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
  'kick',
  'claim',
] as const;

export type CommandFeature = (typeof COMMAND_FEATURES)[number];

/**
 * Whether the guard reads the restrictions, which decides whether `/restrict` is
 * registered. True: every command and panel path in `interactions.ts` checks the
 * map (Claim's through `VoiceCommands.claim`, see {@link claimFeatureFor}), and the
 * room panel hides what a restricted owner cannot use, Kick and Claim excepted
 * ({@link OCCUPANT_LEVEL_ACTIONS}).
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
  'kick',
  'claim',
] as const satisfies readonly CommandFeature[];

export type AvailableFeature = (typeof AVAILABLE_FEATURES)[number];

/** True only for a string `/restrict` offers, which is client input when it arrives. */
export function isAvailableFeature(value: unknown): value is AvailableFeature {
  return typeof value === 'string' && (AVAILABLE_FEATURES as readonly string[]).includes(value);
}

/**
 * How each feature reads in customer copy. Every feature with a room panel button
 * is labelled with the words on it, so an admin is looking at the word members see.
 */
export const FEATURE_LABELS: Record<CommandFeature, string> = {
  privacy: 'Private and Public',
  hide: 'Hide',
  limit: 'Size',
  rename: 'Name',
  transfer: 'Transfer',
  access: 'Saved lists',
  nick: 'Nickname',
  kick: 'Kick',
  claim: 'Claim',
};

/**
 * What a restriction covers, as a clause that finishes "That covers ...".
 *
 * A feature is more than one door, and the reply has to say which, because an
 * admin who restricts Name and then finds the template editor still open will
 * reasonably call it a bug. Name covers the `/template` editor for a room the
 * member owns and the voice status because all three share one write path.
 * Where a feature has an undo direction the clause says that stays open. Kick and
 * Claim also say that their buttons stay on the panel, because an admin who
 * restricts one and still sees the button would otherwise call it a bug.
 *
 * **No pronoun may stand for the person the reply names.** The same clause ends a
 * `deny` reply ("@Troll can no longer use ...") and the first `allow` reply ("From
 * now on only @Mods ... can use ..."), where the people a rule stops are everyone
 * BUT the one named. So a clause that talks about who it stops says "a member it
 * stops", and never "they" or "them" on its own.
 */
export const FEATURE_COVERS: Record<CommandFeature, string> = {
  privacy:
    'the /private command and the Private button. Opening a room again stays open to everyone. Showing a hidden room opens it to everyone too, so hiding and showing a room never leaves it locked',
  hide: 'the /hide command and the Hide button. Showing a room again stays open to everyone',
  limit:
    'the /limit command and the Size button. The /unlimit command and /limit 0 stay open to everyone',
  rename:
    "the /name command, the Name button, the template editor for a member's own room and the voice status",
  transfer: 'the /transfer command and the Transfer button',
  access:
    'the /access trust, block and admit commands and the Always allow button on a join request. A member it stops keeps the lists they already saved, but those lists stop applying to their rooms, and within a few minutes their entries come off the rooms they have now, so anyone they blocked can join again. Removing, clearing and listing stay open to everyone',
  nick: 'the /nick command, and a saved nickname showing in a room name. Removing a nickname stays open to everyone, and a room name that already shows one changes the next time the room refreshes its name',
  kick: 'the /kick command and the Kick button, which start a vote to remove someone from a room. The Kick button stays on the room panel, since anyone in a room can press it, and refuses a member it stops when they press it. Voting on a kick that is already running stays open to everyone',
  claim:
    "the Claim button and the /reclaim command, used to take over somebody else's room. The Claim button stays on the room panel, since anyone in a room can press it, and refuses a member it stops when they press it. A member taking back a room of their own is never stopped",
};

/**
 * Slash command to feature, for the commands a rule can stop.
 *
 * Absent means the command is never restricted by name: `public`, `unhide` and
 * `unlimit` are undo directions, and the admin commands are governed by Discord
 * permissions and not by this map. `reclaim` is absent because a rule on Claim
 * depends on the room and not on the command: see {@link claimFeatureFor}. A lookup
 * is by `featureForCommand`, which is an own-property test, because the name is
 * client input and `constructor` is a property of every object.
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
  kick: 'kick',
};

/**
 * The feature taking over a room belongs to: none for the room's original creator.
 *
 * `/reclaim` and the panel's Claim button are one act (`VoiceCommands.claim`), and it
 * is two things. A member taking over somebody else's room is Claim, and a rule can stop
 * it. The original creator taking their own room back, from a caretaker or after they
 * left, is never restricted: it is the way back to something that is theirs. "Original
 * creator" is the row's `original_creator`, which a `/transfer` or a claim moves to the
 * new owner, so a room given away is no longer the giver's to take back.
 * Only the room's row says which, so the caller decides this where it reads the row and
 * not in the router, and `PANEL_ACTION_FEATURE.claim` is `null` for that reason.
 */
export function claimFeatureFor(isOriginalCreator: boolean): CommandFeature | null {
  return isOriginalCreator ? null : 'claim';
}

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
 * Removing is the undo direction, and the one a member needs when a rule covers
 * them through a ROLE or an allow list: `/restrict deny` clears the saved nickname
 * of a USER it names, but it cannot list a role's members or everyone an allow
 * list leaves out, so such a member would otherwise be left with saved text they
 * cannot erase.
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
 * decision: `unlock` and `unhide` are the undo directions, Info only reads, and Claim
 * is decided where the room's row is read, since its original creator is never
 * restricted ({@link claimFeatureFor}). The two-step actions are the same act as
 * their button: `limitset` and `renameset` are the modals the Size and Name buttons
 * open, and `transferpick` and `kickpick` are the member pickers Transfer and Kick
 * open, so a rule has to stop every step and not only the first. Kick and Claim are
 * occupant-level, so the panel never hides them ({@link OCCUPANT_LEVEL_ACTIONS}).
 *
 * `unhide` is `null` and is never refused, but it is not the same act for everyone: a hidden
 * room is a locked one, so for a member denied Private the router has it open the room to
 * everyone instead of leaving it locked (`privateDeniedFor` in `interactions.ts`).
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
  kick: 'kick',
  kickpick: 'kick',
  info: null,
};

/**
 * The panel actions any occupant of a room may press, not only its owner.
 *
 * The panel hides an owner-level control that a rule denies the room's owner,
 * because the owner is the one person those buttons are for. These are pressed by
 * whoever is in the room, so the owner's standing says nothing about who will press
 * them, and they are never hidden on it: a member a rule covers sees the button and
 * is refused when they press it, like a non-owner pressing an owner's button. Info
 * is here because it is pressed by anyone too, though no rule names it.
 */
export const OCCUPANT_LEVEL_ACTIONS: ReadonlySet<ControlPanelAction> = new Set<ControlPanelAction>([
  'claim',
  'kick',
  'kickpick',
  'info',
]);

/**
 * Most users and most roles one list of one feature may hold, and most entries in
 * the whole map, allow and deny lists together.
 *
 * These are `IMPORT_LIMITS.commandAccessUsers`, `commandAccessRoles` and
 * `commandAccessTotal` in core, which cannot be imported from here, and
 * `commandAccess.unit.test.ts` binds each pair. They exist because the listed ids
 * ride in the guild's settings blob, which every instance keeps resident and
 * which the router reads in full on every interaction.
 */
export const MAX_RESTRICTED_USERS = 50;
export const MAX_RESTRICTED_ROLES = 25;
export const MAX_RESTRICTIONS = 150;

/** The two lists a feature can have, in the order `/restrict` shows them. */
export const ACCESS_LISTS = ['allow', 'deny'] as const;

export type AccessList = (typeof ACCESS_LISTS)[number];

/** The users and roles on one list. Never both empty: that is absent. */
export interface ListEntries {
  users: string[];
  roles: string[];
}

/**
 * One feature's rules: who it is kept to, and who may never use it. Never both
 * absent: that is a feature with no rule, which is absent from the map.
 */
export interface FeatureRules {
  allow?: ListEntries;
  deny?: ListEntries;
}

/** Every feature somebody has a rule about. A feature that is absent is open to everyone. */
export type CommandAccess = Partial<Record<CommandFeature, FeatureRules>>;

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

/** A plain object, which is what a stored map is. Not an array, not null. */
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One stored list, read: its users, its roles without the guild id, and whether
 * the guild id (the `@everyone` role) was among them.
 */
function readList(
  value: unknown,
  guildId: string,
): { users: string[]; roles: string[]; everyone: boolean } {
  if (!isMap(value)) return { users: [], roles: [], everyone: false };
  const roles = readIds(value.roles);
  return {
    users: readIds(value.users),
    roles: roles.filter((id) => id !== guildId),
    everyone: roles.includes(guildId),
  };
}

/**
 * One stored feature entry, read: its allow list and its deny list, each present
 * only when it names somebody, or undefined when neither does.
 *
 * Exported for the writer, which asks it whether an allow list was in force before
 * an edit and still is after, so the reply says what the reader will do.
 *
 * **The guild id never reaches a list, and that is why this takes it.** The
 * `@everyone` role's id IS the guild id, and `GuildMember.roles.cache` includes it
 * for every member. On a deny list it would deny the whole server, so it is dropped.
 * On an allow list it would let everyone in, which is no rule at all, so a list
 * holding it reads as absent. The writer and importer refuse to store it on either
 * list, and this makes the reader the one place that does not depend on them or on
 * every caller stripping it from `roleIds`.
 */
export function readFeatureRules(entry: unknown, guildId: string): FeatureRules | undefined {
  if (!isMap(entry)) return undefined;
  const rules: FeatureRules = {};
  const allow = readList(entry.allow, guildId);
  if (!allow.everyone && allow.users.length + allow.roles.length > 0) {
    rules.allow = { users: allow.users, roles: allow.roles };
  }
  const deny = readList(entry.deny, guildId);
  if (deny.users.length + deny.roles.length > 0) {
    rules.deny = { users: deny.users, roles: deny.roles };
  }
  return rules.allow !== undefined || rules.deny !== undefined ? rules : undefined;
}

/**
 * Reads the rules from the settings blob.
 *
 * Defensive on every level, because the blob is validated only as
 * `record(unknown)` at the repository and `/import` or a newer build can put
 * anything in it. Unknown feature ids are ignored by iterating the known ones
 * rather than the stored ones, and so are fields of an entry other than `allow`
 * and `deny`. A malformed entry or list, a list of ids that is not a list and an
 * id that is not a snowflake are skipped, so the rest of the map still holds:
 * losing every rule over one bad entry would be worse than ignoring it. An allow
 * list that cannot be read is therefore no allow list, which opens the feature:
 * the same fail-open as everything else this build cannot read.
 *
 * The returned object, its entries, their lists and their arrays are all fresh on
 * every call. `SettingsCache` serves the same row object to every caller on the
 * instance, so returning anything stored by reference would let one caller's
 * mutation corrupt every other read in the process with no write behind it.
 */
export function readCommandAccess(
  settings: Record<string, unknown>,
  guildId: string,
): CommandAccess {
  const access: CommandAccess = {};
  const raw = settings[SETTINGS_KEYS.commandAccess];
  if (!isMap(raw)) return access;
  for (const feature of COMMAND_FEATURES) {
    if (!Object.prototype.hasOwnProperty.call(raw, feature)) continue;
    const rules = readFeatureRules(raw[feature], guildId);
    if (rules) access[feature] = rules;
  }
  return access;
}

/** Who is asking: what a rule is checked against. */
export interface CommandCaller {
  userId: string;
  /**
   * The caller's role ids. May include the guild id, which is `@everyone`:
   * {@link readCommandAccess} never returns it on a list, so it cannot match.
   */
  roleIds: readonly string[];
  /** Manage Channels or Administrator, which no rule can restrict. */
  canManage: boolean;
}

/** Whether a list names the caller, by their id or by ANY of their roles. */
function names(list: ListEntries, caller: CommandCaller): boolean {
  return (
    list.users.includes(caller.userId) ||
    caller.roleIds.some((roleId) => list.roles.includes(roleId))
  );
}

/**
 * Whether the caller may use a feature.
 *
 * `null` is a feature that no rule can stop, so it passes, which lets a caller
 * pass `PANEL_ACTION_FEATURE[action]` straight in. A caller who can manage
 * channels always passes. Otherwise the deny list is asked first and wins: a
 * caller it names, by id or by any role, fails, even one the allow list names
 * too. Then a feature with an allow list passes only a caller it names, and a
 * feature with neither list passes everyone.
 *
 * A caller whose roles are not known passes an empty `roleIds`, so only a rule
 * naming them by id can reach them: a deny list by role cannot refuse them, and an
 * allow list by role cannot let them in.
 */
export function mayUse(
  feature: CommandFeature | null,
  caller: CommandCaller,
  access: CommandAccess,
): boolean {
  if (feature === null || caller.canManage) return true;
  const rules = access[feature];
  if (!rules) return true;
  if (rules.deny && names(rules.deny, caller)) return false;
  return rules.allow === undefined || names(rules.allow, caller);
}

/**
 * Whether a member's SAVED lists are inert: a rule refuses them Saved lists (a deny list
 * names them, or an allow list leaves them out), so what they saved applies to nothing
 * until the rule is lifted.
 *
 * A restricted feature is inert for a denied member, saved data included, and this is the
 * one rule every place that applies a saved list asks (a room being made, a sweep, a
 * lock or a hide, a knock, the card's Block), so they apply the same rule. They can still
 * differ in `standing`: a room being made has the member's own snapshot, which judges
 * Manage Channels guild-wide, and every place after it reads the cache, which judges it
 * against the room. A member who holds Manage Channels only through a category or room
 * overwrite is therefore inert at creation and not from the first sweep. Inert is not
 * erased: the rows stay, and the lists apply again the moment the rule goes.
 *
 * **`standing` is who the list's owner is right now, and `undefined` means it could not
 * be resolved, which is NOT inert.** A cold cache or a member who has left says nothing
 * about their roles, and a saved block is protection for the people it names, so the
 * unknown direction keeps applying it: the fail-open direction, with the saved list as
 * the thing it protects, and an allow list that might not name them changes nothing
 * about that. The cost is that a denied member
 * whose standing the cache cannot show keeps their lists in force until it can.
 */
export function savedListsInert(
  access: CommandAccess,
  standing: CommandCaller | undefined,
): boolean {
  return standing !== undefined && !mayUse('access', standing, access);
}
