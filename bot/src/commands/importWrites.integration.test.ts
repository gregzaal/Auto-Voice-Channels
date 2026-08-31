import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AutoChannelRepository,
  GuildRepository,
  ManagedChannelRepository,
  type ChannelFact,
  type GuildFacts,
  type ImportPlan,
} from '@avc/core';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { fakeLogger } from '../runtime/testUtils.js';
import { applyImportWrites, type ImportWriteDeps } from './importCommand.js';

/**
 * The import write phase against a real database.
 *
 * Everything here is invisible to a unit test with fake repositories, and every
 * case is one the design got wrong at least once:
 *
 * - `ManagedChannelRepository.create` is `onConflictDoNothing`, so an import of
 *   an already-adopted channel would report success and change nothing if the
 *   sequence stopped there.
 * - `updateState` replaces the WHOLE `state` column, which also holds `roster`
 *   (arrival order, which decides `@@creator@@` and the owner) and the last
 *   rendered name.
 * - `upsert`'s conflict target is the channel id, so a row belonging to another
 *   fleet or another guild has to throw rather than be quietly rewritten.
 */

const GUILD = '460459401086763010';
const OTHER_GUILD = '111111111111111111';
const CREATOR = '345678901234567890';
const ADOPTED = '456789012345678901';
const VANISHED = '888888888888888888';

function voice(name: string): ChannelFact {
  return { name, kind: 'voice', botCanManage: true, botCanRename: true };
}

function facts(over: Partial<GuildFacts> = {}): GuildFacts {
  return {
    guildId: GUILD,
    channels: new Map([
      [CREATOR, voice('New session')],
      [ADOPTED, voice('Lobby')],
    ]),
    members: new Map(),
    foreignFleetChannels: new Map(),
    applicationId: '479393422705426432',
    otherFleetsPresent: [],
    ...over,
  };
}

function plan(over: Partial<ImportPlan> = {}): ImportPlan {
  return {
    source: 'native',
    authoritative: true,
    settingsPatch: {},
    settingsRemove: [],
    creatorWrites: [],
    creatorRemovals: [],
    adoptedWrites: [],
    adoptedRemovals: [],
    settingChanges: [],
    creatorChanges: [],
    adoptedChanges: [],
    notes: [],
    changed: true,
    ...over,
  };
}

describe('import write phase (integration)', () => {
  let env: PgTestEnv;
  let autoChannels: AutoChannelRepository;
  let managed: ManagedChannelRepository;
  let guilds: GuildRepository;
  let deps: ImportWriteDeps;
  let settingsCalls: { patch: Record<string, unknown>; remove: readonly string[] }[];

  beforeAll(async () => {
    env = await startPostgres();
    autoChannels = new AutoChannelRepository(env.handle.db, 'prod');
    managed = new ManagedChannelRepository(env.handle.db, 'prod');
    guilds = new GuildRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.execute('DELETE FROM managed_channels');
    await env.handle.db.execute('DELETE FROM auto_channels');
    settingsCalls = [];
    deps = {
      autoChannels,
      managed,
      settings: {
        applyImportedSettings: async (guildId, patch, remove) => {
          settingsCalls.push({ patch, remove });
          return guilds.mergeSettings(guildId, (existing) => ({
            patch,
            remove,
            result: { before: existing?.settings ?? {}, driftedKeys: [] },
          }));
        },
      },
      logger: fakeLogger(),
    };
  });

  it('writes a creator channel template', async () => {
    const failures: string[] = [];
    await applyImportWrites(
      plan({ creatorWrites: [{ channelId: CREATOR, template: { name: 'Room ##', limit: 4 } }] }),
      GUILD,
      facts(),
      deps,
      failures,
    );

    expect(failures).toEqual([]);
    expect((await autoChannels.get(CREATOR))?.template).toEqual({ name: 'Room ##', limit: 4 });
  });

  /**
   * `create` is `onConflictDoNothing`, so without the `setTemplate` step this
   * would report success and change nothing: the preview would promise a
   * template and the channel would keep its old one.
   */
  it('updates an already-adopted channel, which create alone would not', async () => {
    await managed.create({
      channelId: ADOPTED,
      guildId: GUILD,
      template: { name: 'old name' },
      state: { seed: 7, name: 'Lobby', roster: ['user-1', 'user-2'] },
    });

    await applyImportWrites(
      plan({
        adoptedWrites: [
          {
            channelId: ADOPTED,
            template: { name: 'new name' },
            state: { seed: 7, name: 'Lobby', roster: ['user-1', 'user-2'] },
            firstTime: false,
          },
        ],
      }),
      GUILD,
      facts(),
      deps,
      [],
    );

    const row = await managed.get(ADOPTED);
    expect(row?.template).toEqual({ name: 'new name' });
    // The roster and the last rendered name survive: a bare `{ seed }` write
    // here would silently reassign ownership and force a rename.
    expect(row?.state.roster).toEqual(['user-1', 'user-2']);
    expect(row?.state.name).toBe('Lobby');
    expect(row?.state.seed).toBe(7);
  });

  it('seeds state on a first-time adopt', async () => {
    await applyImportWrites(
      plan({
        adoptedWrites: [
          {
            channelId: ADOPTED,
            template: { name: '__Lobby/@@creator@@ room__' },
            state: { seed: 812345, name: 'Lobby' },
            firstTime: true,
          },
        ],
      }),
      GUILD,
      facts(),
      deps,
      [],
    );

    const row = await managed.get(ADOPTED);
    expect(row?.state.seed).toBe(812345);
    expect(row?.template.name).toBe('__Lobby/@@creator@@ room__');
  });

  /**
   * A row written for an already-deleted channel is PERMANENT: only a
   * `channelDelete` dispatch removes a primary row, and the deletion happened
   * before the row existed, so no event will ever fire for it. The plan is held
   * for up to 15 minutes, so this window is real.
   */
  it('skips a channel that vanished between the preview and the write', async () => {
    const failures: string[] = [];
    await applyImportWrites(
      plan({
        creatorWrites: [
          { channelId: CREATOR, template: { name: 'Room ##' } },
          { channelId: VANISHED, template: { name: 'Gone ##' } },
        ],
      }),
      GUILD,
      facts(),
      deps,
      failures,
    );

    expect(await autoChannels.get(CREATOR)).toBeDefined();
    expect(await autoChannels.get(VANISHED)).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  /**
   * The foreign-fleet check is re-run at apply, so this row is skipped rather
   * than throwing half way through the loop. 35 guilds run two bots today.
   */
  it('skips a channel another fleet owns instead of throwing mid-apply', async () => {
    const beta = new AutoChannelRepository(env.handle.db, 'beta');
    await beta.upsert(GUILD, ADOPTED, { name: 'beta template' });

    const failures: string[] = [];
    await applyImportWrites(
      plan({
        creatorWrites: [
          { channelId: CREATOR, template: { name: 'Room ##' } },
          { channelId: ADOPTED, template: { name: 'ours ##' } },
        ],
      }),
      GUILD,
      facts({ foreignFleetChannels: new Map([[ADOPTED, 'beta']]) }),
      deps,
      failures,
    );

    // Ours landed, theirs is untouched, and nothing threw.
    expect((await autoChannels.get(CREATOR))?.template.name).toBe('Room ##');
    expect((await beta.get(ADOPTED))?.template.name).toBe('beta template');
    expect(failures).toHaveLength(1);
  });

  /**
   * The guild binding, from the write phase's side. The differ would not
   * produce this plan, so this is the defence in depth: even handed a foreign
   * channel id the repository refuses rather than rewriting another guild's row.
   */
  it('cannot rewrite another guild row even if a plan names one', async () => {
    await autoChannels.upsert(OTHER_GUILD, CREATOR, { name: 'theirs' });

    const failures: string[] = [];
    await applyImportWrites(
      plan({ creatorWrites: [{ channelId: CREATOR, template: { name: 'mine' } }] }),
      GUILD,
      facts(),
      deps,
      failures,
    );

    expect((await autoChannels.get(CREATOR))?.template.name).toBe('theirs');
    expect(failures).toHaveLength(1);
  });

  it('removes the rows a native file omits', async () => {
    await autoChannels.upsert(GUILD, CREATOR, { name: 'going away' });
    await managed.create({ channelId: ADOPTED, guildId: GUILD, template: { name: 'also going' } });

    await applyImportWrites(
      plan({ creatorRemovals: [CREATOR], adoptedRemovals: [ADOPTED] }),
      GUILD,
      facts(),
      deps,
      [],
    );

    expect(await autoChannels.get(CREATOR)).toBeUndefined();
    expect(await managed.get(ADOPTED)).toBeUndefined();
  });

  /**
   * Settings go last, in one call. `enabled` lives there with an immediate
   * fleet-wide NOTIFY, so a crash before this point means it was never written
   * rather than leaving the guild silently switched off.
   */
  it('writes settings once, last, and can clear a key', async () => {
    await guilds.ensure(GUILD);
    await guilds.updateSettings(GUILD, { general: 'General', log_level: 3 });

    await applyImportWrites(
      plan({ settingsPatch: { enabled: false }, settingsRemove: ['general'] }),
      GUILD,
      facts(),
      deps,
      [],
    );

    expect(settingsCalls).toHaveLength(1);
    const row = await guilds.ensure(GUILD);
    expect(row.settings).toEqual({ enabled: false, log_level: 3 });
  });

  it('does not call the settings writer when the plan has no settings', async () => {
    await applyImportWrites(plan(), GUILD, facts(), deps, []);
    expect(settingsCalls).toEqual([]);
  });

  /**
   * Every write is idempotent, so re-running the same import converges rather
   * than duplicating (golden rule 1). That is the whole basis of the reply
   * telling an admin a partial apply is safe to retry.
   */
  it('converges when the same import runs twice', async () => {
    const twice = plan({
      creatorWrites: [{ channelId: CREATOR, template: { name: 'Room ##' } }],
      adoptedWrites: [
        {
          channelId: ADOPTED,
          template: { name: 'Lobby' },
          state: { seed: 5 },
          firstTime: true,
        },
      ],
      settingsPatch: { enabled: true },
    });

    await applyImportWrites(twice, GUILD, facts(), deps, []);
    const first = {
      creator: await autoChannels.get(CREATOR),
      adopted: await managed.get(ADOPTED),
    };
    await applyImportWrites(twice, GUILD, facts(), deps, []);

    expect((await autoChannels.get(CREATOR))?.template).toEqual(first.creator?.template);
    expect((await managed.get(ADOPTED))?.state).toEqual(first.adopted?.state);
    expect(await autoChannels.listByGuild(GUILD)).toHaveLength(1);
    expect(await managed.listByGuild(GUILD)).toHaveLength(1);
  });
});
