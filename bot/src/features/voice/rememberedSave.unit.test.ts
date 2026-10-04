import { MAX_MEMBER_PREF_STATUS_LENGTH, type SaveMemberPrefResult } from '@avc/core';
import { describe, expect, it, vi } from 'vitest';
import { buildEditorModal } from '../../commands/templatePanel.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { buildRenameModal } from './controlPanel.js';
import type { EditorState } from './handler.js';
import {
  PANEL_NAME_MAX,
  isTruncatedPrefill,
  rememberSetting,
  type RememberedSaveDeps,
  type RememberedSetting,
} from './rememberedSave.js';

const GUILD = 'guild-1';
const PRIMARY = 'primary-1';
const ROOM = 'room-1';

const room = (ownerId: string | null = 'alice') => ({
  guildId: GUILD,
  channelId: ROOM,
  primaryChannelId: PRIMARY,
  ownerId,
});

const SAVED: SaveMemberPrefResult = { status: 'saved' };

function harness(over: Partial<RememberedSaveDeps> = {}) {
  const saveName = vi.fn().mockResolvedValue(SAVED);
  const saveLimit = vi.fn().mockResolvedValue(SAVED);
  const savePrivacy = vi.fn().mockResolvedValue(SAVED);
  const saveStatus = vi.fn().mockResolvedValue(SAVED);
  const info = vi.fn();
  const warn = vi.fn();
  const deps: RememberedSaveDeps = {
    memberPrefs: { saveName, saveLimit, savePrivacy, saveStatus },
    logger: { ...fakeLogger(), info, warn } as never,
    ...over,
  };
  return { deps, saveName, saveLimit, savePrivacy, saveStatus, info, warn };
}

const NAME: RememberedSetting = { field: 'name', value: 'Den' };
const LIMIT: RememberedSetting = { field: 'limit', value: 4 };
const PRIVACY: RememberedSetting = { field: 'privacy', value: 'hidden' };
const STATUS: RememberedSetting = { field: 'status', value: 'AFK' };

describe('rememberSetting', () => {
  it('saves each setting for the owner, against the creator channel the room came from', async () => {
    const { deps, saveName, saveLimit, savePrivacy, saveStatus } = harness();
    await rememberSetting(deps, room(), 'alice', NAME);
    await rememberSetting(deps, room(), 'alice', LIMIT);
    await rememberSetting(deps, room(), 'alice', PRIVACY);
    await rememberSetting(deps, room(), 'alice', STATUS);
    expect(saveName).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', 'Den');
    expect(saveLimit).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', 4);
    expect(savePrivacy).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', 'hidden');
    expect(saveStatus).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', 'AFK');
    // Each went to its own column and to no other.
    for (const save of [saveName, saveLimit, savePrivacy, saveStatus]) {
      expect(save).toHaveBeenCalledTimes(1);
    }
  });

  /** A blank status is a room left without one, which is a value and not a reset. */
  it('saves a blank status as a value, and takes one back out on null', async () => {
    const { deps, saveStatus } = harness();
    await rememberSetting(deps, room(), 'alice', { field: 'status', value: '' });
    await rememberSetting(deps, room(), 'alice', { field: 'status', value: null });
    expect(saveStatus.mock.calls).toEqual([
      [GUILD, PRIMARY, 'alice', ''],
      [GUILD, PRIMARY, 'alice', null],
    ]);
  });

  /**
   * The predicate is the room's owner BY EQUALITY. Passing the owner check is not the same
   * thing: a moderator may rename any room, and a room with no owner passes every check.
   */
  describe('who it saves for', () => {
    it('does not save for somebody who is not the room owner', async () => {
      const { deps, saveName, saveLimit, savePrivacy, saveStatus } = harness();
      for (const setting of [NAME, LIMIT, PRIVACY, STATUS]) {
        await rememberSetting(deps, room('alice'), 'mallory', setting);
      }
      expect(saveName).not.toHaveBeenCalled();
      expect(saveLimit).not.toHaveBeenCalled();
      expect(savePrivacy).not.toHaveBeenCalled();
      expect(saveStatus).not.toHaveBeenCalled();
    });

    it('does not save against a room that has no owner, whoever acts', async () => {
      const { deps, saveName, saveLimit, savePrivacy, saveStatus } = harness();
      for (const setting of [NAME, LIMIT, PRIVACY, STATUS]) {
        await rememberSetting(deps, room(null), 'mallory', setting);
      }
      expect(saveName).not.toHaveBeenCalled();
      expect(saveLimit).not.toHaveBeenCalled();
      expect(savePrivacy).not.toHaveBeenCalled();
      expect(saveStatus).not.toHaveBeenCalled();
    });

    it('does not clear for somebody else either, so a moderator cannot take an owner’s setting back', async () => {
      const { deps, saveName, saveLimit, savePrivacy, saveStatus } = harness();
      await rememberSetting(deps, room('alice'), 'mod', { field: 'name', value: null });
      await rememberSetting(deps, room('alice'), 'mod', { field: 'limit', value: null });
      await rememberSetting(deps, room('alice'), 'mod', { field: 'privacy', value: null });
      await rememberSetting(deps, room('alice'), 'mod', { field: 'status', value: null });
      expect(saveName).not.toHaveBeenCalled();
      expect(saveLimit).not.toHaveBeenCalled();
      expect(savePrivacy).not.toHaveBeenCalled();
      expect(saveStatus).not.toHaveBeenCalled();
    });
  });

  /**
   * The lever stops what is STORED and never what is taken back out: a member resetting their
   * name must always get it back, and a refused clear leaves a value waiting to return.
   */
  describe('while member_prefs.disabled is on', () => {
    it('stores nothing, for any setting', async () => {
      const { deps, saveName, saveLimit, savePrivacy, saveStatus } = harness({
        memberPrefsDisabled: () => Promise.resolve(true),
      });
      for (const setting of [NAME, LIMIT, PRIVACY, STATUS]) {
        await rememberSetting(deps, room(), 'alice', setting);
      }
      await rememberSetting(deps, room(), 'alice', { field: 'status', value: '' });
      expect(saveName).not.toHaveBeenCalled();
      expect(saveLimit).not.toHaveBeenCalled();
      expect(savePrivacy).not.toHaveBeenCalled();
      expect(saveStatus).not.toHaveBeenCalled();
    });

    it('stores a limit of 0 no more than any other value', async () => {
      const { deps, saveLimit } = harness({ memberPrefsDisabled: () => Promise.resolve(true) });
      await rememberSetting(deps, room(), 'alice', { field: 'limit', value: 0 });
      expect(saveLimit).not.toHaveBeenCalled();
    });

    it('still clears, for every setting, and does not even ask the lever', async () => {
      const asked = vi.fn(() => Promise.resolve(true));
      const { deps, saveName, saveLimit, savePrivacy, saveStatus } = harness({
        memberPrefsDisabled: asked,
      });
      await rememberSetting(deps, room(), 'alice', { field: 'name', value: null });
      await rememberSetting(deps, room(), 'alice', { field: 'limit', value: null });
      await rememberSetting(deps, room(), 'alice', { field: 'privacy', value: null });
      await rememberSetting(deps, room(), 'alice', { field: 'status', value: null });
      expect(saveName).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', null);
      expect(saveLimit).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', null);
      expect(savePrivacy).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', null);
      expect(saveStatus).toHaveBeenCalledWith(GUILD, PRIMARY, 'alice', null);
      expect(asked).not.toHaveBeenCalled();
    });

    it('saves again once it is lifted', async () => {
      let on = true;
      const { deps, saveName } = harness({ memberPrefsDisabled: () => Promise.resolve(on) });
      await rememberSetting(deps, room(), 'alice', NAME);
      on = false;
      await rememberSetting(deps, room(), 'alice', NAME);
      expect(saveName).toHaveBeenCalledTimes(1);
    });

    /** The real accessor fails open itself, and an injected one that throws must not do worse. */
    it('fails open: an accessor that rejects or throws saves as if it were off', async () => {
      for (const memberPrefsDisabled of [
        () => Promise.reject(new Error('flags down')),
        () => {
          throw new Error('flags down');
        },
      ]) {
        const { deps, saveName, warn } = harness({ memberPrefsDisabled });
        await rememberSetting(deps, room(), 'alice', NAME);
        expect(saveName).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
      }
    });
  });

  /** A save follows a command that already worked, so nothing here may undo that. */
  describe('when it cannot save', () => {
    it('resolves, and logs only ids and what failed, when the repository throws', async () => {
      const { deps, saveName, warn } = harness();
      saveName.mockRejectedValue(
        Object.assign(new Error('connection terminated'), {
          code: '57P01',
          // What a database can echo back of a failing statement: the name the member typed.
          detail: 'Failing row contains (a secret den name)',
          params: ['a secret den name'],
        }),
      );

      await expect(
        rememberSetting(deps, room(), 'alice', { field: 'name', value: 'a secret den name' }),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledTimes(1);
      const [fields, message] = warn.mock.calls[0]!;
      expect(message).toBe('could not remember a room setting');
      expect(fields).toEqual({
        guildId: GUILD,
        channelId: ROOM,
        userId: 'alice',
        field: 'name',
        errorName: 'Error',
        errorCode: '57P01',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    });

    /**
     * A driver's own message can be the statement with its parameters, which for a name save
     * is the name the member typed. So the message is not logged, whatever it says.
     */
    it('never logs the error message, which can carry what the member typed', async () => {
      const { deps, saveName, warn } = harness();
      saveName.mockRejectedValue(
        new Error('Failed query: insert into member_room_prefs params: a secret den name'),
      );

      await rememberSetting(deps, room(), 'alice', { field: 'name', value: 'a secret den name' });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ field: 'name', errorName: 'Error' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Failed query');
    });

    it('logs a status that could not be saved by field and ids, and never what was typed', async () => {
      const { deps, saveStatus, info, warn } = harness();
      saveStatus.mockRejectedValueOnce(new Error('insert params: a secret status'));
      await rememberSetting(deps, room(), 'alice', { field: 'status', value: 'a secret status' });
      saveStatus.mockResolvedValueOnce({ status: 'tooLong', max: 1000 });
      await rememberSetting(deps, room(), 'alice', { field: 'status', value: 'a secret status' });

      expect(warn.mock.calls[0]![0]).toMatchObject({ field: 'status', errorName: 'Error' });
      expect(info.mock.calls[0]![0]).toEqual({
        guildId: GUILD,
        channelId: ROOM,
        userId: 'alice',
        field: 'status',
        status: 'tooLong',
      });
      expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain('secret');
    });

    it('resolves for a thrown value that is not an Error', async () => {
      const { deps, savePrivacy, warn } = harness();
      savePrivacy.mockRejectedValue('nope');
      await expect(rememberSetting(deps, room(), 'alice', PRIVACY)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ field: 'privacy', errorName: 'string' });
    });

    it('logs a value the repository refused, with ids, and never the value', async () => {
      const { deps, saveName, info, warn } = harness();
      saveName.mockResolvedValue({ status: 'tooLong', max: 1000 });
      await rememberSetting(deps, room(), 'alice', { field: 'name', value: 'x'.repeat(2000) });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0]![0]).toEqual({
        guildId: GUILD,
        channelId: ROOM,
        userId: 'alice',
        field: 'name',
        status: 'tooLong',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('says nothing for the two answers that are not a fault', async () => {
      const { deps, saveLimit, savePrivacy, info, warn } = harness();
      saveLimit.mockResolvedValue({ status: 'notOptedIn' });
      savePrivacy.mockResolvedValue({ status: 'cleared' });
      await rememberSetting(deps, room(), 'alice', LIMIT);
      await rememberSetting(deps, room(), 'alice', { field: 'privacy', value: null });
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('does nothing at all without a repository, or without the method it needs', async () => {
      const { deps, warn } = harness({ memberPrefs: undefined });
      await expect(rememberSetting(deps, room(), 'alice', NAME)).resolves.toBeUndefined();
      const partial = harness({ memberPrefs: { savePrivacy: vi.fn() } });
      await expect(rememberSetting(partial.deps, room(), 'alice', NAME)).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      expect(partial.warn).not.toHaveBeenCalled();
    });
  });
});

describe('isTruncatedPrefill', () => {
  const LONG = `${'a'.repeat(60)} ${'b'.repeat(60)} tail`;

  it('is true for the cut the panel box shows of a longer template, and only that', () => {
    expect(LONG.length).toBeGreaterThan(PANEL_NAME_MAX);
    expect(isTruncatedPrefill(LONG.slice(0, PANEL_NAME_MAX), LONG)).toBe(true);
  });

  it('is false once the member changes anything, or writes the whole template again', () => {
    expect(isTruncatedPrefill(`${LONG.slice(0, PANEL_NAME_MAX)}!`, LONG)).toBe(false);
    expect(isTruncatedPrefill(LONG.slice(0, PANEL_NAME_MAX - 1), LONG)).toBe(false);
    expect(isTruncatedPrefill(LONG, LONG)).toBe(false);
    expect(isTruncatedPrefill('Something else', LONG)).toBe(false);
  });

  /** The box's value is trimmed on arrival, so a cut that ends in a space is compared trimmed. */
  it('compares the cut as the room would store it, trimmed', () => {
    const spaced = `${'a'.repeat(PANEL_NAME_MAX - 1)} ${'b'.repeat(40)}`;
    expect(spaced[PANEL_NAME_MAX - 1]).toBe(' ');
    expect(isTruncatedPrefill('a'.repeat(PANEL_NAME_MAX - 1), spaced)).toBe(true);
  });

  /** Nothing was cut, so there is nothing the submit could have been the cut of. */
  it('is false when the room has no template, or one the box shows whole', () => {
    expect(isTruncatedPrefill('Den', undefined)).toBe(false);
    expect(isTruncatedPrefill('Den', 'Den')).toBe(false);
    expect(isTruncatedPrefill('a'.repeat(PANEL_NAME_MAX), 'a'.repeat(PANEL_NAME_MAX))).toBe(false);
    expect(isTruncatedPrefill('Den', 42)).toBe(false);
  });

  /** One number in two files: if the box's cap moves, the guard has to move with it. */
  it('is the cap the panel Name box itself has', () => {
    const modal = buildRenameModal('room-1', 'x').toJSON();
    const row = modal.components[0] as unknown as { components: { max_length?: number }[] };
    expect(row.components[0]!.max_length).toBe(PANEL_NAME_MAX);
  });
});

/**
 * The status has no truncation guard because the one box a member sets it in, the `/name`
 * editor's, takes exactly as much as a save keeps. If the box grew past the cap, a status typed
 * there would be refused as too long and silently not remembered, so the two are bound here.
 */
describe('the remembered status cap', () => {
  it('is what the /name editor status box accepts', () => {
    const state: EditorState = {
      found: true,
      scope: 'channel',
      name: { effectiveTemplate: 'Room', preview: 'Room' },
      status: { currentTemplate: 'AFK', effectiveTemplate: 'AFK', preview: 'AFK' },
      ownerId: 'alice',
    };
    const modal = buildEditorModal('channel', 'status', 'room-1', state).toJSON();
    const row = modal.components[0] as unknown as { components: { max_length?: number }[] };
    expect(row.components[0]!.max_length).toBe(MAX_MEMBER_PREF_STATUS_LENGTH);
  });
});
