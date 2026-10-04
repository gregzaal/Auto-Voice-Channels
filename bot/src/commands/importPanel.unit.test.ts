import { describe, expect, it } from 'vitest';
import {
  AVC_EXPORT_VERSION,
  diffGuildConfig,
  EXPORT_SETTINGS_KEYS,
  fromNativeFile,
  type ChannelChange,
  type GuildConfigFile,
  type ImportNote,
  type ImportPlan,
  type SettingChange,
} from '@avc/core';
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
const GUILD = '100000000000000001';
const NICK_USER = '222222222222222222';
const RESTRICTED_USER = '333333333333333333';
const RESTRICTED_ROLE = '444444444444444444';
const OTHER_USER = '555555555555555555';

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

  /** Four note labels contain the product name, and it was being lowercased. */
  it('does not lowercase the product name', () => {
    const text = renderPreview(
      plan({
        notes: [
          {
            code: 'channel_cannot_rename',
            severity: 'dropped',
            subject: '1',
            name: 'Lobby',
          },
          { code: 'automation_switched_off', severity: 'warning', subject: 'enabled' },
        ],
      }),
      ctx,
    );
    expect(text).toContain('AVC');
    expect(text).not.toContain('avc cannot');
    expect(text).not.toContain('turns avc off');
  });

  /** A whole-import warning must not be prefixed with the guild's own id. */
  it('does not prefix a whole-import warning with a snowflake', () => {
    const text = renderPreview(
      plan({
        notes: [
          {
            code: 'other_bot_may_be_present',
            severity: 'warning',
            subject: '460459401086763010',
          },
        ],
      }),
      ctx,
    );
    expect(text).not.toContain('460459401086763010:');
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
   * The same setting decides who sees a hidden room, so an import that changes it must say
   * so, in the preview and in the announcement an admin reads before anything is written.
   */
  it('says the moderator role also sees hidden rooms, wherever the import names it', () => {
    const change = setting({
      key: 'text_channel_role',
      before: undefined,
      after: '666666666666666666',
    });
    const preview = renderPreview(plan({ settingChanges: [change] }), ctx);
    expect(JSON.stringify(preview)).toContain(
      'Role that can read room text channels and see hidden rooms',
    );
    const announced = renderAnnouncement(plan({ settingChanges: [change] }), ctx);
    expect(announced).toContain('Role that can read room text channels and see hidden rooms');
  });

  /**
   * The same assertion for the other key that holds member ids. Every shape a
   * `command_access` change can take, on both surfaces that reach more than the
   * admin who ran the command.
   */
  it('emits no restricted member or role id for a command_access change, only a count', () => {
    const before = {
      rename: {
        allow: { roles: [RESTRICTED_ROLE] },
        deny: { users: [NICK_USER, RESTRICTED_USER] },
      },
    };
    const after = {
      nick: { deny: { users: [OTHER_USER] } },
      kick: { allow: { users: [NICK_USER] } },
    };
    for (const change of [
      setting({
        key: 'command_access',
        before,
        after,
        entriesAdded: ['nick'],
        entriesRemoved: ['rename'],
      }),
      setting({ key: 'command_access', before: undefined, after, entriesAdded: ['nick'] }),
      setting({
        key: 'command_access',
        before,
        after: undefined,
        cleared: true,
        entriesRemoved: [],
      }),
      setting({
        key: 'command_access',
        before,
        after: { rename: { deny: { users: [OTHER_USER] } } },
        entriesChanged: ['rename'],
      }),
    ]) {
      for (const text of [
        renderAnnouncement(plan({ settingChanges: [change] }), ctx),
        renderPreview(plan({ settingChanges: [change] }), ctx),
      ]) {
        for (const id of [NICK_USER, RESTRICTED_USER, RESTRICTED_ROLE, OTHER_USER]) {
          expect(text).not.toContain(id);
        }
        expect(text).toContain('Who can use room commands');
        expect(text).toMatch(/\d (allow|deny) rules?|none/);
        assertCopyRules(text);
      }
    }
  });

  it('counts the people and roles a command_access change restricts, not its features', () => {
    const text = renderAnnouncement(
      plan({
        settingChanges: [
          setting({
            key: 'command_access',
            before: {
              rename: { deny: { users: [NICK_USER, RESTRICTED_USER], roles: [RESTRICTED_ROLE] } },
            },
            after: {
              rename: { deny: { users: [OTHER_USER] } },
              nick: { deny: { users: [NICK_USER] } },
            },
            entriesAdded: ['nick'],
            entriesChanged: ['rename'],
          }),
        ],
      }),
      ctx,
    );
    expect(text).toContain('Who can use room commands: 2 deny rules (was 3 deny rules)');
  });

  /** Both lists are counted, each on its own, and neither names anybody. */
  it('counts the allow lists and the deny lists apart', () => {
    const text = renderAnnouncement(
      plan({
        settingChanges: [
          setting({
            key: 'command_access',
            before: undefined,
            after: {
              rename: { allow: { roles: [RESTRICTED_ROLE] }, deny: { users: [NICK_USER] } },
              kick: { allow: { users: [OTHER_USER, RESTRICTED_USER] } },
            },
            entriesAdded: ['rename', 'kick'],
          }),
        ],
      }),
      ctx,
    );
    expect(text).toContain('Who can use room commands: 3 allow rules and 1 deny rule (was none)');
    for (const id of [NICK_USER, RESTRICTED_USER, RESTRICTED_ROLE, OTHER_USER]) {
      expect(text).not.toContain(id);
    }
  });

  it('says how many restrictions an import removes, and not whose', () => {
    const text = renderAnnouncement(
      plan({
        settingChanges: [
          setting({
            key: 'command_access',
            before: {
              rename: { deny: { users: [NICK_USER, RESTRICTED_USER] } },
              nick: { deny: { roles: [RESTRICTED_ROLE] } },
            },
            after: { nick: { deny: { roles: [RESTRICTED_ROLE] } } },
            entriesRemoved: ['rename'],
          }),
        ],
      }),
      ctx,
    );
    expect(text).toContain('2 deny rules on room commands');
    expect(text).not.toContain(RESTRICTED_USER);
  });

  /**
   * A file whose `command_access` is null clears every restriction, and the diff reports that
   * as a cleared change with no entries. Built through the real diff, because a hand-built
   * change decides its own `entriesRemoved` and never takes this path.
   */
  it('lists a file that clears every restriction under Removed, from the real diff', () => {
    const stored = {
      rename: { deny: { users: [NICK_USER, RESTRICTED_USER] } },
      nick: { allow: { roles: [RESTRICTED_ROLE] } },
    };
    const settings = Object.fromEntries(
      EXPORT_SETTINGS_KEYS.map((key) => [key, null]),
    ) as GuildConfigFile['settings'];
    const file: GuildConfigFile = {
      avc_export_version: AVC_EXPORT_VERSION,
      exported_at: '2026-10-04T12:00:00.000Z',
      guild_id: GUILD,
      guild_name: 'Example server',
      source_application_id: null,
      source_fleet_channel_scope: null,
      settings,
      creator_channels: [],
      adopted_channels: [],
    };
    const result = diffGuildConfig(
      fromNativeFile(file),
      { settings: { command_access: stored }, creatorChannels: [], adoptedChannels: [] },
      {
        guildId: GUILD,
        channels: new Map([
          [
            '999999999999999999',
            { name: 'Lobby', kind: 'voice', botCanManage: true, botCanRename: true },
          ],
        ]),
        members: new Map(),
        foreignFleetChannels: new Map(),
        applicationId: null,
        otherFleetsPresent: [],
        actorId: ACTOR,
      },
    );
    if (!result.ok) throw new Error('expected a plan');
    const change = result.plan.settingChanges.find((c) => c.key === 'command_access');
    expect(change?.cleared).toBe(true);

    for (const text of [renderPreview(result.plan, ctx), renderAnnouncement(result.plan, ctx)]) {
      expect(text).toContain(
        'Who can use room commands: cleared (1 allow rule and 2 deny rules removed)',
      );
      expect(text).toContain('Removed');
      expect(text).toContain('1 allow rule and 2 deny rules on room commands');
      for (const id of [NICK_USER, RESTRICTED_USER, RESTRICTED_ROLE]) {
        expect(text).not.toContain(id);
      }
    }
  });

  /**
   * The words a server blocks may be slurs, and the announcement is public, so every surface
   * that prints a `blocked_words` change prints a count. The plan file is the runner's own,
   * and counts too: a word nobody needs to read is one nobody is shown.
   */
  describe('blocked_words', () => {
    const SLUR = 'zzslurzz';
    const OTHER = 'qqworseqq';
    const surfaces = (change: SettingChange): string[] => [
      renderAnnouncement(plan({ settingChanges: [change] }), ctx),
      renderPreview(plan({ settingChanges: [change] }), ctx),
      renderPlanFile(plan({ settingChanges: [change] }), ctx),
    ];

    it('emits no blocked word for any shape of change, only a count', () => {
      for (const change of [
        setting({ key: 'blocked_words', before: undefined, after: [SLUR, `${OTHER}*`] }),
        setting({ key: 'blocked_words', before: [SLUR], after: [OTHER] }),
        setting({ key: 'blocked_words', before: [SLUR, OTHER], after: undefined, cleared: true }),
      ]) {
        for (const text of surfaces(change)) {
          expect(text).not.toContain(SLUR);
          expect(text).not.toContain(OTHER);
          expect(text).toContain('Blocked words');
          assertCopyRules(text);
        }
      }
    });

    it('says how many words there are, and were', () => {
      const [announced] = surfaces(
        setting({ key: 'blocked_words', before: [SLUR], after: [SLUR, OTHER, 'x'] }),
      );
      expect(announced).toContain('Blocked words: 3 words (was 1 word)');
      const [added] = surfaces(setting({ key: 'blocked_words', before: undefined, after: [SLUR] }));
      expect(added).toContain('Blocked words: 1 word (was none)');
    });

    it('lists the words an import stops blocking under Removed, as a count', () => {
      const [replaced] = surfaces(
        setting({ key: 'blocked_words', before: [SLUR, OTHER, 'keep'], after: ['KEEP', 'new'] }),
      );
      expect(replaced).toContain('Removed');
      expect(replaced).toContain('2 blocked words');
      const [cleared] = surfaces(
        setting({ key: 'blocked_words', before: [SLUR], after: undefined, cleared: true }),
      );
      expect(cleared).toContain('Blocked words: cleared (1 word removed)');
      expect(cleared).toContain('1 blocked word');
    });
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

/**
 * The old per-command role rule has an answer, so the admin is told what it is
 * rather than only that the setting is gone, and every other dropped field keeps
 * the generic wording. That includes `requiredrole`, which the old bot never read
 * and which sits, empty, in nearly every legacy file.
 */
describe('a legacy import that drops the old role rule', () => {
  const legacyPlan = (): ImportPlan =>
    plan({
      source: 'legacy',
      notes: [
        { code: 'legacy_restriction_replaced', severity: 'warning', subject: 'restrictions' },
        { code: 'legacy_field_dropped', severity: 'warning', subject: 'requiredrole' },
        { code: 'legacy_field_dropped', severity: 'warning', subject: 'prefix' },
      ],
    });

  /**
   * The old rule was an allow list (only these roles may use a command), and so is
   * `/restrict allow`, so the sentence points there. It still says the rule was not
   * carried over, or an admin who relied on it is left believing nothing changed.
   */
  it('points at /restrict allow, says it works the same way, and says the rule was not carried over', () => {
    const text = renderPreview(legacyPlan(), { ...ctx, source: 'legacy' });
    expect(text).toContain(
      'restrictions: was an old rule that let only certain roles use a command, and it was not carried over',
    );
    expect(text).toContain(
      '/restrict allow works the same way: it keeps a room command to the people and roles you name',
    );
    expect(text).not.toContain('the other way round');
    expect(text).not.toContain('is the replacement');
  });

  it('does not call it an old setting AVC no longer has, and leaves the rest alone', () => {
    const lines = renderPreview(legacyPlan(), { ...ctx, source: 'legacy' }).split('\n');
    const line = (subject: string) => lines.find((l) => l.includes(`${subject}: `)) ?? '';
    expect(line('restrictions')).not.toContain('no longer has');
    expect(line('requiredrole')).toContain('is an old setting AVC no longer has');
    expect(line('requiredrole')).not.toContain('/restrict');
    expect(line('prefix')).toContain('is an old setting AVC no longer has');
  });

  it('obeys the copy rules in the preview, the announcement and the attached plan', () => {
    const c = { ...ctx, source: 'legacy' as const };
    assertCopyRules(renderPreview(legacyPlan(), c));
    assertCopyRules(renderAnnouncement(legacyPlan(), c));
    assertCopyRules(renderPlanFile(legacyPlan(), c));
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
    expect(destructiveCount(fresh)).toEqual({ replaced: 0, removed: 0 });
    expect(confirmLabel({ replaced: 0, removed: 0 })).toBe('Apply this configuration');
  });

  it('counts overwritten settings and replaced channels separately from removals', () => {
    const heavy = plan({
      settingChanges: [setting(), setting({ key: 'aliases', before: undefined, after: {} })],
      creatorChanges: [channel('1'), channel('2', { action: 'remove' })],
      adoptedChanges: [channel('3', { action: 'adopt' })],
    });
    // One setting had a stored value, one channel is replaced, one is removed.
    expect(destructiveCount(heavy)).toEqual({ replaced: 2, removed: 1 });
  });

  /**
   * The split matters: a plan whose only destructive act is a deletion read
   * "Replace 2 things" on the control authorising it, and nothing else in the
   * product can put a removed creator channel back.
   */
  it('names a removal as a removal', () => {
    expect(confirmLabel({ replaced: 0, removed: 2 })).toBe('remove 2');
    expect(confirmLabel({ replaced: 3, removed: 2 })).toBe('Replace 3, remove 2');
    expect(confirmLabel({ replaced: 3, removed: 0 })).toBe('Replace 3');
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
