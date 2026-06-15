import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildLoggingModal, LOGGING_MODAL_ID, parseLoggingModal } from './loggingModal.js';

function defaults(modal: ReturnType<typeof buildLoggingModal>): string[] {
  const label = modal.toJSON().components[0] as {
    component: { options?: { value: string; default?: boolean }[] };
  };
  return (label.component.options ?? []).filter((o) => o.default).map((o) => o.value);
}

function fields(opts: { level?: string; channel?: string }): ModalSubmitFields {
  return {
    getStringSelectValues: (id: string) => (id === 'level' && opts.level ? [opts.level] : []),
    getSelectedChannels: () => (opts.channel ? { first: () => ({ id: opts.channel }) } : null),
  } as unknown as ModalSubmitFields;
}

describe('loggingModal', () => {
  it('has the stable custom id', () => {
    expect(
      buildLoggingModal({ enabled: false, level: 1, channelId: null }).toJSON().custom_id,
    ).toBe(LOGGING_MODAL_ID);
  });

  it('pre-selects the current level (or "off" when disabled)', () => {
    expect(defaults(buildLoggingModal({ enabled: false, level: 1, channelId: null }))).toEqual([
      'off',
    ]);
    expect(defaults(buildLoggingModal({ enabled: true, level: 2, channelId: 'c' }))).toEqual(['2']);
  });

  it('parses level + channel, and the "off" disable case', () => {
    expect(parseLoggingModal(fields({ level: 'off' }))).toEqual({ disable: true, level: 1 });
    expect(parseLoggingModal(fields({ level: '3', channel: 'log-1' }))).toEqual({
      disable: false,
      level: 3,
      channelId: 'log-1',
    });
    // No channel picked → caller falls back to the current channel.
    expect(parseLoggingModal(fields({ level: '2' }))).toEqual({ disable: false, level: 2 });
  });
});
