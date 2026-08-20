import { describe, expect, it, vi } from 'vitest';
import {
  PermissionProblemTracker,
  permissionProblemMessage,
  permissionProblemSummary,
} from './permissionProblems.js';
import { problemNoticeBody } from '../../ops/permissionProblemNotifier.js';
import { buildLoggingModal } from '../../commands/loggingModal.js';
import { problemAlertConfirmation } from './guildSettings.js';

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

describe('PermissionProblemTracker hooks', () => {
  it('notifies on record, and on the last incident clearing', () => {
    const t = new PermissionProblemTracker();
    const recorded: string[] = [];
    const resolved: string[] = [];
    t.onRecord = (guildId) => recorded.push(guildId);
    t.onResolved = (guildId) => resolved.push(guildId);

    t.record('g', { channelId: 'a', operation: 'create', at: 1 });
    t.record('g', { channelId: 'b', operation: 'delete', at: 2 });
    expect(recorded).toEqual(['g', 'g']);

    // Still has 'b', so the guild is not resolved yet.
    t.clear('g', 'a');
    expect(resolved).toEqual([]);
    t.clear('g', 'b');
    expect(resolved).toEqual(['g']);
  });

  it('does not fire onResolved for a guild that had nothing', () => {
    const t = new PermissionProblemTracker();
    const resolved = vi.fn();
    t.onResolved = resolved;
    t.clear('never-had-a-problem', 'a');
    expect(resolved).not.toHaveBeenCalled();
  });

  it('contains a throwing hook, because record runs inside a per-guild catch', () => {
    const t = new PermissionProblemTracker();
    t.onRecord = () => {
      throw new Error('notifier exploded');
    };
    expect(() => t.record('g', { channelId: 'a', operation: 'create', at: 1 })).not.toThrow();
    // ...and the incident is still tracked, so /setup is unaffected.
    expect(t.recent('g')).toHaveLength(1);
  });
});

describe('permissionProblemMessage', () => {
  it('names the channel and the fix', () => {
    const msg = permissionProblemMessage('123');
    expect(msg).toContain('<#123>');
    expect(msg).toContain('View Channel');
    expect(msg).toContain('Manage Channels');
  });

  it('gives create failures the override advice, not the lost-access advice', () => {
    const msg = permissionProblemMessage('123', 'create');
    expect(msg).toContain('Manage Roles');
    expect(msg).toContain('/inheritpermissions');
    // The two failures share a Discord error code and nothing else. Naming the
    // wrong fix sent an admin to check four permissions they already had.
    expect(msg).not.toContain('lost access');
  });
});

const problem = (channelId: string, operation: 'create' | 'delete' = 'delete') => ({
  channelId,
  operation,
  at: 0,
});

describe('permissionProblemSummary', () => {
  it('splits creates, moves and lost access, one line each', () => {
    const lines = permissionProblemSummary([
      problem('a', 'create'),
      problem('b'),
      problem('c', 'move'),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('could not create rooms from <#a>');
    expect(lines[1]).toContain('made rooms from <#c>');
    expect(lines[2]).toContain('lost access to <#b>');
  });

  it('never describes a move failure as lost access', () => {
    // The channel named is the CREATOR channel, which just successfully made a
    // room, and nothing stopped being managed. Both other lines would be false.
    const line = permissionProblemSummary([problem('a', 'move')])[0]!;
    expect(line).not.toContain('lost access');
    expect(line).not.toContain('could not create');
    expect(line).toContain('Move Members');
  });

  it('emits only the line it has problems for', () => {
    expect(permissionProblemSummary([problem('a', 'create')])).toHaveLength(1);
    expect(permissionProblemSummary([problem('a')])).toHaveLength(1);
    expect(permissionProblemSummary([])).toEqual([]);
  });

  it('agrees with itself on singular and plural', () => {
    expect(permissionProblemSummary([problem('a')])[0]).toContain('stopped managing it');
    expect(permissionProblemSummary([problem('a'), problem('b')])[0]).toContain(
      'stopped managing them',
    );
  });

  it('says "at least" when it truncates, because the tracker truncated first', () => {
    const many = Array.from({ length: 9 }, (_, i) => problem(`c${i}`));
    const line = permissionProblemSummary(many)[0]!;
    expect(line).toContain('and at least 4 more');
    expect(line).toContain('<#c4>');
    expect(line).not.toContain('<#c5>');
  });
});

/** Every label and description the `/logging` panel renders. */
function loggingModalStrings(): string[] {
  const json = buildLoggingModal({
    enabled: true,
    level: 1,
    channelId: 'c',
    alerts: 'contact',
  }).toJSON().components as unknown as {
    label?: string;
    component?: { options?: { label: string; description?: string }[] };
  }[];
  const out: string[] = [];
  for (const label of json) {
    if (label.label) out.push(label.label);
    for (const o of label.component?.options ?? []) {
      out.push(o.label);
      if (o.description) out.push(o.description);
    }
  }
  return out;
}

/** The three confirmation replies `/logging` can produce, from the source of truth. */
function alertReplyLines(): string[] {
  return (['contact', 'quiet', 'off'] as const).map(problemAlertConfirmation);
}

/**
 * Mechanical guard for the user-facing copy rules (AGENTS.md), modelled on
 * `messages.unit.test.ts`. A hand-kept list of "strings that must stay clean"
 * rots; rendering every message and checking the characters does not.
 *
 * In scope because every string here is read by a server admin in Discord, and
 * AGENTS.md is explicit that the bot's own messages are covered, not just the
 * website. Code comments in these modules are NOT in scope and do use em dashes.
 */
describe('copy rules', () => {
  const everyMessage = (): string[] => [
    permissionProblemMessage('123'),
    permissionProblemMessage('123', 'create'),
    permissionProblemMessage('123', 'move'),
    ...permissionProblemSummary([
      problem('a', 'create'),
      problem('b'),
      problem('c'),
      problem('d', 'move'),
    ]),
    ...permissionProblemSummary(Array.from({ length: 9 }, (_, i) => problem(`c${i}`, 'create'))),
    problemNoticeBody(permissionProblemSummary([problem('a', 'create')]), 1, 'contact'),
    problemNoticeBody(permissionProblemSummary([problem('a')]), 1, 'quiet'),
    problemNoticeBody(permissionProblemSummary([problem('a')]), 4, 'contact'),
    // The `/logging` panel and the reply it produces are read by the same
    // admin, in the same sitting, as everything above.
    ...loggingModalStrings(),
    ...alertReplyLines(),
  ];

  it('uses no em or en dashes', () => {
    for (const msg of everyMessage()) expect(msg).not.toMatch(/[—–]/);
  });

  it('uses no curly quotes or apostrophes', () => {
    for (const msg of everyMessage()) expect(msg).not.toMatch(/[‘’“”]/);
  });

  it('uses no prose semicolons', () => {
    for (const msg of everyMessage()) expect(msg).not.toContain(';');
  });
});

describe('problemNoticeBody', () => {
  it('names the control while it is still going to repeat', () => {
    const body = problemNoticeBody(['something broke'], 1, 'contact');
    expect(body).toContain('/logging');
    expect(body).toContain('/setup');
  });

  it('does not offer to change who is mentioned when nobody is', () => {
    expect(problemNoticeBody(['something broke'], 1, 'quiet')).not.toContain('/logging');
  });

  it('says the last one is the last one, and only the last one', () => {
    // Four notices go out in total (one unconditional plus one per backoff
    // interval), so the third must not announce itself as the final word.
    expect(problemNoticeBody(['broke'], 3, 'contact')).not.toContain('last time');
    const body = problemNoticeBody(['broke'], 4, 'contact');
    expect(body).toContain('last time');
    // Silence must not be mistaken for the problem having gone away.
    expect(body).toContain('/setup');
  });
});
