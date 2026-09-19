import { describe, expect, it, vi } from 'vitest';
import { ControlPanelPoster } from './controlPanelPoster.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import type { SecondaryChannelRepository } from '@avc/core';

const GUILD = 'g1';
const ROOM = 'room-1';
const PRIMARY = 'creator-1';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as never;

function setup(
  opts: {
    state?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    row?: { guildId: string } | null;
    send?: (channelId: string, payload: unknown) => Promise<string>;
  } = {},
) {
  const setControlPanelMessage = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn(opts.send ?? (async () => 'msg-1'));
  const problems = new PermissionProblemTracker();
  const serverLog = vi.fn();
  const count = vi.fn();
  const poster = new ControlPanelPoster({
    send: send as never,
    guilds: { ensure: vi.fn().mockResolvedValue({ settings: opts.settings ?? {} }) } as never,
    secondaries: {
      get: vi
        .fn()
        .mockResolvedValue(
          opts.row === null
            ? undefined
            : { guildId: opts.row?.guildId ?? GUILD, state: opts.state ?? {} },
        ),
      setControlPanelMessage,
    } as unknown as SecondaryChannelRepository,
    logger: silentLogger,
    permissionProblems: problems,
    serverLog,
    count,
  });
  return { poster, send, setControlPanelMessage, problems, serverLog, count };
}

describe('ControlPanelPoster', () => {
  it('posts into the channel it is given and records the message id', async () => {
    const { poster, send, setControlPanelMessage, count } = setup();
    await poster.postForRoom(GUILD, ROOM, PRIMARY, 'companion-1');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('companion-1');
    expect(setControlPanelMessage).toHaveBeenCalledWith(ROOM, 'msg-1', 'companion-1');
    expect(count).toHaveBeenCalledWith('posted', GUILD);
  });

  /**
   * The replay guard. A caught-up reconcile or a redelivered voice event runs
   * the whole create path again against a room that already has a panel.
   */
  it('posts nothing when the room already carries a panel', async () => {
    const { poster, send, count } = setup({ state: { controlPanelMessageId: 'already' } });
    await poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM);
    expect(send).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('posts nothing for a room this fleet does not own, or one that is gone', async () => {
    const other = setup({ row: { guildId: 'someone-else' } });
    await other.poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM);
    expect(other.send).not.toHaveBeenCalled();

    const missing = setup({ row: null });
    await missing.poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM);
    expect(missing.send).not.toHaveBeenCalled();
  });

  it('posts nothing, and reports nothing, when the server switched the panel off', async () => {
    const { poster, send, count, problems } = setup({
      settings: { control_panel: { panel: false } },
    });
    await poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM);
    expect(send).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(problems.recent(GUILD)).toEqual([]);
  });

  /**
   * The realistic failure: the bot grants itself no Send Messages on the rooms
   * it creates, so any category that denies it produces this on every room
   * while everything else works.
   */
  it('reports a failed post against the creator channel and never throws', async () => {
    const { poster, problems, serverLog, count } = setup({
      send: () => Promise.reject(new Error('Missing Permissions')),
    });
    await expect(poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM)).resolves.toBeUndefined();
    expect(problems.recent(GUILD)).toEqual([
      expect.objectContaining({ channelId: PRIMARY, operation: 'panel' }),
    ]);
    expect(serverLog).toHaveBeenCalledWith(GUILD, 1, expect.stringContaining(PRIMARY));
    expect(count).toHaveBeenCalledWith('failed', GUILD);
  });

  /**
   * A post that worked is a post that worked. Nothing below the send is the
   * server's fault, so telling an admin to grant Send Messages when the
   * buttons are sitting in the channel in front of them is advice that names
   * the wrong fix, which is how a notice stops being believed.
   */
  it('does not blame the server when only recording the message id fails', async () => {
    const { poster, problems, count, send } = setup();
    (
      poster as unknown as { deps: { secondaries: { setControlPanelMessage: unknown } } }
    ).deps.secondaries.setControlPanelMessage = vi
      .fn()
      .mockRejectedValue(new Error('connection reset'));
    await expect(poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith('posted', GUILD);
    expect(problems.recent(GUILD)).toEqual([]);
  });

  /**
   * Same reasoning one step earlier: everything before the send is a database
   * read, and a blip there is ours, not theirs.
   */
  it('does not blame the server when the read before the post fails', async () => {
    const { poster, problems, count, send } = setup();
    (poster as unknown as { deps: { secondaries: { get: unknown } } }).deps.secondaries.get = vi
      .fn()
      .mockRejectedValue(new Error('db down'));
    await expect(poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith('failed', GUILD);
    expect(problems.recent(GUILD)).toEqual([]);
  });

  /**
   * Nothing else ever removes a `panel` incident, so without this one bad
   * afternoon would leave /setup reporting a problem forever and `onResolved`
   * would never fire, pinning the notifier's backoff at whatever rung it had
   * climbed to.
   */
  it('clears the panel incident once a post works, and only that one', async () => {
    const { poster, problems } = setup();
    problems.record(GUILD, { channelId: PRIMARY, operation: 'panel', at: 1 });
    problems.record(GUILD, { channelId: PRIMARY, operation: 'companion', at: 1 });
    await poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM);
    expect(problems.recent(GUILD)).toEqual([
      expect.objectContaining({ channelId: PRIMARY, operation: 'companion' }),
    ]);
  });
});
