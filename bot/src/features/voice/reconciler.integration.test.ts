import {
  AutoChannelRepository,
  GuildRepository,
  ManagedChannelRepository,
  RUNTIME_FLAGS,
  RuntimeFlagsRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { GuildDispatcher } from '../../runtime/dispatcher.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { VoiceFeature } from './handler.js';
import { Reconciler } from './reconciler.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-reconcile-test';
const PRIMARY = 'primary-1';

describe('Reconciler (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let managedRepo: ManagedChannelRepository;
  let flags: RuntimeFlagsRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let feature: VoiceFeature;
  let dispatcher: GuildDispatcher;
  let reconciler: Reconciler;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
    managedRepo = new ManagedChannelRepository(env.handle.db);
    flags = new RuntimeFlagsRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.managedChannels);
    await env.handle.db.delete(db.schema.autoChannels);
    await env.handle.db.delete(db.schema.runtimeFlags);
    voice = new FakeVoiceView();
    actions = new RecordingVoiceActions();
    feature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
    });
    dispatcher = new GuildDispatcher({ logger: fakeLogger() });
    reconciler = new Reconciler({
      feature,
      dispatcher,
      secondaries,
      autoChannels,
      flags,
      logger: fakeLogger(),
    });
    await guilds.ensure(GUILD);
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
  });

  it('drops the DB record for a secondary whose channel vanished from Discord', async () => {
    await secondaries.create({
      channelId: 'gone',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      state: { name: '#1 [General]' },
    });
    // `voice` knows nothing about 'gone' → channelExists is false.

    const drift = await reconciler.reconcileGuild(GUILD);

    expect(drift.orphanedRecords).toEqual(['gone']);
    expect(actions.ofType('delete')).toHaveLength(0); // no Discord call for a vanished channel
    expect(await secondaries.get('gone')).toBeUndefined();
  });

  it('deletes a tracked secondary that has emptied (missed leave event)', async () => {
    await secondaries.create({
      channelId: 'empty',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      state: { name: '#1 [General]' },
    });
    voice.ensureChannel('empty'); // exists in Discord but has no members

    const drift = await reconciler.reconcileGuild(GUILD);

    expect(drift.deletedEmpty).toEqual(['empty']);
    expect(actions.ofType('delete').map((a) => a.channelId)).toContain('empty');
    expect(await secondaries.get('empty')).toBeUndefined();
  });

  it('spawns a secondary for a member still sitting in a primary (missed join)', async () => {
    voice.put(PRIMARY, member('alice', ['Halo']));

    const drift = await reconciler.reconcileGuild(GUILD);

    expect(drift.created).toHaveLength(1);
    expect(drift.created[0]!.memberId).toBe('alice');
    const created = actions.ofType('create');
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('#1 [Halo]');
    expect(actions.ofType('move')[0]!.memberId).toBe('alice');
    const rows = await secondaries.listByGuild(GUILD);
    expect(rows).toHaveLength(1);
  });

  it('renames a surviving secondary whose name drifted', async () => {
    await secondaries.create({
      channelId: 'sec',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: 'stale name', index: 0 },
    });
    voice.put('sec', member('alice', ['Halo']));

    const drift = await reconciler.reconcileGuild(GUILD);

    expect(drift.renamed).toEqual([{ channelId: 'sec', to: '#1 [Halo]' }]);
    expect(actions.ofType('rename')[0]!.name).toBe('#1 [Halo]');
  });

  it('renumbers ## siblings after a middle channel was deleted (no gaps or dupes)', async () => {
    // Three siblings #1/#2/#3 created in order; the middle one (#2) then vanishes.
    // Sibling order is createdAt-then-channelId, so inserting a→b→c is deterministic.
    for (const [i, id] of [
      ['0', 'chan-a'],
      ['1', 'chan-b'],
      ['2', 'chan-c'],
    ] as const) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'owner',
        state: { name: `#${Number(i) + 1} [General]`, index: Number(i) },
      });
    }
    // 'chan-b' (#2) vanished; 'chan-a' (#1) and 'chan-c' (stale #3) remain populated.
    voice.removeChannel('chan-b');
    await secondaries.remove('chan-b');
    voice.put('chan-a', member('owner'));
    voice.put('chan-c', member('owner'));

    const drift = await reconciler.reconcileGuild(GUILD);

    // 'chan-c' should be renumbered #3 → #2 to close the gap; 'chan-a' stays #1.
    expect(drift.renamed).toEqual([{ channelId: 'chan-c', to: '#2 [General]' }]);
    expect((await secondaries.get('chan-c'))!.state.name).toBe('#2 [General]');
    expect((await secondaries.get('chan-a'))!.state.name).toBe('#1 [General]');
  });

  it('is idempotent: a second reconcile of a consistent guild is a no-op', async () => {
    voice.put(PRIMARY, member('alice'));
    await reconciler.reconcileGuild(GUILD);
    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Simulate the move landing: alice now sits in the new secondary, not primary.
    voice.drop(PRIMARY, 'alice');
    voice.put(secondaryId, member('alice'));
    actions.actions.length = 0;

    const drift = await reconciler.reconcileGuild(GUILD);

    expect(drift.created).toHaveLength(0);
    expect(drift.deletedEmpty).toHaveLength(0);
    expect(drift.orphanedRecords).toHaveLength(0);
    expect(actions.actions).toHaveLength(0);
  });

  it('dry-run reports drift without acting', async () => {
    await secondaries.create({
      channelId: 'gone',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      state: { name: '#1 [General]' },
    });
    await secondaries.create({
      channelId: 'empty',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      state: { name: '#2 [General]' },
    });
    voice.ensureChannel('empty');
    voice.put(PRIMARY, member('alice'));

    const drift = await reconciler.reconcileGuild(GUILD, { dryRun: true });

    expect(drift.dryRun).toBe(true);
    expect(drift.orphanedRecords).toEqual(['gone']);
    expect(drift.deletedEmpty).toEqual(['empty']);
    expect(drift.created).toHaveLength(1);
    expect(drift.created[0]!.secondaryId).toBeUndefined(); // nothing actually created

    // Nothing changed in the world.
    expect(actions.actions).toHaveLength(0);
    expect(await secondaries.get('gone')).toBeDefined();
    expect(await secondaries.get('empty')).toBeDefined();
  });

  it('sweep skips everything under global pause', async () => {
    voice.put(PRIMARY, member('alice'));
    await flags.set(RUNTIME_FLAGS.GLOBAL_PAUSE, true, { actor: 'test' });

    await reconciler.sweep();

    expect(actions.actions).toHaveLength(0);
  });

  it('sweep skips when the sweep-disabled flag is set', async () => {
    voice.put(PRIMARY, member('alice'));
    await flags.set(RUNTIME_FLAGS.SWEEP_DISABLED, true, { actor: 'test' });

    await reconciler.sweep();

    expect(actions.actions).toHaveLength(0);
  });

  it('sweep reconciles guilds that have managed channels', async () => {
    voice.put(PRIMARY, member('alice'));

    await reconciler.sweep();

    // The member sitting in the primary got their secondary.
    expect(actions.ofType('create')).toHaveLength(1);
  });

  /**
   * The partial-cache case (`plans/scaling.md` §9.1 finding 1). `scopedGuildIds`
   * selects fleet-wide from Postgres with no shard predicate; this asserts the
   * `ownsGuild` filter actually removes a foreign guild from the sweep's scope,
   * so a channel this instance's (fake, in this test) cache knows nothing about
   * is left alone rather than read as "gone" and deleted.
   */
  it('sweep does not touch a guild this instance owns no shard for', async () => {
    await secondaries.create({
      channelId: 'foreign-secondary',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      state: { name: '#1 [General]' },
    });
    // `voice` knows nothing about 'foreign-secondary' — channelExists is false,
    // exactly as it would be for any channel in a guild we don't cache at all.

    const scopedReconciler = new Reconciler({
      feature,
      dispatcher,
      secondaries,
      autoChannels,
      flags,
      logger: fakeLogger(),
      ownsGuild: () => false,
    });

    await scopedReconciler.sweep();

    expect(actions.actions).toHaveLength(0);
    expect(await secondaries.get('foreign-secondary')).toBeDefined();
  });

  /**
   * Defense in depth for the same finding: even a DIRECT `reconcileGuild` call
   * (ops tooling, or a caller that got the shard scoping wrong) must not delete
   * a row for a guild this instance doesn't own, independent of the sweep's own
   * scoping tested above. This exercises the guard in `handler.ts` itself.
   */
  it('reconcileGuild itself refuses to delete for a guild it does not own', async () => {
    await secondaries.create({
      channelId: 'foreign-secondary-2',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      state: { name: '#1 [General]' },
    });

    const scopedFeature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      ownsGuild: () => false,
    });

    const drift = await scopedFeature.reconcileGuild(GUILD);

    expect(drift.orphanedRecords).toHaveLength(0);
    expect(actions.actions).toHaveLength(0);
    expect(await secondaries.get('foreign-secondary-2')).toBeDefined();
  });

  /**
   * The same guard, mirrored for the adopted/managed-channels branch
   * (`handler.ts`'s second destructive site) — not covered by the secondaries
   * test above, and flagged as untested by the adversarial review before
   * this landed.
   */
  it('reconcileGuild refuses to drop a managed-channel record for a guild it does not own', async () => {
    await managedRepo.create({ channelId: 'foreign-managed', guildId: GUILD });
    // `voice` knows nothing about 'foreign-managed' — channelExists is false.

    const scopedFeature = new VoiceFeature({
      autoChannels,
      secondaries,
      managed: managedRepo,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      ownsGuild: () => false,
    });

    const drift = await scopedFeature.reconcileGuild(GUILD);

    expect(drift.orphanedRecords).toHaveLength(0);
    expect(actions.actions).toHaveLength(0);
    expect(await managedRepo.get('foreign-managed')).toBeDefined();
  });
});
