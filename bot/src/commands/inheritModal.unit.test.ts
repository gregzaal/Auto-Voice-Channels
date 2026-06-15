import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  buildInheritModal,
  inheritChannelId,
  INHERIT_MODAL_PREFIX,
  parseInheritModal,
} from './inheritModal.js';

function fields(opts: { mode?: string; channel?: string }): ModalSubmitFields {
  return {
    getStringSelectValues: (id: string) => (id === 'mode' && opts.mode ? [opts.mode] : []),
    getSelectedChannels: () => (opts.channel ? { first: () => ({ id: opts.channel }) } : null),
  } as unknown as ModalSubmitFields;
}

describe('inheritModal', () => {
  it('encodes + round-trips the channel id', () => {
    const modal = buildInheritModal('sec-9');
    expect(modal.toJSON().custom_id).toBe(`${INHERIT_MODAL_PREFIX}sec-9`);
    expect(inheritChannelId(`${INHERIT_MODAL_PREFIX}sec-9`)).toBe('sec-9');
    expect(inheritChannelId('avc:other')).toBeUndefined();
  });

  it('prefers a picked channel, else the mode, else primary', () => {
    expect(parseInheritModal(fields({ mode: 'category' }))).toBe('category');
    expect(parseInheritModal(fields({ mode: 'category', channel: 'chan-1' }))).toBe('chan-1');
    expect(parseInheritModal(fields({}))).toBe('primary');
  });
});
