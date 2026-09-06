import { describe, expect, it } from 'vitest';
import type { VoiceMember } from './types.js';
import {
  applyStringTransforms,
  DEFAULT_CHANNEL_NAME_TEMPLATE,
  DEFAULT_STATUS_TEMPLATE,
  getAlias,
  getChannelGames,
  getGameName,
  RANDOM_EMOJIS,
  renderChannelName,
  resolveEmptyOccupied,
  toRoman,
  type RenderContext,
} from './nameTemplate.js';

function member(partial: Partial<VoiceMember> & { id: string }): VoiceMember {
  return {
    displayName: partial.id,
    bot: false,
    playing: [],
    ...partial,
  };
}

describe('getAlias', () => {
  it('applies built-in aliases', () => {
    expect(getAlias('League of Legends')).toBe('LoL');
    expect(getAlias('Counter-Strike: Global Offensive')).toBe('CS:GO');
  });

  it('prefers per-guild aliases over built-ins', () => {
    expect(getAlias('League of Legends', { 'League of Legends': 'League' })).toBe('League');
  });

  it('returns the original name when no alias matches', () => {
    expect(getAlias('Some Random Game')).toBe('Some Random Game');
  });
});

describe('getChannelGames', () => {
  it('returns General when nobody is playing', () => {
    expect(getChannelGames([member({ id: 'a' }), member({ id: 'b' })])).toEqual(['General']);
  });

  it('ignores bots and Custom Status', () => {
    const members = [
      member({ id: 'a', playing: ['Custom Status'] }),
      member({ id: 'bot', bot: true, playing: ['Halo'] }),
    ];
    expect(getChannelGames(members)).toEqual(['General']);
  });

  it('picks the most-played game', () => {
    const members = [
      member({ id: 'a', playing: ['Halo'] }),
      member({ id: 'b', playing: ['Halo'] }),
      member({ id: 'c', playing: ['Doom'] }),
    ];
    expect(getChannelGames(members)).toEqual(['Halo']);
  });

  it('joins a two-way tie', () => {
    const members = [
      member({ id: 'a', playing: ['Halo'] }),
      member({ id: 'b', playing: ['Doom'] }),
    ];
    expect(getChannelGames(members).sort()).toEqual(['Doom', 'Halo']);
  });

  it('falls back to General on a three-way tie', () => {
    const members = [
      member({ id: 'a', playing: ['Halo'] }),
      member({ id: 'b', playing: ['Doom'] }),
      member({ id: 'c', playing: ['Quake'] }),
    ];
    expect(getChannelGames(members)).toEqual(['General']);
  });
});

describe('getGameName', () => {
  it('returns the general label verbatim', () => {
    expect(getGameName([member({ id: 'a' })])).toBe('General');
  });

  it('aliases and joins tied games', () => {
    const members = [
      member({ id: 'a', playing: ['League of Legends'] }),
      member({ id: 'b', playing: ['Counter-Strike: Global Offensive'] }),
    ];
    const name = getGameName(members);
    expect(name).toContain('LoL');
    expect(name).toContain('CS:GO');
  });
});

describe('toRoman', () => {
  it('converts numbers', () => {
    expect(toRoman(1)).toBe('I');
    expect(toRoman(4)).toBe('IV');
    expect(toRoman(9)).toBe('IX');
    expect(toRoman(14)).toBe('XIV');
    expect(toRoman(40)).toBe('XL');
  });
});

describe('renderChannelName', () => {
  it('renders the classic number+game template', () => {
    const name = renderChannelName('## [@@game_name@@]', {
      index: 0,
      members: [member({ id: 'a', playing: ['Halo'] })],
    });
    expect(name).toBe('#1 [Halo]');
  });

  it('renders General when nobody is playing', () => {
    const name = renderChannelName('## [@@game_name@@]', {
      index: 2,
      members: [member({ id: 'a' })],
    });
    expect(name).toBe('#3 [General]');
  });

  it('renders ? for an unknown index', () => {
    expect(renderChannelName('##', { index: -1, members: [] })).toBe('#?');
  });

  it('renders roman numerals', () => {
    expect(renderChannelName('Room +#', { index: 3, members: [] })).toBe('Room IV');
  });

  it('renders zero-padded numbers', () => {
    expect(renderChannelName('$0#', { index: 0, members: [] })).toBe('01');
    expect(renderChannelName('$00#', { index: 8, members: [] })).toBe('009');
  });

  it('renders member count and owner', () => {
    const members = [member({ id: 'a' }), member({ id: 'bot', bot: true })];
    expect(
      renderChannelName('@@num@@ by @@owner@@', {
        index: 0,
        members,
        creatorName: 'Alice',
      }),
    ).toBe('1 by Alice');
  });

  it('still accepts `@@creator@@`, the older name for `@@owner@@`, for existing templates', () => {
    const members = [member({ id: 'a' })];
    expect(
      renderChannelName('@@owner@@ and @@creator@@', {
        index: 0,
        members,
        creatorName: 'Alice',
      }),
    ).toBe('Alice and Alice');
  });

  it('does not re-substitute the literal text "@@creator@@" if it is inside a display name', () => {
    const members = [member({ id: 'a' })];
    expect(
      renderChannelName('@@owner@@', {
        index: 0,
        members,
        creatorName: 'xx@@creator@@yy',
      }),
    ).toBe('xx@@creator@@yy');
  });

  it('clamps the rendered name to Discord’s 100-character limit', () => {
    const longGame = 'X'.repeat(200);
    const name = renderChannelName('@@game_name@@', {
      index: 0,
      members: [member({ id: 'a', playing: [longGame] })],
    });
    expect(name).toHaveLength(100);
  });

  it('falls back to "-" for an empty render', () => {
    expect(renderChannelName('@@stream_name@@', { index: 0, members: [] })).toBe('-');
  });
});

describe('renderChannelName — rich tokens', () => {
  it('[[random]] is stable for a given seed and varies by seed', () => {
    const tmpl = '[[a/b/c/d/e]]';
    const a1 = renderChannelName(tmpl, { index: 0, members: [], seed: 1 });
    const a2 = renderChannelName(tmpl, { index: 0, members: [], seed: 1 });
    expect(a1).toBe(a2); // same seed → same pick (no rename churn)
    expect('abcde').toContain(a1);
    // At least one other seed picks a different option.
    const others = [2, 3, 4, 5, 6, 7].map((s) =>
      renderChannelName(tmpl, { index: 0, members: [], seed: s }),
    );
    expect(others.some((x) => x !== a1)).toBe(true);
  });

  it('resolves two independent [[random]] groups (default-style template)', () => {
    const name = renderChannelName("[[🔥/🐍]] @@creator@@'s [[den/cave]]", {
      index: 0,
      members: [member({ id: 'a' })],
      creatorName: 'Alice',
      seed: 42,
    });
    expect(name).toMatch(/^(🔥|🐍) Alice's (den|cave)$/u);
  });

  it('renders @@nato@@ by channel number, wrapping past Z', () => {
    expect(renderChannelName('@@nato@@', { index: 0, members: [] })).toBe('Alpha');
    expect(renderChannelName('@@nato@@', { index: 25, members: [] })).toBe('Zulu');
    expect(renderChannelName('@@nato@@', { index: 26, members: [] })).toBe('Alpha 2');
  });

  it('renders @@num_others@@ excluding the creator', () => {
    const alice = member({ id: 'alice' });
    const bob = member({ id: 'bob' });
    const name = renderChannelName('@@num@@/@@num_others@@', {
      index: 0,
      members: [alice, bob],
      creator: alice,
    });
    expect(name).toBe('2/1');
  });

  it('selects the __empty/occupied__ branch by occupancy, substituting its tokens', () => {
    const tmpl = "__General/@@creator@@'s room__";
    const empty = renderChannelName(tmpl, { index: 0, members: [] });
    expect(empty).toBe('General');

    const alice = member({ id: 'a', displayName: 'Alice' });
    const occupied = renderChannelName(tmpl, {
      index: 0,
      members: [alice],
      creator: alice,
      creatorName: 'Alice',
    });
    expect(occupied).toBe("Alice's room");
  });

  it('handles <<singular/plural>> by member count', () => {
    const one = renderChannelName('@@num@@ <<player/players>>', {
      index: 0,
      members: [member({ id: 'a' })],
    });
    expect(one).toBe('1 player');
    const many = renderChannelName('@@num@@ <<player/players>>', {
      index: 0,
      members: [member({ id: 'a' }), member({ id: 'b' })],
    });
    expect(many).toBe('2 players');
  });

  it('resolves NESTED <<…>> groups for a three-way select', () => {
    // outer `/` selects on total members; inner `\` selects on non-creator count.
    const tmpl = '<<alone/<<duo\\group of @@num_others@@>>>>';
    const render = (members: VoiceMember[]) =>
      renderChannelName(tmpl, { index: 0, members, creator: members[0] });
    const a = member({ id: 'a' });
    const b = member({ id: 'b' });
    const c = member({ id: 'c' });
    expect(render([a])).toBe('alone'); // 1 total
    expect(render([a, b])).toBe('duo'); // 2 total, 1 other
    expect(render([a, b, c])).toBe('group of 2'); // 3 total, 2 others
  });

  it("doesn't leave a dangling >> on the nested singular case (the reported bug)", () => {
    const out = renderChannelName(
      "<<pls join im so lonely/<<@@creator@@'s room\\@@creator@@ and the @@num_others@@ rats>>>>",
      {
        index: 0,
        members: [member({ id: 'a' })],
        creatorName: 'Greg',
        creator: member({ id: 'a' }),
      },
    );
    expect(out).toBe('pls join im so lonely');
    expect(out).not.toContain('>>');
  });

  it('renders rich-presence party tokens', () => {
    const players = [
      member({
        id: 'a',
        activities: [
          {
            kind: 'playing',
            name: 'Deep Rock',
            state: 'Hazard 5',
            details: 'Salvage',
            party: { size: [3, 4] },
          },
        ],
      }),
      member({
        id: 'b',
        activities: [{ kind: 'playing', name: 'Deep Rock', party: { size: [3, 4] } }],
      }),
    ];
    const name = renderChannelName(
      '@@num_playing@@/@@party_size@@ @@party_state@@ — @@party_details@@',
      {
        index: 0,
        members: players,
        general: 'General',
      },
    );
    expect(name).toBe('3/4 Hazard 5 — Salvage');
  });

  it('handles <<singular|plural>> by party size (@@num_playing@@)', () => {
    const soloParty = [
      member({
        id: 'a',
        activities: [{ kind: 'playing', name: 'Deep Rock', party: { size: [1, 4] } }],
      }),
    ];
    const solo = renderChannelName('@@num_playing@@ <<player|players>>', {
      index: 0,
      members: soloParty,
      general: 'General',
    });
    expect(solo).toBe('1 player');

    const fullParty = [
      member({
        id: 'a',
        activities: [{ kind: 'playing', name: 'Deep Rock', party: { size: [3, 4] } }],
      }),
      member({
        id: 'b',
        activities: [{ kind: 'playing', name: 'Deep Rock', party: { size: [3, 4] } }],
      }),
    ];
    const full = renderChannelName('@@num_playing@@ <<player|players>>', {
      index: 0,
      members: fullParty,
      general: 'General',
    });
    expect(full).toBe('3 players');

    // No rich-presence data at all: the party lookup still runs (triggered by the
    // `<<…|…>>` group alone) and numPlaying defaults to 0, which takes the plural.
    const noParty = renderChannelName('<<player|players>>', {
      index: 0,
      members: [member({ id: 'a' })],
      general: 'General',
    });
    expect(noParty).toBe('players');
  });

  it('evaluates {{conditional}} expressions', () => {
    const streamer = member({ id: 'a', activities: [{ kind: 'streaming', name: 'My Stream' }] });
    const live = renderChannelName('{{LIVE ?? 🔴 @@stream_name@@ // offline}}', {
      index: 0,
      members: [streamer],
      creator: streamer,
    });
    expect(live).toBe('🔴 My Stream');

    const offline = renderChannelName('{{LIVE ?? 🔴 // offline}}', {
      index: 0,
      members: [member({ id: 'b' })],
      creator: member({ id: 'b' }),
    });
    expect(offline).toBe('offline');
  });

  it('supports numeric and role conditionals', () => {
    const a = member({
      id: 'a',
      roleIds: ['111', '222'],
      activities: [{ kind: 'playing', name: 'X', party: { size: [5, 8] } }],
    });
    const b = member({
      id: 'b',
      activities: [{ kind: 'playing', name: 'X', party: { size: [5, 8] } }],
    });
    const name = renderChannelName('{{PLAYERS>=5??FULLISH//ok}} {{ROLE:222??[VIP]}}', {
      index: 0,
      members: [a, b],
      creator: a,
    });
    expect(name).toBe('FULLISH [VIP]');
  });

  it('exposes a PLAYING boolean for the default status template', () => {
    const opts = { maxLength: 500, allowEmpty: true };
    // A game is playing → "Playing <game>"; idle → blank (status cleared).
    const playing = renderChannelName(
      DEFAULT_STATUS_TEMPLATE,
      {
        index: 0,
        members: [member({ id: 'a', playing: ['Blender'] })],
      },
      opts,
    );
    expect(playing).toBe('Playing Blender');

    const idle = renderChannelName(
      DEFAULT_STATUS_TEMPLATE,
      {
        index: 0,
        members: [member({ id: 'a' })],
      },
      opts,
    );
    expect(idle).toBe('');
  });

  it('allowEmpty keeps an empty status empty (vs "-" for names)', () => {
    expect(renderChannelName('', { index: 0, members: [] })).toBe('-');
    expect(renderChannelName('', { index: 0, members: [] }, { allowEmpty: true })).toBe('');
  });

  it('@@random_emoji@@ is a stable per-seed pick from the emoji pool', () => {
    const render = (seed: number) =>
      renderChannelName('@@random_emoji@@', { index: 0, members: [], seed });
    expect(render(1)).toBe(render(1)); // stable for a seed
    expect(RANDOM_EMOJIS).toContain(render(1));
    const picks = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(render));
    expect(picks.size).toBeGreaterThan(1); // varies across seeds
  });

  it('the default template uses @@random_emoji@@ and stays short', () => {
    expect(DEFAULT_CHANNEL_NAME_TEMPLATE).toContain('@@random_emoji@@');
    // The bug was a ~250-char default; it should now comfortably fit any template input.
    expect(DEFAULT_CHANNEL_NAME_TEMPLATE.length).toBeLessThan(150);
    const name = renderChannelName(DEFAULT_CHANNEL_NAME_TEMPLATE, {
      index: 0,
      members: [member({ id: 'a' })],
      creatorName: 'Greg',
      seed: 42,
    });
    expect(name).toMatch(/^.+ Greg's \w+$/u); // emoji + owner + word
  });
});

describe('applyStringTransforms (legacy ""mode:text"")', () => {
  it('lower+scaps lowercases then small-caps (the reported migration bug)', () => {
    expect(applyStringTransforms('""lower+scaps:Onza\'s Crew""')).toBe("ᴏɴᴢᴀ'ꜱ ᴄʀᴇᴡ");
  });

  it('<N>w keeps the first N words', () => {
    expect(applyStringTransforms('""1w:Greg Zaal""\'s chat')).toBe("Greg's chat");
    expect(applyStringTransforms('""2w:a b c d""')).toBe('a b');
  });

  it('supports the common pure-string modes', () => {
    expect(applyStringTransforms('""upper:hi there""')).toBe('HI THERE');
    expect(applyStringTransforms('""caps:hi""')).toBe('HI');
    expect(applyStringTransforms('""lower:HELLO""')).toBe('hello');
    expect(applyStringTransforms('""title:hello world""')).toBe('Hello World');
    expect(applyStringTransforms('""swap:Hello""')).toBe('hELLO');
    expect(applyStringTransforms('""acro:deep rock galactic""')).toBe('drg');
    expect(applyStringTransforms('""remshort:lord of the rings""')).toBe('lord rings');
    expect(applyStringTransforms('""spaces:a   b""')).toBe('a b');
  });

  it('only transforms the wrapped span and strips the markers', () => {
    expect(applyStringTransforms('x ""lower:AB"" y')).toBe('x ab y');
  });

  it('applies math-font modes (e.g. bold) end to end', () => {
    expect(applyStringTransforms('""bold:hi""')).toBe('𝐡𝐢');
  });

  it('passes a genuinely unknown mode through without the literal wrapper', () => {
    expect(applyStringTransforms('""nope:hi""')).toBe('hi');
  });

  it('leaves a non-transform pair (no colon) literal, matching the legacy guard', () => {
    expect(applyStringTransforms('""just quoted""')).toBe('""just quoted""');
  });

  it('applies as the final step of renderChannelName', () => {
    const onza = member({ id: 'c', displayName: 'Onza' });
    const out = renderChannelName('""lower+scaps:@@creator@@\'s crew""', {
      index: 0,
      members: [onza],
      creatorName: 'Onza',
      creator: onza,
    });
    expect(out).toBe("ᴏɴᴢᴀ'ꜱ ᴄʀᴇᴡ");
    expect(out).not.toContain('""');
  });
});

describe('resolveEmptyOccupied (__empty/occupied__)', () => {
  it('picks the first branch when empty, the second when occupied', () => {
    expect(resolveEmptyOccupied('__General/Busy__', true)).toBe('General');
    expect(resolveEmptyOccupied('__General/Busy__', false)).toBe('Busy');
  });

  it('splits on the first slash only, so the occupied branch may contain "/"', () => {
    expect(resolveEmptyOccupied('__Lobby/a/b__', false)).toBe('a/b');
    expect(resolveEmptyOccupied('__Lobby/a/b__', true)).toBe('Lobby');
  });

  it('resolves multiple groups and surrounding text left to right', () => {
    expect(resolveEmptyOccupied('[__A/B__] [__C/D__]', false)).toBe('[B] [D]');
  });

  it('leaves a group without a slash, and plain "__" runs, untouched', () => {
    expect(resolveEmptyOccupied('__no slash__', true)).toBe('__no slash__');
    expect(resolveEmptyOccupied('plain text', false)).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// Conditional operands (plans/name-tokens.md §5.1)
// ---------------------------------------------------------------------------

describe('conditional operands', () => {
  const three = [member({ id: 'a' }), member({ id: 'b' }), member({ id: 'c' })];
  const ctx = (extra: Partial<RenderContext> = {}): RenderContext => ({
    index: 4,
    members: three,
    creator: three[0]!,
    creatorName: 'a',
    seed: 1,
    ...extra,
  });

  it('compares a token on the left against a literal', () => {
    expect(renderChannelName('{{@@num@@>=2 ?? Y // N}}', ctx())).toBe('Y');
    expect(renderChannelName('{{@@num@@>=9 ?? Y // N}}', ctx())).toBe('N');
    expect(renderChannelName('{{$#>=2 ?? Y // N}}', ctx())).toBe('Y');
    expect(renderChannelName('{{@@num@@=3 ?? Y // N}}', ctx())).toBe('Y');
  });

  it('compares two tokens, and a variable against a variable', () => {
    expect(renderChannelName('{{@@num@@>=@@limit@@ ?? Y // N}}', ctx({ userLimit: 3 }))).toBe('Y');
    expect(renderChannelName('{{@@num@@>@@limit@@ ?? Y // N}}', ctx({ userLimit: 3 }))).toBe('N');
    expect(renderChannelName('{{PLAYERS>=MAX ?? Y // N}}', ctx())).toBe('Y'); // 0 >= 0
  });

  /**
   * `##` renders `#5` and `+#` renders `V`, so neither ever parses. This is the
   * asymmetry the docs and the assistant's lint both have to carry, because
   * `##` is the token people know.
   */
  it('leaves the number tokens that do not substitute a number falsy', () => {
    expect(renderChannelName('{{##>=2 ?? Y // N}}', ctx())).toBe('N');
    expect(renderChannelName('{{+#>=2 ?? Y // N}}', ctx())).toBe('N');
    expect(renderChannelName('{{@@nato@@>=2 ?? Y // N}}', ctx())).toBe('N');
  });

  /**
   * `in` walked the prototype chain and returned a FUNCTION, which is truthy,
   * so every one of these rendered the TRUE branch.
   */
  it('does not resolve Object.prototype members as variables', () => {
    for (const name of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__proto__',
      '__defineGetter__',
    ]) {
      expect(renderChannelName('{{' + name + ' ?? Y // N}}', ctx()), name).toBe('N');
    }
  });

  /** A typo has to keep failing safe: `assisted_templates.md` §9 leans on it. */
  it('keeps an unknown name falsy rather than treating it as a string literal', () => {
    expect(renderChannelName('{{PLAYERZ!=5 ?? Y // N}}', ctx())).toBe('N');
    expect(renderChannelName('{{PLAYERZ ?? Y // N}}', ctx())).toBe('N');
  });

  it('leaves the ":" and "=" right sides as raw text', () => {
    const withRole = [member({ id: 'a', roleIds: ['998877'] })];
    const roleCtx = { index: 0, members: withRole, creator: withRole[0]!, creatorName: 'a' };
    expect(renderChannelName('{{ROLE:998877 ?? Y // N}}', roleCtx)).toBe('Y');
    expect(renderChannelName('{{GAME=General ?? Y // N}}', ctx())).toBe('Y');
    expect(renderChannelName('{{GAME:Gen ?? Y // N}}', ctx())).toBe('Y');
  });

  it('is false when a comparison lands on a non-number', () => {
    expect(renderChannelName('{{PLAYERS>=RICH ?? Y // N}}', ctx())).toBe('N');
    expect(renderChannelName('{{PLAYERS>=GAME ?? Y // N}}', ctx())).toBe('N');
  });
});

// ---------------------------------------------------------------------------
// Member-controlled text (plans/name-tokens.md §5.2)
// ---------------------------------------------------------------------------

describe('substituted member text cannot form engine delimiters', () => {
  const withDetails = (details: string): VoiceMember =>
    member({
      id: 'a',
      playing: ['DRG'],
      activities: [
        {
          kind: 'playing',
          name: 'DRG',
          state: 'Hazard 5',
          details,
          party: { id: 'p', size: [3, 4] },
        },
      ],
    });
  const render = (template: string, details: string): string => {
    const owner = withDetails(details);
    return renderChannelName(template, {
      index: 4,
      members: [owner],
      creator: owner,
      creatorName: 'a',
      seed: 1,
    });
  };

  it('does not let party text split the conditional it sits inside', () => {
    expect(render('{{RICH ?? [@@party_details@@] // no}}', 'x ?? EVIL // y')).toBe(
      '[x ? EVIL / y]',
    );
  });

  /**
   * Collapsing a run to ONE, not halving a pair. Replacing the doubled form
   * once is bypassable: `????` would become `??`, re-creating the marker it
   * just removed.
   */
  it('cannot be bypassed by doubling the marker', () => {
    expect(render('{{RICH ?? [@@party_details@@] // no}}', 'x ???? EVIL //// y')).toBe(
      '[x ? EVIL / y]',
    );
    expect(render('A @@party_details@@ B', '{{{{PLAYING ?? IN // no}}}}')).toBe(
      'A {PLAYING ? IN / no} B',
    );
    expect(render('A @@party_details@@ B', '""""upper:shout""""')).toBe('A "upper:shout" B');
  });

  it('does not let party text introduce a construct the admin did not write', () => {
    expect(render('A @@party_details@@ B', '{{PLAYING ?? IN // no}}')).toBe(
      'A {PLAYING ? IN / no} B',
    );
    expect(render('A @@party_details@@ B', '""upper:shout""')).toBe('A "upper:shout" B');
    expect(render('A @@party_details@@ B', '<<one/many>>')).toBe('A <one/many> B');
    expect(render('A @@party_details@@ B', '@@owner@@')).toBe('A @owner@ B');
  });

  it('leaves ordinary party text readable', () => {
    expect(render('A @@party_details@@ B', 'Salvage')).toBe('A Salvage B');
    expect(render('A @@party_details@@ B', 'Co-op // Salvage')).toBe('A Co-op / Salvage B');
  });

  /**
   * By step 9 only `""` is still unresolved, so an owner name keeps its
   * slashes. Over-sanitising here would rename every room whose owner has a
   * `//` in their nickname.
   */
  it('leaves an owner name with slashes untouched', () => {
    const owner = member({ id: 'a', displayName: 'Greg // AVC' });
    expect(
      renderChannelName("@@owner@@'s room", {
        index: 0,
        members: [owner],
        creator: owner,
        creatorName: 'Greg // AVC',
      }),
    ).toBe("Greg // AVC's room");
  });
});

// ---------------------------------------------------------------------------
// The new vocabulary (plans/name-tokens.md §5.4)
// ---------------------------------------------------------------------------

describe('capacity tokens and FULL', () => {
  const room = (n: number, userLimit?: number): RenderContext => {
    const members = Array.from({ length: n }, (_, i) => member({ id: `m${i}` }));
    return {
      index: 0,
      members,
      creator: members[0]!,
      creatorName: 'm0',
      ...(userLimit !== undefined ? { userLimit } : {}),
    };
  };

  it('renders the limit and the free places', () => {
    expect(renderChannelName('@@num@@/@@limit@@ (@@slots@@ free)', room(3, 5))).toBe(
      '3/5 (2 free)',
    );
    expect(renderChannelName('@@slots@@', room(5, 5))).toBe('0');
    // Over the limit (an admin lowered it) floors at zero rather than going negative.
    expect(renderChannelName('@@slots@@', room(7, 5))).toBe('0');
  });

  /** "0 spots left" is a lie; a visible gap is guardable and honest. */
  it('renders slots empty, not zero, when the room is unlimited', () => {
    expect(renderChannelName('x@@slots@@y', room(3))).toBe('xy');
    expect(renderChannelName('@@limit@@', room(3))).toBe('0');
    expect(renderChannelName('a{{@@limit@@>=1 ?? @@slots@@ spots}}', room(3))).toBe('a');
    // The branch keeps the space after `??`, so this is `a` + ` 2 spots`.
    expect(renderChannelName('a{{@@limit@@>=1 ?? @@slots@@ spots}}', room(3, 5))).toBe('a 2 spots');
  });

  /**
   * The reason FULL is a variable at all: `{{@@num@@>=@@limit@@}}` reads `3>=0`
   * on an unlimited room and calls it full.
   */
  it('knows an unlimited room is never full, where the arithmetic does not', () => {
    expect(renderChannelName('{{FULL ?? full // open}}', room(3))).toBe('open');
    expect(renderChannelName('{{@@num@@>=@@limit@@ ?? full // open}}', room(3))).toBe('full');
    expect(renderChannelName('{{FULL ?? full // open}}', room(3, 3))).toBe('full');
    expect(renderChannelName('{{FULL ?? full // open}}', room(2, 3))).toBe('open');
  });
});

describe('room-scoped variables', () => {
  const goLive = member({ id: 'b', selfStreaming: true });
  const twitch = member({ id: 'c', activities: [{ kind: 'streaming', name: 'a stream' }] });
  const quiet = member({ id: 'a', roleIds: ['1'] });
  const ctx = (members: VoiceMember[]): RenderContext => ({
    index: 0,
    members,
    creator: members[0]!,
    creatorName: members[0]!.id,
  });

  it('asks about anyone in the room, where LIVE asks about the owner', () => {
    expect(renderChannelName('{{ANY_LIVE ?? Y // N}}', ctx([quiet, goLive]))).toBe('Y');
    expect(renderChannelName('{{LIVE ?? Y // N}}', ctx([quiet, goLive]))).toBe('N');
    expect(renderChannelName('{{ANY_LIVE ?? Y // N}}', ctx([quiet]))).toBe('N');
    expect(renderChannelName('@@num_live@@', ctx([quiet, goLive, twitch]))).toBe('2');
  });

  it('finds a role held by anyone, and a specific member', () => {
    const mod = member({ id: 'd', roleIds: ['99'] });
    expect(renderChannelName('{{ANY_ROLE:99 ?? Y // N}}', ctx([quiet, mod]))).toBe('Y');
    expect(renderChannelName('{{ROLE:99 ?? Y // N}}', ctx([quiet, mod]))).toBe('N');
    expect(renderChannelName('{{MEMBER:d ?? Y // N}}', ctx([quiet, mod]))).toBe('Y');
    expect(renderChannelName('{{MEMBER:zz ?? Y // N}}', ctx([quiet, mod]))).toBe('N');
  });

  it('ignores bots', () => {
    const bot = member({ id: 'bot', bot: true, selfStreaming: true, roleIds: ['99'] });
    expect(renderChannelName('{{ANY_LIVE ?? Y // N}}', ctx([quiet, bot]))).toBe('N');
    expect(renderChannelName('{{ANY_ROLE:99 ?? Y // N}}', ctx([quiet, bot]))).toBe('N');
    expect(renderChannelName('@@num_live@@', ctx([quiet, bot]))).toBe('0');
  });
});

describe('PRIVATE', () => {
  const one = member({ id: 'a' });
  const ctx = (isPrivate?: boolean): RenderContext => ({
    index: 0,
    members: [one],
    creator: one,
    creatorName: 'a',
    ...(isPrivate !== undefined ? { isPrivate } : {}),
  });

  it('reflects the room being locked, and defaults to public', () => {
    expect(renderChannelName('{{PRIVATE ?? L // U}}', ctx(true))).toBe('L');
    expect(renderChannelName('{{PRIVATE ?? L // U}}', ctx(false))).toBe('U');
    // An adopted channel passes nothing, and must read as public rather than
    // rendering a padlock on a channel nobody locked.
    expect(renderChannelName('{{PRIVATE ?? L // U}}', ctx())).toBe('U');
  });
});

describe('numberOffset (startAt)', () => {
  const one = member({ id: 'a' });
  const at = (index: number, numberOffset: number): RenderContext => ({
    index,
    members: [one],
    creator: one,
    creatorName: 'a',
    numberOffset,
  });

  it('shifts every index-derived token together', () => {
    expect(renderChannelName('## $0# +# @@nato@@', at(0, 3))).toBe('#4 04 IV Delta');
    expect(renderChannelName('## $0# +# @@nato@@', at(2, 3))).toBe('#6 06 VI Foxtrot');
    expect(renderChannelName('## $0# +# @@nato@@', at(0, 0))).toBe('#1 01 I Alpha');
  });

  /**
   * Numbering from zero puts the first room's shifted index at -1, which is
   * also the standalone-channel sentinel. It must still be a real room, and
   * the NATO alphabet has no zeroth word, so the words ignore a negative shift
   * rather than clamping (which would name the first two rooms both Alpha).
   */
  it('handles numbering from zero without colliding with a standalone channel', () => {
    expect(renderChannelName('## $0# @@nato@@', at(0, -1))).toBe('#0 00 Alpha');
    expect(renderChannelName('## $0# @@nato@@', at(1, -1))).toBe('#1 01 Bravo');
    expect(
      renderChannelName('## $0# +# @@nato@@', { index: -1, members: [one], creator: one }),
    ).toBe('#? ? ? ?');
  });
});

describe('OWNER', () => {
  const sam = member({ id: '111', displayName: 'Sam' });
  const robin = member({ id: '222', displayName: 'Robin' });
  const ctx = (creator?: VoiceMember): RenderContext => ({
    index: 0,
    members: [sam, robin],
    ...(creator ? { creator, creatorName: creator.displayName } : {}),
  });

  it('matches the owner by id, and nobody else in the room', () => {
    expect(renderChannelName('{{OWNER:111 ?? mine // theirs}}', ctx(sam))).toBe('mine');
    // Robin is present, so MEMBER matches, but they do not own the room.
    expect(renderChannelName('{{OWNER:222 ?? mine // theirs}}', ctx(sam))).toBe('theirs');
    expect(renderChannelName('{{MEMBER:222 ?? here // away}}', ctx(sam))).toBe('here');
  });

  /**
   * The distinction that makes it worth having: `MEMBER` answers "is this
   * person in the room", `OWNER` answers "is this their room". They disagree
   * exactly when the person is present but does not own it, which is the
   * common case in any busy room.
   */
  it('is not the same question as MEMBER', () => {
    // Robin is in the room and does not own it, so the two disagree.
    expect(renderChannelName('{{OWNER:222 ?? yes // no}}', ctx(sam))).toBe('no');
    expect(renderChannelName('{{MEMBER:222 ?? yes // no}}', ctx(sam))).toBe('yes');
  });

  /**
   * `creator` is resolved from the channel's CURRENT members, so an owner who
   * has left leaves it empty. That is the same condition that makes
   * `@@owner@@` render `Unknown`, which is what makes this a usable fallback
   * rather than a quirk.
   */
  it('is empty when the owner is not in the room, so a bare test is a fallback', () => {
    expect(renderChannelName('{{OWNER ?? owned // ownerless}}', ctx(sam))).toBe('owned');
    expect(renderChannelName('{{OWNER ?? owned // ownerless}}', ctx())).toBe('ownerless');
    expect(renderChannelName("{{OWNER ?? @@owner@@'s room // Open room}}", ctx(sam))).toBe(
      "Sam's room",
    );
    expect(renderChannelName("{{OWNER ?? @@owner@@'s room // Open room}}", ctx())).toBe(
      'Open room',
    );
  });

  /** A bot cannot own a room, and the roster the variables read excludes them. */
  it('ignores bots in the room', () => {
    const bot = member({ id: '999', bot: true });
    const withBot: RenderContext = {
      index: 0,
      members: [sam, bot],
      creator: sam,
      creatorName: 'Sam',
    };
    expect(renderChannelName('{{MEMBER:999 ?? y // n}}', withBot)).toBe('n');
    expect(renderChannelName('{{OWNER:999 ?? y // n}}', withBot)).toBe('n');
  });
});
