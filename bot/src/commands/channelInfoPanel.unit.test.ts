import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AT_TOKENS, CONDITION_VARIABLES, NUMBER_TOKENS } from '../features/voice/nameTemplate.js';
import type { ChannelInfo, RenderContext, VoiceMember } from '../features/voice/index.js';
import {
  BOOLEAN_VARIABLES,
  buildChannelInfoPanel,
  buildChannelInfoView,
  buildScenarioPanel,
  buildTokenPanel,
  CHANNELINFO_PREFIX,
  EXCLUDED_TOKENS,
  infoId,
  LIST_VARIABLES,
  parseInfoId,
  TOKEN_PROBES,
  VALUE_VARIABLES,
  type ChannelInfoPanelInput,
} from './channelInfoPanel.js';

const CHANNEL = '460459401086763012';

function member(id: string, displayName: string, over: Partial<VoiceMember> = {}): VoiceMember {
  return { id, displayName, bot: false, playing: [], ...over };
}

const OWNER = member('u1', 'Robin', {
  playing: ['Deep Rock Galactic'],
  activities: [
    {
      kind: 'playing',
      name: 'Deep Rock Galactic',
      state: 'Hazard 5',
      details: 'Salvage',
      party: { id: 'p1', size: [3, 4] },
    },
  ],
  roleIds: ['r1'],
});

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return {
    index: 1,
    members: [OWNER, member('u2', 'Sam')],
    aliases: { 'Deep Rock Galactic': 'DRG' },
    general: 'General',
    creatorName: 'Robin',
    creator: OWNER,
    userLimit: 4,
    isPrivate: false,
    seed: 4,
    numberOffset: 0,
    ...over,
  };
}

function info(over: Partial<ChannelInfo> = {}): ChannelInfo {
  return {
    channelId: CHANNEL,
    kind: 'room',
    render: {
      ctx: ctx(),
      synthetic: false,
      nameTemplate: '## @@game_name@@',
      nameSource: 'creator',
      statusTemplate: '',
      statusSource: 'server',
    },
    ownerId: 'u1',
    originalCreator: 'u1',
    seed: 4,
    index: 1,
    userLimit: 4,
    isPrivate: false,
    accessMode: 'public',
    members: { total: 2, bots: 0 },
    game: 'DRG',
    rawGames: ['Deep Rock Galactic'],
    general: 'General',
    enabled: true,
    aliasCount: 1,
    ...over,
  };
}

function input(over: Partial<ChannelInfoPanelInput> = {}): ChannelInfoPanelInput {
  return {
    info: info(),
    currentName: '#2 DRG',
    isAdmin: false,
    botPermissions: {},
    problems: [],
    ...over,
  };
}

/** Every field value across every embed in a reply, for the length checks. */
function fieldValues(reply: ReturnType<typeof buildChannelInfoPanel>): string[] {
  return (reply.embeds ?? []).flatMap((e) =>
    ((e as { fields?: { value: string }[] }).fields ?? []).map((f) => f.value),
  );
}

function text(reply: ReturnType<typeof buildChannelInfoPanel>): string {
  return JSON.stringify(reply);
}

describe('the readout covers the engine vocabulary', () => {
  /**
   * The whole point of probing rather than re-deriving is that the readout
   * cannot report a value the engine disagrees with. It can still fall SILENT
   * on a token the engine gains later, which this catches, in the same shape as
   * `systemPrompt.unit.test.ts`.
   */
  it('lists or excuses every @@token@@', () => {
    for (const token of AT_TOKENS) {
      expect(
        TOKEN_PROBES.includes(token) || token in EXCLUDED_TOKENS,
        `${token} is neither shown by /channelinfo nor excluded with a reason`,
      ).toBe(true);
    }
  });

  it('lists or excuses every number token', () => {
    for (const token of NUMBER_TOKENS) {
      expect(
        TOKEN_PROBES.includes(token) || token in EXCLUDED_TOKENS,
        `${token} is neither shown by /channelinfo nor excluded with a reason`,
      ).toBe(true);
    }
  });

  it('sorts every condition variable into exactly one bucket', () => {
    for (const name of CONDITION_VARIABLES) {
      const buckets = [
        name in VALUE_VARIABLES,
        BOOLEAN_VARIABLES.includes(name),
        LIST_VARIABLES.includes(name),
      ].filter(Boolean);
      expect(buckets.length, `${name} belongs to ${buckets.length} buckets, want exactly 1`).toBe(
        1,
      );
    }
  });

  it('excludes nothing it also shows', () => {
    for (const token of TOKEN_PROBES) expect(token in EXCLUDED_TOKENS).toBe(false);
  });
});

/**
 * Binds this file to `VoiceFeature.buildRenderContext` the way
 * `renderContextGuard.unit.test.ts` binds `handler.ts`.
 *
 * That guard reads `handler.ts` alone, so a panel that assembled its own
 * context would be invisible to the test whose entire purpose is preventing
 * exactly that. Every render here must use the `ctx` it was handed.
 */
describe('the panel never assembles a render context', () => {
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'channelInfoPanel.ts'),
    'utf8',
  );

  it('found the render call sites', () => {
    expect([...SOURCE.matchAll(/(?<![A-Za-z])renderChannelName\(/g)].length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('passes only the context it was given', () => {
    for (const match of SOURCE.matchAll(/(?<![A-Za-z])renderChannelName\(([^)]*)\)/g)) {
      const args = match[1]!.split(',').map((a) => a.trim());
      expect(args[1], `renderChannelName called with a context other than ctx: ${match[0]}`).toBe(
        'ctx',
      );
    }
  });

  /**
   * The name check above is defeated by naming a local `ctx`, so these two check
   * PROVENANCE rather than the identifier:
   *
   * ```ts
   * const ctx: RenderContext = { index: 0, members: [], … };  // both catch it
   * ```
   *
   * A context reaches this module as a parameter, never as an annotation on a
   * local and never as a literal. `renderPair`'s scenario contexts come from
   * `previewScenarios`, which is the one deliberate exception and is named here
   * the way `renderContextGuard.unit.test.ts` names its own.
   */
  it('declares no RenderContext of its own', () => {
    expect(SOURCE.includes(': RenderContext = ')).toBe(false);
  });

  it('builds no object that looks like a context', () => {
    const literals = [...SOURCE.matchAll(/\{[^{}]*\bindex:[^{}]*\}/g)].filter((m) =>
      m[0].includes('members:'),
    );
    expect(literals.map((m) => m[0])).toEqual([]);
  });

  it('renders against a fixture context only through previewScenarios', () => {
    for (const match of SOURCE.matchAll(/(?<![A-Za-z])renderPair\(([^)]*)\)/g)) {
      const args = match[1]!.split(',').map((a) => a.trim());
      expect(args[2], `renderPair called with something other than a scenario: ${match[0]}`).toBe(
        's.ctx',
      );
    }
    expect(SOURCE).toContain('previewScenarios({');
  });
});

describe('buildChannelInfoPanel', () => {
  it('names the owner and the original creator when they differ', () => {
    const reply = buildChannelInfoPanel(
      input({ info: info({ ownerId: 'u2', originalCreator: 'u1' }) }),
    );
    expect(text(reply)).toContain('<@u2>');
    expect(text(reply)).toContain('/reclaim');
  });

  it('says the name is up to date when the render matches', () => {
    expect(text(buildChannelInfoPanel(input({ currentName: '#2 DRG' })))).toContain('up to date');
  });

  /**
   * The single most useful line in the panel. A correct template with a stale
   * name is the expected steady state for a busy room, not a fault, and saying
   * so is what stops it being reported as one.
   */
  it('explains a rendered name that has not landed yet', () => {
    const reply = buildChannelInfoPanel(input({ currentName: 'old name' }));
    expect(text(reply)).toContain('old name');
    expect(text(reply)).toContain('two renames');
  });

  it('shows the alias behind a renamed game', () => {
    expect(text(buildChannelInfoPanel(input()))).toContain('via an alias');
  });

  it('offers no view buttons on an unmanaged channel', () => {
    const reply = buildChannelInfoPanel(
      input({ info: info({ kind: 'unmanaged', render: undefined }) }),
    );
    expect(reply.components ?? []).toHaveLength(0);
    expect(text(reply)).toContain('does not rename');
  });

  it('keeps the admin fields out of a member view', () => {
    const admin = input({
      isAdmin: true,
      botPermissions: { ManageChannels: false },
      info: info({ primary: { channelId: 'p1', startAt: 4, above: true, defaultMode: 'public' } }),
    });
    expect(text(buildChannelInfoPanel(admin))).toContain('ManageChannels');
    expect(text(buildChannelInfoPanel({ ...admin, isAdmin: false }))).not.toContain(
      'ManageChannels',
    );
  });

  /**
   * Adversarial review, confirmed: `enabled` was collected and never rendered,
   * so with automation switched off server-wide the panel reported a room whose
   * name was "up to date" while nothing was renaming anything. That is the
   * likeliest answer to the question the command exists to answer.
   */
  it('says so when automation is switched off for the whole server', () => {
    const body = text(buildChannelInfoPanel(input({ info: info({ enabled: false }) })));
    expect(body).toContain('switched off for this whole server');
    expect(body).toContain('/setup');
  });

  /**
   * Adversarial review, confirmed. Occupancy, privacy and the detected game
   * were read off whoever was passing through a creator channel, while the
   * token view beside them renders against an empty room. Both correct, one
   * click apart, and incoherent as a pair.
   */
  it('shows no occupancy or game for a creator channel', () => {
    const creator = info({
      kind: 'creator',
      // What a live read of a creator channel someone is standing in looks like.
      members: { total: 1, bots: 0 },
      userLimit: 2,
      game: 'Halo',
      rawGames: ['Halo'],
      render: { ...info().render!, synthetic: true, ctx: ctx({ members: [], index: 0 }) },
    });
    const body = text(buildChannelInfoPanel(input({ info: creator })));
    expect(body).not.toContain('Halo');
    expect(body).not.toContain('People');
    expect(body).toContain('The first room from here');
  });

  it('says the server is paused rather than pretending otherwise', () => {
    expect(text(buildChannelInfoPanel(input({ gatedNote: 'AVC is paused here.' })))).toContain(
      'paused',
    );
  });

  /**
   * Public, locked and hidden are three different answers, and a hidden room is a locked
   * one, so `isPrivate` alone cannot say. The readout names who else sees a hidden room,
   * because the moderator role is a guild setting nobody in the room can see, and says no
   * more than the channel list.
   */
  describe('the Access field', () => {
    const ROLE = '123456789012345678';
    const access = (over: Partial<ChannelInfo>): string => {
      const field = (
        buildChannelInfoPanel(input({ info: info(over) })).embeds![0] as {
          fields: { name: string; value: string }[];
        }
      ).fields.find((f) => f.name === 'Access');
      return field!.value;
    };

    it('says a public room is open to everyone and a locked one is private', () => {
      expect(access({ accessMode: 'public' })).toBe('🔓 Open to everyone');
      expect(access({ accessMode: 'locked', isPrivate: true })).toBe('🔒 Private');
    });

    it('says a hidden room is hidden from the channel list, and who still sees it', () => {
      expect(access({ accessMode: 'hidden', isPrivate: true })).toBe(
        '🙈 Hidden from the channel list\nStill seen by Administrators and anyone who was let in.',
      );
      expect(access({ accessMode: 'hidden', isPrivate: true, viewerRoleId: ROLE })).toBe(
        `🙈 Hidden from the channel list\nStill seen by Administrators, <@&${ROLE}> and anyone who was let in.`,
      );
    });

    /** A hidden room is private, and only a hidden one says so in its own words. */
    it('does not call a hidden room private or open', () => {
      const hidden = access({ accessMode: 'hidden', isPrivate: true });
      expect(hidden).not.toContain('Private');
      expect(hidden).not.toContain('Open to everyone');
    });

    it('does not guess for a room whose access settings cannot be read', () => {
      const unknown = access({ accessMode: 'unknown', isPrivate: true });
      expect(unknown).toContain("can't read this room's access settings");
      expect(unknown).not.toContain('Private');
      expect(unknown).not.toContain('Hidden');
      expect(unknown).not.toContain('Open to everyone');
    });

    it('follows the copy rules in every state, and makes no claim beyond the channel list', () => {
      const text = [
        access({ accessMode: 'public' }),
        access({ accessMode: 'locked', isPrivate: true }),
        access({ accessMode: 'hidden', isPrivate: true }),
        access({ accessMode: 'hidden', isPrivate: true, viewerRoleId: ROLE }),
        access({ accessMode: 'unknown' }),
      ].join('\n');
      expect(text).not.toMatch(/[—–‘’“”;]/);
      expect(text.toLowerCase()).not.toMatch(/primary|secondary|profile|activity|invisible/);
    });
  });
});

/**
 * What a creator channel says about how its new rooms start. It was a yes or no about
 * "private", which has two answers too few now that a room can also be hidden, and the
 * three states are said in the words the room's own Access field uses.
 */
describe('the creator channel settings', () => {
  const settings = (defaultMode: 'public' | 'locked' | 'hidden'): string => {
    const reply = buildChannelInfoPanel(
      input({
        isAdmin: true,
        info: info({
          kind: 'creator',
          primary: { channelId: 'p1', startAt: 4, above: true, defaultMode },
        }),
      }),
    );
    const field = (reply.embeds![0] as { fields: { name: string; value: string }[] }).fields.find(
      (f) => f.name === 'Creator channel settings',
    );
    return field!.value;
  };

  it('says how new rooms start in all three states', () => {
    expect(settings('public')).toContain('New rooms start: open to everyone');
    expect(settings('locked')).toContain('New rooms start: private');
    expect(settings('hidden')).toContain('New rooms start: hidden from the channel list');
  });

  it('no longer asks a yes or no question about private', () => {
    for (const mode of ['public', 'locked', 'hidden'] as const) {
      expect(settings(mode)).not.toMatch(/start private/i);
    }
  });

  it('keeps to the copy rules and the vocabulary in every state', () => {
    const all = (['public', 'locked', 'hidden'] as const).map(settings).join('\n');
    expect(all).not.toMatch(/[—–‘’“”;]/);
    expect(all.toLowerCase()).not.toMatch(/primary|secondary|profile|activity|invisible/);
  });

  describe('remembered room settings', () => {
    const remembered = (
      extra: { rememberPrefs?: boolean; savedSettings?: number; rememberPaused?: boolean } = {},
      isAdmin = true,
    ): string | undefined => {
      const reply = buildChannelInfoPanel(
        input({
          isAdmin,
          info: info({
            kind: 'creator',
            primary: { channelId: 'p1', defaultMode: 'public', ...extra },
          }),
        }),
      );
      const field = (reply.embeds![0] as { fields: { name: string; value: string }[] }).fields.find(
        (f) => f.name === 'Creator channel settings',
      );
      return field?.value
        .split('\n')
        .find((line) => line.startsWith('Returning members get their own saved name'));
    };

    it('says whether returning members get their own saved name, size and privacy', () => {
      expect(remembered({})).toBe(
        'Returning members get their own saved name, size and privacy: off',
      );
      expect(remembered({ rememberPrefs: false })).toBe(
        'Returning members get their own saved name, size and privacy: off',
      );
      expect(remembered({ rememberPrefs: true })).toBe(
        'Returning members get their own saved name, size and privacy: on',
      );
    });

    it('says how many members have saved settings when it is on', () => {
      expect(remembered({ rememberPrefs: true, savedSettings: 0 })).toContain(
        'on, nobody has saved settings yet',
      );
      expect(remembered({ rememberPrefs: true, savedSettings: 1 })).toContain(
        'on, 1 member has saved settings',
      );
      expect(remembered({ rememberPrefs: true, savedSettings: 12 })).toContain(
        'on, 12 members have saved settings',
      );
    });

    /** Rows kept while it is off are not what the line is about, and a count beside off would mislead. */
    it('shows no count beside off', () => {
      expect(remembered({ rememberPrefs: false, savedSettings: 12 })).toBe(
        'Returning members get their own saved name, size and privacy: off',
      );
    });

    /** It sits in the admin's section, so a member running the command never reads it. */
    it('is part of the admin section and absent from a member view', () => {
      expect(remembered({ rememberPrefs: true }, false)).toBeUndefined();
    });

    /** `member_prefs.disabled` is on: "on" would describe a feature that is doing nothing. */
    it('says it is switched off for now while the lever is on, and drops the count', () => {
      expect(remembered({ rememberPrefs: true, rememberPaused: true })).toBe(
        'Returning members get their own saved name, size and privacy: on, but switched off for now',
      );
      expect(remembered({ rememberPrefs: true, rememberPaused: true, savedSettings: 9 })).toBe(
        'Returning members get their own saved name, size and privacy: on, but switched off for now',
      );
      // Off stays off, and says nothing of the lever.
      expect(remembered({ rememberPrefs: false, rememberPaused: true })).toBe(
        'Returning members get their own saved name, size and privacy: off',
      );
    });

    it('keeps to the copy rules and the vocabulary in every state', () => {
      const all = [
        {},
        { rememberPrefs: true },
        { rememberPrefs: true, savedSettings: 0 },
        { rememberPrefs: true, savedSettings: 1 },
        { rememberPrefs: true, savedSettings: 40 },
        { rememberPrefs: true, rememberPaused: true },
      ]
        .map((extra) => remembered(extra))
        .join('\n');
      expect(all).not.toMatch(/[—–‘’“”;]/);
      expect(all.toLowerCase()).not.toMatch(/primary|secondary|profile|activity|invisible/);
    });
  });
});

describe('buildTokenPanel', () => {
  it('resolves tokens through the real engine', () => {
    const body = text(buildTokenPanel(input()));
    // The alias, the party, the limit and the index all come back resolved.
    expect(body).toContain('DRG');
    expect(body).toContain('Hazard 5');
    expect(body).toContain('Salvage');
  });

  /**
   * `@@slots@@` renders EMPTY on an unlimited room rather than `0`, and the
   * readout has to preserve that: substituting a dash or a zero would teach the
   * admin the opposite of what their template will do.
   */
  it('shows an empty token as empty, not as the fallback dash', () => {
    const unlimited = info({
      render: { ...info().render!, ctx: ctx({ userLimit: 0 }) },
      userLimit: 0,
    });
    const body = text(buildTokenPanel(input({ info: unlimited })));
    expect(body).toContain('_(empty)_');
  });

  it('reports the conditions that are true for this room', () => {
    const priv = info({
      isPrivate: true,
      render: { ...info().render!, ctx: ctx({ isPrivate: true }) },
    });
    const body = text(buildTokenPanel(input({ info: priv })));
    expect(body).toMatch(/PRIVATE.*✅/s);
  });

  /**
   * HIDDEN is the narrower of the two, and a hidden room is private too: the readout probes
   * the real engine with the room's own context, so it has to say yes to both for a hidden
   * room and only to PRIVATE for a locked one.
   */
  it('reports HIDDEN for a hidden room, which is also PRIVATE, and not for a locked one', () => {
    const conditions = (over: Partial<RenderContext>): string => {
      const room = info({ render: { ...info().render!, ctx: ctx(over) } });
      return fieldValues(buildTokenPanel(input({ info: room }))).join('\n');
    };
    const hidden = conditions({ isPrivate: true, isHidden: true });
    expect(hidden).toContain('`{{HIDDEN}}` ✅ yes');
    expect(hidden).toContain('`{{PRIVATE}}` ✅ yes');
    const locked = conditions({ isPrivate: true, isHidden: false });
    expect(locked).toContain('`{{HIDDEN}}` ❌ no');
    expect(locked).toContain('`{{PRIVATE}}` ✅ yes');
    const open = conditions({});
    expect(open).toContain('`{{HIDDEN}}` ❌ no');
    expect(open).toContain('`{{PRIVATE}}` ❌ no');
  });

  it('says a creator channel preview is not a live channel', () => {
    const creator = info({
      kind: 'creator',
      render: { ...info().render!, synthetic: true, ctx: ctx({ members: [], index: 0 }) },
    });
    expect(text(buildTokenPanel(input({ info: creator })))).toContain('no room of its own');
  });

  it('surfaces lint advice on a broken template', () => {
    const broken = info({ render: { ...info().render!, nameTemplate: '{{GAME ?? oops' } });
    expect(text(buildTokenPanel(input({ info: broken })))).toContain('Worth checking');
  });

  it('names who is playing what, which is what picks the game', () => {
    expect(text(buildTokenPanel(input()))).toContain('Robin');
  });

  /**
   * Found by rendering the panel for real rather than by a test.
   *
   * `getGameName` reads `activities` when present and falls back to the flat
   * `playing` list otherwise, so a member carrying only `playing` counts toward
   * the game. Listing activities alone named the game and then showed nobody
   * playing it, in the one field whose whole job is explaining that choice.
   */
  it('counts a member who has playing but no activities, like the engine does', () => {
    const mixed = info({
      render: {
        ...info().render!,
        ctx: ctx({
          members: [OWNER, member('u2', 'Sam', { playing: ['Deep Rock Galactic'] })],
        }),
      },
    });
    const body = text(buildTokenPanel(input({ info: mixed })));
    expect(body).toContain('Sam: Deep Rock Galactic');
    expect(body).not.toContain('Sam: _nothing_');
  });

  /**
   * Adversarial review, confirmed as the finding that should block a deploy.
   *
   * `@@owner@@` is the member's own `/nick` or nickname and `@@stream_name@@`
   * their stream title, both substituted at step 9, which collapses only `"`
   * runs. Embed field values DO render masked links, so a leading backtick used
   * to close the code span and hand the rest of the row to the renderer: any
   * member could put a fake "Verify your account" link inside an AVC panel.
   */
  it('cannot be used to inject markdown through a nickname or a stream title', () => {
    const attacker = member('u1', '`[Verify your account](https://evil.example)', {
      playing: ['Halo'],
      activities: [
        { kind: 'playing', name: 'Halo' },
        { kind: 'streaming', name: '`[Click here](https://evil.example)' },
      ],
    });
    const hostile = info({
      render: {
        ...info().render!,
        ctx: ctx({ members: [attacker], creator: attacker, creatorName: attacker.displayName }),
      },
    });
    const values = fieldValues(buildTokenPanel(input({ info: hostile }))).find((v) =>
      v.includes('@@owner@@'),
    )!;
    /**
     * The invariant, not the text. The link text still appears, wrapped in the
     * code span `cell()` puts around it; what must never appear is a SECOND
     * backtick that closes that span early. Two adjacent backticks are the
     * signature of one having escaped, and an odd total means a span is left
     * open and the rest of the field renders as markdown.
     */
    expect(values).not.toContain('``');
    expect(values.split('`').length % 2, `unbalanced code spans in:\n${values}`).toBe(1);
    expect(values).toContain('Verify your account');
  });

  it('falls back to the summary when there is nothing to explain', () => {
    const reply = buildTokenPanel(input({ info: info({ kind: 'unmanaged', render: undefined }) }));
    expect(text(reply)).toContain('Channel info');
  });
});

describe('buildScenarioPanel', () => {
  it('renders the template across the fixture states', () => {
    const body = text(buildScenarioPanel(input()));
    expect(body).toContain('nothing playing');
    expect(body).toContain('the room is locked');
  });

  /**
   * The previews must differ from the real room only in the SITUATION. Carrying
   * the fixture's own index would preview room 2 as room 1, which reads as a
   * bug in the numbering rather than as a different scenario.
   */
  it('keeps the number the room actually has', () => {
    const body = text(buildScenarioPanel(input()));
    expect(body).toContain('#2');
    expect(body).not.toContain('#1');
  });

  /**
   * Adversarial review, confirmed, and invisible to every other test here
   * because the fixtures happened to use seed 4, which is `PREVIEW_SEED`.
   *
   * With no stored seed the live views render at `ctx.seed ?? 0` while
   * `previewScenarios` falls back to 4, so `[[Red/Blue]]` said Red on the
   * summary and Blue in every row here. The seed must come off the context the
   * other views actually rendered with.
   */
  it('picks the same random branch the live views did, with no stored seed', () => {
    const seedless = info({
      seed: undefined,
      render: {
        ...info().render!,
        nameTemplate: '[[Red/Blue]]',
        ctx: { ...ctx(), seed: undefined },
      },
    });
    const live = text(buildChannelInfoPanel(input({ info: seedless })));
    // The "Renders as" field only. The panel also echoes the raw template,
    // which contains both words by construction.
    const rendered = fieldValues(buildScenarioPanel(input({ info: seedless }))).find((v) =>
      v.includes('nothing playing'),
    )!;
    const pick = live.includes('Red') ? 'Red' : 'Blue';
    expect(rendered).toContain(pick);
    expect(rendered).not.toContain(pick === 'Red' ? 'Blue' : 'Red');
  });

  it('drops the privacy scenario for an adopted channel, which has no privacy', () => {
    const managed = info({ kind: 'managed' });
    const body = text(buildScenarioPanel(input({ info: managed })));
    expect(body).not.toContain('the room is locked');
    expect(body).toContain('nobody in the channel');
  });
});

describe('embed limits', () => {
  /** Discord rejects the whole message over 1024 characters in one field. */
  it('keeps every field under the cap, even with long party text', () => {
    const wordy = ctx({
      members: [
        member('u1', 'Robin'.repeat(20), {
          playing: ['A'.repeat(200)],
          activities: [
            {
              kind: 'playing',
              name: 'A'.repeat(200),
              state: 'B'.repeat(300),
              details: 'C'.repeat(300),
            },
          ],
        }),
        ...Array.from({ length: 12 }, (_, i) => member(`m${i}`, `Member ${i}`.repeat(8))),
      ],
      creator: member('u1', 'Robin'.repeat(20)),
    });
    const wide = info({
      render: { ...info().render!, ctx: wordy, nameTemplate: 'X'.repeat(600) },
    });
    const admin = input({
      info: wide,
      isAdmin: true,
      botPermissions: { ViewChannel: true, ManageChannels: false },
      problems: Array.from({ length: 10 }, (_, i) => ({
        channelId: `c${i}`,
        operation: 'create' as const,
      })),
    });
    for (const view of ['summary', 'tokens', 'scenarios'] as const) {
      for (const value of fieldValues(buildChannelInfoView(view, admin))) {
        expect(value.length).toBeLessThanOrEqual(1024);
      }
    }
  });

  /**
   * The cap the per-field check cannot see, and the one that actually rejects
   * the message: Discord sums title, description and every field name and value
   * across the embed and refuses the lot past 6000. Eight fields each capped at
   * 1024 clear the per-field rule and blow this one.
   */
  it('keeps each whole embed under the total cap', () => {
    const long = 'Z'.repeat(400);
    const wordy = ctx({
      members: Array.from({ length: 12 }, (_, i) =>
        member(`m${i}`, `Member${i}`.repeat(6), {
          playing: [long],
          activities: [{ kind: 'playing', name: long, state: long, details: long }],
        }),
      ),
      creator: member('m0', 'Member0'.repeat(6)),
    });
    const wide = input({
      isAdmin: true,
      botPermissions: { ViewChannel: true, Connect: true, ManageChannels: false },
      problems: Array.from({ length: 10 }, (_, i) => ({
        channelId: `c${i}`,
        operation: 'create' as const,
      })),
      gatedNote: 'G'.repeat(200),
      info: info({
        render: { ...info().render!, ctx: wordy, nameTemplate: `{{GAME ?? ${'X'.repeat(600)}` },
        primary: {
          channelId: 'p1',
          startAt: 4,
          above: true,
          limit: 8,
          inheritperms: 'category',
          defaultMode: 'hidden',
        },
      }),
    });
    for (const view of ['summary', 'tokens', 'scenarios'] as const) {
      for (const embed of buildChannelInfoView(view, wide).embeds ?? []) {
        const e = embed as {
          title?: string;
          description?: string;
          fields?: { name: string; value: string }[];
        };
        const total =
          (e.title?.length ?? 0) +
          (e.description?.length ?? 0) +
          (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
        expect(total, `${view} embed is ${total} chars`).toBeLessThanOrEqual(6000);
        // A floor as well as a ceiling: without it, a builder that started
        // returning an empty embed would pass the cap check forever.
        expect(total, `${view} embed is suspiciously small`).toBeGreaterThan(200);
        expect(e.title?.length ?? 0).toBeLessThanOrEqual(256);
        expect((e.fields ?? []).length).toBeLessThanOrEqual(25);
      }
    }
  });
});

describe('custom ids', () => {
  it('round-trips a view and a channel', () => {
    expect(parseInfoId(infoId('tokens', CHANNEL))).toEqual({ view: 'tokens', channelId: CHANNEL });
  });

  it('refuses an id from another namespace or with a bad view', () => {
    expect(parseInfoId('avc:setup:tokens:1')).toBeNull();
    expect(parseInfoId(`${CHANNELINFO_PREFIX}nonsense:1`)).toBeNull();
    expect(parseInfoId(`${CHANNELINFO_PREFIX}tokens:`)).toBeNull();
  });
});
