import {
  AutoChannelRepository,
  GuildRepository,
  JoinChannelRepository,
  ManagedChannelRepository,
  SecondaryChannelRepository,
  db,
} from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { VoiceFeature } from './handler.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import { PrivacyService } from './privacy.js';
import type { VoiceStateEvent } from './types.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-voice-test';
const PRIMARY = 'primary-1';

describe('VoiceFeature (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let managed: ManagedChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let feature: VoiceFeature;

  beforeAll(async () => {
    env = await startPostgres();
    guilds = new GuildRepository(env.handle.db);
    autoChannels = new AutoChannelRepository(env.handle.db);
    secondaries = new SecondaryChannelRepository(env.handle.db);
    managed = new ManagedChannelRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    await env.handle.db.delete(db.schema.secondaryChannels);
    await env.handle.db.delete(db.schema.managedChannels);
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

  it('notifies (without crashing) when it can’t create a secondary (missing permissions)', async () => {
    const logs: { level: number; message: string }[] = [];
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
      permissionProblems: problems,
    });
    actions.failCreate = true;
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    expect(actions.ofType('create')).toHaveLength(0); // the create threw
    expect(problems.recent(GUILD).map((p) => p.channelId)).toContain(PRIMARY);
    expect(logs.some((l) => l.level === 1 && l.message.includes('create a channel'))).toBe(true);
  });

  it('clears the create incident once a create works again', async () => {
    const problems = new PermissionProblemTracker();
    const resolved: string[] = [];
    problems.onResolved = (guildId) => resolved.push(guildId);
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);

    actions.failCreate = true;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    expect(problems.recent(GUILD)).toHaveLength(1);

    // The admin fixes the override. Nothing cleared the create incident before
    // this, and unlike a secondary the creator channel lives on, so it stuck
    // around for the life of the process and kept being reported as broken.
    actions.failCreate = false;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    expect(problems.recent(GUILD)).toEqual([]);
    expect(resolved).toEqual([GUILD]);
  });

  it('blames the creator channel, not the room it just deleted, when the move fails', async () => {
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    actions.failMove = true;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    // The secondary is created then deleted on this path, so recording it
    // would hand the admin a `<#id>` mention for a channel that no longer
    // exists. The creator channel is the thing they configured.
    const recorded = problems.recent(GUILD);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.channelId).toBe(PRIMARY);
    expect(recorded[0]!.operation).toBe('move');
  });

  it('does not clear-and-re-record on every join when only the move fails', async () => {
    const problems = new PermissionProblemTracker();
    const resolved: string[] = [];
    problems.onResolved = (guildId) => resolved.push(guildId);
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
    });
    const alice = member('alice');
    voice.put(PRIMARY, alice);
    actions.failMove = true;

    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    // Both failures record against the primary, so clearing on a bare create
    // would resolve and re-open the guild on every join, which resets the
    // notifier's backoff and turns four notices into one per join.
    expect(resolved).toEqual([]);
    expect(problems.recent(GUILD)).toHaveLength(1);
  });

  it('gives up a channel it can no longer delete (Missing Access), notifying instead of retrying', async () => {
    const logs: { level: number; message: string }[] = [];
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      serverLog: (_g, level, message) => logs.push({ level, message }),
      permissionProblems: problems,
    });
    await secondaries.create({
      channelId: 'locked',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: 'Locked', index: 0 },
    });
    // The empty channel can't be deleted — a permission override hid it from us.
    actions.failDeleteForChannel = 'locked';
    await f.handleVoiceStateUpdate({
      guildId: GUILD,
      member: member('alice'),
      beforeChannelId: 'locked',
    });

    // Stopped tracking it (so the reconcile won't retry forever), recorded + notified.
    expect(await secondaries.get('locked')).toBeUndefined();
    expect(problems.recent(GUILD).map((p) => p.channelId)).toContain('locked');
    expect(logs.some((l) => l.level === 1 && l.message.includes('lost access'))).toBe(true);
  });

  it('logs a rate-limited rename as deferred (level 2), and a normal rename as applied', async () => {
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
    await secondaries.create({
      channelId: 'rl',
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: 'stale', index: 0 },
    });
    voice.put('rl', member('alice', ['Halo']));

    // Discord defers the rename → the log says so, at the renames level (2).
    actions.simulateRenameRateLimit = true;
    await f.rerenderSecondary(GUILD, 'rl');
    const deferred = logs.find((l) => l.message.includes('deferred'));
    expect(deferred?.level).toBe(2);
    expect(deferred?.message).toContain('rate-limiting');
    expect(deferred?.message).not.toContain('renamed to');

    // When the limit clears, a real rename logs as applied (no "deferred").
    logs.length = 0;
    actions.simulateRenameRateLimit = false;
    voice.put('rl', member('alice', ['Doom'])); // change the game so the name drifts again
    await f.rerenderSecondary(GUILD, 'rl');
    expect(logs).toContainEqual({ level: 2, message: expect.stringContaining('renamed to') });
    expect(logs.some((l) => l.message.includes('deferred'))).toBe(false);
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

  it('a default-private primary spawns its secondaries private (locked + companion)', async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    const joinChannels = new JoinChannelRepository(env.handle.db);
    const privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
    });
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      makePrivateOnCreate: (g, c, ownerId, ownerName) =>
        privacy.makePrivateForCreation(g, c, ownerId, ownerName),
    });
    // A prior test may have left the guild blocked; ensure it's entitled to create.
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room", defaultPrivate: true });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Locked to @everyone, the creator granted Connect by id, and a companion spawned.
    expect(actions.ofType('privacy')).toContainEqual(
      expect.objectContaining({ channelId: secondaryId, isPrivate: true }),
    );
    expect(actions.ofType('connect')).toContainEqual(
      expect.objectContaining({ channelId: secondaryId, memberId: 'alice', allow: true }),
    );
    expect(actions.ofType('joinChannel')).toHaveLength(1);
    expect((await secondaries.get(secondaryId))!.state.private).toBe(true);
    // The channel is locked before the creator is moved into it.
    const privacyIdx = actions.actions.findIndex(
      (a) => a.type === 'privacy' && a.channelId === secondaryId,
    );
    const moveIdx = actions.actions.findIndex((a) => a.type === 'move' && a.memberId === 'alice');
    expect(privacyIdx).toBeLessThan(moveIdx);
  });

  it('deletes a default-private room it could not lock down, blaming the creator channel', async () => {
    await env.handle.db.delete(db.schema.joinChannels);
    const joinChannels = new JoinChannelRepository(env.handle.db);
    const privacy = new PrivacyService({
      secondaries,
      joinChannels,
      actions,
      voice,
      logger: fakeLogger(),
    });
    const problems = new PermissionProblemTracker();
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      permissionProblems: problems,
      makePrivateOnCreate: (g, c, ownerId, ownerName) =>
        privacy.makePrivateForCreation(g, c, ownerId, ownerName),
    });
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room", defaultPrivate: true });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    actions.failPrivacy = true;
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    const secondaryId = actions.ofType('create')[0]!.channelId;
    // Created, then deleted again -- a locked room nobody, not even the
    // owner, can get into is worse than no room at all.
    expect(actions.ofType('delete')).toContainEqual(
      expect.objectContaining({ channelId: secondaryId }),
    );
    expect(await secondaries.get(secondaryId)).toBeUndefined();
    // Nobody was ever moved into a room they could not have gotten into anyway.
    expect(actions.ofType('move')).toEqual([]);

    // Same convention as a failed move: blame the creator channel, not the
    // secondary that's already gone by the time this is recorded.
    const recorded = problems.recent(GUILD);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.channelId).toBe(PRIMARY);
    expect(recorded[0]!.operation).toBe('privacy');
  });

  it('a public (default) primary spawns secondaries without locking them', async () => {
    const f = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
      makePrivateOnCreate: () => Promise.reject(new Error('should not be called')),
    });
    await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
    await autoChannels.upsert(GUILD, PRIMARY, { name: "@@creator@@'s room" });

    const alice = member('alice');
    voice.put(PRIMARY, alice);
    await f.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: PRIMARY });

    expect(actions.ofType('privacy')).toHaveLength(0);
    expect(actions.ofType('joinChannel')).toHaveLength(0);
  });

  describe('adopted standalone channels (managed)', () => {
    const ADOPTED = 'adopted-vc';
    let f: VoiceFeature;

    beforeEach(() => {
      f = new VoiceFeature({
        autoChannels,
        secondaries,
        managed,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
      });
    });

    it('adopts a channel: seeds owner from occupants and renders the occupied name', async () => {
      const alice = member('alice');
      voice.put(ADOPTED, alice);

      const res = await f.adoptChannel(GUILD, ADOPTED, 'General');
      expect(res.ok).toBe(true);

      const row = (await managed.get(ADOPTED))!;
      expect(row.ownerId).toBe('alice');
      expect(row.template.name).toBe("__General/@@creator@@'s room__");
      // Occupied → "Alice's room".
      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: "alice's room",
      });
    });

    it('refuses to adopt a primary or an already-adopted channel', async () => {
      expect((await f.adoptChannel(GUILD, PRIMARY, 'x')).ok).toBe(false);
      voice.put(ADOPTED, member('alice'));
      await f.adoptChannel(GUILD, ADOPTED, 'General');
      expect((await f.adoptChannel(GUILD, ADOPTED, 'General')).ok).toBe(false);
    });

    it('drops a managed channel confirmed deleted on Discord, without pestering the admin', async () => {
      const logs: { level: number; message: string }[] = [];
      const problems = new PermissionProblemTracker();
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        managed,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        serverLog: (_g, level, message) => logs.push({ level, message }),
        permissionProblems: problems,
      });
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await feature.adoptChannel(GUILD, ADOPTED, 'General');

      // The channel is deleted on Discord; the next rename confirms it is gone.
      actions.renameGoneForChannel = ADOPTED;
      voice.drop(ADOPTED, 'alice');
      await feature.rerenderManaged(GUILD, ADOPTED, { onUnmanageable: 'abandon' });

      // The row is gone, so reconcile can never retry the impossible rename.
      expect(await managed.get(ADOPTED)).toBeUndefined();
      // Deleting your own channel is not a permission problem: say nothing.
      expect(problems.recent(GUILD)).toHaveLength(0);
      expect(logs.filter((l) => l.level === 1)).toHaveLength(0);
    });

    it('gives up an adopted channel it can no longer rename (Missing Access), notifying instead of retrying', async () => {
      const logs: { level: number; message: string }[] = [];
      const problems = new PermissionProblemTracker();
      const feature = new VoiceFeature({
        autoChannels,
        secondaries,
        managed,
        guilds,
        actions,
        voice,
        selfHosted: true,
        logger: fakeLogger(),
        serverLog: (_g, level, message) => logs.push({ level, message }),
        permissionProblems: problems,
      });
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await feature.adoptChannel(GUILD, ADOPTED, 'General');

      // The channel still exists but an override hid it from us.
      actions.failRenameForChannel = ADOPTED;
      voice.drop(ADOPTED, 'alice');
      await feature.rerenderManaged(GUILD, ADOPTED, { onUnmanageable: 'abandon' });

      expect(await managed.get(ADOPTED)).toBeUndefined();
      expect(problems.recent(GUILD).map((p) => p.operation)).toContain('rename');
      expect(logs.some((l) => l.level === 1 && l.message.includes('lost access'))).toBe(true);
    });

    it('keeps the admin’s template when an interactive rename hits a permission error', async () => {
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await f.adoptChannel(GUILD, ADOPTED, 'General');
      const before = (await managed.get(ADOPTED))!.template;

      // An interactive caller (the `/template` editor) must never have the
      // template it just saved binned under it for a recoverable problem.
      actions.failRenameForChannel = ADOPTED;
      voice.drop(ADOPTED, 'alice');
      await expect(f.rerenderManaged(GUILD, ADOPTED)).rejects.toThrow();

      const after = await managed.get(ADOPTED);
      expect(after).toBeDefined();
      expect(after!.template).toEqual(before);
    });

    it('stops tracking managed and secondary channels deleted on Discord', async () => {
      voice.put(ADOPTED, member('alice'));
      await f.adoptChannel(GUILD, ADOPTED, 'General');
      await secondaries.create({
        channelId: 'sec-gone',
        guildId: GUILD,
        primaryChannelId: PRIMARY,
        ownerId: 'alice',
        state: { name: 'Gone', index: 0 },
      });

      await f.handleChannelDeleted(GUILD, ADOPTED);
      await f.handleChannelDeleted(GUILD, 'sec-gone');

      expect(await managed.get(ADOPTED)).toBeUndefined();
      expect(await secondaries.get('sec-gone')).toBeUndefined();
      // Idempotent: a redelivered event must not throw.
      await expect(f.handleChannelDeleted(GUILD, ADOPTED)).resolves.toBeUndefined();
    });

    /**
     * The primaries branch. Without it a deleted creator channel left an
     * `auto_channels` row that nothing anywhere removed, so `/setup` listed a
     * channel that no longer existed for as long as the guild lived.
     */
    it('stops tracking a creator channel deleted on Discord', async () => {
      expect(await autoChannels.get(PRIMARY)).toBeDefined();

      await f.handleChannelDeleted(GUILD, PRIMARY);

      expect(await autoChannels.get(PRIMARY)).toBeUndefined();
      // Idempotent: a redelivered event must not throw.
      await expect(f.handleChannelDeleted(GUILD, PRIMARY)).resolves.toBeUndefined();
    });

    it('ignores a deleted channel belonging to another guild', async () => {
      await f.handleChannelDeleted('some-other-guild', PRIMARY);

      expect(await autoChannels.get(PRIMARY)).toBeDefined();
    });

    it('renames to the resting name when emptied — and never deletes the channel', async () => {
      const alice = member('alice');
      voice.put(ADOPTED, alice);
      await f.adoptChannel(GUILD, ADOPTED, 'General');

      // alice leaves → channel empties.
      voice.drop(ADOPTED, 'alice');
      const touched = await f.handleVoiceStateUpdate({
        guildId: GUILD,
        member: alice,
        beforeChannelId: ADOPTED,
      });
      expect(touched).toContain(ADOPTED);
      await f.rerenderManaged(GUILD, ADOPTED); // the scheduler does this in production

      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: 'General',
      });
      expect(actions.ofType('delete')).toHaveLength(0);
      expect(await managed.get(ADOPTED)).toBeDefined();
      expect((await managed.get(ADOPTED))!.ownerId).toBeNull();
    });

    it('claims ownership and shows the occupied name when someone joins an empty one', async () => {
      await managed.create({
        channelId: ADOPTED,
        guildId: GUILD,
        template: { name: "__General/@@creator@@'s room__" },
        state: { seed: 1, name: 'General' },
      });
      const bob = member('bob');
      voice.put(ADOPTED, bob);

      await f.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: ADOPTED });
      expect((await managed.get(ADOPTED))!.ownerId).toBe('bob');
      await f.rerenderManaged(GUILD, ADOPTED);
      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: "bob's room",
      });
    });

    it('edits templates, stops managing, and exposes editor state', async () => {
      voice.put(ADOPTED, member('alice'));
      await f.adoptChannel(GUILD, ADOPTED, 'General');

      const editor = await f.getManagedEditorState(GUILD, ADOPTED);
      expect(editor.found).toBe(true);
      expect(editor.name.currentTemplate).toBe("__General/@@creator@@'s room__");

      expect((await f.setManagedName(GUILD, ADOPTED, '__Lobby/@@creator@@ is live__')).ok).toBe(
        true,
      );
      expect((await managed.get(ADOPTED))!.template.name).toBe('__Lobby/@@creator@@ is live__');
      expect((await f.setManagedName(GUILD, ADOPTED, '   ')).ok).toBe(false); // blank rejected

      const stop = await f.stopManaging(GUILD, ADOPTED);
      expect(stop.ok).toBe(true);
      expect(await managed.get(ADOPTED)).toBeUndefined();
    });

    it('reconcile converges names, never deletes, and drops vanished records', async () => {
      // A live adopted channel whose stored name has drifted from reality.
      await managed.create({
        channelId: ADOPTED,
        guildId: GUILD,
        ownerId: 'alice',
        template: { name: "__General/@@creator@@'s room__" },
        state: { seed: 1, name: 'STALE', roster: ['alice'] },
      });
      voice.put(ADOPTED, member('alice'));
      // A vanished adopted channel (record exists, channel gone).
      await managed.create({
        channelId: 'gone-vc',
        guildId: GUILD,
        template: { name: '__X/Y__' },
        state: {},
      });

      await f.reconcileGuild(GUILD);

      expect(actions.ofType('rename').at(-1)).toMatchObject({
        channelId: ADOPTED,
        name: "alice's room",
      });
      expect(actions.ofType('delete')).toHaveLength(0); // adopted channels are never deleted
      expect(await managed.get(ADOPTED)).toBeDefined();
      expect(await managed.get('gone-vc')).toBeUndefined(); // stale record dropped
    });
  });

  describe('category grouping (/group)', () => {
    const CAT = 'cat-1';
    const A = 'primary-A';
    const B = 'primary-B';

    beforeEach(async () => {
      await autoChannels.upsert(GUILD, A, { name: '## room' });
      await autoChannels.upsert(GUILD, B, { name: '## room' });
      voice.setParent(A, CAT);
      voice.setParent(B, CAT);
      await guilds.transitionAuth({ guildId: GUILD, toStatus: 'trial' });
      // The guilds row persists across tests, so clear any grouping from a prior one.
      await guilds.updateSettings(GUILD, { groups: {} });
    });

    const enableGroup = (above = false): Promise<unknown> =>
      guilds.updateSettings(GUILD, { groups: { [CAT]: { above } } });

    it('numbers group-wide and positions one block across primaries on create', async () => {
      await enableGroup(false); // below
      const alice = member('alice');
      voice.put(A, alice);
      await feature.handleVoiceStateUpdate({ guildId: GUILD, member: alice, afterChannelId: A });
      const sA = actions.ofType('create').at(-1)!.channelId;
      voice.put(sA, alice);
      voice.drop(A, 'alice');

      const bob = member('bob');
      voice.put(B, bob);
      await feature.handleVoiceStateUpdate({ guildId: GUILD, member: bob, afterChannelId: B });
      const sB = actions.ofType('create').at(-1)!.channelId;

      // Group-wide numbering across the two primaries: #1 then #2.
      expect((await secondaries.get(sA))!.state.index).toBe(0);
      expect((await secondaries.get(sB))!.state.index).toBe(1);
      expect(actions.ofType('create').map((a) => a.name)).toEqual(['#1 room', '#2 room']);

      // One block of both secondaries, below all primaries.
      const rg = actions.ofType('repositionGroup').at(-1)!;
      expect(rg.channelIds).toEqual([sA, sB]);
      expect(new Set(rg.primaryChannelIds)).toEqual(new Set([A, B]));
      expect(rg.above).toBe(false);

      // Appending a new channel never renames the existing ones (no churn).
      expect(actions.ofType('rename')).toHaveLength(0);
    });

    it('resyncCategory renumbers group-wide and repositions the block', async () => {
      await enableGroup(true); // above
      await secondaries.create({
        channelId: 's1',
        guildId: GUILD,
        primaryChannelId: A,
        ownerId: 'a',
        state: { name: 'stale', index: 5 },
      });
      await secondaries.create({
        channelId: 's2',
        guildId: GUILD,
        primaryChannelId: B,
        ownerId: 'b',
        state: { name: 'stale', index: 9 },
      });
      voice.put('s1', member('a'));
      voice.put('s2', member('b'));

      const summary = await feature.resyncCategory(GUILD, CAT);
      expect(summary.considered).toBe(2);
      expect((await secondaries.get('s1'))!.state.index).toBe(0);
      expect((await secondaries.get('s2'))!.state.index).toBe(1);
      expect(actions.ofType('rename').map((a) => a.name)).toEqual(['#1 room', '#2 room']);
      const rg = actions.ofType('repositionGroup').at(-1)!;
      expect(rg.channelIds).toEqual(['s1', 's2']);
      expect(rg.above).toBe(true);
    });

    it('resyncCategory reverts to per-primary numbering + positioning when not grouped', async () => {
      // No group config → ungrouped path.
      for (const [p, id] of [
        [A, 'a1'],
        [A, 'a2'],
        [B, 'b1'],
      ] as const) {
        await secondaries.create({
          channelId: id,
          guildId: GUILD,
          primaryChannelId: p,
          ownerId: 'o',
          state: { name: 'stale', index: 7 },
        });
        voice.put(id, member('o'));
      }

      await feature.resyncCategory(GUILD, CAT);
      // Per-primary numbering: A → 0,1 ; B → 0.
      expect((await secondaries.get('a1'))!.state.index).toBe(0);
      expect((await secondaries.get('a2'))!.state.index).toBe(1);
      expect((await secondaries.get('b1'))!.state.index).toBe(0);
      // Per-primary reposition for each primary — not a single group reposition.
      expect(actions.ofType('repositionGroup')).toHaveLength(0);
      expect(
        actions
          .ofType('reposition')
          .map((a) => a.primaryChannelId)
          .sort(),
      ).toEqual([A, B].sort());
    });

    it('reconcile compacts group numbering + repositions, and never deletes', async () => {
      await enableGroup(false);
      await secondaries.create({
        channelId: 's1',
        guildId: GUILD,
        primaryChannelId: A,
        ownerId: 'a',
        state: { name: 'STALE', index: 3 },
      });
      await secondaries.create({
        channelId: 's2',
        guildId: GUILD,
        primaryChannelId: B,
        ownerId: 'b',
        state: { name: 'STALE', index: 8 },
      });
      voice.put('s1', member('a'));
      voice.put('s2', member('b'));

      await feature.reconcileGuild(GUILD);
      expect((await secondaries.get('s1'))!.state.index).toBe(0);
      expect((await secondaries.get('s2'))!.state.index).toBe(1);
      const names = actions.ofType('rename').map((a) => a.name);
      expect(names).toContain('#1 room');
      expect(names).toContain('#2 room');
      expect(actions.ofType('repositionGroup').length).toBeGreaterThan(0);
      expect(actions.ofType('delete')).toHaveLength(0);
    });

    it('groups root-level primaries via the @root sentinel', async () => {
      voice.setParent(A, null);
      voice.setParent(B, null);
      await guilds.updateSettings(GUILD, { groups: { '@root': { above: true } } });
      await secondaries.create({
        channelId: 'r1',
        guildId: GUILD,
        primaryChannelId: A,
        ownerId: 'a',
        state: { name: 'x', index: 0 },
      });
      await secondaries.create({
        channelId: 'r2',
        guildId: GUILD,
        primaryChannelId: B,
        ownerId: 'b',
        state: { name: 'x', index: 0 },
      });
      voice.put('r1', member('a'));
      voice.put('r2', member('b'));

      await feature.resyncCategory(GUILD, '@root');
      expect((await secondaries.get('r1'))!.state.index).toBe(0);
      expect((await secondaries.get('r2'))!.state.index).toBe(1);
      const rg = actions.ofType('repositionGroup').at(-1)!;
      expect(rg.channelIds).toEqual(['r1', 'r2']);
      expect(rg.above).toBe(true);
    });
  });
});
