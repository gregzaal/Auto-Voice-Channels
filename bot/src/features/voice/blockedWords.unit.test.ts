import { describe, expect, it, vi } from 'vitest';
import { IMPORT_LIMITS } from '@avc/core';
import { fakeLogger } from '../../runtime/testUtils.js';
import {
  addsBlockedWords,
  blockedWordsText,
  MAX_BLOCKED_WORD_LENGTH,
  MAX_BLOCKED_WORDS,
  MAX_BLOCKED_WORDS_TEXT,
  parseBlockedWordsInput,
} from './blockedWords.js';
import {
  joinDisplayName,
  JOIN_OWNER_NAME_MAX,
  parseVoiceSettings,
  readBlockedWords,
  SETTINGS_KEYS,
} from './guildSettings.js';
import { GuildSettingsService } from './settings.js';

const GUILD = '460459401086763010';

describe('the caps', () => {
  /** Core cannot import the bot, so the two sets of numbers are bound here. */
  it('are the same numbers in the bot and in the importer', () => {
    expect(MAX_BLOCKED_WORDS).toBe(IMPORT_LIMITS.blockedWords);
    expect(MAX_BLOCKED_WORD_LENGTH).toBe(IMPORT_LIMITS.blockedWordChars);
    expect(MAX_BLOCKED_WORDS_TEXT).toBe(IMPORT_LIMITS.blockedWordsTotalChars);
  });

  /** AutoMod's own caps on one rule, and the box `/blockedwords` prefills. */
  it('are 1000 entries of up to 60 characters, and 4000 characters in all', () => {
    expect([MAX_BLOCKED_WORDS, MAX_BLOCKED_WORD_LENGTH, MAX_BLOCKED_WORDS_TEXT]).toEqual([
      1000, 60, 4000,
    ]);
  });
});

describe('the settings key', () => {
  it('is blocked_words', () => {
    expect(SETTINGS_KEYS.blockedWords).toBe('blocked_words');
  });
});

describe('parseBlockedWordsInput', () => {
  it('splits on line breaks and commas, trims, and drops empties', () => {
    expect(parseBlockedWordsInput('bad\r\n  worse , ,\n\nworst*,').words).toEqual([
      'bad',
      'worse',
      'worst*',
    ]);
  });

  it('keeps the first spelling of entries that differ only by case or accents', () => {
    expect(parseBlockedWordsInput('Bad\nbád\nBAD\nbad*').words).toEqual(['Bad', 'bad*']);
  });

  it('makes each run of spaces or tabs inside an entry one space', () => {
    expect(parseBlockedWordsInput('bad \t  word').words).toEqual(['bad word']);
  });

  it('refuses an entry holding a control character', () => {
    expect(parseBlockedWordsInput('a\u0007b').rejected).toEqual([
      { entry: 'a\u0007b', problem: 'character' },
    ]);
  });

  it('keeps a phrase whole', () => {
    expect(parseBlockedWordsInput('bad word\nother').words).toEqual(['bad word', 'other']);
  });

  it('reports what cannot be used and saves the rest', () => {
    const long = 'x'.repeat(MAX_BLOCKED_WORD_LENGTH + 1);
    const parsed = parseBlockedWordsInput(`fine\nb*d\n*\n${long}`);
    expect(parsed.words).toEqual(['fine']);
    expect(parsed.rejected).toEqual([
      { entry: 'b*d', problem: 'wildcard' },
      { entry: '*', problem: 'empty' },
      { entry: long, problem: 'too_long' },
    ]);
  });

  it('reads an empty box as an empty list', () => {
    expect(parseBlockedWordsInput('  \n ')).toEqual({ words: [], rejected: [] });
  });
});

describe('addsBlockedWords', () => {
  it('is true only for an entry the list does not already hold, by case and accents', () => {
    expect(addsBlockedWords(['bad', 'worse'], ['bad'])).toBe(false);
    expect(addsBlockedWords(['bad'], ['BÁD'])).toBe(false);
    expect(addsBlockedWords(['bad'], [])).toBe(false);
    expect(addsBlockedWords(['bad'], ['bad*'])).toBe(true);
    expect(addsBlockedWords([], ['bad'])).toBe(true);
  });
});

describe('readBlockedWords', () => {
  it('reads strings only, drops blanks, and caps the count', () => {
    expect(readBlockedWords({ blocked_words: ['bad', 3, '', '  ', null, 'worse'] })).toEqual([
      'bad',
      'worse',
    ]);
    expect(readBlockedWords({ blocked_words: 'bad' })).toEqual([]);
    expect(readBlockedWords({})).toEqual([]);
    const many = Array.from({ length: MAX_BLOCKED_WORDS + 5 }, (_, i) => `w${i}`);
    expect(readBlockedWords({ blocked_words: many })).toHaveLength(MAX_BLOCKED_WORDS);
  });

  /** `SettingsCache` hands every caller the same row, so a stored array must never escape. */
  it('returns a fresh array every call', () => {
    const stored = ['bad'];
    const read = readBlockedWords({ blocked_words: stored });
    expect(read).not.toBe(stored);
    read.push('worse');
    expect(stored).toEqual(['bad']);
  });

  it('reaches the voice settings every render reads', () => {
    expect(parseVoiceSettings({ blocked_words: ['bad'] }, GUILD).blockedWords).toEqual(['bad']);
    expect(parseVoiceSettings({}, GUILD).blockedWords).toEqual([]);
  });
});

describe('joinDisplayName', () => {
  const member = { id: '111111111111111111', displayName: 'BadGuy' };

  it('masks the blocked words in the name a Join channel shows', () => {
    const settings = parseVoiceSettings({ blocked_words: ['bad*'] }, GUILD);
    expect(joinDisplayName(settings, member)).toBe('***');
  });

  it('masks a saved nickname too', () => {
    const settings = parseVoiceSettings(
      { blocked_words: ['bad'], custom_nicks: { [member.id]: 'so bad' } },
      GUILD,
    );
    expect(joinDisplayName(settings, member)).toBe('so ***');
  });

  it('leaves the name exactly as it was without a list', () => {
    expect(joinDisplayName(parseVoiceSettings({}, GUILD), member)).toBe('BadGuy');
  });

  /** "⇩ Join " plus the name has to fit a 100-character channel name, or the create fails. */
  it('keeps a name that masking made longer inside the Join channel limit', () => {
    const nick = 'ab '.repeat(26).trim();
    const settings = parseVoiceSettings(
      { blocked_words: ['ab'], custom_nicks: { [member.id]: nick } },
      GUILD,
    );
    const name = joinDisplayName(settings, member);
    expect(name.length).toBeLessThanOrEqual(JOIN_OWNER_NAME_MAX);
    expect(`⇩ Join ${name}`.length).toBeLessThanOrEqual(100);
    expect(name).not.toMatch(/ab/);
  });
});

/**
 * The service over a `mergeSettings` that applies what `decide` returns to an in-memory
 * settings blob, the way the real one does under the row lock.
 */
function makeService(initial: Record<string, unknown> = {}) {
  let settings: Record<string, unknown> = initial;
  const writes: { patch: Record<string, unknown>; remove: readonly string[] }[] = [];
  const mergeSettings = vi.fn(
    (
      _guildId: string,
      decide: (existing: { authStatus: string; settings: Record<string, unknown> }) => {
        patch: Record<string, unknown>;
        remove?: readonly string[];
        result: unknown;
      },
    ) => {
      const decided = decide({ authStatus: 'active', settings });
      writes.push({ patch: decided.patch, remove: decided.remove ?? [] });
      settings = { ...settings, ...decided.patch };
      for (const key of decided.remove ?? []) delete settings[key];
      return Promise.resolve(decided.result);
    },
  );
  const service = new GuildSettingsService({
    guilds: {
      ensure: vi.fn(() => Promise.resolve({ settings })),
      updateSettings: vi.fn(),
      mergeSettings,
    } as never,
    autoChannels: {} as never,
    secondaries: {} as never,
    actions: {} as never,
    logger: fakeLogger(),
  });
  return { service, writes, stored: () => settings };
}

describe('setBlockedWords', () => {
  it('stores the list whole, and says how many and that it changed', async () => {
    const { service, stored } = makeService();
    const result = await service.setBlockedWords(GUILD, ['bad', 'worse*']);
    expect(result).toEqual({ ok: true, message: '', changed: true, count: 2 });
    expect(stored().blocked_words).toEqual(['bad', 'worse*']);
  });

  it('removes the key when the list is emptied, so nothing blocked is the absence of it', async () => {
    const { service, writes, stored } = makeService({ blocked_words: ['bad'] });
    const result = await service.setBlockedWords(GUILD, []);
    expect(result).toMatchObject({ ok: true, changed: true, count: 0 });
    expect(writes).toEqual([{ patch: {}, remove: ['blocked_words'] }]);
    expect(stored()).not.toHaveProperty('blocked_words');
  });

  it('writes nothing when the list is the one already stored', async () => {
    const { service, writes } = makeService({ blocked_words: ['bad', 'worse'] });
    const result = await service.setBlockedWords(GUILD, ['bad', 'worse']);
    expect(result).toMatchObject({ ok: true, changed: false, count: 2 });
    expect(writes).toEqual([{ patch: {}, remove: [] }]);
  });

  it('drops an entry the matcher cannot use, if a caller passes one', async () => {
    const { service, stored } = makeService();
    await service.setBlockedWords(GUILD, ['bad', 'b*d']);
    expect(stored().blocked_words).toEqual(['bad']);
  });

  it('refuses more entries than a server may block, and writes nothing', async () => {
    const { service, writes } = makeService();
    const many = Array.from({ length: MAX_BLOCKED_WORDS + 1 }, (_, i) => `w${i}`);
    const result = await service.setBlockedWords(GUILD, many);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`up to ${MAX_BLOCKED_WORDS}`);
    expect(writes).toEqual([]);
  });

  it('refuses a list longer than the box that edits it, and writes nothing', async () => {
    const { service, writes } = makeService();
    const long = Array.from({ length: 100 }, (_, i) => `${'x'.repeat(40)}${i}`);
    expect(blockedWordsText(long).length).toBeGreaterThan(MAX_BLOCKED_WORDS_TEXT);
    const result = await service.setBlockedWords(GUILD, long);
    expect(result.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  describe('in a lapsed server (refuseAdditions)', () => {
    it('writes a save that only takes entries away', async () => {
      const { service, stored } = makeService({ blocked_words: ['bad', 'worse'] });
      const result = await service.setBlockedWords(GUILD, ['bad'], { refuseAdditions: true });
      expect(result).toMatchObject({ ok: true, changed: true, count: 1 });
      expect(stored().blocked_words).toEqual(['bad']);
    });

    it('writes nothing for a save that adds an entry, and says so', async () => {
      const { service, writes, stored } = makeService({ blocked_words: ['bad'] });
      const result = await service.setBlockedWords(GUILD, ['bad', 'worse'], {
        refuseAdditions: true,
      });
      expect(result).toMatchObject({ ok: false, changed: false, refusedAddition: true });
      expect(writes).toEqual([{ patch: {}, remove: [] }]);
      expect(stored().blocked_words).toEqual(['bad']);
    });

    it('lets an emptied list through, which only removes', async () => {
      const { service, stored } = makeService({ blocked_words: ['bad'] });
      await service.setBlockedWords(GUILD, [], { refuseAdditions: true });
      expect(stored()).not.toHaveProperty('blocked_words');
    });
  });
});
