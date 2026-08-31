import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import {
  AutoChannelRepository,
  GuildRepository,
  ManagedChannelRepository,
  OpsAuditRepository,
  RuntimeFlagsRepository,
  SecondaryChannelRepository,
  RUNTIME_FLAGS,
} from '@avc/core';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { fakeLogger } from '../runtime/testUtils.js';
import { GuildSettingsService } from '../features/voice/settings.js';
import { RecordingVoiceActions } from '../features/voice/actions.js';
import {
  createImportSessionStore,
  handleExport,
  handleImportButton,
  handleImportCommand,
  type ImportCommandDeps,
} from './importCommand.js';
import { importId } from './importPanel.js';

/**
 * The two flows composed and actually run, against a real database.
 *
 * Everything else about this feature is tested in pieces: the format, the pure
 * differ, the renderers, the write phase. None of that executes the composition,
 * and the composition is where this project's worst bugs have lived (a
 * `statement_timeout` on a pool, an `/admin/ops` writing every lever to the wrong
 * fleet, a `dev`-stamped deploy). A wiring mistake, a wrong `editReply` shape or
 * a broken attachment build would pass every other test in the suite.
 */

const GUILD = '460459401086763010';
const ACTOR = '333333333333333333';
const CREATOR = '345678901234567890';
const ADOPTED = '456789012345678901';
const APP = '479393422705426432';

interface Recorded {
  content?: string;
  files?: { name?: string; attachment?: Buffer }[];
  components?: unknown[];
}

function fakeGuild() {
  const channel = (id: string, name: string) => ({
    id,
    name,
    type: 2, // GuildVoice
    permissionsFor: () => ({ has: () => true }),
  });
  const cache = new Map<string, ReturnType<typeof channel>>([
    [CREATOR, channel(CREATOR, 'New session')],
    [ADOPTED, channel(ADOPTED, 'Lobby')],
  ]);
  return {
    id: GUILD,
    name: 'Example server',
    available: true,
    systemChannel: { send: vi.fn().mockResolvedValue(undefined) },
    channels: { cache },
    members: {
      me: { permissions: { has: () => true } },
      fetch: vi.fn().mockResolvedValue({ id: ACTOR }),
    },
  };
}

function fakeCommand(guild: ReturnType<typeof fakeGuild>, attachment?: Recorded['files']) {
  const replies: Recorded[] = [];
  const record = (arg: unknown): Promise<void> => {
    replies.push(typeof arg === 'string' ? { content: arg } : (arg as Recorded));
    return Promise.resolve();
  };
  const file = attachment?.[0];
  return {
    replies,
    interaction: {
      id: 'i-1',
      guildId: GUILD,
      guild,
      user: { id: ACTOR },
      memberPermissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild },
      replied: false,
      deferred: false,
      deferReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn(record),
      editReply: vi.fn(record),
      followUp: vi.fn(record),
      update: vi.fn(record),
      options: {
        getAttachment: () =>
          file
            ? {
                name: file.name,
                size: file.attachment?.length ?? 0,
                url: 'https://cdn.discordapp.com/attachments/1/2/config.json',
                contentType: 'application/json',
              }
            : null,
      },
    } as never,
  };
}

function fakeButton(guild: ReturnType<typeof fakeGuild>, customId: string) {
  const replies: Recorded[] = [];
  const record = (arg: unknown): Promise<void> => {
    replies.push(typeof arg === 'string' ? { content: arg } : (arg as Recorded));
    return Promise.resolve();
  };
  return {
    replies,
    interaction: {
      id: 'i-2',
      guildId: GUILD,
      guild,
      customId,
      user: { id: ACTOR },
      memberPermissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild },
      replied: false,
      deferred: false,
      update: vi.fn(record),
      followUp: vi.fn(record),
      reply: vi.fn(record),
    } as never,
  };
}

const text = (replies: Recorded[]): string => JSON.stringify(replies.map((r) => r.content));

describe('import and export flow (integration)', () => {
  let env: PgTestEnv;
  let deps: ImportCommandDeps;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let managed: ManagedChannelRepository;
  let flags: RuntimeFlagsRepository;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db, 'prod');
    managed = new ManagedChannelRepository(env.handle.db, 'prod');
    flags = new RuntimeFlagsRepository(env.handle.db, 'prod');
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await env?.stop();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    await env.handle.db.execute('DELETE FROM managed_channels');
    await env.handle.db.execute('DELETE FROM auto_channels');
    await env.handle.db.execute('DELETE FROM ops_audit');
    await env.handle.db.execute('DELETE FROM runtime_flags');
    await env.handle.db.execute('DELETE FROM guilds');

    const settings = new GuildSettingsService({
      guilds,
      autoChannels,
      secondaries: new SecondaryChannelRepository(env.handle.db, 'prod'),
      actions: new RecordingVoiceActions(),
      logger: fakeLogger(),
    });

    deps = {
      db: env.handle.db,
      fleet: 'prod',
      guilds,
      autoChannels,
      managed,
      settings,
      flags,
      opsAudit: new OpsAuditRepository(env.handle.db, 'prod'),
      serverLog: vi.fn(),
      reconcileGuild: vi.fn().mockResolvedValue(undefined),
      dispatchRun: (_guildId, _name, task) => task(),
      applicationId: APP,
      logger: fakeLogger(),
      sessions: createImportSessionStore(),
    };
  });

  /** Puts real configuration in the guild, the way the panels would. */
  async function configureGuild(): Promise<void> {
    await guilds.ensure(GUILD);
    await guilds.updateSettings(GUILD, {
      general: 'Voice rooms',
      aliases: { Valorant: 'Val', 'Counter-Strike 2': 'CS2' },
      log_level: 2,
    });
    await autoChannels.upsert(GUILD, CREATOR, { name: '@@game_name@@ ##', limit: 4 });
    await managed.create({
      channelId: ADOPTED,
      guildId: GUILD,
      template: { name: '__Lobby/@@creator@@ room__' },
      state: { seed: 812345, name: 'Lobby', roster: [ACTOR] },
    });
  }

  function serveFile(body: string): void {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(body) });
  }

  describe('/export', () => {
    it('attaches the configuration and says what is in it', async () => {
      await configureGuild();
      const { interaction, replies } = fakeCommand(fakeGuild());

      await handleExport(interaction, deps);

      const attached = replies.at(-1)?.files?.[0];
      expect(attached?.name).toMatch(/^avc-config-460459401086763010-\d{4}-\d{2}-\d{2}\.json$/);
      const file = JSON.parse(attached!.attachment!.toString('utf8'));
      expect(file.guild_id).toBe(GUILD);
      expect(file.source_application_id).toBe(APP);
      expect(file.creator_channels).toHaveLength(1);
      expect(file.adopted_channels).toHaveLength(1);
      // The disclosure has to be in the copy, not just in the design doc.
      expect(text(replies)).toContain('nick');
    });

    it('works for a guild with nothing configured', async () => {
      const { interaction, replies } = fakeCommand(fakeGuild());
      await handleExport(interaction, deps);
      const file = JSON.parse(replies.at(-1)!.files![0]!.attachment!.toString('utf8'));
      expect(Object.values(file.settings).every((v) => v === null)).toBe(true);
      expect(file.creator_channels).toEqual([]);
    });
  });

  describe('/import', () => {
    /**
     * The whole point of this file: export a configured guild, wipe it, import
     * the file back, and check the guild is where it started. Nothing else in
     * the suite runs both halves against one database.
     */
    it('round trips a guild through export, wipe and import', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const fileText = exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8');

      // Wipe it the way an admin would not, but a test can.
      await autoChannels.remove(GUILD, CREATOR);
      await managed.remove(GUILD, ADOPTED);
      await guilds.mergeSettings(GUILD, () => ({
        patch: {},
        remove: ['general', 'aliases', 'log_level'],
        result: null,
      }));

      serveFile(fileText);
      const previewed = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(fileText, 'utf8') },
      ]);
      await handleImportCommand(previewed.interaction, deps);

      const preview = previewed.replies.at(-1)!;
      expect(preview.components).toHaveLength(1);
      expect(preview.content).toContain('Preview of');
      expect(preview.content).toContain('Subscription and trial state: unchanged');

      const sessionId = 'i-1'.slice(-18);
      const confirmed = fakeButton(fakeGuild(), importId('confirm', sessionId));
      await handleImportButton(confirmed.interaction, deps);

      // Back where it started.
      const row = await guilds.ensure(GUILD);
      expect(row.settings).toMatchObject({
        general: 'Voice rooms',
        aliases: { Valorant: 'Val', 'Counter-Strike 2': 'CS2' },
        log_level: 2,
      });
      expect((await autoChannels.get(CREATOR))?.template).toEqual({
        name: '@@game_name@@ ##',
        limit: 4,
      });
      const adopted = await managed.get(ADOPTED);
      expect(adopted?.template.name).toBe('__Lobby/@@creator@@ room__');
      expect(adopted?.state.seed).toBe(812345);
    });

    /** The undo is handed over before any write, so it survives a crash. */
    it('sends the snapshot before it writes anything, and announces after', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const fileText = exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8');

      // A file that changes something, so the import is not a no-op.
      const edited = JSON.parse(fileText);
      edited.settings.general = 'Rooms';
      serveFile(JSON.stringify(edited));

      const previewed = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(JSON.stringify(edited), 'utf8') },
      ]);
      await handleImportCommand(previewed.interaction, deps);

      const guild = fakeGuild();
      const confirmed = fakeButton(guild, importId('confirm', 'i-1'.slice(-18)));
      await handleImportButton(confirmed.interaction, deps);

      const snapshot = confirmed.replies.find((r) => r.files?.[0]?.name?.includes('before-import'));
      expect(snapshot, 'the snapshot must be attached').toBeDefined();
      expect(snapshot!.content).toContain('Nothing has changed yet');
      // The old value, captured before the write.
      const before = JSON.parse(snapshot!.files![0]!.attachment!.toString('utf8'));
      expect(before.settings.general).toBe('Voice rooms');

      expect(guild.systemChannel.send).toHaveBeenCalledOnce();
      const announcement = guild.systemChannel.send.mock.calls[0]![0] as { content: string };
      expect(announcement.content).toContain('configuration imported');
      // And the write actually landed.
      expect((await guilds.ensure(GUILD)).settings.general).toBe('Rooms');
    });

    it('writes both audit rows, so nothing looks stranded', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const edited = JSON.parse(exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8'));
      edited.settings.general = 'Rooms';
      serveFile(JSON.stringify(edited));

      const previewed = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(JSON.stringify(edited), 'utf8') },
      ]);
      await handleImportCommand(previewed.interaction, deps);
      await handleImportButton(
        fakeButton(fakeGuild(), importId('confirm', 'i-1'.slice(-18))).interaction,
        deps,
      );

      const rows = await new OpsAuditRepository(env.handle.db).recent(10);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('guild.config_import');
      expect(actions).toContain('guild.config_import.done');
      // Member nicknames are stored as a count, never as the names.
      const first = rows.find((r) => r.action === 'guild.config_import');
      expect(JSON.stringify(first?.details)).not.toContain('"Greg"');
    });

    it('refuses while the kill switch is set, on either fleet', async () => {
      await configureGuild();
      const beta = new RuntimeFlagsRepository(env.handle.db, 'beta');
      await beta.set(RUNTIME_FLAGS.IMPORT_DISABLED, true, { actor: 'test' });

      const { interaction, replies } = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from('{}', 'utf8') },
      ]);
      await handleImportCommand(interaction, deps);

      expect(text(replies)).toContain('switched off');
    });

    it('refuses a file exported from another server', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const foreign = JSON.parse(exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8'));
      foreign.guild_id = '111111111111111111';
      serveFile(JSON.stringify(foreign));

      const { interaction, replies } = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(JSON.stringify(foreign), 'utf8') },
      ]);
      await handleImportCommand(interaction, deps);

      expect(text(replies)).toContain('was not imported');
      expect(text(replies)).toContain('111111111111111111');
    });

    it('refuses an attachment that is not hosted by Discord', async () => {
      await configureGuild();
      globalThis.fetch = vi.fn();
      const { interaction, replies } = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from('{}', 'utf8') },
      ]);
      interaction.options.getAttachment = () => ({
        name: 'avc-config.json',
        size: 2,
        url: 'https://example.invalid/config.json',
        contentType: 'application/json',
      });

      await handleImportCommand(interaction, deps);

      expect(text(replies)).toContain('not hosted by Discord');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('says nothing would change when the file matches the guild', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const fileText = exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8');
      serveFile(fileText);

      const { interaction, replies } = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(fileText, 'utf8') },
      ]);
      await handleImportCommand(interaction, deps);

      expect(text(replies)).toContain('Nothing would change');
    });

    /** Claim by delete, so the plan cannot be applied twice. */
    it('refuses a second confirm click', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const edited = JSON.parse(exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8'));
      edited.settings.general = 'Rooms';
      serveFile(JSON.stringify(edited));

      const previewed = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(JSON.stringify(edited), 'utf8') },
      ]);
      await handleImportCommand(previewed.interaction, deps);

      const id = importId('confirm', 'i-1'.slice(-18));
      await handleImportButton(fakeButton(fakeGuild(), id).interaction, deps);
      const second = fakeButton(fakeGuild(), id);
      await handleImportButton(second.interaction, deps);

      expect(text(second.replies)).toContain('already ran');
    });

    it('cancels without writing anything', async () => {
      await configureGuild();
      const exported = fakeCommand(fakeGuild());
      await handleExport(exported.interaction, deps);
      const edited = JSON.parse(exported.replies.at(-1)!.files![0]!.attachment!.toString('utf8'));
      edited.settings.general = 'Rooms';
      serveFile(JSON.stringify(edited));

      const previewed = fakeCommand(fakeGuild(), [
        { name: 'avc-config.json', attachment: Buffer.from(JSON.stringify(edited), 'utf8') },
      ]);
      await handleImportCommand(previewed.interaction, deps);

      const cancelled = fakeButton(fakeGuild(), importId('cancel', 'i-1'.slice(-18)));
      await handleImportButton(cancelled.interaction, deps);

      expect(text(cancelled.replies)).toContain('Nothing was imported');
      expect((await guilds.ensure(GUILD)).settings.general).toBe('Voice rooms');
    });

    /**
     * A legacy file, which is the format the whole `parseLegacyJson` and
     * `planGuild` reuse exists for, and the one that must not clear fields it
     * cannot express.
     */
    it('imports a legacy config without clearing what the format cannot express', async () => {
      await guilds.ensure(GUILD);
      await autoChannels.upsert(GUILD, CREATOR, {
        name: 'Room ##',
        status: 'Playing @@game_name@@',
        defaultPrivate: true,
      });

      const legacy = JSON.stringify({
        enabled: true,
        general: 'Voice',
        auto_channels: { [CREATOR]: { template: 'Legacy ##' } },
      });
      serveFile(legacy);

      const { interaction, replies } = fakeCommand(fakeGuild(), [
        { name: `${GUILD}.json`, attachment: Buffer.from(legacy, 'utf8') },
      ]);
      await handleImportCommand(interaction, deps);
      expect(replies.at(-1)?.content).toContain('Preview of');

      await handleImportButton(
        fakeButton(fakeGuild(), importId('confirm', 'i-1'.slice(-18))).interaction,
        deps,
      );

      const template = (await autoChannels.get(CREATOR))?.template;
      // The status template and /alwaysprivate survive, which is the defect the
      // format-aware merge exists to prevent.
      expect(template?.status).toBe('Playing @@game_name@@');
      expect(template?.defaultPrivate).toBe(true);
    });
  });
});
