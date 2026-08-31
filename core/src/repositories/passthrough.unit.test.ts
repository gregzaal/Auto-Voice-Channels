import { describe, expect, it } from 'vitest';
import { autoChannelRowSchema, primaryTemplateSchema } from './autoChannels.js';
import {
  managedChannelRowSchema,
  managedStateSchema,
  managedTemplateSchema,
} from './managedChannels.js';

/**
 * The three jsonb column schemas preserve fields they do not know about.
 *
 * **This is golden rule 3 for these columns**, and it was not true before. A
 * `z.object` strips unknown keys, so during a rolling deploy an old instance
 * doing a read-modify-write on a template silently dropped whatever a newer
 * build had written, and `/export` could not carry it either. Nothing failed:
 * the field was simply gone.
 */
describe('template and state schemas preserve unknown fields', () => {
  it('keeps an unknown field on a primary template', () => {
    const parsed = primaryTemplateSchema.parse({ name: 'Room ##', someFutureField: 'keep me' });
    expect(parsed).toMatchObject({ name: 'Room ##', someFutureField: 'keep me' });
  });

  it('keeps an unknown field on an adopted template and its state', () => {
    expect(managedTemplateSchema.parse({ name: 'Lobby', futureThing: 1 })).toMatchObject({
      futureThing: 1,
    });
    expect(managedStateSchema.parse({ seed: 7, futureThing: 'x' })).toMatchObject({
      futureThing: 'x',
    });
  });

  /** Through the row parse, which is the path every repository read takes. */
  it('keeps an unknown field through a whole row parse', () => {
    const auto = autoChannelRowSchema.parse({
      channelId: 'c',
      guildId: 'g',
      template: { name: 'Room ##', someFutureField: 'keep me' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(auto.template).toMatchObject({ someFutureField: 'keep me' });

    const managed = managedChannelRowSchema.parse({
      channelId: 'c',
      guildId: 'g',
      ownerId: null,
      template: { name: 'Lobby', futureThing: 1 },
      state: { seed: 7, futureThing: 'x' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(managed.template).toMatchObject({ futureThing: 1 });
    expect(managed.state).toMatchObject({ futureThing: 'x' });
  });

  /** Still rejects a field of the wrong type, which is what the schema is for. */
  it('still rejects a known field with the wrong type', () => {
    expect(primaryTemplateSchema.safeParse({ limit: 'four' }).success).toBe(false);
    expect(managedStateSchema.safeParse({ seed: 'seven' }).success).toBe(false);
  });
});
