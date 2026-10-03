import { EventEmitter } from 'node:events';
import type { JoinChannelRow, Logger } from '@avc/core';
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../../runtime/testUtils.js';
import { registerJoinRequests } from './joinRequests.js';
import type { PrivacyService } from './privacy.js';

const GUILD = 'guild-1';
const JOIN = 'join-1';
const ROOM = 'room-1';

const ctx: JoinChannelRow = {
  channelId: JOIN,
  guildId: GUILD,
  secondaryChannelId: ROOM,
  creatorId: 'alice',
  createdAt: new Date(0),
};

function setup(
  over: {
    context?: JoinChannelRow | undefined;
    blocked?: boolean | (() => Promise<boolean>);
    entitled?: (guildId: string) => boolean;
    logger?: Logger;
  } = {},
) {
  const sent: { channelId: string; payload: unknown }[] = [];
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    channels: {
      fetch: (channelId: string) =>
        Promise.resolve({
          isTextBased: () => true,
          send: (payload: unknown) => {
            sent.push({ channelId, payload });
            return Promise.resolve();
          },
        }),
    },
  }) as unknown as Client;
  const blocked = over.blocked ?? false;
  const privacy = {
    getJoinContext: vi.fn((channelId: string) =>
      Promise.resolve(channelId === JOIN ? ('context' in over ? over.context : ctx) : undefined),
    ),
    refuseBlockedKnock: vi.fn(() =>
      typeof blocked === 'function' ? blocked() : Promise.resolve(blocked),
    ),
  };
  const dispose = registerJoinRequests({
    client,
    privacy: privacy as unknown as PrivacyService,
    logger: over.logger ?? fakeLogger(),
    ...(over.entitled ? { entitled: over.entitled } : {}),
  });
  /** A member moving into `channelId`, then everything the listener started finishing. */
  const knock = async (memberId: string, channelId: string = JOIN) => {
    emitter.emit(
      'voiceStateUpdate',
      { channelId: undefined },
      { channelId, guild: { id: GUILD }, member: { id: memberId } },
    );
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { sent, privacy, knock, dispose };
}

describe('registerJoinRequests', () => {
  it('posts the card into the room and confirms in the lobby for a member who knocks', async () => {
    const { sent, privacy, knock } = setup();

    await knock('bob');

    expect(privacy.refuseBlockedKnock).toHaveBeenCalledWith(ctx, 'bob');
    expect(sent.map((s) => s.channelId)).toEqual([ROOM, JOIN]);
    expect(JSON.stringify(sent[0]!.payload)).toContain('<@bob>');
  });

  /** The point of the saved block: no card for somebody the owner has already said no to. */
  it('posts nothing at all for a blocked member', async () => {
    const { sent, privacy, knock } = setup({ blocked: true });

    await knock('mallory');

    expect(privacy.refuseBlockedKnock).toHaveBeenCalledWith(ctx, 'mallory');
    expect(sent).toEqual([]);
  });

  it('asks about a blocked member before it posts anything, and only for a real knock', async () => {
    const order: string[] = [];
    const { privacy, knock } = setup({
      blocked: () => {
        order.push('asked');
        return Promise.resolve(false);
      },
    });
    privacy.getJoinContext.mockImplementation((channelId: string) => {
      order.push('context');
      return Promise.resolve(channelId === JOIN ? ctx : undefined);
    });

    await knock('bob');

    expect(order.slice(0, 2)).toEqual(['context', 'asked']);
  });

  it('does not ask about the owner re-entering their own lobby', async () => {
    const { sent, privacy, knock } = setup({ blocked: true });
    await knock('alice');
    expect(privacy.refuseBlockedKnock).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('ignores a channel that is not a join channel', async () => {
    const { sent, privacy, knock } = setup({ blocked: true });
    await knock('bob', 'some-other-channel');
    expect(privacy.refuseBlockedKnock).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('ignores a guild that is not entitled, before any read', async () => {
    const { privacy, knock } = setup({ entitled: () => false });
    await knock('bob');
    expect(privacy.getJoinContext).not.toHaveBeenCalled();
  });

  it('contains an error and posts nothing rather than throwing into the voice listener', async () => {
    const error = vi.fn();
    const logger = { ...fakeLogger(), error } as unknown as Logger;
    const { sent, knock } = setup({ logger, blocked: () => Promise.reject(new Error('db down')) });

    await knock('bob');

    expect(error).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it('stops listening when disposed', async () => {
    const { privacy, knock, dispose } = setup();
    dispose();
    await knock('bob');
    expect(privacy.getJoinContext).not.toHaveBeenCalled();
  });
});
