import { describe, expect, it } from 'vitest';
import { buildJoinRow, joinId, JOIN_PREFIX, parseJoinId } from './joinPanel.js';

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

  it('builds the three Approve/Deny/Block buttons with matching ids', () => {
    const row = buildJoinRow('j', 'r').toJSON();
    const ids = (row.components as { custom_id: string }[]).map((c) => c.custom_id);
    expect(ids).toEqual([
      joinId('approve', 'j', 'r'),
      joinId('deny', 'j', 'r'),
      joinId('block', 'j', 'r'),
    ]);
  });
});
