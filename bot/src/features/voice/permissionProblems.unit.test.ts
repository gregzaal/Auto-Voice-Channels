import { describe, expect, it } from 'vitest';
import { PermissionProblemTracker, permissionProblemMessage } from './permissionProblems.js';

describe('PermissionProblemTracker', () => {
  it('records most-recent-first and de-dupes per channel', () => {
    const t = new PermissionProblemTracker();
    t.record('g', { channelId: 'a', operation: 'delete', at: 1 });
    t.record('g', { channelId: 'b', operation: 'delete', at: 2 });
    t.record('g', { channelId: 'a', operation: 'move', at: 3 }); // updates 'a', moves it to front

    const recent = t.recent('g');
    expect(recent.map((p) => p.channelId)).toEqual(['a', 'b']);
    expect(recent[0]).toMatchObject({ operation: 'move', at: 3 });
  });

  it('caps the list per guild', () => {
    const t = new PermissionProblemTracker();
    for (let i = 0; i < 15; i++) t.record('g', { channelId: `c${i}`, operation: 'delete', at: i });
    expect(t.recent('g')).toHaveLength(10);
    expect(t.recent('g')[0]!.channelId).toBe('c14'); // newest kept
  });

  it('clears a resolved channel and is isolated per guild', () => {
    const t = new PermissionProblemTracker();
    t.record('g1', { channelId: 'a', operation: 'delete', at: 1 });
    t.record('g2', { channelId: 'a', operation: 'delete', at: 1 });
    t.clear('g1', 'a');
    expect(t.recent('g1')).toEqual([]);
    expect(t.recent('g2')).toHaveLength(1);
  });
});

describe('permissionProblemMessage', () => {
  it('names the channel and the fix', () => {
    const msg = permissionProblemMessage('123');
    expect(msg).toContain('<#123>');
    expect(msg).toContain('View Channel');
    expect(msg).toContain('Manage Channels');
  });
});
