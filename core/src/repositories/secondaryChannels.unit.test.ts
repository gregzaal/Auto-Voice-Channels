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
    };
    expect(secondaryStateSchema.safeParse(full).success).toBe(true);
  });

  it('rejects constraint violations the DB could otherwise round-trip', () => {
    expect(secondaryStateSchema.safeParse({ index: -1 }).success).toBe(false); // min(0)
    expect(secondaryStateSchema.safeParse({ index: 1.5 }).success).toBe(false); // int
    expect(secondaryStateSchema.safeParse({ seed: 'x' }).success).toBe(false); // number
    expect(secondaryStateSchema.safeParse({ roster: [1, 2] }).success).toBe(false); // string[]
    expect(secondaryStateSchema.safeParse({ private: 'yes' }).success).toBe(false); // boolean
  });
});
