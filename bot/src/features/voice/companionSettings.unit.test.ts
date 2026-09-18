import { describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../../runtime/testUtils.js';
import { GuildSettingsService } from './settings.js';
import { DEFAULT_TEXT_CHANNEL_NAME } from './guildSettings.js';

const GUILD = '460459401086763010';

/**
 * The three writers behind `/textchannels` and the `/setup` modal.
 *
 * Unit, against fake repositories: what is worth pinning here is the decision
 * each one makes, not the SQL. Two of them are refusals, and one of those is a
 * privacy guard rather than validation.
 */
function makeService(
  opts: { template?: Record<string, unknown>; settings?: Record<string, unknown> } = {},
) {
  const upsert = vi.fn().mockResolvedValue(undefined);
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  const mergeSettings = vi.fn((_g: string, decide: (existing: unknown) => { result: unknown }) => {
    const decided = decide({ settings: opts.settings ?? {} }) as {
      remove?: string[];
      result: unknown;
    };
    return Promise.resolve({ ...(decided.result as object), removed: decided.remove ?? [] });
  });
  const service = new GuildSettingsService({
    guilds: {
      ensure: vi.fn().mockResolvedValue({ settings: opts.settings ?? {} }),
      updateSettings,
      mergeSettings,
    } as never,
    autoChannels: {
      get: vi.fn().mockResolvedValue({
        channelId: 'primary-1',
        guildId: GUILD,
        template: opts.template ?? {},
      }),
      upsert,
    } as never,
    secondaries: { get: vi.fn().mockResolvedValue(undefined) } as never,
    actions: {} as never,
    logger: fakeLogger(),
  });
  return { service, upsert, updateSettings, mergeSettings };
}

describe('companion text settings', () => {
  describe('toggleTextChannel', () => {
    it('sets the field on, and stores nothing when turning it off', async () => {
      const on = makeService();
      await on.service.toggleTextChannel(GUILD, 'primary-1');
      expect(on.upsert).toHaveBeenCalledWith(GUILD, 'primary-1', { textChannel: true });

      const off = makeService({ template: { textChannel: true, name: 'Room' } });
      await off.service.toggleTextChannel(GUILD, 'primary-1');
      // Deleted rather than written false, so a creator channel that never
      // wanted it carries no opinion at all through every export.
      expect(off.upsert).toHaveBeenCalledWith(GUILD, 'primary-1', { name: 'Room' });
    });

    it('says what a member will actually get, without claiming privacy it cannot give', async () => {
      const { service } = makeService();
      const result = await service.toggleTextChannel(GUILD, 'primary-1');
      expect(result.ok).toBe(true);
      // The honest claim: visibility follows the room, and joining is still open.
      expect(result.message).toMatch(/whoever is in the room/i);
      expect(result.message).toMatch(/can still join/i);
      expect(result.message).not.toMatch(/only the people in the room/i);
    });
  });

  describe('setTextChannelName', () => {
    it('warns that Discord will not render the name as typed', async () => {
      const { service, updateSettings } = makeService();
      const result = await service.setTextChannelName(GUILD, '  War Room  ');
      expect(updateSettings).toHaveBeenCalledWith(GUILD, { text_channel_name: 'War Room' });
      expect(result.message).toMatch(/lowercases/i);
    });

    it('clears back to the default on an empty submit', async () => {
      const { service, mergeSettings } = makeService();
      const result = await service.setTextChannelName(GUILD, '   ');
      expect(mergeSettings).toHaveBeenCalled();
      expect(result.message).toContain(DEFAULT_TEXT_CHANNEL_NAME);
    });

    it('refuses a name Discord would reject', async () => {
      const { service, updateSettings } = makeService();
      const result = await service.setTextChannelName(GUILD, 'x'.repeat(101));
      expect(result.ok).toBe(false);
      expect(updateSettings).not.toHaveBeenCalled();
    });
  });

  describe('setTextChannelRole', () => {
    /**
     * The guard that matters. `@everyone`'s role id IS the guild id, so storing
     * it would grant View to the whole server and undo the deny that makes a
     * companion private. Discord's own role picker offers it, so this is one
     * click away rather than only reachable through a hand-edited import file.
     */
    it('refuses the everyone role, which would publish every room chat', async () => {
      const { service, updateSettings } = makeService();
      const result = await service.setTextChannelRole(GUILD, GUILD);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/everyone/i);
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it('stores an ordinary role and says the change reaches existing channels', async () => {
      const { service, updateSettings } = makeService();
      const result = await service.setTextChannelRole(GUILD, '555000111222333444');
      expect(updateSettings).toHaveBeenCalledWith(GUILD, {
        text_channel_role: '555000111222333444',
      });
      expect(result.message).toMatch(/existing channels are updated/i);
    });

    it('clears the role', async () => {
      const { service, mergeSettings } = makeService();
      await service.setTextChannelRole(GUILD, null);
      expect(mergeSettings).toHaveBeenCalled();
    });
  });
});
