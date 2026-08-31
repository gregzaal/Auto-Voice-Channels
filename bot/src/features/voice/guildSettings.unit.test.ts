import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_NAME_TEMPLATE } from './nameTemplate.js';
import {
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
