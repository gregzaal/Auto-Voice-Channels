import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildCommandDefinitions } from './definitions.js';

describe('buildCommandDefinitions', () => {
  const defs = buildCommandDefinitions();
  const byName = new Map(defs.map((d) => [d.name, d]));

  it('exposes the full hybrid command surface', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'alias',
        'alwaysprivate',
        'channelinfo',
        'create',
        'defaultlimit',
        'export',
        'group',
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
        'setup',
        'source',
        'template',
        'transfer',
        'unlimit',
      ].sort(),
    );
  });

  /**
   * One permission tier above the configuration commands: `/import`
   * replaces another admin's work from a file, and `/export` discloses channel
   * ids, the recorded contact and every self-chosen nickname. `/docs/commands`
   * publishes "Manage Server" for both, so this is a published commitment.
   */
  it('gates export and import behind ManageGuild, one tier higher', () => {
    const manageGuild = PermissionFlagsBits.ManageGuild.toString();
    for (const name of ['export', 'import']) {
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
      'group',
      'inheritpermissions',
      'logging',
    ]) {
      expect(byName.get(name)!.default_member_permissions).toBe(manage);
    }
    // Per-channel + utility commands stay open (owner checks live in logic).
    for (const name of ['limit', 'nick', 'ping', 'invite', 'source']) {
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
      'reclaim',
      'template',
      'position',
      'alwaysprivate',
      'group',
      'logging',
    ]) {
      expect(byName.get(name)!.options ?? [], `${name} should have no options`).toHaveLength(0);
    }
    // inheritpermissions is now modal-driven too (no slash options).
    expect(byName.get('inheritpermissions')!.options ?? []).toHaveLength(0);
  });

  it('constrains the limit option to 0..99', () => {
    const opt = byName.get('limit')!.options?.[0] as { min_value: number; max_value: number };
    expect(opt.min_value).toBe(0);
    expect(opt.max_value).toBe(99);
  });
});
