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
 * importer. The alternative failure, a rule that locks the people it was never
 * meant to, is the one an admin cannot diagnose from inside Discord.
 *
 * **Members who can manage channels are never restricted.** Manage Channels or
 * Administrator already lets them rename any room, so a rule could not stop
 * them and would only mislead the admin who wrote it, and it means an admin can
 * never lock themselves out.
 *
 * **Undo directions are never restricted.** Opening a room again, removing a
 * limit and (later) showing a room or removing a saved member must always work:
 * a creator channel whose rooms start private has to leave its owner a way to
 * open one, and a saved list is something a member must be able to erase.
 */

/**
 * The features a rule can name, as stored.
 *
 * Append only, and never rename: the stored map is keyed by these strings, so a
 * renamed id silently un-restricts everybody an admin named under the old one.
 * Hide and Saved lists are listed ahead of their commands so the ids are
 * reserved, but nothing offers or enforces them until those commands exist.
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
 * The features `/restrict` offers today.
 *
 * Hide and Saved lists are absent because the commands they restrict do not
 * exist in this build, so an admin could restrict nothing and would be told they
 * had. Add one here in the commit that ships its command.
 */
export const AVAILABLE_FEATURES = [
  'privacy',
  'limit',
  'rename',
  'transfer',
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
  limit: 'the /limit command and the Size button. Removing a limit stays open to everyone',
  rename:
    'the /name command, the Name button, the template editor for their own room and the voice status',
  transfer: 'the /transfer command and the Transfer button',
  access:
    'the /access trust, block and admit commands. Removing, clearing and listing stay open to everyone',
  nick: 'the /nick command',
};

/**
 * Slash command to feature, for the commands a rule can stop.
 *
 * Absent means the command is never restricted: `public` and `unlimit` are undo
 * directions, `reclaim` and `kick` are occupant-level, and the admin commands
 * are governed by Discord permissions and not by this map. A lookup is by
 * `featureForCommand`, which is an own-property test, because the name is client
 * input and `constructor` is a property of every object.
 */
export const COMMAND_FEATURE: Readonly<Record<string, CommandFeature>> = {
  private: 'privacy',
  limit: 'limit',
  name: 'rename',
  transfer: 'transfer',
  nick: 'nick',
};

/** The feature a slash command belongs to, or null when no rule can stop it. */
export function featureForCommand(commandName: string): CommandFeature | null {
  return Object.prototype.hasOwnProperty.call(COMMAND_FEATURE, commandName)
    ? COMMAND_FEATURE[commandName]!
    : null;
}

/**
 * Room panel action to feature, for the panel entry that performs the same act
 * as the command.
 *
 * A `Record` over every action, not a lookup that defaults, so a new panel action
 * cannot compile without a decision about whether a rule can stop it. `null` is a
 * decision: `unlock` is the undo direction, and Claim, Kick and Info are
 * occupant-level (see {@link COMMAND_FEATURES}). The two-step actions are the
 * same act as their button: `limitset` and `renameset` are the modals the Size
 * and Name buttons open, and `transferpick` is the member picker Transfer opens,
 * so a rule has to stop every step and not only the first.
 */
export const PANEL_ACTION_FEATURE: Record<ControlPanelAction, CommandFeature | null> = {
  lock: 'privacy',
  unlock: null,
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

/** A list of snowflakes, deduplicated in the order stored. Anything else reads as none. */
function readIds(value: unknown): string[] {
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
 * The returned object, its entries and their arrays are all fresh on every call.
 * `SettingsCache` serves the same row object to every caller on the instance, so
 * returning anything stored by reference would let one caller's mutation corrupt
 * every other read in the process with no write behind it.
 */
export function readCommandAccess(settings: Record<string, unknown>): CommandAccess {
  const access: CommandAccess = {};
  const raw = settings[SETTINGS_KEYS.commandAccess];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return access;
  for (const feature of COMMAND_FEATURES) {
    if (!Object.prototype.hasOwnProperty.call(raw, feature)) continue;
    const entry = (raw as Record<string, unknown>)[feature];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const users = readIds((entry as { users?: unknown }).users);
    const roles = readIds((entry as { roles?: unknown }).roles);
    if (users.length + roles.length > 0) access[feature] = { users, roles };
  }
  return access;
}

/** Who is asking: what a rule is checked against. */
export interface CommandCaller {
  userId: string;
  /**
   * The caller's role ids, WITHOUT the guild id. `@everyone` is a role whose id is
   * the guild id, and a caller that left it in would match a stored `@everyone`
   * rule that the writer and importer refuse to store, so stripping it is the
   * caller's half of the contract.
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
