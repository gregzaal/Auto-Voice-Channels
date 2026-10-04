import { describe, expect, it } from 'vitest';
import {
  BLOCKED_WORD_MASK,
  blockedWordKey,
  blockedWordProblem,
  compileBlockedWords,
  findBlocked,
  findBlockedInTemplate,
  keepBlockedWords,
  maskBlocked,
  maskBlockedInTemplate,
  maskBlockedWithin,
  parseBlockedWord,
} from './blockedWords.js';
import { MAX_CHANNEL_NAME_LENGTH, MAX_STATUS_LENGTH, renderChannelName } from './nameTemplate.js';

/**
 * The matcher behind `/blockedwords`. The rules are Discord AutoMod's custom keywords:
 * a plain entry is a whole word, `word*` a word starting with it, `*word` a word ending
 * with it, `*word*` anywhere. A word boundary is any character, as written, that is not a
 * Unicode letter or number. Case and accents are folded on both sides.
 */
const mask = (text: string, ...list: string[]): string => maskBlocked(text, list);

describe('a plain entry matches whole words only', () => {
  it('matches the word on its own and between punctuation, emoji and spaces', () => {
    expect(mask('bad', 'bad')).toBe('***');
    expect(mask('so bad!', 'bad')).toBe('so ***!');
    expect(mask('(bad)', 'bad')).toBe('(***)');
    expect(mask('🍆bad🍆', 'bad')).toBe('🍆***🍆');
    expect(mask('bad_room', 'bad')).toBe('***_room');
    expect(mask("it's bad's", 'bad')).toBe("it's ***'s");
  });

  it('does not match inside a longer word, or beside a digit', () => {
    expect(mask('badge', 'bad')).toBe('badge');
    expect(mask('abad', 'bad')).toBe('abad');
    expect(mask('bad2', 'bad')).toBe('bad2');
    expect(mask('2bad', 'bad')).toBe('2bad');
  });

  it('treats letters of any script as part of a word', () => {
    expect(mask('badé', 'bad')).toBe('badé');
    expect(mask('яbad', 'bad')).toBe('яbad');
  });

  /** `™` folds to `tm`, but as written it is a symbol, so it ends the word. */
  it('judges a boundary on the character as written, so a symbol that folds to letters ends a word', () => {
    expect(mask('bad™ room', 'bad')).toBe('***™ room');
    expect(mask('bad㎏', 'bad')).toBe('***㎏');
    expect(findBlocked('bad™', ['bad'])).not.toBeNull();
  });

  it('does not match part of one character, which is inside a word', () => {
    // `ﬁ` folds to `fi`, and `f` alone is half of it.
    expect(mask('ﬁ', 'f')).toBe('ﬁ');
    expect(mask('ﬁ', 'fi')).toBe('***');
  });

  it('matches a word made of digits by the same boundary rule', () => {
    expect(mask('room 69 here', '69')).toBe('room *** here');
    expect(mask('room 690', '69')).toBe('room 690');
  });

  it('needs a wildcard to match inside text written without spaces', () => {
    expect(mask('好坏人', '坏')).toBe('好坏人');
    expect(mask('好 坏 人', '坏')).toBe('好 *** 人');
    expect(mask('好坏人', '*坏*')).toBe('好***人');
  });
});

describe('wildcards', () => {
  it('word* matches words that start with it, and masks the whole word', () => {
    expect(mask('badger and bad', 'bad*')).toBe('*** and ***');
    expect(mask('so badger2!', 'bad*')).toBe('so ***!');
    expect(mask('abad', 'bad*')).toBe('abad');
  });

  it('*word matches words that end with it, and masks the whole word', () => {
    expect(mask('abad and bad', '*bad')).toBe('*** and ***');
    expect(mask('badge', '*bad')).toBe('badge');
  });

  it('widens only for the kind that matched', () => {
    // `bad` the word and `*bad` the ending, in a word that only the ending matches.
    expect(mask('abad bad', 'bad', '*bad')).toBe('*** ***');
    // `bad*` the start, in a word it does not start: `*bad*` matched, so only `bad` goes.
    expect(mask('abadge', 'bad*', '*bad*')).toBe('a***ge');
  });

  /** Every entry is tried at every position, not only the first or longest that fits. */
  it('finds every match at a position, whichever entry is shorter', () => {
    expect(mask('badger', 'ba*', '*bad*')).toBe('***');
  });

  it('*word* matches anywhere, inside other words too', () => {
    expect(mask('abadge', '*bad*')).toBe('a***ge');
  });

  it('refuses a * anywhere but the start or the end', () => {
    expect(blockedWordProblem('b*d', 60)).toBe('wildcard');
    expect(blockedWordProblem('**bad', 60)).toBe('wildcard');
    expect(blockedWordProblem('***', 60)).toBe('wildcard');
    expect(parseBlockedWord('b*d')).toBeNull();
    // An entry that cannot be used is skipped, and the rest of the list still works.
    expect(mask('b*d bad', 'b*d', 'bad')).toBe('b*d ***');
  });

  /** A character that folds to `*` is judged as one, or it could match the mask itself. */
  it('reads a character that folds to * as one', () => {
    expect(blockedWordProblem('＊', 60)).toBe('empty');
    expect(blockedWordProblem('﹡', 60)).toBe('empty');
    expect(blockedWordProblem('*＊*', 60)).toBe('wildcard');
    expect(blockedWordProblem('ba＊d', 60)).toBe('wildcard');
    // At an edge it is a wildcard like any other.
    expect(parseBlockedWord('＊bad')).toEqual({ kind: 'suffix', core: 'bad' });
  });

  it('refuses an entry with no letter or number to match', () => {
    for (const entry of ['', ' ', '*', '**', '* *', '\u0301', '\u200b', ':)', '🍆', '!!!']) {
      expect(blockedWordProblem(entry, 60), JSON.stringify(entry)).toBe('empty');
    }
  });
});

describe('phrases', () => {
  it('matches a phrase as a whole, across any run of whitespace', () => {
    expect(mask('a very bad word here', 'bad word')).toBe('a very *** here');
    expect(mask('very bad  word', 'bad word')).toBe('very ***');
    expect(mask('bad\u00a0word', 'bad word')).toBe('***');
    expect(mask('bad\tword', 'bad  word')).toBe('***');
  });

  it('keeps the boundary rule at both ends of a phrase', () => {
    expect(mask('abad words', 'bad word')).toBe('abad words');
    expect(mask('abad words', '*bad word*')).toBe('a***s');
  });
});

describe('folding', () => {
  it('ignores case on both sides', () => {
    expect(mask('BaD', 'bad')).toBe('***');
    expect(mask('bad', 'BAD')).toBe('***');
  });

  it('ignores accents on both sides, and masks the accented original', () => {
    expect(mask('bád', 'bad')).toBe('***');
    expect(mask('bad', 'bád')).toBe('***');
    // Decomposed: the combining accent goes with the word, not left behind.
    expect(mask('ba\u0301d!', 'bad')).toBe('***!');
    expect(mask('bad\u0301 x', 'bad')).toBe('*** x');
    // And a decomposed accent does not end a word early.
    expect(mask('ba\u0301d', 'ba')).toBe('ba\u0301d');
  });

  it('reads styled letters as the letters they are', () => {
    // The math-bold letters `""bold:bad""` renders, and the full-width ones.
    expect(mask('𝐛𝐚𝐝 room', 'bad')).toBe('*** room');
    expect(mask('ｂａｄ', 'bad')).toBe('***');
  });

  it('ignores invisible characters put inside a word to split it', () => {
    expect(mask('b\u200bad', 'bad')).toBe('***');
    expect(mask('b\u00adad', 'bad')).toBe('***');
  });

  /** Lower case one character at a time cannot know a sigma is final, so both are sigma. */
  it('reads a final sigma as a sigma, both ways round', () => {
    expect(mask('οδος', 'ΟΔΟΣ')).toBe('***');
    expect(findBlocked('ΟΔΟΣ', ['οδος'])).not.toBeNull();
    expect(blockedWordKey('ΟΔΟΣ')).toBe(blockedWordKey('οδος'));
  });

  it('keys entries the way it matches them, for de-duplication', () => {
    expect(blockedWordKey(' Bád  Word ')).toBe('bad word');
    expect(blockedWordKey('BAD*')).toBe(blockedWordKey('bad*'));
    expect(blockedWordKey('＊bad')).toBe(blockedWordKey('*bad'));
  });
});

describe('masking', () => {
  it('leaves the rest of the text exactly as it was', () => {
    expect(mask('🎮 Halo with bad people 🔥', 'bad')).toBe('🎮 Halo with *** people 🔥');
  });

  it('masks every match, and repeats', () => {
    expect(mask('bad, bad, bad', 'bad')).toBe('***, ***, ***');
  });

  it('masks matches that overlap or touch as one', () => {
    expect(mask('foobar', '*foo*', '*oba*')).toBe('***r');
    expect(mask('foobar', '*foo*', '*foobar*')).toBe('***');
    expect(mask('BADBAD', '*bad*')).toBe('***');
  });

  /** One pass, judged on the text as written: in `foobar`, `foo` is not a whole word. */
  it('masks in one pass over the text as written', () => {
    expect(mask('foobar', 'foo', '*bar*')).toBe('foo***');
  });

  it('takes a skin tone with the word it follows', () => {
    expect(mask('so bad🏽 ok', 'bad')).toBe('so *** ok');
  });

  it('changes nothing for an empty list, or a list with nothing usable', () => {
    expect(mask('bad')).toBe('bad');
    expect(mask('bad', '*', 'b*d')).toBe('bad');
    expect(compileBlockedWords([]).size).toBe(0);
  });

  it('never matches its own mask', () => {
    expect(mask(BLOCKED_WORD_MASK, 'bad', '*a*', '＊')).toBe(BLOCKED_WORD_MASK);
  });

  /**
   * A hostile list cannot make masking feed on itself: before entries were judged folded,
   * `＊` became an entry that matched the mask, and each pass grew the text until the
   * process ran out of memory.
   */
  it('stays put and fast with an entry that reads as the mask', () => {
    const started = performance.now();
    expect(maskBlockedWithin('my * room', ['＊'], 100)).toBe('my * room');
    expect(maskBlockedWithin('bad room', ['bad', '＊', '*＊*'], 100)).toBe('*** room');
    expect(maskBlockedWithin('*'.repeat(500), ['bad', '＊'], Number.MAX_SAFE_INTEGER)).toHaveLength(
      500,
    );
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('maskBlockedWithin', () => {
  it('returns the text exactly as it was for an empty list, untrimmed and uncut', () => {
    expect(maskBlockedWithin('  ab ab  ', [], 3)).toBe('  ab ab  ');
  });

  it('masks, trims and cuts so the result fits and holds no match', () => {
    expect(maskBlockedWithin(' ab ab ab ', ['ab'], 9)).toBe('*** *** *');
    expect(maskBlockedWithin('fine', ['ab'], 9)).toBe('fine');
  });
});

describe('findBlocked', () => {
  it('says where the first match is, in the original text', () => {
    expect(findBlocked('so Bád!', ['bad'])).toEqual({ start: 3, end: 6 });
    expect(findBlocked('fine', ['bad'])).toBeNull();
    expect(findBlocked('bad', [])).toBeNull();
  });
});

/** A name or a status is a template: its typed text is judged, its syntax is not. */
describe('templates', () => {
  it('judges only the text a member typed, never a token or a variable name', () => {
    expect(findBlockedInTemplate('@@game_name@@ room', ['game'])).toBe(false);
    expect(findBlockedInTemplate('{{LIVE ?? on air // off}}', ['live'])).toBe(false);
    expect(findBlockedInTemplate("@@owner@@'s den", ['owner'])).toBe(false);
    expect(findBlockedInTemplate('[[list:bad]] room', ['bad'])).toBe(false);
    expect(findBlockedInTemplate('""scaps:hi""', ['scaps'])).toBe(false);
  });

  it('finds a blocked word in the typed text, a branch or a random pick included', () => {
    expect(findBlockedInTemplate('my bad room', ['bad'])).toBe(true);
    expect(findBlockedInTemplate('{{LIVE ?? bad // fine}}', ['bad'])).toBe(true);
    expect(findBlockedInTemplate('[[good/bad]] ##', ['bad'])).toBe(true);
    expect(findBlockedInTemplate('""scaps:bad""', ['bad'])).toBe(true);
    expect(findBlockedInTemplate('my bad room', [])).toBe(false);
  });

  it('masks the typed text of a template and leaves its syntax readable', () => {
    expect(maskBlockedInTemplate('@@game_name@@ bad ##', ['game', 'bad'])).toBe(
      '@@game_name@@ *** ##',
    );
    expect(maskBlockedInTemplate('{{LIVE ?? bad}}', ['live', 'bad'])).toBe('{{LIVE ?? ***}}');
  });
});

describe('keepBlockedWords', () => {
  it('keeps the usable entries trimmed, drops repeats quietly and counts the rest', () => {
    expect(keepBlockedWords([' bad ', 'BÁD', 'b*d', 42, '＊', 'worse*'], 60)).toEqual({
      kept: ['bad', 'worse*'],
      unusable: 3,
    });
  });
});

describe('compileBlockedWords', () => {
  it('compiles a list once and reuses it', () => {
    expect(compileBlockedWords(['bad', 'worse*'])).toBe(compileBlockedWords(['bad', 'worse*']));
    expect(compileBlockedWords(['bad'])).not.toBe(compileBlockedWords(['worse']));
  });

  /** Two lists must never share a key: one guild's list switching another's off. */
  it('keys a list unambiguously, whatever its entries hold', () => {
    const joined = compileBlockedWords(['a\u0000b']);
    const apart = compileBlockedWords(['a', 'b']);
    expect(joined).not.toBe(apart);
    expect(maskBlocked('a b', ['a', 'b'])).toBe('*** ***');
  });

  it('counts the usable entries, once each', () => {
    expect(compileBlockedWords(['bad', 'BÁD', 'bad*', 'b*d']).size).toBe(2);
  });

  it('copes with a full list of a thousand entries', () => {
    const list = Array.from({ length: 1000 }, (_, i) => `word${i}*`);
    const started = performance.now();
    const matcher = compileBlockedWords(list);
    for (let i = 0; i < 200; i++) matcher.mask(`a room called word999x and word5 ${i}`);
    expect(matcher.mask('word999x')).toBe('***');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('blockedWordProblem', () => {
  it('caps the length of the entry as typed, wildcards included', () => {
    expect(blockedWordProblem('a'.repeat(60), 60)).toBeNull();
    expect(blockedWordProblem('a'.repeat(61), 60)).toBe('too_long');
    expect(blockedWordProblem(`*${'a'.repeat(59)}*`, 60)).toBe('too_long');
  });

  it('refuses the separators the list is split on, and control characters', () => {
    expect(blockedWordProblem('bad,word', 60)).toBe('character');
    expect(blockedWordProblem('bad\nword', 60)).toBe('character');
    expect(blockedWordProblem('a\u0000b', 60)).toBe('character');
    expect(blockedWordProblem('a\u0085b', 60)).toBe('character');
    // A tab is whitespace, and a phrase may hold one.
    expect(blockedWordProblem('bad\tword', 60)).toBeNull();
  });

  it('accepts the four shapes, a phrase and a word with an emoji in it', () => {
    for (const entry of ['bad', 'bad*', '*bad', '*bad*', 'bad word', 'bad🍆', '69']) {
      expect(blockedWordProblem(entry, 60), entry).toBeNull();
    }
  });
});

/**
 * The engine applies the list to the finished text, so every render path masks the same
 * way, whatever put the word there.
 */
describe('renderChannelName with blocked words', () => {
  const member = (id: string, displayName: string, playing: string[] = []) => ({
    id,
    displayName,
    bot: false,
    playing,
  });

  it('masks a display name, a game title and the template text alike', () => {
    const owner = member('o', 'BadGuy', ['Bad Game']);
    const ctx = {
      index: 0,
      members: [owner],
      creator: owner,
      creatorName: 'BadGuy',
      blockedWords: ['bad*'],
    };
    expect(renderChannelName("@@owner@@'s @@game_name@@ bad den", ctx)).toBe(
      "***'s *** Game *** den",
    );
  });

  it('masks the voice status too', () => {
    const owner = member('o', 'Sam', ['Bad Game']);
    const ctx = { index: 0, members: [owner], creator: owner, blockedWords: ['bad'] };
    expect(
      renderChannelName('Playing @@game_name@@', ctx, {
        maxLength: MAX_STATUS_LENGTH,
        allowEmpty: true,
      }),
    ).toBe('Playing *** Game');
  });

  /** Small caps and upside-down write characters that no longer read as letters. */
  it('masks a game title inside a small-caps or upside-down transform', () => {
    const owner = member('o', 'Sam', ['Bad Game']);
    const ctx = { index: 0, members: [owner], creator: owner, blockedWords: ['bad'] };
    const caps = renderChannelName('""scaps:@@game_name@@""', ctx);
    expect(caps.startsWith('***')).toBe(true);
    expect(
      renderChannelName('""scaps:@@game_name@@""', { ...ctx, blockedWords: [] }),
    ).not.toContain('***');
    expect(renderChannelName('""usd:@@game_name@@""', ctx)).toContain('***');
  });

  it('changes nothing without a list', () => {
    expect(renderChannelName('bad room', { index: 0, members: [] })).toBe('bad room');
    expect(renderChannelName('bad room', { index: 0, members: [], blockedWords: [] })).toBe(
      'bad room',
    );
  });

  it('still holds the length clamp when masking makes the name longer', () => {
    const name = renderChannelName('ab '.repeat(40), {
      index: 0,
      members: [],
      blockedWords: ['ab'],
    });
    expect(name.length).toBeLessThanOrEqual(MAX_CHANNEL_NAME_LENGTH);
    expect(name).not.toMatch(/\bab\b/);
  });

  it('masks a word the clamp cut a longer word down to', () => {
    // 96 characters of padding, a space and `hello`, cut at 100 to end on `hel`.
    const name = renderChannelName(`${'x'.repeat(96)} hello`, {
      index: 0,
      members: [],
      blockedWords: ['hel'],
    });
    expect(name).toBe(`${'x'.repeat(96)} ***`);
  });

  it('renders a name that is nothing but a blocked word as the mask, never empty', () => {
    expect(renderChannelName('bad', { index: 0, members: [], blockedWords: ['bad'] })).toBe('***');
  });
});
