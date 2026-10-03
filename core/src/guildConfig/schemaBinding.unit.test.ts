import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { primaryTemplateSchema } from '../repositories/autoChannels.js';
import { managedStateSchema, managedTemplateSchema } from '../repositories/managedChannels.js';
import {
  exportedManagedStateSchema,
  exportedManagedTemplateSchema,
  exportedPrimaryTemplateSchema,
} from './format.js';
import { PRIMARY_FIELDS } from './import.js';

/**
 * Binds the three stored jsonb schemas to the wire schemas mechanically, so
 * adding a stored setting cannot silently omit it from export and import.
 *
 * **The failure this exists for is silent and has already happened once.** The
 * first wire-schema example omitted `status` and `defaultPrivate`, which
 * would have cleared every creator channel's voice-status template and its
 * `/alwaysprivate` setting on every import. A hand-kept list of "fields the
 * exporter carries" cannot catch the next one: nothing fails, the field is
 * simply absent from every file, and the loss only shows up in a restore.
 *
 * `state` is the one place the two lists deliberately differ, and the exemption
 * has to be justified rather than assumed, so it is named below with its reason.
 */

/** Top-level keys of a zod object schema, whatever wrappers are around it. */
function keysOf(schema: z.ZodTypeAny): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  expect(shape, 'schema has no shape: is it still a z.object?').toBeDefined();
  return Object.keys(shape!).sort();
}

/**
 * Stored fields the wire format deliberately does not carry, with the reason.
 *
 * An entry is a claim that has to stay true, so keep them few and specific.
 */
const NOT_CARRIED: Record<string, string> = {
  'managedState.roster':
    'live occupancy, not configuration. Arrival order decides @@creator@@ and the owner, so importing one moment of it would name somebody who is not in the channel. A first-time adopt seeds it from the live occupants instead.',
};

describe('the export format carries every stored field', () => {
  it('covers every field of a creator channel template', () => {
    expect(keysOf(exportedPrimaryTemplateSchema)).toEqual(keysOf(primaryTemplateSchema));
  });

  /**
   * The third of the five places a creator channel template field has to be added, and the
   * one nothing else checked. `PRIMARY_FIELDS` is the list `/import` writes from: a stored
   * field missing there is simply never imported, and the file still round trips as if it
   * were absent, so nothing fails and the setting is lost on every restore.
   */
  it('imports every field of a creator channel template, and no other', () => {
    expect([...PRIMARY_FIELDS].sort()).toEqual(keysOf(primaryTemplateSchema));
  });

  /**
   * The keys the first export format wrote, which are REQUIRED on the wire. Every key added
   * since has to be optional there, because a file a previous release wrote (every export,
   * and the pre-import snapshot that is the documented undo) does not have it, and a
   * required key refuses the whole file. Written as the list of the old keys rather than the
   * new ones so the next field added is held to the rule without editing this test.
   */
  const REQUIRED_SINCE_THE_FIRST_FORMAT = [
    'above',
    'defaultPrivate',
    'inheritperms',
    'limit',
    'name',
    'startAt',
    'status',
    'textChannel',
  ];

  it('refuses no file for lacking a creator channel template field added later', () => {
    const shape = (
      exportedPrimaryTemplateSchema as unknown as { shape: Record<string, z.ZodTypeAny> }
    ).shape;
    const later = Object.keys(shape).filter(
      (key) => !REQUIRED_SINCE_THE_FIRST_FORMAT.includes(key),
    );
    expect(later.length).toBeGreaterThan(0);
    for (const key of later) {
      expect(
        shape[key]!.safeParse(undefined).success,
        `${key} is required on the wire, which refuses every file written before it existed`,
      ).toBe(true);
    }
  });

  it('covers every field of an adopted channel template', () => {
    expect(keysOf(exportedManagedTemplateSchema)).toEqual(keysOf(managedTemplateSchema));
  });

  /**
   * `state` is the one asymmetric pair, so it is checked as a subset plus an
   * explicit exemption rather than as equality.
   */
  it('covers every field of an adopted channel state, except the named exemption', () => {
    const stored = keysOf(managedStateSchema);
    const wire = new Set(keysOf(exportedManagedStateSchema));
    const missing = stored.filter((key) => !wire.has(key));
    expect(missing.map((key) => `managedState.${key}`)).toEqual(Object.keys(NOT_CARRIED));
  });

  it('carries no wire field the stored schema does not have', () => {
    const stored = new Set(keysOf(managedStateSchema));
    expect(keysOf(exportedManagedStateSchema).filter((k) => !stored.has(k))).toEqual([]);
  });

  /** A stale exemption would hide a field that stopped being carried. */
  it('has no stale exemptions', () => {
    const stored = new Set(keysOf(managedStateSchema));
    for (const key of Object.keys(NOT_CARRIED)) {
      const field = key.split('.')[1]!;
      expect(stored.has(field), `exemption names a field that no longer exists: ${key}`).toBe(true);
    }
  });

  /**
   * Every wire field is nullable, because `null` is how the format says "absent
   * from the stored blob". A non-nullable field would make the round trip
   * inexact for the one value that matters most.
   */
  it('makes every wire field nullable', () => {
    for (const schema of [
      exportedPrimaryTemplateSchema,
      exportedManagedTemplateSchema,
      exportedManagedStateSchema,
    ]) {
      const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      for (const [key, field] of Object.entries(shape)) {
        expect(field.safeParse(null).success, `${key} must accept null`).toBe(true);
      }
    }
  });
});
