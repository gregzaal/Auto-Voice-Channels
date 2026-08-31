import { describe, expect, it } from 'vitest';
import type { ChannelChange, ImportNote, ImportPlan, SettingChange } from '@avc/core';
import {
  confirmLabel,
  destructiveCount,
  ImportSessionStore,
  renderAnnouncement,
  renderLogEntry,
  renderPlanFile,
  renderPreview,
  renderRefusals,
  type RenderContext,
} from './importPanel.js';

const ACTOR = '123456789012345678';
const NICK_USER = '222222222222222222';

const ctx: RenderContext = { actorId: ACTOR, fileName: 'avc-config.json', source: 'native' };

function plan(over: Partial<ImportPlan> = {}): ImportPlan {
  return {
    source: 'native',
    authoritative: true,
    settingsPatch: {},
    settingsRemove: [],
    creatorWrites: [],
    creatorRemovals: [],
    adoptedWrites: [],
    adoptedRemovals: [],
    settingChanges: [],
    creatorChanges: [],
    adoptedChanges: [],
    notes: [],
    changed: true,
    ...over,
  };
}

function setting(over: Partial<SettingChange> = {}): SettingChange {
  return {
    key: 'general',
    before: 'General',
    after: 'Voice',
    cleared: false,
    entriesAdded: [],
    entriesRemoved: [],
    entriesChanged: [],
    ...over,
  };
}

function channel(id: string, over: Partial<ChannelChange> = {}): ChannelChange {
  return { channelId: id, name: `channel-${id}`, action: 'update', fields: [], ...over };
}

/** A guild big enough to blow the message limit if a cap were missing. */
function bigPlan(): ImportPlan {
  const creatorChanges = Array.from({ length: 30 }, (_, i) =>
    channel(`${1000000000000000000 + i}`, {
      name: `a-rather-long-creator-channel-name-${i}`,
      fields: [
        { field: 'name', before: 'Room ##', after: '@@game_name@@ ##' },
        { field: 'limit', before: 0, after: 4 },
      ],
    }),
  );
  const removedAliases = Array.from({ length: 40 }, (_, i) => `A Game With A Long Name ${i}`);
  return plan({
    creatorChanges,
    creatorWrites: creatorChanges.map((c) => ({ channelId: c.channelId, template: {} })),
    settingChanges: [
      setting(),
      setting({ key: 'aliases', before: {}, after: {}, entriesRemoved: removedAliases }),
      setting({ key: 'channel_name_template', before: 'Room ##', after: '@@game_name@@ ##' }),
    ],
    notes: Array.from({ length: 25 }, (_, i) => ({
      code: 'channel_missing' as const,
      severity: 'dropped' as const,
      subject: `${2000000000000000000 + i}`,
      name: `a-vanished-channel-with-a-long-name-${i}`,
    })),
  });
}

/**
 * The copy rules, which apply to every string a user reads. Enforced here
 * because these are builder-adjacent literals with no other checker.
 */
function assertCopyRules(text: string): void {
  expect(text, 'no em or en dashes').not.toMatch(/[—–]/);
  expect(text, 'straight quotes only').not.toMatch(/[‘’“”]/);
  // No prose semicolons. A semicolon inside a code span would be fine, and
  // there are none here, so the flat rule is the honest one.
  expect(text, 'no prose semicolons').not.toContain(';');
}

describe('renderPreview', () => {
  it('stays inside the message limit for a large guild', () => {
    const text = renderPreview(bigPlan(), ctx);
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('obeys the copy rules', () => {
    assertCopyRules(renderPreview(bigPlan(), ctx));
    assertCopyRules(renderPreview(plan({ changed: false }), ctx));
  });

  it('says nothing would change, rather than showing an empty preview', () => {
    expect(renderPreview(plan({ changed: false }), ctx)).toContain('Nothing would change');
  });

  /** The hard requirement: removals are visible before the button is pressed. */
  it('lists removed entries by name, with an honest tail', () => {
    const text = renderPreview(bigPlan(), ctx);
    expect(text).toContain('A Game With A Long Name 0');
    expect(text).toMatch(/and \d+ more/);
  });

  it('names the state an import never touches', () => {
    expect(renderPreview(bigPlan(), ctx)).toContain('Subscription and trial state: unchanged');
  });

  it('tells the admin the preview expires and that re-uploading is safe', () => {
    const text = renderPreview(bigPlan(), ctx);
    expect(text).toContain('15 minutes');
    expect(text).toContain('Re-uploading');
  });
});

describe('renderAnnouncement', () => {
  it('stays inside the message limit for a large guild', () => {
    expect(renderAnnouncement(bigPlan(), ctx).length).toBeLessThanOrEqual(2000);
  });

  it('obeys the copy rules', () => {
    assertCopyRules(renderAnnouncement(bigPlan(), ctx));
  });

  /**
   * The mandatory assertion. `custom_nicks` entries are names members chose for
   * themselves, and the system channel is general chat in most servers.
   */
  it('emits no member nickname and no member id, only a count', () => {
    const withNicks = plan({
      settingChanges: [
        setting({
          key: 'custom_nicks',
          before: { [NICK_USER]: 'Greg' },
          after: {},
          entriesRemoved: [NICK_USER],
        }),
      ],
    });
    const text = renderAnnouncement(withNicks, ctx);
    expect(text).not.toContain(NICK_USER);
    expect(text).not.toContain('Greg');
    expect(text).toContain('1 member nicknames');
  });

  /**
   * Channels as `<#id>`, never as a name string: a mention renders as
   * unresolvable to a viewer without access, while a name discloses a
   * staff-only channel to everyone who can read the system channel.
   */
  it('renders channels as mentions rather than names', () => {
    const text = renderAnnouncement(
      plan({ creatorChanges: [channel('345678901234567890', { name: 'secret-staff-room' })] }),
      ctx,
    );
    expect(text).toContain('<#345678901234567890>');
    expect(text).not.toContain('secret-staff-room');
  });

  it('mentions the actor so people know who to ask', () => {
    expect(renderAnnouncement(bigPlan(), ctx)).toContain(`<@${ACTOR}>`);
  });

  /** The write order puts the announcement before the reply, so it cannot refer to it. */
  it('never mentions the rollback file', () => {
    const text = renderAnnouncement(bigPlan(), ctx).toLowerCase();
    expect(text).not.toContain('rollback');
    expect(text).not.toContain('attached');
    expect(text).not.toContain('undo');
  });

  it('says the state an import never changes', () => {
    expect(renderAnnouncement(bigPlan(), ctx)).toContain('an import never changes it');
  });

  it('warns in its own line when the file switched automation off', () => {
    const text = renderAnnouncement(
      plan({
        notes: [{ code: 'automation_switched_off', severity: 'warning', subject: 'enabled' }],
      }),
      ctx,
    );
    expect(text).toContain('turned AVC off');
  });

  it('warns that open setup panels are stale', () => {
    expect(renderAnnouncement(bigPlan(), ctx)).toContain('out of date');
  });
});

describe('renderLogEntry and renderPlanFile', () => {
  it('caps the log entry like everything else outbound', () => {
    const text = renderLogEntry(bigPlan(), ctx);
    expect(text.length).toBeLessThanOrEqual(2000);
    assertCopyRules(text);
  });

  /** The attachment is the record, so it names everything and is not capped. */
  it('lists every removal in the attached plan', () => {
    const text = renderPlanFile(bigPlan(), ctx);
    expect(text).toContain('A Game With A Long Name 39');
    expect(text).toContain('NEVER TOUCHED BY AN IMPORT');
  });
});

describe('renderRefusals', () => {
  it('names both servers on a guild mismatch and points at the alternative', () => {
    const notes: ImportNote[] = [
      {
        code: 'file_guild_mismatch',
        severity: 'refusal',
        subject: '460459401086763010',
        other: '111111111111111111',
      },
    ];
    const text = renderRefusals(notes);
    expect(text).toContain('460459401086763010');
    expect(text).toContain('111111111111111111');
    expect(text).toContain('/template');
    assertCopyRules(text);
  });

  it('tells the admin to wait when the server is still loading', () => {
    const text = renderRefusals([
      { code: 'guild_not_hydrated', severity: 'refusal', subject: 'g' },
    ]);
    expect(text).toContain('still loading');
  });

  it('quotes the limit that was exceeded', () => {
    const text = renderRefusals([
      {
        code: 'too_many_creator_channels',
        severity: 'refusal',
        subject: 'creator_channels',
        count: 51,
        limit: 50,
      },
    ]);
    expect(text).toContain('51');
    expect(text).toContain('50');
  });
});

describe('confirmLabel and destructiveCount', () => {
  /** Proportional: a guild with nothing stored is not destroying anything. */
  it('does not pretend a first-time import is destructive', () => {
    const fresh = plan({ creatorChanges: [channel('1', { action: 'adopt' })] });
    expect(destructiveCount(fresh)).toBe(0);
    expect(confirmLabel(0)).toBe('Apply this configuration');
  });

  it('counts overwritten settings and replaced or removed channels', () => {
    const heavy = plan({
      settingChanges: [setting(), setting({ key: 'aliases', before: undefined, after: {} })],
      creatorChanges: [channel('1'), channel('2', { action: 'remove' })],
      adoptedChanges: [channel('3', { action: 'adopt' })],
    });
    // One setting had a stored value, two channels were replaced or removed.
    expect(destructiveCount(heavy)).toBe(3);
    expect(confirmLabel(3)).toBe('Replace 3 things');
    expect(confirmLabel(1)).toBe('Replace 1 thing');
  });
});

describe('ImportSessionStore', () => {
  const session = (guildId: string) => ({
    guildId,
    userId: ACTOR,
    plan: plan(),
    fileName: 'a.json',
    fileSize: 100,
    createdAt: 0,
  });

  function store(now: () => number) {
    return new ImportSessionStore({ ttlMs: 1000, perGuild: 2, perInstance: 3, now });
  }

  it('reports the held bytes, not just a count', () => {
    const s = store(() => 0);
    s.put('a', { ...session('g1'), fileSize: 1000 });
    s.put('b', { ...session('g2'), fileSize: 2400 });
    expect(s.stats()).toMatchObject({ sessions: 2, heldBytesEstimate: 3400 });
  });

  it('holds a session and hands it back once', () => {
    const s = store(() => 0);
    expect(s.put('a', session('g1'))).toEqual({ ok: true });
    expect(s.claim('a')?.guildId).toBe('g1');
    // Claim by delete, so a second confirm click cannot apply the same plan.
    expect(s.claim('a')).toBeUndefined();
  });

  /**
   * The distinction that matters after a second click: "already ran" and
   * "expired" call for completely different copy in a flow that contemplates
   * partial applies.
   */
  it('remembers that a claimed session was applied', () => {
    const s = store(() => 0);
    s.put('a', session('g1'));
    s.claim('a');
    expect(s.wasApplied('a')).toBe(true);
    expect(s.wasApplied('never-existed')).toBe(false);
  });

  it('refuses past the per-guild cap, and says which cap', () => {
    const s = store(() => 0);
    s.put('a', session('g1'));
    s.put('b', session('g1'));
    expect(s.put('c', session('g1'))).toMatchObject({ ok: false, reason: 'per_guild', limit: 2 });
    // A different guild still fits, up to the instance cap.
    expect(s.put('d', session('g2'))).toEqual({ ok: true });
  });

  it('refuses past the per-instance cap', () => {
    const s = store(() => 0);
    s.put('a', session('g1'));
    s.put('b', session('g2'));
    s.put('c', session('g3'));
    expect(s.put('d', session('g4'))).toMatchObject({ ok: false, reason: 'per_instance' });
  });

  /**
   * A cap, not just a TTL. Pruning alone removes only what has already expired,
   * and an admin can upload far faster than the TTL.
   */
  it('frees slots once sessions expire', () => {
    let clock = 0;
    const s = store(() => clock);
    s.put('a', session('g1'));
    s.put('b', session('g1'));
    expect(s.put('c', session('g1')).ok).toBe(false);
    clock = 2000;
    expect(s.put('c', session('g1'))).toEqual({ ok: true });
  });

  it('frees the slot on cancel without marking it applied', () => {
    const s = store(() => 0);
    s.put('a', session('g1'));
    s.drop('a');
    expect(s.wasApplied('a')).toBe(false);
    expect(s.claim('a')).toBeUndefined();
  });

  it('reports what it holds, for diagnostics', () => {
    const s = store(() => 0);
    s.put('a', session('g1'));
    s.put('b', session('g1'));
    expect(s.stats()).toMatchObject({ sessions: 2, byGuildMax: 2 });
  });
});
