import { describe, expect, it } from 'vitest';
import { secondaryStateSchema } from './secondaryChannels.js';

describe('secondaryStateSchema', () => {
  it('accepts an empty state and a fully-populated valid one', () => {
    expect(secondaryStateSchema.safeParse({}).success).toBe(true);
    const full = {
      name: '🐲 Greg’s den',
      status: 'Playing Blender',
      statusTemplate: 'Playing @@game_name@@',
      private: true,
      index: 0,
      template: '@@creator@@',
      seed: 12345,
      roster: ['u1', 'u2'],
      controlPanelMessageId: '1418271927263854593',
      controlPanelChannelId: '1418271927263854594',
    };
    expect(secondaryStateSchema.safeParse(full).success).toBe(true);
  });

  it('rejects constraint violations the DB could otherwise round-trip', () => {
    expect(secondaryStateSchema.safeParse({ index: -1 }).success).toBe(false); // min(0)
    expect(secondaryStateSchema.safeParse({ index: 1.5 }).success).toBe(false); // int
    expect(secondaryStateSchema.safeParse({ seed: 'x' }).success).toBe(false); // number
    expect(secondaryStateSchema.safeParse({ roster: [1, 2] }).success).toBe(false); // string[]
    expect(secondaryStateSchema.safeParse({ private: 'yes' }).success).toBe(false);
    // A snowflake written as a number is how the legacy dump stored one, and
    // every row read in the guild parses through this schema, so one bad value
    // would block the whole list rather than the one room it belongs to.
    expect(secondaryStateSchema.safeParse({ controlPanelMessageId: 123 }).success).toBe(false);
    expect(secondaryStateSchema.safeParse({ controlPanelChannelId: 123 }).success).toBe(false); // boolean
  });
});
