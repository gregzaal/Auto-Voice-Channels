import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Binds every live render to {@link VoiceFeature.buildRenderContext}, by reading
 * `handler.ts`'s own source.
 *
 * **This exists because of a defect that was not a mistake anyone made once.**
 * `RenderContext.userLimit` was passed on the create path and on none of the
 * seven other call sites, so `@@party_size@@`'s user-limit fallback worked when
 * a channel was created and silently degraded to `0` on every re-render
 * afterwards. Nothing failed, no test noticed, and the name was simply a little
 * wrong forever. The cause was not a forgotten argument, it was eight
 * hand-assembled context literals: any field added later would be forgotten the
 * same way, and `{{FULL}}` reading a stale limit is worse than
 * `@@party_size@@` doing it (`plans/name-tokens.md` §5.3).
 *
 * Residual limits, stated rather than papered over. This reads source text, so
 * a call built somewhere it cannot follow needs an exemption below. And it
 * proves the assembler is reached, not that its inputs are right, which is what
 * `handler.integration.test.ts` is for.
 *
 * Relative to this file, not to `process.cwd()`: vitest runs from `avc/`, so a
 * cwd-relative path resolves to nothing and the suite silently collapses to
 * zero assertions.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'handler.ts'), 'utf8');

/**
 * Renders that legitimately do not go through the assembler, each with a reason.
 *
 * An entry here is a claim that has to stay true, so keep them few and
 * specific. Both are SYNTHETIC contexts: they describe a channel that does not
 * exist yet, so there is no live channel to read a limit or a privacy flag
 * from, and routing them through the assembler would make it read another
 * channel's state and quietly report it as this one's.
 */
const EXEMPT: Record<string, string> = {
  previewCtx:
    'previews a room the primary has not spawned yet, from an empty member list. There is no room to read a live user limit from.',
};

/**
 * Every `renderChannelName(` call in the file, with the argument text after it.
 *
 * The boundary is not decoration: `rerenderChannelName` CONTAINS
 * `renderChannelName`, so a plain `indexOf` picks up the dispatcher method that
 * renders nothing itself and reports it as an unguarded call.
 */
function renderCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/(?<![A-Za-z])renderChannelName\(/g)) {
    // Enough text to cover the context argument in every shape used here,
    // including a multi-line object literal.
    calls.push(source.slice(match.index, match.index + 600));
  }
  return calls;
}

describe('every render goes through buildRenderContext', () => {
  const calls = renderCalls(SOURCE);

  /**
   * The count guard the crude scanner needs. Without it, a rename of
   * `renderChannelName` (or a move of the file) makes every assertion below
   * pass over an empty list, which is the failure mode a source-reading test
   * has and a type-level one does not.
   */
  it('found the render call sites', () => {
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('passes a context that came from the assembler, never a fresh literal', () => {
    for (const call of calls) {
      const exempt = Object.keys(EXEMPT).find((name) => call.includes(name));
      if (exempt) continue;
      expect(
        call.includes('buildRenderContext') || /renderChannelName\([^,]+,\s*renderCtx/.test(call),
        `a renderChannelName call assembles its own context:\n${call.slice(0, 300)}`,
      ).toBe(true);
    }
  });

  /**
   * `renderCtx` is the local every site assigns the assembler's result to, so
   * the check above accepts it. That is only sound while nothing else in the
   * file assigns that name from anything but the assembler.
   */
  it('only ever assigns renderCtx from the assembler', () => {
    for (const match of SOURCE.matchAll(/const renderCtx = ([^;]+);/gs)) {
      expect(match[1], `renderCtx assigned from something else:\n${match[1]}`).toContain(
        'buildRenderContext',
      );
    }
  });

  /**
   * The assembler has to read the LIVE channel. `primary.template.limit` is the
   * configured default a room is created with, and `/limit` writes straight
   * through to Discord without storing anything, so a context built from the
   * stored value reports a limit the room may not have had for months.
   */
  it('reads the user limit from the live channel', () => {
    // Bounded by the method's own closing brace, not by a character count: a
    // fixed window silently stops covering the method the moment anything is
    // added above the line it was looking for, which is how this test broke.
    const from = SOURCE.indexOf('buildRenderContext(input: RenderContextInput)');
    expect(from).toBeGreaterThan(-1);
    const body = SOURCE.slice(from, SOURCE.indexOf('\n  }', from));
    expect(body).toContain('userLimitOf');
  });
});
