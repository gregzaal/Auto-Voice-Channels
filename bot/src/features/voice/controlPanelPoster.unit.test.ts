import { describe, expect, it, vi } from 'vitest';
import { ControlPanelPoster, type PanelRoomRow } from './controlPanelPoster.js';
import { buildControlPanel, controlPanelFingerprint, type RoomPanelView } from './controlPanel.js';
import { readControlPanel } from './guildSettings.js';
import { PermissionProblemTracker } from './permissionProblems.js';
import type { SecondaryChannelRepository } from '@avc/core';

const GUILD = 'g1';
const ROOM = '123456789012345678';
const PRIMARY = '223456789012345678';
const MESSAGE = '323456789012345678';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as never;

const view = (over: Partial<RoomPanelView> = {}): RoomPanelView => ({
  ownerId: '423456789012345678',
  primaryChannelId: PRIMARY,
  isPrivate: false,
  userLimit: 0,
  ...over,
});

/** The fingerprint the panel would have for a given settings blob and view. */
function fingerprintFor(settings: Record<string, unknown>, v: RoomPanelView): string {
  return controlPanelFingerprint(buildControlPanel(ROOM, readControlPanel(settings), v));
}

function setup(
  opts: {
    state?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    row?: { guildId: string } | null;
    send?: () => Promise<string>;
    edit?: () => Promise<void>;
  } = {},
) {
  const setControlPanelMessage = vi.fn().mockResolvedValue(undefined);
  const clearControlPanelMessage = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn(opts.send ?? (async () => MESSAGE));
  const edit = vi.fn(opts.edit ?? (async () => undefined));
  const problems = new PermissionProblemTracker();
  const serverLog = vi.fn();
  const count = vi.fn();
  const poster = new ControlPanelPoster({
    send: send as never,
    edit: edit as never,
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
      clearControlPanelMessage,
    } as unknown as SecondaryChannelRepository,
    logger: silentLogger,
    permissionProblems: problems,
    serverLog,
    count,
  });
  return {
    poster,
    send,
    edit,
    setControlPanelMessage,
    clearControlPanelMessage,
    problems,
    serverLog,
    count,
  };
}

describe('ControlPanelPoster.postForRoom', () => {
  it('posts where it is told and records the message with its fingerprint', async () => {
    const { poster, send, setControlPanelMessage, count } = setup();
    await poster.postForRoom(GUILD, ROOM, PRIMARY, 'companion-1', view());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('companion-1');
    expect(setControlPanelMessage).toHaveBeenCalledWith(
      ROOM,
      MESSAGE,
      'companion-1',
      fingerprintFor({}, view()),
    );
    expect(count).toHaveBeenCalledWith('posted', GUILD);
  });

  it('posts nothing when the room already carries a panel', async () => {
    const { poster, send, count } = setup({ state: { controlPanelMessageId: 'already' } });
    await poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view());
    expect(send).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('posts nothing for a room this fleet does not own, or one that is gone', async () => {
    const other = setup({ row: { guildId: 'someone-else' } });
    await other.poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view());
    expect(other.send).not.toHaveBeenCalled();

    const missing = setup({ row: null });
    await missing.poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view());
    expect(missing.send).not.toHaveBeenCalled();
  });

  it('posts nothing, and reports nothing, when the server switched the panel off', async () => {
    const { poster, send, count, problems } = setup({
      settings: { control_panel: { panel: false } },
    });
    await poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view());
    expect(send).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(problems.recent(GUILD)).toEqual([]);
  });

  /**
   * The realistic failure: the bot grants itself no Send Messages on the rooms
   * it creates, so any category that denies it produces this on every room.
   */
  it('reports a failed post against the creator channel and never throws', async () => {
    const { poster, problems, serverLog, count } = setup({
      send: () => Promise.reject(new Error('Missing Permissions')),
    });
    await expect(poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view())).resolves.toBeUndefined();
    expect(problems.recent(GUILD)).toEqual([
      expect.objectContaining({ channelId: PRIMARY, operation: 'panel' }),
    ]);
    expect(count).toHaveBeenCalledWith('failed', GUILD);
    // The server log line is how an admin with a Send Messages denial finds out
    // at all, so it is asserted rather than merely spied on.
    expect(serverLog).toHaveBeenCalledWith(GUILD, 1, expect.stringContaining(PRIMARY));
  });

  it('does not blame the server when only recording the message id fails', async () => {
    const { poster, problems, count, send } = setup();
    (
      poster as unknown as { deps: { secondaries: { setControlPanelMessage: unknown } } }
    ).deps.secondaries.setControlPanelMessage = vi
      .fn()
      .mockRejectedValue(new Error('connection reset'));
    await expect(poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view())).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith('posted', GUILD);
    expect(problems.recent(GUILD)).toEqual([]);
  });

  it('clears the panel incident once a post works, and only that one', async () => {
    const { poster, problems } = setup();
    problems.record(GUILD, { channelId: PRIMARY, operation: 'panel', at: 1 });
    problems.record(GUILD, { channelId: PRIMARY, operation: 'companion', at: 1 });
    await poster.postForRoom(GUILD, ROOM, PRIMARY, ROOM, view());
    expect(problems.recent(GUILD)).toEqual([
      expect.objectContaining({ channelId: PRIMARY, operation: 'companion' }),
    ]);
  });
});

describe('ControlPanelPoster.refreshForRoom', () => {
  /** A room with a posted panel, fingerprinted for the given settings and view. */
  const posted = (settings: Record<string, unknown>, v: RoomPanelView): PanelRoomRow => ({
    guildId: GUILD,
    state: {
      controlPanelMessageId: MESSAGE,
      controlPanelChannelId: ROOM,
      controlPanelHash: fingerprintFor(settings, v),
    },
  });

  /**
   * The fingerprint is the whole reason this can hang off every rerender,
   * including the bulk sweeps that walk a guild. If it stops short-circuiting,
   * every sweep becomes one edit per room.
   */
  it('issues no request at all when nothing about the room changed', async () => {
    const { poster, edit, setControlPanelMessage, count } = setup();
    await poster.refreshForRoom(GUILD, ROOM, posted({}, view()), view());
    expect(edit).not.toHaveBeenCalled();
    expect(setControlPanelMessage).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it.each([
    ['the room was locked', view({ isPrivate: true })],
    ['the owner changed', view({ ownerId: '999999999999999999' })],
    ['a size was set', view({ userLimit: 6 })],
  ])('edits the panel when %s', async (_what, changed) => {
    const { poster, edit, setControlPanelMessage, count } = setup();
    await poster.refreshForRoom(GUILD, ROOM, posted({}, view()), changed);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]![0]).toBe(ROOM);
    expect(edit.mock.calls[0]![1]).toBe(MESSAGE);
    expect(setControlPanelMessage).toHaveBeenCalledWith(
      ROOM,
      MESSAGE,
      ROOM,
      fingerprintFor({}, changed),
    );
    expect(count).toHaveBeenCalledWith('updated', GUILD);
  });

  it('edits the panel when the server switches a button off', async () => {
    const { poster, edit } = setup({ settings: { control_panel: { kick: false } } });
    await poster.refreshForRoom(GUILD, ROOM, posted({}, view()), view());
    expect(edit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(edit.mock.calls[0]![2])).not.toContain('kick');
  });

  /**
   * Switched off after the panel was posted. Edited down to nothing rather than
   * deleted: deleting somebody's scrollback is a bigger act than the setting
   * asked for, and an empty edit leaves no buttons, which is what off means.
   */
  /**
   * Discord refuses an edit that would leave a message with no content, no
   * embeds and no components, so the switched-off panel becomes a line rather
   * than a blank. Deleting it is not the answer either: that is somebody's
   * scrollback, and the setting did not ask for it.
   */
  it('edits the panel down to a line, not to nothing, when it is switched off', async () => {
    const { poster, edit } = setup({ settings: { control_panel: { panel: false } } });
    await poster.refreshForRoom(GUILD, ROOM, posted({}, view()), view());
    expect(edit).toHaveBeenCalledTimes(1);
    const payload = edit.mock.calls[0]![2] as {
      content?: string;
      embeds: unknown[];
      components: unknown[];
    };
    expect(payload.content).toBeTruthy();
    expect(payload.embeds).toEqual([]);
    expect(payload.components).toEqual([]);
  });

  it('does nothing for a room that never had a panel', async () => {
    const { poster, edit } = setup();
    await poster.refreshForRoom(GUILD, ROOM, { guildId: GUILD, state: {} }, view());
    expect(edit).not.toHaveBeenCalled();
  });

  /**
   * A database read, so ours and transient. Forgetting the binding here would
   * mean one Postgres blip during a sweep permanently withdrawing the panel
   * from every room in the guild, with the messages left posted and frozen and
   * nothing that ever re-posts outside create.
   */
  it('keeps the panel when the settings read fails', async () => {
    const { poster, edit, clearControlPanelMessage } = setup();
    (poster as unknown as { deps: { guilds: { ensure: unknown } } }).deps.guilds.ensure = vi
      .fn()
      .mockRejectedValue(new Error('db down'));
    await expect(
      poster.refreshForRoom(GUILD, ROOM, posted({}, view()), view({ isPrivate: true })),
    ).resolves.toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
    expect(clearControlPanelMessage).not.toHaveBeenCalled();
  });

  /**
   * The panel on screen is already correct; only the fingerprint is stale, so
   * the next render issues one harmless identical edit. Forgetting the binding
   * would leave a live, correct panel that nothing could ever update again.
   */
  it('keeps the panel when only recording the new fingerprint fails', async () => {
    const { poster, edit, clearControlPanelMessage, count } = setup();
    (
      poster as unknown as { deps: { secondaries: { setControlPanelMessage: unknown } } }
    ).deps.secondaries.setControlPanelMessage = vi
      .fn()
      .mockRejectedValue(new Error('connection reset'));
    await expect(
      poster.refreshForRoom(GUILD, ROOM, posted({}, view()), view({ isPrivate: true })),
    ).resolves.toBeUndefined();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(clearControlPanelMessage).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith('updated', GUILD);
  });

  /**
   * Almost always a message somebody deleted. Retrying it on every rerender for
   * the life of the room would be a request per render forever, and the admin
   * is told nothing because the original post proved permissions were fine.
   */
  it('forgets a message it cannot edit, and reports nothing to the admin', async () => {
    const { poster, clearControlPanelMessage, problems, count } = setup({
      edit: () => Promise.reject(new Error('Unknown Message')),
    });
    await expect(
      poster.refreshForRoom(GUILD, ROOM, posted({}, view()), view({ isPrivate: true })),
    ).resolves.toBeUndefined();
    expect(clearControlPanelMessage).toHaveBeenCalledWith(ROOM);
    expect(problems.recent(GUILD)).toEqual([]);
    expect(count).not.toHaveBeenCalledWith('updated', GUILD);
  });
});
