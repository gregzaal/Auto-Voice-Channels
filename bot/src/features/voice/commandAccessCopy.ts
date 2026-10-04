import {
  AVAILABLE_FEATURES,
  FEATURE_COVERS,
  FEATURE_LABELS,
  MAX_RESTRICTED_ROLES,
  MAX_RESTRICTED_USERS,
  MAX_RESTRICTIONS,
  type AccessList,
  type CommandAccess,
  type CommandFeature,
  type ListEntries,
  type RestrictTarget,
} from './commandAccess.js';

/**
 * What `/restrict` says, kept out of the writer and the handler so both word the
 * same facts the same way and one render-time test covers every string.
 *
 * Nothing here says why a member was refused or who else is restricted: that is
 * for the admin who asked, and every reply is ephemeral and sends no mention.
 */

/** A user or role as a mention, which Discord renders for the reader and never pings. */
export function restrictMention(target: RestrictTarget): string {
  return target.kind === 'role' ? `<@&${target.id}>` : `<@${target.id}>`;
}

/**
 * Said under the reply to `allow`, `deny` and `list`.
 *
 * Both halves are true limits and an admin should hear them before relying on a
 * rule. A rule is read by the build that serves the room, and a server can be
 * served by more than one. And Discord's own Integrations screen can still
 * narrow a slash command on top of this, while a panel button is not a slash
 * command and so follows these rules alone.
 */
export const RESTRICT_NOTE =
  "Restrictions only apply on versions of AVC that include them. Discord's own Integrations settings still apply to slash commands on top of this, and the room panel buttons ignore those settings.";

const label = (feature: CommandFeature): string => `**${FEATURE_LABELS[feature]}**`;

/**
 * How a feature reads to the MEMBER it was turned off for, where that differs
 * from the admin's label.
 *
 * Privacy is the one: an admin picks "Private and Public" because that is the
 * pair of buttons, but only going private is ever restricted, and opening a room
 * again stays open to everyone ({@link FEATURE_COVERS}). A member who has just
 * been refused `/private` must not be told they lost the way to open a room.
 */
const REFUSAL_LABELS: Partial<Record<CommandFeature, string>> = { privacy: 'Private' };

/**
 * What a member is told when a rule stops them, from a command, a panel button, a
 * modal or a picker alike.
 *
 * It says that a server admin turned the feature off for them, and nothing more:
 * never why (a deny list, or an allow list that leaves them out), and never who
 * else is restricted, since the member who reads it may
 * be the very person an admin is dealing with and everyone else is none of their
 * business. No mention, so nothing here can ping.
 */
export function restrictedRefusal(feature: CommandFeature): string {
  return `A server admin has turned off **${REFUSAL_LABELS[feature] ?? FEATURE_LABELS[feature]}** for you.`;
}

/**
 * Said when the `command_access.disabled` lever is set, where an admin is looking
 * at rules or has just added one. The rules are kept, which is the part an admin
 * worries about, and nobody is being refused, which is the part that would
 * otherwise be a false claim.
 */
export const RESTRICT_PAUSED =
  'Enforcement is paused right now, so nobody is being refused. The restrictions are kept and apply again when it resumes.';

/** Said where a reply has just put an allow list in force, or kept one in force. */
const ALLOW_LIST_ONLY =
  'Only the people and roles on its allow list, and members who can manage channels, can use it.';

/** Said where a reply has just emptied an allow list, which opens the feature again. */
const ALLOW_LIST_EMPTIED =
  'Its allow list is empty now, so everyone who is not denied can use it again.';

/**
 * What a successful `allow` says.
 *
 * `created` is the first entry of an allow list, which is the moment the feature
 * closes to everyone else, so that reply says it plainly and says what the feature
 * covers. `manager` is a target that can manage channels, which could already use
 * every room command: allowing one is how a feature is kept to admins, so the reply
 * says that instead of claiming they gained something. `moved` is a target this
 * edit took off the deny list. `already` is a repeat, which changes nothing unless
 * it also took them off the deny list.
 */
export function restrictAllowedMessage(
  target: RestrictTarget,
  feature: CommandFeature,
  opts: { already: boolean; created: boolean; manager: boolean; moved: boolean },
): string {
  const who = restrictMention(target);
  if (opts.already) {
    return opts.moved
      ? `${who} is no longer on the deny list for ${label(feature)}, and stays on its allow list.`
      : `${who} is already on the allow list for ${label(feature)}, so nothing changed.`;
  }
  const moved = opts.moved ? ` ${who} is no longer on its deny list.` : '';
  if (opts.created) {
    const lead = opts.manager
      ? `From now on only members who can manage channels, like ${who}, can use ${label(feature)}.`
      : `From now on only ${who} and members who can manage channels can use ${label(feature)}.`;
    return `${lead} That covers ${FEATURE_COVERS[feature]}.${moved}`;
  }
  const lead = opts.manager
    ? `${who} is on the allow list for ${label(feature)} now. Members who can manage channels can always use it.`
    : `${who} is on the allow list for ${label(feature)} now. ${ALLOW_LIST_ONLY}`;
  return `${lead}${moved}`;
}

/**
 * What a successful `deny` says. `already` is a repeat, which changes nothing
 * except that it still removes a saved nickname an older build let through, and
 * then "so nothing changed" would be untrue in the same sentence. `moved` is a
 * target this edit took off the allow list, and `allowEmptied` is that move
 * emptying it, which opens the feature to everyone else.
 */
export function restrictDeniedMessage(
  target: RestrictTarget,
  feature: CommandFeature,
  opts: { already: boolean; nicknameCleared: boolean; moved: boolean; allowEmptied: boolean },
): string {
  const who = restrictMention(target);
  const tail = [
    ...(opts.moved ? [`${who} is no longer on its allow list.`] : []),
    ...(opts.allowEmptied ? [ALLOW_LIST_EMPTIED] : []),
    ...(opts.nicknameCleared ? ['Their saved nickname was removed.'] : []),
  ];
  if (opts.already) {
    const lead = `${who} is already restricted from ${label(feature)}`;
    return tail.length > 0 ? `${lead}. ${tail.join(' ')}` : `${lead}, so nothing changed.`;
  }
  const lead = `${who} can no longer use ${label(feature)}. That covers ${FEATURE_COVERS[feature]}.`;
  return [lead, ...tail].join(' ');
}

/** What a successful `clear` says. `removed` is how many people and roles it took off. */
export function restrictClearedMessage(feature: CommandFeature, opts: { removed: number }): string {
  if (opts.removed === 0)
    return `Nobody was restricted from ${label(feature)}, so nothing changed.`;
  const count = opts.removed === 1 ? '1 restriction' : `${opts.removed} restrictions`;
  return `Removed ${count} on ${label(feature)}. Everyone can use it again.`;
}

/**
 * What a successful `remove` says. `from` is the lists the target came off, empty
 * when there was nothing to remove. `allowEmptied` is the allow list losing its last
 * entry, which opens the feature, and `allowAfter` is an allow list still in force,
 * which a person taken off the deny list does not get past by being taken off it.
 */
export function restrictRemovedMessage(
  target: RestrictTarget,
  feature: CommandFeature,
  opts: { from: readonly AccessList[]; allowEmptied: boolean; allowAfter: boolean },
): string {
  const who = restrictMention(target);
  const deny = opts.from.includes('deny');
  const allow = opts.from.includes('allow');
  if (!deny && !allow) {
    return `${who} was not on the allow list or the deny list for ${label(feature)}, so nothing changed.`;
  }
  if (deny && !allow && !opts.allowAfter) return `${who} can use ${label(feature)} again.`;
  const lead =
    deny && allow
      ? `${who} is off both lists for ${label(feature)}.`
      : deny
        ? `${who} is off the deny list for ${label(feature)}.`
        : `${who} is off the allow list for ${label(feature)}.`;
  if (opts.allowEmptied) return `${lead} ${ALLOW_LIST_EMPTIED}`;
  return opts.allowAfter ? `${lead} ${ALLOW_LIST_ONLY}` : lead;
}

/** Every reason `allow` and `deny` can refuse, as the reply an admin reads. */
export const RESTRICT_REFUSALS = {
  /** The role whose id is the guild id, on a deny list. */
  everyone:
    'That is the everyone role, which would restrict the whole server. Pick a person or a specific role instead.',
  /** The same role on an allow list, where it would be no rule at all. */
  everyoneAllowed:
    'That is the everyone role, and allowing everyone is the same as having no rule. Pick a person or a specific role instead, or use /restrict clear to let everyone use it again.',
  /** A target Discord gave us that is neither a user nor a role we can use. */
  unusable: 'That is not something I can restrict.',
  /** A feature id that is not one `/restrict` offers, which only a hand-built request sends. */
  unknownFeature: 'Pick one of the room commands from the list.',
  bot: (target: RestrictTarget): string =>
    `${restrictMention(target)} is a bot, and bots cannot use room commands, so there is nothing to restrict.`,
  /** Manage Channels or Administrator, which a deny cannot stop. */
  manager: (target: RestrictTarget): string =>
    `${restrictMention(target)} has the Manage Channels or Administrator permission, so a restriction would do nothing. ` +
    'People with either can always use every room command.',
  /**
   * The three full-list refusals name `/restrict clear` because a list can fill
   * with people who have left the server and roles that were deleted, and neither
   * can be picked again for `remove`.
   */
  tooManyUsers: (feature: CommandFeature, list: AccessList): string =>
    `The ${list} list for ${label(feature)} already holds ${MAX_RESTRICTED_USERS} people, which is the most one list can hold. ` +
    'Remove someone before adding another, or use /restrict clear to start its lists again.',
  tooManyRoles: (feature: CommandFeature, list: AccessList): string =>
    `The ${list} list for ${label(feature)} already holds ${MAX_RESTRICTED_ROLES} roles, which is the most one list can hold. ` +
    'Remove a role before adding another, or use /restrict clear to start its lists again.',
  tooMany: `This server already has ${MAX_RESTRICTIONS} restrictions, which is the most it can hold. Remove some before adding more, or use /restrict clear on a command to start its lists again.`,
  /**
   * A list whose stored shape this version cannot change, which only a newer
   * version writes. Refused rather than rewritten, so that version's data survives.
   */
  unreadable: (feature: CommandFeature): string =>
    `The saved restrictions for ${label(feature)} are in a form this version of AVC cannot change, so nothing was changed.`,
} as const;

/**
 * Most people and roles shown on one list before the rest are counted. The reply
 * starts here and shows fewer until it fits one Discord message, so this is the
 * most an admin is shown and never a reason the reply cannot be sent.
 */
const LIST_CAP = 7;

/** Discord's limit on one message, which the list reply must fit. */
const MESSAGE_LIMIT = 2000;

/**
 * Said under a list that holds a role the server no longer has. Neither kind can be
 * picked for `remove` once it is deleted, so the way out is named.
 */
export const DELETED_ROLE_NOTE =
  'A deleted role on an allow list lets nobody in, and on a deny list it stops nobody. Use /restrict clear on that command to start its lists again.';

/** "3 people and 2 roles", for a list too long to show. */
function countOf(people: number, roles: number): string {
  const parts = [
    ...(roles > 0 ? [roles === 1 ? '1 role' : `${roles} roles`] : []),
    ...(people > 0 ? [people === 1 ? '1 person' : `${people} people`] : []),
  ];
  return parts.join(' and ');
}

/** "@A, @B and @C", or "@A, @B and 5 more" past `cap`, or a count when `cap` is 0. */
function entriesText(
  entries: readonly string[],
  people: number,
  roles: number,
  cap: number,
): string {
  if (cap === 0) return countOf(people, roles);
  if (entries.length <= cap) {
    return entries.length === 1
      ? entries[0]!
      : `${entries.slice(0, -1).join(', ')} and ${entries.at(-1)!}`;
  }
  return `${entries.slice(0, cap).join(', ')} and ${entries.length - cap} more`;
}

/**
 * The `/restrict list` reply.
 *
 * Every feature `/restrict` offers, in the order it offers them, because an admin
 * looking at who may use a command is also looking at what could be restricted.
 * Each reads as who can use it: "everyone", "only" its allow list, "everyone
 * except" its deny list, or "only" the one and "never" the other. Roles come before
 * people, since there are fewer of them and they cover more.
 *
 * `roleExists` is the guild's role cache, when there is one. A role it does not hold
 * is shown as "a deleted role" rather than a mention Discord would render as
 * "@deleted-role" with nothing said about it, and the reply ends with what a deleted
 * role does on each list. Absent, nothing is flagged, since a role the cache cannot
 * see may still exist.
 *
 * Capped per list with an honest tail rather than cut off. 150 mentions is about
 * 3,700 characters against Discord's 2,000, so the reply starts at {@link LIST_CAP}
 * a list and shows fewer until it fits, down to counts alone, and the lines at the
 * bottom that an admin must not miss always fit. `paused` puts
 * {@link RESTRICT_PAUSED} first, ahead of the lists it qualifies.
 */
export function renderRestrictionList(
  access: CommandAccess,
  opts: { paused?: boolean; roleExists?: (id: string) => boolean } = {},
): string {
  const deleted = (id: string): boolean => opts.roleExists !== undefined && !opts.roleExists(id);
  const shown = (list: ListEntries | undefined, cap: number): string => {
    const roles = list?.roles ?? [];
    const users = list?.users ?? [];
    const entries = [
      ...roles.map((id) =>
        deleted(id) ? 'a deleted role' : restrictMention({ kind: 'role', id }),
      ),
      ...users.map((id) => restrictMention({ kind: 'user', id })),
    ];
    return entriesText(entries, users.length, roles.length, cap);
  };
  const anyDeleted = AVAILABLE_FEATURES.some((feature) =>
    [access[feature]?.allow, access[feature]?.deny].some((list) => list?.roles.some(deleted)),
  );
  const render = (cap: number): string => {
    const lines = [...(opts.paused ? [RESTRICT_PAUSED, ''] : []), '**Who can use room commands**'];
    for (const feature of AVAILABLE_FEATURES) {
      const { allow, deny } = access[feature] ?? {};
      const who =
        allow && deny
          ? `only ${shown(allow, cap)}, never ${shown(deny, cap)}`
          : allow
            ? `only ${shown(allow, cap)}`
            : deny
              ? `everyone except ${shown(deny, cap)}`
              : 'everyone';
      lines.push(`${label(feature)}: ${who}`);
    }
    lines.push(
      '',
      ...(anyDeleted ? [DELETED_ROLE_NOTE] : []),
      'People with the Manage Channels or Administrator permission can always use every room command.',
      RESTRICT_NOTE,
    );
    return lines.join('\n');
  };
  for (let cap = LIST_CAP; cap > 0; cap -= 1) {
    const text = render(cap);
    if (text.length <= MESSAGE_LIMIT) return text;
  }
  return render(0);
}
