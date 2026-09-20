import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from './nameTemplate.js';
import {
  CONTROL_PANEL_CONTROLS,
  CONTROL_PANEL_DEFAULT_ENABLED,
  CONTROL_PANEL_DEFAULTS,
  controlPanelConfirmation,
  readControlPanel,
  ROOT_GROUP_KEY,
  groupKeyFor,
  isStringMap,
  parseVoiceSettings,
  readContact,
  readGroup,
  readGroups,
  readLogging,
} from './guildSettings.js';

describe('guildSettings', () => {
  it('applies defaults for an empty blob', () => {
    const s = parseVoiceSettings({});
    expect(s.enabled).toBe(true);
    expect(s.general).toBe('General');
    expect(s.channelNameTemplate).toBe(DEFAULT_CHANNEL_NAME_TEMPLATE);
    expect(s.aliases).toEqual({});
    expect(s.customNicks).toEqual({});
  });

  it('reads valid values', () => {
    const s = parseVoiceSettings({
      enabled: false,
      general: 'Hangout',
      channel_name_template: '@@creator@@',
      aliases: { 'Counter-Strike 2': 'CS2' },
      custom_nicks: { u1: 'Big G' },
    });
    expect(s.enabled).toBe(false);
    expect(s.general).toBe('Hangout');
    expect(s.channelNameTemplate).toBe('@@creator@@');
    expect(s.aliases).toEqual({ 'Counter-Strike 2': 'CS2' });
    expect(s.customNicks).toEqual({ u1: 'Big G' });
  });

  it('rejects non-string map values rather than passing them through', () => {
    // A corrupt/legacy blob with a non-string nick must not reach channel.setName.
    const s = parseVoiceSettings({ custom_nicks: { u1: 42 }, aliases: ['not', 'a', 'map'] });
    expect(s.customNicks).toEqual({});
    expect(s.aliases).toEqual({});
  });

  it('isStringMap guards arrays and non-string values', () => {
    expect(isStringMap({ a: 'b' })).toBe(true);
    expect(isStringMap({})).toBe(true);
    expect(isStringMap({ a: 1 })).toBe(false);
    expect(isStringMap(['a'])).toBe(false);
    expect(isStringMap(null)).toBe(false);
    expect(isStringMap('x')).toBe(false);
  });

  it('readLogging derives enabled/level/channel', () => {
    expect(readLogging({})).toEqual({ enabled: false, level: 1, channelId: null });
    expect(readLogging({ logging: '234567890123456789', log_level: 3 })).toEqual({
      enabled: true,
      level: 3,
      channelId: '234567890123456789',
    });
    // Out-of-range / non-numeric level falls back to 1; logging:false → disabled.
    expect(readLogging({ logging: false, log_level: 9 })).toEqual({
      enabled: false,
      level: 1,
      channelId: null,
    });
  });

  /**
   * The id is validated, not merely truthy. `/import` can put an arbitrary
   * string here, and a value that is not a snowflake cannot be a channel.
   */
  it('readLogging rejects a channel id that is not a snowflake', () => {
    for (const bad of ['c1', '', '12345', '2345678901234567890123', '23456789012345678\n', 42]) {
      expect(readLogging({ logging: bad, log_level: 2 })).toEqual({
        enabled: false,
        level: 2,
        channelId: null,
      });
    }
  });

  it('groupKeyFor maps a category id to itself and null/undefined to the root sentinel', () => {
    expect(groupKeyFor('cat-1')).toBe('cat-1');
    expect(groupKeyFor(null)).toBe(ROOT_GROUP_KEY);
    expect(groupKeyFor(undefined)).toBe(ROOT_GROUP_KEY);
  });

  it('readGroups parses the grouping map and skips malformed entries', () => {
    expect(readGroups({})).toEqual({});
    expect(readGroups({ groups: { 'cat-1': { above: true }, '@root': { above: false } } })).toEqual(
      { 'cat-1': { above: true }, '@root': { above: false } },
    );
    // Missing/odd `above` defaults to false; non-object entries and arrays are skipped.
    expect(readGroups({ groups: { 'cat-2': {}, 'cat-3': 'nope', 'cat-4': ['x'] } })).toEqual({
      'cat-2': { above: false },
    });
    expect(readGroups({ groups: 'not-an-object' })).toEqual({});
  });

  it('readGroup returns one category config or undefined', () => {
    const settings = { groups: { 'cat-1': { above: true } } };
    expect(readGroup(settings, 'cat-1')).toEqual({ above: true });
    expect(readGroup(settings, 'cat-9')).toBeUndefined();
  });
});

describe('readContact', () => {
  it('reads a stored snowflake', () => {
    expect(readContact({ contact_user_id: '201444089835552768' })).toBe('201444089835552768');
  });

  it('is null when unset, so callers fall back to the owner', () => {
    expect(readContact({})).toBeNull();
  });

  /**
   * The settings blob is `record(unknown)` at the repo boundary, so a bad value
   * is only ever caught here. A number is the realistic failure: that is how
   * the legacy dump stored snowflakes, and above 2^53 it is silently wrong.
   */
  it('rejects anything that is not snowflake-shaped', () => {
    expect(readContact({ contact_user_id: 201444089835552768 })).toBeNull();
    expect(readContact({ contact_user_id: '' })).toBeNull();
    expect(readContact({ contact_user_id: '123' })).toBeNull();
    expect(readContact({ contact_user_id: null })).toBeNull();
    expect(readContact({ contact_user_id: { id: '201444089835552768' } })).toBeNull();
  });
});

describe('readControlPanel', () => {
  /**
   * The panel is OFF for a server that has never configured it, while the
   * feature is proved on beta. The control defaults still apply underneath, so
   * turning it on gives that server the intended set rather than everything.
   */
  it('is on for a server that has never configured it', () => {
    const config = readControlPanel({});
    expect(config.enabled).toBe(true);
    expect(CONTROL_PANEL_DEFAULT_ENABLED).toBe(true);
    expect(config.controls).toEqual(CONTROL_PANEL_DEFAULTS);
  });

  /** Only a departure is stored, so a server that said no keeps its no. */
  it('keeps a stored no when the default moved to yes', () => {
    expect(readControlPanel({ control_panel: { panel: false } }).enabled).toBe(false);
  });

  /**
   * Claim and Transfer are off out of the box: both are handovers, and Claim
   * in particular only works when nobody is in charge, because ownership passes
   * to the longest-present member the moment an owner leaves.
   */
  it('leaves Claim and Transfer off out of the box', () => {
    const config = readControlPanel({});
    expect(config.controls.claim).toBe(false);
    expect(config.controls.transfer).toBe(false);
    expect(config.controls.privacy).toBe(true);
  });

  it('applies exactly what the blob names, in either direction', () => {
    const config = readControlPanel({ control_panel: { panel: true, kick: false, claim: true } });
    expect(config.enabled).toBe(true);
    expect(config.controls.kick).toBe(false);
    expect(config.controls.claim).toBe(true);
    expect(config.controls.privacy).toBe(true);
  });

  it('reads the panel sentinel as the panel itself, never as a control', () => {
    const config = readControlPanel({ control_panel: { panel: false } });
    expect(config.enabled).toBe(false);
    // The controls are untouched, so turning the panel back on restores what
    // the server had rather than an empty one.
    expect(config.controls).toEqual(CONTROL_PANEL_DEFAULTS);
  });

  /**
   * A file exported from a newer build can name a control this one has never
   * heard of. Losing the rest of the map over it would be worse than ignoring
   * it, and an unknown id is inert because nothing ever looks it up.
   */
  it('ignores unknown ids and malformed values rather than giving up on the map', () => {
    const config = readControlPanel({
      control_panel: { somethingnew: false, kick: 'no', info: false },
    });
    expect(config.controls.info).toBe(false);
    expect(config.controls.kick).toBe(true);
    expect(Object.keys(config.controls).sort()).toEqual([...CONTROL_PANEL_CONTROLS].sort());
  });

  it('treats a corrupt key as never configured', () => {
    for (const raw of [null, 'off', 42, ['kick']]) {
      const config = readControlPanel({ control_panel: raw });
      expect(config.enabled).toBe(CONTROL_PANEL_DEFAULT_ENABLED);
      expect(config.controls).toEqual(CONTROL_PANEL_DEFAULTS);
    }
  });

  /**
   * The settings cache serves one row object to every caller on the instance,
   * so a reader that handed back a stored reference - or the defaults map
   * itself - would let one caller's mutation corrupt every other guild read in
   * the process.
   */
  it('hands back a fresh object each time, never the defaults map', () => {
    const settings = { control_panel: { kick: false } };
    const first = readControlPanel(settings);
    first.controls.privacy = false;
    expect(readControlPanel(settings).controls.privacy).toBe(true);
    expect(CONTROL_PANEL_DEFAULTS.privacy).toBe(true);
  });
});

describe('controlPanelConfirmation', () => {
  it('always says the panels already posted are updated too', () => {
    for (const on of [true, false]) {
      expect(controlPanelConfirmation('panel', on)).toContain('already posted');
      expect(controlPanelConfirmation('kick', on)).toContain('already posted');
    }
  });

  it('says the command still works when a button is taken away', () => {
    expect(controlPanelConfirmation('kick', false)).toContain('command behind it still works');
    expect(controlPanelConfirmation('panel', false)).toContain('command that still works');
  });

  it('follows the copy rules', () => {
    for (const control of [...CONTROL_PANEL_CONTROLS, 'panel'] as const) {
      for (const on of [true, false]) {
        const text = controlPanelConfirmation(control, on);
        expect(text).not.toMatch(/[—–]/);
        expect(text).not.toMatch(/[‘’“”]/);
        expect(text).not.toMatch(/;/);
      }
    }
  });
});
