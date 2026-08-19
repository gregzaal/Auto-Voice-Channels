import { describe, expect, it } from 'vitest';
import { parseLegacyJson, quoteLongIntegers } from './parseLegacyJson.js';

/**
 * These guard the single most damaging bug available to the importer. A
 * snowflake rounded by `JSON.parse` is still a plausible-looking id, so nothing
 * downstream would have complained: the rooms would simply have had owners and
 * companion channels that do not exist.
 */
describe('parseLegacyJson', () => {
  it('keeps a snowflake exact where JSON.parse would round it', () => {
    const text = '{"logging": 605724722902204416}';
    expect(JSON.parse(text).logging).toBe(605724722902204400); // the bug
    expect((parseLegacyJson(text) as { logging: string }).logging).toBe('605724722902204416');
  });

  it('handles every id field the dump actually uses', () => {
    const text = `{
      "logging": 605724722902204416,
      "auto_channels": {
        "605724722902204416": {
          "secondaries": {
            "700000000000000123": {
              "creator": 291185187105275904,
              "jc": 718375705951338548,
              "tc": 718375705951338549,
              "tcr": 718375705951338550
            }
          }
        }
      }
    }`;
    const parsed = parseLegacyJson(text) as Record<string, never>;
    const secondary = (
      parsed as never as {
        auto_channels: Record<string, { secondaries: Record<string, Record<string, string>> }>;
      }
    ).auto_channels['605724722902204416']!.secondaries['700000000000000123']!;
    expect(secondary.creator).toBe('291185187105275904');
    expect(secondary.jc).toBe('718375705951338548');
    expect(secondary.tc).toBe('718375705951338549');
    expect(secondary.tcr).toBe('718375705951338550');
  });

  /** Small numbers are still numbers: log_level and friends must not become strings. */
  it('leaves small integers alone', () => {
    const parsed = parseLegacyJson('{"log_level": 3, "limit": 5}') as Record<string, number>;
    expect(parsed.log_level).toBe(3);
    expect(parsed.limit).toBe(5);
  });

  it('leaves booleans, null and strings alone', () => {
    const parsed = parseLegacyJson(
      '{"enabled": true, "left": null, "general": "General"}',
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ enabled: true, left: null, general: 'General' });
  });

  /**
   * The reason this is a walker and not a regex. Channel-name templates are
   * arbitrary user text and genuinely contain long digit runs.
   */
  it('does not touch digits inside strings', () => {
    const text = '{"channel_name_template": "Room 12345678901234567890 ##"}';
    const parsed = parseLegacyJson(text) as Record<string, string>;
    expect(parsed.channel_name_template).toBe('Room 12345678901234567890 ##');
  });

  it('is not fooled by an escaped quote before a long number', () => {
    const text = '{"a": "he said \\"hi\\"", "b": 605724722902204416}';
    const parsed = parseLegacyJson(text) as Record<string, string>;
    expect(parsed.a).toBe('he said "hi"');
    expect(parsed.b).toBe('605724722902204416');
  });

  it('leaves floats and exponents as numbers', () => {
    const parsed = parseLegacyJson('{"a": 1234567890123456.5, "b": 1e20}') as Record<
      string,
      number
    >;
    expect(typeof parsed.a).toBe('number');
    expect(typeof parsed.b).toBe('number');
  });

  /** A negative number is never an id, so it stays a number rather than
   * becoming `-"605..."`, which is not JSON at all. */
  it('leaves negative numbers alone', () => {
    const parsed = parseLegacyJson('{"a": -605724722902204416, "b": -3}') as Record<string, number>;
    expect(typeof parsed.a).toBe('number');
    expect(parsed.b).toBe(-3);
  });

  it('handles arrays and nesting', () => {
    const parsed = parseLegacyJson('{"ids": [605724722902204416, 2]}') as { ids: unknown[] };
    expect(parsed.ids).toEqual(['605724722902204416', 2]);
  });

  /** A corrupt file must still fail loudly rather than import as empty. */
  it('throws on malformed JSON, like JSON.parse', () => {
    expect(() => parseLegacyJson('{"a": }')).toThrow();
  });

  it('is idempotent over already-quoted ids', () => {
    const text = '{"creator": "291185187105275904"}';
    expect(quoteLongIntegers(text)).toBe(text);
  });
});
