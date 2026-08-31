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
    perGuild: 4,
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
  const oversize = text.length > IMPORT_LIMITS.attachmentBytes;
  if (oversize) {
    // An export must never produce a file /import refuses. Saying so beats an
    // admin discovering it at the other end.
    lines.push(
      '',
      `This file is larger than the ${Math.round(IMPORT_LIMITS.attachmentBytes / 1024)} KB that /import accepts, ` +
        'so it can be read by a self-hosted instance but not loaded back through the command.',
    );
  }

  await interaction.editReply({
    content: lines.join('\n'),
    files: [{ attachment: Buffer.from(text, 'utf8'), name: exportFilename(guildId, now) }],
  });
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

  const read = readIncoming(parsed, attachment.name);
  if (!read.ok) {
    deps.counters?.refused('unreadable');
    await interaction.editReply(`That file was not usable: ${read.reason}`);
    return;
  }

  const facts = await buildFacts(guild, read.incoming, deps);
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

  deps.serverLog(guildId, 1, renderLogEntry(outcome.applied, ctx));

  /**
   * Skipped when the flag is set, and reported as not posted either way, so the
   * reply never claims other admins were told when they were not.
   *
   * This is the second unsolicited push the bot makes into a guild and the flag
   * is its own lever, separate from the kill switch: taking away the command is
   * the wrong answer to a notice that turns out to be wrong for a server.
   */
  const announced = (await announceDisabled(deps))
    ? 'not_posted'
    : await announce(guild, renderAnnouncement(outcome.applied, ctx), deps);

  const lines: string[] = [];
  lines.push(
    outcome.failures.length === 0
      ? 'Imported. The configuration in the file is now live in this server.'
      : 'Partly imported. Some steps did not finish, listed below. Running the same import again is safe.',
  );
  for (const failure of outcome.failures) lines.push(`- ${failure}`);
  if (outcome.driftedKeys.length > 0) {
    lines.push(
      `- ${outcome.driftedKeys.length} settings had changed since the preview, so what was replaced ` +
        'is not exactly what the preview showed.',
    );
  }
  if (announced !== 'posted') {
    lines.push('Nobody else was notified. This server has no system channel AVC can post in.');
  }
  lines.push('Your previous configuration is in the file above. Import it to undo this.');

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
  const facts = await buildApplyFacts(guild, previewPlan, deps);
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
  await interaction
    .followUp({
      content:
        "Before anything is written, here is this server's current configuration. " +
        'Nothing has changed yet. Keep this file: importing it undoes what happens next.',
      files: [
        {
          attachment: Buffer.from(serializeGuildConfig(snapshot), 'utf8'),
          name: snapshotFilename(guildId, new Date()),
        },
      ],
      ephemeral: true,
    })
    .catch((err: unknown) => {
      // Not fatal: the same snapshot goes into the audit row below.
      deps.logger.warn({ err, guildId }, 'could not deliver the pre-import snapshot');
      failures.push('the pre-import snapshot could not be attached');
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

  // Only the writes need the per-guild ordering guarantee against voice events.
  const applied = await deps.dispatchRun(guildId, 'cmd:import', async () => {
    return applyImportWrites(previewPlan, guildId, facts, deps, failures);
  });

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
  // Creator channels, each re-resolved: a channel deleted since the preview
  // would otherwise get a PERMANENT phantom row, because only a channelDelete
  // dispatch removes one and the deletion happened before the row existed.
  for (const write of plan.creatorWrites) {
    if (!stillWritable(write.channelId, facts)) {
      failures.push(`a creator channel vanished before it could be written`);
      continue;
    }
    try {
      await deps.autoChannels.upsert(guildId, write.channelId, write.template);
    } catch (err) {
      deps.logger.warn({ err, guildId, channelId: write.channelId }, 'import creator write failed');
      failures.push('a creator channel could not be written');
    }
  }
  for (const channelId of plan.creatorRemovals) {
    try {
      await deps.autoChannels.remove(guildId, channelId);
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
    if (!stillWritable(write.channelId, facts)) {
      failures.push('an adopted channel vanished before it could be written');
      continue;
    }
    try {
      await deps.managed.create({
        channelId: write.channelId,
        guildId,
        ownerId: null,
        template: write.template,
        state: write.state,
      });
      await deps.managed.setTemplate(guildId, write.channelId, write.template);
      await deps.managed.updateState(guildId, write.channelId, write.state);
    } catch (err) {
      deps.logger.warn({ err, guildId, channelId: write.channelId }, 'import adopted write failed');
      failures.push('an adopted channel could not be written');
    }
  }
  for (const channelId of plan.adoptedRemovals) {
    try {
      await deps.managed.remove(guildId, channelId);
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
      const result = await deps.settings.applyImportedSettings(
        guildId,
        plan.settingsPatch,
        plan.settingsRemove,
      );
      driftedKeys = result.driftedKeys;
    } catch (err) {
      deps.logger.error({ err, guildId }, 'import settings write failed');
      failures.push('the server settings could not be written');
    }
  }

  return { plan, driftedKeys };
}

function stillWritable(channelId: string, facts: GuildFacts): boolean {
  return facts.channels.has(channelId) && !facts.foreignFleetChannels.has(channelId);
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

function readIncoming(parsed: unknown, fileName: string): ReadResult {
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

  const plan = planGuild('unknown', stripped, {});
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
    ...(await fleetFacts(guild, ids, deps)),
  };
}

function channelFact(guild: Guild, channel: GuildBasedChannel): ChannelFact {
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  return {
    name: channel.name,
    kind:
      channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice
        ? 'voice'
        : channel.type === ChannelType.GuildCategory
          ? 'category'
          : channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement
            ? 'text'
            : 'other',
    botCanManage: perms?.has(PermissionFlagsBits.ViewChannel) === true,
    botCanRename: perms?.has(PermissionFlagsBits.ManageChannels) === true,
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

/** Short enough for a 100-character custom id, unique enough for a 15-minute TTL. */
function newSessionId(interactionId: string): string {
  return interactionId.slice(-18);
}
