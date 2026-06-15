import { AutoChannelRepository, GuildRepository, SecondaryChannelRepository, db } from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { VoiceFeature } from './handler.js';
import type { VoiceStateEvent } from './types.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-voice-test';
const PRIMARY = 'primary-1';

describe('VoiceFeature (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let feature: VoiceFeature;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.autoChannels);
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
    await guilds.ensure(GUILD);
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
  });

  it('creates and moves a member into a secondary on joining a primary', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);

    const event: VoiceStateEvent = { guildId: GUILD, member: alice, afterChannelId: PRIMARY };
    await feature.handleVoiceStateUpdate(event);

    const created = actions.ofType('create');
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe('#1 [Halo]');

    const moves = actions.ofType('move');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.memberId).toBe('alice');

    const rows = await secondaries.listByGuild(GUILD);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerId).toBe('alice');
    expect(rows[0]!.primaryChannelId).toBe(PRIMARY);
  });

  it('is idempotent: a replayed join does not create a second channel', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    const event: VoiceStateEvent = { guildId: GUILD, member: alice, afterChannelId: PRIMARY };

    await feature.handleVoiceStateUpdate(event);
    // Simulate the move taking effect (member left primary, now in the secondary).
    voice.drop(PRIMARY, 'alice');
    await feature.handleVoiceStateUpdate(event); // replay

    expect(actions.ofType('create')).toHaveLength(1);
    expect(await secondaries.listByGuild(GUILD)).toHaveLength(1);
  });

  it('deletes the secondary when the last non-bot member leaves', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });

    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Member is now in the secondary; simulate them leaving it.
    voice.put(secondaryId, alice);
    voice.drop(PRIMARY, 'alice');
    voice.drop(secondaryId, 'alice');

    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      beforeChannelId: secondaryId,
    });

    expect(actions.ofType('delete').map((a) => a.channelId)).toContain(secondaryId);
    expect(await secondaries.get(secondaryId)).toBeUndefined();
  });

  it('does not delete a secondary that still has members', async () => {
    const alice = member('alice');
    const bob = member('bob');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;

    // Both in the secondary, then alice leaves but bob remains.
    voice.put(secondaryId, alice);
    voice.put(secondaryId, bob);
    voice.drop(secondaryId, 'alice');

    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      beforeChannelId: secondaryId,
    });

    expect(actions.ofType('delete')).toHaveLength(0);
    expect(await secondaries.get(secondaryId)).toBeDefined();
  });

  it('ignores mute/unmute (no channel change)', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      beforeChannelId: PRIMARY,
      afterChannelId: PRIMARY,
    });
    expect(actions.actions).toHaveLength(0);
  });

  it('re-renders a secondary when its membership/game changes', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    expect(actions.ofType('create')[0]!.name).toBe('#1 [Halo]');

    // Alice is now in the secondary; Bob joins playing a different game.
    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob', ['Doom']));
    await feature.rerenderSecondary(GUILD, secondaryId);

    const renames = actions.ofType('rename');
    expect(renames).toHaveLength(1);
    expect(renames[0]!.channelId).toBe(secondaryId);
    expect(renames[0]!.name).toContain('Halo');
    expect(renames[0]!.name).toContain('Doom');
    const row = await secondaries.get(secondaryId);
    expect(row!.state.name).toBe(renames[0]!.name);
  });

  it('rerenderSecondary is a no-op when the name is unchanged', async () => {
    const alice = member('alice', ['Halo']);
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    voice.put(secondaryId, alice);

    await feature.rerenderSecondary(GUILD, secondaryId);
    expect(actions.ofType('rename')).toHaveLength(0);
  });

  it('rerenderSecondary no-ops for an unknown or empty channel', async () => {
    await feature.rerenderSecondary(GUILD, 'not-a-secondary');
    expect(actions.ofType('rename')).toHaveLength(0);
  });

  it('handleVoiceStateUpdate reports a joined secondary as needing re-render', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;

    const bob = member('bob');
    voice.put(secondaryId, bob);
    const touched = await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: bob,
      afterChannelId: secondaryId,
    });
    expect(touched).toContain(secondaryId);
  });

  it('does not create when the runtime gate denies (e.g. global pause)', async () => {
    const gatedFeature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      gate: { allowCreate: () => Promise.resolve({ allowed: false, reason: 'global pause' }) },
      logger: fakeLogger(),
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await gatedFeature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    expect(actions.ofType('create')).toHaveLength(0);
    expect(await secondaries.listByGuild(GUILD)).toHaveLength(0);
  });

  it('does not create when the guild is blocked', async () => {
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'blocked' });
    const blockedFeature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true, // kill-switch wins even when self-hosted
      logger: fakeLogger(),
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await blockedFeature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    expect(actions.ofType('create')).toHaveLength(0);
  });

  it('rerenderByOwner re-renders every channel a member owns', async () => {
    for (const id of ['c1', 'c2']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'stale', index: 0 },
      });
      voice.put(id, member('alice'));
    }
    // A channel owned by someone else must be untouched.
    await secondaries.create({
      channelId: 'c3',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'bob',
      state: { name: 'stale', index: 0 },
    });
    voice.put('c3', member('bob'));

    const summary = await feature.rerenderByOwner(GUILD, 'alice');
    expect(summary).toMatchObject({ considered: 2, renamed: 2 });
    expect(
      actions
        .ofType('rename')
        .map((a) => a.channelId)
        .sort(),
    ).toEqual(['c1', 'c2']);
  });

  it('rerenderSiblings re-renders all channels of a primary, counting rate limits', async () => {
    actions.simulateRenameRateLimit = true;
    for (const id of ['s1', 's2']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'stale', index: 0 },
      });
      voice.put(id, member('alice'));
    }
    const summary = await feature.rerenderSiblings(GUILD, 's1');
    expect(summary).toMatchObject({ considered: 2, renamed: 2, rateLimited: 2 });
  });

  it('getEditorState returns current value + live preview for both editors', async () => {
    await secondaries.create({
      channelId: 'ed',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0, template: 'My Room' },
    });
    voice.put('ed', member('alice', ['Halo']));

    // /name editor: the per-channel override and its rendered preview.
    const nameState = await feature.getEditorState('name', GUILD, 'ed');
    expect(nameState).toMatchObject({
      found: true,
      currentTemplate: 'My Room',
      preview: 'My Room',
    });
    expect(nameState.ownerId).toBe('alice');

    // /template editor: the primary's template (PRIMARY uses '## [@@game_name@@]').
    const tmplState = await feature.getEditorState('template', GUILD, 'ed');
    expect(tmplState).toMatchObject({
      found: true,
      currentTemplate: '## [@@game_name@@]',
      preview: '#1 [Halo]', // primary template, ignoring the per-channel override
    });

    expect((await feature.getEditorState('name', GUILD, 'missing')).found).toBe(false);
  });

  it('debugChannel reports the data behind a channel name', async () => {
    await secondaries.create({
      channelId: 'dbg',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0, seed: 7 },
    });
    voice.put('dbg', member('alice', ['Halo']));

    const info = await feature.debugChannel(GUILD, 'dbg');
    expect(info.isSecondary).toBe(true);
    expect(info.effectiveTemplate).toBe('## [@@game_name@@]');
    expect(info.computedGame).toBe('Halo');
    expect(info.renderedName).toBe('#1 [Halo]');
    expect(info.seed).toBe(7);
    expect(info.members).toHaveLength(1);
    expect(info.members[0]).toMatchObject({ id: 'alice', playing: ['Halo'] });
  });
});
