import { describe, expect, it } from 'vitest';
import {
  ALIAS_PAGE_SIZE,
  ALIAS_SELECT_ID,
  aliasHash,
  aliasId,
  aliasPageCount,
  buildAliasDetailPanel,
  buildAliasEditModal,
  buildAliasListPanel,
  findAliasByHash,
  parseAliasId,
  sortAliases,
} from './aliasPanel.js';

/** Reads the button labels out of a built panel, in row and column order. */
const labelsOf = (panel: { components?: unknown }): string[] =>
  (panel.components as { components: { data: { label?: string } }[] }[])
    .flatMap((row) => row.components.map((c) => c.data.label))
    // The select menu has a placeholder, not a label, so it drops out here.
    .filter((l): l is string => l !== undefined);

/** The buttons of a built panel, as `label -> disabled`. */
const buttonsOf = (panel: { components?: unknown }): Record<string, boolean> =>
  Object.fromEntries(
    (panel.components as { components: { data: { label?: string; disabled?: boolean } }[] }[])
      .flatMap((row) => row.components.map((c) => c.data))
      .filter((d) => d.label !== undefined)
      .map((d) => [d.label!, d.disabled ?? false]),
  );

/** The select menu's options, as the plain data Discord will receive. */
const optionsOf = (panel: {
  components?: unknown;
}): { value: string; label: string; description: string }[] => {
  const row = (panel.components as { components: { options?: { toJSON(): unknown }[] }[] }[])[0]!;
  const options = row.components[0]!.options ?? [];
  return options.map((o) => o.toJSON() as { value: string; label: string; description: string });
};

/** Every custom id anywhere in a built panel. */
const idsOf = (panel: unknown): string[] =>
  Array.from(JSON.stringify(panel).matchAll(/"custom_id":"([^"]+)"/g)).map((m) => m[1]!);

const many = (n: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`Game ${i}`, `G${i}`]));

describe('aliasPanel ids', () => {
  it('round-trips and validates alias component ids', () => {
    expect(parseAliasId(aliasId('add'))).toEqual({ action: 'add', arg: null });
    expect(parseAliasId(aliasId('close'))).toEqual({ action: 'close', arg: null });
    expect(parseAliasId(aliasId('back'))).toEqual({ action: 'back', arg: null });
    expect(parseAliasId(aliasId('page', '2'))).toEqual({ action: 'page', arg: '2' });
    expect(parseAliasId(aliasId('edit', 'deadbeef'))).toEqual({ action: 'edit', arg: 'deadbeef' });
    expect(parseAliasId(aliasId('remove', 'deadbeef'))).toEqual({
      action: 'remove',
      arg: 'deadbeef',
    });
    expect(parseAliasId(aliasId('save', 'deadbeef'))).toEqual({ action: 'save', arg: 'deadbeef' });
  });

  it('rejects malformed ids and another feature namespace', () => {
    expect(parseAliasId('avc:alias:bogus')).toBeNull();
    expect(parseAliasId('avc:alias:')).toBeNull();
    expect(parseAliasId('avc:group:below:cat-1')).toBeNull();
    expect(parseAliasId('avc:tpl:edit:channel:name:1')).toBeNull();
  });

  it('keeps the retired bare id out of the panel namespace', () => {
    // `avc:alias` is the pre-panel Add modal id, routed by exact match. It must
    // not parse as a panel action, or the ladder would swallow it.
    expect(parseAliasId('avc:alias')).toBeNull();
  });

  it('hashes a game name to something short, stable and id-safe', () => {
    const h = aliasHash('The Witcher 3: Wild Hunt');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(h).toBe(aliasHash('The Witcher 3: Wild Hunt'));
    expect(h).not.toBe(aliasHash('The Witcher 3'));
  });

  it('keeps every id well inside Discord 100-character limit, even for a long game name', () => {
    const game = 'x'.repeat(100);
    const panel = buildAliasDetailPanel(game, 'y'.repeat(100));
    for (const id of idsOf(panel)) expect(id.length).toBeLessThan(100);
    expect(idsOf(buildAliasEditModal(game, 'y'.repeat(100)))[0]!.length).toBeLessThan(100);
  });
});

describe('findAliasByHash', () => {
  it('resolves a hash back to its pair, including a name containing a colon', () => {
    const aliases = { 'The Witcher 3: Wild Hunt': 'The Witcher 3', 'Counter-Strike 2': 'CS2' };
    expect(findAliasByHash(aliases, aliasHash('The Witcher 3: Wild Hunt'))).toEqual({
      game: 'The Witcher 3: Wild Hunt',
      alias: 'The Witcher 3',
    });
  });

  it('returns null for an alias that has been removed since the panel opened', () => {
    expect(findAliasByHash({ 'Counter-Strike 2': 'CS2' }, aliasHash('Apex Legends'))).toBeNull();
  });

  it('does not resolve an inherited property as an alias', () => {
    // A game called "constructor" is a legal key, and `in` would find the one on
    // Object.prototype. Only an own entry may ever resolve.
    expect(findAliasByHash({}, aliasHash('constructor'))).toBeNull();
    expect(findAliasByHash({ constructor: 'Ctor' }, aliasHash('constructor'))).toEqual({
      game: 'constructor',
      alias: 'Ctor',
    });
  });
});

describe('sortAliases', () => {
  it('sorts case-insensitively by game name, as the legacy listing did', () => {
    const sorted = sortAliases({ zeta: 'z', Alpha: 'a', beta: 'b' });
    expect(sorted.map(([g]) => g)).toEqual(['Alpha', 'beta', 'zeta']);
  });
});

describe('buildAliasListPanel', () => {
  it('is ephemeral and offers only Add and Close when there are no aliases', () => {
    const panel = buildAliasListPanel({});
    expect(panel.ephemeral).toBe(true);
    expect(labelsOf(panel)).toEqual(['Add', 'Close']);
    expect(JSON.stringify(panel)).toContain('No aliases yet');
    // No picker when there is nothing to pick.
    expect(idsOf(panel)).not.toContain(ALIAS_SELECT_ID);
  });

  it('lists the aliases and offers a picker keyed by hash, not by the game name', () => {
    const panel = buildAliasListPanel({ 'The Witcher 3: Wild Hunt': 'The Witcher 3' });
    const json = JSON.stringify(panel);
    expect(json).toContain('The Witcher 3: Wild Hunt');
    expect(json).toContain(ALIAS_SELECT_ID);
    expect(json).toContain(`"value":"${aliasHash('The Witcher 3: Wild Hunt')}"`);
    expect(labelsOf(panel)).toEqual(['Add', 'Close']);
  });

  it('survives a game name longer than a select option value accepts', () => {
    // Discord throws outright past 100 characters, and an imported legacy alias
    // is bounded by nothing. The value is the 8-char hash for exactly this.
    const game = 'g'.repeat(400);
    const option = optionsOf(buildAliasListPanel({ [game]: 'a'.repeat(400) }))[0]!;
    expect(option.value).toBe(aliasHash(game));
    expect(option.value.length).toBeLessThanOrEqual(100);
  });

  it('shows no pagination at exactly one full page', () => {
    const panel = buildAliasListPanel(many(ALIAS_PAGE_SIZE));
    expect(aliasPageCount(ALIAS_PAGE_SIZE)).toBe(1);
    expect(labelsOf(panel)).toEqual(['Add', 'Close']);
  });

  it('paginates past one page, disabling Previous on the first page', () => {
    const panel = buildAliasListPanel(many(ALIAS_PAGE_SIZE + 1));
    expect(aliasPageCount(ALIAS_PAGE_SIZE + 1)).toBe(2);
    expect(labelsOf(panel)).toEqual(['Add', 'Previous', 'Next', 'Close']);
    expect(JSON.stringify(panel)).toContain('Page 1 of 2');
    expect(buttonsOf(panel)).toMatchObject({ Previous: true, Next: false });
  });

  it('disables Next on the last page and offers only the remainder', () => {
    const panel = buildAliasListPanel(many(ALIAS_PAGE_SIZE + 1), { page: 1 });
    expect(JSON.stringify(panel)).toContain('Page 2 of 2');
    expect(buttonsOf(panel)).toMatchObject({ Previous: false, Next: true });
    const options = optionsOf(panel);
    expect(options).toHaveLength(1);
  });

  it('never offers more options than a select menu accepts', () => {
    const panel = buildAliasListPanel(many(ALIAS_PAGE_SIZE * 2 + 1));
    const options = optionsOf(panel);
    expect(options).toHaveLength(ALIAS_PAGE_SIZE);
    expect(aliasPageCount(ALIAS_PAGE_SIZE * 2 + 1)).toBe(3);
  });

  it('clamps a page index past the end, so removing the last alias cannot strand the panel', () => {
    const panel = buildAliasListPanel({ 'Counter-Strike 2': 'CS2' }, { page: 7 });
    expect(JSON.stringify(panel)).toContain('Counter-Strike 2');
    expect(labelsOf(panel)).toEqual(['Add', 'Close']);
  });

  it('keeps the embed description inside Discord limit with a full page of long names', () => {
    const long = Object.fromEntries(
      Array.from({ length: ALIAS_PAGE_SIZE }, (_, i) => [
        `${'g'.repeat(99)}${i}`,
        `${'a'.repeat(99)}${i}`,
      ]),
    );
    const description = (buildAliasListPanel(long).embeds as { description?: string }[])[0]!
      .description!;
    expect(description.length).toBeLessThanOrEqual(4096);
  });

  it('truncates a select option label and description to what Discord accepts', () => {
    const option = optionsOf(buildAliasListPanel({ ['g'.repeat(150)]: 'a'.repeat(150) }))[0]!;
    expect(option.label.length).toBeLessThanOrEqual(100);
    expect(option.description.length).toBeLessThanOrEqual(100);
  });

  it('escapes markdown in a game name so it cannot break the embed', () => {
    const description = (
      buildAliasListPanel({ '**bold** _x_': 'ok' }).embeds as { description?: string }[]
    )[0]!.description!;
    expect(description).toContain('\\*\\*bold\\*\\*');
  });

  it('renders a note when one is passed, for a mutation result', () => {
    const panel = buildAliasListPanel({}, { note: 'Removed the alias.' });
    expect(JSON.stringify(panel)).toContain('Removed the alias.');
  });
});

describe('buildAliasDetailPanel', () => {
  it('offers Edit, Remove and Back for the chosen alias', () => {
    const panel = buildAliasDetailPanel('Counter-Strike 2', 'CS2');
    expect(panel.ephemeral).toBe(true);
    expect(labelsOf(panel)).toEqual(['Edit', 'Remove', 'Back']);
    const hash = aliasHash('Counter-Strike 2');
    expect(idsOf(panel)).toEqual([aliasId('edit', hash), aliasId('remove', hash), aliasId('back')]);
  });

  it('marks Remove as the destructive action', () => {
    const json = JSON.stringify(buildAliasDetailPanel('Counter-Strike 2', 'CS2'));
    // ButtonStyle.Danger === 4
    expect(json).toContain('"style":4');
  });
});

describe('buildAliasEditModal', () => {
  it('prefills both fields and keys the submit on the previous name hash', () => {
    const modal = buildAliasEditModal('Counter-Strike 2', 'CS2');
    const json = JSON.stringify(modal);
    expect(json).toContain('"value":"Counter-Strike 2"');
    expect(json).toContain('"value":"CS2"');
    expect(json).toContain(aliasId('save', aliasHash('Counter-Strike 2')));
  });

  it('prefills within the input limit for an over-long stored value', () => {
    const json = JSON.stringify(buildAliasEditModal('g'.repeat(150), 'a'.repeat(150)));
    for (const [, value] of json.matchAll(/"value":"(g+|a+)"/g)) {
      expect(value!.length).toBeLessThanOrEqual(100);
    }
  });
});
