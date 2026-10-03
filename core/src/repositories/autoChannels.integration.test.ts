import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutoChannelRepository, startModeOf } from './autoChannels.js';
import { autoChannels } from '../db/schema.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const CHANNEL = 'creator-1';

describe('AutoChannelRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: AutoChannelRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new AutoChannelRepository(env.handle.db, 'prod');
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(autoChannels);
  });

  describe('setDefaultPrivacy', () => {
    it('stores locked as defaultPrivate alone, and hidden as the pair', async () => {
      await repo.upsert(GUILD, CHANNEL, { name: 'Room ##' });

      const locked = await repo.setDefaultPrivacy(GUILD, CHANNEL, 'locked');
      expect(locked?.template).toEqual({ name: 'Room ##', defaultPrivate: true });
      expect(startModeOf(locked!.template)).toBe('locked');

      const hidden = await repo.setDefaultPrivacy(GUILD, CHANNEL, 'hidden');
      // Both keys, so an instance that predates `defaultHidden` still starts the room locked.
      expect(hidden?.template).toEqual({
        name: 'Room ##',
        defaultPrivate: true,
        defaultHidden: true,
      });
      expect(startModeOf(hidden!.template)).toBe('hidden');
    });

    it('moves between every pair of modes, and public stores nothing at all', async () => {
      await repo.upsert(GUILD, CHANNEL, { name: 'Room ##', limit: 4 });
      const modes = ['public', 'locked', 'hidden'] as const;
      for (const from of modes) {
        for (const to of modes) {
          await repo.setDefaultPrivacy(GUILD, CHANNEL, from);
          const row = await repo.setDefaultPrivacy(GUILD, CHANNEL, to);
          expect(startModeOf(row!.template), `${from} to ${to}`).toBe(to);
          // The row as read back agrees with the row the write returned.
          expect((await repo.get(CHANNEL))!.template).toEqual(row!.template);
          if (to === 'public') {
            expect(row!.template).toEqual({ name: 'Room ##', limit: 4 });
          }
          if (to === 'locked') {
            expect(row!.template).not.toHaveProperty('defaultHidden');
          }
        }
      }
    });

    it('leaves every other field alone, including one this build does not know', async () => {
      await repo.upsert(GUILD, CHANNEL, {
        name: 'Room ##',
        status: 'Playing',
        limit: 4,
        startAt: 3,
        above: true,
        inheritperms: 'category',
        textChannel: true,
        someFutureField: { nested: [1, 2] },
      });
      for (const mode of ['hidden', 'locked', 'public'] as const) {
        const row = await repo.setDefaultPrivacy(GUILD, CHANNEL, mode);
        expect(row!.template).toMatchObject({
          name: 'Room ##',
          status: 'Playing',
          limit: 4,
          startAt: 3,
          above: true,
          inheritperms: 'category',
          textChannel: true,
          someFutureField: { nested: [1, 2] },
        });
      }
    });

    /**
     * The defect this exists for. A toggle that read the template and wrote it back with
     * `upsert` replaced the whole column from a snapshot, so a `/template` edit that landed
     * between its read and its write was undone. Here the edit lands after the read, which
     * is exactly the interleaving, and it has to survive the toggle.
     */
    it('keeps an edit made after the template was read', async () => {
      await repo.upsert(GUILD, CHANNEL, { name: 'Old name', limit: 2 });
      const stale = await repo.get(CHANNEL);
      expect(stale?.template.name).toBe('Old name');

      // The concurrent `/template` and `/defaultlimit` edits.
      await repo.upsert(GUILD, CHANNEL, { name: 'New name', limit: 9 });
      const row = await repo.setDefaultPrivacy(GUILD, CHANNEL, 'hidden');

      expect(row!.template).toEqual({
        name: 'New name',
        limit: 9,
        defaultPrivate: true,
        defaultHidden: true,
      });
    });

    /**
     * Two toggles racing never leave the pair half written: hidden beside no `defaultPrivate`
     * reads as public, which is the one outcome nobody asked for.
     */
    it('writes the pair in one statement, so racing toggles end in a whole mode', async () => {
      await repo.upsert(GUILD, CHANNEL, { name: 'Room ##' });
      for (let i = 0; i < 20; i++) {
        await Promise.all([
          repo.setDefaultPrivacy(GUILD, CHANNEL, 'hidden'),
          repo.setDefaultPrivacy(GUILD, CHANNEL, 'locked'),
          repo.setDefaultPrivacy(GUILD, CHANNEL, 'public'),
        ]);
        const { template } = (await repo.get(CHANNEL))!;
        const wholeModes = [
          {},
          { defaultPrivate: true },
          { defaultPrivate: true, defaultHidden: true },
        ];
        const stored = {
          ...(template.defaultPrivate !== undefined
            ? { defaultPrivate: template.defaultPrivate }
            : {}),
          ...(template.defaultHidden !== undefined
            ? { defaultHidden: template.defaultHidden }
            : {}),
        };
        expect(wholeModes).toContainEqual(stored);
      }
    });

    it('does not touch a creator channel of another guild, or another fleet', async () => {
      await repo.upsert(GUILD, CHANNEL, { name: 'Room ##' });
      const beta = new AutoChannelRepository(env.handle.db, 'beta');

      // Right channel, wrong guild: nothing is written and nothing is returned.
      expect(await repo.setDefaultPrivacy(OTHER_GUILD, CHANNEL, 'hidden')).toBeUndefined();
      // Right guild, wrong fleet.
      expect(await beta.setDefaultPrivacy(GUILD, CHANNEL, 'hidden')).toBeUndefined();
      // No such channel at all.
      expect(await repo.setDefaultPrivacy(GUILD, 'nope', 'hidden')).toBeUndefined();

      expect((await repo.get(CHANNEL))!.template).toEqual({ name: 'Room ##' });
    });

    it('moves updatedAt, which the import differ and the audit read', async () => {
      const before = await repo.upsert(GUILD, CHANNEL, { name: 'Room ##' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const row = await repo.setDefaultPrivacy(GUILD, CHANNEL, 'locked');
      expect(row!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });
  });
});
