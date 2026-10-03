import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '@avc/core';
import { buildCommandDefinitions } from '../../commands/definitions.js';
import {
  AVAILABLE_FEATURES,
  COMMAND_FEATURE,
  COMMAND_FEATURES,
  FEATURE_COVERS,
  FEATURE_LABELS,
  featureForCommand,
  isAvailableFeature,
  MAX_RESTRICTED_ROLES,
  MAX_RESTRICTED_USERS,
  MAX_RESTRICTIONS,
  mayUse,
  PANEL_ACTION_FEATURE,
  readCommandAccess,
  type CommandAccess,
  type CommandCaller,
} from './commandAccess.js';
import { SETTINGS_KEYS } from './guildSettings.js';

const GUILD = '460459401086763010';
const USER = '111111111111111111';
const OTHER = '222222222222222222';
const ROLE = '333333333333333333';
const OTHER_ROLE = '444444444444444444';

const settingsOf = (command_access: unknown): Record<string, unknown> => ({ command_access });

const caller = (over: Partial<CommandCaller> = {}): CommandCaller => ({
  userId: USER,
  roleIds: [],
  canManage: false,
  ...over,
});

describe('the feature list', () => {
  it('names the seven features, in the order the ids are reserved', () => {
    expect([...COMMAND_FEATURES]).toEqual([
      'privacy',
      'hide',
      'limit',
      'rename',
      'transfer',
      'access',
      'nick',
    ]);
  });

  /**
   * Hide and Saved lists do not exist yet. Offering them would let an admin
   * restrict nothing and be told they had.
   */
  it('offers only the features whose commands exist', () => {
    expect([...AVAILABLE_FEATURES]).toEqual(['privacy', 'limit', 'rename', 'transfer', 'nick']);
    for (const feature of AVAILABLE_FEATURES) expect(COMMAND_FEATURES).toContain(feature);
    expect(AVAILABLE_FEATURES).not.toContain('hide');
    expect(AVAILABLE_FEATURES).not.toContain('access');
  });

  it('recognises an available feature and nothing else, since the id is client input', () => {
    expect(isAvailableFeature('rename')).toBe(true);
    expect(isAvailableFeature('hide')).toBe(false);
    expect(isAvailableFeature('access')).toBe(false);
    expect(isAvailableFeature('claim')).toBe(false);
    expect(isAvailableFeature('constructor')).toBe(false);
    expect(isAvailableFeature(undefined)).toBe(false);
  });

  it('labels every feature with the words the panel uses', () => {
    expect(FEATURE_LABELS).toEqual({
      privacy: 'Private and Public',
      hide: 'Hide',
      limit: 'Size',
      rename: 'Name',
      transfer: 'Transfer',
      access: 'Saved lists',
      nick: 'Nickname',
    });
  });

  /** Rendered, not scanned: a source scan only ever catches a curly quote. */
  it('follows the copy rules in every label and every clause', () => {
    for (const text of [...Object.values(FEATURE_LABELS), ...Object.values(FEATURE_COVERS)]) {
      expect(text, 'no em or en dashes').not.toMatch(/[—–]/);
      expect(text, 'straight quotes only').not.toMatch(/[‘’“”]/);
      expect(text, 'no prose semicolons').not.toContain(';');
      expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
    }
  });

  it('says what each available feature covers, and that an undo direction stays open', () => {
    for (const feature of AVAILABLE_FEATURES)
      expect(FEATURE_COVERS[feature].length).toBeGreaterThan(0);
    expect(FEATURE_COVERS.rename).toContain('/name');
    expect(FEATURE_COVERS.rename).toContain('template editor');
    expect(FEATURE_COVERS.rename).toContain('voice status');
    expect(FEATURE_COVERS.privacy).toContain('stays open to everyone');
    expect(FEATURE_COVERS.limit).toContain('stays open to everyone');
  });
});

/**
 * The caps exist in two places because core cannot import the bot, and nothing
 * bound the older sets of caps to each other. This binds these three.
 */
describe('the caps', () => {
  it('are the same numbers in the bot and in the importer', () => {
    expect(MAX_RESTRICTED_USERS).toBe(IMPORT_LIMITS.commandAccessUsers);
    expect(MAX_RESTRICTED_ROLES).toBe(IMPORT_LIMITS.commandAccessRoles);
    expect(MAX_RESTRICTIONS).toBe(IMPORT_LIMITS.commandAccessTotal);
  });

  it('are 50 users and 25 roles per feature and 150 in all', () => {
    expect([MAX_RESTRICTED_USERS, MAX_RESTRICTED_ROLES, MAX_RESTRICTIONS]).toEqual([50, 25, 150]);
  });
});

describe('the settings key', () => {
  it('is command_access', () => {
    expect(SETTINGS_KEYS.commandAccess).toBe('command_access');
  });
});

describe('which commands a rule can stop', () => {
  it('maps the five commands that have an owner-level feature', () => {
    expect(featureForCommand('private')).toBe('privacy');
    expect(featureForCommand('limit')).toBe('limit');
    expect(featureForCommand('name')).toBe('rename');
    expect(featureForCommand('transfer')).toBe('transfer');
    expect(featureForCommand('nick')).toBe('nick');
  });

  /** An owner whose creator channel starts rooms private must always be able to open one. */
  it('never maps an undo direction, an occupant-level command or an admin command', () => {
    for (const name of [
      'public',
      'unlimit',
      'reclaim',
      'kick',
      'channelinfo',
      'ping',
      'invite',
      'source',
      'setup',
      'create',
      'template',
      'controlpanel',
      'import',
      'export',
      'restrict',
    ]) {
      expect(featureForCommand(name), name).toBeNull();
    }
  });

  /** The name is client input, and `constructor` is a property of every object. */
  it('answers null for a name on the prototype chain, not the prototype', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '']) {
      expect(featureForCommand(name), name).toBeNull();
    }
  });

  it('maps only commands that are registered, so a rename cannot silently un-restrict one', () => {
    const registered = new Set(buildCommandDefinitions().map((d) => d.name));
    for (const name of Object.keys(COMMAND_FEATURE)) expect(registered.has(name), name).toBe(true);
  });

  it('maps every command to a feature that exists', () => {
    for (const feature of Object.values(COMMAND_FEATURE)) {
      expect(COMMAND_FEATURES).toContain(feature);
    }
  });
});

describe('which panel actions a rule can stop', () => {
  it('stops the lock, never the unlock', () => {
    expect(PANEL_ACTION_FEATURE.lock).toBe('privacy');
    expect(PANEL_ACTION_FEATURE.unlock).toBeNull();
  });

  /** A rule has to stop every step of an act, or the second step is the way round it. */
  it('stops both steps of Size, Name and Transfer', () => {
    expect(PANEL_ACTION_FEATURE.limit).toBe('limit');
    expect(PANEL_ACTION_FEATURE.limitset).toBe('limit');
    expect(PANEL_ACTION_FEATURE.rename).toBe('rename');
    expect(PANEL_ACTION_FEATURE.renameset).toBe('rename');
    expect(PANEL_ACTION_FEATURE.transfer).toBe('transfer');
    expect(PANEL_ACTION_FEATURE.transferpick).toBe('transfer');
  });

  it('leaves the occupant-level actions alone', () => {
    for (const action of ['claim', 'kick', 'kickpick', 'info'] as const) {
      expect(PANEL_ACTION_FEATURE[action], action).toBeNull();
    }
  });

  it('makes a decision for exactly the actions the panel has', () => {
    expect(Object.keys(PANEL_ACTION_FEATURE).sort()).toEqual(
      [
        'claim',
        'info',
        'kick',
        'kickpick',
        'limit',
        'limitset',
        'lock',
        'rename',
        'renameset',
        'transfer',
        'transferpick',
        'unlock',
      ].sort(),
    );
  });

  /** A panel button and its command have to agree, or one is the way round the other. */
  it('agrees with the command map on the feature each shared act belongs to', () => {
    expect(PANEL_ACTION_FEATURE.lock).toBe(featureForCommand('private'));
    expect(PANEL_ACTION_FEATURE.limit).toBe(featureForCommand('limit'));
    expect(PANEL_ACTION_FEATURE.rename).toBe(featureForCommand('name'));
    expect(PANEL_ACTION_FEATURE.transfer).toBe(featureForCommand('transfer'));
  });
});

describe('readCommandAccess', () => {
  it('reads nobody denied from a blob with no key', () => {
    expect(readCommandAccess({})).toEqual({});
    expect(readCommandAccess({ command_access: undefined })).toEqual({});
  });

  it('reads the users and roles of each feature', () => {
    expect(
      readCommandAccess(
        settingsOf({ rename: { users: [USER], roles: [ROLE] }, nick: { users: [OTHER] } }),
      ),
    ).toEqual({
      rename: { users: [USER], roles: [ROLE] },
      nick: { users: [OTHER], roles: [] },
    });
  });

  it('keeps the order stored and removes a repeat', () => {
    const read = readCommandAccess(settingsOf({ rename: { users: [OTHER, USER, OTHER, USER] } }));
    expect(read.rename?.users).toEqual([OTHER, USER]);
  });

  /** A newer build wrote a feature this one has never heard of. */
  it('ignores a feature id it does not know, and keeps the ones it does', () => {
    const read = readCommandAccess(
      settingsOf({
        somethingnew: { users: [USER] },
        claim: { users: [USER] },
        rename: { users: [OTHER] },
      }),
    );
    expect(Object.keys(read)).toEqual(['rename']);
  });

  it('reads a feature reserved for a later command, which nothing enforces yet', () => {
    expect(readCommandAccess(settingsOf({ hide: { roles: [ROLE] } }))).toEqual({
      hide: { users: [], roles: [ROLE] },
    });
  });

  it('ignores an id that is not a snowflake, whatever else it is', () => {
    const read = readCommandAccess(
      settingsOf({
        rename: { users: [USER, 'not-an-id', 42, null, {}, '12', `${USER}\n`, `${USER}1234567`] },
      }),
    );
    expect(read.rename?.users).toEqual([USER]);
  });

  /** A malformed value costs that entry, not every restriction the guild has. */
  it('skips a malformed entry and keeps the rest of the map', () => {
    const read = readCommandAccess(
      settingsOf({
        privacy: 'nope',
        limit: ['nope'],
        rename: null,
        transfer: 7,
        nick: { users: 'nope', roles: { [ROLE]: true } },
        access: { users: [USER] },
      }),
    );
    expect(read).toEqual({ access: { users: [USER], roles: [] } });
  });

  it('reads nothing from a value that is not a map at all', () => {
    for (const value of ['rename', 7, true, ['rename'], null]) {
      expect(readCommandAccess(settingsOf(value)), String(value)).toEqual({});
    }
  });

  /** An entry with nothing in it is absent, so it never shows as a restriction. */
  it('treats an entry with no users and no roles as absent', () => {
    expect(readCommandAccess(settingsOf({ rename: {}, nick: { users: [], roles: [] } }))).toEqual(
      {},
    );
  });

  it('does not read a feature off the prototype', () => {
    const inherited = Object.create({ rename: { users: [USER] } });
    expect(readCommandAccess({ command_access: inherited })).toEqual({});
  });

  /**
   * `SettingsCache` serves one row object to every caller, so a reader that
   * handed back anything stored by reference would let one caller's mutation
   * corrupt every other read on the instance with no write behind it.
   */
  it('returns fresh objects every call, never the stored ones', () => {
    const stored = { rename: { users: [USER], roles: [ROLE] } };
    const settings = settingsOf(stored);
    const first = readCommandAccess(settings);
    const second = readCommandAccess(settings);

    expect(first).not.toBe(second);
    expect(first.rename).not.toBe(second.rename);
    expect(first.rename?.users).not.toBe(second.rename?.users);
    expect(first.rename?.users).not.toBe(stored.rename.users);
    expect(first.rename?.roles).not.toBe(stored.rename.roles);

    first.rename!.users.push(OTHER);
    first.rename!.roles.length = 0;
    delete first.rename;
    expect(stored).toEqual({ rename: { users: [USER], roles: [ROLE] } });
    expect(readCommandAccess(settings).rename).toEqual({ users: [USER], roles: [ROLE] });
  });
});

describe('mayUse', () => {
  const access: CommandAccess = {
    rename: { users: [USER], roles: [ROLE] },
    nick: { users: [], roles: [OTHER_ROLE] },
  };

  it('lets everyone use a feature nobody is denied', () => {
    expect(mayUse('limit', caller(), access)).toBe(true);
    expect(mayUse('rename', caller(), {})).toBe(true);
    expect(mayUse('privacy', caller({ roleIds: [ROLE] }), access)).toBe(true);
  });

  it('refuses a denied user', () => {
    expect(mayUse('rename', caller(), access)).toBe(false);
  });

  it('lets another user through the same rule', () => {
    expect(mayUse('rename', caller({ userId: OTHER }), access)).toBe(true);
  });

  it('refuses a denied role, and a user who has it among others', () => {
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: [ROLE] }), access)).toBe(false);
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: ['9', ROLE, '8'] }), access)).toBe(
      false,
    );
  });

  it('lets a user through whose roles are none of the denied ones', () => {
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: [OTHER_ROLE] }), access)).toBe(true);
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: [] }), access)).toBe(true);
  });

  it('keeps each feature to its own rule', () => {
    const roleOnly = caller({ userId: OTHER, roleIds: [OTHER_ROLE] });
    expect(mayUse('nick', roleOnly, access)).toBe(false);
    expect(mayUse('rename', roleOnly, access)).toBe(true);
  });

  /**
   * Manage Channels or Administrator can already rename any room, so a rule could
   * not stop them, and an admin must never be able to lock themselves out.
   */
  it('never restricts a caller who can manage channels, however they are named', () => {
    const manager = caller({ canManage: true, roleIds: [ROLE] });
    expect(mayUse('rename', manager, access)).toBe(true);
    expect(mayUse('nick', manager, access)).toBe(true);
  });

  it('passes a feature of null, which no rule can stop', () => {
    expect(mayUse(null, caller(), access)).toBe(true);
    expect(mayUse(PANEL_ACTION_FEATURE.unlock, caller(), access)).toBe(true);
    expect(mayUse(PANEL_ACTION_FEATURE.kick, caller(), access)).toBe(true);
  });

  /** The undo directions, end to end through both maps. */
  it('never refuses the way back, even when every feature is denied to the caller', () => {
    const denied: CommandAccess = Object.fromEntries(
      COMMAND_FEATURES.map((f) => [f, { users: [USER], roles: [] }]),
    );
    expect(mayUse(featureForCommand('public'), caller(), denied)).toBe(true);
    expect(mayUse(featureForCommand('unlimit'), caller(), denied)).toBe(true);
    expect(mayUse(PANEL_ACTION_FEATURE.unlock, caller(), denied)).toBe(true);
    // And the way in is refused, so the test is not passing for the wrong reason.
    expect(mayUse(featureForCommand('private'), caller(), denied)).toBe(false);
    expect(mayUse(PANEL_ACTION_FEATURE.lock, caller(), denied)).toBe(false);
  });

  /** A role that was deleted stops matching anybody, which is the fail-open direction. */
  it('lets a caller through a rule naming a role they cannot have', () => {
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: [] }), access)).toBe(true);
  });

  /**
   * `@everyone` is a role whose id is the guild id. The writer and the importer
   * refuse to store it, and a caller strips it from its role list, so a stored
   * one (a hand edit) matches nobody.
   */
  it('does not deny a caller over a stored @everyone rule, because a caller strips that role', () => {
    const everyone: CommandAccess = { rename: { users: [], roles: [GUILD] } };
    expect(mayUse('rename', caller({ roleIds: [] }), everyone)).toBe(true);
  });

  it('works on what the reader returns', () => {
    const read = readCommandAccess(
      settingsOf({ rename: { users: [USER] }, limit: { roles: [ROLE] } }),
    );
    expect(mayUse('rename', caller(), read)).toBe(false);
    expect(mayUse('limit', caller({ userId: OTHER, roleIds: [ROLE] }), read)).toBe(false);
    expect(mayUse('limit', caller({ userId: OTHER }), read)).toBe(true);
    expect(mayUse('transfer', caller(), read)).toBe(true);
  });
});
