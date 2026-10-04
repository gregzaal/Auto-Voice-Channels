import { describe, expect, it } from 'vitest';
import { MAX_BLOCKED_WORDS } from './blockedWords.js';
import {
  BLOCKED_WORDS_NOTHING_USABLE,
  BLOCKED_WORDS_PAUSED,
  BLOCKED_WORDS_TOO_LONG,
  blockedWordLogLine,
  blockedWordRefusal,
  blockedWordsAuditLine,
  blockedWordsSavedMessage,
  rejectedWordsLines,
  tooManyBlockedWords,
  type BlockedWordDoor,
} from './blockedWordsCopy.js';

const DOORS: BlockedWordDoor[] = ['name', 'status', 'nick'];
const ADMIN = '111111111111111111';

/** Every sentence `/blockedwords` and the doors say, rendered in every state. */
function everySentence(): string[] {
  const out: string[] = [
    BLOCKED_WORDS_PAUSED,
    BLOCKED_WORDS_TOO_LONG,
    BLOCKED_WORDS_NOTHING_USABLE,
  ];
  for (const door of DOORS) out.push(blockedWordRefusal(door), blockedWordLogLine(ADMIN, door));
  for (const n of [0, 1, 2, MAX_BLOCKED_WORDS]) {
    out.push(blockedWordsSavedMessage(n), blockedWordsAuditLine(ADMIN, n));
  }
  out.push(tooManyBlockedWords(MAX_BLOCKED_WORDS + 1));
  out.push(
    ...rejectedWordsLines([
      { entry: 'b*d', problem: 'wildcard' },
      { entry: '*', problem: 'empty' },
      { entry: 'x'.repeat(61), problem: 'too_long' },
      { entry: 'a,b', problem: 'character' },
    ]),
  );
  return out;
}

describe('copy rules', () => {
  it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
    const text = everySentence().join('\n');
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/[‘’“”]/);
    expect(text).not.toMatch(/;/);
  });

  it('never says primary or secondary', () => {
    const text = everySentence().join('\n').toLowerCase();
    expect(text).not.toContain('primary');
    expect(text).not.toContain('secondary');
  });

  /** A reply is a message, and Discord refuses one past 2000 characters. */
  it('fits a message', () => {
    for (const sentence of everySentence()) expect(sentence.length).toBeLessThanOrEqual(2000);
  });
});

describe('what a member is told', () => {
  it('says the text holds a word the server does not allow, and never which', () => {
    expect(blockedWordRefusal('name')).toBe(
      "That has a word this server doesn't allow in room names. Try something else.",
    );
    expect(blockedWordRefusal('nick')).toBe(blockedWordRefusal('name'));
    expect(blockedWordRefusal('status')).toContain("in a room's status");
  });
});

describe('the /logging lines', () => {
  it('name who tried and where, as a mention, and nothing they typed', () => {
    expect(blockedWordLogLine(ADMIN, 'name')).toBe(
      `🚫 <@${ADMIN}> tried to use a blocked word in a room name.`,
    );
    expect(blockedWordLogLine(ADMIN, 'nick')).toContain('their nickname');
    expect(blockedWordLogLine(ADMIN, 'status')).toContain("a room's status");
  });

  it('name the admin and how many words, never the words', () => {
    expect(blockedWordsAuditLine(ADMIN, 3)).toBe(
      `🚫 <@${ADMIN}> changed the blocked words list. It has 3 words now.`,
    );
    expect(blockedWordsAuditLine(ADMIN, 1)).toContain('1 word now');
    expect(blockedWordsAuditLine(ADMIN, 0)).toBe(`🚫 <@${ADMIN}> emptied the blocked words list.`);
  });
});

describe('what saving the list says', () => {
  /** Where it applies, said in full: an admin who sees a word in a game title calls it a bug otherwise. */
  it('says how many words are blocked, which doors refuse them and where they show as ***', () => {
    const text = blockedWordsSavedMessage(3);
    expect(text).toContain('**3 words**');
    expect(text).toContain('`/name`');
    expect(text).toContain('`/nick`');
    expect(text).toContain('admins included');
    expect(text).toContain('room names, voice statuses and new **⇩ Join** channels');
  });

  it('says nothing is filtered for an empty list', () => {
    expect(blockedWordsSavedMessage(0)).toBe(
      'The blocked words list is empty, so nothing is filtered.',
    );
  });
});

describe('rejectedWordsLines', () => {
  it('groups by reason, and strips backticks so an entry cannot break out of its code span', () => {
    const lines = rejectedWordsLines([
      { entry: 'a*b', problem: 'wildcard' },
      { entry: 'c`*`d', problem: 'wildcard' },
      { entry: '**', problem: 'empty' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('`a*b`, `c*d`');
    expect(lines[1]).toContain('`**`');
  });

  it('quotes ten and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      entry: `a*${i}b`,
      problem: 'wildcard' as const,
    }));
    const [line] = rejectedWordsLines(many);
    expect(line).toContain('and 3 more');
    expect(line).not.toContain('a*10b');
  });

  it('says nothing when everything was saved', () => {
    expect(rejectedWordsLines([])).toEqual([]);
  });

  /** A list pasted with spaces arrives as one long entry, and the reply must still fit. */
  it('cuts a long entry short, so ten of the longest still fit a message', () => {
    const long = Array.from({ length: 10 }, (_, i) => ({
      entry: `${i}${'x'.repeat(1600)}`,
      problem: 'too_long' as const,
    }));
    const [line] = rejectedWordsLines(long);
    expect(line!.length).toBeLessThan(1000);
    expect(line).toContain('…`');
  });
});
