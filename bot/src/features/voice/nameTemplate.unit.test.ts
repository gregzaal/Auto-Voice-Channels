import { describe, expect, it } from 'vitest';
import type { VoiceMember } from './types.js';
import {
  DEFAULT_STATUS_TEMPLATE,
  getAlias,
  getChannelGames,
  getGameName,
  renderChannelName,
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
});
