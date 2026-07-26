import { describe, expect, it } from 'vitest';
import { renderChannelName } from '../voice/nameTemplate.js';
import { previewScenarios, renderPair } from './preview.js';
import { inspectRendered, lintTemplate, screenTemplate } from './validate.js';

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

describe('lintTemplate', () => {
  it('passes the templates the engine actually supports', () => {
    for (const template of [
      '## — @@game_name@@',
      "@@random_emoji@@ @@creator@@'s [[den/lounge/lair]]",
      '{{LIVE ?? 🔴 LIVE: @@stream_name@@}}',
      '{{PLAYERS >= 5 ?? 🔥 Full // open}}',
      '{{ROLE:998877 ?? 👑 }}@@creator@@’s room',
      '@@num@@ <<player/players>>',
      '@@num_playing@@ <<player|players>>',
      '""lower+scaps:@@creator@@\'s crew""',
      '""2w:@@game_name@@""',
      '__💤 Chill Zone/🎮 @@game_name@@__',
      '$0# @@nato@@ +#',
    ]) {
      expect(lintTemplate(template, 'name'), template).toEqual([]);
    }
  });

  // §9 finding 3/4: the model's most stubborn failure. It renders to nothing,
  // so only a structural check can see it.
  it('rejects a token used inside a conditional', () => {
    expect(codes(lintTemplate('{{@@num@@ >= 5 ?? busy}}', 'name'))).toContain('token-in-condition');
    expect(codes(lintTemplate('{{## = 1 ?? first}}', 'name'))).toContain('token-in-condition');
  });

  it('rejects an invented conditional variable', () => {
    const issues = lintTemplate('{{MEMBERS >= 5 ?? busy // quiet}}', 'name');
    expect(codes(issues)).toContain('unknown-variable');
    expect(issues[0]!.message).toContain('PLAYING');
  });

  it('accepts every real conditional variable and comparison form', () => {
    for (const template of [
      '{{PLAYING ?? x}}y',
      '{{RICH ?? x}}y',
      '{{LIVE_DISCORD ?? x}}y',
      '{{LIVE_EXTERNAL ?? x}}y',
      '{{GAME:Halo ?? x}}y',
      '{{MAX != 4 ?? x}}y',
      '{{PLAYERS <= 2 ?? x}}y',
    ]) {
      expect(lintTemplate(template, 'name'), template).toEqual([]);
    }
  });

  it('rejects an invented token but allows every real one', () => {
    expect(codes(lintTemplate('@@channel_topic@@ room', 'name'))).toContain('unknown-token');
    expect(lintTemplate('@@party_state@@ @@party_details@@ @@num_others@@', 'name')).toEqual([]);
  });

  it('rejects a stray token marker', () => {
    expect(codes(lintTemplate('@@creator@@ @@ room', 'name'))).toContain('stray-token-marker');
  });

  it('rejects an unknown style mode, which the engine silently ignores', () => {
    expect(codes(lintTemplate('""sparkle:@@creator@@""', 'name'))).toContain('unknown-style');
    // A chained mode list is checked entry by entry.
    expect(codes(lintTemplate('""lower+glitch:hi""', 'name'))).toContain('unknown-style');
    // A `""…""` with no colon is plain text to the engine, so it is not an error.
    expect(lintTemplate('""just text"" room', 'name')).toEqual([]);
  });

  it('rejects constructs that would print literally', () => {
    expect(codes(lintTemplate('[[onlyone]] room', 'name'))).toContain('random-without-choices');
    expect(codes(lintTemplate('<<solo>> room', 'name'))).toContain('plural-without-separator');
    expect(codes(lintTemplate('{{LIVE live}}', 'name'))).toContain('condition-without-branch');
  });

  it('rejects unclosed constructs', () => {
    expect(codes(lintTemplate('{{LIVE ?? x', 'name'))).toContain('unclosed-construct');
    expect(codes(lintTemplate('[[a/b room', 'name'))).toContain('unclosed-construct');
    expect(codes(lintTemplate('""lower:hi', 'name'))).toContain('unclosed-construct');
  });

  it('rejects literal text already past the output cap', () => {
    expect(codes(lintTemplate('x'.repeat(101), 'name'))).toContain('template-too-long');
    // The same length is fine for a status, whose cap is 500.
    expect(lintTemplate('x'.repeat(101), 'status')).toEqual([]);
    expect(codes(lintTemplate('x'.repeat(501), 'status'))).toContain('template-too-long');
  });
});

describe('inspectRendered', () => {
  it('catches a name that renders empty, which the engine turns into a bare dash', () => {
    // The engine's own fallback, so this is exactly what a channel would show.
    const rendered = renderChannelName('{{LIVE ?? 🔴}}', { index: 0, members: [] });
    expect(rendered).toBe('-');
    expect(codes(inspectRendered(rendered, '', 'name'))).toEqual(['renders-empty']);
  });

  it('allows a status that renders empty, since that just clears it', () => {
    expect(inspectRendered('', '', 'status')).toEqual([]);
  });

  it('catches markers left in the output', () => {
    expect(codes(inspectRendered('room {{LIVE', 'room {{LIVE', 'name'))).toContain(
      'renders-unsubstituted',
    );
  });

  it('catches silent truncation', () => {
    const long = 'x'.repeat(120);
    expect(codes(inspectRendered(long.slice(0, 100), long, 'name'))).toContain('renders-truncated');
    expect(inspectRendered(long, long, 'status')).toEqual([]);
  });
});

describe('preview scenarios', () => {
  const opts = { general: 'General', aliases: {}, creatorName: 'Kay', standalone: false };

  it('exercises the states an admin cannot see in their own channel', () => {
    expect(previewScenarios(opts).map((s) => s.key)).toEqual([
      'idle',
      'playing',
      'streaming',
      'party',
    ]);
    // A standalone channel is the only kind that exists while empty.
    expect(previewScenarios({ ...opts, standalone: true }).map((s) => s.key)).toContain('empty');
  });

  it('renders the same template differently across scenarios', () => {
    const scenarios = previewScenarios(opts);
    const rendered = scenarios.map(
      (s) => renderPair('{{PLAYING ?? @@game_name@@ // idle}}', 'name', s.ctx).rendered,
    );
    expect(rendered[0]).toBe('idle');
    expect(rendered[1]).toBe('Halo');
    expect(rendered[2]).toBe('Deep Rock Galactic');
  });

  it('shows `?` for numbering tokens on a standalone channel', () => {
    const [idle] = previewScenarios({ ...opts, standalone: true });
    expect(renderPair('## room', 'name', idle!.ctx).rendered).toBe('#? room');
  });

  it('keeps random picks stable, so a preview matches what gets applied', () => {
    const scenarios = previewScenarios(opts);
    const once = renderPair('[[den/lair/lounge]]', 'name', scenarios[0]!.ctx).rendered;
    const twice = renderPair('[[den/lair/lounge]]', 'name', scenarios[0]!.ctx).rendered;
    expect(once).toBe(twice);
  });
});

describe('screenTemplate', () => {
  it('passes an ordinary template', () => {
    expect(screenTemplate("@@creator@@'s room", 'name it after the owner')).toEqual([]);
  });

  it('refuses content the model introduced but the admin never typed', () => {
    expect(screenTemplate('Join discord.gg/abcdef', 'name it after the game')).toEqual([
      { code: 'invite-link', match: 'discord.gg/abcdef' },
    ]);
    expect(codes(screenTemplate('@everyone lounge', 'name it after the game'))).toEqual([
      'mass-mention',
    ]);
    expect(codes(screenTemplate('room https://evil.example', 'name it after the game'))).toEqual([
      'url',
    ]);
    // A bare domain with a path is still an advert.
    expect(codes(screenTemplate('watch twitch.tv/someone', 'name it after the game'))).toEqual([
      'url',
    ]);
  });

  it('does not mistake an ordinary name for a link', () => {
    for (const template of ['Squad.io night', "@@creator@@'s room 2.0", 'A/B testing']) {
      expect(screenTemplate(template, 'whatever'), template).toEqual([]);
    }
  });

  it('refuses disguising characters', () => {
    expect(codes(screenTemplate(`ro\u200bom`, 'name it after the game'))).toEqual([
      'control-characters',
    ]);
  });

  // The admin already has Manage Channels and could type any name via
  // /template, so this is about the model never *introducing* something.
  it('allows text the admin typed themselves', () => {
    expect(screenTemplate('Watch twitch.tv/kay', 'put twitch.tv/kay in the name')).toEqual([]);
    expect(screenTemplate('@everyone room', 'literally call it "@everyone room"')).toEqual([]);
  });
});
