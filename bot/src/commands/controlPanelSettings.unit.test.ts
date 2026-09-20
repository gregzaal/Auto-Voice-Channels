import { describe, expect, it, vi } from 'vitest';
import { fakeLogger } from '../runtime/testUtils.js';
import { GuildSettingsService } from '../features/voice/settings.js';
import {
  CONTROL_PANEL_APPEARANCE_KEYS,
  CONTROL_PANEL_CONTROLS,
  CONTROL_PANEL_DEFAULT_COLOR,
  CONTROL_PANEL_DESCRIPTION_MAX,
  CONTROL_PANEL_DEFAULTS,
  readControlPanel,
} from '../features/voice/guildSettings.js';
import {
  buildAppearanceModal,
  buildControlSettingsPanel,
  CONTROL_SETTINGS_PREFIX,
  controlAppearanceId,
  controlSettingsId,
  controlToggleId,
  parseControlAppearanceId,
  parseControlSettingsId,
  parseControlToggleId,
} from './controlPanelSettings.js';

const GUILD = '460459401086763010';

/**
 * A server that has switched the panel on. The panel is off for one that has
 * never configured it, which `buildControlSettingsPanel` renders as its own
 * state and which has its own test below.
 */
const ON = { control_panel: { panel: true } };

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
    const json = buildControlSettingsPanel(readControlPanel(ON));
    const fields = json.embeds![0]! as { fields?: { name: string; value: string }[] };
    // One per control, plus the Appearance summary.
    expect(fields.fields).toHaveLength(CONTROL_PANEL_CONTROLS.length + 1);
    // Claim is off by default, Size is on, and the state is in the field name.
    expect(fields.fields!.map((f) => f.name)).toContain('❌ 👑 Claim');
    expect(fields.fields!.map((f) => f.name)).toContain('✅ 👥 Size');
  });

  /**
   * The appearance half. The values are shown raw, tokens and all, because that
   * is what the modal hands back and what an admin edits.
   */
  it('summarises the colour, title and description as one field', () => {
    const json = buildControlSettingsPanel(readControlPanel(ON));
    const embed = json.embeds![0]! as {
      color?: number;
      fields?: { name: string; value: string }[];
    };
    const appearance = embed.fields!.find((f) => f.name === '🎨 Appearance')!;
    expect(appearance.value).toContain('Control your room');
    expect(appearance.value).toContain('@@owner@@');
    expect(appearance.value).toContain('#c43bff');
    // The description is shown on one line: a stored newline would otherwise
    // break the three labels apart.
    expect(appearance.value.split('\n')).toHaveLength(3);
    // The panel wears the colour it configures, so a change is visible at once.
    expect(embed.color).toBe(CONTROL_PANEL_DEFAULT_COLOR);
    expect(
      (
        buildControlSettingsPanel(
          readControlPanel({ ...ON, control_panel_style: { color: 0x00ff00 } }),
        ).embeds![0]! as { color?: number }
      ).color,
    ).toBe(0x00ff00);
  });

  it('offers a button per appearance entry, and only while the panel is on', () => {
    const on = JSON.stringify(buildControlSettingsPanel(readControlPanel(ON)));
    for (const key of CONTROL_PANEL_APPEARANCE_KEYS) {
      expect(on).toContain(controlAppearanceId(key));
    }
    const off = JSON.stringify(
      buildControlSettingsPanel(readControlPanel({ control_panel: { panel: false } })),
    );
    expect(off).not.toContain(controlAppearanceId('title'));
  });

  /**
   * Five rows is Discord's ceiling and a sixth is refused outright, which would
   * take the whole configuration surface down rather than drop a button.
   */
  it('never renders more rows than Discord accepts', () => {
    for (const settings of [ON, { control_panel: { panel: false } }]) {
      expect(
        buildControlSettingsPanel(readControlPanel(settings)).components!.length,
      ).toBeLessThanOrEqual(5);
    }
  });
});

describe('parseControlAppearanceId', () => {
  it('reads back every key it writes', () => {
    for (const key of CONTROL_PANEL_APPEARANCE_KEYS) {
      expect(parseControlAppearanceId(controlAppearanceId(key))).toBe(key);
    }
  });

  /** Same reasoning as the toggle id: it still names a settings key. */
  it('refuses anything that is not a known key', () => {
    expect(parseControlAppearanceId(`${CONTROL_SETTINGS_PREFIX}a:panel`)).toBeNull();
    expect(parseControlAppearanceId(`${CONTROL_SETTINGS_PREFIX}a:__proto__`)).toBeNull();
    expect(parseControlAppearanceId(`${CONTROL_SETTINGS_PREFIX}a:`)).toBeNull();
    expect(parseControlAppearanceId(`${CONTROL_SETTINGS_PREFIX}t:kick`)).toBeNull();
    expect(parseControlAppearanceId('avc:other:a:title')).toBeNull();
  });
});

describe('buildAppearanceModal', () => {
  const config = readControlPanel(ON);

  /** Blank submits back to the default, so the input cannot be required. */
  it('prefills what is set now and never requires a value', () => {
    for (const key of CONTROL_PANEL_APPEARANCE_KEYS) {
      const json = buildAppearanceModal(key, config).toJSON();
      const input = (
        json.components[0]!.components as unknown as {
          required?: boolean;
          value?: string;
          max_length?: number;
        }[]
      )[0]!;
      expect(json.custom_id).toBe(controlAppearanceId(key));
      expect(input.required).toBe(false);
      expect(input.value).toBeTruthy();
    }
  });

  it('shows the colour as hex, and the text raw', () => {
    const value = (key: Parameters<typeof buildAppearanceModal>[0]): string =>
      (
        buildAppearanceModal(key, config).toJSON().components[0]!.components as unknown as {
          value?: string;
        }[]
      )[0]!.value!;
    expect(value('color')).toBe('#c43bff');
    expect(value('title')).toBe('Control your room');
    expect(value('description')).toContain('@@owner@@');
  });

  it('gives every control a toggle button carrying its state', () => {
    const json = JSON.stringify(buildControlSettingsPanel(readControlPanel(ON)));
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
    const on = JSON.stringify(buildControlSettingsPanel(readControlPanel(ON)));
    expect(on).not.toMatch(/"style":(1|3|4)/);
    expect(on).not.toContain('"disabled":true');
  });

  /** Every button off is a third state: the panel is on and yet nothing is posted. */
  it('says so when every button is off', () => {
    const none = Object.fromEntries(CONTROL_PANEL_CONTROLS.map((c) => [c, false]));
    const json = buildControlSettingsPanel(
      readControlPanel({ control_panel: { ...none, panel: true } }),
    );
    // The title still says enabled, so the description is the only place that
    // can tell an admin nothing is actually being posted.
    expect(JSON.stringify(json.embeds![0])).toContain('Control panels are enabled');
    expect(JSON.stringify(json.embeds![0])).toContain('nothing is being posted at all');
  });

  it('follows the copy rules', () => {
    const none = Object.fromEntries(CONTROL_PANEL_CONTROLS.map((c) => [c, false]));
    for (const settings of [
      ON,
      {},
      { control_panel: { panel: false } },
      { control_panel: { ...none, panel: true } },
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

  /** The panel is off by default, so switching it ON is the departure stored. */
  it('switches the whole panel through the same key', async () => {
    // On is the default, so OFF is the departure that gets stored.
    const off = makeService({ control_panel: { kick: false } });
    await off.service.setControlPanelEntry(GUILD, 'panel', false);
    expect(off.writes[0]!.patch).toEqual({ control_panel: { kick: false, panel: false } });

    const on = makeService({ control_panel: { kick: false, panel: false } });
    await on.service.setControlPanelEntry(GUILD, 'panel', true);
    expect(on.writes[0]!.patch).toEqual({ control_panel: { kick: false } });
  });

  /**
   * Switching the panel back on is agreeing with the default, so it stores
   * nothing and the key removes itself. That is what keeps "deliberately on"
   * and "never configured" the same state through an export round trip.
   */
  it('removes the key entirely when the panel goes back to the default', async () => {
    const { service, writes } = makeService({ control_panel: { panel: false } });
    await service.setControlPanelEntry(GUILD, 'panel', true);
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual(['control_panel']);
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

/**
 * The storage rule for the appearance half, which is the same one the toggles
 * follow: only a DEPARTURE from the default is kept, and the key removes itself
 * once nothing is left in it. That is what keeps "deliberately the default" and
 * "never configured" the same state through an export round trip.
 */
describe('setControlPanelAppearance', () => {
  it('stores a title that differs, and drops one that matches the default', async () => {
    const { service, writes } = makeService({});
    await service.setControlPanelAppearance(GUILD, 'title', 'Your room');
    expect(writes[0]!.patch.control_panel_style).toEqual({ title: 'Your room' });

    const back = makeService({ control_panel_style: { title: 'Your room', color: 1 } });
    await back.service.setControlPanelAppearance(GUILD, 'title', 'Control your room');
    expect(back.writes[0]!.patch.control_panel_style).toEqual({ color: 1 });
  });

  /**
   * The style key is separate from the switches key, so resetting the last
   * style entry must not take the switches with it.
   */
  it('removes the style key when the reset leaves nothing behind, and only that key', async () => {
    const { service, writes } = makeService({
      control_panel: { kick: false },
      control_panel_style: { color: 0x00ff00 },
    });
    await service.setControlPanelAppearance(GUILD, 'color', null);
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.remove).toEqual(['control_panel_style']);
  });

  it('stores a colour as the integer, not the string somebody typed', async () => {
    const { service, writes } = makeService({});
    await service.setControlPanelAppearance(GUILD, 'color', 0xc43bfe);
    expect((writes[0]!.patch.control_panel_style as Record<string, unknown>).color).toBe(0xc43bfe);
  });

  /**
   * Validated at the writer as well as at the command layer. This is the only
   * writer, and a colour outside Discord's range does not fail one write, it
   * fails every panel render in the guild afterwards.
   */
  it('refuses a colour outside the range Discord accepts, and writes nothing', async () => {
    for (const bad of [-1, 0x1000000, 1.5]) {
      const { service, writes } = makeService({});
      const res = await service.setControlPanelAppearance(GUILD, 'color', bad);
      expect(res.ok).toBe(false);
      expect(writes).toHaveLength(0);
    }
  });

  it('refuses a title that is empty once the spaces come off', async () => {
    const { service, writes } = makeService({});
    const res = await service.setControlPanelAppearance(GUILD, 'title', '   ');
    expect(res.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  /**
   * Golden rule 3, the same trap `setControlPanelEntry` documents: an entry a
   * newer build wrote has to survive an older one saving an unrelated setting.
   */
  it('preserves entries it does not understand', async () => {
    const { service, writes } = makeService({
      control_panel_style: { somethingNew: 7, banner: 'x' },
    });
    await service.setControlPanelAppearance(GUILD, 'title', 'Yours');
    expect(writes[0]!.patch.control_panel_style).toEqual({
      somethingNew: 7,
      banner: 'x',
      title: 'Yours',
    });
  });

  /** The switches key is a different key and must be left completely alone. */
  it('never touches the switches key', async () => {
    const { service, writes } = makeService({ control_panel: { panel: false, kick: false } });
    await service.setControlPanelAppearance(GUILD, 'title', 'Yours');
    expect(writes[0]!.patch.control_panel).toBeUndefined();
    expect(writes[0]!.remove).toEqual([]);
  });

  it('caps a stored description rather than letting Discord refuse the render', async () => {
    const { service, writes } = makeService({});
    await service.setControlPanelAppearance(GUILD, 'description', 'x'.repeat(9000));
    const stored = (writes[0]!.patch.control_panel_style as Record<string, string>).description;
    expect(stored.length).toBe(CONTROL_PANEL_DESCRIPTION_MAX);
  });
});
