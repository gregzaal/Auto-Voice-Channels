import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type {
  ChannelChange,
  ImportNote,
  ImportNoteCode,
  ImportPlan,
  SettingChange,
} from '@avc/core';

/**
 * Rendering and session state for `/import`.
 *
 * **Two audiences, two renderers, and they must not be merged.** The ephemeral
 * reply goes to the one admin who ran the command and may name things: aliases,
 * channels, how many nicknames changed. The system-channel announcement is
 * public and may not, so it renders every channel as `<#id>` and every user as
 * `<@id>` and lets Discord's own per-viewer resolution do the redaction. A name
 * string would disclose a staff-only log channel to everyone who can read the
 * system channel, and a nickname list would publish what members chose for
 * themselves.
 *
 * Everything outbound is capped. A guild with twenty creator channels, old to
 * new templates and two removal lists blows 2000 characters easily, and the
 * announcement cannot fall back to an attachment because the full plan is public
 * there.
 */

export const IMPORT_PREFIX = 'avc:import:';
export const importId = (action: string, session: string): string =>
  `${IMPORT_PREFIX}${action}:${session}`;

/** Discord's hard message limit, with room for the "and N more" tails. */
const MESSAGE_BUDGET = 1900;
/** Items named in a list before it collapses to a count. */
const LIST_CAP = 10;
/** Items named in a PUBLIC list. Lower, because the audience cannot act on it. */
const PUBLIC_LIST_CAP = 3;

export interface ImportSession {
  guildId: string;
  userId: string;
  plan: ImportPlan;
  fileName: string;
  fileSize: number;
  createdAt: number;
}

export interface SessionRejection {
  reason: 'per_guild' | 'per_instance';
  limit: number;
}

/**
 * The preview sessions held between the command and the confirm click.
 *
 * **Capped by COUNT with a refusal, not by TTL.** "Prune on insert" only removes
 * what has already expired, and an admin can upload far faster than fifteen
 * minutes, so a TTL alone is not a bound at all. Nothing else throttles repeat
 * `/import` calls either: `create.rate_limit_per_min` is for secondary creation.
 * The principal set here is every ManageGuild holder across the ~1,400 guilds on
 * one machine's shards, not one trusted operator.
 *
 * Holds the computed diff and drops the parsed source, which is what keeps the
 * per-session cost near the file size rather than several times it.
 */
export class ImportSessionStore {
  private readonly sessions = new Map<string, ImportSession>();
  /**
   * Ids that were claimed and applied, kept so a second confirm click can say
   * "this already ran" rather than "that session expired", which in a flow that
   * contemplates partial applies is the difference between reassurance and an
   * admin who cannot tell whether their configuration was half replaced.
   */
  private readonly applied = new Map<string, number>();

  constructor(
    private readonly opts: {
      ttlMs: number;
      perGuild: number;
      perInstance: number;
      now?: () => number;
    },
  ) {}

  private clock(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private prune(): void {
    const cutoff = this.clock() - this.opts.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(id);
    }
    for (const [id, at] of this.applied) {
      if (at < cutoff) this.applied.delete(id);
    }
  }

  put(id: string, session: ImportSession): { ok: true } | ({ ok: false } & SessionRejection) {
    this.prune();
    if (this.sessions.size >= this.opts.perInstance) {
      return { ok: false, reason: 'per_instance', limit: this.opts.perInstance };
    }
    const forGuild = [...this.sessions.values()].filter(
      (s) => s.guildId === session.guildId,
    ).length;
    if (forGuild >= this.opts.perGuild) {
      return { ok: false, reason: 'per_guild', limit: this.opts.perGuild };
    }
    this.sessions.set(id, session);
    return { ok: true };
  }

  /**
   * Takes the session, so it cannot be used twice.
   *
   * Claim-by-delete at the top of the confirm handler, before the defer. The
   * house pattern deletes at the END of the apply, which here would mean a
   * second click is a second pair of audit rows and possibly a second public
   * announcement.
   */
  claim(id: string): ImportSession | undefined {
    this.prune();
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    this.applied.set(id, this.clock());
    return session;
  }

  /** Cancel path: forget it without marking it applied, freeing the guild's slot. */
  drop(id: string): void {
    this.sessions.delete(id);
  }

  wasApplied(id: string): boolean {
    this.prune();
    return this.applied.has(id);
  }

  /**
   * For `/diagnostics`, which today can see nothing held in this closure.
   *
   * `heldBytesEstimate` is the number an operator with a memory alarm actually
   * wants: a count of sessions says nothing about whether they are four small
   * files or thirty-two large ones. Estimated from the uploaded file sizes,
   * which is the only figure available without walking the plans, and stated as
   * an estimate because a parsed plan costs several times its text.
   */
  stats(): {
    sessions: number;
    byGuildMax: number;
    applied: number;
    heldBytesEstimate: number;
  } {
    this.prune();
    const perGuild = new Map<string, number>();
    let bytes = 0;
    for (const session of this.sessions.values()) {
      perGuild.set(session.guildId, (perGuild.get(session.guildId) ?? 0) + 1);
      bytes += session.fileSize;
    }
    return {
      sessions: this.sessions.size,
      byGuildMax: Math.max(0, ...perGuild.values()),
      applied: this.applied.size,
      heldBytesEstimate: bytes,
    };
  }
}

export function importButtons(
  session: string,
  counts: DestructiveCounts,
): ActionRowBuilder<ButtonBuilder> {
  const destructive = counts.replaced + counts.removed;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(importId('confirm', session))
      .setLabel(confirmLabel(counts))
      // Proportional, not uniform: a guild with no existing configuration is not
      // being asked to destroy anything and the button should not pretend it is.
      .setStyle(destructive > 0 ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(importId('cancel', session))
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
}

export interface DestructiveCounts {
  /** Stored values this plan overwrites. */
  replaced: number;
  /** Channel rows this plan deletes, which no other command can put back. */
  removed: number;
}

/**
 * The label carries the destructive counts, SPLIT, because a removal is not a
 * replacement and collapsing them hides the consequential half.
 *
 * A plan whose only destructive act was deleting two creator channels read
 * "Replace 2 things" on the control that authorises it. Nothing else in the
 * product can register an existing voice channel as a creator channel, so that
 * removal is the one part only the attached snapshot can undo, and it gets its
 * own word.
 */
export function confirmLabel(counts: DestructiveCounts): string {
  const parts: string[] = [];
  if (counts.replaced > 0) parts.push(`Replace ${counts.replaced}`);
  if (counts.removed > 0) parts.push(`remove ${counts.removed}`);
  return parts.length === 0 ? 'Apply this configuration' : parts.join(', ');
}

/** How many stored things the plan overwrites, and how many it deletes. */
export function destructiveCount(plan: ImportPlan): DestructiveCounts {
  const settingsReplaced = plan.settingChanges.filter(
    (c) => c.before !== undefined && c.before !== null,
  ).length;
  const all = plan.creatorChanges.concat(plan.adoptedChanges);
  return {
    replaced: settingsReplaced + all.filter((c) => c.action === 'update').length,
    removed: all.filter((c) => c.action === 'remove').length,
  };
}

export interface RenderContext {
  /** Who ran the command. */
  actorId: string;
  fileName: string;
  source: 'native' | 'legacy';
}

/** Human labels for the settings keys, so no wire key reaches a reader. */
const SETTING_LABELS: Record<string, string> = {
  enabled: 'Automation',
  general: 'Default category name',
  channel_name_template: 'Default channel name template',
  channel_status_template: 'Default voice status template',
  aliases: 'Game aliases',
  custom_nicks: 'Member nicknames',
  logging: 'Event logging',
  log_level: 'Event logging detail',
  groups: 'Channel grouping',
  contact_user_id: 'Server contact',
  problem_alerts: 'Problem alerts',
};

const NOTE_LABELS: Record<ImportNoteCode, string> = {
  file_guild_mismatch: 'This file was exported from a different server',
  filename_guild_mismatch: 'This file is named after a different server',
  guild_not_hydrated: 'Still loading this server',
  too_many_creator_channels: 'Too many creator channels in the file',
  too_many_adopted_channels: 'Too many adopted channels in the file',
  channel_in_both_sections: 'A channel is listed twice in the file',
  every_channel_foreign_fleet: 'Every channel here is managed by another AVC bot',
  channel_missing: 'no longer exists in this server',
  channel_wrong_type: 'is not a voice channel any more',
  channel_foreign_fleet: 'is managed by another AVC bot in this server',
  channel_already_creator: 'is already a creator channel here',
  channel_already_adopted: 'is already an adopted channel here',
  channel_cannot_manage: 'AVC cannot see or manage it yet',
  channel_cannot_rename: 'AVC cannot rename it, so it was skipped',
  creator_removal_is_one_way:
    'will stop being a creator channel, and only re-importing the attached file brings it back',
  setting_invalid: 'the value was not usable',
  setting_over_limit: 'the value was too long or too large',
  setting_unknown_key: 'is not a setting AVC uses',
  logging_unresolved: 'that log channel does not exist here',
  group_unresolved: 'that category does not exist here',
  inheritperms_unresolved: 'the permission source channel does not exist here',
  contact_not_member: 'the named contact has left this server',
  contact_stamped: 'you are now recorded as the server contact for AVC problem notices',
  template_field_invalid: 'the template value was not usable',
  automation_switched_off: 'This file turns AVC off in this server',
  position_overwritten: 'Channel position is always rewritten by an old Python config',
  other_bot_may_be_present: 'Another AVC bot may still be managing these channels',
  legacy_field_dropped: 'is an old setting AVC no longer has',
  legacy_marked_left: 'This file was saved after the old bot was removed',
  orphaned_text_channel: 'was left behind by the old bot and is safe to delete',
  orphaned_role: 'is a role left behind by the old bot and is safe to delete',
};

/** A list, capped, with an honest tail. Never a silent truncation. */
function capped(items: readonly string[], cap: number): string {
  if (items.length === 0) return '';
  if (items.length <= cap) return items.join(', ');
  const shown = items.slice(0, cap).join(', ');
  return `${shown}, and ${items.length - cap} more`;
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Settings keys whose value is an id, and which kind, so no surface prints a
 * bare snowflake.
 *
 * A quoted 19-digit number tells a reader nothing, and in the public
 * announcement it is worse than nothing: a channel mention renders as
 * unresolvable to a viewer without access, while the raw id is a lookup anyone
 * can do. The contact stamp made this a common path rather than a rare one.
 */
const ID_SETTINGS: Record<string, 'channel' | 'user'> = {
  logging: 'channel',
  contact_user_id: 'user',
};

function describeValue(value: unknown, key?: string): string {
  if (value === undefined || value === null) return 'not set';
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value === '') return 'empty';
    const kind = key ? ID_SETTINGS[key] : undefined;
    if (kind && SNOWFLAKE.test(value)) return kind === 'channel' ? `<#${value}>` : `<@${value}>`;
    return `"${value}"`;
  }
  if (typeof value === 'object') {
    const size = Object.keys(value as Record<string, unknown>).length;
    return size === 1 ? '1 entry' : `${size} entries`;
  }
  return 'a new value';
}

/** The ephemeral preview, for the one admin who ran the command. */
export function renderPreview(plan: ImportPlan, ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`**Preview of \`${ctx.fileName}\`**`);
  lines.push(
    ctx.source === 'legacy' ? 'Read as an old Python bot configuration.' : 'Read as an AVC export.',
  );
  lines.push('');

  if (!plan.changed) {
    lines.push('Nothing would change. This file matches the current configuration.');
    return lines.join('\n');
  }

  const settingLines = plan.settingChanges.map(settingLine);
  if (settingLines.length > 0) {
    lines.push('**Settings**');
    lines.push(...cappedLines(settingLines, LIST_CAP));
    lines.push('');
  }

  const channelLines = plan.creatorChanges
    .concat(plan.adoptedChanges)
    .filter((c) => c.action !== 'remove')
    .map((c) => channelLine(c, false));
  if (channelLines.length > 0) {
    lines.push('**Channels**');
    lines.push(...cappedLines(channelLines, LIST_CAP));
    lines.push('');
  }

  const removalLines = removalSection(plan, false);
  if (removalLines.length > 0) {
    lines.push('**Removed**');
    lines.push(...cappedLines(removalLines, LIST_CAP));
    lines.push('');
  }

  const dropped = plan.notes.filter((n) => n.severity === 'dropped');
  if (dropped.length > 0) {
    lines.push('**Not applied**');
    lines.push(...cappedLines(dropped.map(noteLine), LIST_CAP));
    lines.push('');
  }

  /**
   * The two-bots warning gets its own section, above everything else.
   *
   * It is the only failure mode the headline flow produces EVERY time, and it
   * looks like the import broke something rather than like two bots doing what
   * they were told. As one line among ten in "Worth knowing" it was five
   * uninformative words that could be capped away entirely.
   */
  if (plan.notes.some((n) => n.code === 'other_bot_may_be_present')) {
    lines.push('**Read this first**');
    lines.push(
      '- Another AVC bot may still be managing these channels in this server. Two bots with the ' +
        'same creator channels each create a room on every join, so remove the other one first.',
    );
    lines.push('');
  }

  const warnings = plan.notes.filter(
    (n) => n.severity === 'warning' && n.code !== 'other_bot_may_be_present',
  );
  if (warnings.length > 0) {
    lines.push('**Worth knowing**');
    lines.push(...cappedLines(warnings.map(noteLine), LIST_CAP));
    lines.push('');
  }

  return composeWithFooter(lines, PREVIEW_FOOTER, MESSAGE_BUDGET);
}

/**
 * Always present, whatever else had to be cut.
 *
 * An admin who has just watched a command rewrite their server will assume it
 * touched billing unless told otherwise, and one whose confirm click lands on a
 * lapsed session needs to know a re-upload is safe.
 */
const PREVIEW_FOOTER = [
  'Subscription and trial state: unchanged. An import never touches it.',
  'The full plan is attached. This preview is good for 15 minutes.',
  'Re-uploading the file afterwards is safe and changes nothing on its own.',
];

function settingLine(change: SettingChange): string {
  const label = SETTING_LABELS[change.key] ?? change.key;
  if (change.cleared) {
    const removed = change.entriesRemoved.length;
    if (removed > 0 && change.key === 'custom_nicks') {
      return `${label}: cleared (${removed} removed)`;
    }
    return `${label}: back to the default (was ${describeValue(change.before, change.key)})`;
  }
  if (
    change.entriesAdded.length + change.entriesRemoved.length + change.entriesChanged.length >
    0
  ) {
    const parts: string[] = [];
    if (change.entriesAdded.length > 0) parts.push(`${change.entriesAdded.length} added`);
    if (change.entriesChanged.length > 0) parts.push(`${change.entriesChanged.length} changed`);
    if (change.entriesRemoved.length > 0) parts.push(`${change.entriesRemoved.length} removed`);
    return `${label}: ${parts.join(', ')}`;
  }
  return `${label}: ${describeValue(change.after, change.key)} (was ${describeValue(change.before, change.key)})`;
}

function channelLine(change: ChannelChange, isPublic: boolean): string {
  const name = isPublic ? `<#${change.channelId}>` : (change.name ?? `channel ${change.channelId}`);
  if (change.action === 'adopt') return `${name}: newly managed by AVC`;
  if (change.action === 'remove') return `${name}: no longer managed by AVC`;
  const fields = change.fields.map((f) => f.field).join(', ');
  return fields ? `${name}: ${fields} updated` : `${name}: updated`;
}

/**
 * The removal list, which §5.5 makes a hard requirement and which is the whole
 * reason replace is safe to offer.
 *
 * `custom_nicks` is a COUNT on every surface including this one, because the
 * entries are names members chose for themselves.
 */
function removalSection(plan: ImportPlan, isPublic: boolean): string[] {
  const out: string[] = [];
  const cap = isPublic ? PUBLIC_LIST_CAP : LIST_CAP;

  for (const change of plan.settingChanges) {
    if (change.entriesRemoved.length === 0) continue;
    const label = SETTING_LABELS[change.key] ?? change.key;
    if (change.key === 'custom_nicks') {
      out.push(`${change.entriesRemoved.length} member nicknames`);
      continue;
    }
    out.push(
      `${change.entriesRemoved.length} ${label.toLowerCase()}: ${capped(change.entriesRemoved, cap)}`,
    );
  }

  const removedChannels = plan.creatorChanges
    .concat(plan.adoptedChanges)
    .filter((c) => c.action === 'remove');
  for (const change of removedChannels) {
    const name = isPublic ? `<#${change.channelId}>` : (change.name ?? change.channelId);
    out.push(`${name} stops being managed by AVC`);
  }

  return out;
}

/** Notes that describe the whole import, so a subject prefix would be noise. */
const WHOLE_IMPORT_NOTES = new Set<ImportNoteCode>([
  'automation_switched_off',
  'position_overwritten',
  'other_bot_may_be_present',
  'legacy_marked_left',
]);

function noteLine(note: ImportNote): string {
  const label = NOTE_LABELS[note.code] ?? note.code;
  // A whole-import warning prefixed with the guild's own snowflake reads as if
  // something is wrong with a channel called 460459401086763010.
  if (WHOLE_IMPORT_NOTES.has(note.code)) return label;
  const subject = note.name ?? SETTING_LABELS[note.subject] ?? note.subject;
  const limit = note.limit !== undefined ? ` (limit ${note.limit})` : '';
  // Naming the permission is the difference between a line an admin can act on
  // and one they have to guess at.
  const missing =
    note.missingPermissions && note.missingPermissions.length > 0
      ? ` (needs ${note.missingPermissions.join(', ')})`
      : '';
  /**
   * The label is used as written, never lowercased.
   *
   * Four of them contain the product name, and `toLowerCase` turned them into
   * "avc cannot rename this channel" in the main preview an admin reads before
   * pressing a destructive button. The labels are phrased to sit after a colon
   * instead.
   */
  return `${subject}: ${label}${limit}${missing}`;
}

function cappedLines(lines: readonly string[], cap: number): string[] {
  const shown = lines.slice(0, cap).map((l) => `- ${l}`);
  if (lines.length > cap) shown.push(`- and ${lines.length - cap} more`);
  return shown;
}

/** Last resort, so a message can never exceed the limit even if a cap is missed. */
function trimTo(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget - 40).trimEnd()}\n(the rest is in the attached file)`;
}

/**
 * Body plus footer, with the FOOTER reserved.
 *
 * A plain trailing trim cuts whatever is last, and what is last here is the
 * load-bearing part: that billing was not touched, that the preview expires,
 * that an open setup panel is now stale, who to ask. A large guild is exactly
 * the case where those lines matter and exactly the case a trailing trim
 * removes them, which is how this was found. So the footer is measured first
 * and the body gets what is left.
 */
function composeWithFooter(
  bodyLines: readonly string[],
  footerLines: readonly string[],
  budget: number,
): string {
  const footer = footerLines.join('\n');
  const body = trimTo(bodyLines.join('\n'), Math.max(0, budget - footer.length - 2));
  return `${body}\n\n${footer}`;
}

/**
 * The system-channel announcement.
 *
 * Categories and counts, with a few examples, which is what decision 4 can
 * actually deliver in a 2000-character public post that may not carry an
 * attachment. No member data, and every channel and user as a mention so
 * Discord redacts per viewer.
 */
export function renderAnnouncement(plan: ImportPlan, ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push('**Auto Voice Channels configuration imported**');
  lines.push('');
  lines.push(`<@${ctx.actorId}> imported a configuration file into this server.`);
  lines.push('');

  const applied: string[] = [];
  for (const change of plan.settingChanges) applied.push(settingLine(change));
  for (const change of plan.creatorChanges.concat(plan.adoptedChanges)) {
    if (change.action === 'remove') continue;
    applied.push(channelLine(change, true));
  }
  if (applied.length > 0) {
    lines.push('**Applied**');
    lines.push(...cappedLines(applied, PUBLIC_LIST_CAP + 2));
    lines.push('');
  }

  const removals = removalSection(plan, true);
  if (removals.length > 0) {
    lines.push('**Removed**');
    lines.push(...cappedLines(removals, PUBLIC_LIST_CAP));
    lines.push('');
  }

  const dropped = plan.notes.filter((n) => n.severity === 'dropped');
  const notApplied: string[] = [];
  if (dropped.length > 0) {
    notApplied.push(
      dropped.length === 1
        ? '1 thing in the file could not be applied here'
        : `${dropped.length} things in the file could not be applied here`,
    );
  }
  notApplied.push('Subscription and trial state: an import never changes it');
  lines.push('**Not applied**');
  lines.push(...cappedLines(notApplied, PUBLIC_LIST_CAP));
  lines.push('');

  const footer: string[] = [];
  if (plan.notes.some((n) => n.code === 'automation_switched_off')) {
    footer.push('This file turned AVC off in this server. Run /setup to turn it back on.');
  }
  footer.push(
    'Any setup panel opened before now is out of date. Run the command again for a fresh one.',
  );
  footer.push(`If this was not expected, ask <@${ctx.actorId}>.`);

  return composeWithFooter(lines, footer, MESSAGE_BUDGET);
}

/** The guild's own event log, through the same capping renderer. */
export function renderLogEntry(plan: ImportPlan, ctx: RenderContext): string {
  const counts = [
    `${plan.settingChanges.length} settings`,
    `${plan.creatorWrites.length} creator channels`,
    `${plan.adoptedWrites.length} adopted channels`,
  ];
  const removals = plan.creatorRemovals.length + plan.adoptedRemovals.length;
  if (removals > 0) counts.push(`${removals} removed`);
  return trimTo(
    `📥 <@${ctx.actorId}> imported a configuration file (${counts.join(', ')}).`,
    MESSAGE_BUDGET,
  );
}

/**
 * The complete plan, as the attachment. Only the runner sees this, so it may
 * name everything.
 */
export function renderPlanFile(plan: ImportPlan, ctx: RenderContext): string {
  const lines: string[] = [
    `AVC configuration import plan`,
    `File: ${ctx.fileName}`,
    `Read as: ${ctx.source === 'legacy' ? 'old Python bot configuration' : 'AVC export'}`,
    '',
    'SETTINGS',
  ];
  for (const change of plan.settingChanges) {
    lines.push(`  ${settingLine(change)}`);
    for (const entry of change.entriesRemoved) lines.push(`    removed: ${entry}`);
    for (const entry of change.entriesAdded) lines.push(`    added: ${entry}`);
    for (const entry of change.entriesChanged) lines.push(`    changed: ${entry}`);
  }
  if (plan.settingChanges.length === 0) lines.push('  no changes');

  lines.push('', 'CREATOR CHANNELS');
  for (const change of plan.creatorChanges) {
    lines.push(`  ${channelLine(change, false)}`);
    for (const field of change.fields) {
      lines.push(
        `    ${field.field}: ${describeValue(field.after)} (was ${describeValue(field.before)})`,
      );
    }
  }
  if (plan.creatorChanges.length === 0) lines.push('  no changes');

  lines.push('', 'ADOPTED CHANNELS');
  for (const change of plan.adoptedChanges) lines.push(`  ${channelLine(change, false)}`);
  if (plan.adoptedChanges.length === 0) lines.push('  no changes');

  lines.push('', 'NOT APPLIED, AND WHY');
  for (const note of plan.notes.filter((n) => n.severity === 'dropped')) {
    lines.push(`  ${noteLine(note)}`);
  }

  lines.push('', 'WORTH KNOWING');
  for (const note of plan.notes.filter((n) => n.severity === 'warning')) {
    lines.push(`  ${noteLine(note)}`);
  }

  lines.push('', 'NEVER TOUCHED BY AN IMPORT');
  lines.push('  subscription state, trial state, grace period, billed tier');
  lines.push('  member counts and billing history');
  return `${lines.join('\n')}\n`;
}

/** What a refusal says, so the admin knows what to change. */
export function renderRefusals(notes: readonly ImportNote[]): string {
  const lines = ['**This file was not imported.**', ''];
  for (const note of notes) {
    const label = NOTE_LABELS[note.code] ?? note.code;
    if (note.code === 'file_guild_mismatch' || note.code === 'filename_guild_mismatch') {
      lines.push(
        `- ${label}. It names server ${note.other ?? 'unknown'} and this is server ${note.subject}. ` +
          'To copy a name template between servers, use /template.',
      );
      continue;
    }
    if (note.code === 'guild_not_hydrated') {
      lines.push('- AVC is still loading this server. Try again in a minute.');
      continue;
    }
    if (note.limit !== undefined) {
      lines.push(
        `- ${label}: the file has ${note.count ?? 'more'} and the limit is ${note.limit}.`,
      );
      continue;
    }
    if (note.code === 'every_channel_foreign_fleet') {
      lines.push(
        '- Every channel in this file is already managed by another AVC bot in this server, ' +
          'so importing it would change server settings only. Remove the other bot first if that is not what you want.',
      );
      continue;
    }
    lines.push(`- ${label}.`);
  }
  return trimTo(lines.join('\n'), MESSAGE_BUDGET);
}
