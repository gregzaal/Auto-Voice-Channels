import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildLoggingModal, LOGGING_MODAL_ID, parseLoggingModal } from './loggingModal.js';
import type { ProblemAlertMode } from '../features/voice/guildSettings.js';

type OptionJson = { value: string; default?: boolean };
type LabelJson = { component: { custom_id?: string; options?: OptionJson[] } };

/**
 * Selected values of one select, found by its custom id rather than by index.
 *
 * By index it silently tested the wrong component the moment anything was
 * inserted ahead of it, which is exactly what this modal just had happen.
 */
function defaults(modal: ReturnType<typeof buildLoggingModal>, customId: string): string[] {
  const label = (modal.toJSON().components as unknown as LabelJson[]).find(
    (c) => c.component?.custom_id === customId,
  );
  return (label?.component.options ?? []).filter((o) => o.default).map((o) => o.value);
}

function state(over: Partial<Parameters<typeof buildLoggingModal>[0]> = {}) {
  return {
    enabled: false,
    level: 1 as const,
    channelId: null,
    alerts: 'contact' as const,
    ...over,
  };
}

function fields(opts: { level?: string; channel?: string; alerts?: string }): ModalSubmitFields {
  return {
    getStringSelectValues: (id: string) => {
      if (id === 'level') return opts.level ? [opts.level] : [];
      if (id === 'alerts') return opts.alerts ? [opts.alerts] : [];
      return [];
    },
    getSelectedChannels: () => (opts.channel ? { first: () => ({ id: opts.channel }) } : null),
  } as unknown as ModalSubmitFields;
}

describe('loggingModal', () => {
  it('has the stable custom id', () => {
    expect(buildLoggingModal(state()).toJSON().custom_id).toBe(LOGGING_MODAL_ID);
  });

  it('stays within the 5-component modal cap Discord enforces', () => {
    expect(buildLoggingModal(state()).toJSON().components.length).toBeLessThanOrEqual(5);
  });

  it('pre-selects the current level (or "off" when disabled)', () => {
    expect(defaults(buildLoggingModal(state()), 'level')).toEqual(['off']);
    expect(defaults(buildLoggingModal(state({ enabled: true, level: 2 })), 'level')).toEqual(['2']);
  });

  it('pre-selects the current alert mode', () => {
    for (const alerts of ['contact', 'quiet', 'off'] as ProblemAlertMode[]) {
      expect(defaults(buildLoggingModal(state({ alerts })), 'alerts')).toEqual([alerts]);
    }
  });

  it('parses level + channel, and the "off" disable case', () => {
    expect(parseLoggingModal(fields({ level: 'off' }))).toEqual({
      disable: true,
      level: 1,
      alerts: 'contact',
    });
    expect(parseLoggingModal(fields({ level: '3', channel: 'log-1' }))).toEqual({
      disable: false,
      level: 3,
      alerts: 'contact',
      channelId: 'log-1',
    });
    // No channel picked → caller falls back to the current channel.
    expect(parseLoggingModal(fields({ level: '2' }))).toEqual({
      disable: false,
      level: 2,
      alerts: 'contact',
    });
  });

  it('carries the alert mode through the "off" branch', () => {
    // The disable branch returns early, so a field read after it is dropped.
    // "Turn logging off" is exactly when someone is also setting this, so
    // losing it here would silently undo the change they just made.
    expect(parseLoggingModal(fields({ level: 'off', alerts: 'off' })).alerts).toBe('off');
    expect(parseLoggingModal(fields({ level: '1', alerts: 'quiet' })).alerts).toBe('quiet');
  });

  it('falls back to mentioning the contact for an unknown alert value', () => {
    expect(parseLoggingModal(fields({ level: '1', alerts: 'nonsense' })).alerts).toBe('contact');
    expect(parseLoggingModal(fields({ level: '1' })).alerts).toBe('contact');
  });
});
