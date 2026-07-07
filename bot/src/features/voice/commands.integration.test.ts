import { AutoChannelRepository, GuildRepository, SecondaryChannelRepository, db } from '@avc/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgTestEnv } from '../../test/pgContainer.js';
import { startPostgres } from '../../test/pgContainer.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { RecordingVoiceActions } from './actions.js';
import { VoiceCommands } from './commands.js';
import { VoiceFeature } from './handler.js';
import { FakeVoiceView, fakeMember as member } from './voiceTestUtils.js';

const GUILD = 'guild-cmd-test';
const PRIMARY = 'primary-1';
const SEC = 'sec-1';

describe('VoiceCommands (integration)', () => {
  let env: PgTestEnv;
  let guilds: GuildRepository;
  let autoChannels: AutoChannelRepository;
  let secondaries: SecondaryChannelRepository;
  let voice: FakeVoiceView;
  let actions: RecordingVoiceActions;
  let commands: VoiceCommands;

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
    const feature = new VoiceFeature({
      autoChannels,
      secondaries,
      guilds,
      actions,
      voice,
      selfHosted: true,
      logger: fakeLogger(),
    });
    commands = new VoiceCommands({ secondaries, actions, voice, feature, logger: fakeLogger() });
    await guilds.ensure(GUILD);
    await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
    await secondaries.create({
      channelId: SEC,
      guildId: GUILD,
      primaryChannelId: PRIMARY,
      ownerId: 'alice',
      state: { name: '#1 [General]', index: 0 },
    });
    voice.put(SEC, member('alice'));
  });

  it('owner can set and clear the user limit', async () => {
    const set = await commands.setLimit(GUILD, SEC, 'alice', 5);
    expect(set.ok).toBe(true);
    expect(actions.ofType('limit').at(-1)).toMatchObject({ channelId: SEC, limit: 5 });

    const cleared = await commands.unlimit(GUILD, SEC, 'alice');
    expect(cleared.ok).toBe(true);
    expect(actions.ofType('limit').at(-1)).toMatchObject({ channelId: SEC, limit: 0 });
  });

  it('rejects an out-of-range limit', async () => {
    const res = await commands.setLimit(GUILD, SEC, 'alice', 500);
    expect(res.ok).toBe(false);
    expect(actions.ofType('limit')).toHaveLength(0);
  });

  it('rejects a non-owner', async () => {
    const res = await commands.setLimit(GUILD, SEC, 'mallory', 5);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/owner/i);
    expect(actions.ofType('limit')).toHaveLength(0);
  });

  it('rejects when the channel is not bot-managed', async () => {
    const res = await commands.setLimit(GUILD, 'random-channel', 'alice', 5);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/bot-managed/i);
  });

  it('sets a custom name override and re-renders, then resets', async () => {
    voice.put(SEC, member('alice', ['Halo']));
    const set = await commands.setName(GUILD, SEC, 'alice', 'My Lounge');
    expect(set.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBe('My Lounge');
    expect(actions.ofType('rename').at(-1)!.name).toBe('My Lounge');

    const reset = await commands.setName(GUILD, SEC, 'alice', 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBeUndefined();
    // Back to the primary template rendered against alice playing Halo.
    expect(actions.ofType('rename').at(-1)!.name).toBe('#1 [Halo]');
  });

  it('warns in the reply when a rename is rate-limited', async () => {
    actions.simulateRenameRateLimit = true;
    voice.put(SEC, member('alice'));
    const res = await commands.setName(GUILD, SEC, 'alice', 'A Brand New Name');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/rate-limit/i);
  });

  it('blocks a non-owner from renaming, but allows an admin override', async () => {
    voice.put(SEC, member('alice', ['Halo']));

    // Mallory doesn't own SEC (alice does) and isn't admin → rejected.
    const denied = await commands.setName(GUILD, SEC, 'mallory', 'Hijacked');
    expect(denied.ok).toBe(false);
    expect((await secondaries.get(SEC))!.state.template).toBeUndefined();

    // Same call with the admin flag succeeds (absorbs the old /rename).
    const allowed = await commands.setName(GUILD, SEC, 'mallory', 'Admin Named', { admin: true });
    expect(allowed.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBe('Admin Named');
    expect(actions.ofType('rename').at(-1)!.name).toBe('Admin Named');
  });

  it('sets and resets the per-channel status override', async () => {
    voice.put(SEC, member('alice'));
    const set = await commands.setStatus(GUILD, SEC, 'alice', 'AFK 💤');
    expect(set.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBe('AFK 💤');
    expect(actions.ofType('status').at(-1)).toMatchObject({ channelId: SEC, status: 'AFK 💤' });

    const reset = await commands.setStatus(GUILD, SEC, 'alice', 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBeUndefined();
  });

  it('stores an empty status as a blank override (not a reset) and clears it', async () => {
    voice.put(SEC, member('alice'));
    await commands.setStatus(GUILD, SEC, 'alice', 'AFK 💤');
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBe('AFK 💤');

    const blank = await commands.setStatus(GUILD, SEC, 'alice', '');
    expect(blank.ok).toBe(true);
    // Stored as an empty string (a deliberate blank), NOT deleted/inherited.
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBe('');
    // …and the channel status is cleared on Discord.
    expect(actions.ofType('status').at(-1)).toMatchObject({ channelId: SEC, status: '' });

    // An explicit `reset` still removes the override entirely.
    const reset = await commands.setStatus(GUILD, SEC, 'alice', 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.statusTemplate).toBeUndefined();
  });

  it('transfers ownership to a member in the channel', async () => {
    voice.put(SEC, member('bob'));
    const res = await commands.transfer(GUILD, SEC, 'alice', 'bob');
    expect(res.ok).toBe(true);
    const row = await secondaries.get(SEC);
    expect(row!.ownerId).toBe('bob');
    // A transfer is a durable handover: bob also becomes the original creator.
    expect(row!.originalCreator).toBe('bob');
  });

  it('refuses transfer to someone not in the channel', async () => {
    const res = await commands.transfer(GUILD, SEC, 'alice', 'charlie');
    expect(res.ok).toBe(false);
    expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
  });

  it('allows claiming when the owner has left', async () => {
    voice.drop(SEC, 'alice');
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'bob');
    expect(res.ok).toBe(true);
    const row = await secondaries.get(SEC);
    expect(row!.ownerId).toBe('bob');
    // A non-creator claim is durable: bob becomes the new original creator.
    expect(row!.originalCreator).toBe('bob');
  });

  it('refuses claiming when the owner is still present', async () => {
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'bob');
    expect(res.ok).toBe(false);
    expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
  });

  it('reassigns the original creator on transfer, so the giver cannot reclaim it', async () => {
    voice.put(SEC, member('bob'));
    await commands.transfer(GUILD, SEC, 'alice', 'bob');
    expect((await secondaries.get(SEC))!.originalCreator).toBe('bob');

    // Alice is still present but no longer the original creator, and bob (the
    // owner) is here — so she can't wrestle it back with /claim.
    const reclaim = await commands.claim(GUILD, SEC, 'alice');
    expect(reclaim.ok).toBe(false);
    expect(reclaim.message).toMatch(/still here/i);
    expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
  });

  it('lets the original creator reclaim the channel from a caretaker owner', async () => {
    // Alice leaves; the caretaker handoff (setOwner, as handleSecondaryLeave does)
    // makes bob the owner but keeps alice as the original creator.
    await secondaries.setOwner(SEC, 'bob');
    expect((await secondaries.get(SEC))!.originalCreator).toBe('alice');

    // Alice returns — both she and caretaker bob are present. She reclaims it even
    // though bob is still here, because she is the original creator.
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'alice');
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/reclaim/i);
    const row = await secondaries.get(SEC);
    expect(row!.ownerId).toBe('alice');
    expect(row!.originalCreator).toBe('alice');
  });
});
