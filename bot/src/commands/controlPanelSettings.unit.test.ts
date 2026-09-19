import { describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { GuildSettingsService } from '../features/voice/settings.js';
import { readControlPanel } from '../features/voice/guildSettings.js';
import {
  buildControlSettingsPanel,
  CONTROL_SETTINGS_PREFIX,
  CONTROL_SETTINGS_SELECT_ID,
  controlSettingsId,
  parseControlSelection,
  parseControlSettingsId,
} from './controlPanelSettings.js';

const GUILD = '460459401086763010';

/** The service with a `mergeSettings` that reports what it would write. */
function makeService(settings: Record<string, unknown> = {}) {
  const writes: { patch: Record<string, unknown>; remove: readonly string[] }[] = [];
  const mergeSettings = vi.fn(
    (
      _g: string,
      decide: (existing: unknown) => {
        patch: Record<string, unknown>;
        remove?: readonly string[];
        result: unknown;
      },
    ) => {
      const decided = decide({ settings });
      writes.push({ patch: decided.patch, remove: decided.remove ?? [] });
      return Promise.resolve(decided.result);
    },
  );
  const service = new GuildSettingsService({
    guilds: {
      ensure: vi.fn().mockResolvedValue({ settings }),
      updateSettings: vi.fn(),
      mergeSettings,
    } as never,
    autoChannels: {} as never,
    secondaries: {} as never,
    actions: {} as never,
    logger: fakeLogger(),
  });
  return { service, writes };
}

describe('control settings custom ids', () => {
  it('round-trips its three actions and refuses anything else', () => {
    expect(parseControlSettingsId(controlSettingsId('off'))).toBe('off');
    expect(parseControlSettingsId(controlSettingsId('on'))).toBe('on');
    expect(parseControlSettingsId(controlSettingsId('close'))).toBe('close');
    expect(parseControlSettingsId(`${CONTROL_SETTINGS_PREFIX}bogus`)).toBeNull();
    expect(parseControlSettingsId('avc:setup:open')).toBeNull();
  });

  /**
   * Select values are chosen client side, and this one goes straight into a
   * settings key, so it is validated rather than trusted.
   */
  it('validates a selection against the known controls', () => {
    expect(parseControlSelection('kick')).toBe('kick');
    expect(parseControlSelection('panel')).toBeNull();
    expect(parseControlSelection('__proto__')).toBeNull();
    expect(parseControlSelection('')).toBeNull();
  });
});

describe('buildControlSettingsPanel', () => {
  it('offers every control, marking the ones that are off', () => {
    const config = readControlPanel({ control_panel: { kick: false } });
    const json = JSON.stringify(buildControlSettingsPanel(config));
    expect(json).toContain(CONTROL_SETTINGS_SELECT_ID);
    expect(json).toContain('Kick (off)');
    expect(json).toContain('Switched off: Kick.');
  });

  it('drops the picker and offers the way back when the panel is off', () => {
    const config = readControlPanel({ control_panel: { panel: false } });
    const json = JSON.stringify(buildControlSettingsPanel(config));
    expect(json).not.toContain(CONTROL_SETTINGS_SELECT_ID);
    expect(json).toContain(controlSettingsId('on'));
    expect(json).not.toContain(controlSettingsId('off'));
  });

  /**
   * `/setup`'s rule (rewrite.md decision 11): at most one Success button and
   * never a Primary, a Danger or a disabled one. The green one exists only
   * where turning the panel back on is this state's answer.
   */
  it('has one Success button when the panel is off, and none when it is on', () => {
    const off = JSON.stringify(
      buildControlSettingsPanel(readControlPanel({ control_panel: { panel: false } })),
    );
    expect([...off.matchAll(/"style":3/g)]).toHaveLength(1);
    const on = JSON.stringify(buildControlSettingsPanel(readControlPanel({})));
    expect(on).not.toMatch(/"style":(1|3|4)/);
    expect(on).not.toContain('"disabled":true');
  });

  it('follows the copy rules', () => {
    for (const settings of [
      {},
      { control_panel: { panel: false } },
      { control_panel: { kick: false } },
    ]) {
      const text = JSON.stringify(
        buildControlSettingsPanel(readControlPanel(settings), { note: 'a note' }),
      );
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/[‘’“”]/);
      expect(text.toLowerCase()).not.toContain('secondary channel');
    }
  });
});

describe('setControlPanelEntry', () => {
  it('stores only what is switched off', async () => {
    const { service, writes } = makeService();
    await service.setControlPanelEntry(GUILD, 'kick', false);
    expect(writes[0]!.patch).toEqual({ control_panel: { kick: false } });
    expect(writes[0]!.remove).toEqual([]);
  });

  /**
   * Writing `{}` would make "deliberately all on" indistinguishable from
   * "never configured" on an export round trip, and the format's rule is that
   * `null` on the wire means the key is absent from the blob.
   */
  it('removes the key entirely once nothing is off any more', async () => {
    const { service, writes } = makeService({ control_panel: { kick: false } });
    await service.setControlPanelEntry(GUILD, 'kick', true);
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual(['control_panel']);
  });

  it('keeps the other entries when one is switched back on', async () => {
    const { service, writes } = makeService({ control_panel: { kick: false, info: false } });
    await service.setControlPanelEntry(GUILD, 'kick', true);
    expect(writes[0]!.patch).toEqual({ control_panel: { info: false } });
  });

  it('switches the whole panel through the same key', async () => {
    const { service, writes } = makeService({ control_panel: { kick: false } });
    await service.setControlPanelEntry(GUILD, 'panel', false);
    expect(writes[0]!.patch).toEqual({ control_panel: { kick: false, panel: false } });
  });

  /**
   * Golden rule 3: preserve unknown JSON fields on writes.
   *
   * Filtering to booleans looked tidier and would break the very migration
   * `feature-parity.md` §3.5 names next, which widens a value in this same key
   * from a boolean to `false | 'everyone' | [role ids]`. An OLD instance mid
   * rollout would then delete every role-valued entry the moment an admin
   * toggled any single button. A value this build cannot read is ignored by
   * `readControlPanel`, which is inert; one it DELETES is gone.
   */
  it('keeps a value it cannot read rather than deleting it', async () => {
    const { service, writes } = makeService({
      control_panel: { kick: ['role-1'], info: false },
    });
    await service.setControlPanelEntry(GUILD, 'lock', false);
    expect(writes[0]!.patch).toEqual({
      control_panel: { kick: ['role-1'], info: false, lock: false },
    });
  });

  it('keeps the key alive for an entry it cannot read, rather than sweeping it away', async () => {
    const { service, writes } = makeService({ control_panel: { kick: ['role-1'], info: false } });
    await service.setControlPanelEntry(GUILD, 'info', true);
    expect(writes[0]!.remove).toEqual([]);
    expect(writes[0]!.patch).toEqual({ control_panel: { kick: ['role-1'] } });
  });
});
