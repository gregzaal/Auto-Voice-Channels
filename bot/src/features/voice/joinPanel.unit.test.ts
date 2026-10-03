import { describe, expect, it } from 'vitest';
import {
  alwaysId,
  ALWAYS_PREFIX,
  buildJoinRow,
  joinId,
  JOIN_PREFIX,
  parseAlwaysId,
  parseJoinId,
} from './joinPanel.js';

describe('joinPanel', () => {
  it('builds and round-trips the custom id', () => {
    const id = joinId('approve', 'join-1', 'user-9');
    expect(id).toBe(`${JOIN_PREFIX}approve:join-1:user-9`);
    expect(parseJoinId(id)).toEqual({
      action: 'approve',
      joinChannelId: 'join-1',
      requesterId: 'user-9',
    });
  });

  it('rejects foreign or malformed custom ids', () => {
    expect(parseJoinId('avc:kick:abc')).toBeNull();
    expect(parseJoinId(`${JOIN_PREFIX}bogus:join-1:user-9`)).toBeNull(); // bad action
    expect(parseJoinId(`${JOIN_PREFIX}deny:join-1:`)).toBeNull(); // missing requester
    expect(parseJoinId(`${JOIN_PREFIX}deny::user-9`)).toBeNull(); // missing channel
  });

  it('builds the Approve, Always allow, Deny and Block buttons with matching ids', () => {
    const row = buildJoinRow('j', 'r').toJSON();
    const buttons = row.components as { custom_id: string; label: string }[];
    expect(buttons.map((c) => c.custom_id)).toEqual([
      joinId('approve', 'j', 'r'),
      alwaysId('j', 'r'),
      joinId('deny', 'j', 'r'),
      joinId('block', 'j', 'r'),
    ]);
    expect(buttons.map((c) => c.label)).toEqual(['Approve', 'Always allow', 'Deny', 'Block']);
    // A card nobody can press is the failure to rule out: nothing is disabled.
    expect(JSON.stringify(row)).not.toContain('"disabled":true');
  });

  /**
   * The three ids an older instance already handles are untouched, byte for byte: a
   * card posted before this button, and an older instance answering a card posted after.
   */
  it('keeps the three older ids exactly as they were', () => {
    expect(joinId('approve', 'join-1', 'user-9')).toBe('avc:join:approve:join-1:user-9');
    expect(joinId('deny', 'join-1', 'user-9')).toBe('avc:join:deny:join-1:user-9');
    expect(joinId('block', 'join-1', 'user-9')).toBe('avc:join:block:join-1:user-9');
  });

  describe('Always allow', () => {
    it('has its own prefix, which an older instance answers as out of date', () => {
      expect(ALWAYS_PREFIX).toBe('avc:always:');
      // Not under `avc:join:`, where an older instance would drop an unknown action
      // without a word.
      expect(alwaysId('join-1', 'user-9').startsWith(JOIN_PREFIX)).toBe(false);
      expect(alwaysId('join-1', 'user-9')).toBe('avc:always:join-1:user-9');
    });

    it('round-trips', () => {
      expect(parseAlwaysId(alwaysId('join-1', 'user-9'))).toEqual({
        joinChannelId: 'join-1',
        requesterId: 'user-9',
      });
    });

    it('is never read as one of the three, and they are never read as it', () => {
      expect(parseJoinId(alwaysId('join-1', 'user-9'))).toBeNull();
      expect(parseAlwaysId(joinId('approve', 'join-1', 'user-9'))).toBeNull();
    });

    it('rejects foreign or malformed custom ids', () => {
      expect(parseAlwaysId('avc:kick:abc')).toBeNull();
      expect(parseAlwaysId(`${ALWAYS_PREFIX}join-1:`)).toBeNull(); // missing requester
      expect(parseAlwaysId(`${ALWAYS_PREFIX}:user-9`)).toBeNull(); // missing channel
      expect(parseAlwaysId(`${ALWAYS_PREFIX}a:b:c`)).toBeNull(); // trailing junk
      expect(parseAlwaysId(ALWAYS_PREFIX)).toBeNull();
    });
  });
});
