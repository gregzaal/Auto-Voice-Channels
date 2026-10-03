import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_FEATURES } from '../features/voice/commandAccess.js';
import { buildCommandDefinitions } from './definitions.js';

describe('buildCommandDefinitions', () => {
  // `/restrict` is asked for explicitly, so its shape is tested whatever
  // `RESTRICT_ENFORCED` is. That it is registered by default is `commandAccess.unit.test.ts`.
  const defs = buildCommandDefinitions({ includeRestrict: true });
  const byName = new Map(defs.map((d) => [d.name, d]));

  it('exposes the full hybrid command surface', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'access',
        'alias',
        'alwayshidden',
        'alwaysprivate',
        'botprofile',
        'channelinfo',
        'controlpanel',
        'create',
        'defaultlimit',
        'export',
        'group',
        'hide',
        'import',
        'inheritpermissions',
        'invite',
        'kick',
        'limit',
        'logging',
        'name',
        'nick',
        'ping',
        'position',
        'private',
        'public',
        'reclaim',
        'restrict',
        'setup',
        'source',
        'template',
        'textchannels',
        'transfer',
        'unhide',
        'unlimit',
      ].sort(),
    );
    // The number the release notes and the docs state. A command added or dropped has to
    // change it here, where somebody is looking, and not only in the list above.
    expect(defs).toHaveLength(33);
  });

  /**
   * One permission tier above the configuration commands: `/import`
   * replaces another admin's work from a file, and `/export` discloses channel
   * ids, the recorded contact and every self-chosen nickname. `/docs/commands`
   * publishes "Manage Server" for both, so this is a published commitment.
   */
  it('gates export, import and botprofile behind ManageGuild, one tier higher', () => {
    const manageGuild = PermissionFlagsBits.ManageGuild.toString();
    for (const name of ['export', 'import', 'botprofile']) {
      expect(byName.get(name)!.default_member_permissions).toBe(manageGuild);
    }
  });

  it('takes the import file as a required attachment', () => {
    const option = byName.get('import')!.options?.[0];
    expect(option).toMatchObject({ name: 'file', required: true });
  });

  it('gates admin commands behind ManageChannels', () => {
    const manage = PermissionFlagsBits.ManageChannels.toString();
    for (const name of [
      'alias',
      'create',
      'template',
      'position',
      'alwaysprivate',
      'alwayshidden',
      'controlpanel',
      'group',
      'inheritpermissions',
      'logging',
      'restrict',
    ]) {
      expect(byName.get(name)!.default_member_permissions).toBe(manage);
    }
    // Per-channel + utility commands stay open (owner checks live in logic).
    for (const name of ['limit', 'hide', 'unhide', 'access', 'nick', 'ping', 'invite', 'source']) {
      expect(byName.get(name)!.default_member_permissions ?? null).toBeNull();
    }
  });

  /**
   * The assertion that keeps `/channelinfo` open to everyone.
   *
   * It looks admin-shaped, sits beside the admin commands in the source, and
   * takes a channel option, so the tempting edit is to wrap it in `adminOnly`
   * like its neighbours. That would silently remove the whole point: the person
   * asking why their room is called something is usually not an admin. The
   * option alone is gated, in `handleChannelInfo`, not here.
   */
  it('leaves /channelinfo open to every member', () => {
    expect(byName.get('channelinfo')!.default_member_permissions ?? null).toBeNull();
    expect(byName.get('channelinfo')!.options?.[0]).toMatchObject({
      name: 'channel',
      required: false,
    });
  });

  it('includes /debug only when requested', () => {
    expect(byName.has('debug')).toBe(false);
    const withDebug = buildCommandDefinitions({ includeDebug: true });
    const debug = withDebug.find((d) => d.name === 'debug');
    expect(debug).toBeDefined();
    expect(debug!.default_member_permissions).toBe(PermissionFlagsBits.ManageChannels.toString());
  });

  // A self-hoster with no model endpoint should never be shown a command that
  // could only apologise, so it is registered conditionally.
  it('includes /templateassistant only when a model endpoint is configured', () => {
    expect(byName.has('templateassistant')).toBe(false);
    const withAssistant = buildCommandDefinitions({ includeAssistant: true });
    const assistant = withAssistant.find((d) => d.name === 'templateassistant');
    expect(assistant).toBeDefined();
    // Admin-gated exactly like /template, and nothing else gates it.
    expect(assistant!.default_member_permissions).toBe(
      PermissionFlagsBits.ManageChannels.toString(),
    );
    expect(assistant!.options ?? []).toHaveLength(0);
  });

  it('marks commands as guild-only', () => {
    for (const def of defs) {
      expect(def.dm_permission).toBe(false);
    }
  });

  it('keeps the VC-dependent commands option-less (act on your current channel)', () => {
    for (const name of [
      'name',
      'private',
      'public',
      'hide',
      'unhide',
      'reclaim',
      'template',
      'position',
      'alwaysprivate',
      'alwayshidden',
      'controlpanel',
      'botprofile',
      'group',
      'logging',
    ]) {
      expect(byName.get(name)!.options ?? [], `${name} should have no options`).toHaveLength(0);
    }
    // inheritpermissions is now modal-driven too (no slash options).
    expect(byName.get('inheritpermissions')!.options ?? []).toHaveLength(0);
  });

  /**
   * The first command with subcommands, and the first with a mentionable option,
   * so the shape is pinned: `/restrict add` and `remove` take a required feature
   * and a required who, and `list` takes nothing.
   */
  describe('/restrict', () => {
    type Sub = { type: number; name: string; options?: Record<string, unknown>[] };
    const subs = (byName.get('restrict')!.options ?? []) as unknown as Sub[];
    const sub = (name: string): Sub => subs.find((s) => s.name === name)!;
    const SUBCOMMAND = 1;
    const STRING = 3;
    const MENTIONABLE = 9;

    it('has an add, a remove, a clear and a list subcommand, and nothing else', () => {
      expect(subs.map((s) => [s.name, s.type])).toEqual([
        ['add', SUBCOMMAND],
        ['remove', SUBCOMMAND],
        ['clear', SUBCOMMAND],
        ['list', SUBCOMMAND],
      ]);
    });

    /**
     * `clear` is the way out of a list full of members who left and roles that were
     * deleted, which the picker cannot offer to `remove`, so it must not ask who.
     */
    it('takes only a required feature on clear, the same one add takes', () => {
      expect(sub('clear').options, 'clear').toMatchObject([
        { name: 'feature', type: STRING, required: true },
      ]);
      expect(sub('clear').options).toEqual([sub('add').options![0]]);
    });

    it('takes a required feature and a required person or role on add and remove', () => {
      for (const name of ['add', 'remove']) {
        expect(sub(name).options, name).toMatchObject([
          { name: 'feature', type: STRING, required: true },
          { name: 'who', type: MENTIONABLE, required: true },
        ]);
      }
    });

    it('takes no options on list', () => {
      expect(sub('list').options ?? []).toHaveLength(0);
    });

    it('offers exactly the features that exist, labelled as the panel labels them', () => {
      const choices = (sub('add').options![0] as { choices: { name: string; value: string }[] })
        .choices;
      expect(choices).toEqual([
        { name: 'Private and Public', value: 'privacy' },
        { name: 'Hide', value: 'hide' },
        { name: 'Size', value: 'limit' },
        { name: 'Name', value: 'rename' },
        { name: 'Transfer', value: 'transfer' },
        { name: 'Saved lists', value: 'access' },
        { name: 'Nickname', value: 'nick' },
      ]);
      expect(choices.map((c) => c.value)).toEqual([...AVAILABLE_FEATURES]);
    });

    it('offers the same choices on remove as on add', () => {
      expect(sub('remove').options![0]).toEqual(sub('add').options![0]);
    });

    it('is not open to every member by default, and is guild only', () => {
      expect(byName.get('restrict')!.dm_permission).toBe(false);
      expect(byName.get('restrict')!.default_member_permissions).toBe(
        PermissionFlagsBits.ManageChannels.toString(),
      );
    });

    it('says what it does in one short sentence a customer can read', () => {
      const def = byName.get('restrict')!;
      for (const text of [
        def.description,
        ...subs.map((s) => (s as { description?: string }).description!),
      ]) {
        expect(text.length).toBeLessThanOrEqual(100);
        expect(text).not.toMatch(/[—–‘’“”;]/);
        expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
      }
    });
  });

  /**
   * The second command with subcommands. It is open to every member, because the saved
   * lists are a member's own, and `remove`, `clear` and `list` are how they erase and
   * check them.
   */
  describe('/access', () => {
    type Sub = {
      type: number;
      name: string;
      description: string;
      options?: { name: string; type: number; required?: boolean; choices?: { value: string }[] }[];
    };
    const subs = (byName.get('access')!.options ?? []) as unknown as Sub[];
    const sub = (name: string): Sub => subs.find((s) => s.name === name)!;
    const SUBCOMMAND = 1;
    const STRING = 3;
    const USER = 6;

    it('has trust, block, admit, remove, list and clear, and nothing else', () => {
      expect(subs.map((s) => [s.name, s.type])).toEqual([
        ['trust', SUBCOMMAND],
        ['block', SUBCOMMAND],
        ['admit', SUBCOMMAND],
        ['remove', SUBCOMMAND],
        ['list', SUBCOMMAND],
        ['clear', SUBCOMMAND],
      ]);
    });

    it('takes one required member on trust, block, admit and remove', () => {
      for (const name of ['trust', 'block', 'admit', 'remove']) {
        expect(sub(name).options, name).toMatchObject([
          { name: 'member', type: USER, required: true },
        ]);
      }
    });

    it('takes nothing on list, and an optional trusted or blocked on clear', () => {
      expect(sub('list').options ?? []).toHaveLength(0);
      expect(sub('clear').options).toMatchObject([{ name: 'list', type: STRING }]);
      expect(sub('clear').options![0]!.required ?? false).toBe(false);
      expect(sub('clear').options![0]!.choices!.map((c) => c.value)).toEqual([
        'trusted',
        'blocked',
      ]);
    });

    it('is guild only and open to every member, with no default permission', () => {
      expect(byName.get('access')!.dm_permission).toBe(false);
      expect(byName.get('access')!.default_member_permissions ?? null).toBeNull();
    });

    it('says what it does in short sentences a customer can read', () => {
      const def = byName.get('access')!;
      for (const text of [def.description, ...subs.map((s) => s.description)]) {
        expect(text.length).toBeLessThanOrEqual(100);
        expect(text).not.toMatch(/[—–‘’“”;]/);
        expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
      }
    });
  });

  /**
   * The sibling of `/alwaysprivate`: the same admin gate, no options (it acts on the creator
   * channel you are in, or offers a picker), and a description a customer can read.
   */
  describe('/alwayshidden', () => {
    // Narrowed to a chat input command, which is what it is: a context menu command has no
    // description, and that is what the union type says until it is told.
    const def = byName.get('alwayshidden')! as unknown as {
      description: string;
      default_member_permissions?: string | null;
      dm_permission?: boolean;
      options?: unknown[];
    };

    it('is admin only like /alwaysprivate, guild only, and takes no options', () => {
      expect(def.default_member_permissions).toBe(
        byName.get('alwaysprivate')!.default_member_permissions,
      );
      expect(def.default_member_permissions).toBe(PermissionFlagsBits.ManageChannels.toString());
      expect(def.dm_permission).toBe(false);
      expect(def.options ?? []).toHaveLength(0);
    });

    it('says what it does in one short sentence a customer can read', () => {
      expect(def.description.length).toBeLessThanOrEqual(100);
      expect(def.description).not.toMatch(/[—–‘’“”;]/);
      expect(def.description.toLowerCase()).not.toMatch(/primary|secondary/);
      expect(def.description).toContain('hidden');
    });
  });

  it('constrains the limit option to 0..99', () => {
    const opt = byName.get('limit')!.options?.[0] as { min_value: number; max_value: number };
    expect(opt.min_value).toBe(0);
    expect(opt.max_value).toBe(99);
  });
});
