import { describe, expect, it } from 'vitest';
import { checkCopyRules, parseCopy, reinviteUrlFor, renderFor } from './announce.js';

const GOOD = `<!--
  A comment with an em dash — and a "curly quote", neither of which is copy.
-->

=== body ===
## Hello

Some text.

{{PRICING}}

Fix permissions: {{INVITE_LINK}}

Links: https://auto-voice.io

=== pricing:dormant ===
Free forever.

=== pricing:year ===
Free until {{EXPIRY}}.

=== pricing:short ===
Free until {{EXPIRY}}, shorter for big servers.

=== pricing:active ===
You already pay, nothing changes.
`;

describe('parseCopy', () => {
  it('reads the body and every pricing variant', () => {
    const s = parseCopy(GOOD);
    expect(s.body).toContain('## Hello');
    expect(s.body).toContain('{{PRICING}}');
    expect(Object.keys(s.pricing).sort()).toEqual(['active', 'dormant', 'short', 'year']);
    expect(s.pricing.year).toBe('Free until {{EXPIRY}}.');
  });

  /**
   * The instructions at the top of the copy file are HTML comments and contain
   * exactly the characters the rules ban, because they are explaining the rules.
   * Treating them as copy would fail every run.
   */
  it('strips the HTML comment so its contents are never sent or linted', () => {
    const s = parseCopy(GOOD);
    expect(s.body).not.toContain('curly quote');
    expect(checkCopyRules('body', s.body)).toEqual([]);
  });

  it('refuses a body with no pricing placeholder, which would silently drop the price', () => {
    const bad = GOOD.replace('{{PRICING}}', 'nothing here');
    expect(() => parseCopy(bad)).toThrow(/PRICING/);
  });

  /**
   * `marketing.md` §5.1 item 4: the reinvite fix-it link is meant to be in
   * every touch of the announcement, not an afterthought a human forgets to
   * paste in. Mirrors the {{PRICING}} guard immediately above.
   */
  it('refuses a body with no {{INVITE_LINK}} placeholder, so the reinvite fix-it path is never silently dropped', () => {
    const bad = GOOD.replace('Fix permissions: {{INVITE_LINK}}', 'Fix permissions.');
    expect(() => parseCopy(bad)).toThrow(/INVITE_LINK/);
  });

  it('refuses a missing pricing variant rather than sending some guilds nothing', () => {
    const bad = GOOD.replace('=== pricing:short ===', '=== pricing:typo ===');
    expect(() => parseCopy(bad)).toThrow(/pricing:short/);
  });

  /**
   * A paying guild told its service is "free until 2027" is worse than one told
   * nothing, so the variant has to exist before a send can start.
   */
  it('refuses copy with no active variant, which would mis-price paying guilds', () => {
    const bad = GOOD.replace('=== pricing:active ===', '=== pricing:unused ===');
    expect(() => parseCopy(bad)).toThrow(/pricing:active/);
  });

  it('refuses a file with no body at all', () => {
    expect(() => parseCopy('=== pricing:year ===\nhi\n')).toThrow(/body/);
  });
});

describe('checkCopyRules', () => {
  it('passes clean copy', () => {
    expect(checkCopyRules('x', 'Straight quotes, a comma, and a full stop.')).toEqual([]);
  });

  it('catches an em dash and an en dash', () => {
    expect(checkCopyRules('x', 'one — two')).toHaveLength(1);
    expect(checkCopyRules('x', 'one – two')).toHaveLength(1);
  });

  it('catches curly quotes, which is what pasting from a doc produces', () => {
    expect(checkCopyRules('x', 'it’s')).toHaveLength(1);
    expect(checkCopyRules('x', '“quoted”')).toHaveLength(1);
  });

  it('catches a prose semicolon', () => {
    expect(checkCopyRules('x', 'one thing; another thing')).toHaveLength(1);
  });

  /** A template like `{{a}};{{b}}` inside backticks is code, not prose. */
  it('allows a semicolon inside a code span', () => {
    expect(checkCopyRules('x', 'Set it to `a;b` and you are done.')).toEqual([]);
  });

  it('reports every distinct problem, not just the first', () => {
    expect(checkCopyRules('x', 'a — b “c” d; e')).toHaveLength(3);
  });
});

describe('reinviteUrlFor', () => {
  it('is guild-scoped and disables the guild picker (marketing.md §5.1 item 4)', () => {
    const url = reinviteUrlFor('123', '456');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('123');
    expect(parsed.searchParams.get('guild_id')).toBe('456');
    expect(parsed.searchParams.get('disable_guild_select')).toBe('true');
  });

  /**
   * The permission set and scope have been hand-copied into three places
   * (`web/src/lib/env.ts`, `web/src/app/dashboard/page.tsx`, and
   * `commands/interactions.ts`'s `/invite`). This is the bot-side half of
   * `marketing.md` §5.1 item 3 ("assert the invite scope in CI"): a drift
   * here would silently under- or over-request permissions, or drop the
   * `applications.commands` scope that made the whole rewrite cutover work
   * without anyone re-authorizing.
   */
  it('requests the same scope and permissions the bot has invited with since 2018', () => {
    const url = reinviteUrlFor('123', '456');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('bot applications.commands');
    expect(parsed.searchParams.get('permissions')).toBe('286280784');
  });
});

describe('renderFor', () => {
  it('substitutes the invite link alongside the pricing paragraph', () => {
    const sections = parseCopy(GOOD);
    const rendered = renderFor(
      sections,
      'year',
      new Date('2027-01-01T00:00:00Z'),
      'https://discord.com/oauth2/authorize?x=1',
    );
    expect(rendered).toContain('https://discord.com/oauth2/authorize?x=1');
    expect(rendered).not.toContain('{{INVITE_LINK}}');
    expect(rendered).not.toContain('{{PRICING}}');
  });

  it('leaves no unresolved placeholder for a real per-guild link', () => {
    const sections = parseCopy(GOOD);
    const url = reinviteUrlFor('123', '456');
    const rendered = renderFor(sections, 'active', null, url);
    expect(checkCopyRules('rendered', rendered)).toEqual([]);
    expect(rendered).toContain(url);
  });
});
