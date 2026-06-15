import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildCreateModal, CREATE_MODAL_ID, parseCreateModal } from './createModal.js';

const defaults = { nameTemplate: 'DEFAULT NAME', statusTemplate: 'DEFAULT STATUS' };

/** Minimal stand-in for ModalSubmitFields backed by plain values. */
function fields(values: {
  name?: string;
  nameTemplate?: string;
  statusTemplate?: string;
  position?: string;
  category?: string;
}): ModalSubmitFields {
  return {
    getTextInputValue: (id: string) => (values as Record<string, string>)[id] ?? '',
    getStringSelectValues: (id: string) =>
      id === 'position' && values.position ? [values.position] : [],
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
      'Secondary position (/toggleposition later)',
    ]);
    for (const l of labels) expect(l!.length).toBeLessThanOrEqual(45);
  });

  it('parses the category channel select, position dropdown, and templates', () => {
    const parsed = parseCreateModal(
      fields({
        category: 'cat-123',
        name: '  Lobby  ',
        nameTemplate: 'DEFAULT NAME', // unchanged → inherit
        statusTemplate: 'Custom status',
        position: 'below',
      }),
      defaults,
    );
    expect(parsed).toEqual({
      parentId: 'cat-123',
      name: 'Lobby',
      statusTemplate: 'Custom status',
      above: false,
    });
    expect(parsed.nameTemplate).toBeUndefined();
  });

  it('defaults to above with no category when nothing is selected', () => {
    const parsed = parseCreateModal(fields({}), defaults);
    expect(parsed).toEqual({ above: true });
  });
});
