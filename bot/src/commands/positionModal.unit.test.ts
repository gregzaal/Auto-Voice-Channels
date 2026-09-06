import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  buildPositionModal,
  parsePositionModal,
  POSITION_MODAL_PREFIX,
  positionChannelId,
} from './positionModal.js';

/** Reads the default-selected option values out of the built modal JSON. */
function defaults(modal: ReturnType<typeof buildPositionModal>): string[] {
  const label = modal.toJSON().components[0] as {
    component: { options?: { value: string; default?: boolean }[] };
  };
  return (label.component.options ?? []).filter((o) => o.default).map((o) => o.value);
}

const fields = (value?: string, startAt = ''): ModalSubmitFields =>
  ({
    getStringSelectValues: () => (value ? [value] : []),
    getTextInputValue: () => startAt,
  }) as unknown as ModalSubmitFields;

describe('positionModal', () => {
  it('encodes the channel id in the custom id and round-trips it', () => {
    const modal = buildPositionModal('chan-1', false);
    expect(modal.toJSON().custom_id).toBe(`${POSITION_MODAL_PREFIX}chan-1`);
    expect(positionChannelId(`${POSITION_MODAL_PREFIX}chan-1`)).toBe('chan-1');
    expect(positionChannelId('avc:other:x')).toBeUndefined();
  });

  it('pre-selects the current setting', () => {
    expect(defaults(buildPositionModal('c', false))).toEqual(['below']);
    expect(defaults(buildPositionModal('c', true))).toEqual(['above']);
  });

  it('parses the chosen position (true = above)', () => {
    expect(parsePositionModal(fields('above')).above).toBe(true);
    expect(parsePositionModal(fields('below')).above).toBe(false);
    expect(parsePositionModal(fields()).above).toBe(false);
  });

  it('pre-fills the current start number, and leaves it blank for the default', () => {
    const value = (modal: ReturnType<typeof buildPositionModal>): string => {
      const label = modal.toJSON().components[1] as { component: { value?: string } };
      return label.component.value ?? '';
    };
    expect(value(buildPositionModal('c', false, 4))).toBe('4');
    expect(value(buildPositionModal('c', false))).toBe('');
  });

  it('parses a start number, and stores nothing for the default of 1', () => {
    expect(parsePositionModal(fields('below', '4')).startAt).toBe(4);
    expect(parsePositionModal(fields('below', '0')).startAt).toBe(0);
    expect(parsePositionModal(fields('below', '1')).startAt).toBeUndefined();
    expect(parsePositionModal(fields('below', '')).startAt).toBeUndefined();
  });

  /**
   * A modal cannot show a field-level validation error, so junk has to mean
   * "the default" rather than pinning the guild to a number nobody typed (or,
   * worse, a `NaN` offset that would render every room as `#NaN`).
   */
  it('treats unusable input as the default rather than refusing', () => {
    for (const raw of ['abc', '-3', '1e5', '99999', '4.5', '  ']) {
      expect(parsePositionModal(fields('below', raw)).startAt, raw).toBeUndefined();
    }
  });
});
