import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { SecondaryChannelRepository } from './secondaryChannels.js';
import type { RoomAccess } from '../domain/roomAccess.js';
import { secondaryChannels } from '../db/schema.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const GUILD = 'guild-1';
const ROOM = 'room-1';

describe('SecondaryChannelRepository access (integration)', () => {
  let env: PgTestEnv;
  let repo: SecondaryChannelRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new SecondaryChannelRepository(env.handle.db, 'prod');
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(secondaryChannels);
  });

  const make = (channelId = ROOM, over: Partial<Parameters<typeof repo.create>[0]> = {}) =>
    repo.create({
      channelId,
      guildId: GUILD,
      primaryChannelId: 'primary-1',
      ownerId: 'u1',
      ...over,
    });

  /** The column exactly as Postgres holds it, bypassing every parse. */
  const rawAccess = async (channelId = ROOM): Promise<unknown> =>
    (
      await env.handle.db.execute<{ access: unknown }>(
        sql`SELECT access FROM secondary_channels WHERE channel_id = ${channelId}`,
      )
    ).rows[0]?.access;

  const rawState = async (channelId = ROOM): Promise<Record<string, unknown>> =>
    (
      await env.handle.db.execute<{ state: Record<string, unknown> }>(
        sql`SELECT state FROM secondary_channels WHERE channel_id = ${channelId}`,
      )
    ).rows[0]!.state;

  /** Writes the column verbatim, to stage a blob the repository would never write. */
  const stageAccess = (blob: unknown, channelId = ROOM) =>
    env.handle.db.execute(
      sql`UPDATE secondary_channels SET access = ${JSON.stringify(blob)}::jsonb WHERE channel_id = ${channelId}`,
    );

  /**
   * Counts row updates with a trigger, so "one statement" is the database's
   * answer and not an assumption about how the repository is written. Two
   * statements would be two row versions and two log rows.
   */
  const withUpdateLog = async (run: () => Promise<void>) => {
    const exec = (statement: string) => env.handle.db.execute(sql.raw(statement));
    await exec(
      `CREATE TABLE update_log (n serial PRIMARY KEY, channel_id text, new_state jsonb, new_access jsonb)`,
    );
    await exec(`
      CREATE FUNCTION log_secondary_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO update_log (channel_id, new_state, new_access)
          VALUES (NEW.channel_id, NEW.state, NEW.access);
        RETURN NEW;
      END $$`);
    await exec(`
      CREATE TRIGGER secondary_update_log AFTER UPDATE ON secondary_channels
        FOR EACH ROW EXECUTE FUNCTION log_secondary_update()`);
    try {
      await run();
      return (
        await env.handle.db.execute<{
          channel_id: string;
          new_state: Record<string, unknown>;
          new_access: unknown;
        }>(sql`SELECT channel_id, new_state, new_access FROM update_log ORDER BY n`)
      ).rows;
    } finally {
      await exec(`DROP TRIGGER secondary_update_log ON secondary_channels`);
      await exec(`DROP FUNCTION log_secondary_update()`);
      await exec(`DROP TABLE update_log`);
    }
  };

  describe('getAccess', () => {
    it('reads a new room as having no access record', async () => {
      const row = await make();
      expect(row.access).toBeNull();
      expect(await repo.getAccess(ROOM)).toBeNull();
      expect(await rawAccess()).toBeNull();
    });

    it('reads a record back, leaving state alone', async () => {
      await make(ROOM, { state: { seed: 7, roster: ['u1'] } });
      const access: RoomAccess = { creatorId: 'u1', hidden: true, trusted: ['u2'] };
      await stageAccess(access);

      expect(await repo.getAccess(ROOM)).toEqual(access);
      const row = await repo.get(ROOM);
      expect(row?.access).toEqual(access);
      expect(row?.state).toEqual({ seed: 7, roster: ['u1'] });
    });

    it('is null for a room that has no row', async () => {
      expect(await repo.getAccess('ghost')).toBeNull();
      expect(await repo.get('ghost')).toBeUndefined();
    });

    /**
     * It reads the one column on purpose, so a room whose `state` does not parse
     * (which makes `get` throw) still has its record read.
     */
    it('reads the record of a room whose state is corrupt', async () => {
      await make();
      await stageAccess({ hidden: true, creatorId: 'u1' });
      await env.handle.db.execute(
        sql`UPDATE secondary_channels SET state = '{"controlPanelChannelId": 123}'::jsonb WHERE channel_id = ${ROOM}`,
      );

      await expect(repo.get(ROOM)).rejects.toThrow();
      expect(await repo.getAccess(ROOM)).toEqual({ hidden: true, creatorId: 'u1' });
    });

    it('survives a replayed create, which does not touch an existing row', async () => {
      await make();
      await stageAccess({ hidden: true });
      await make();
      expect(await repo.getAccess(ROOM)).toEqual({ hidden: true });
    });
  });

  /**
   * What `getAccess` and the row schema cannot say: a blob this build cannot read
   * is `null` to both, which is also what a room with no record is, and a caller
   * that is about to decide from the record has to tell the two apart.
   */
  describe('readAccess', () => {
    it('reads a room with no record as readable and empty', async () => {
      await make();
      expect(await repo.readAccess(ROOM)).toEqual({ readable: true, access: null });
    });

    it('reads a record, carrying a field this build does not know', async () => {
      await make();
      await stageAccess({ hidden: true, kicked: ['u9'], futureThing: 1 });
      expect(await repo.readAccess(ROOM)).toEqual({
        readable: true,
        access: { hidden: true, kicked: ['u9'], futureThing: 1 },
      });
    });

    it('says a blob it cannot parse is unreadable, where getAccess says null', async () => {
      await make();
      await stageAccess({ hidden: 'yes' });
      expect(await repo.readAccess(ROOM)).toEqual({ readable: false });
      expect(await repo.getAccess(ROOM)).toBeNull();
    });

    it('is undefined for a room that does not exist, or belongs to another fleet', async () => {
      await make();
      await stageAccess({ hidden: true });
      expect(await repo.readAccess('ghost')).toBeUndefined();
      const other = new SecondaryChannelRepository(env.handle.db, 'beta');
      expect(await other.readAccess(ROOM)).toBeUndefined();
    });

    it('reads the record of a room whose state is corrupt', async () => {
      await make();
      await stageAccess({ hidden: true });
      await env.handle.db.execute(
        sql`UPDATE secondary_channels SET state = '{"controlPanelChannelId": 123}'::jsonb WHERE channel_id = ${ROOM}`,
      );
      expect(await repo.readAccess(ROOM)).toEqual({ readable: true, access: { hidden: true } });
    });
  });

  describe('mutateAccess', () => {
    it('hands the current record to the callback and stores what it returns', async () => {
      await make();
      const seen: (RoomAccess | null)[] = [];

      const first = await repo.mutateAccess(ROOM, (current) => {
        seen.push(current);
        return { creatorId: 'u1', trusted: ['u2'] };
      });
      const second = await repo.mutateAccess(ROOM, (current) => {
        seen.push(current);
        return { ...current, trusted: [...(current?.trusted ?? []), 'u3'] };
      });

      expect(seen).toEqual([null, { creatorId: 'u1', trusted: ['u2'] }]);
      expect(first).toEqual({
        status: 'written',
        access: { creatorId: 'u1', trusted: ['u2'] },
      });
      expect(second).toEqual({
        status: 'written',
        access: { creatorId: 'u1', trusted: ['u2', 'u3'] },
      });
      expect(await repo.getAccess(ROOM)).toEqual({ creatorId: 'u1', trusted: ['u2', 'u3'] });
    });

    it('clears the record when the callback returns null', async () => {
      await make();
      await stageAccess({ hidden: true });
      expect(await repo.mutateAccess(ROOM, () => null)).toEqual({
        status: 'written',
        access: null,
      });
      expect(await rawAccess()).toBeNull();
    });

    it('does not touch state', async () => {
      await make(ROOM, { state: { seed: 7, roster: ['u1'], private: true } });
      await repo.mutateAccess(ROOM, () => ({ hidden: true }));
      expect(await rawState()).toEqual({ seed: 7, roster: ['u1'], private: true });
    });

    /**
     * A caller that carries on after anything but `written` makes a Discord grant
     * the record does not hold, which no later removal will ever take back.
     */
    it('says the room is missing, and never calls the callback for it', async () => {
      const mutate = vi.fn(() => ({ hidden: true }));
      expect(await repo.mutateAccess('ghost', mutate)).toEqual({ status: 'missing' });
      expect(mutate).not.toHaveBeenCalled();
      expect(await repo.get('ghost')).toBeUndefined();
    });

    it('rolls back when the callback throws, and lets the error out', async () => {
      await make();
      await stageAccess({ trusted: ['u2'] });

      await expect(
        repo.mutateAccess(ROOM, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await repo.getAccess(ROOM)).toEqual({ trusted: ['u2'] });
    });

    /**
     * The point of the lock. `admitted` is an array inside one blob, so without
     * it two writers each read, append and write back, and one entry is lost: an
     * overwrite on Discord that no later removal will ever revoke.
     */
    it('loses no entry when many writers add at the same moment', async () => {
      await make();
      const ids = Array.from({ length: 24 }, (_, i) => `u-${i}`);

      await Promise.all(
        ids.map((id) =>
          repo.mutateAccess(ROOM, (current) => ({
            ...current,
            admitted: [...(current?.admitted ?? []), id],
          })),
        ),
      );

      expect([...((await repo.getAccess(ROOM))?.admitted ?? [])].sort()).toEqual([...ids].sort());
    });

    /**
     * Golden rule 3. A value this build cannot read (an enum member a newer build
     * added) fails the whole record, which may be a hidden room's: writing this
     * build's idea of it over the top would destroy the grants and the way back
     * to the room's original permissions, and no later removal can restore them.
     * So it refuses and leaves the blob exactly as it was.
     */
    it('refuses to write over a record it cannot read, and leaves it as it was', async () => {
      await make();
      const blob = {
        hidden: true,
        baseline: { view: 'inherit' },
        blocked: ['u9'],
        neutralised: [{ roleId: 'r1', view: 'allow' }],
      };
      await stageAccess(blob);
      const mutate = vi.fn(() => ({ trusted: ['u2'] }));

      expect(await repo.mutateAccess(ROOM, mutate)).toEqual({ status: 'unreadable' });

      expect(mutate).not.toHaveBeenCalled();
      expect(await rawAccess()).toEqual(blob);
    });

    it('treats an empty column and a jsonb null as nothing to preserve, not as unreadable', async () => {
      await make();
      await stageAccess(null);
      expect(await repo.mutateAccess(ROOM, () => ({ trusted: ['u2'] }))).toMatchObject({
        status: 'written',
      });
      expect(await repo.getAccess(ROOM)).toMatchObject({ trusted: ['u2'] });
    });

    /** Golden rule 3: an unknown field a newer build wrote survives this build's write. */
    it('keeps a field it does not know about through a write', async () => {
      await make();
      await stageAccess({
        hidden: true,
        futureThing: { a: 1 },
        baseline: { view: 'allow', speak: 'deny' },
      });

      await repo.mutateAccess(ROOM, (current) => ({ ...current, trusted: ['u2'] }));

      expect(await rawAccess()).toEqual({
        hidden: true,
        futureThing: { a: 1 },
        baseline: { view: 'allow', speak: 'deny' },
        trusted: ['u2'],
        creatorId: 'u1',
      });
    });
  });

  /**
   * `listByOriginalCreator` falls back to the `original_creator` column for a
   * record that names no creator, and `/transfer` moves that column on purpose. A
   * record that does not name its creator would therefore follow the handover,
   * which is the one thing it exists to prevent, so the repository names it in
   * every record it writes rather than leaving it to each caller to remember.
   */
  describe('the creator a record belongs to', () => {
    const roomsFor = async (creatorId: string) =>
      (await repo.listByOriginalCreator(GUILD, creatorId)).map((r) => r.channelId);

    it('stamps the original creator of the room into a record written without one', async () => {
      await make(ROOM, { ownerId: 'u2', originalCreator: 'u1' });

      const result = await repo.mutateAccess(ROOM, () => ({ blocked: ['u9'] }));

      expect(result).toEqual({ status: 'written', access: { blocked: ['u9'], creatorId: 'u1' } });
      expect(await rawAccess()).toEqual({ blocked: ['u9'], creatorId: 'u1' });
    });

    it('stamps it through a transition too', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({ hidden: true }),
      });
      expect(await rawAccess()).toEqual({ hidden: true, creatorId: 'u1' });
    });

    it('keeps a creator the caller names, and does not stamp a cleared record', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await repo.mutateAccess(ROOM, () => ({ creatorId: 'u5', blocked: ['u9'] }));
      expect(await rawAccess()).toEqual({ creatorId: 'u5', blocked: ['u9'] });

      await repo.mutateAccess(ROOM, () => null);
      expect(await rawAccess()).toBeNull();
    });

    it('leaves a room with no original creator unstamped', async () => {
      await repo.create({ channelId: ROOM, guildId: GUILD, primaryChannelId: 'primary-1' });
      await repo.mutateAccess(ROOM, () => ({ blocked: ['u9'] }));
      expect(await rawAccess()).toEqual({ blocked: ['u9'] });
    });

    /**
     * The owner LEAVING is the caretaker flow: it moves the owner and nothing
     * else, so the creator's guests and blocks stay theirs.
     */
    it('keeps a block with the creator it was recorded for when the owner merely leaves', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await repo.mutateAccess(ROOM, () => ({ blocked: ['u9'] }));

      await repo.setOwner(ROOM, 'u2');

      expect((await repo.get(ROOM))?.ownerId).toBe('u2');
      expect(await rawAccess()).toEqual({ blocked: ['u9'], creatorId: 'u1' });
      expect(await roomsFor('u1')).toEqual([ROOM]);
      expect(await roomsFor('u2')).toEqual([]);
    });

    /**
     * A room with no record yet follows the column, so a handover first gives it
     * to the new creator and the first record then names THEM. (With a record, the
     * handover moves the record too: see the next block.)
     */
    it('gives a room handed over before its first record to the new creator', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await repo.setOwnerAndCreator(ROOM, 'u2');

      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({ hidden: true }),
      });

      expect(await roomsFor('u2')).toEqual([ROOM]);
      expect(await roomsFor('u1')).toEqual([]);
    });

    /**
     * A writer that builds the record from scratch and does not spread the old one
     * must not hand the room over: the creator carries forward from what was
     * stored, and the column is not consulted.
     */
    it('carries the stored creator forward when a later write forgets to spread it', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await repo.mutateAccess(ROOM, () => ({ blocked: ['u9'] }));
      // The column and the record differ only after a handover that skipped the
      // record, which `setOwnerAndCreator` no longer does, so stage it directly.
      await env.handle.db.execute(
        sql`UPDATE secondary_channels SET original_creator = 'u2' WHERE channel_id = ${ROOM}`,
      );

      await repo.mutateAccess(ROOM, () => ({ blocked: ['u9', 'u8'] }));

      expect(await rawAccess()).toEqual({ blocked: ['u9', 'u8'], creatorId: 'u1' });
      expect(await roomsFor('u1')).toEqual([ROOM]);
    });
  });

  /**
   * A deliberate handover (`/transfer`, or a claim of an ownerless room) moves who
   * the room's lists belong to. Left on the giver, they could keep adding and
   * revoking guests on a room they gave away while the recipient's own lists never
   * applied to it.
   */
  describe('a handover', () => {
    const roomsFor = async (creatorId: string) =>
      (await repo.listByOriginalCreator(GUILD, creatorId)).map((r) => r.channelId);

    it('re-points the record at the new creator, keeping everything else in it', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1', state: { seed: 7 } });
      await stageAccess({
        creatorId: 'u1',
        hidden: true,
        baseline: { view: 'allow' },
        trusted: ['u3'],
        blocked: ['u9'],
        futureThing: { a: 1 },
      });

      expect(await repo.setOwnerAndCreator(ROOM, 'u2', 'Two')).toEqual({ access: 'repointed' });

      const row = await repo.get(ROOM);
      expect(row).toMatchObject({ ownerId: 'u2', originalCreator: 'u2' });
      expect(row?.state).toMatchObject({ seed: 7, originalCreatorName: 'Two' });
      expect(await rawAccess()).toEqual({
        creatorId: 'u2',
        hidden: true,
        baseline: { view: 'allow' },
        trusted: ['u3'],
        blocked: ['u9'],
        futureThing: { a: 1 },
      });
      expect(await roomsFor('u2')).toEqual([ROOM]);
      expect(await roomsFor('u1')).toEqual([]);
    });

    it('does it in the same statement as the owner, so nothing sees half a handover', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess({ creatorId: 'u1', blocked: ['u9'] });

      const log = await withUpdateLog(() =>
        repo.setOwnerAndCreator(ROOM, 'u2', 'Two').then(() => undefined),
      );

      expect(log).toHaveLength(1);
      expect(log[0]?.new_access).toEqual({ creatorId: 'u2', blocked: ['u9'] });
    });

    it('has nothing to re-point for a room with no record, and the column carries it', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });

      expect(await repo.setOwnerAndCreator(ROOM, 'u2')).toEqual({ access: 'none' });

      expect(await rawAccess()).toBeNull();
      expect(await roomsFor('u2')).toEqual([ROOM]);
    });

    it('leaves a record it cannot read exactly as it was, and says so', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      const blob = { creatorId: 'u1', hidden: 'sideways' };
      await stageAccess(blob);

      expect(await repo.setOwnerAndCreator(ROOM, 'u2')).toEqual({ access: 'unreadable' });

      expect(await rawAccess()).toEqual(blob);
      expect((await repo.get(ROOM))?.ownerId).toBe('u2');
    });

    it('does nothing for a room that does not exist, and for another fleet', async () => {
      expect(await repo.setOwnerAndCreator('ghost', 'u2')).toEqual({ access: 'none' });

      const other = new SecondaryChannelRepository(env.handle.db, 'beta');
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess({ creatorId: 'u1' });
      await other.setOwnerAndCreator(ROOM, 'u2');
      expect((await repo.get(ROOM))?.ownerId).toBe('u1');
      expect(await rawAccess()).toEqual({ creatorId: 'u1' });
    });

    it('is replay safe: handing it to the same member twice changes nothing more', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess({ creatorId: 'u1', blocked: ['u9'] });

      await repo.setOwnerAndCreator(ROOM, 'u2');
      await repo.setOwnerAndCreator(ROOM, 'u2');

      expect(await rawAccess()).toEqual({ creatorId: 'u2', blocked: ['u9'] });
    });

    it('does not lose an entry a concurrent transition adds, nor the re-point', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess({ creatorId: 'u1' });

      await Promise.all([
        repo.transitionAccess(ROOM, { access: (current) => ({ ...current, blocked: ['u9'] }) }),
        repo.setOwnerAndCreator(ROOM, 'u2'),
      ]);

      // Either order, both writes survive: the lock makes the second read the first.
      expect(await rawAccess()).toEqual({ creatorId: 'u2', blocked: ['u9'] });
    });
  });

  describe('transitionAccess', () => {
    it('writes state and access in ONE statement, so a reader never sees half', async () => {
      await make(ROOM, { state: { seed: 7, roster: ['u1'] } });

      const log = await withUpdateLog(async () => {
        const result = await repo.transitionAccess(ROOM, {
          statePatch: { private: true },
          access: () => ({ creatorId: 'u1', hidden: true }),
        });
        expect(result).toEqual({ status: 'written', access: { creatorId: 'u1', hidden: true } });
      });

      expect(log).toHaveLength(1);
      expect(log[0]?.new_state).toMatchObject({ private: true });
      expect(log[0]?.new_access).toEqual({ creatorId: 'u1', hidden: true });
    });

    it('is still one statement when the new record is built from the one under the lock', async () => {
      await make();
      await stageAccess({ trusted: ['u2'] });

      const log = await withUpdateLog(() =>
        repo
          .transitionAccess(ROOM, {
            statePatch: { private: true },
            access: (current) => ({ ...current, hidden: true }),
          })
          .then(() => undefined),
      );

      expect(log).toHaveLength(1);
      expect(log[0]?.new_state).toMatchObject({ private: true });
      expect(log[0]?.new_access).toEqual({ trusted: ['u2'], hidden: true, creatorId: 'u1' });
    });

    it('merges the patch into state and leaves every other key alone', async () => {
      await make(ROOM, { state: { seed: 7, name: 'Room', roster: ['u1', 'u2'] } });

      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({ hidden: true }),
      });

      expect(await rawState()).toEqual({
        seed: 7,
        name: 'Room',
        roster: ['u1', 'u2'],
        private: true,
      });
    });

    it('removes keys from state without touching the rest', async () => {
      await make(ROOM, { state: { seed: 7, private: true, roster: ['u1'] } });
      await stageAccess({ hidden: true, baseline: { view: 'allow' } });

      await repo.transitionAccess(ROOM, {
        stateRemove: ['private'],
        access: (current) => ({ ...current, hidden: false }),
      });

      expect(await rawState()).toEqual({ seed: 7, roster: ['u1'] });
      expect(await repo.getAccess(ROOM)).toEqual({
        hidden: false,
        baseline: { view: 'allow' },
        creatorId: 'u1',
      });
    });

    it('applies the removal after the patch, so a key named in both is removed', async () => {
      await make(ROOM, { state: { seed: 7 } });
      await repo.transitionAccess(ROOM, {
        statePatch: { private: true, name: 'x' },
        stateRemove: ['private'],
        access: () => null,
      });
      expect(await rawState()).toEqual({ seed: 7, name: 'x' });
    });

    it('can clear the access record in the same statement as a state change', async () => {
      await make(ROOM, { state: { private: true } });
      await stageAccess({ hidden: true });

      await repo.transitionAccess(ROOM, { stateRemove: ['private'], access: () => null });

      expect(await rawAccess()).toBeNull();
      expect(await rawState()).toEqual({});
    });

    it('leaves state alone when it names no state keys', async () => {
      await make(ROOM, { state: { seed: 7, private: true } });

      const log = await withUpdateLog(() =>
        repo
          .transitionAccess(ROOM, {
            statePatch: {},
            stateRemove: [],
            access: () => ({ hidden: true }),
          })
          .then(() => undefined),
      );

      expect(log[0]?.new_state).toEqual({ seed: 7, private: true });
      expect(await repo.getAccess(ROOM)).toEqual({ hidden: true, creatorId: 'u1' });
    });

    it('patches a room whose state is still empty', async () => {
      await make();
      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({ hidden: true }),
      });
      expect(await rawState()).toEqual({ private: true });
    });

    it('says the room is missing and writes nothing, without running the decision', async () => {
      const decide = vi.fn(() => ({ hidden: true }));
      await expect(
        repo.transitionAccess('ghost', { statePatch: { private: true }, access: decide }),
      ).resolves.toEqual({ status: 'missing' });
      expect(decide).not.toHaveBeenCalled();
      expect(await repo.get('ghost')).toBeUndefined();
    });

    /** Golden rule 3 again, and here the state half is also left untouched. */
    it('refuses a record it cannot read, and writes neither half', async () => {
      await make(ROOM, { state: { seed: 7 } });
      const blob = { hidden: true, baseline: { view: 'inherit' } };
      await stageAccess(blob);
      const decide = vi.fn(() => ({ hidden: false }));

      await expect(
        repo.transitionAccess(ROOM, { statePatch: { private: true }, access: decide }),
      ).resolves.toEqual({ status: 'unreadable' });

      expect(decide).not.toHaveBeenCalled();
      expect(await rawAccess()).toEqual(blob);
      expect(await rawState()).toEqual({ seed: 7 });
    });

    /**
     * `state` is parsed on every listing of the guild, so a patch of the wrong
     * type would make this one room fail the lot. It is refused before anything is
     * written, as a bug in the caller.
     */
    it.each([
      ['a boolean field given a string', { private: 'yes' }],
      ['a string field given null', { name: null }],
      ['an id given a number', { controlPanelChannelId: 123 }],
    ])('refuses a state patch with %s, before writing anything', async (_name, patch) => {
      await make(ROOM, { state: { seed: 7 } });
      const decide = vi.fn(() => ({ hidden: true }));

      await expect(
        repo.transitionAccess(ROOM, {
          statePatch: patch as Parameters<typeof repo.transitionAccess>[1]['statePatch'],
          access: decide,
        }),
      ).rejects.toThrow();

      expect(decide).not.toHaveBeenCalled();
      expect(await rawState()).toEqual({ seed: 7 });
      expect(await rawAccess()).toBeNull();
      // The row still parses, which is the point.
      expect(await repo.listByGuild(GUILD)).toHaveLength(1);
    });

    it('rolls back both halves when the decision throws', async () => {
      await make(ROOM, { state: { seed: 7 } });
      await stageAccess({ trusted: ['u2'] });

      await expect(
        repo.transitionAccess(ROOM, {
          statePatch: { private: true },
          access: () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toThrow('boom');

      expect(await rawState()).toEqual({ seed: 7 });
      expect(await repo.getAccess(ROOM)).toEqual({ trusted: ['u2'] });
    });

    /** Two transitions racing: neither loses the entry the other added. */
    it('loses no entry when concurrent transitions each add one under the row lock', async () => {
      await make();
      const ids = Array.from({ length: 16 }, (_, i) => `u-${i}`);

      await Promise.all(
        ids.map((id) =>
          repo.transitionAccess(ROOM, {
            statePatch: { [`touched-${id}`]: true },
            access: (current) => ({ ...current, admitted: [...(current?.admitted ?? []), id] }),
          }),
        ),
      );

      expect([...((await repo.getAccess(ROOM))?.admitted ?? [])].sort()).toEqual([...ids].sort());
      expect(Object.keys(await rawState()).sort()).toEqual(ids.map((id) => `touched-${id}`).sort());
    });
  });

  /**
   * THE hazard this column exists to avoid. `updateState` writes the whole
   * `state` column back from a snapshot read before a multi-second Discord round
   * trip, so nine existing callers revert whatever landed in `state` meanwhile.
   * `access` is not in `state`, so a stale replace cannot reach it.
   */
  describe('against a stale whole-state write', () => {
    it('keeps the access record when an old snapshot is written back over the state', async () => {
      await make(ROOM, { state: { seed: 7, name: 'Room', roster: ['u1'] } });
      const stale = await repo.get(ROOM);

      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({
          creatorId: 'u1',
          hidden: true,
          baseline: { view: 'allow', connect: 'allow' },
        }),
      });
      // What `rerenderSecondary`, `makePrivate` and the roster update all do:
      // write the snapshot they read earlier, plus their own change, back whole.
      await repo.updateState(ROOM, { ...stale!.state, name: 'Renamed' });

      const after = await repo.get(ROOM);
      expect(after?.access).toEqual({
        creatorId: 'u1',
        hidden: true,
        baseline: { view: 'allow', connect: 'allow' },
      });
      expect(after?.state.name).toBe('Renamed');
    });

    /**
     * What the one-statement transition does NOT protect, pinned so nobody builds
     * on the opposite. `private` still lives in `state`, so the same stale replace
     * drops it while `access.hidden` stands: a hidden room that reads as public to
     * anything that looks at `private` alone. Readers have to treat `hidden` as
     * implying locked, and whatever sweeps rooms has to put `private` back.
     */
    it('still loses state.private to a stale replace, while access.hidden survives', async () => {
      await make(ROOM, { state: { seed: 7 } });
      const stale = await repo.get(ROOM);

      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({ hidden: true }),
      });
      expect((await repo.get(ROOM))?.state.private).toBe(true);

      await repo.updateState(ROOM, { ...stale!.state, name: 'Renamed' });

      const after = await repo.get(ROOM);
      expect(after?.access?.hidden).toBe(true);
      expect(after?.state.private).toBeUndefined();
    });

    /**
     * The writer for a few keys after a slow call. The same stale snapshot, merged instead of
     * replaced, leaves the flag a lock finalised meanwhile and the roster a join appended.
     */
    it('keeps private and the roster when only the keys it names are merged', async () => {
      await make(ROOM, { state: { seed: 7, name: 'Room', roster: ['u1'] } });
      const stale = await repo.get(ROOM);

      await repo.transitionAccess(ROOM, {
        statePatch: { private: true },
        access: () => ({ hidden: true }),
      });
      await repo.updateState(ROOM, { ...(await repo.get(ROOM))!.state, roster: ['u1', 'u2'] });
      await repo.mergeState(ROOM, { name: 'Renamed', status: 'chilling', index: 3 });

      const after = await repo.get(ROOM);
      expect(stale!.state.private).toBeUndefined();
      expect(after?.state).toMatchObject({
        seed: 7,
        name: 'Renamed',
        status: 'chilling',
        index: 3,
        private: true,
        roster: ['u1', 'u2'],
      });
      expect(after?.access?.hidden).toBe(true);
    });

    it('keeps the access record when an old snapshot is written back after mutateAccess', async () => {
      await make(ROOM, { state: { seed: 7 } });
      const stale = await repo.get(ROOM);

      await repo.mutateAccess(ROOM, () => ({ trusted: ['u2'], admitted: ['u3'] }));
      await repo.updateState(ROOM, { ...stale!.state, roster: ['u1'] });

      expect(await repo.getAccess(ROOM)).toEqual({
        trusted: ['u2'],
        admitted: ['u3'],
        creatorId: 'u1',
      });
    });

    it('keeps the access record when the replaces are racing it', async () => {
      await make(ROOM, { state: { seed: 7 } });
      const stale = await repo.get(ROOM);

      await Promise.all([
        repo.updateState(ROOM, { ...stale!.state, name: 'a' }),
        repo.transitionAccess(ROOM, {
          statePatch: { private: true },
          access: (current) => ({ ...current, hidden: true }),
        }),
        repo.updateState(ROOM, { ...stale!.state, name: 'b' }),
        repo.mutateAccess(ROOM, (current) => ({ ...current, trusted: ['u2'] })),
      ]);

      expect(await repo.getAccess(ROOM)).toEqual({
        hidden: true,
        trusted: ['u2'],
        creatorId: 'u1',
      });
    });

    it('leaves the access record alone when the panel keys are merged or cleared', async () => {
      await make();
      await stageAccess({ hidden: true });
      await repo.setControlPanelMessage(ROOM, 'msg', 'chan', 'hash');
      await repo.clearControlPanelMessage(ROOM);
      expect(await repo.getAccess(ROOM)).toEqual({ hidden: true });
    });
  });

  /**
   * A listing parses every room, so a parse that throws fails the lot. A newer
   * build's shape this one cannot read must cost that room its access record and
   * nothing else.
   */
  describe('a blob that does not parse', () => {
    const bad: [string, unknown][] = [
      ['a string', 'hidden'],
      ['a number', 42],
      ['an array', [1, 2]],
      ['a boolean field of the wrong type', { hidden: 'yes' }],
      ['an id list of numbers', { trusted: [1, 2] }],
      ['an unknown baseline value', { baseline: { view: 'maybe' } }],
    ];

    it.each(bad)('reads %s as no record without throwing out of get', async (_name, blob) => {
      await make(ROOM, { state: { seed: 7 } });
      await stageAccess(blob);

      const row = await repo.get(ROOM);

      expect(row?.access).toBeNull();
      expect(row?.state).toEqual({ seed: 7 });
      expect(await repo.getAccess(ROOM)).toBeNull();
    });

    it('reads a jsonb null as no record', async () => {
      await make();
      await stageAccess(null);
      expect((await repo.get(ROOM))?.access).toBeNull();
    });

    it('does not fail the guild listing for the good rooms next to a bad one', async () => {
      await make('good-1');
      await make('bad-1');
      await make('good-2');
      await stageAccess({ hidden: true }, 'good-1');
      await stageAccess({ trusted: ['u2'] }, 'good-2');
      await stageAccess({ hidden: 'yes' }, 'bad-1');

      const rooms = await repo.listByGuild(GUILD);

      expect(rooms).toHaveLength(3);
      const byId = Object.fromEntries(rooms.map((r) => [r.channelId, r.access]));
      expect(byId).toEqual({
        'good-1': { hidden: true },
        'bad-1': null,
        'good-2': { trusted: ['u2'] },
      });
      // The same parse backs every other listing.
      expect((await repo.listByPrimary('primary-1')).length).toBe(3);
      expect((await repo.listByOwner(GUILD, 'u1')).length).toBe(3);
    });
  });

  describe('unknown fields', () => {
    it('reads a field a newer build wrote', async () => {
      await make();
      await stageAccess({ hidden: true, futureThing: { a: 1 } });
      expect((await repo.get(ROOM))?.access).toEqual({ hidden: true, futureThing: { a: 1 } });
    });
  });

  describe('listByOriginalCreator', () => {
    const roomsFor = async (creatorId: string, guildId = GUILD) =>
      (await repo.listByOriginalCreator(guildId, creatorId)).map((r) => r.channelId).sort();

    it('finds the rooms a creator made, with or without an access record', async () => {
      await make('plain', { ownerId: 'u1', originalCreator: 'u1' });
      await make('locked', { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess({ creatorId: 'u1', trusted: ['u9'] }, 'locked');
      await make('theirs', { ownerId: 'u2', originalCreator: 'u2' });

      expect(await roomsFor('u1')).toEqual(['locked', 'plain']);
      expect(await roomsFor('u2')).toEqual(['theirs']);
      expect(await roomsFor('nobody')).toEqual([]);
    });

    /**
     * The record's creator wins over the column, which is what keeps a caretaker
     * (named by `setOwner`, which moves nothing else) from taking the creator's
     * lists. A deliberate handover moves both, so they agree again.
     */
    it('follows the creator in the record, not the column, when the two differ', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u2' });
      await stageAccess({ creatorId: 'u1', blocked: ['u9'] });

      expect(await roomsFor('u1')).toEqual([ROOM]);
      expect(await roomsFor('u2')).toEqual([]);
    });

    it('follows a handover, whether or not the room has a record', async () => {
      await make(ROOM, { ownerId: 'u1', originalCreator: 'u1' });
      await repo.setOwnerAndCreator(ROOM, 'u2');
      expect(await roomsFor('u1')).toEqual([]);
      expect(await roomsFor('u2')).toEqual([ROOM]);

      await stageAccess({ creatorId: 'u2', blocked: ['u9'] });
      await repo.setOwnerAndCreator(ROOM, 'u3');
      expect(await roomsFor('u2')).toEqual([]);
      expect(await roomsFor('u3')).toEqual([ROOM]);
    });

    it('falls through to the column when the record is malformed or names no creator', async () => {
      await make('bad', { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess('garbage', 'bad');
      await make('no-creator', { ownerId: 'u1', originalCreator: 'u1' });
      await stageAccess({ hidden: true }, 'no-creator');

      expect(await roomsFor('u1')).toEqual(['bad', 'no-creator']);
    });

    it('does not match a room with neither a creator nor a record', async () => {
      await repo.create({ channelId: 'orphan', guildId: GUILD, primaryChannelId: 'primary-1' });
      expect(await roomsFor('u1')).toEqual([]);
    });

    it('is bound to the server', async () => {
      await make('here', { ownerId: 'u1', originalCreator: 'u1' });
      await repo.create({
        channelId: 'elsewhere',
        guildId: 'guild-2',
        primaryChannelId: 'primary-2',
        ownerId: 'u1',
      });
      expect(await roomsFor('u1')).toEqual(['here']);
      expect(await roomsFor('u1', 'guild-2')).toEqual(['elsewhere']);
    });
  });
});
