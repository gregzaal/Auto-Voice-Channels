import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildCreateModal, CREATE_MODAL_ID, parseCreateModal } from './createModal.js';

const defaults = { nameTemplate: 'DEFAULT NAME', statusTemplate: 'DEFAULT STATUS' };

/** Minimal stand-in for ModalSubmitFields backed by plain values. */
function fields(values: {
  name?: string;
  nameTemplate?: string;
  statusTemplate?: string;
  privacy?: string;
  category?: string;
}): ModalSubmitFields {
  return {
    getTextInputValue: (id: string) => (values as Record<string, string>)[id] ?? '',
    getStringSelectValues: (id: string) =>
      id === 'privacy' && values.privacy ? [values.privacy] : [],
    getSelectedChannels: () =>
      values.category ? { first: () => ({ id: values.category }) } : null,
  } as unknown as ModalSubmitFields;
}

describe('createModal', () => {
  it('builds a 5-field Label-component modal with the expected labels', () => {
    const modal = buildCreateModal(defaults).toJSON();
    expect(modal.custom_id).toBe(CREATE_MODAL_ID);
    const labels = (modal.components as { label?: string }[]).map((c) => c.label);
    expect(labels).toEqual([
      'Category',
      'Primary (creation) channel name',
      'Name template (/template to edit later)',
      'Status template (/template to edit later)',
      'Default privacy (/alwaysprivate later)',
    ]);
    // Discord caps a modal at 5 top-level components — never exceed it.
    expect(labels).toHaveLength(5);
    for (const l of labels) expect(l!.length).toBeLessThanOrEqual(45);
  });

  it('parses the category channel select, privacy selector, and templates', () => {
    const parsed = parseCreateModal(
      fields({
        category: 'cat-123',
        name: '  Lobby  ',
        nameTemplate: 'DEFAULT NAME', // unchanged → inherit
        statusTemplate: 'Custom status',
        privacy: 'private',
      }),
      defaults,
    );
    expect(parsed).toEqual({
      parentId: 'cat-123',
      name: 'Lobby',
      statusTemplate: 'Custom status',
      defaultPrivate: true,
    });
    expect(parsed.nameTemplate).toBeUndefined();
  });

  it('defaults to public (no defaultPrivate) with no category when privacy is open', () => {
    expect(parseCreateModal(fields({ privacy: 'open' }), defaults)).toEqual({});
    // Position is no longer collected here — the parse never sets `above`.
    expect(parseCreateModal(fields({ privacy: 'open' }), defaults)).not.toHaveProperty('above');
  });

  it('marks private only when the privacy selector is private', () => {
    expect(parseCreateModal(fields({ privacy: 'private' }), defaults)).toEqual({
      defaultPrivate: true,
    });
  });
});
