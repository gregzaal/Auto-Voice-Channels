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

const fields = (value?: string): ModalSubmitFields =>
  ({ getStringSelectValues: () => (value ? [value] : []) }) as unknown as ModalSubmitFields;

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
    expect(parsePositionModal(fields('above'))).toBe(true);
    expect(parsePositionModal(fields('below'))).toBe(false);
    expect(parsePositionModal(fields())).toBe(false);
  });
});
