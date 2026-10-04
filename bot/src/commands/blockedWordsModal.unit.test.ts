import { describe, expect, it } from 'vitest';
import { MAX_BLOCKED_WORDS_TEXT } from '../features/voice/blockedWords.js';
import { BLOCKED_WORDS_MODAL_ID, buildBlockedWordsModal } from './blockedWordsModal.js';

/** The box `/blockedwords` opens, as Discord receives it. */
interface Box {
  label: string;
  description?: string;
  component: {
    custom_id: string;
    style: number;
    required?: boolean;
    max_length?: number;
    placeholder?: string;
    value?: string;
  };
}

function modal(words: string[], opts: { paused?: boolean } = {}) {
  return buildBlockedWordsModal(words, opts).toJSON() as unknown as {
    custom_id: string;
    title: string;
    components: Box[];
  };
}

describe('buildBlockedWordsModal', () => {
  it('is one paragraph box, prefilled with the list one entry per line', () => {
    const json = modal(['bad', 'worse*', 'bad word']);
    expect(json.custom_id).toBe(BLOCKED_WORDS_MODAL_ID);
    expect(json.components).toHaveLength(1);
    const box = json.components[0]!.component;
    expect(box.style).toBe(2);
    expect(box.value).toBe('bad\nworse*\nbad word');
    expect(box.max_length).toBe(MAX_BLOCKED_WORDS_TEXT);
  });

  /** Emptying the box and submitting is how an admin blocks nothing. */
  it('is not required, and carries no value for an empty list', () => {
    const box = modal([]).components[0]!.component;
    expect(box.required).toBe(false);
    expect(box.value).toBeUndefined();
  });

  it('says when word filtering is switched off for now', () => {
    expect(modal(['bad'], { paused: true }).components[0]!.description).toBe(
      'Word filtering is switched off for now. You can still change the list.',
    );
    expect(modal(['bad']).components[0]!.description).not.toContain('switched off');
  });

  /** Discord caps a modal title and a label at 45, a description and a placeholder at 100. */
  it('stays inside Discord’s limits', () => {
    for (const paused of [true, false]) {
      const json = modal(['bad'], { paused });
      expect(json.title.length).toBeLessThanOrEqual(45);
      for (const c of json.components) {
        expect(c.label.length).toBeLessThanOrEqual(45);
        expect((c.description ?? '').length).toBeLessThanOrEqual(100);
        expect((c.component.placeholder ?? '').length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('follows the copy rules in everything it says', () => {
    for (const paused of [true, false]) {
      const text = JSON.stringify(modal(['x'], { paused }));
      expect(text).not.toMatch(/[—–‘’“”;]/);
      expect(text.toLowerCase()).not.toMatch(/primary|secondary/);
    }
  });
});
