import { describe, expect, it } from 'vitest';
import { buildAliasModal } from './aliasModal.js';

/** The game field's prefilled value, as the modal will send it. */
const prefill = (game: string): string | undefined => {
  const json = buildAliasModal(game).toJSON() as {
    components: { components: { custom_id: string; value?: string }[] }[];
  };
  return json.components.flatMap((row) => row.components).find((c) => c.custom_id === 'game')
    ?.value;
};

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('buildAliasModal', () => {
  /**
   * The prefilled game becomes the alias key the server stores, and Postgres refuses a key
   * holding half of a surrogate pair, so the alias was never saved.
   */
  it('never prefills half of a pair, at the 100-unit cut or from the game itself', () => {
    expect(prefill(`${'a'.repeat(99)}😀`)).toBe('a'.repeat(99));
    expect(prefill('Half \uD83C game')).toBe('Half \uFFFD game');
    expect(prefill(`${'a'.repeat(99)}😀`)).not.toMatch(LONE);
  });
});
