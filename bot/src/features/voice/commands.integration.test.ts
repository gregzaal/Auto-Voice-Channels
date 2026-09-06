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
    // owner) is here — so she can't wrestle it back with /reclaim.
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

  /**
   * The commands that change something a template can read now trigger a
   * re-render, and the cost of that has to stay at zero for the guilds whose
   * templates say nothing about it.
   *
   * Both halves matter. The first proves the feature works. **The second is what
   * protects the property the whole design leans on**: `rerenderSecondary`
   * compares the rendered name against the stored one and issues nothing when
   * they match, so `/limit`, `/private` and `/public` cost no renames for the
   * overwhelming majority of guilds. A refactor that weakened the no-op guard
   * would spend a rename per command on every room in the install base, against
   * a budget of two per ten minutes.
   *
   * The re-render is deliberately not awaited by the command (the reply has to
   * land inside Discord's 3-second window and a rate-limited rename spends 2.5s
   * in its probe), so these await a macrotask to let it settle.
   */
  describe('re-renders triggered by a command', () => {
    /**
     * Waits for the detached re-render to land. Polling rather than a fixed
     * number of ticks: it does several awaited database round trips, and how
     * many turns that takes is not something a test should hard-code.
     */
    const settle = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if (done()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    it('renames once when the template reads the user limit, and never otherwise', async () => {
      voice.setUserLimit(SEC, 0);
      await autoChannels.upsert(GUILD, PRIMARY, {
        name: 'room{{@@limit@@>=1 ?? @@slots@@ free}}',
      });
      await secondaries.updateState(SEC, { name: 'room', index: 0 });

      const before = actions.ofType('rename').length;
      // The recording action seam does not move the live view, so mirror what
      // Discord's cache does after a successful edit.
      voice.setUserLimit(SEC, 4);
      await commands.setLimit(GUILD, SEC, 'alice', 4);
      await settle(() => actions.ofType('rename').length > before);
      const renames = actions.ofType('rename').slice(before);
      expect(renames).toHaveLength(1);
      expect(renames[0]).toMatchObject({ channelId: SEC, name: 'room 3 free' });
    });

    it('renames nothing when the template does not mention the limit', async () => {
      await autoChannels.upsert(GUILD, PRIMARY, { name: '## [@@game_name@@]' });
      await secondaries.updateState(SEC, { name: '#1 [General]', index: 0 });

      const before = actions.ofType('rename').length;
      voice.setUserLimit(SEC, 4);
      await commands.setLimit(GUILD, SEC, 'alice', 4);
      // Nothing to wait FOR here, so give the detached work a generous window
      // and assert it still did nothing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(actions.ofType('rename').slice(before)).toHaveLength(0);
    });

    it('still reports the limit change to the caller when the name is unchanged', async () => {
      const res = await commands.setLimit(GUILD, SEC, 'alice', 7);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('7');
    });
  });
});
