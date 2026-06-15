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

  it('hands ownership to a remaining member when the owner leaves (no "Unknown")', async () => {
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room" });
    const ownerChanges: { channelId: string; newOwnerId: string; newOwnerName: string }[] = [];
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      onOwnerChanged: (_g, channelId, newOwnerId, newOwnerName) => {
        ownerChanges.push({ channelId, newOwnerId, newOwnerName });
        return Promise.resolve();
      },
    });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    const secondaryId = actions.ofType('create')[0]!.channelId;
    expect((await secondaries.get(secondaryId))!.ownerId).toBe('alice');

    // alice (owner) + bob both inside; alice leaves, bob remains.
    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob'));
    voice.drop(secondaryId, 'alice');
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, beforeChannelId: secondaryId });

    expect((await secondaries.get(secondaryId))!.ownerId).toBe('bob');
    // The "⇩ Join" companion hook fires with the new owner.
    expect(ownerChanges).toEqual([
      { channelId: secondaryId, newOwnerId: 'bob', newOwnerName: 'bob' },
    ]);

    // The re-render now resolves the new owner instead of "Unknown".
    await f.rerenderSecondary(GUILD, secondaryId);
    const rename = actions.ofType('rename').at(-1)!;
    expect(rename.name).toBe("bob's room");
    expect(rename.name).not.toContain('Unknown');
  });

  it('keeps ownership when a non-owner leaves', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const secondaryId = actions.ofType('create')[0]!.channelId;

    voice.put(secondaryId, alice);
    voice.put(secondaryId, member('bob'));
    voice.drop(secondaryId, 'bob');
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: member('bob'),
      beforeChannelId: secondaryId,
    });

    expect((await secondaries.get(secondaryId))!.ownerId).toBe('alice');
  });

  it('transfers to the longest-present member (arrival order), not an arbitrary one', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const sec = actions.ofType('create')[0]!.channelId;
    voice.put(sec, alice); // creator now sitting in the secondary (roster: [alice])

    // carol joins first, then bob → roster becomes [alice, carol, bob].
    const carol = member('carol');
    voice.put(sec, carol);
    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: carol, afterChannelId: sec });
    const bob = member('bob');
    voice.put(sec, bob);
    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: sec });
    expect((await secondaries.get(sec))!.state.roster).toEqual(['alice', 'carol', 'bob']);

    // The owner (alice) leaves → carol inherits (joined before bob), not bob.
    voice.drop(sec, 'alice');
    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: alice, beforeChannelId: sec });

    expect((await secondaries.get(sec))!.ownerId).toBe('carol');
    expect((await secondaries.get(sec))!.state.roster).toEqual(['carol', 'bob']);
  });

  it('self-heals the roster from current members after a gap', async () => {
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await feature.handleVoiceStateUpdate({
      guildId: GUILD,
      member: alice,
      afterChannelId: PRIMARY,
    });
    const sec = actions.ofType('create')[0]!.channelId;

    // Simulate members who joined while untracked (roster still just [alice]).
    voice.put(sec, alice);
    voice.put(sec, member('bob'));
    voice.put(sec, member('carol'));
    voice.drop(sec, 'alice'); // owner leaves

    await feature.handleVoiceStateUpdate({ guildId: GUILD, member: alice, beforeChannelId: sec });

    // alice pruned; bob/carol appended in cache order; first inherits.
    const row = await secondaries.get(sec);
    expect(row!.state.roster).toEqual(['bob', 'carol']);
    expect(row!.ownerId).toBe('bob');
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

  it('repositionSecondaries hands all the primary’s secondaries to the action seam', async () => {
    for (const id of ['a', 'b', 'c']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        state: {},
      });
    }
    const moved = await feature.repositionSecondaries(GUILD, PRIMARY, true);
    expect(moved).toBe(3);
    const action = actions.ofType('reposition')[0]!;
    expect(action.primaryChannelId).toBe(PRIMARY);
    expect(action.above).toBe(true);
    expect([...action.channelIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('repositionSecondaries is a no-op when the primary has no secondaries', async () => {
    const moved = await feature.repositionSecondaries(GUILD, PRIMARY, false);
    expect(moved).toBe(0);
    expect(actions.ofType('reposition')).toHaveLength(0);
  });

  it('repositionSecondaries moves each private channel’s “⇩ Join” companion with it', async () => {
    for (const id of ['a', 'b']) {
      await secondaries.create({
        channelId: id,
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        state: {},
      });
    }
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      // 'a' is private (has a Join companion); 'b' is public.
      joinCompanionFor: (id) => Promise.resolve(id === 'a' ? 'join-a' : undefined),
    });
    await f.repositionSecondaries(GUILD, PRIMARY, true);

    const ids = actions.ofType('reposition')[0]!.channelIds;
    expect(ids).toHaveLength(3);
    expect(ids).toContain('b');
    // The companion sits directly above its secondary.
    expect(ids.indexOf('join-a')).toBe(ids.indexOf('a') - 1);
  });

  it('logs members joining and leaving a secondary at level 3', async () => {
    const logs: { level: number; message: string }[] = [];
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
    });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    const sec = actions.ofType('create')[0]!.channelId;
    voice.put(sec, alice);

    // bob joins the secondary → level-3 "joined".
    voice.put(sec, member('bob'));
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: member('bob'), afterChannelId: sec });
    expect(logs).toContainEqual({ level: 3, message: expect.stringContaining('joined') });

    // bob leaves while alice remains → level-3 "left" (not a deletion).
    voice.drop(sec, 'bob');
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: member('bob'), beforeChannelId: sec });
    expect(logs).toContainEqual({ level: 3, message: expect.stringContaining('left') });
  });

  it('secondaries.create is create-once: a replay does not clobber live state', async () => {
    await secondaries.create({
      channelId: 'co',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { roster: ['alice'], seed: 7 },
    });
    await secondaries.setOwner('co', 'bob');
    await secondaries.updateState('co', { roster: ['alice', 'bob'], seed: 7 });

    // A replayed create with the original seed state must leave the live row intact.
    const replay = await secondaries.create({
      channelId: 'co',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { roster: ['alice'], seed: 7 },
    });
    expect(replay.ownerId).toBe('bob');
    expect(replay.state.roster).toEqual(['alice', 'bob']);
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

  it('getEditorState returns name + status (current + preview) for both scopes', async () => {
    await secondaries.create({
      channelId: 'ed',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0, template: 'My Room' },
    });
    voice.put('ed', member('alice', ['Halo']));

    // channel scope (/name): per-channel name override + inherited status.
    const ch = await feature.getEditorState('channel', GUILD, 'ed');
    expect(ch.found).toBe(true);
    expect(ch.name).toMatchObject({ currentTemplate: 'My Room', preview: 'My Room' });
    // No status override → inherits the default ("Playing @@game_name@@" since Halo).
    expect(ch.status.currentTemplate).toBeUndefined();
    expect(ch.status.preview).toBe('Playing Halo');
    expect(ch.ownerId).toBe('alice');

    // primary scope (/template): the primary's name template (ignores the override).
    const pr = await feature.getEditorState('primary', GUILD, 'ed');
    expect(pr.name).toMatchObject({ currentTemplate: '## [@@game_name@@]', preview: '#1 [Halo]' });

    expect((await feature.getEditorState('channel', GUILD, 'missing')).found).toBe(false);
  });

  it('rerenderSecondary sets the voice status from the status template, and clears it when idle', async () => {
    await secondaries.create({
      channelId: 'st',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [Halo]', index: 0 },
    });
    // Playing Blender → default status template renders "Playing Blender".
    voice.put('st', member('alice', ['Blender']));
    await feature.rerenderSecondary(GUILD, 'st');
    expect(actions.ofType('status').at(-1)).toMatchObject({
      channelId: 'st',
      status: 'Playing Blender',
    });
    expect((await secondaries.get('st'))!.state.status).toBe('Playing Blender');

    // Stops playing → status clears (empty), and a redundant rerender is a no-op.
    voice.put('st', member('alice'));
    await feature.rerenderSecondary(GUILD, 'st');
    expect(actions.ofType('status').at(-1)).toMatchObject({ channelId: 'st', status: '' });

    const before = actions.ofType('status').length;
    await feature.rerenderSecondary(GUILD, 'st');
    expect(actions.ofType('status').length).toBe(before); // no change → no extra status call
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
