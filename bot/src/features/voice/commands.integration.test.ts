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

  it('renames a channel by id (admin override), and resets it', async () => {
    voice.put(SEC, member('alice', ['Halo']));
    const res = await commands.renameById(GUILD, SEC, 'Admin Named');
    expect(res.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBe('Admin Named');
    expect(actions.ofType('rename').at(-1)!.name).toBe('Admin Named');

    expect((await commands.renameById(GUILD, 'nope', 'x')).ok).toBe(false);

    const reset = await commands.renameById(GUILD, SEC, 'reset');
    expect(reset.ok).toBe(true);
    expect((await secondaries.get(SEC))!.state.template).toBeUndefined();
  });

  it('transfers ownership to a member in the channel', async () => {
    voice.put(SEC, member('bob'));
    const res = await commands.transfer(GUILD, SEC, 'alice', 'bob');
    expect(res.ok).toBe(true);
    expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
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
    expect((await secondaries.get(SEC))!.ownerId).toBe('bob');
  });

  it('refuses claiming when the owner is still present', async () => {
    voice.put(SEC, member('bob'));
    const res = await commands.claim(GUILD, SEC, 'bob');
    expect(res.ok).toBe(false);
    expect((await secondaries.get(SEC))!.ownerId).toBe('alice');
  });
});
