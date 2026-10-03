import { DiscordAPIError } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  BOT_ACCESS,
  CONNECT,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  VIEW_CHANNEL,
  planAccess,
  type ResolvedOverwrite,
} from './accessPlan.js';
import { RecordingVoiceActions } from './actions.js';

const GUILD = 'g1';
const ROOM = 'room-1';
const BOT = 'bot';
const VC = VIEW_CHANNEL | CONNECT;

const member = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_MEMBER,
  allow,
  deny,
});
const role = (id: string, allow = 0n, deny = 0n): ResolvedOverwrite => ({
  id,
  type: OVERWRITE_ROLE,
  allow,
  deny,
});
const botOverwrite = member(BOT, BOT_ACCESS);

/** The fake's overwrite store and its recorded actions: what a service test reads back. */
describe('RecordingVoiceActions overwrites', () => {
  it('reads a room that was never seeded as holding none', async () => {
    const actions = new RecordingVoiceActions();
    await expect(actions.readOverwrites(GUILD, ROOM)).resolves.toEqual([]);
  });

  it('reads back what a test seeded, as a copy it cannot change the store through', async () => {
    const actions = new RecordingVoiceActions();
    actions.seedOverwrites(ROOM, [role(GUILD, 0n, CONNECT)]);
    const read = (await actions.readOverwrites(GUILD, ROOM))!;
    read[0]!.deny = 0n;
    expect(actions.overwritesOf(ROOM)).toEqual([role(GUILD, 0n, CONNECT)]);
  });

  it('stores what is applied, and records it with the set it was planned against', async () => {
    const actions = new RecordingVoiceActions();
    const previous = [role(GUILD)];
    actions.seedOverwrites(ROOM, previous);
    const desired = [role(GUILD, 0n, CONNECT), botOverwrite];
    const result = await actions.applyOverwrites(GUILD, ROOM, desired, previous);

    expect(result).toMatchObject({ deferred: false, channelGone: false, droppedMemberIds: [] });
    expect(actions.overwritesOf(ROOM)).toEqual(desired);
    expect(actions.ofType('overwrites')).toEqual([
      {
        type: 'overwrites',
        guildId: GUILD,
        channelId: ROOM,
        written: desired,
        previous,
        droppedMemberIds: [],
        requests: 2,
      },
    ]);
  });

  /** The same rule as the real adapter: 1 or 2 changes are one request each, more than that is one bulk. */
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 1],
    [10, 1],
  ])('costs what the adapter would for %i changes: %i requests', async (changes, requests) => {
    const actions = new RecordingVoiceActions();
    const desired = Array.from({ length: changes }, (_, i) => member(`m${i}`, VC));
    const result = await actions.applyOverwrites(GUILD, ROOM, desired, []);
    expect(result.requests).toBe(requests);
  });

  it('leaves out members it is told are not in the server, and says so', async () => {
    const actions = new RecordingVoiceActions();
    actions.unknownMemberIds.add('ghost');
    const desired = [botOverwrite, member('alice', VC), member('ghost', VC)];
    const result = await actions.applyOverwrites(GUILD, ROOM, desired, []);

    expect(result.droppedMemberIds).toEqual(['ghost']);
    expect(result.written.map((o) => o.id)).toEqual([BOT, 'alice']);
    expect(actions.overwritesOf(ROOM).map((o) => o.id)).toEqual([BOT, 'alice']);
    expect(actions.ofType('overwrites')[0]!.droppedMemberIds).toEqual(['ghost']);
  });

  it('does not second-guess an overwrite that is already there, as the adapter does not', async () => {
    const actions = new RecordingVoiceActions();
    actions.unknownMemberIds.add('departed');
    const previous = [member('departed', 1n)];
    const result = await actions.applyOverwrites(
      GUILD,
      ROOM,
      [...previous, botOverwrite],
      previous,
    );
    expect(result.droppedMemberIds).toEqual([]);
    expect(result.written.map((o) => o.id)).toEqual(['departed', BOT]);
  });

  it('rejects with Missing Permissions and changes nothing when told to fail', async () => {
    const actions = new RecordingVoiceActions();
    actions.seedOverwrites(ROOM, [role(GUILD)]);
    actions.failOverwrites = true;
    await expect(actions.applyOverwrites(GUILD, ROOM, [botOverwrite], [])).rejects.toMatchObject({
      code: 50013,
    });
    expect(actions.overwritesOf(ROOM)).toEqual([role(GUILD)]);
    expect(actions.ofType('overwrites')).toEqual([]);
  });

  it('rejects a read with Missing Access when told to fail', async () => {
    const actions = new RecordingVoiceActions();
    actions.failReadOverwrites = true;
    const err = await actions.readOverwrites(GUILD, ROOM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordAPIError);
    expect(err).toMatchObject({ code: 50001 });
  });

  it('reports a channel that is gone', async () => {
    const actions = new RecordingVoiceActions();
    actions.overwritesGoneForChannel = ROOM;
    await expect(actions.readOverwrites(GUILD, ROOM)).resolves.toBeNull();
    await expect(actions.applyOverwrites(GUILD, ROOM, [botOverwrite], [])).resolves.toMatchObject({
      channelGone: true,
      requests: 0,
    });
    expect(actions.ofType('overwrites')).toEqual([]);
  });

  it('reports deferred when told Discord is rate limiting, and still stores the write', async () => {
    const actions = new RecordingVoiceActions();
    actions.simulateOverwriteRateLimit = true;
    const result = await actions.applyOverwrites(GUILD, ROOM, [botOverwrite], []);
    expect(result.deferred).toBe(true);
    expect(actions.overwritesOf(ROOM)).toEqual([botOverwrite]);
  });

  it('answers roleExists as the adapter does: never @everyone, never a role marked missing', async () => {
    const actions = new RecordingVoiceActions();
    actions.missingRoleIds.add('deleted');
    await expect(actions.roleExists(GUILD, 'mods')).resolves.toBe(true);
    await expect(actions.roleExists(GUILD, 'deleted')).resolves.toBe(false);
    await expect(actions.roleExists(GUILD, GUILD)).resolves.toBe(false);
  });

  /** A planner and the fake together: what a service test over both will see. */
  it('round-trips a hide through read, plan and apply, and then has nothing left to do', async () => {
    const actions = new RecordingVoiceActions();
    actions.seedOverwrites(ROOM, [role('members', VC), role(GUILD)]);
    const input = {
      guildId: GUILD,
      botId: BOT,
      mode: 'hidden' as const,
      previousMode: 'public' as const,
      record: null,
      ownerId: 'owner',
      occupants: ['alice'],
      trusted: [],
      admitted: [],
      blocked: [],
    };

    const current = (await actions.readOverwrites(GUILD, ROOM))!;
    const plan = planAccess({ ...input, current });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await actions.applyOverwrites(GUILD, ROOM, plan.desired, current);

    // A hide of this size is the one bulk request, however many it changed.
    expect(actions.ofType('overwrites')[0]!.requests).toBe(1);
    const after = (await actions.readOverwrites(GUILD, ROOM))!;
    const again = planAccess({
      ...input,
      previousMode: 'hidden',
      current: after,
      record: {
        baseline: plan.facts.baseline ?? {},
        neutralised: plan.facts.neutralised,
      },
    });
    expect(again.ok && again.diff).toEqual({ upserts: [], deletes: [] });
  });
});

describe('RecordingVoiceActions.moveMember', () => {
  it('records a plain move exactly as it always did, with no onlyFrom key', async () => {
    const actions = new RecordingVoiceActions();
    await actions.moveMember(GUILD, 'u1', 'room');
    expect(actions.actions).toEqual([
      { type: 'move', guildId: GUILD, memberId: 'u1', channelId: 'room' },
    ]);
  });

  it('records onlyFrom when the caller scoped the move', async () => {
    const actions = new RecordingVoiceActions();
    await actions.moveMember(GUILD, 'u1', null, { onlyFrom: 'room' });
    expect(actions.ofType('move')).toEqual([
      { type: 'move', guildId: GUILD, memberId: 'u1', channelId: null, onlyFrom: 'room' },
    ]);
  });

  it('leaves a member alone who is somewhere other than onlyFrom, or not in voice', async () => {
    const actions = new RecordingVoiceActions();
    actions.setMemberChannel('moved', 'elsewhere');
    actions.setMemberChannel('left', null);
    actions.setMemberChannel('here', 'room');
    for (const id of ['moved', 'left', 'here']) {
      await actions.moveMember(GUILD, id, null, { onlyFrom: 'room' });
    }
    expect(actions.ofType('move').map((m) => m.memberId)).toEqual(['here']);
  });

  it('takes a member it was not told about to be where the caller expects', async () => {
    const actions = new RecordingVoiceActions();
    await actions.moveMember(GUILD, 'unknown', null, { onlyFrom: 'room' });
    expect(actions.ofType('move')).toHaveLength(1);
  });

  it('ignores onlyFrom for a plain move, whatever it knows', async () => {
    const actions = new RecordingVoiceActions();
    actions.setMemberChannel('u1', 'elsewhere');
    await actions.moveMember(GUILD, 'u1', 'room');
    expect(actions.ofType('move')).toHaveLength(1);
  });

  it('swallows a member who is not connected, as the adapter swallows 40032', async () => {
    const actions = new RecordingVoiceActions();
    actions.notConnectedMemberIds.add('u1');
    await expect(actions.moveMember(GUILD, 'u1', null)).resolves.toBeUndefined();
    expect(actions.ofType('move')).toEqual([]);
  });

  it('still fails a move it is told to fail', async () => {
    const actions = new RecordingVoiceActions();
    actions.failMove = true;
    await expect(actions.moveMember(GUILD, 'u1', 'room')).rejects.toMatchObject({ code: 50013 });
  });
});
