import { describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { GuildSettingsService } from '../features/voice/settings.js';
import {
  CONTROL_PANEL_CONTROLS,
  CONTROL_PANEL_DEFAULTS,
  readControlPanel,
} from '../features/voice/guildSettings.js';
import {
  buildControlSettingsPanel,
  CONTROL_SETTINGS_PREFIX,
  controlSettingsId,
  controlToggleId,
  parseControlSettingsId,
  parseControlToggleId,
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
  it('round-trips its three whole-panel actions and refuses anything else', () => {
    expect(parseControlSettingsId(controlSettingsId('off'))).toBe('off');
    expect(parseControlSettingsId(controlSettingsId('on'))).toBe('on');
    expect(parseControlSettingsId(controlSettingsId('close'))).toBe('close');
    expect(parseControlSettingsId(`${CONTROL_SETTINGS_PREFIX}bogus`)).toBeNull();
    expect(parseControlSettingsId('avc:setup:open')).toBeNull();
  });

  it('round-trips a per-control toggle', () => {
    for (const c of CONTROL_PANEL_CONTROLS) {
      expect(parseControlToggleId(controlToggleId(c))).toBe(c);
    }
  });

  /**
   * The two parsers share a namespace, so each has to refuse the other's ids or
   * a toggle would be read as a whole-panel action and switch the wrong thing.
   */
  it('keeps the toggles and the whole-panel actions apart', () => {
    expect(parseControlSettingsId(controlToggleId('kick'))).toBeNull();
    expect(parseControlToggleId(controlSettingsId('off'))).toBeNull();
  });

  /**
   * A custom id comes back from a message we posted, but it is still client
   * input on the wire and it goes straight into a settings key.
   */
  it('refuses a toggle for anything that is not a known control', () => {
    expect(parseControlToggleId(`${CONTROL_SETTINGS_PREFIX}t:panel`)).toBeNull();
    expect(parseControlToggleId(`${CONTROL_SETTINGS_PREFIX}t:__proto__`)).toBeNull();
    expect(parseControlToggleId(`${CONTROL_SETTINGS_PREFIX}t:`)).toBeNull();
  });
});

describe('buildControlSettingsPanel', () => {
  it('describes every control in a field, with its state', () => {
    const json = buildControlSettingsPanel(readControlPanel({}));
    const fields = json.embeds![0]! as { fields?: { name: string; value: string }[] };
    expect(fields.fields).toHaveLength(CONTROL_PANEL_CONTROLS.length);
    // Claim is off by default, Size is on, and the state is in the field name.
    expect(fields.fields!.map((f) => f.name)).toContain('❌ 👑 Claim');
    expect(fields.fields!.map((f) => f.name)).toContain('✅ 👥 Size');
  });

  it('gives every control a toggle button carrying its state', () => {
    const json = JSON.stringify(buildControlSettingsPanel(readControlPanel({})));
    for (const c of CONTROL_PANEL_CONTROLS) expect(json).toContain(controlToggleId(c));
    expect(json).toContain('✅');
    expect(json).toContain('❌');
  });

  it('drops the toggles and offers the way back when the panel is off', () => {
    const json = JSON.stringify(
      buildControlSettingsPanel(readControlPanel({ control_panel: { panel: false } })),
    );
    expect(json).not.toContain(controlToggleId('kick'));
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

  /** Every button off is a third state: the panel is on and yet nothing is posted. */
  it('says so when every button is off', () => {
    const none = Object.fromEntries(CONTROL_PANEL_CONTROLS.map((c) => [c, false]));
    const json = buildControlSettingsPanel(readControlPanel({ control_panel: none }));
    expect(JSON.stringify(json.embeds![0])).toContain('no control panel at all');
  });

  it('follows the copy rules', () => {
    const none = Object.fromEntries(CONTROL_PANEL_CONTROLS.map((c) => [c, false]));
    for (const settings of [{}, { control_panel: { panel: false } }, { control_panel: none }]) {
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
  it('stores a control only when it differs from its default', async () => {
    const off = makeService();
    await off.service.setControlPanelEntry(GUILD, 'kick', false);
    expect(off.writes[0]!.patch).toEqual({ control_panel: { kick: false } });

    // Claim is off by DEFAULT, so switching it on is the departure worth storing.
    expect(CONTROL_PANEL_DEFAULTS.claim).toBe(false);
    const on = makeService();
    await on.service.setControlPanelEntry(GUILD, 'claim', true);
    expect(on.writes[0]!.patch).toEqual({ control_panel: { claim: true } });
  });

  /**
   * Writing the default out would pin a server to today's answer for a control
   * they never touched, and writing `{}` would make "deliberately default"
   * indistinguishable from "never configured" on an export round trip.
   */
  it('removes the key entirely once everything is back to its default', async () => {
    const { service, writes } = makeService({ control_panel: { kick: false } });
    await service.setControlPanelEntry(GUILD, 'kick', true);
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual(['control_panel']);
  });

  it('keeps the other entries when one goes back to its default', async () => {
    const { service, writes } = makeService({ control_panel: { kick: false, claim: true } });
    await service.setControlPanelEntry(GUILD, 'kick', true);
    expect(writes[0]!.patch).toEqual({ control_panel: { claim: true } });
  });

  it('switches the whole panel through the same key', async () => {
    const { service, writes } = makeService({ control_panel: { kick: false } });
    await service.setControlPanelEntry(GUILD, 'panel', false);
    expect(writes[0]!.patch).toEqual({ control_panel: { kick: false, panel: false } });
  });

  /**
   * Golden rule 3: preserve unknown JSON fields on writes. Filtering to
   * booleans would break the migration `feature-parity.md` §3.5 names next,
   * which widens a value in this same key to `false | 'everyone' | [role ids]`.
   */
  it('keeps a value it cannot read rather than deleting it', async () => {
    const { service, writes } = makeService({
      control_panel: { kick: ['role-1'], claim: true },
    });
    await service.setControlPanelEntry(GUILD, 'rename', false);
    expect(writes[0]!.patch).toEqual({
      control_panel: { kick: ['role-1'], claim: true, rename: false },
    });
  });

  it('keeps the key alive for an entry it cannot read, rather than sweeping it away', async () => {
    const { service, writes } = makeService({ control_panel: { kick: ['role-1'], claim: true } });
    await service.setControlPanelEntry(GUILD, 'claim', false);
    expect(writes[0]!.remove).toEqual([]);
    expect(writes[0]!.patch).toEqual({ control_panel: { kick: ['role-1'] } });
  });
});
