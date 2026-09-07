import type { ModalSubmitFields } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildTimeZoneModal, parseTimeZoneModal, TIMEZONE_MODAL_ID } from './timezoneModal.js';

const json = (modal: ReturnType<typeof buildTimeZoneModal>) =>
  modal.toJSON() as unknown as {
    custom_id: string;
    components: {
      components: { custom_id: string; value?: string; required?: boolean; max_length?: number }[];
    }[];
  };

const field = (modal: ReturnType<typeof buildTimeZoneModal>) =>
  json(modal).components[0]!.components[0]!;

function fields(value: string): ModalSubmitFields {
  return { getTextInputValue: () => value } as unknown as ModalSubmitFields;
}

describe('buildTimeZoneModal', () => {
  it('prefills the current zone', () => {
    expect(field(buildTimeZoneModal('Europe/Amsterdam')).value).toBe('Europe/Amsterdam');
    expect(json(buildTimeZoneModal('Europe/Amsterdam')).custom_id).toBe(TIMEZONE_MODAL_ID);
  });

  it('opens empty when no zone is set', () => {
    expect(field(buildTimeZoneModal(undefined)).value).toBeUndefined();
  });

  /**
   * Clearing the setting is a real choice, so the input cannot be required: with
   * `required` set Discord refuses the submit and there is no way back to UTC
   * short of an `/import`.
   */
  it('is optional, so an empty submit can clear the setting', () => {
    expect(field(buildTimeZoneModal('Europe/Amsterdam')).required).toBe(false);
  });

  it('bounds what can be pasted in', () => {
    expect(field(buildTimeZoneModal(undefined)).max_length).toBe(64);
  });
});

describe('parseTimeZoneModal', () => {
  /** Untrimmed on purpose: the service owns what counts as valid and what clears. */
  it('hands the raw value to the service', () => {
    expect(parseTimeZoneModal(fields('  Europe/Amsterdam '))).toBe('  Europe/Amsterdam ');
    expect(parseTimeZoneModal(fields(''))).toBe('');
  });
});
