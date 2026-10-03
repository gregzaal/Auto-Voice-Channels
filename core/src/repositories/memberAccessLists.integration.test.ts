import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MemberAccessListRepository } from './memberAccessLists.js';
import { MAX_SAVED_BLOCKED, MAX_SAVED_TRUSTED } from '../domain/roomAccess.js';
import { memberAccessLists } from '../db/schema.js';
import { runMigrations } from '../db/migrate.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';

const GUILD = 'guild-1';
const OWNER = 'owner-1';

/** `m-00`, `m-01`, ... so a list's expected contents read as a range. */
const members = (n: number, prefix = 'm') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, '0')}`);

describe('MemberAccessListRepository (integration)', () => {
  let env: PgTestEnv;
  let repo: MemberAccessListRepository;

  beforeAll(async () => {
    env = await startPostgres();
    repo = new MemberAccessListRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(memberAccessLists);
  });

  /** Rows for one member in one server under one owner, straight from the table. */
  const rowsFor = async (memberId: string, guildId = GUILD, ownerId = OWNER) =>
    (
      await env.handle.db.execute<{ kind: string }>(
        sql`SELECT kind FROM member_access_lists
             WHERE guild_id = ${guildId} AND owner_id = ${ownerId} AND member_id = ${memberId}`,
      )
    ).rows;

  describe('add and get', () => {
    it('starts empty', async () => {
      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: [], blocked: [] });
      expect(await repo.counts(GUILD, OWNER)).toEqual({ trusted: 0, blocked: 0 });
    });

    it('adds a member, and a repeat is a no-op that says so', async () => {
      expect(await repo.add(GUILD, OWNER, 'm-1', 'trusted')).toEqual({ outcome: 'added' });
      expect(await repo.add(GUILD, OWNER, 'm-1', 'trusted')).toEqual({ outcome: 'already' });
      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: ['m-1'], blocked: [] });
    });

    it('lists each list oldest entry first', async () => {
      for (const id of ['m-3', 'm-1', 'm-2']) await repo.add(GUILD, OWNER, id, 'trusted');
      await repo.add(GUILD, OWNER, 'b-1', 'blocked');
      expect(await repo.get(GUILD, OWNER)).toEqual({
        trusted: ['m-3', 'm-1', 'm-2'],
        blocked: ['b-1'],
      });
    });

    it('keeps one owner, and one server, apart from another', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, 'owner-2', 'm-2', 'blocked');
      await repo.add('guild-2', OWNER, 'm-3', 'trusted');

      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: ['m-1'], blocked: [] });
      expect(await repo.get(GUILD, 'owner-2')).toEqual({ trusted: [], blocked: ['m-2'] });
      expect(await repo.get('guild-2', OWNER)).toEqual({ trusted: ['m-3'], blocked: [] });
    });

    /** The column is plain text, so a newer build may add a kind this one must read around. */
    it('reads around a kind it does not know', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await env.handle.db.execute(
        sql`INSERT INTO member_access_lists (guild_id, owner_id, member_id, kind)
            VALUES (${GUILD}, ${OWNER}, 'm-future', 'muted')`,
      );
      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: ['m-1'], blocked: [] });
      expect((await repo.listByGuild(GUILD)).get(OWNER)).toEqual({
        trusted: ['m-1'],
        blocked: [],
      });
    });
  });

  /**
   * The primary key is (guild, owner, member) WITHOUT kind, so the lists are
   * exclusive by construction, not by a check somebody has to remember.
   */
  describe('mutual exclusion', () => {
    it('moves a member from trusted to blocked and never leaves them on both', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');

      expect(await repo.add(GUILD, OWNER, 'm-1', 'blocked')).toEqual({
        outcome: 'flipped',
        from: 'trusted',
      });

      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: [], blocked: ['m-1'] });
      expect(await rowsFor('m-1')).toEqual([{ kind: 'blocked' }]);
    });

    /**
     * The column is plain text, and `from` is typed as one of our two lists, so a
     * member sitting on a newer build's kind must not come back as `flipped` from
     * a list they were never on: the caller would take back a grant that list
     * never made.
     */
    it('counts a member on a kind it does not know as a new entry and not a flip', async () => {
      await env.handle.db.execute(
        sql`INSERT INTO member_access_lists (guild_id, owner_id, member_id, kind)
            VALUES (${GUILD}, ${OWNER}, 'm-future', 'muted')`,
      );

      expect(await repo.add(GUILD, OWNER, 'm-future', 'blocked')).toEqual({ outcome: 'added' });

      expect(await rowsFor('m-future')).toEqual([{ kind: 'blocked' }]);
    });

    it('moves a member back from blocked to trusted', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'blocked');
      expect(await repo.add(GUILD, OWNER, 'm-1', 'trusted')).toEqual({
        outcome: 'flipped',
        from: 'blocked',
      });
      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: ['m-1'], blocked: [] });
    });

    it('keeps the time a member was first listed across a flip, and moves updated_at', async () => {
      const times = () =>
        env.handle.db
          .select({
            createdAt: memberAccessLists.createdAt,
            updatedAt: memberAccessLists.updatedAt,
          })
          .from(memberAccessLists)
          .where(eq(memberAccessLists.memberId, 'm-1'))
          .then((rows) => rows[0]!);
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      const before = await times();
      await new Promise((resolve) => setTimeout(resolve, 15));

      await repo.add(GUILD, OWNER, 'm-1', 'blocked');

      const after = await times();
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });

    /** A member in two servers is two independent entries. */
    it('flips only within one owner in one server', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add('guild-2', OWNER, 'm-1', 'blocked');
      await repo.add(GUILD, 'owner-2', 'm-1', 'blocked');

      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: ['m-1'], blocked: [] });
    });

    /**
     * The primary key alone leaves one row whatever happens, so a row count would
     * pass without the advisory lock. What the lock decides is what each caller is
     * TOLD: unserialised, both read an empty table and both answer `added`, and the
     * caller of the loser then applies an overwrite for a list the table says the
     * member is no longer on. Serialised, the second sees the first and flips.
     */
    it('tells exactly one of two racing adds that it flipped the other, and ends on one list', async () => {
      for (const id of members(12)) {
        const [asTrusted, asBlocked] = await Promise.all([
          repo.add(GUILD, OWNER, id, 'trusted'),
          repo.add(GUILD, OWNER, id, 'blocked'),
        ]);

        const trustedFirst = asTrusted.outcome === 'added';
        expect(trustedFirst ? asTrusted : asBlocked, id).toEqual({ outcome: 'added' });
        expect(trustedFirst ? asBlocked : asTrusted, id).toEqual({
          outcome: 'flipped',
          from: trustedFirst ? 'trusted' : 'blocked',
        });
        // The one that ran second is the one the table kept.
        expect(await rowsFor(id), id).toEqual([{ kind: trustedFirst ? 'blocked' : 'trusted' }]);
      }
      const lists = await repo.get(GUILD, OWNER);
      expect(lists.trusted.length + lists.blocked.length).toBe(12);
    });
  });

  describe('caps', () => {
    it('refuses the 26th trusted member and says what the limit is', async () => {
      for (const id of members(MAX_SAVED_TRUSTED)) {
        expect(await repo.add(GUILD, OWNER, id, 'trusted')).toEqual({ outcome: 'added' });
      }
      expect(await repo.add(GUILD, OWNER, 'one-too-many', 'trusted')).toEqual({
        outcome: 'full',
        limit: MAX_SAVED_TRUSTED,
      });
      expect((await repo.get(GUILD, OWNER)).trusted).toHaveLength(MAX_SAVED_TRUSTED);
    });

    it('refuses the 26th blocked member', async () => {
      for (const id of members(MAX_SAVED_BLOCKED)) await repo.add(GUILD, OWNER, id, 'blocked');
      expect(await repo.add(GUILD, OWNER, 'one-too-many', 'blocked')).toEqual({
        outcome: 'full',
        limit: MAX_SAVED_BLOCKED,
      });
    });

    it('caps the two lists independently', async () => {
      for (const id of members(MAX_SAVED_TRUSTED, 't')) await repo.add(GUILD, OWNER, id, 'trusted');
      for (const id of members(MAX_SAVED_BLOCKED, 'b')) await repo.add(GUILD, OWNER, id, 'blocked');
      expect(await repo.counts(GUILD, OWNER)).toEqual({
        trusted: MAX_SAVED_TRUSTED,
        blocked: MAX_SAVED_BLOCKED,
      });
    });

    it('caps per owner and per server, not across them', async () => {
      for (const id of members(MAX_SAVED_TRUSTED)) await repo.add(GUILD, OWNER, id, 'trusted');
      expect(await repo.add(GUILD, 'owner-2', 'm-1', 'trusted')).toEqual({ outcome: 'added' });
      expect(await repo.add('guild-2', OWNER, 'm-1', 'trusted')).toEqual({ outcome: 'added' });
    });

    it('still answers already for a member on a full list', async () => {
      for (const id of members(MAX_SAVED_TRUSTED)) await repo.add(GUILD, OWNER, id, 'trusted');
      expect(await repo.add(GUILD, OWNER, 'm-00', 'trusted')).toEqual({ outcome: 'already' });
    });

    /** A flip into a full list is refused whole: the member stays where they were. */
    it('refuses a flip into a full list and leaves the member where they were', async () => {
      for (const id of members(MAX_SAVED_BLOCKED, 'b')) await repo.add(GUILD, OWNER, id, 'blocked');
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');

      expect(await repo.add(GUILD, OWNER, 'm-1', 'blocked')).toEqual({
        outcome: 'full',
        limit: MAX_SAVED_BLOCKED,
      });

      expect(await rowsFor('m-1')).toEqual([{ kind: 'trusted' }]);
    });

    it('lets a list take a new member once one is removed', async () => {
      for (const id of members(MAX_SAVED_TRUSTED)) await repo.add(GUILD, OWNER, id, 'trusted');
      await repo.remove(GUILD, OWNER, 'm-00');
      expect(await repo.add(GUILD, OWNER, 'm-new', 'trusted')).toEqual({ outcome: 'added' });
    });

    /**
     * The race the lock exists for. Both writers read 24, both see room, and
     * without serialisation both insert.
     */
    it('lets exactly one of two writers racing for the last slot have it', async () => {
      for (const id of members(MAX_SAVED_TRUSTED - 1)) await repo.add(GUILD, OWNER, id, 'trusted');

      const results = await Promise.all([
        repo.add(GUILD, OWNER, 'racer-a', 'trusted'),
        repo.add(GUILD, OWNER, 'racer-b', 'trusted'),
      ]);

      expect(results.map((r) => r.outcome).sort()).toEqual(['added', 'full']);
      expect((await repo.get(GUILD, OWNER)).trusted).toHaveLength(MAX_SAVED_TRUSTED);
    });

    /**
     * The harder case. With no entries there is no row, so a `SELECT ... FOR
     * UPDATE` would lock nothing and every writer would count zero. The
     * advisory lock is what holds this to the cap.
     */
    it('holds the cap when many writers race to make the first entries, with no row to lock', async () => {
      const racers = members(MAX_SAVED_TRUSTED + 15, 'racer');

      const results = await Promise.all(racers.map((id) => repo.add(GUILD, OWNER, id, 'trusted')));

      expect(results.filter((r) => r.outcome === 'added')).toHaveLength(MAX_SAVED_TRUSTED);
      expect(results.filter((r) => r.outcome === 'full')).toHaveLength(15);
      expect(await repo.counts(GUILD, OWNER)).toEqual({ trusted: MAX_SAVED_TRUSTED, blocked: 0 });
    });

    it('holds each owner to the cap independently when two owners race at once', async () => {
      const results = await Promise.all([
        ...members(MAX_SAVED_TRUSTED + 5, 'a').map((id) =>
          repo.add(GUILD, 'owner-a', id, 'trusted'),
        ),
        ...members(MAX_SAVED_TRUSTED + 5, 'b').map((id) =>
          repo.add(GUILD, 'owner-b', id, 'trusted'),
        ),
      ]);
      expect(results.filter((r) => r.outcome === 'added')).toHaveLength(MAX_SAVED_TRUSTED * 2);
      expect(await repo.counts(GUILD, 'owner-a')).toEqual({
        trusted: MAX_SAVED_TRUSTED,
        blocked: 0,
      });
      expect(await repo.counts(GUILD, 'owner-b')).toEqual({
        trusted: MAX_SAVED_TRUSTED,
        blocked: 0,
      });
    });
  });

  describe('remove and clear', () => {
    it('removes a member from whichever list they are on and says which', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, OWNER, 'm-2', 'blocked');

      expect(await repo.remove(GUILD, OWNER, 'm-1')).toBe('trusted');
      expect(await repo.remove(GUILD, OWNER, 'm-2')).toBe('blocked');
      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: [], blocked: [] });
    });

    it('answers null for a member who is on neither list, so a retry is harmless', async () => {
      expect(await repo.remove(GUILD, OWNER, 'nobody')).toBeNull();
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      expect(await repo.remove(GUILD, OWNER, 'm-1')).toBe('trusted');
      expect(await repo.remove(GUILD, OWNER, 'm-1')).toBeNull();
    });

    it('deletes a row of a kind it does not know when asked by name, and says it was on neither list', async () => {
      await env.handle.db.execute(
        sql`INSERT INTO member_access_lists (guild_id, owner_id, member_id, kind)
            VALUES (${GUILD}, ${OWNER}, 'm-future', 'muted')`,
      );

      expect(await repo.remove(GUILD, OWNER, 'm-future')).toBeNull();

      expect(await rowsFor('m-future')).toEqual([]);
    });

    it('removes only that owner in that server', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, 'owner-2', 'm-1', 'trusted');
      await repo.add('guild-2', OWNER, 'm-1', 'trusted');

      await repo.remove(GUILD, OWNER, 'm-1');

      expect((await repo.get(GUILD, 'owner-2')).trusted).toEqual(['m-1']);
      expect((await repo.get('guild-2', OWNER)).trusted).toEqual(['m-1']);
    });

    it('clears one list and returns the members it held', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, OWNER, 'm-2', 'trusted');
      await repo.add(GUILD, OWNER, 'b-1', 'blocked');

      expect((await repo.clear(GUILD, OWNER, 'trusted')).sort()).toEqual(['m-1', 'm-2']);

      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: [], blocked: ['b-1'] });
    });

    it('clears both lists when no kind is given', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, OWNER, 'b-1', 'blocked');

      expect((await repo.clear(GUILD, OWNER)).sort()).toEqual(['b-1', 'm-1']);

      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: [], blocked: [] });
      expect(await repo.clear(GUILD, OWNER)).toEqual([]);
    });

    it('clears only that owner in that server', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, 'owner-2', 'm-1', 'trusted');
      await repo.add('guild-2', OWNER, 'm-1', 'trusted');

      await repo.clear(GUILD, OWNER);

      expect((await repo.get(GUILD, 'owner-2')).trusted).toEqual(['m-1']);
      expect((await repo.get('guild-2', OWNER)).trusted).toEqual(['m-1']);
    });
  });

  /** Erasure on request: both are the only writes here that are not bound to one server. */
  describe('erasure on request', () => {
    beforeEach(async () => {
      // `victim` is listed by two owners in two servers, and owns a list of their own.
      await repo.add(GUILD, 'owner-a', 'victim', 'trusted');
      await repo.add(GUILD, 'owner-b', 'victim', 'blocked');
      await repo.add('guild-2', 'owner-a', 'victim', 'blocked');
      await repo.add(GUILD, 'owner-a', 'bystander', 'trusted');
      await repo.add(GUILD, 'victim', 'friend', 'trusted');
      await repo.add('guild-2', 'victim', 'friend', 'blocked');
    });

    it('removes a listed person from every owner and every server, and nobody else', async () => {
      expect(await repo.deleteByMember('victim')).toBe(3);

      expect(await repo.get(GUILD, 'owner-a')).toEqual({ trusted: ['bystander'], blocked: [] });
      expect(await repo.get(GUILD, 'owner-b')).toEqual({ trusted: [], blocked: [] });
      expect(await repo.get('guild-2', 'owner-a')).toEqual({ trusted: [], blocked: [] });
      // Their own lists are the OWNER's data, and are not what this erases.
      expect(await repo.get(GUILD, 'victim')).toEqual({ trusted: ['friend'], blocked: [] });
    });

    it('removes an owner’s lists from every server, and nobody else’s', async () => {
      expect(await repo.deleteByOwner('victim')).toBe(2);

      expect(await repo.get(GUILD, 'victim')).toEqual({ trusted: [], blocked: [] });
      expect(await repo.get('guild-2', 'victim')).toEqual({ trusted: [], blocked: [] });
      // Entries other owners made about them are theirs, not the victim's.
      expect(await repo.get(GUILD, 'owner-a')).toEqual({
        trusted: ['victim', 'bystander'],
        blocked: [],
      });
    });

    it('is idempotent and reports nothing for someone with no data', async () => {
      expect(await repo.deleteByMember('victim')).toBe(3);
      expect(await repo.deleteByMember('victim')).toBe(0);
      expect(await repo.deleteByOwner('stranger')).toBe(0);
      expect(await repo.deleteByMember('stranger')).toBe(0);
    });
  });

  describe('listByGuild and counts', () => {
    it('returns every owner’s lists in one read, keyed by owner', async () => {
      await repo.add(GUILD, 'owner-a', 'm-1', 'trusted');
      await repo.add(GUILD, 'owner-a', 'm-2', 'blocked');
      await repo.add(GUILD, 'owner-b', 'm-3', 'blocked');
      await repo.add('guild-2', 'owner-c', 'm-4', 'trusted');

      const byOwner = await repo.listByGuild(GUILD);

      expect([...byOwner.keys()].sort()).toEqual(['owner-a', 'owner-b']);
      expect(byOwner.get('owner-a')).toEqual({ trusted: ['m-1'], blocked: ['m-2'] });
      expect(byOwner.get('owner-b')).toEqual({ trusted: [], blocked: ['m-3'] });
    });

    it('is empty for a server nobody has saved anyone in', async () => {
      expect((await repo.listByGuild('nobody-here')).size).toBe(0);
    });

    it('counts each list', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');
      await repo.add(GUILD, OWNER, 'm-2', 'trusted');
      await repo.add(GUILD, OWNER, 'b-1', 'blocked');
      await repo.add(GUILD, 'owner-2', 'x-1', 'blocked');
      expect(await repo.counts(GUILD, OWNER)).toEqual({ trusted: 2, blocked: 1 });
    });
  });

  /**
   * The table is read by the exact shape of these keys: erasure by the listed
   * person and by the owner are deletes, and they stay cheap only if indexed.
   */
  describe('table shape', () => {
    it('has the (guild, owner, member) primary key and both erasure indexes', async () => {
      const pk = await env.handle.db.execute<{ def: string }>(
        sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conrelid = 'member_access_lists'::regclass AND contype = 'p'`,
      );
      expect(pk.rows.map((r) => r.def)).toEqual(['PRIMARY KEY (guild_id, owner_id, member_id)']);

      const indexes = await env.handle.db.execute<{ indexname: string; indexdef: string }>(
        sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'member_access_lists'`,
      );
      const defs = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
      expect(defs['member_access_lists_member_idx']).toMatch(/\(member_id\)/);
      expect(defs['member_access_lists_owner_idx']).toMatch(/\(owner_id, guild_id\)/);
    });

    it('has no fleet column: the lists are shared by every fleet', async () => {
      const cols = await env.handle.db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'member_access_lists'`,
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
        'created_at',
        'guild_id',
        'kind',
        'member_id',
        'owner_id',
        'updated_at',
      ]);
    });
  });

  /**
   * Migration 0043, on a database that went through the whole journal fresh (the
   * harness applies every migration), and again on one that already has it.
   */
  describe('migration 0043', () => {
    it('is a no-op the second time and keeps the rows it already holds', async () => {
      await repo.add(GUILD, OWNER, 'm-1', 'trusted');

      await expect(runMigrations(env.handle.db)).resolves.toBeUndefined();

      expect(await repo.get(GUILD, OWNER)).toEqual({ trusted: ['m-1'], blocked: [] });
    });

    it('added the access column to secondary_channels as nullable jsonb', async () => {
      const col = await env.handle.db.execute<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_name = 'secondary_channels' AND column_name = 'access'`,
      );
      expect(col.rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
    });
  });
});
