import { ActivityType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { gameSignature } from './gateway.js';

const playing = (name: string, extra: Record<string, unknown> = {}) => ({
  type: ActivityType.Playing,
  name,
  ...extra,
});
const custom = (name: string) => ({ type: ActivityType.Custom, name });
const streaming = (name: string) => ({ type: ActivityType.Streaming, name });

describe('gameSignature', () => {
  it('is empty for no presence', () => {
    expect(gameSignature(null)).toBe('');
    expect(gameSignature({ activities: [] })).toBe('');
  });

  it('ignores status and custom-status changes (the common churn)', () => {
    const a = gameSignature({ activities: [playing('Blender'), custom('hello')] });
    const b = gameSignature({ activities: [playing('Blender'), custom('a new status')] });
    expect(a).toBe(b);
  });

  it('changes when the played game changes', () => {
    const a = gameSignature({ activities: [playing('Blender')] });
    const b = gameSignature({ activities: [] });
    const c = gameSignature({ activities: [playing('Halo')] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('changes when party size, state, or streaming changes', () => {
    const base = gameSignature({ activities: [playing('X', { party: { size: [2, 4] } })] });
    expect(gameSignature({ activities: [playing('X', { party: { size: [3, 4] } })] })).not.toBe(
      base,
    );
    expect(gameSignature({ activities: [playing('X', { state: 'Lobby' })] })).not.toBe(base);
    expect(gameSignature({ activities: [streaming('My Stream')] })).not.toBe(base);
  });
});
