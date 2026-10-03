import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AutoChannelRepository } from './autoChannels.js';
import { MemberRoomPrefsRepository } from './memberRoomPrefs.js';
import { autoChannels, memberRoomPrefs } from '../db/schema.js';
import {
  MAX_MEMBER_PREF_NAME_LENGTH,
  MEMBER_PREFS_ORPHAN_GRACE_MS,
} from '../domain/memberRoomPrefs.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';
const PRIMARY = 'creator-1';
const OTHER_PRIMARY = 'creator-2';
const USER = 'user-1';
const OTHER_USER = 'user-2';

type Row = {
  primary_channel_id: string;
  user_id: string;
  guild_id: string;
  name_template: string | null;
  user_limit: number | null;
  privacy: string | null;
  updated_at: string | Date;
};

describe('MemberRoomPrefsRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: MemberRoomPrefsRepository;
  let creators: AutoChannelRepository;
  let betaCreators: AutoChannelRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new MemberRoomPrefsRepository(env.handle.db);
    creators = new AutoChannelRepository(env.handle.db, 'prod');
    betaCreators = new AutoChannelRepository(env.handle.db, 'beta');
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(memberRoomPrefs);
    await env.handle.db.delete(autoChannels);
  });

  /** A creator channel that remembers, which is the only kind a save is accepted for. */
  const optIn = (channel = PRIMARY, guild = GUILD) =>
    creators.upsert(guild, channel, { name: 'Room ##', rememberPrefs: true });

  /** A row's timestamp as a number: a raw statement hands it back as text. */
  const at = (row: Row): number => new Date(row.updated_at).getTime();

  /** Every row, straight from the table, oldest key first. */
  const rows = async (): Promise<Row[]> =>
    (
      await env.handle.db.execute<Row>(
        sql`SELECT * FROM member_room_prefs ORDER BY primary_channel_id, user_id`,
      )
    ).rows;

  /** Stages a row directly, as an older build or a hand edit would have left it. */
  const stage = (
    over: Partial<{
      primary: string;
      user: string;
      guild: string;
      name: string | null;
      limit: number | null;
      privacy: string | null;
      ageDays: number;
    }> = {},
  ) =>
    env.handle.db.execute(
      sql`INSERT INTO member_room_prefs
            (primary_channel_id, user_id, guild_id, name_template, user_limit, privacy, updated_at)
          VALUES (${over.primary ?? PRIMARY}, ${over.user ?? USER}, ${over.guild ?? GUILD},
                  ${over.name ?? null}, ${over.limit ?? null}, ${over.privacy ?? null},
                  now() - (${over.ageDays ?? 0}::double precision * interval '1 day'))`,
    );

  describe('the table', () => {
    /** The migration is exercised by `startPostgres`, and this reads back what it made. */
    it('is created by the migration with the key, the indexes and no fleet column', async () => {
      const columns = (
        await env.handle.db.execute<{
          column_name: string;
          data_type: string;
          is_nullable: string;
        }>(
          sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
               WHERE table_name = 'member_room_prefs' ORDER BY ordinal_position`,
        )
      ).rows;
      expect(columns).toEqual([
        { column_name: 'primary_channel_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'user_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'guild_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'name_template', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'user_limit', data_type: 'smallint', is_nullable: 'YES' },
        { column_name: 'privacy', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      ]);

      const indexes = (
        await env.handle.db.execute<{ indexname: string; indexdef: string }>(
          sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'member_room_prefs'`,
        )
      ).rows;
      const defs = indexes.map((i) => i.indexdef).join('\n');
      expect(defs).toContain('(primary_channel_id, user_id)');
      expect(defs).toContain('member_room_prefs_guild_idx');
      expect(defs).toContain('(guild_id)');
      expect(defs).toContain('member_room_prefs_user_idx');
      expect(defs).toContain('(user_id)');
    });
  });

  describe('saving one setting at a time', () => {
    it('starts empty, and reads nothing for a member who has saved nothing', async () => {
      await optIn();
      expect(await repo.get(PRIMARY, USER)).toBeUndefined();
    });

    it('stores each setting without reading or rewriting the others', async () => {
      await optIn();

      expect(await repo.saveName(GUILD, PRIMARY, USER, 'Kay: @@game_name@@')).toEqual({
        status: 'saved',
      });
      expect(await repo.get(PRIMARY, USER)).toEqual({
        name: 'Kay: @@game_name@@',
        limit: null,
        privacy: null,
      });

      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 6)).toEqual({ status: 'saved' });
      expect(await repo.savePrivacy(GUILD, PRIMARY, USER, 'hidden')).toEqual({ status: 'saved' });
      expect(await repo.get(PRIMARY, USER)).toEqual({
        name: 'Kay: @@game_name@@',
        limit: 6,
        privacy: 'hidden',
      });

      // One row, however many settings it holds.
      expect(await rows()).toHaveLength(1);
    });

    /** What `/name` after `/limit` relies on: the second save does not know the first exists. */
    it('changes one setting and leaves a different one exactly as it was', async () => {
      await optIn();
      await repo.saveLimit(GUILD, PRIMARY, USER, 4);
      await repo.savePrivacy(GUILD, PRIMARY, USER, 'private');

      await repo.saveName(GUILD, PRIMARY, USER, 'den');
      await repo.savePrivacy(GUILD, PRIMARY, USER, 'hidden');
      const [after] = await rows();

      expect(after).toMatchObject({ user_limit: 4, name_template: 'den', privacy: 'hidden' });
    });

    /** What the orphan sweep's grace reads, so a member who is still using it is never swept. */
    it('moves updated_at on a save, so a row in use never looks abandoned', async () => {
      await optIn();
      await stage({ limit: 3, ageDays: 20 });
      expect(at((await rows())[0]!)).toBeLessThan(Date.now() - 10 * 24 * 60 * 60 * 1000);

      await repo.saveName(GUILD, PRIMARY, USER, 'den');
      expect(at((await rows())[0]!)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('is idempotent: the same save twice is one row with one value', async () => {
      await optIn();
      for (let i = 0; i < 3; i += 1) {
        expect(await repo.saveLimit(GUILD, PRIMARY, USER, 8)).toEqual({ status: 'saved' });
      }
      expect(await rows()).toHaveLength(1);
      expect((await repo.get(PRIMARY, USER))?.limit).toBe(8);
    });

    /** A limit of 0 is "no limit", which a member can choose and a restore must honour. */
    it('remembers a limit of 0 as a choice, which is not the same as nothing', async () => {
      await optIn();
      await repo.saveLimit(GUILD, PRIMARY, USER, 0);
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: null, limit: 0, privacy: null });
    });

    it('keeps one member, and one creator channel, apart from another', async () => {
      await optIn();
      await optIn(OTHER_PRIMARY);
      await repo.saveName(GUILD, PRIMARY, USER, 'one');
      await repo.saveName(GUILD, PRIMARY, OTHER_USER, 'two');
      await repo.saveName(GUILD, OTHER_PRIMARY, USER, 'three');

      expect((await repo.get(PRIMARY, USER))?.name).toBe('one');
      expect((await repo.get(PRIMARY, OTHER_USER))?.name).toBe('two');
      expect((await repo.get(OTHER_PRIMARY, USER))?.name).toBe('three');
    });

    /**
     * Three commands can finish in the same moment, and an upsert that read the row first
     * would let two of them both insert, one failing on the key, or one overwrite the other.
     */
    it('keeps every setting when three saves for a new member run at once', async () => {
      await optIn();
      const results = await Promise.all([
        repo.saveName(GUILD, PRIMARY, USER, 'den'),
        repo.saveLimit(GUILD, PRIMARY, USER, 3),
        repo.savePrivacy(GUILD, PRIMARY, USER, 'private'),
      ]);
      expect(results).toEqual([{ status: 'saved' }, { status: 'saved' }, { status: 'saved' }]);
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: 'den', limit: 3, privacy: 'private' });
      expect(await rows()).toHaveLength(1);
    });
  });

  /**
   * The check and the write are one statement, so there is no window in which the flag is
   * read as on and written after it turned off, and no `auto_channels` read before a save.
   */
  describe('the opt-in', () => {
    it('writes nothing for a creator channel that never turned it on', async () => {
      await creators.upsert(GUILD, PRIMARY, { name: 'Room ##' });
      expect(await repo.saveName(GUILD, PRIMARY, USER, 'den')).toEqual({ status: 'notOptedIn' });
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 4)).toEqual({ status: 'notOptedIn' });
      expect(await repo.savePrivacy(GUILD, PRIMARY, USER, 'private')).toEqual({
        status: 'notOptedIn',
      });
      expect(await rows()).toEqual([]);
    });

    it('writes nothing for a creator channel that turned it off, or that does not exist', async () => {
      await creators.upsert(GUILD, PRIMARY, { rememberPrefs: false });
      expect(await repo.saveName(GUILD, PRIMARY, USER, 'den')).toEqual({ status: 'notOptedIn' });
      expect(await repo.saveName(GUILD, 'no-such-channel', USER, 'den')).toEqual({
        status: 'notOptedIn',
      });
      expect(await rows()).toEqual([]);
    });

    /** A creator channel id is global, and a server must not save into another server's. */
    it('writes nothing when the creator channel belongs to another server', async () => {
      await optIn(PRIMARY, GUILD);
      expect(await repo.saveName(OTHER_GUILD, PRIMARY, USER, 'den')).toEqual({
        status: 'notOptedIn',
      });
      expect(await rows()).toEqual([]);
    });

    it('does not rewrite a row that carries another server, even for an opted-in channel', async () => {
      await optIn(PRIMARY, GUILD);
      await stage({ guild: OTHER_GUILD, name: 'theirs' });

      expect(await repo.saveName(GUILD, PRIMARY, USER, 'mine')).toEqual({ status: 'notOptedIn' });
      expect((await rows())[0]).toMatchObject({ guild_id: OTHER_GUILD, name_template: 'theirs' });
    });

    /** Opted in on another fleet's row is still this creator channel: a channel id has one owner. */
    it('reads the flag from the creator channel whichever fleet owns it', async () => {
      await betaCreators.upsert(GUILD, PRIMARY, { rememberPrefs: true });
      expect(await repo.saveName(GUILD, PRIMARY, USER, 'den')).toEqual({ status: 'saved' });
    });

    /** Turning it off keeps the rows, dormant, and stops anything reaching them. */
    it('keeps rows dormant when it is turned off, and refuses to change them', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'den');

      await creators.upsert(GUILD, PRIMARY, { rememberPrefs: false });
      expect(await repo.saveName(GUILD, PRIMARY, USER, 'changed')).toEqual({
        status: 'notOptedIn',
      });
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 5)).toEqual({ status: 'notOptedIn' });
      // Still there, unchanged, for the day it is turned back on.
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: 'den', limit: null, privacy: null });

      await optIn();
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 5)).toEqual({ status: 'saved' });
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: 'den', limit: 5, privacy: null });
    });
  });

  describe('what a save refuses', () => {
    it('refuses a name past the cap and writes nothing, and takes one exactly at it', async () => {
      await optIn();
      const cap = 'x'.repeat(MAX_MEMBER_PREF_NAME_LENGTH);
      expect(await repo.saveName(GUILD, PRIMARY, USER, `${cap}y`)).toEqual({
        status: 'tooLong',
        max: MAX_MEMBER_PREF_NAME_LENGTH,
      });
      expect(await rows()).toEqual([]);

      expect(await repo.saveName(GUILD, PRIMARY, USER, cap)).toEqual({ status: 'saved' });
      expect((await repo.get(PRIMARY, USER))?.name).toBe(cap);
    });

    /** A refused name is not a clear: what the member had stays, rather than being cut. */
    it('leaves a saved name alone when a longer one is refused', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'den');
      await repo.saveName(GUILD, PRIMARY, USER, 'x'.repeat(MAX_MEMBER_PREF_NAME_LENGTH + 1));
      expect((await repo.get(PRIMARY, USER))?.name).toBe('den');
    });

    it('refuses an empty name, a name Postgres cannot store, and a limit Discord would refuse', async () => {
      await optIn();
      expect(await repo.saveName(GUILD, PRIMARY, USER, '')).toEqual({ status: 'invalid' });
      expect(await repo.saveName(GUILD, PRIMARY, USER, '   ')).toEqual({ status: 'invalid' });
      expect(await repo.saveName(GUILD, PRIMARY, USER, 'a\u0000b')).toEqual({ status: 'invalid' });
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 100)).toEqual({ status: 'invalid' });
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, -1)).toEqual({ status: 'invalid' });
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 2.5)).toEqual({ status: 'invalid' });
      expect(await repo.savePrivacy(GUILD, PRIMARY, USER, 'public' as never)).toEqual({
        status: 'invalid',
      });
      expect(await rows()).toEqual([]);
    });

    it('takes the largest limit Discord allows', async () => {
      await optIn();
      expect(await repo.saveLimit(GUILD, PRIMARY, USER, 99)).toEqual({ status: 'saved' });
    });

    /** The column is text, so a newer build may store a mode this one cannot apply. */
    it('reads around a privacy it does not know', async () => {
      await stage({ name: 'den', privacy: 'sealed' });
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: 'den', limit: null, privacy: null });
    });
  });

  describe('clearing one setting', () => {
    it('removes just that setting while others remain', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'den');
      await repo.saveLimit(GUILD, PRIMARY, USER, 4);

      expect(await repo.saveName(GUILD, PRIMARY, USER, null)).toEqual({ status: 'cleared' });
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: null, limit: 4, privacy: null });
    });

    /** A row exists only while somebody has something remembered. */
    it.each([
      ['name', (g: string) => repo.saveName(g, PRIMARY, USER, null)],
      ['limit', (g: string) => repo.saveLimit(g, PRIMARY, USER, null)],
      ['privacy', (g: string) => repo.savePrivacy(g, PRIMARY, USER, null)],
    ])('deletes the row when the %s was the last thing in it', async (field, clear) => {
      await optIn();
      if (field === 'name') await repo.saveName(GUILD, PRIMARY, USER, 'den');
      if (field === 'limit') await repo.saveLimit(GUILD, PRIMARY, USER, 4);
      if (field === 'privacy') await repo.savePrivacy(GUILD, PRIMARY, USER, 'private');

      expect(await clear(GUILD)).toEqual({ status: 'cleared' });
      expect(await rows()).toEqual([]);
      expect(await repo.get(PRIMARY, USER)).toBeUndefined();
    });

    it('deletes the row only when every setting has been cleared', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'den');
      await repo.saveLimit(GUILD, PRIMARY, USER, 4);
      await repo.savePrivacy(GUILD, PRIMARY, USER, 'hidden');

      await repo.saveName(GUILD, PRIMARY, USER, null);
      await repo.savePrivacy(GUILD, PRIMARY, USER, null);
      expect(await rows()).toHaveLength(1);
      await repo.saveLimit(GUILD, PRIMARY, USER, null);
      expect(await rows()).toEqual([]);
    });

    it('is idempotent, and creates nothing when there was nothing to clear', async () => {
      await optIn();
      expect(await repo.saveName(GUILD, PRIMARY, USER, null)).toEqual({ status: 'cleared' });
      expect(await repo.savePrivacy(GUILD, PRIMARY, USER, null)).toEqual({ status: 'cleared' });
      expect(await rows()).toEqual([]);

      await repo.saveLimit(GUILD, PRIMARY, USER, 3);
      await repo.saveName(GUILD, PRIMARY, USER, null);
      await repo.saveName(GUILD, PRIMARY, USER, null);
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: null, limit: 3, privacy: null });
    });

    /** A replay that changes nothing should not make a row look recently used. */
    it('does not move updated_at when the setting was already empty', async () => {
      await optIn();
      await stage({ limit: 3, ageDays: 10 });
      const before = at((await rows())[0]!);
      await repo.saveName(GUILD, PRIMARY, USER, null);
      expect(at((await rows())[0]!)).toBe(before);
    });

    /**
     * Not gated on the opt-in, unlike a save: a clear only removes what a member already
     * has, and a dormant value that came back unasked the day an admin turned this on again
     * is a value the member had reset.
     */
    it('works while the creator channel does not remember, since it only removes', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'den');
      await repo.saveLimit(GUILD, PRIMARY, USER, 4);
      await creators.upsert(GUILD, PRIMARY, { rememberPrefs: false });

      await repo.saveName(GUILD, PRIMARY, USER, null);
      expect(await repo.get(PRIMARY, USER)).toEqual({ name: null, limit: 4, privacy: null });
      await repo.saveLimit(GUILD, PRIMARY, USER, null);
      expect(await rows()).toEqual([]);
    });

    it('never clears another member, another creator channel or a row that carries another server', async () => {
      await stage({ user: OTHER_USER, name: 'theirs' });
      await stage({ primary: OTHER_PRIMARY, name: 'elsewhere' });
      await stage({ primary: 'creator-3', guild: OTHER_GUILD, name: 'abroad' });
      const names = async () => (await rows()).map((r) => r.name_template).sort();

      // No row for this member in this creator channel, so there is nothing to touch.
      await repo.saveName(GUILD, PRIMARY, USER, null);
      // The right member and creator channel but another server's row: the guild is what refuses.
      await repo.saveName(GUILD, 'creator-3', USER, null);
      expect(await names()).toEqual(['abroad', 'elsewhere', 'theirs']);

      await repo.saveName(OTHER_GUILD, 'creator-3', USER, null);
      expect(await names()).toEqual(['elsewhere', 'theirs']);
    });
  });

  describe('the admin readout and clear', () => {
    it('counts the members who have something saved for one creator channel in one server', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'a');
      await repo.saveLimit(GUILD, PRIMARY, OTHER_USER, 3);
      await stage({ primary: OTHER_PRIMARY, name: 'elsewhere' });
      await stage({ guild: OTHER_GUILD, user: 'user-9', name: 'abroad' });

      expect(await repo.countByPrimary(GUILD, PRIMARY)).toBe(2);
      expect(await repo.countByPrimary(GUILD, OTHER_PRIMARY)).toBe(1);
      expect(await repo.countByPrimary(GUILD, 'nobody')).toBe(0);
      // Bound to the guild: each server counts only the rows that carry its own id.
      expect(await repo.countByPrimary(OTHER_GUILD, PRIMARY)).toBe(1);
      expect(await repo.countByPrimary('guild-3', PRIMARY)).toBe(0);
    });

    it('clears every member of one creator channel and says how many', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'a');
      await repo.saveLimit(GUILD, PRIMARY, OTHER_USER, 3);
      await stage({ primary: OTHER_PRIMARY, name: 'elsewhere' });

      expect(await repo.clearByPrimary(GUILD, PRIMARY)).toBe(2);
      expect((await rows()).map((r) => r.primary_channel_id)).toEqual([OTHER_PRIMARY]);
      // A second press finds nothing, and that is not an error.
      expect(await repo.clearByPrimary(GUILD, PRIMARY)).toBe(0);
    });

    /** An admin of one server naming another's creator channel clears nothing. */
    it('is bound to the server, so naming another server channel removes nothing', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'a');
      expect(await repo.clearByPrimary(OTHER_GUILD, PRIMARY)).toBe(0);
      expect(await repo.get(PRIMARY, USER)).toBeDefined();
    });

    it('works while the creator channel does not remember, since the rows are only dormant', async () => {
      await optIn();
      await repo.saveName(GUILD, PRIMARY, USER, 'a');
      await creators.upsert(GUILD, PRIMARY, { rememberPrefs: false });
      expect(await repo.countByPrimary(GUILD, PRIMARY)).toBe(1);
      expect(await repo.clearByPrimary(GUILD, PRIMARY)).toBe(1);
    });
  });

  describe('erasure on request', () => {
    it('deletes everything about one member across creator channels and servers', async () => {
      await stage({ name: 'a' });
      await stage({ primary: OTHER_PRIMARY, name: 'b' });
      await stage({ guild: OTHER_GUILD, primary: 'creator-3', name: 'c' });
      await stage({ user: OTHER_USER, name: 'someone else' });

      expect(await repo.deleteByUser(USER)).toBe(3);
      expect((await rows()).map((r) => r.user_id)).toEqual([OTHER_USER]);
      expect(await repo.deleteByUser(USER)).toBe(0);
    });

    it('deletes one server and leaves every other alone', async () => {
      await stage({ name: 'a' });
      await stage({ user: OTHER_USER, name: 'b' });
      await stage({ guild: OTHER_GUILD, primary: 'creator-3', name: 'c' });

      expect(await repo.deleteByGuild(GUILD)).toBe(2);
      expect((await rows()).map((r) => r.guild_id)).toEqual([OTHER_GUILD]);
    });
  });

  /**
   * The sweep deletes rows whose creator channel is gone everywhere, after a grace, and
   * can never reach a live creator channel's rows however old they are.
   */
  describe('the orphan sweep', () => {
    const SWEEP = { olderThanMs: MEMBER_PREFS_ORPHAN_GRACE_MS, limit: 100 };

    it('deletes an old row whose creator channel is gone', async () => {
      await stage({ name: 'orphan', ageDays: 8 });
      expect(await repo.deleteOrphans(SWEEP)).toBe(1);
      expect(await rows()).toEqual([]);
    });

    /**
     * The `/import` undo: a creator channel dropped by an import can come back from the
     * pre-import snapshot, which carries no remembered settings.
     */
    it('keeps an orphan until it has waited out the grace period', async () => {
      await stage({ name: 'fresh', ageDays: 6.9 });
      expect(await repo.deleteOrphans(SWEEP)).toBe(0);
      expect(await rows()).toHaveLength(1);

      // And what makes the grace a real window: the creator channel returns, and nothing is lost.
      await optIn();
      expect(await repo.deleteOrphans({ olderThanMs: 0, limit: 100 })).toBe(0);
      expect(await repo.get(PRIMARY, USER)).toBeDefined();
    });

    it('takes a row of any age when the grace is zero', async () => {
      await stage({ name: 'just now', ageDays: 0 });
      expect(await repo.deleteOrphans({ olderThanMs: 0, limit: 100 })).toBe(1);
    });

    it('never deletes a row whose creator channel exists, however old, remembering or not', async () => {
      await optIn(PRIMARY);
      await creators.upsert(GUILD, OTHER_PRIMARY, { name: 'Room ##' });
      await stage({ name: 'ancient', ageDays: 400 });
      await stage({ primary: OTHER_PRIMARY, name: 'dormant', ageDays: 400 });

      expect(await repo.deleteOrphans(SWEEP)).toBe(0);
      expect(await rows()).toHaveLength(2);
    });

    /**
     * Not fleet-scoped: a creator channel id belongs to one fleet, and a row in ANY of them
     * is the creator channel these rows name. Scoping the check would invent orphans out of
     * the other fleets' creator channels, on the next sweep of the first fleet to run it.
     */
    it('keeps rows whose creator channel exists in another fleet', async () => {
      await betaCreators.upsert(GUILD, PRIMARY, { rememberPrefs: true });
      await stage({ name: 'beta owns it', ageDays: 30 });

      expect(await repo.deleteOrphans(SWEEP)).toBe(0);
      expect(await rows()).toHaveLength(1);
    });

    it('deletes at most the limit per call, oldest first, and a second call carries on', async () => {
      await stage({ user: 'u-newest', ageDays: 9 });
      await stage({ user: 'u-oldest', ageDays: 30 });
      await stage({ user: 'u-middle', ageDays: 15 });
      await stage({ user: 'u-fresh', ageDays: 1 });

      expect(await repo.deleteOrphans({ ...SWEEP, limit: 2 })).toBe(2);
      expect((await rows()).map((r) => r.user_id).sort()).toEqual(['u-fresh', 'u-newest']);
      expect(await repo.deleteOrphans({ ...SWEEP, limit: 2 })).toBe(1);
      expect((await rows()).map((r) => r.user_id)).toEqual(['u-fresh']);
      expect(await repo.deleteOrphans({ ...SWEEP, limit: 2 })).toBe(0);
    });

    it('does nothing for a limit that is not a positive number', async () => {
      await stage({ name: 'orphan', ageDays: 30 });
      expect(await repo.deleteOrphans({ ...SWEEP, limit: 0 })).toBe(0);
      expect(await repo.deleteOrphans({ ...SWEEP, limit: -5 })).toBe(0);
      expect(await repo.deleteOrphans({ ...SWEEP, limit: Number.NaN })).toBe(0);
      expect(await rows()).toHaveLength(1);
    });

    it('sweeps orphans in every server in one pass, which is the point of it', async () => {
      await stage({ guild: GUILD, primary: 'gone-1', name: 'a', ageDays: 20 });
      await stage({ guild: OTHER_GUILD, primary: 'gone-2', name: 'b', ageDays: 20 });
      expect(await repo.deleteOrphans(SWEEP)).toBe(2);
    });

    /** The sweep is idempotent: nothing left to do is not an error. */
    it('answers 0 when there is nothing to sweep', async () => {
      expect(await repo.deleteOrphans(SWEEP)).toBe(0);
    });
  });
});
