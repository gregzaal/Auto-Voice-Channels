import { DiscordAPIError } from 'discord.js';
import type { Client, GuildMember, VoiceState } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordVoiceActions, normalizeVoiceState } from './discordAdapter.js';

const UNKNOWN_CHANNEL = 10003;

function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: 'x' } as never,
    code,
    code === UNKNOWN_CHANNEL ? 404 : 403,
    'DELETE',
    'https://discord.test',
    {} as never,
  );
}

const fakeMember = (id = 'u1'): GuildMember =>
  ({
    id,
    displayName: 'Greg',
    user: { bot: false },
    presence: null,
    roles: { cache: new Map() },
    voice: { streaming: false },
  }) as unknown as GuildMember;

const voiceState = (over: Partial<Record<string, unknown>>): VoiceState =>
  ({
    guild: { id: 'g1' },
    member: fakeMember(),
    channelId: null,
    ...over,
  }) as unknown as VoiceState;

function clientWith(channel: unknown): Client {
  return { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;
}

describe('normalizeVoiceState', () => {
  it('returns undefined without a guild or without a member', () => {
    expect(
      normalizeVoiceState(voiceState({ guild: null }), voiceState({ guild: null })),
    ).toBeUndefined();
    expect(
      normalizeVoiceState(voiceState({ member: null }), voiceState({ member: null })),
    ).toBeUndefined();
  });

  it('maps before/after channel ids and builds the member', () => {
    const event = normalizeVoiceState(
      voiceState({ channelId: 'a' }),
      voiceState({ channelId: 'b' }),
    );
    expect(event).toMatchObject({
      guildId: 'g1',
      beforeChannelId: 'a',
      afterChannelId: 'b',
      member: { id: 'u1', displayName: 'Greg', bot: false },
    });
  });

  it('omits a channel id that is null (join-only / leave-only)', () => {
    const join = normalizeVoiceState(
      voiceState({ channelId: null }),
      voiceState({ channelId: 'b' }),
    );
    expect(join).not.toHaveProperty('beforeChannelId');
    expect(join).toMatchObject({ afterChannelId: 'b' });
  });
});

describe('DiscordVoiceActions.deleteChannel', () => {
  it('swallows an Unknown Channel error (idempotent)', async () => {
    const channel = {
      isVoiceBased: () => true,
      delete: vi.fn().mockRejectedValue(apiError(UNKNOWN_CHANNEL)),
    };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.deleteChannel('g1', 'c1')).resolves.toBeUndefined();
  });

  it('rethrows any other API error', async () => {
    const channel = {
      isVoiceBased: () => true,
      delete: vi.fn().mockRejectedValue(apiError(50013)),
    };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.deleteChannel('g1', 'c1')).rejects.toBeInstanceOf(DiscordAPIError);
  });
});

describe('DiscordVoiceActions.renameChannel (rate-limit probe)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports rateLimited when the rename outlives the probe window', async () => {
    vi.useFakeTimers();
    const channel = {
      isVoiceBased: () => true,
      setName: vi.fn().mockReturnValue(new Promise(() => {})),
    };
    const actions = new DiscordVoiceActions(clientWith(channel));
    const pending = actions.renameChannel('g1', 'c1', 'New name');
    await vi.advanceTimersByTimeAsync(2600); // past RENAME_PROBE_MS (2500)
    await expect(pending).resolves.toEqual({ rateLimited: true });
  });

  it('reports not rate-limited when the rename applies promptly', async () => {
    vi.useFakeTimers();
    const channel = { isVoiceBased: () => true, setName: vi.fn().mockResolvedValue(undefined) };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.renameChannel('g1', 'c1', 'New name')).resolves.toEqual({
      rateLimited: false,
    });
  });

  it('is a no-op for a non-voice channel', async () => {
    const channel = { isVoiceBased: () => false };
    const actions = new DiscordVoiceActions(clientWith(channel));
    await expect(actions.renameChannel('g1', 'c1', 'x')).resolves.toEqual({ rateLimited: false });
  });
});
