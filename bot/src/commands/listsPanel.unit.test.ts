import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  buildListDetailPanel,
  buildListEditModal,
  buildListsPanel,
  findList,
  LIST_OPTIONS_INPUT_MAX,
  LISTS_SELECT_ID,
  listsId,
  parseListEditModal,
  parseListOptions,
  parseListsId,
  sortLists,
} from './listsPanel.js';
import { MAX_LISTS } from '../features/voice/settings.js';

/** The buttons of a built panel, as `label -> custom id`. */
const buttonsOf = (panel: { components?: unknown }): Record<string, string> =>
  Object.fromEntries(
    (panel.components as { components: { data: { label?: string; custom_id?: string } }[] }[])
      .flatMap((row) => row.components.map((c) => c.data))
      .filter((d) => d.label !== undefined)
      .map((d) => [d.label!, d.custom_id ?? '']),
  );

/** The select menu's options, as the plain data Discord will receive. */
const optionsOf = (panel: {
  components?: unknown;
}): { value: string; label: string; description: string }[] => {
  const row = (panel.components as { components: { options?: { toJSON(): unknown }[] }[] }[])[0]!;
  return (row.components[0]!.options ?? []).map(
    (o) => o.toJSON() as { value: string; label: string; description: string },
  );
};

const descriptionOf = (panel: { embeds?: unknown }): string =>
  ((panel.embeds as { description?: string }[])[0]?.description ?? '').toString();

function fields(name: string, options: string): ModalSubmitFields {
  return {
    getTextInputValue: (id: string) => (id === 'name' ? name : options),
  } as unknown as ModalSubmitFields;
}

const modalJson = (modal: ReturnType<typeof buildListEditModal>) =>
  modal.toJSON() as unknown as {
    custom_id: string;
    title: string;
    components: { components: { custom_id: string; value?: string; required?: boolean }[] }[];
  };

const inputs = (modal: ReturnType<typeof buildListEditModal>): Record<string, string | undefined> =>
  Object.fromEntries(
    modalJson(modal).components.flatMap((row) =>
      row.components.map((c) => [c.custom_id, c.value] as const),
    ),
  );

describe('listsId / parseListsId', () => {
  it('round-trips an action with and without a name', () => {
    expect(parseListsId(listsId('add'))).toEqual({ action: 'add', name: null });
    expect(parseListsId(listsId('edit', 'animals'))).toEqual({ action: 'edit', name: 'animals' });
  });

  it('ignores a foreign or unknown id', () => {
    expect(parseListsId('avc:alias:add')).toBeNull();
    expect(parseListsId('avc:lists:destroy')).toBeNull();
  });

  /**
   * A name is validated to carry no colon before it is stored, so this only
   * arises for a name written by an older build or an `/import`. Rejoining the
   * remainder means the detail view opens and the list can be REMOVED, where
   * reading one field would resolve a truncated name that matches nothing.
   */
  it('rejoins a name that somehow contains a colon', () => {
    expect(parseListsId('avc:lists:remove:a:b')).toEqual({ action: 'remove', name: 'a:b' });
  });
});

describe('findList', () => {
  it('finds a list by its exact name', () => {
    expect(findList({ animals: ['otter'] }, 'animals')).toEqual(['otter']);
    expect(findList({ animals: ['otter'] }, 'Animals')).toBeNull();
  });

  /** The `getAlias` trap: a prototype member must not read as a list that exists. */
  it('does not resolve Object.prototype members', () => {
    expect(findList({}, 'constructor')).toBeNull();
    expect(findList({}, 'toString')).toBeNull();
  });
});

describe('buildListsPanel', () => {
  it('explains what a list is when there are none, and offers only Add', () => {
    const panel = buildListsPanel({});
    expect(descriptionOf(panel)).toContain('[[list:name]]');
    expect(Object.keys(buttonsOf(panel))).toEqual(['Add', 'Close']);
    // No picker row at all, rather than an empty select Discord would refuse.
    expect(panel.components).toHaveLength(1);
  });

  it('lists each list with its count, sorted case-insensitively', () => {
    const panel = buildListsPanel({ zebras: ['z'], Animals: ['otter', 'badger'] });
    expect(optionsOf(panel).map((o) => o.value)).toEqual(['Animals', 'zebras']);
    expect(descriptionOf(panel)).toContain('**Animals** (2): otter, badger');
  });

  it('summarises a long list rather than printing all of it', () => {
    const many = Array.from({ length: 30 }, (_, i) => `opt${i}`);
    expect(descriptionOf(buildListsPanel({ animals: many }))).toContain('and 24 more');
  });

  it('escapes markdown in a name and an option', () => {
    const panel = buildListsPanel({ '**bold**': ['_under_'] });
    expect(descriptionOf(panel)).not.toContain('**bold**:');
    expect(descriptionOf(panel)).toContain('\\_under\\_');
  });

  it('carries the picker id every full page of lists can be reached through', () => {
    const full = Object.fromEntries(
      Array.from({ length: MAX_LISTS }, (_, i) => [`list${i}`, ['one']]),
    );
    const panel = buildListsPanel(full);
    expect(optionsOf(panel)).toHaveLength(MAX_LISTS);
    expect(
      (panel.components as { components: { data: { custom_id?: string } }[] }[])[0]!.components[0]!
        .data.custom_id,
    ).toBe(LISTS_SELECT_ID);
  });

  it('renders a result note alongside the new state', () => {
    const panel = buildListsPanel({}, { note: 'Removed the list **animals**.' });
    expect((panel.embeds as { fields?: { value: string }[] }[])[0]!.fields![0]!.value).toContain(
      'Removed',
    );
  });
});

describe('buildListDetailPanel', () => {
  it('shows every option, and how to use the list', () => {
    const panel = buildListDetailPanel('animals', ['otter', 'badger', 'heron']);
    expect(descriptionOf(panel)).toContain('[[list:animals]]');
    expect(descriptionOf(panel)).toContain('otter, badger, heron');
    expect(buttonsOf(panel)).toEqual({
      Edit: 'avc:lists:edit:animals',
      Remove: 'avc:lists:remove:animals',
      Back: 'avc:lists:back',
    });
  });
});

describe('buildListEditModal', () => {
  it('opens empty for a new list, with no name in the id', () => {
    const modal = buildListEditModal();
    expect(modalJson(modal).custom_id).toBe('avc:lists:save');
    expect(inputs(modal)).toEqual({ name: undefined, options: undefined });
  });

  /**
   * The name the modal was OPENED on rides in the custom id, which is what makes
   * a name change in the box a rename rather than a second list.
   */
  it('prefills both fields and remembers the name it opened on', () => {
    const modal = buildListEditModal('animals', ['otter', 'badger']);
    expect(modalJson(modal).custom_id).toBe('avc:lists:save:animals');
    expect(inputs(modal)).toEqual({ name: 'animals', options: `otter${'\n'}badger` });
  });

  it('clamps a prefill Discord would refuse', () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `option-${i}`);
    const value = inputs(buildListEditModal('animals', huge))['options']!;
    expect(value.length).toBeLessThanOrEqual(LIST_OPTIONS_INPUT_MAX);
  });
});

describe('parseListOptions', () => {
  it('takes one option per line, dropping blanks and surrounding space', () => {
    expect(parseListOptions('otter\n  badger  \n\nheron\n')).toEqual(['otter', 'badger', 'heron']);
  });

  it('handles the CRLF a Windows client sends', () => {
    expect(parseListOptions('otter\r\nbadger')).toEqual(['otter', 'badger']);
  });

  /** Repeating an option is the only way to weight a pick, so it must survive. */
  it('keeps duplicates', () => {
    expect(parseListOptions('otter\notter\nbadger')).toEqual(['otter', 'otter', 'badger']);
  });

  it('reads the submitted modal, trimming the name', () => {
    expect(parseListEditModal(fields('  animals  ', 'otter\nbadger'))).toEqual({
      name: 'animals',
      options: ['otter', 'badger'],
    });
  });
});

describe('sortLists', () => {
  it('is stable regardless of insertion order, since jsonb does not preserve it', () => {
    const one = sortLists({ b: ['1'], a: ['2'], C: ['3'] });
    const two = sortLists({ C: ['3'], a: ['2'], b: ['1'] });
    expect(one.map(([n]) => n)).toEqual(['a', 'b', 'C']);
    expect(two).toEqual(one);
  });
});
