import { describe, expect, it } from 'vitest';
import {
  REMEMBER_OFF_NOTE,
  REMEMBER_ON_NOTE,
  clearedNote,
  rememberedFieldValue,
  rememberedInfoLine,
} from './memberPrefsCopy.js';

const COUNTS = [undefined, 0, 1, 2, 250] as const;

/**
 * Every sentence the creator channel editor and `/channelinfo` say about remembered room
 * settings, rendered in every state, so the copy rules are checked on what an admin reads and
 * not on source text, where only a curly quote shows.
 */
function everySentence(): string[] {
  const out: string[] = [REMEMBER_ON_NOTE, REMEMBER_OFF_NOTE];
  for (const saved of COUNTS) {
    for (const on of [true, false]) {
      out.push(rememberedFieldValue(on, saved), rememberedInfoLine(on, saved));
    }
  }
  for (const removed of [0, 1, 2, 250]) out.push(clearedNote(removed));
  return out;
}

describe('copy rules', () => {
  it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
    const text = everySentence().join('\n');
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/[‘’“”]/);
    expect(text).not.toMatch(/;/);
  });

  it('never says primary or secondary to an admin', () => {
    const text = everySentence().join('\n').toLowerCase();
    expect(text).not.toContain('primary');
    expect(text).not.toContain('secondary');
  });

  it('makes no claim of generative AI', () => {
    expect(everySentence().join('\n').toLowerCase()).not.toMatch(/\b(ai|generated|llm)\b/);
  });

  /** Discord refuses the whole panel when one field value is past 1024. */
  it('fits an embed field, which is where an admin reads each of them', () => {
    for (const sentence of everySentence()) expect(sentence.length).toBeLessThanOrEqual(1024);
  });
});

describe('what turning it on says', () => {
  /**
   * The one place an admin chooses to have member ids and typed names kept, so each thing it
   * has to say is pinned: what members get, the one rule about names, and what is stored.
   */
  it('says what members get, that a name is only remembered when set, and what is stored', () => {
    expect(REMEMBER_ON_NOTE).toContain('name, size and privacy');
    expect(REMEMBER_ON_NOTE).toContain('instead of the server defaults');
    expect(REMEMBER_ON_NOTE).toContain(
      'A name is only remembered when the member set one themselves',
    );
    expect(REMEMBER_ON_NOTE).toContain("each member's id and the names they choose");
    expect(REMEMBER_ON_NOTE).toContain('[Privacy page](https://auto-voice.io/privacy)');
  });

  it('says that nothing is remembered until a member next changes their room', () => {
    expect(REMEMBER_ON_NOTE).toContain(
      'Nothing is remembered until a member next changes their room',
    );
  });

  it('says that turning it off keeps what members saved, and how to remove it', () => {
    expect(REMEMBER_OFF_NOTE).toContain('kept and not used');
    expect(REMEMBER_OFF_NOTE).toContain('comes back if you turn this on again');
    expect(REMEMBER_OFF_NOTE).toContain('"Clear saved settings"');
  });
});

describe('rememberedFieldValue', () => {
  it('states on and off first, in bold, so the state is the first thing read', () => {
    expect(rememberedFieldValue(true, undefined)).toMatch(/^\*\*On\.\*\*/);
    expect(rememberedFieldValue(false, undefined)).toMatch(/^\*\*Off\.\*\*/);
  });

  it('says what an on creator channel does and what an off one does', () => {
    expect(rememberedFieldValue(true, undefined)).toContain(
      'their own saved name, size and privacy, instead of the server defaults',
    );
    expect(rememberedFieldValue(false, undefined)).toContain("this creator channel's defaults");
  });

  it('counts members, in the singular and the plural', () => {
    expect(rememberedFieldValue(true, 1)).toContain('1 member has saved settings.');
    expect(rememberedFieldValue(true, 2)).toContain('2 members have saved settings.');
    expect(rememberedFieldValue(true, 0)).toContain('Nobody has saved settings yet.');
  });

  /** What is kept while it is off is what "Clear saved settings" is for, so the count says so. */
  it('says saved settings are kept and not used while it is off, and says nothing of none', () => {
    expect(rememberedFieldValue(false, 3)).toContain(
      '3 members have saved settings, which are kept and not used while this is off.',
    );
    expect(rememberedFieldValue(false, 0)).not.toMatch(/saved settings/);
  });

  /** A count that could not be read is not "nobody". */
  it('leaves the count out when it could not be read', () => {
    expect(rememberedFieldValue(true, undefined)).not.toMatch(/Nobody|have saved|has saved/);
    expect(rememberedFieldValue(false, undefined)).not.toMatch(/Nobody|have saved|has saved/);
  });
});

describe('clearedNote', () => {
  it('says how many members were removed, in the singular and the plural', () => {
    expect(clearedNote(1)).toContain('1 member.');
    expect(clearedNote(2)).toContain('2 members.');
    expect(clearedNote(250)).toContain('250 members.');
  });

  it('says there was nothing to clear when nothing was there, rather than claiming a clear', () => {
    expect(clearedNote(0)).toContain('nothing to clear');
    expect(clearedNote(0)).not.toContain('Removed');
  });
});

describe('rememberedInfoLine', () => {
  const HEAD = 'Returning members get their own saved name, size and privacy';

  it('reads on or off, in the words of the rest of that section', () => {
    expect(rememberedInfoLine(false, undefined)).toBe(`${HEAD}: off`);
    expect(rememberedInfoLine(true, undefined)).toBe(`${HEAD}: on`);
  });

  it('adds how many members have saved settings, only when on', () => {
    expect(rememberedInfoLine(true, 1)).toBe(`${HEAD}: on, 1 member has saved settings`);
    expect(rememberedInfoLine(true, 4)).toBe(`${HEAD}: on, 4 members have saved settings`);
    expect(rememberedInfoLine(true, 0)).toBe(`${HEAD}: on, nobody has saved settings yet`);
    // A count beside "off" would describe rows nothing uses.
    expect(rememberedInfoLine(false, 4)).toBe(`${HEAD}: off`);
  });
});
