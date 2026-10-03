import { describe, expect, it } from 'vitest';
import { secondaryChannelRowSchema, secondaryStateSchema } from './secondaryChannels.js';

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

describe('secondaryChannelRowSchema access', () => {
  const row = {
    channelId: 'c',
    guildId: 'g',
    primaryChannelId: 'p',
    ownerId: 'u1',
    originalCreator: 'u1',
    state: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('reads a room with no access record as null', () => {
    expect(secondaryChannelRowSchema.parse({ ...row, access: null }).access).toBeNull();
    // A row from before the column existed, or a hand-built fixture, omits it.
    expect(secondaryChannelRowSchema.parse(row).access).toBeNull();
  });

  it('reads a valid access record', () => {
    const access = { creatorId: 'u1', hidden: true, trusted: ['u2'] };
    expect(secondaryChannelRowSchema.parse({ ...row, access }).access).toEqual(access);
  });

  /**
   * The one that matters. This schema runs on every row of a guild listing, so
   * a throw here fails the whole guild over one room's blob. A newer build's
   * shape this one cannot read degrades to null and the rest of the row still
   * parses, state included.
   */
  it('reads a blob it cannot parse as null and still parses the rest of the row', () => {
    for (const access of ['hidden', 42, [], { hidden: 'yes' }, { trusted: [1] }]) {
      const parsed = secondaryChannelRowSchema.parse({ ...row, state: { seed: 3 }, access });
      expect(parsed.access, JSON.stringify(access)).toBeNull();
      expect(parsed.state.seed).toBe(3);
    }
  });
});
