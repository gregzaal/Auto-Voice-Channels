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

  it('renders member count and creator', () => {
    const members = [member({ id: 'a' }), member({ id: 'bot', bot: true })];
    expect(
      renderChannelName('@@num@@ by @@creator@@', {
        index: 0,
        members,
        creatorName: 'Alice',
      }),
    ).toBe('1 by Alice');
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
    expect(name).toMatch(/^.+ Greg's \w+$/u); // emoji + creator + word
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
