import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '@avc/core';
import { buildCommandDefinitions } from '../../commands/definitions.js';
import {
  accessFeatureFor,
  AVAILABLE_FEATURES,
  claimFeatureFor,
  COMMAND_FEATURE,
  COMMAND_FEATURES,
  FEATURE_COVERS,
  FEATURE_LABELS,
  featureForCommand,
  isAvailableFeature,
  isNickReset,
  limitFeatureFor,
  MAX_RESTRICTED_ROLES,
  MAX_RESTRICTED_USERS,
  MAX_RESTRICTIONS,
  mayUse,
  nickFeatureFor,
  OCCUPANT_LEVEL_ACTIONS,
  PANEL_ACTION_FEATURE,
  readCommandAccess,
  readFeatureRules,
  RESTRICT_ENFORCED,
  savedListsInert,
  type CommandAccess,
  type CommandCaller,
} from './commandAccess.js';
import { SETTINGS_KEYS } from './guildSettings.js';

const GUILD = '460459401086763010';
const USER = '111111111111111111';
const OTHER = '222222222222222222';
const ROLE = '333333333333333333';
const OTHER_ROLE = '444444444444444444';
/** A role id the server no longer has: nothing a caller holds can match it. */
const DELETED_ROLE = '555555555555555555';

const settingsOf = (command_access: unknown): Record<string, unknown> => ({ command_access });

const caller = (over: Partial<CommandCaller> = {}): CommandCaller => ({
  userId: USER,
  roleIds: [],
  canManage: false,
  ...over,
});

/** A deny list of these users and roles, as the reader returns it. */
const deny = (users: string[], roles: string[] = []) => ({ deny: { users, roles } });
/** An allow list of these users and roles, as the reader returns it. */
const allow = (users: string[], roles: string[] = []) => ({ allow: { users, roles } });

describe('the feature list', () => {
  it('names the nine features, in the order the ids are reserved', () => {
    expect([...COMMAND_FEATURES]).toEqual([
      'privacy',
      'hide',
      'limit',
      'rename',
      'transfer',
      'access',
      'nick',
      'kick',
      'claim',
    ]);
  });

  /** Every feature has its command now, and the order is the order the ids are reserved in. */
  it('offers only the features whose commands exist', () => {
    expect([...AVAILABLE_FEATURES]).toEqual([...COMMAND_FEATURES]);
    for (const feature of AVAILABLE_FEATURES) expect(COMMAND_FEATURES).toContain(feature);
  });

  it('recognises an available feature and nothing else, since the id is client input', () => {
    expect(isAvailableFeature('rename')).toBe(true);
    expect(isAvailableFeature('hide')).toBe(true);
    expect(isAvailableFeature('access')).toBe(true);
    expect(isAvailableFeature('kick')).toBe(true);
    expect(isAvailableFeature('claim')).toBe(true);
    expect(isAvailableFeature('info')).toBe(false);
    expect(isAvailableFeature('reclaim')).toBe(false);
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
      kick: 'Kick',
      claim: 'Claim',
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
    // `/unlimit` and `/limit 0` both remove a limit, which is the undo direction,
    // so both are named as the open ones. Not "a limit of 0 by any door": the Size
    // button is refused before its box can open, so only the command is reachable.
    expect(FEATURE_COVERS.limit).toContain(
      'The /unlimit command and /limit 0 stay open to everyone',
    );
    expect(FEATURE_COVERS.limit).not.toMatch(/any door|Size box/);
  });

  /**
   * The guard refuses the knock card's Always allow on this rule, so an admin who is
   * told only about the commands would call the button open a bug. Block on the card is
   * not a door of this feature, and the three undo directions stay open.
   */
  it('says Saved lists covers the join request button, and that removing, clearing and listing stay open', () => {
    expect(FEATURE_COVERS.access).toContain('/access trust, block and admit commands');
    expect(FEATURE_COVERS.access).toContain('Always allow button on a join request');
    expect(FEATURE_COVERS.access).toContain('Removing, clearing and listing stay open to everyone');
  });

  /**
   * A rule on Saved lists is more than the commands: it makes what the member already saved
   * apply to nothing (see `savedListsInert`), and the sweep takes their entries off their
   * live rooms, so a person they blocked can join again. An admin told only about the commands
   * would not expect that, and it is the part that changes who is let into the rooms.
   */
  it('says Saved lists also stops what the member has already saved from applying, and what that lets in', () => {
    expect(FEATURE_COVERS.access).toContain(
      'A member it stops keeps the lists they already saved, but those lists stop applying to their rooms',
    );
    expect(FEATURE_COVERS.access).toContain('within a few minutes their entries come off');
    expect(FEATURE_COVERS.access).toContain('anyone they blocked can join again');
  });

  /**
   * A feature is more than one door, and the reply has to say which. A saved
   * nickname is the second door of Nickname: it stops showing in room names, and
   * for a role rule that lands at the next re-render, which an admin cannot see.
   */
  it('says a restricted nickname stops showing in room names, and that removing one stays open', () => {
    expect(FEATURE_COVERS.nick).toContain('/nick command');
    expect(FEATURE_COVERS.nick).toContain('saved nickname showing in a room name');
    expect(FEATURE_COVERS.nick).toContain('Removing a nickname stays open to everyone');
    expect(FEATURE_COVERS.nick).toContain('next time the room refreshes its name');
  });

  /**
   * Kick and Claim are pressed by anyone in a room, so the panel keeps their buttons
   * and refuses the click. An admin who restricts one and still sees the button would
   * call it a bug unless the reply says so, and the ways that stay open are named.
   */
  it('says Kick and Claim keep their buttons and refuse the click, and what stays open', () => {
    expect(FEATURE_COVERS.kick).toContain('/kick command and the Kick button');
    expect(FEATURE_COVERS.kick).toContain('stays on the room panel');
    expect(FEATURE_COVERS.kick).toContain('Voting on a kick that is already running stays open');
    expect(FEATURE_COVERS.claim).toContain('Claim button and the /reclaim command');
    expect(FEATURE_COVERS.claim).toContain("take over somebody else's room");
    expect(FEATURE_COVERS.claim).toContain('stays on the room panel');
    expect(FEATURE_COVERS.claim).toContain(
      'A member taking back a room of their own is never stopped',
    );
  });

  /**
   * Offering a feature that no command or panel action maps to would let an admin
   * restrict nothing and be told they had. The ids are pinned above, and this is
   * what makes a new one fail here and not in a customer's server.
   */
  it('offers only a feature a command maps to, and a panel action too where there is a button', () => {
    // Nickname and Saved lists are commands with no panel button, so they have no action.
    const noPanelButton: readonly string[] = ['nick', 'access'];
    for (const feature of AVAILABLE_FEATURES) {
      // Claim is decided from the room, not the command name: see `claimFeatureFor`.
      if (feature === 'claim') {
        expect(claimFeatureFor(false)).toBe('claim');
        continue;
      }
      expect(Object.values(COMMAND_FEATURE), feature).toContain(feature);
      if (noPanelButton.includes(feature)) continue;
      expect(Object.values(PANEL_ACTION_FEATURE), feature).toContain(feature);
    }
  });
});

/**
 * `/restrict` tells an admin a member "can no longer use" something, so it is
 * registered only by a build whose guard stands behind that.
 */
describe('registering /restrict', () => {
  const names = (options?: { includeRestrict?: boolean }): string[] =>
    buildCommandDefinitions(options).map((d) => d.name);

  it('follows RESTRICT_ENFORCED by default', () => {
    expect(names().includes('restrict')).toBe(RESTRICT_ENFORCED);
  });

  /** The guard reads the map on every path now, so the command is on by default. */
  it('is registered by default now that the guard reads the restrictions', () => {
    expect(RESTRICT_ENFORCED).toBe(true);
    expect(names()).toContain('restrict');
  });

  it('can be asked for explicitly either way', () => {
    expect(names({ includeRestrict: true })).toContain('restrict');
    expect(names({ includeRestrict: false })).not.toContain('restrict');
  });

  it('leaves every other command alone', () => {
    const without = names({ includeRestrict: false });
    expect(names({ includeRestrict: true }).filter((n) => n !== 'restrict')).toEqual(without);
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

  it('are 50 users and 25 roles per list of a feature and 150 in all', () => {
    expect([MAX_RESTRICTED_USERS, MAX_RESTRICTED_ROLES, MAX_RESTRICTIONS]).toEqual([50, 25, 150]);
  });
});

describe('the settings key', () => {
  it('is command_access', () => {
    expect(SETTINGS_KEYS.commandAccess).toBe('command_access');
  });
});

describe('which commands a rule can stop', () => {
  it('maps the eight commands that have a feature of their own', () => {
    expect(featureForCommand('private')).toBe('privacy');
    expect(featureForCommand('hide')).toBe('hide');
    expect(featureForCommand('limit')).toBe('limit');
    expect(featureForCommand('name')).toBe('rename');
    expect(featureForCommand('transfer')).toBe('transfer');
    expect(featureForCommand('access')).toBe('access');
    expect(featureForCommand('nick')).toBe('nick');
    expect(featureForCommand('kick')).toBe('kick');
  });

  /**
   * A rule stops three of `/access`'s six subcommands, so the command name is not enough
   * and the guard asks with the subcommand. `remove`, `clear` and `list` are how a member
   * erases or checks what they saved, so they are never restricted.
   */
  describe('accessFeatureFor', () => {
    it('stops trust, block and admit', () => {
      for (const sub of ['trust', 'block', 'admit']) {
        expect(accessFeatureFor(sub), sub).toBe('access');
      }
    });

    it('never stops remove, clear or list, or a subcommand it does not know', () => {
      for (const sub of ['remove', 'clear', 'list', 'purge', '', 'constructor', 'TRUST']) {
        expect(accessFeatureFor(sub), sub).toBeNull();
      }
      expect(accessFeatureFor(null)).toBeNull();
    });
  });

  /**
   * `/reclaim` and the Claim button take over a room, which is Claim, except for the
   * room's original creator taking their own room back, which is never restricted.
   */
  describe('claimFeatureFor', () => {
    it('is Claim for anyone but the original creator, and nothing for them', () => {
      expect(claimFeatureFor(false)).toBe('claim');
      expect(claimFeatureFor(true)).toBeNull();
      expect(mayUse(claimFeatureFor(true), caller(), { claim: deny([USER]) })).toBe(true);
      expect(mayUse(claimFeatureFor(false), caller(), { claim: deny([USER]) })).toBe(false);
    });

    it('leaves /reclaim to it rather than to the command name', () => {
      expect(featureForCommand('reclaim')).toBeNull();
    });
  });

  /** An owner whose creator channel starts rooms private must always be able to open one. */
  it('never maps an undo direction or an admin command', () => {
    for (const name of [
      'public',
      'unhide',
      'unlimit',
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

/**
 * A limit of 0 is "no limit", which is `/unlimit` by another name, so it is the
 * undo direction wherever it comes in: `/limit 0`, and the panel's Size box
 * submitted blank or as 0.
 */
describe('limitFeatureFor', () => {
  it('never restricts a limit of 0', () => {
    expect(limitFeatureFor(0)).toBeNull();
    expect(mayUse(limitFeatureFor(0), caller(), { limit: deny([USER]) })).toBe(true);
    expect(mayUse(limitFeatureFor(0), caller(), { limit: allow([OTHER]) })).toBe(true);
  });

  it('restricts any other count, including one that is not a number or is missing', () => {
    for (const count of [1, 5, 99, -1, Number.NaN, null]) {
      expect(limitFeatureFor(count), String(count)).toBe('limit');
    }
    expect(mayUse(limitFeatureFor(5), caller(), { limit: deny([USER]) })).toBe(false);
  });
});

/**
 * Removing a saved nickname is the undo direction. A rule naming a ROLE, or an allow
 * list that leaves a member out, cannot clear their nickname (the writer cannot list
 * them), so without this a member under one would hold saved text they cannot erase.
 */
describe('nickFeatureFor', () => {
  it('never restricts a value that removes the nickname', () => {
    for (const name of ['reset', 'RESET', ' Reset ', '', '   ', '\t']) {
      expect(isNickReset(name), JSON.stringify(name)).toBe(true);
      expect(nickFeatureFor(name), JSON.stringify(name)).toBeNull();
    }
    expect(mayUse(nickFeatureFor('reset'), caller(), { nick: deny([USER]) })).toBe(true);
    expect(mayUse(nickFeatureFor('reset'), caller(), { nick: allow([OTHER]) })).toBe(true);
  });

  it('restricts any other value, and a missing one, which only a hand-built request sends', () => {
    for (const name of ['Big Bob', 'resets', 'reset me', '0']) {
      expect(isNickReset(name), name).toBe(false);
      expect(nickFeatureFor(name), name).toBe('nick');
    }
    expect(nickFeatureFor(null)).toBe('nick');
    expect(mayUse(nickFeatureFor('Big Bob'), caller(), { nick: deny([USER]) })).toBe(false);
  });
});

describe('which panel actions a rule can stop', () => {
  it('stops the lock, never the unlock', () => {
    expect(PANEL_ACTION_FEATURE.lock).toBe('privacy');
    expect(PANEL_ACTION_FEATURE.unlock).toBeNull();
  });

  /** The same shape as privacy: the entry direction is gated and the undo is never. */
  it('stops the hide, never the unhide', () => {
    expect(PANEL_ACTION_FEATURE.hide).toBe('hide');
    expect(PANEL_ACTION_FEATURE.unhide).toBeNull();
  });

  /** A rule has to stop every step of an act, or the second step is the way round it. */
  it('stops both steps of Size, Name, Transfer and Kick', () => {
    expect(PANEL_ACTION_FEATURE.limit).toBe('limit');
    expect(PANEL_ACTION_FEATURE.limitset).toBe('limit');
    expect(PANEL_ACTION_FEATURE.rename).toBe('rename');
    expect(PANEL_ACTION_FEATURE.renameset).toBe('rename');
    expect(PANEL_ACTION_FEATURE.transfer).toBe('transfer');
    expect(PANEL_ACTION_FEATURE.transferpick).toBe('transfer');
    expect(PANEL_ACTION_FEATURE.kick).toBe('kick');
    expect(PANEL_ACTION_FEATURE.kickpick).toBe('kick');
  });

  /**
   * Info only reads. Claim is decided where the room's row is read, because its
   * original creator is never restricted, so the router's guard passes it.
   */
  it('leaves Info and Claim to no feature here', () => {
    expect(PANEL_ACTION_FEATURE.info).toBeNull();
    expect(PANEL_ACTION_FEATURE.claim).toBeNull();
  });

  /**
   * The panel follows the owner, and these are pressed by whoever is in the room, so
   * the owner's standing says nothing about them. They are never hidden on it.
   */
  it('names Claim, Kick, its picker and Info as occupant-level, and nothing the owner alone presses', () => {
    expect([...OCCUPANT_LEVEL_ACTIONS].sort()).toEqual(['claim', 'info', 'kick', 'kickpick']);
  });

  it('makes a decision for exactly the actions the panel has', () => {
    expect(Object.keys(PANEL_ACTION_FEATURE).sort()).toEqual(
      [
        'claim',
        'hide',
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
        'unhide',
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
    expect(PANEL_ACTION_FEATURE.kick).toBe(featureForCommand('kick'));
  });
});

describe('readCommandAccess', () => {
  it('reads no rules from a blob with no key', () => {
    expect(readCommandAccess({}, GUILD)).toEqual({});
    expect(readCommandAccess({ command_access: undefined }, GUILD)).toEqual({});
  });

  it('reads the allow and deny lists of each feature', () => {
    expect(
      readCommandAccess(
        settingsOf({
          rename: { allow: { roles: [ROLE] }, deny: { users: [USER] } },
          nick: { deny: { users: [OTHER] } },
          kick: { allow: { users: [USER], roles: [OTHER_ROLE] } },
        }),
        GUILD,
      ),
    ).toEqual({
      rename: { allow: { users: [], roles: [ROLE] }, deny: { users: [USER], roles: [] } },
      nick: { deny: { users: [OTHER], roles: [] } },
      kick: { allow: { users: [USER], roles: [OTHER_ROLE] } },
    });
  });

  it('keeps the order stored and removes a repeat', () => {
    const read = readCommandAccess(
      settingsOf({ rename: { deny: { users: [OTHER, USER, OTHER, USER] } } }),
      GUILD,
    );
    expect(read.rename?.deny?.users).toEqual([OTHER, USER]);
  });

  /** A newer build wrote a feature this one has never heard of. */
  it('ignores a feature id it does not know, and keeps the ones it does', () => {
    const read = readCommandAccess(
      settingsOf({
        somethingnew: { deny: { users: [USER] } },
        info: { deny: { users: [USER] } },
        rename: { deny: { users: [OTHER] } },
      }),
      GUILD,
    );
    expect(Object.keys(read)).toEqual(['rename']);
  });

  /** Only `allow` and `deny` are lists: anything else an entry holds is somebody else's field. */
  it('reads nothing from an entry with no allow or deny list, whatever else it holds', () => {
    expect(
      readCommandAccess(settingsOf({ rename: { users: [USER], roles: [ROLE] } }), GUILD),
    ).toEqual({});
    const read = readCommandAccess(
      settingsOf({ rename: { deny: { users: [USER] }, until: 1800000000 } }),
      GUILD,
    );
    expect(read).toEqual({ rename: { deny: { users: [USER], roles: [] } } });
  });

  it('ignores an id that is not a snowflake, whatever else it is', () => {
    const read = readCommandAccess(
      settingsOf({
        rename: {
          deny: {
            users: [USER, 'not-an-id', 42, null, {}, '12', `${USER}\n`, `${USER}1234567`],
          },
        },
      }),
      GUILD,
    );
    expect(read.rename?.deny?.users).toEqual([USER]);
  });

  /** A malformed value costs that entry or that list, not every rule the guild has. */
  it('skips a malformed entry or list and keeps the rest of the map', () => {
    const read = readCommandAccess(
      settingsOf({
        privacy: 'nope',
        limit: ['nope'],
        rename: null,
        transfer: 7,
        nick: { deny: { users: 'nope', roles: { [ROLE]: true } } },
        hide: { allow: 'nope', deny: { users: [OTHER] } },
        access: { deny: { users: [USER] } },
      }),
      GUILD,
    );
    expect(read).toEqual({
      hide: { deny: { users: [OTHER], roles: [] } },
      access: { deny: { users: [USER], roles: [] } },
    });
  });

  /**
   * An allow list this build cannot read is no allow list, which opens the feature:
   * the same fail-open as everything else it cannot read.
   */
  it('reads an allow list it cannot read as no allow list', () => {
    const read = readCommandAccess(
      settingsOf({ rename: { allow: { users: 'nope' } }, limit: { allow: ['nope'] } }),
      GUILD,
    );
    expect(read).toEqual({});
    expect(mayUse('rename', caller(), read)).toBe(true);
  });

  it('reads nothing from a value that is not a map at all', () => {
    for (const value of ['rename', 7, true, ['rename'], null]) {
      expect(readCommandAccess(settingsOf(value), GUILD), String(value)).toEqual({});
    }
  });

  /** A list with nothing in it is absent, so it never shows as a rule, and an entry with none is too. */
  it('treats a list with no users and no roles as absent, and an entry with no list as absent', () => {
    expect(
      readCommandAccess(
        settingsOf({
          rename: {},
          nick: { allow: { users: [], roles: [] }, deny: {} },
          limit: { allow: {}, deny: { users: [USER] } },
        }),
        GUILD,
      ),
    ).toEqual({ limit: { deny: { users: [USER], roles: [] } } });
  });

  it('does not read a feature off the prototype', () => {
    const inherited = Object.create({ rename: { deny: { users: [USER] } } });
    expect(readCommandAccess({ command_access: inherited }, GUILD)).toEqual({});
  });

  /**
   * `SettingsCache` serves one row object to every caller, so a reader that
   * handed back anything stored by reference would let one caller's mutation
   * corrupt every other read on the instance with no write behind it.
   */
  it('returns fresh objects every call, never the stored ones', () => {
    const stored = {
      rename: {
        allow: { users: [OTHER], roles: [OTHER_ROLE] },
        deny: { users: [USER], roles: [ROLE] },
      },
    };
    const settings = settingsOf(stored);
    const first = readCommandAccess(settings, GUILD);
    const second = readCommandAccess(settings, GUILD);

    expect(first).not.toBe(second);
    expect(first.rename).not.toBe(second.rename);
    expect(first.rename?.deny).not.toBe(second.rename?.deny);
    expect(first.rename?.allow).not.toBe(stored.rename.allow);
    expect(first.rename?.deny?.users).not.toBe(stored.rename.deny.users);
    expect(first.rename?.deny?.roles).not.toBe(stored.rename.deny.roles);
    expect(first.rename?.allow?.users).not.toBe(stored.rename.allow.users);

    first.rename!.deny!.users.push(OTHER);
    first.rename!.allow!.roles.length = 0;
    delete first.rename!.allow;
    delete first.rename;
    expect(stored).toEqual({
      rename: {
        allow: { users: [OTHER], roles: [OTHER_ROLE] },
        deny: { users: [USER], roles: [ROLE] },
      },
    });
    expect(readCommandAccess(settings, GUILD).rename).toEqual({
      allow: { users: [OTHER], roles: [OTHER_ROLE] },
      deny: { users: [USER], roles: [ROLE] },
    });
  });

  it('reads one entry the same way through readFeatureRules', () => {
    expect(readFeatureRules({ deny: { users: [USER] } }, GUILD)).toEqual({
      deny: { users: [USER], roles: [] },
    });
    expect(readFeatureRules({}, GUILD)).toBeUndefined();
    expect(readFeatureRules('nope', GUILD)).toBeUndefined();
  });
});

describe('mayUse', () => {
  describe('a deny list alone', () => {
    const access: CommandAccess = {
      rename: deny([USER], [ROLE]),
      nick: deny([], [OTHER_ROLE]),
    };

    it('lets everyone use a feature nobody is denied', () => {
      expect(mayUse('limit', caller(), access)).toBe(true);
      expect(mayUse('rename', caller(), {})).toBe(true);
      expect(mayUse('privacy', caller({ roleIds: [ROLE] }), access)).toBe(true);
    });

    it('refuses a denied user, and lets another user through the same rule', () => {
      expect(mayUse('rename', caller(), access)).toBe(false);
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

    /** A role that was deleted stops matching anybody, which is the fail-open direction. */
    it('lets everyone through a deny naming a role that was deleted', () => {
      const deleted: CommandAccess = { rename: deny([], [DELETED_ROLE]) };
      expect(mayUse('rename', caller({ roleIds: [ROLE] }), deleted)).toBe(true);
      expect(mayUse('rename', caller(), deleted)).toBe(true);
    });
  });

  describe('an allow list alone', () => {
    const access: CommandAccess = { rename: allow([OTHER], [ROLE]) };

    it('lets in a user it names by id', () => {
      expect(mayUse('rename', caller({ userId: OTHER }), access)).toBe(true);
    });

    it('lets in a user holding a role it names, among others', () => {
      expect(mayUse('rename', caller({ roleIds: ['9', ROLE] }), access)).toBe(true);
    });

    it('refuses everyone it does not name', () => {
      expect(mayUse('rename', caller(), access)).toBe(false);
      expect(mayUse('rename', caller({ roleIds: [OTHER_ROLE] }), access)).toBe(false);
    });

    it('says nothing about another feature', () => {
      expect(mayUse('limit', caller(), access)).toBe(true);
    });

    /**
     * A role that was deleted lets nobody in, which is the allow list's closed
     * direction: the feature is left to the rest of the list and to whoever can
     * manage channels, and `/restrict list` flags the role.
     */
    it('lets nobody in through a role that was deleted', () => {
      const deleted: CommandAccess = { rename: allow([], [DELETED_ROLE]) };
      expect(mayUse('rename', caller({ roleIds: [ROLE, OTHER_ROLE] }), deleted)).toBe(false);
      expect(mayUse('rename', caller({ canManage: true }), deleted)).toBe(true);
      const withOthers: CommandAccess = { rename: allow([OTHER], [DELETED_ROLE]) };
      expect(mayUse('rename', caller({ userId: OTHER }), withOthers)).toBe(true);
    });

    /** Roles nobody could resolve cannot let a caller in, only an id can. */
    it('lets in a caller whose roles are unknown only by their id', () => {
      expect(mayUse('rename', caller({ roleIds: [] }), access)).toBe(false);
      expect(mayUse('rename', caller({ userId: OTHER, roleIds: [] }), access)).toBe(true);
    });
  });

  describe('both lists', () => {
    const access: CommandAccess = {
      rename: { ...allow([OTHER], [ROLE]), ...deny([USER], [OTHER_ROLE]) },
    };

    it('lets in someone the allow list names and the deny list does not', () => {
      expect(mayUse('rename', caller({ userId: OTHER }), access)).toBe(true);
      expect(
        mayUse('rename', caller({ userId: '666666666666666666', roleIds: [ROLE] }), access),
      ).toBe(true);
    });

    it('refuses someone the deny list names even when the allow list names them too', () => {
      // By id on both.
      const both: CommandAccess = { rename: { ...allow([USER]), ...deny([USER]) } };
      expect(mayUse('rename', caller(), both)).toBe(false);
      // Allowed by role, denied by another role.
      expect(
        mayUse(
          'rename',
          caller({ userId: '666666666666666666', roleIds: [ROLE, OTHER_ROLE] }),
          access,
        ),
      ).toBe(false);
      // Allowed by id, denied by role.
      expect(mayUse('rename', caller({ userId: OTHER, roleIds: [OTHER_ROLE] }), access)).toBe(
        false,
      );
      // Allowed by role, denied by id.
      expect(mayUse('rename', caller({ roleIds: [ROLE] }), access)).toBe(false);
    });

    it('refuses someone neither list names, since the allow list leaves them out', () => {
      expect(mayUse('rename', caller({ userId: '666666666666666666' }), access)).toBe(false);
    });
  });

  /**
   * Manage Channels or Administrator can already rename any room, so a rule could
   * not stop them, and an admin must never be able to lock themselves out.
   */
  it('never restricts a caller who can manage channels, on either list, however they are named', () => {
    const manager = caller({ canManage: true, roleIds: [ROLE] });
    expect(mayUse('rename', manager, { rename: deny([USER], [ROLE]) })).toBe(true);
    expect(mayUse('rename', manager, { rename: allow([OTHER], [OTHER_ROLE]) })).toBe(true);
    expect(
      mayUse('rename', manager, { rename: { ...allow([OTHER]), ...deny([USER], [ROLE]) } }),
    ).toBe(true);
  });

  it('passes a feature of null, which no rule can stop', () => {
    const access: CommandAccess = { rename: deny([USER]), kick: allow([OTHER]) };
    expect(mayUse(null, caller(), access)).toBe(true);
    expect(mayUse(PANEL_ACTION_FEATURE.unlock, caller(), access)).toBe(true);
    expect(mayUse(PANEL_ACTION_FEATURE.info, caller(), access)).toBe(true);
  });

  /** The undo directions, end to end through both maps. */
  it('never refuses the way back, even when every feature is denied to the caller', () => {
    for (const rules of [deny([USER]), allow([OTHER])]) {
      const denied: CommandAccess = Object.fromEntries(COMMAND_FEATURES.map((f) => [f, rules]));
      expect(mayUse(featureForCommand('public'), caller(), denied)).toBe(true);
      expect(mayUse(featureForCommand('unlimit'), caller(), denied)).toBe(true);
      expect(mayUse(PANEL_ACTION_FEATURE.unlock, caller(), denied)).toBe(true);
      expect(mayUse(claimFeatureFor(true), caller(), denied)).toBe(true);
      // And the way in is refused, so the test is not passing for the wrong reason.
      expect(mayUse(featureForCommand('private'), caller(), denied)).toBe(false);
      expect(mayUse(PANEL_ACTION_FEATURE.lock, caller(), denied)).toBe(false);
      expect(mayUse(claimFeatureFor(false), caller(), denied)).toBe(false);
      expect(mayUse(featureForCommand('kick'), caller(), denied)).toBe(false);
    }
  });

  /**
   * `@everyone` is a role whose id is the guild id, and `GuildMember.roles.cache`
   * lists it for every member. The writer and the importer refuse to store it, and
   * the READER drops it from a deny list, so even a value put in the database by
   * hand cannot deny the whole server, whatever role list the caller passes.
   */
  it('does not deny a caller over a stored @everyone deny, even one that lists the guild id', () => {
    const read = readCommandAccess(settingsOf({ rename: { deny: { roles: [GUILD] } } }), GUILD);
    expect(read).toEqual({});
    expect(mayUse('rename', caller({ roleIds: [GUILD] }), read)).toBe(true);
    expect(mayUse('rename', caller({ roleIds: [GUILD, ROLE] }), read)).toBe(true);
  });

  it('keeps the real roles beside a stored @everyone deny', () => {
    const read = readCommandAccess(
      settingsOf({ rename: { deny: { roles: [GUILD, ROLE] } } }),
      GUILD,
    );
    expect(read).toEqual({ rename: deny([], [ROLE]) });
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: [GUILD, ROLE] }), read)).toBe(false);
    expect(mayUse('rename', caller({ userId: OTHER, roleIds: [GUILD] }), read)).toBe(true);
  });

  /**
   * On an allow list `@everyone` lets everyone in, which is no rule at all, so the
   * reader treats the whole allow list as absent, and the deny list beside it holds.
   */
  it('reads an allow list holding @everyone as no allow list, and keeps the deny list', () => {
    const read = readCommandAccess(
      settingsOf({
        rename: { allow: { users: [OTHER], roles: [GUILD, ROLE] }, deny: { users: [USER] } },
        limit: { allow: { roles: [GUILD] } },
      }),
      GUILD,
    );
    expect(read).toEqual({ rename: deny([USER]) });
    expect(mayUse('rename', caller({ userId: '666666666666666666' }), read)).toBe(true);
    expect(mayUse('rename', caller(), read)).toBe(false);
    expect(mayUse('limit', caller(), read)).toBe(true);
  });

  /** Another server's id is just an id here: only THIS guild's is `@everyone`. */
  it('drops only this guild id from the roles', () => {
    const read = readCommandAccess(
      settingsOf({
        rename: { deny: { roles: [OTHER_ROLE] } },
        limit: { allow: { roles: [OTHER_ROLE] } },
      }),
      GUILD,
    );
    expect(read.rename?.deny?.roles).toEqual([OTHER_ROLE]);
    expect(read.limit?.allow?.roles).toEqual([OTHER_ROLE]);
  });

  it('works on what the reader returns', () => {
    const read = readCommandAccess(
      settingsOf({
        rename: { deny: { users: [USER] } },
        limit: { deny: { roles: [ROLE] } },
        kick: { allow: { roles: [ROLE] } },
      }),
      GUILD,
    );
    expect(mayUse('rename', caller(), read)).toBe(false);
    expect(mayUse('limit', caller({ userId: OTHER, roleIds: [ROLE] }), read)).toBe(false);
    expect(mayUse('limit', caller({ userId: OTHER }), read)).toBe(true);
    expect(mayUse('transfer', caller(), read)).toBe(true);
    expect(mayUse('kick', caller({ roleIds: [ROLE] }), read)).toBe(true);
    expect(mayUse('kick', caller(), read)).toBe(false);
  });
});

/**
 * A restricted feature is inert for a denied member, saved data included. One predicate
 * answers it for every place a saved list is applied, and what it cannot tell fails open.
 */
describe('savedListsInert', () => {
  const access: CommandAccess = {
    access: deny([USER], [ROLE]),
    rename: deny([OTHER]),
  };

  it('is inert for a member the Saved lists deny list names, by id or by role', () => {
    expect(savedListsInert(access, caller())).toBe(true);
    expect(savedListsInert(access, caller({ userId: OTHER, roleIds: [ROLE] }))).toBe(true);
  });

  it('is inert for a member a Saved lists allow list leaves out, and not for one it names', () => {
    const kept: CommandAccess = { access: allow([OTHER], [ROLE]) };
    expect(savedListsInert(kept, caller())).toBe(true);
    expect(savedListsInert(kept, caller({ userId: OTHER }))).toBe(false);
    expect(savedListsInert(kept, caller({ roleIds: [ROLE] }))).toBe(false);
  });

  it('is not inert for anybody else, or when no rule names the feature', () => {
    expect(savedListsInert(access, caller({ userId: OTHER }))).toBe(false);
    expect(savedListsInert(access, caller({ userId: OTHER, roleIds: [OTHER_ROLE] }))).toBe(false);
    // A rule on another feature says nothing about this one.
    expect(savedListsInert({ rename: deny([USER]) }, caller())).toBe(false);
    expect(savedListsInert({}, caller())).toBe(false);
  });

  it('is not inert for a member who can manage channels, whom no rule can restrict', () => {
    expect(savedListsInert(access, caller({ canManage: true }))).toBe(false);
    expect(savedListsInert({ access: allow([OTHER]) }, caller({ canManage: true }))).toBe(false);
  });

  /** A saved block protects the people it names, so the direction we cannot see applies it. */
  it('is not inert when who they are could not be resolved, under either list', () => {
    expect(savedListsInert(access, undefined)).toBe(false);
    expect(savedListsInert({ access: allow([OTHER]) }, undefined)).toBe(false);
    expect(savedListsInert({}, undefined)).toBe(false);
  });
});
