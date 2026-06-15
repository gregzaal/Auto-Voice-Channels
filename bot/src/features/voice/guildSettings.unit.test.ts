import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from './nameTemplate.js';
import { isStringMap, parseVoiceSettings, readLogging } from './guildSettings.js';

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
    expect(readLogging({ logging: 'c1', log_level: 3 })).toEqual({
      enabled: true,
      level: 3,
      channelId: 'c1',
    });
    // Out-of-range / non-numeric level falls back to 1; logging:false → disabled.
    expect(readLogging({ logging: false, log_level: 9 })).toEqual({
      enabled: false,
      level: 1,
      channelId: null,
    });
  });
});
