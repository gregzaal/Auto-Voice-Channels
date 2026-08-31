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
 * them without passing through either, which is the same shape as
 * `plans/refunds.md` §2.2 (owning one thing authorized a write to another) and
 * gets the same treatment: bind the id where a new caller cannot forget.
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
 * `/import` writes exactly these two (`plans/import_command.md` §5.3 keeps it
 * out of the ephemeral tables), and they are also the two a native export
 * carries, so an id in them can have come from a file.
 */
const USER_SUPPLIED = ['autoChannels.ts', 'managedChannels.ts'];

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

/** Drizzle calls that change a row. A method containing one of these is a write. */
const WRITE_CALLS = ['.update(', '.delete(', '.insert('];

/**
 * Writes that legitimately do not filter on a guild, each with the reason.
 *
 * An entry here is a claim that has to stay true, so keep them few and specific.
 */
const EXEMPT: Record<string, string> = {
  'managedChannels.ts:create':
    'an insert sets the guild rather than filtering on it, so the binding is `guildId: input.guildId` in the values plus an `existing.guildId !== input.guildId` throw on the conflict path. Checked explicitly below.',
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
