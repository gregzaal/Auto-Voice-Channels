import { ChannelType, type Attachment, type ChatInputCommandInteraction } from 'discord.js';
import type { ButtonInteraction, Guild, GuildBasedChannel } from 'discord.js';
import {
  diffGuildConfig,
  exportFilename,
  foreignFleetChannelOwners,
  fromLegacyPlan,
  fromNativeFile,
  hasLeft,
  IMPORT_LIMITS,
  otherFleetsInGuild,
  parseFilenameGuildId,
  parseLegacyJson,
  parseNativeFile,
  planGuild,
  RUNTIME_FLAGS,
  serializeGuildConfig,
  snapshotFilename,
  sniffFormat,
  type AutoChannelRepository,
  type ChannelFact,
  type Database,
  type Fleet,
  type GuildConfigFile,
  type GuildFacts,
  type ImportNote,
  type ImportPlan,
  type IncomingConfig,
  type Logger,
  type ManagedChannelRepository,
  type OpsAuditRepository,
  type RuntimeFlagsRepository,
} from '@avc/core';
import { PermissionFlagsBits } from 'discord.js';
import {
  buildExportFile,
  readCurrentConfig,
  type ConfigSnapshotDeps,
} from '../features/voice/configSnapshot.js';
import type { GuildSettingsService } from '../features/voice/settings.js';
import { CircuitOpenError } from '../runtime/circuitBreaker.js';
import { missingBotPermissions, missingRenamePermissions } from './setupPanel.js';
import {
  destructiveCount,
  importButtons,
  ImportSessionStore,
  renderAnnouncement,
  renderLogEntry,
  renderPlanFile,
  renderPreview,
  renderRefusals,
  type RenderContext,
} from './importPanel.js';

/**
 * `/export` and `/import`, kept out of `interactions.ts` because that file is
 * already 2000 lines and this flow has its own shape: two steps, a held plan, a
 * re-check of everything about the guild at confirm time, and an apply that is
 * deliberately not one transaction.
 *
 * The ordering rules that are not obvious and are load-bearing:
 *
 * - **The snapshot goes out BEFORE any write.** Every failure the write order is
 *   designed around would otherwise take the undo file with it: a process killed
 *   mid-apply leaves the only copy of the previous configuration in an
 *   `ops_audit` row the admin cannot read, and on a self-host there is no
 *   operator to read it either.
 * - **Settings are written LAST**, because `enabled` lives there with an
 *   immediate fleet-wide NOTIFY, so a crash before that point means it was never
 *   written rather than leaving the guild silently switched off.
 * - **The reconcile is fired AFTER the queued task returns, never awaited
 *   inside it.** `run()` is `dispatcher.dispatch`, whose queue runs tasks
 *   strictly sequentially with no timeout, so awaiting `reconcileGuild` from
 *   inside a queued task waits for a task that cannot start until the awaiting
 *   one finishes. The guild's queue would hang forever and every voice event for
 *   it would stop until the process restarted.
 * - **The three outbound Discord calls are outside the queue.** Nothing bounds a
 *   REST call subject to discord.js's automatic 429 retry, `GuildQueue.drain()`
 *   polls until idle with no timeout, and `gracefulDrain` blocks on it inside a
 *   30 second `kill_timeout` that the alert and backup schedulers already
 *   contend for.
 */

/** Hosts an attachment URL may point at. */
const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
/** The signed URL is Discord's, but the fetch is still ours to bound. */
const FETCH_TIMEOUT_MS = 10_000;
const SESSION_TTL_MS = 15 * 60 * 1000;

export interface ImportCommandDeps extends ConfigSnapshotDeps {
  db: Database;
  fleet: Fleet;
  autoChannels: AutoChannelRepository;
  managed: ManagedChannelRepository;
  settings: GuildSettingsService;
  flags: RuntimeFlagsRepository;
  opsAudit: OpsAuditRepository;
  /** The guild's own event log, at level 1. Best effort by contract. */
  serverLog: (guildId: string, level: 1 | 2 | 3, message: string) => void;
  /** Reconcile after an apply, fired outside the per-guild queue. */
  reconcileGuild: (guildId: string) => Promise<void>;
  /**
   * Routes the write phase through the per-guild queue, for ordering against
   * voice events and fault isolation.
   *
   * Passed in rather than taking the dispatcher, so this module cannot
   * accidentally dispatch a second task and deadlock the guild: `run` awaits a
   * strictly sequential queue, so a nested dispatch on the same guild waits for
   * a task that cannot start until the awaiting one finishes.
   */
  dispatchRun: <T>(guildId: string, name: string, task: () => Promise<T>) => Promise<T>;
  /**
   * Who is in a voice channel right now, for seeding a first-time adopt.
   *
   * `adoptChannel` seeds `ownerId` and `roster` from the live occupants, and an
   * import that adopts has to do the same or `@@creator@@` resolves to nothing
   * until the next time somebody joins or leaves.
   */
  membersInChannel: (channelId: string) => string[];
  /** This bot's application id, for the two-bots warning. */
  applicationId: string;
  logger: Logger;
  sessions: ImportSessionStore;
  counters?: ImportCounters;
}

/**
 * The numbers an operator actually needs, none of which is recoverable
 * afterwards from anything else.
 *
 * `countCommand` fires before the command switch, so for `/import` it counts the
 * PREVIEW: `commands.invoked` cannot tell fifty admins reading a diff from fifty
 * configurations replaced.
 */
export interface ImportCounters {
  previewed(): void;
  applied(): void;
  partiallyApplied(): void;
  refused(reason: string): void;
}

export function createImportSessionStore(): ImportSessionStore {
  return new ImportSessionStore({
    ttlMs: SESSION_TTL_MS,
    /**
     * Two per guild, not four.
     *
     * Nobody needs more than one preview open at a time and two leaves room for
     * a second attempt, while four made the per-instance cap reachable by eight
     * guilds, so a handful of admins could refuse `/import` for the ~1,380
     * others sharing the machine's shards.
     */
    perGuild: 2,
    /**
     * 32 held plans at roughly 2 MiB each (512 KiB of text, several times that
     * once parsed) is about 64 MiB, against the ~650 MB of V8 old space a prod
     * machine has spare. Refused rather than evicted, so an admin is told to
     * come back instead of losing a preview they were reading.
     */
    perInstance: 32,
  });
}

// -- /export ----------------------------------------------------------------

export async function handleExport(
  interaction: ChatInputCommandInteraction,
  deps: ImportCommandDeps,
): Promise<void> {
  const guildId = interaction.guildId!;
  await interaction.deferReply({ ephemeral: true });

  const [current, otherFleets] = await Promise.all([
    readCurrentConfig(deps, guildId),
    otherFleetsInGuild(deps.db, deps.fleet, guildId),
  ]);

  const now = new Date();
  const file = buildExportFile(current, {
    guildId,
    guildName: interaction.guild?.name ?? null,
    applicationId: deps.applicationId,
    otherFleetsPresent: otherFleets,
    channelName: (id) => interaction.guild?.channels.cache.get(id)?.name ?? null,
    exportedAt: now,
  });

  const text = serializeGuildConfig(file);
  const lines = [
    "Here is this server's AVC configuration.",
    '',
    `Creator channels: ${file.creator_channels.length}. Adopted channels: ${file.adopted_channels.length}.`,
    'The file lists channel ids, your templates and game aliases, the recorded server contact, ' +
      'and the names members chose for themselves with /nick.',
    'Anyone who gets the file gets all of that, so treat it the way you would treat a server backup.',
  ];
  if (otherFleets.length > 0) {
    lines.push(
      '',
      'Another AVC bot is also set up in this server. Its creator channels are managed separately ' +
        'and are not in this file.',
    );
  }
  const overCeiling = importCeilingsExceeded(file, text);
  if (overCeiling.length > 0) {
    /**
     * An export must never produce a file `/import` refuses, and saying so beats
     * an admin discovering it at the other end.
     *
     * The earlier wording said the file "can be read by a self-hosted instance",
     * which is true of nothing: `/import` is the only reader there is and it
     * applies the same limits wherever it runs.
     */
    lines.push(
      '',
      `This server is past what /import accepts (${overCeiling.join(', ')}), so this file is a ` +
        'record of your setup rather than something you can load back. ' +
        'Ask in the support server if you need to move a server this size.',
    );
  }

  await interaction.editReply({
    content: lines.join('\n'),
    files: [{ attachment: Buffer.from(text, 'utf8'), name: exportFilename(guildId, now) }],
  });
}

/**
 * Which import ceilings a file would breach, named for the copy.
 *
 * **The invariant is "`/export` must never produce a file `/import` refuses",
 * and the byte cap was the only half being checked.** The two array caps are
 * hard REFUSALS in the differ, so a guild past either had its only documented
 * rollback path be a file the command rejects, while being told the opposite at
 * the exact moment it mattered. `/docs/commands` publishes the undo as product
 * copy, which makes an unqualified promise here a claim the code does not
 * support.
 *
 * Empty for every real guild: the caps are 50 and 100 against a fleet mean of
 * 1.95 creator channels and 40 adopted rooms across the whole install base.
 */
function importCeilingsExceeded(file: GuildConfigFile, text: string): string[] {
  const over: string[] = [];
  if (text.length > IMPORT_LIMITS.attachmentBytes) {
    over.push(`over ${Math.round(IMPORT_LIMITS.attachmentBytes / 1024)} KB`);
  }
  if (file.creator_channels.length > IMPORT_LIMITS.creatorChannels) {
    over.push(`more than ${IMPORT_LIMITS.creatorChannels} creator channels`);
  }
  if (file.adopted_channels.length > IMPORT_LIMITS.adoptedChannels) {
    over.push(`more than ${IMPORT_LIMITS.adoptedChannels} adopted channels`);
  }
  const nicks = file.settings.custom_nicks;
  if (nicks !== null && Object.keys(nicks).length > IMPORT_LIMITS.customNicks) {
    over.push(`more than ${IMPORT_LIMITS.customNicks} member nicknames`);
  }
  return over;
}

// -- /import, step one: the preview -----------------------------------------

export async function handleImportCommand(
  interaction: ChatInputCommandInteraction,
  deps: ImportCommandDeps,
): Promise<void> {
  const guildId = interaction.guildId!;

  if (await importDisabled(deps)) {
    await interaction.reply({
      content: 'Configuration import is switched off right now. Try again later.',
      ephemeral: true,
    });
    return;
  }

  const attachment = interaction.options.getAttachment('file', true);

  // Refused from `attachment.size` before any request at all.
  if (attachment.size > IMPORT_LIMITS.attachmentBytes) {
    deps.counters?.refused('oversize');
    await interaction.reply({
      content:
        `That file is ${Math.round(attachment.size / 1024)} KB and the limit is ` +
        `${Math.round(IMPORT_LIMITS.attachmentBytes / 1024)} KB.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild || !hydrated(guild)) {
    deps.counters?.refused('not_hydrated');
    await interaction.editReply(
      'AVC is still loading this server, so it cannot tell which channels exist yet. ' +
        'Try again in a minute.',
    );
    return;
  }

  const text = await fetchAttachment(attachment, deps);
  if (!text.ok) {
    deps.counters?.refused(text.reason);
    await interaction.editReply(text.message);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseLegacyJson(text.text);
  } catch (err) {
    deps.counters?.refused('unreadable');
    // The parser's own reason, and nothing from the file itself: an error here
    // reaches `reportError`, which posts to the admin channel.
    await interaction.editReply(
      `That file could not be read as JSON (${err instanceof Error ? err.message : 'unknown error'}). ` +
        'If it came from /export, upload it again without editing it.',
    );
    return;
  }

  const read = readIncoming(parsed, attachment.name, guildId);
  if (!read.ok) {
    deps.counters?.refused('unreadable');
    await interaction.editReply(`That file was not usable: ${read.reason}`);
    return;
  }

  const facts = await buildFacts(guild, read.incoming, interaction.user.id, deps);
  const current = await readCurrentConfig(deps, guildId);
  const result = diffGuildConfig(read.incoming, current, facts);

  const ctx: RenderContext = {
    actorId: interaction.user.id,
    fileName: attachment.name,
    source: read.incoming.source,
  };

  if (!result.ok) {
    deps.counters?.refused(result.refusals[0]?.code ?? 'refused');
    await interaction.editReply(renderRefusals(result.refusals));
    return;
  }

  if (!result.plan.changed) {
    await interaction.editReply(
      'Nothing would change. This file matches the current configuration, so there is nothing to apply.',
    );
    return;
  }

  const sessionId = newSessionId(interaction.id);
  const stored = deps.sessions.put(sessionId, {
    guildId,
    userId: interaction.user.id,
    plan: result.plan,
    fileName: attachment.name,
    fileSize: attachment.size,
    createdAt: Date.now(),
  });
  if (!stored.ok) {
    deps.counters?.refused(`session_${stored.reason}`);
    await interaction.editReply(
      stored.reason === 'per_guild'
        ? `There are already ${stored.limit} imports waiting for a decision in this server. ` +
            'Finish or cancel one of those first.'
        : 'Too many imports are being previewed right now. Try again in a few minutes.',
    );
    return;
  }

  deps.counters?.previewed();
  await interaction.editReply({
    content: renderPreview(result.plan, ctx),
    components: [importButtons(sessionId, destructiveCount(result.plan))],
    files: [
      {
        attachment: Buffer.from(renderPlanFile(result.plan, ctx), 'utf8'),
        name: `avc-import-plan-${guildId}.txt`,
      },
    ],
  });
}

// -- /import, step two: the apply -------------------------------------------

export async function handleImportButton(
  interaction: ButtonInteraction,
  deps: ImportCommandDeps,
): Promise<void> {
  const parts = interaction.customId.split(':');
  const action = parts[2];
  const sessionId = parts.slice(3).join(':');

  if (action === 'cancel') {
    deps.sessions.drop(sessionId);
    await interaction.update({
      content: 'Cancelled. Nothing was imported.',
      components: [],
      files: [],
    });
    return;
  }
  if (action !== 'confirm') return;

  /**
   * Claim by deleting, before anything else, so a second click cannot apply the
   * same plan. Stripping the components in the same act closes the window that
   * a slow apply would otherwise leave open.
   */
  const session = deps.sessions.claim(sessionId);
  if (!session) {
    const already = deps.sessions.wasApplied(sessionId);
    await interaction.update({
      content: already
        ? 'This import already ran. Scroll up for what it did.'
        : 'That preview expired, so nothing was imported. Upload the file again to start over.',
      components: [],
    });
    return;
  }

  // The preview is ephemeral so only the runner can click it, but their roles
  // can change in between, and the default permission is a default rather than
  // a gate: a server admin can re-open the command to any role.
  if (
    interaction.guildId !== session.guildId ||
    interaction.user.id !== session.userId ||
    !hasManageGuild(interaction)
  ) {
    await interaction.update({
      content: 'You need the Manage Server permission to apply an import.',
      components: [],
    });
    return;
  }

  if (await importDisabled(deps)) {
    await interaction.update({
      content:
        'Configuration import was switched off while this was waiting. Nothing was imported.',
      components: [],
    });
    return;
  }

  await interaction.update({ content: 'Applying...', components: [], files: [] });

  const guildId = session.guildId;
  const guild = interaction.guild;
  if (!guild || !hydrated(guild)) {
    await interaction.followUp({
      content:
        'AVC lost sight of this server between the preview and now, so nothing was imported. Try again.',
      ephemeral: true,
    });
    return;
  }

  const ctx: RenderContext = {
    actorId: interaction.user.id,
    fileName: session.fileName,
    source: session.plan.source,
  };

  const outcome = await applyImport(interaction, guild, session.plan, ctx, deps);

  // Outside the queue: none of these touches guild state, and a file upload
  // subject to a 429 retry must not sit inside the drain window.
  if (outcome.reconcileNeeded) {
    // Fired, not awaited inside the queued task. See the module comment.
    void deps.reconcileGuild(guildId).catch((err: unknown) => {
      deps.logger.warn({ err, guildId }, 'post-import reconcile failed');
    });
  }

  /**
   * Nothing landed means nothing to tell anyone.
   *
   * A no-op re-run must not post, or an admin retrying a file spams the channel,
   * and a write phase that was refused outright must not be announced as a
   * configuration change at all.
   */
  if (outcome.applied.changed) deps.serverLog(guildId, 1, renderLogEntry(outcome.applied, ctx));

  /**
   * Skipped when the flag is set, and reported as not posted either way, so the
   * reply never claims other admins were told when they were not.
   *
   * This is the second unsolicited push the bot makes into a guild and the flag
   * is its own lever, separate from the kill switch: taking away the command is
   * the wrong answer to a notice that turns out to be wrong for a server.
   */
  const announceSuppressed = !outcome.applied.changed || (await announceDisabled(deps));
  const announced = announceSuppressed
    ? 'not_posted'
    : await announce(guild, renderAnnouncement(outcome.applied, ctx), deps);

  const lines: string[] = [];
  if (!outcome.applied.changed) {
    // The write phase was refused or every step failed. Saying "imported" here
    // would be the single most misleading thing this command could print.
    lines.push('Nothing was imported.');
  } else {
    lines.push(
      outcome.failures.length === 0
        ? 'Imported. The configuration in the file is now live in this server.'
        : 'Partly imported. Some steps did not finish, listed below. Running the same import again is safe.',
    );
  }
  for (const failure of outcome.failures) lines.push(`- ${failure}`);
  if (outcome.driftedKeys.length > 0) {
    lines.push(
      `- ${outcome.driftedKeys.length} setting(s) had been changed by somebody else since the ` +
        'preview, so what was replaced is not what the preview showed.',
    );
  }
  if (announced !== 'posted' && !announceSuppressed) {
    // Only when the post was actually attempted and did not land. Saying this
    // because a flag suppressed it, or because nothing changed, would be a
    // confident statement about a server's channels that is simply untrue.
    lines.push('Nobody else was notified. This server has no system channel AVC can post in.');
  }
  if (outcome.applied.changed) {
    lines.push(
      'Any setup panel you had open before now is out of date. Run the command again for a fresh one.',
    );
  }
  if (outcome.applied.creatorRemovals.length > 0) {
    /**
     * Said here because nothing else in the product can put it back.
     * `createPrimary` always creates a NEW Discord channel, so no command turns
     * an existing voice channel back into a creator channel, and the attached
     * snapshot is the only route. Section 5.5a rule 3 asks for exactly this.
     */
    const n = outcome.applied.creatorRemovals.length;
    lines.push(
      `${n === 1 ? '1 channel' : `${n} channels`} stopped being a creator channel. ` +
        'No command puts that back, so the file above is the only way to restore it.',
    );
  }
  if (outcome.snapshotDelivered && outcome.snapshotReimportable) {
    lines.push('Your previous configuration is in the file above. Import it to undo this.');
  } else if (outcome.snapshotDelivered) {
    lines.push(
      'Your previous configuration is in the file above. This server is past what /import accepts, ' +
        'so ask in the support server if you need it restored.',
    );
  } else {
    // Promising a file that is not there is worse than admitting it is missing:
    // the admin would go looking, and the operator record is the only route left.
    lines.push(
      'The file holding your previous configuration could not be attached. ' +
        'It is recorded on our side, so ask in the support server if you need it back.',
    );
  }

  await interaction.followUp({
    content: lines.filter(Boolean).join('\n'),
    ephemeral: true,
  });

  if (outcome.failures.length > 0) deps.counters?.partiallyApplied();
  else deps.counters?.applied();
}

interface ApplyOutcome {
  applied: ImportPlan;
  failures: string[];
  driftedKeys: string[];
  reconcileNeeded: boolean;
  /**
   * False when the pre-import snapshot could not be delivered.
   *
   * The reply points at that file as the undo, so it has to stop doing that when
   * the file is not there: an admin told to import it would go looking for
   * something that does not exist.
   */
  snapshotDelivered: boolean;
  /**
   * False when the snapshot is past an import ceiling, so it is a record rather
   * than a working undo. Only reachable for a guild far outside the caps.
   */
  snapshotReimportable: boolean;
}

async function applyImport(
  interaction: ButtonInteraction,
  guild: Guild,
  previewPlan: ImportPlan,
  ctx: RenderContext,
  deps: ImportCommandDeps,
): Promise<ApplyOutcome> {
  const guildId = guild.id;
  const failures: string[] = [];

  // Everything about the GUILD is re-read here, which is the whole reason the
  // file is not re-fetched: the plan applied is the plan previewed, and the
  // state it is applied to is current.
  const facts = await buildApplyFacts(guild, previewPlan, interaction.user.id, deps);
  const current = await readCurrentConfig(deps, guildId);
  const snapshot = buildExportFile(current, {
    guildId,
    guildName: guild.name,
    applicationId: deps.applicationId,
    otherFleetsPresent: facts.otherFleetsPresent,
    channelName: (id) => guild.channels.cache.get(id)?.name ?? null,
    exportedAt: new Date(),
  });

  /**
   * The undo, handed over BEFORE anything is written.
   *
   * On the old ordering this was the last step, so a process killed mid-apply
   * took it with it and left the only copy inside an audit row the admin cannot
   * read. Self-host has no operator to read it either.
   */
  let snapshotDelivered = true;
  const snapshotText = serializeGuildConfig(snapshot);
  const snapshotOverCeiling = importCeilingsExceeded(snapshot, snapshotText);
  await interaction
    .followUp({
      content:
        "Before anything is written, here is this server's current configuration. " +
        'Nothing has changed yet. ' +
        (snapshotOverCeiling.length === 0
          ? 'Keep this file: importing it undoes what happens next.'
          : // Never call it an undo when /import would refuse it. This is the one
            // moment the claim has to be true.
            'Keep this file as a record. This server is past what /import accepts ' +
            `(${snapshotOverCeiling.join(', ')}), so it cannot be loaded back through the ` +
            'command. Ask in the support server if you need to roll this back.'),
      files: [
        {
          attachment: Buffer.from(snapshotText, 'utf8'),
          name: snapshotFilename(guildId, new Date()),
        },
      ],
      ephemeral: true,
    })
    .catch((err: unknown) => {
      // Not fatal: the same snapshot goes into the audit row below. But the
      // reply must stop pointing at a file that is not there.
      deps.logger.warn({ err, guildId }, 'could not deliver the pre-import snapshot');
      failures.push('the pre-import snapshot could not be attached');
      snapshotDelivered = false;
    });

  await deps.opsAudit
    .record({
      actor: interaction.user.id,
      action: 'guild.config_import',
      target: guildId,
      details: auditDetails(previewPlan, ctx, snapshot),
    })
    .catch((err: unknown) => {
      deps.logger.error({ err, guildId }, 'could not write the import audit row');
      failures.push('the audit record could not be written');
    });

  /**
   * Only the writes need the per-guild ordering guarantee against voice events.
   *
   * **The dispatch itself can be REFUSED**, which is different from a write
   * inside it failing, and leaving it uncaught was worse than either. The
   * per-guild circuit breaker is shared across task types, so a guild already
   * failing at voice automation refuses this for reasons unrelated to the
   * import, and a queue draining during a rolling deploy refuses it too. The
   * throw then escaped to `route`'s catch, which shows a generic error, the
   * session had already been claimed so a retry said "this import already ran",
   * and the first audit row stood with no completion row, which the new
   * `/api/watch` check reads as a stranded import.
   *
   * Nothing was written in that case, so the honest report is exactly that.
   */
  let applied: { plan: ImportPlan; driftedKeys: string[] };
  try {
    applied = await deps.dispatchRun(guildId, 'cmd:import', async () => {
      return applyImportWrites(previewPlan, guildId, facts, deps, failures);
    });
  } catch (err) {
    deps.logger.warn({ err, guildId }, 'import write phase was refused');
    failures.push(
      isCircuitOpen(err)
        ? 'this server is in a failure cooldown, so nothing was written. Try again in about ' +
            `${Math.max(1, Math.round(err.retryAfterMs / 1000))} seconds`
        : 'the write could not be started, so nothing was written',
    );
    applied = { plan: emptyPlan(previewPlan), driftedKeys: [] };
  }

  await deps.opsAudit
    .record({
      actor: interaction.user.id,
      action: 'guild.config_import.done',
      target: guildId,
      details: {
        settingsWritten: Object.keys(applied.plan.settingsPatch).length,
        settingsCleared: applied.plan.settingsRemove.length,
        creatorChannels: applied.plan.creatorWrites.length,
        creatorRemovals: applied.plan.creatorRemovals.length,
        adoptedChannels: applied.plan.adoptedWrites.length,
        adoptedRemovals: applied.plan.adoptedRemovals.length,
        failures,
        driftedKeys: applied.driftedKeys,
      },
    })
    .catch((err: unknown) => {
      deps.logger.error({ err, guildId }, 'could not write the import completion row');
    });

  return {
    applied: applied.plan,
    failures,
    driftedKeys: applied.driftedKeys,
    reconcileNeeded:
      applied.plan.creatorWrites.length > 0 ||
      applied.plan.adoptedWrites.length > 0 ||
      applied.plan.settingsRemove.length > 0 ||
      Object.keys(applied.plan.settingsPatch).length > 0,
    snapshotDelivered,
    snapshotReimportable: snapshotOverCeiling.length === 0,
  };
}

/**
 * `true` when the per-guild queue refused the task rather than running it.
 *
 * `instanceof`, not a string match on the message: the class exists and carries
 * `retryAfterMs`, so a regex would be guessing at something the type system can
 * answer.
 */
function isCircuitOpen(err: unknown): err is CircuitOpenError {
  return err instanceof CircuitOpenError;
}

/**
 * The same plan with nothing in it, for reporting a write phase that never ran.
 *
 * Keeps the announcement, the log entry and the reply describing what LANDED
 * rather than what was intended, which is the difference between "partly
 * imported, here is what did not finish" and a public post claiming a
 * configuration was replaced when it was not.
 */
function emptyPlan(plan: ImportPlan): ImportPlan {
  return {
    ...plan,
    settingsPatch: {},
    settingsRemove: [],
    creatorWrites: [],
    creatorRemovals: [],
    adoptedWrites: [],
    adoptedRemovals: [],
    settingChanges: [],
    creatorChanges: [],
    adoptedChanges: [],
    changed: false,
  };
}

/**
 * What the write phase needs, and nothing else.
 *
 * Narrower than {@link ImportCommandDeps} so the risky half can be exercised
 * against a real database without a Discord fake: `create` is
 * `onConflictDoNothing` and `updateState` replaces a whole jsonb column, and
 * neither behaviour is visible to a unit test.
 */
export interface ImportWriteDeps {
  autoChannels: AutoChannelRepository;
  managed: ManagedChannelRepository;
  settings: Pick<GuildSettingsService, 'applyImportedSettings'>;
  /** Live occupants, for seeding a first-time adopt the way `adoptChannel` does. */
  membersInChannel: (channelId: string) => string[];
  logger: Logger;
}

/** The write phase, in the order the design fixes. */
export async function applyImportWrites(
  plan: ImportPlan,
  guildId: string,
  facts: GuildFacts,
  deps: ImportWriteDeps,
  failures: string[],
): Promise<{ plan: ImportPlan; driftedKeys: string[] }> {
  /**
   * What actually LANDED, accumulated as we go.
   *
   * The intended plan was returned before, so a run where half the writes failed
   * was announced publicly and written to the guild's event log as a complete
   * success. Every reader of this result describes what happened, so it has to
   * be what happened.
   */
  const landedCreatorWrites: ImportPlan['creatorWrites'] = [];
  const landedCreatorRemovals: string[] = [];
  const landedAdoptedWrites: ImportPlan['adoptedWrites'] = [];
  const landedAdoptedRemovals: string[] = [];
  let landedSettings = false;
  // Creator channels, each re-resolved: a channel deleted since the preview
  // would otherwise get a PERMANENT phantom row, because only a channelDelete
  // dispatch removes one and the deletion happened before the row existed.
  for (const write of plan.creatorWrites) {
    if (!stillWritable(write.channelId, facts, { needsRename: false })) {
      failures.push('a creator channel changed before it could be written, so it was skipped');
      continue;
    }
    try {
      await deps.autoChannels.upsert(guildId, write.channelId, write.template);
      landedCreatorWrites.push(write);
    } catch (err) {
      deps.logger.warn({ err, guildId, channelId: write.channelId }, 'import creator write failed');
      failures.push('a creator channel could not be written');
    }
  }
  for (const channelId of plan.creatorRemovals) {
    try {
      await deps.autoChannels.remove(guildId, channelId);
      landedCreatorRemovals.push(channelId);
    } catch (err) {
      deps.logger.warn({ err, guildId, channelId }, 'import creator removal failed');
      failures.push('a creator channel could not be removed');
    }
  }

  // Adopted channels: create (which no-ops when already adopted and returns the
  // existing row), then setTemplate for the already-adopted case, then the
  // merged state. `create` is where owner and roster get seeded from the live
  // occupants, matching `adoptChannel`, or `@@creator@@` resolves to nothing
  // until the next occupancy change.
  for (const write of plan.adoptedWrites) {
    if (!stillWritable(write.channelId, facts, { needsRename: true })) {
      failures.push('an adopted channel changed before it could be written, so it was skipped');
      continue;
    }
    try {
      /**
       * Owner and roster from the LIVE occupants on a first-time adopt, matching
       * `adoptChannel`.
       *
       * `roster` is arrival order and is what picks `@@creator@@` and the owner.
       * The file deliberately does not carry it (importing one moment's arrival
       * order would name somebody who is not in the channel), so an adopt that
       * seeded neither left the channel with no owner until the next occupancy
       * change, which for an idle channel is indefinitely. Only on a first-time
       * adopt: an existing row's roster is the bot's own live state and
       * `write.state` already preserves it.
       */
      const roster = write.firstTime ? deps.membersInChannel(write.channelId) : [];
      const state = write.firstTime ? { ...write.state, roster } : write.state;
      await deps.managed.create({
        channelId: write.channelId,
        guildId,
        ownerId: roster[0] ?? null,
        template: write.template,
        state,
      });
      /**
       * The two follow-up writes are for an ALREADY-adopted channel only.
       *
       * `create` is `onConflictDoNothing`, so on an existing row it changes
       * nothing and these are what apply the template and the merged state. On a
       * first-time adopt `create` has just written both, so repeating them is
       * two round trips per channel for no effect, and at the adopted cap that
       * is 200 of them inside the queued phase the 30s drain has to fit.
       */
      if (!write.firstTime) {
        await deps.managed.setTemplate(guildId, write.channelId, write.template);
        await deps.managed.updateState(guildId, write.channelId, state);
      }
      landedAdoptedWrites.push(write);
    } catch (err) {
      deps.logger.warn({ err, guildId, channelId: write.channelId }, 'import adopted write failed');
      failures.push('an adopted channel could not be written');
    }
  }
  for (const channelId of plan.adoptedRemovals) {
    try {
      await deps.managed.remove(guildId, channelId);
      landedAdoptedRemovals.push(channelId);
    } catch (err) {
      deps.logger.warn({ err, guildId, channelId }, 'import adopted removal failed');
      failures.push('an adopted channel could not be removed');
    }
  }

  // Settings LAST, one transaction, one NOTIFY. `enabled` lives here and takes
  // effect fleet-wide the moment the NOTIFY lands, so a crash before this point
  // means it was never written.
  let driftedKeys: string[] = [];
  if (Object.keys(plan.settingsPatch).length > 0 || plan.settingsRemove.length > 0) {
    try {
      /**
       * What the PREVIEW saw, key by key, taken from the plan's own change list.
       *
       * The drift check compares this against the value under the row lock, so
       * both sides are raw stored values and a concurrent `/alias` or `/nick`
       * landing in the window is actually reported instead of being silently
       * replaced.
       */
      const expectedBefore: Record<string, unknown> = {};
      for (const change of plan.settingChanges) expectedBefore[change.key] = change.before;

      const result = await deps.settings.applyImportedSettings(
        guildId,
        plan.settingsPatch,
        plan.settingsRemove,
        expectedBefore,
      );
      driftedKeys = result.driftedKeys;
      landedSettings = true;
    } catch (err) {
      deps.logger.error({ err, guildId }, 'import settings write failed');
      failures.push('the server settings could not be written');
    }
  }

  /**
   * The plan as it happened, so the announcement, the log entry and the
   * completion audit row all describe reality.
   *
   * The change lists are narrowed to the ids that landed, because the renderers
   * read those rather than the write arrays.
   */
  const landedIds = new Set<string>([
    ...landedCreatorWrites.map((w) => w.channelId),
    ...landedCreatorRemovals,
    ...landedAdoptedWrites.map((w) => w.channelId),
    ...landedAdoptedRemovals,
  ]);
  const landed: ImportPlan = {
    ...plan,
    settingsPatch: landedSettings ? plan.settingsPatch : {},
    settingsRemove: landedSettings ? plan.settingsRemove : [],
    creatorWrites: landedCreatorWrites,
    creatorRemovals: landedCreatorRemovals,
    adoptedWrites: landedAdoptedWrites,
    adoptedRemovals: landedAdoptedRemovals,
    settingChanges: landedSettings ? plan.settingChanges : [],
    creatorChanges: plan.creatorChanges.filter((c) => landedIds.has(c.channelId)),
    adoptedChanges: plan.adoptedChanges.filter((c) => landedIds.has(c.channelId)),
    changed:
      landedSettings ||
      landedCreatorWrites.length > 0 ||
      landedCreatorRemovals.length > 0 ||
      landedAdoptedWrites.length > 0 ||
      landedAdoptedRemovals.length > 0,
  };

  return { plan: landed, driftedKeys };
}

/**
 * The apply-time re-check, which is section 5.2 step 6 rather than a presence
 * test.
 *
 * `needsRename` is what makes an adopted channel different, and it is not
 * optional: writing a `managed_channels` row for a channel the bot can no longer
 * rename makes the next sweep call `rerenderManaged` with
 * `onUnmanageable: 'abandon'`, which deletes the row AND records a permission
 * problem, which fires the outbound notifier ladder. The preview refuses that
 * case, and a permission removed during the 15-minute window would otherwise
 * walk straight past it.
 */
function stillWritable(
  channelId: string,
  facts: GuildFacts,
  opts: { needsRename: boolean },
): boolean {
  const fact = facts.channels.get(channelId);
  if (!fact) return false;
  if (facts.foreignFleetChannels.has(channelId)) return false;
  if (fact.kind !== 'voice') return false;
  return !opts.needsRename || fact.botCanRename;
}

/** What row one carries, bounded, with member data redacted. */
function auditDetails(
  plan: ImportPlan,
  ctx: RenderContext,
  snapshot: ReturnType<typeof buildExportFile>,
): Record<string, unknown> {
  const redacted = {
    ...snapshot,
    settings: {
      ...snapshot.settings,
      // Keys and a count, never the names members chose for themselves. The
      // privacy policy covers ids and per-server settings, which is ids, not
      // member-chosen text, and this table is backed up under GFS retention.
      custom_nicks:
        snapshot.settings.custom_nicks === null
          ? null
          : { redactedEntryCount: Object.keys(snapshot.settings.custom_nicks).length },
    },
  };
  const text = JSON.stringify(redacted);
  const BUDGET = 64 * 1024;
  return {
    file: ctx.fileName,
    source: ctx.source,
    settingsToWrite: Object.keys(plan.settingsPatch),
    settingsToClear: plan.settingsRemove,
    creatorWrites: plan.creatorWrites.map((w) => w.channelId),
    creatorRemovals: plan.creatorRemovals,
    adoptedWrites: plan.adoptedWrites.map((w) => w.channelId),
    adoptedRemovals: plan.adoptedRemovals,
    dropped: plan.notes.filter((n) => n.severity === 'dropped').map(noteSummary),
    // `/admin/ops` renders `details` into a table cell, so a fat row makes the
    // page that hosts the kill switch the slowest to load, during the incident
    // that sends you there.
    snapshot: text.length <= BUDGET ? redacted : { tooLargeBytes: text.length },
  };
}

function noteSummary(note: ImportNote): Record<string, unknown> {
  return { code: note.code, subject: note.subject };
}

/**
 * The system channel, and nowhere else.
 *
 * No DM rung and no creator-channel rung: the permission notifier's ladder
 * exists to reach a guild whose automation has stopped with nobody present, and
 * here an admin is standing in front of a reply. Never an arbitrary text
 * channel, which is what spam bots do and what honeypot channels auto-ban for.
 */
async function announce(
  guild: Guild,
  content: string,
  deps: ImportCommandDeps,
): Promise<'posted' | 'not_posted'> {
  const channel = guild.systemChannel;
  if (!channel) return 'not_posted';
  try {
    await channel.send({ content, allowedMentions: { parse: [] } });
    return 'posted';
  } catch (err) {
    deps.logger.warn({ err, guildId: guild.id }, 'import announcement failed');
    return 'not_posted';
  }
}

// -- reading the file -------------------------------------------------------

type ReadResult = { ok: true; incoming: IncomingConfig } | { ok: false; reason: string };

function readIncoming(parsed: unknown, fileName: string, guildId: string): ReadResult {
  const sniff = sniffFormat(parsed);
  if (sniff.format === 'unreadable') return { ok: false, reason: sniff.reason };

  if (sniff.format === 'native') {
    const file = parseNativeFile(parsed);
    if (!file.ok) return { ok: false, reason: file.reason };
    return { ok: true, incoming: fromNativeFile(file.file) };
  }

  /**
   * Legacy. `left` is stripped BEFORE planning and recorded first, because
   * `planGuild` returns early for a guild marked left with every field empty,
   * including the dropped-fields and orphan lists the preview wants, and because
   * `left` is itself in DROPPED_FIELDS so stripping it removes the evidence.
   *
   * A stale stamp is ordinary: the guild running the command is present by
   * definition, and its file may date from a period when the old bot was removed.
   */
  const raw = parsed as Record<string, unknown>;
  const wasMarkedLeft = hasLeft(raw as never);
  const stripped: Record<string, unknown> = { ...raw };
  delete stripped.left;

  /**
   * The guild running the command, not a placeholder.
   *
   * `planGuild` only uses it to stamp its own output and to consult
   * `liveGuildIds` (which a per-guild caller does not pass), so a placeholder
   * would be inert. It is still the wrong thing to write: the plan would carry
   * an id that is not this guild's, and the next reader has to work out whether
   * that matters.
   *
   * `fromLegacyPlan` still reports `guildId: null` on the INCOMING config, and
   * that is the semantically load-bearing part: a legacy FILE carries no guild
   * id of its own, which is why the filename is the only cross-guild check
   * available for that format.
   */
  const plan = planGuild(guildId, stripped, {});
  /**
   * A JSON object with nothing recognisable in it is not a legacy config.
   *
   * Sniffing treats any object without `avc_export_version` as legacy, which is
   * correct for the real corpus and wrong for a file somebody uploaded by
   * mistake. Without this, an unrelated JSON file produced an empty plan and the
   * reply said "this file matches the current configuration", which is a
   * confident statement about a file we could not read.
   */
  if (Object.keys(plan.settings).length === 0 && plan.primaries.length === 0) {
    return {
      ok: false,
      reason:
        'it does not look like an AVC export or an old Python bot configuration. ' +
        'If it came from /export, upload it again without editing it.',
    };
  }
  return {
    ok: true,
    incoming: fromLegacyPlan(plan, {
      wasMarkedLeft,
      filenameGuildId: parseFilenameGuildId(fileName),
    }),
  };
}

type FetchResult = { ok: true; text: string } | { ok: false; reason: string; message: string };

async function fetchAttachment(
  attachment: Attachment,
  deps: ImportCommandDeps,
): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    return { ok: false, reason: 'bad_url', message: 'That attachment could not be read.' };
  }
  /**
   * Host-pinned. The URL is not one we minted, we received it, and the health
   * server binds all interfaces while Postgres and every sibling Fly app sit on
   * the same private IPv6 mesh, so an unpinned fetch here is an SSRF primitive
   * on an admin-triggerable path.
   */
  if (url.protocol !== 'https:' || !ATTACHMENT_HOSTS.has(url.hostname)) {
    deps.logger.warn({ host: url.hostname }, 'refused an attachment from an unexpected host');
    return {
      ok: false,
      reason: 'bad_host',
      message: 'That attachment is not hosted by Discord, so it was not fetched.',
    };
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'fetch_failed',
        message: 'Discord would not hand over that attachment. Try uploading it again.',
      };
    }
    const text = await response.text();
    // Belt and braces: `attachment.size` was already checked, but the body is
    // what we actually parse.
    if (text.length > IMPORT_LIMITS.attachmentBytes) {
      return {
        ok: false,
        reason: 'oversize',
        message: 'That file is larger than /import accepts.',
      };
    }
    return { ok: true, text };
  } catch (err) {
    deps.logger.warn({ err }, 'attachment fetch failed');
    return {
      ok: false,
      reason: 'fetch_failed',
      message: 'That attachment could not be downloaded in time. Try again.',
    };
  }
}

// -- the guild, as facts ----------------------------------------------------

/**
 * A guild with an empty channel cache is one that is not hydrated, not one with
 * no channels.
 *
 * `READY` stubs every guild as unavailable and `WebSocketShard.checkReady` marks
 * the shard ready once `waitGuildTimeout` expires with guilds still outstanding,
 * while commands register globally and are clickable immediately. `/setup` fails
 * open on this and the reconciler bails on it; an import must REFUSE, because
 * here the admin can confirm past a preview claiming their setup has vanished.
 */
function hydrated(guild: Guild): boolean {
  return guild.available && guild.channels.cache.size > 0;
}

/** The channel cache, as facts. Shared by both callers. */
function channelFacts(guild: Guild): Map<string, ChannelFact> {
  const channels = new Map<string, ChannelFact>();
  for (const [id, channel] of guild.channels.cache) {
    channels.set(id, channelFact(guild, channel));
  }
  return channels;
}

async function fleetFacts(
  guild: Guild,
  ids: readonly string[],
  deps: ImportCommandDeps,
): Promise<Pick<GuildFacts, 'foreignFleetChannels' | 'otherFleetsPresent'>> {
  const [foreignFleetChannels, otherFleetsPresent] = await Promise.all([
    foreignFleetChannelOwners(deps.db, deps.fleet, ids),
    otherFleetsInGuild(deps.db, deps.fleet, guild.id),
  ]);
  return { foreignFleetChannels, otherFleetsPresent };
}

/** Facts for the preview: what the FILE names, resolved against the guild. */
async function buildFacts(
  guild: Guild,
  incoming: IncomingConfig,
  actorId: string,
  deps: ImportCommandDeps,
): Promise<GuildFacts> {
  const ids = [
    ...incoming.creatorChannels.map((c) => c.channelId),
    ...incoming.adoptedChannels.map((c) => c.channelId),
  ];

  // Only the contact needs resolving, and only when the file names one. A
  // failed fetch counts as "not a member", which is the safe reading: the
  // contact receives an unsolicited DM and an @-ping when automation breaks.
  const members = new Map<string, boolean>();
  const contact = incoming.settings.get('contact_user_id');
  if (typeof contact === 'string' && contact !== '') {
    const member = await guild.members.fetch(contact).catch(() => null);
    members.set(contact, member !== null);
  }

  return {
    guildId: guild.id,
    channels: channelFacts(guild),
    members,
    applicationId: deps.applicationId,
    actorId,
    ...(await fleetFacts(guild, ids, deps)),
  };
}

/**
 * Facts for the apply, re-read from the guild immediately before the writes.
 *
 * Separate from {@link buildFacts} rather than a flag on it, because the two
 * take their channel ids from different places and a shared function had to be
 * handed a plan pretending to be a file to make that work. The ids here are the
 * plan's, so a channel deleted during the 15-minute window is caught: a row
 * written for an already-deleted channel is PERMANENT, since only a
 * `channelDelete` dispatch removes one and the deletion happened first.
 *
 * `members` is deliberately empty. The settings patch was validated at preview
 * time and is written as computed, so a contact who leaves inside the window is
 * still stamped. That is an accepted window rather than an oversight:
 * `readContact` falls back to the owner and the notifier re-checks membership
 * before it pings anyone.
 */
async function buildApplyFacts(
  guild: Guild,
  plan: ImportPlan,
  actorId: string,
  deps: ImportCommandDeps,
): Promise<GuildFacts> {
  const ids = [
    ...plan.creatorWrites.map((w) => w.channelId),
    ...plan.adoptedWrites.map((w) => w.channelId),
  ];
  return {
    guildId: guild.id,
    channels: channelFacts(guild),
    members: new Map(),
    applicationId: deps.applicationId,
    actorId,
    ...(await fleetFacts(guild, ids, deps)),
  };
}

/**
 * One channel, as the differ needs it.
 *
 * The permission answers come from `missingBotPermissions` and
 * `missingRenamePermissions`, the same two helpers `/setup` uses, rather than a
 * single-flag proxy. That matters in both directions: a creator channel where
 * the bot can See but cannot Connect creates no rooms, and an adopted channel
 * where it holds Manage Channels but not View Channel cannot be renamed at all,
 * which is precisely the case whose row the next sweep abandons.
 */
function channelFact(guild: Guild, channel: GuildBasedChannel): ChannelFact {
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const has = (flag: bigint): boolean => perms?.has(flag) === true;
  const missingForCreate = missingBotPermissions(has);
  const missingForRename = missingRenamePermissions(has);
  const kind: ChannelFact['kind'] =
    channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
      ? 'voice'
      : channel.type === ChannelType.GuildCategory
        ? 'category'
        : channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement
          ? 'text'
          : 'other';
  return {
    name: channel.name,
    kind,
    botCanManage: missingForCreate.length === 0,
    botCanRename: missingForRename.length === 0,
    missingPermissions: missingForCreate.length > 0 ? missingForCreate : missingForRename,
  };
}

// -- small helpers ----------------------------------------------------------

async function importDisabled(deps: ImportCommandDeps): Promise<boolean> {
  // Across ALL fleets: the settings blob has no fleet column, so an import
  // through either bot rewrites the row both read.
  return deps.flags.getBoolAnyFleet(RUNTIME_FLAGS.IMPORT_DISABLED);
}

async function announceDisabled(deps: ImportCommandDeps): Promise<boolean> {
  return deps.flags.getBool(RUNTIME_FLAGS.IMPORT_ANNOUNCE_DISABLED);
}

export function hasManageGuild(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

/**
 * The interaction id, whole.
 *
 * It was truncated to the last 18 characters, which bought nothing: a custom id
 * of `avc:import:confirm:` plus a 19-digit snowflake is 38 characters against a
 * 100-character budget. Truncating introduced a collision class instead, and
 * `put` overwrites rather than refusing, so two ids agreeing on their last 18
 * digits inside one 15-minute window would silently evict somebody else's
 * pending plan. The guard on the confirm would catch the wrong-plan case, but
 * the eviction would already have happened.
 */
function newSessionId(interactionId: string): string {
  return interactionId;
}
