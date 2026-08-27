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
        'create',
        'defaultlimit',
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
        'reclaim',
        'setup',
        'source',
        'template',
        'transfer',
        'unlimit',
      ].sort(),
    );
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
    // Admin-gated exactly like /template, and nothing else gates it (§5).
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
