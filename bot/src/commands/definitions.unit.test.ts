import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildCommandDefinitions } from './definitions.js';

describe('buildCommandDefinitions', () => {
  const defs = buildCommandDefinitions();
  const byName = new Map(defs.map((d) => [d.name, d]));

  it('exposes the full hybrid command surface', () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        'alwaysprivate',
        'claim',
        'create',
        'group',
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
        'settings',
        'setup',
        'template',
        'transfer',
        'unlimit',
      ].sort(),
    );
  });

  it('gates admin commands behind ManageChannels', () => {
    const manage = PermissionFlagsBits.ManageChannels.toString();
    for (const name of [
      'settings',
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
    for (const name of ['limit', 'nick', 'ping', 'invite']) {
      expect(byName.get(name)!.default_member_permissions ?? null).toBeNull();
    }
  });

  it('includes /debug only when requested', () => {
    expect(byName.has('debug')).toBe(false);
    const withDebug = buildCommandDefinitions({ includeDebug: true });
    const debug = withDebug.find((d) => d.name === 'debug');
    expect(debug).toBeDefined();
    expect(debug!.default_member_permissions).toBe(PermissionFlagsBits.ManageChannels.toString());
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
      'claim',
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
