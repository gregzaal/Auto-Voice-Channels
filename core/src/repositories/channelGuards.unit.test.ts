import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Binds every write on a channel-keyed table to its guild MECHANICALLY, by
 * reading the repository's own source.
 *
 * **A channel id is globally unique, which is exactly why binding it alone is
 * not enough.** Every one of these tables has `channel_id` as its sole primary
 * key, so a write keyed on the id compiles, runs, and updates whatever row holds
 * that id, in whatever guild. Until `/import` existed that was safe only by the
 * grace of the callers: `primaryFor` checks `primary.guildId === guildId` and
 * `setManagedName` refuses unless `row.guildId === guildId`, both in the service
 * layer. `/import` takes channel ids from a file an admin uploads and writes
 * them without passing through either. Owning one channel must not authorize
 * writes to another: bind the guild id where a new caller cannot forget.
 *
 * `fleet` is already bound by each repository's own `scoped` helper and is not
 * what this file checks. Guild is.
 *
 * Residual limits, both stated rather than papered over. This reads source text,
 * so a predicate built somewhere it cannot follow needs an exemption below. And
 * it proves the guild reaches the statement, not that the value is the right
 * one, which is what the integration tests are for.
 *
 * Relative to this file, not to `process.cwd()`: vitest runs from `avc/` while
 * this sits under `core/src/repositories/`, so a cwd-relative path resolves to
 * nothing and the suite silently collapses to zero assertions.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Tables whose channel ids can arrive from outside the gateway, so a write on
 * them must bind the guild itself.
 *
 * `/import` writes the first two (never the ephemeral channel tables), and they are also the
 * two a native export
 * carries, so an id in them can have come from a file.
 *
 * `memberAccessLists.ts` is here for its own reason: it holds no channel id, but its owner and
 * member ids come from a slash command, its rows are keyed by guild, and an owner in one server
 * must never write another server's list. Its two erasure-on-request deletes are exempt below.
 *
 * `memberRoomPrefs.ts` is here for the same reason, and its creator channel id arrives from a
 * room, which a member can name by typing a command in it. It writes with raw SQL as well as
 * builder calls, which is why `.execute(` counts as a write below. Its erasure by member and its
 * orphan sweep span servers by design and are exempt below.
 */
const USER_SUPPLIED = [
  'autoChannels.ts',
  'managedChannels.ts',
  'memberAccessLists.ts',
  'memberRoomPrefs.ts',
];

/**
 * The ephemeral tables. Enumerated so this file records the distinction rather
 * than leaving them unmentioned, but not held to the binding rule: every id
 * written to them was resolved from a gateway dispatch for one guild, and
 * nothing user-supplied reaches them.
 *
 * **Move a table up to {@link USER_SUPPLIED} the moment anything takes its ids
 * from user input**, and expect the writes to need new parameters when you do.
 */
const GATEWAY_ONLY = ['secondaryChannels.ts', 'joinChannels.ts'];

/**
 * Drizzle calls that change a row. A method containing one of these is a write.
 *
 * `.execute(` is one because a repository that has to check a condition and write in one
 * statement (an `INSERT ... SELECT ... WHERE EXISTS`) can only say so in raw SQL, and a write
 * the scan could not see would be a write nobody checks. It also catches a read that goes
 * through `execute`, which has to bind the guild too, and every one here does.
 */
const WRITE_CALLS = ['.update(', '.delete(', '.insert(', '.execute('];

/**
 * Writes that legitimately do not filter on a guild, each with the reason.
 *
 * An entry here is a claim that has to stay true, so keep them few and specific.
 */
const EXEMPT: Record<string, string> = {
  'managedChannels.ts:create':
    'an insert sets the guild rather than filtering on it, so the binding is `guildId: input.guildId` in the values plus an `existing.guildId !== input.guildId` throw on the conflict path. Checked explicitly below.',
  'memberAccessLists.ts:deleteByMember':
    'erasure on request for the listed person spans every server by design, so it filters on the member instead. An operator tool, not reachable from a command. Checked explicitly below.',
  'memberAccessLists.ts:deleteByOwner':
    'erasure on request for an owner spans every server by design, so it filters on the owner instead. An operator tool, not reachable from a command. Checked explicitly below.',
  'memberRoomPrefs.ts:deleteByUser':
    'erasure on request for a member spans every server and creator channel by design, so it filters on the user instead. An operator tool, not reachable from a command. Checked explicitly below.',
  'memberRoomPrefs.ts:sweepOrphans':
    'the orphan sweep spans every server by design, because the rows it reaches belong to creator channels that no longer exist anywhere. It filters on the missing creator channel and the time since the sweep first saw it missing instead, and is bounded by a limit. Reached only from the periodic sweep. Checked explicitly below.',
};

interface Method {
  name: string;
  body: string;
}

/**
 * Splits a class into its methods by indentation.
 *
 * Deliberately crude: a method starts at two-space indent and runs to the next
 * one. A shape this misses becomes an unchecked write, so the count assertion
 * below is what stops the regex quietly matching nothing.
 */
function methodsOf(source: string): Method[] {
  const out: Method[] = [];
  const start = /^ {2}(?:private |protected |public )?(?:async )?([a-zA-Z_]\w*)\s*\(/;
  let current: Method | null = null;
  for (const line of source.split('\n')) {
    const match = start.exec(line);
    if (match) {
      if (current) out.push(current);
      current = { name: match[1]!, body: line };
      continue;
    }
    if (current) current.body += `\n${line}`;
  }
  if (current) out.push(current);
  return out;
}

/** The parameter list, balanced from the method's own opening paren. */
function signatureOf(body: string): string {
  const open = body.indexOf('(');
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')' && --depth === 0) return body.slice(open, i + 1);
  }
  return body.slice(open);
}

function writesOf(source: string): Method[] {
  return methodsOf(source).filter((m) => WRITE_CALLS.some((call) => m.body.includes(call)));
}

function read(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

describe('channel repository guards', () => {
  /**
   * The count guard. Without it a change to the class shape makes `methodsOf`
   * match nothing and every assertion below passes on an empty list, which is
   * the failure mode a source-scanning test has and a type-level one does not.
   */
  it('finds writes to check in every channel repository', () => {
    for (const file of [...USER_SUPPLIED, ...GATEWAY_ONLY]) {
      const found = writesOf(read(file)).map((m) => m.name);
      expect(
        found.length,
        `no writes found in ${file} - has the class shape changed?`,
      ).toBeGreaterThan(0);
    }
  });

  it('takes a guild id on every write, and binds it in the predicate', () => {
    const problems: string[] = [];

    for (const file of USER_SUPPLIED) {
      for (const method of writesOf(read(file))) {
        if (EXEMPT[`${file}:${method.name}`]) continue;

        if (!/\bguildId\b/.test(signatureOf(method.body))) {
          problems.push(`${file}: ${method.name} writes a channel-keyed row without a guild id`);
          continue;
        }
        // The guild has to reach the statement, not merely the signature. Both
        // spellings count: an inline `eq(table.guildId, guildId)` and the
        // `scopedTo(guildId, channelId)` helper that wraps it.
        const binds =
          /\.guildId,\s*guildId/.test(method.body) || /scopedTo\(\s*guildId/.test(method.body);
        if (!binds) {
          problems.push(`${file}: ${method.name} takes a guild id but never binds it to the row`);
        }
      }
    }

    expect(problems, problems.join('\n')).toEqual([]);
  });

  /**
   * The one exemption, checked rather than trusted. An insert sets the guild, so
   * it cannot filter on it, and the danger is the conflict path handing back a
   * row that belongs to somebody else.
   */
  it('binds the guild on the adopt insert and its conflict path', () => {
    const create = writesOf(read('managedChannels.ts')).find((m) => m.name === 'create');
    expect(create, 'ManagedChannelRepository.create has gone or changed shape').toBeDefined();
    expect(create!.body).toMatch(/guildId:\s*input\.guildId/);
    expect(create!.body).toMatch(/existing\.guildId\s*!==\s*input\.guildId/);
  });

  /**
   * The two erasure exemptions, checked rather than trusted. Each drops the
   * guild only because it is keyed on something wider, and an unkeyed delete
   * here would wipe the whole table, so each has to bind the key it exists for.
   * They are also the only writes on that table that are exempt.
   */
  it('binds each erasure delete to the person it erases, and exempts nothing else on that table', () => {
    const writes = writesOf(read('memberAccessLists.ts'));
    const byMember = writes.find((m) => m.name === 'deleteByMember');
    const byOwner = writes.find((m) => m.name === 'deleteByOwner');
    expect(
      byMember,
      'MemberAccessListRepository.deleteByMember has gone or changed shape',
    ).toBeDefined();
    expect(
      byOwner,
      'MemberAccessListRepository.deleteByOwner has gone or changed shape',
    ).toBeDefined();
    expect(byMember!.body).toMatch(/\.memberId,\s*memberId/);
    expect(byOwner!.body).toMatch(/\.ownerId,\s*ownerId/);

    const exempt = Object.keys(EXEMPT).filter((key) => key.startsWith('memberAccessLists.ts:'));
    expect(exempt.sort()).toEqual([
      'memberAccessLists.ts:deleteByMember',
      'memberAccessLists.ts:deleteByOwner',
    ]);
  });

  /**
   * The remembered settings' two exemptions, checked rather than trusted, for the reason the
   * saved lists' are. The erasure is keyed on the member it erases. The sweep has no guild to
   * bind, so its guard is its predicate: a delete that lost the `NOT EXISTS` on the creator
   * channel, the test that the grace has run from the stamp or the `LIMIT` would wipe live
   * members' settings, one pass at a time.
   * They are also the only writes on that table that are exempt, and every other write binds
   * the guild in a statement that is raw SQL or builder calls alike.
   */
  it('binds the remembered settings erasure to its member, and the sweep to what makes a row an orphan', () => {
    const writes = writesOf(read('memberRoomPrefs.ts'));
    const byUser = writes.find((m) => m.name === 'deleteByUser');
    const sweep = writes.find((m) => m.name === 'sweepOrphans');
    expect(
      byUser,
      'MemberRoomPrefsRepository.deleteByUser has gone or changed shape',
    ).toBeDefined();
    expect(sweep, 'MemberRoomPrefsRepository.sweepOrphans has gone or changed shape').toBeDefined();
    expect(byUser!.body).toMatch(/\.userId,\s*userId/);
    // The statement that deletes, and not the two that only stamp and unstamp.
    const deletion = sweep!.body.slice(sweep!.body.indexOf('DELETE FROM member_room_prefs'));
    expect(deletion).toMatch(/m\.orphaned_at < now\(\)/);
    expect(deletion).toMatch(/NOT EXISTS \(SELECT 1 FROM auto_channels/);
    expect(deletion).toMatch(/LIMIT \$\{limit\}/);
    expect(deletion).toMatch(/SKIP LOCKED/);

    const exempt = Object.keys(EXEMPT).filter((key) => key.startsWith('memberRoomPrefs.ts:'));
    expect(exempt.sort()).toEqual([
      'memberRoomPrefs.ts:deleteByUser',
      'memberRoomPrefs.ts:sweepOrphans',
    ]);
    // The raw writes are in the scan, so none of them can lose its guild binding unseen.
    const names = writes.map((m) => m.name);
    for (const name of ['upsertField', 'clearField', 'clearByPrimary', 'deleteByGuild']) {
      expect(names, `${name} should be a write the scan sees`).toContain(name);
    }
  });

  /** Every exemption names a real method, so a stale one cannot hide a gap. */
  it('has no stale exemptions', () => {
    for (const key of Object.keys(EXEMPT)) {
      const [file, name] = key.split(':');
      expect([...USER_SUPPLIED, ...GATEWAY_ONLY], `unknown file in exemption: ${key}`).toContain(
        file,
      );
      const found = methodsOf(read(file!)).some((m) => m.name === name);
      expect(found, `exemption names a method that no longer exists: ${key}`).toBe(true);
    }
  });
});
