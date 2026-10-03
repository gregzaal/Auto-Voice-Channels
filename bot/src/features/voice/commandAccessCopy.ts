import {
  AVAILABLE_FEATURES,
  FEATURE_COVERS,
  FEATURE_LABELS,
  MAX_RESTRICTED_ROLES,
  MAX_RESTRICTED_USERS,
  MAX_RESTRICTIONS,
  type CommandAccess,
  type CommandFeature,
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
 * Said under the reply to `add` and `list`.
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
 * What a successful `add` says. `already` is a repeat, which changes nothing
 * except that it still removes a saved nickname an older build let through, and
 * then "so nothing changed" would be untrue in the same sentence.
 */
export function restrictAddedMessage(
  target: RestrictTarget,
  feature: CommandFeature,
  opts: { already: boolean; nicknameCleared: boolean },
): string {
  const who = restrictMention(target);
  if (opts.already) {
    const lead = `${who} is already restricted from ${label(feature)}`;
    return opts.nicknameCleared
      ? `${lead}. Their saved nickname was removed.`
      : `${lead}, so nothing changed.`;
  }
  const lead = `${who} can no longer use ${label(feature)}. That covers ${FEATURE_COVERS[feature]}.`;
  return opts.nicknameCleared ? `${lead} Their saved nickname was removed.` : lead;
}

/** What a successful `clear` says. `removed` is how many restrictions it took off. */
export function restrictClearedMessage(feature: CommandFeature, opts: { removed: number }): string {
  if (opts.removed === 0)
    return `Nobody was restricted from ${label(feature)}, so nothing changed.`;
  const count = opts.removed === 1 ? '1 restriction' : `${opts.removed} restrictions`;
  return `Removed ${count} on ${label(feature)}. Everyone can use it again.`;
}

/** What a successful `remove` says. `was` is whether there was anything to remove. */
export function restrictRemovedMessage(
  target: RestrictTarget,
  feature: CommandFeature,
  opts: { was: boolean },
): string {
  const who = restrictMention(target);
  return opts.was
    ? `${who} can use ${label(feature)} again.`
    : `${who} was not restricted from ${label(feature)}, so nothing changed.`;
}

/** Every reason `add` can refuse, as the reply an admin reads. */
export const RESTRICT_REFUSALS = {
  /** The role whose id is the guild id. */
  everyone:
    'That is the everyone role, which would restrict the whole server. Pick a person or a specific role instead.',
  /** A target Discord gave us that is neither a user nor a role we can use. */
  unusable: 'That is not something I can restrict.',
  /** A feature id that is not one `/restrict` offers, which only a hand-built request sends. */
  unknownFeature: 'Pick one of the room commands from the list.',
  bot: (target: RestrictTarget): string =>
    `${restrictMention(target)} is a bot, and bots cannot use room commands, so there is nothing to restrict.`,
  /** Manage Channels or Administrator, which a rule cannot stop. */
  manager: (target: RestrictTarget): string =>
    `${restrictMention(target)} has the Manage Channels or Administrator permission, so a restriction would do nothing. ` +
    'People with either can always use every room command.',
  /**
   * The three full-list refusals name `/restrict clear` because a list can fill
   * with people who have left the server and roles that were deleted, and neither
   * can be picked again for `remove`.
   */
  tooManyUsers: (feature: CommandFeature): string =>
    `${label(feature)} already restricts ${MAX_RESTRICTED_USERS} people, which is the most one feature can hold. ` +
    'Remove someone before adding another, or use /restrict clear to start its list again.',
  tooManyRoles: (feature: CommandFeature): string =>
    `${label(feature)} already restricts ${MAX_RESTRICTED_ROLES} roles, which is the most one feature can hold. ` +
    'Remove a role before adding another, or use /restrict clear to start its list again.',
  tooMany: `This server already has ${MAX_RESTRICTIONS} restrictions, which is the most it can hold. Remove some before adding more, or use /restrict clear on a command to start its list again.`,
  /**
   * A list whose stored shape this version cannot change, which only a newer
   * version writes. Refused rather than rewritten, so that version's data survives.
   */
  unreadable: (feature: CommandFeature): string =>
    `The saved restrictions for ${label(feature)} are in a form this version of AVC cannot change, so nothing was changed.`,
} as const;

/** Most people and roles shown under one feature before the rest are counted. */
const LIST_CAP = 8;

/**
 * The `/restrict list` reply.
 *
 * Every feature `/restrict` offers, in the order it offers them, because an
 * admin looking for who is restricted is also looking at what could be. Roles
 * come before people, since there are fewer of them and they cover more.
 *
 * Capped per feature with an honest tail rather than cut off. 150 mentions is
 * about 3,700 characters against Discord's 2,000, so the cap is what keeps the
 * reply deliverable, and it is sized so that every feature at the cap still
 * leaves room for the two lines at the bottom that an admin must not miss.
 */
export function renderRestrictionList(access: CommandAccess): string {
  // Headed by what the lists ARE: they name who is denied, and a heading that
  // reads "who can use" would be taken for the opposite.
  const lines = ['**Restricted from room commands**'];
  for (const feature of AVAILABLE_FEATURES) {
    const denied = access[feature];
    const entries: string[] = [
      ...(denied?.roles ?? []).map((id) => restrictMention({ kind: 'role', id })),
      ...(denied?.users ?? []).map((id) => restrictMention({ kind: 'user', id })),
    ];
    if (entries.length === 0) {
      lines.push(`${label(feature)}: nobody is restricted`);
      continue;
    }
    const shown = entries.slice(0, LIST_CAP).join(', ');
    const more = entries.length > LIST_CAP ? `, and ${entries.length - LIST_CAP} more` : '';
    lines.push(`${label(feature)}: ${shown}${more}`);
  }
  lines.push(
    '',
    'People with the Manage Channels or Administrator permission can always use every room command.',
    RESTRICT_NOTE,
  );
  return lines.join('\n');
}
