/**
 * One-shot broadcast to every guild on the fleet.
 *
 * Built for the rewrite announcement, but nothing here is specific to it: the
 * copy lives in a file passed with `--file`, so this stays a generic sender and
 * the message stays wherever its author keeps it.
 *
 * **REST only, no gateway.** Logging a second `Client` in with the same token
 * would open a competing session for a shard the running bot already holds, and
 * spend one of the 1,000 daily session starts to do it. Every route used here
 * is plain HTTP, so this can run beside a live fleet without touching it.
 *
 * Dry by default, like every other CLI in this repo. `--apply` sends.
 */

/* eslint-disable no-console */

import { readFileSync } from 'node:fs';
import { REST, Routes } from 'discord.js';
import {
  GuildFleetPresenceRepository,
  GuildRepository,
  createDatabase,
  loadConfig,
  trialPolicyFor,
  type TrialPolicy,
} from '@avc/core';

/** Discord's hard limit for a plain message. */
const MAX_MESSAGE = 2000;

/**
 * How many guilds are in flight at once.
 *
 * Deliberately low. The global REST budget is far higher, but this walks a
 * thousand *different* channels and the failure we care about is not a 429 (the
 * REST client retries those) but a half-finished broadcast that is hard to
 * reason about. Slow and legible beats fast.
 */
const CONCURRENCY = 4;
const PAUSE_MS = 250;

/**
 * Extra delay after a message that went to an owner DM rather than a channel.
 *
 * Posting into a thousand servers the bot was invited to is ordinary traffic.
 * Sending a few hundred unsolicited DMs quickly is the exact shape of a spam
 * run, and Discord's abuse heuristics do not know our intentions. Channel posts
 * stay brisk, DMs are deliberately slow.
 */
const DM_PAUSE_MS = 3_000;

interface Sections {
  body: string;
  pricing: Record<string, string>;
}

/**
 * Parses the `=== name ===` section format.
 *
 * The comment block at the top of the copy file is HTML, so it is stripped
 * rather than treated as part of the first section.
 */
export function parseCopy(raw: string): Sections {
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
  const parts = withoutComments.split(/^===\s*(.+?)\s*===\s*$/m);
  const sections = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) {
    sections.set(parts[i]!.trim(), (parts[i + 1] ?? '').trim());
  }

  const body = sections.get('body');
  if (!body) throw new Error('The copy file has no `=== body ===` section.');
  if (!body.includes('{{PRICING}}')) {
    throw new Error('The body has no {{PRICING}} placeholder, so no pricing would ever be shown.');
  }

  const pricing: Record<string, string> = {};
  for (const [name, text] of sections) {
    if (name.startsWith('pricing:')) pricing[name.slice('pricing:'.length)] = text;
  }
  for (const policy of ['dormant', 'year', 'short', 'active']) {
    if (!pricing[policy]) throw new Error(`The copy file has no \`pricing:${policy}\` section.`);
  }
  return { body, pricing };
}

/**
 * The AGENTS.md copy rules, enforced on the thing actually being sent.
 *
 * `messages.unit.test.ts` does this for the strings compiled into the bot, and
 * this file is not one of them: it is read at runtime and edited by hand right
 * before a broadcast, which is exactly when a smart quote gets pasted in. A
 * thousand servers is the wrong place to find out.
 */
export function checkCopyRules(label: string, text: string): string[] {
  const problems: string[] = [];
  if (/[—–]/.test(text)) problems.push(`${label}: contains an em or en dash`);
  if (/[‘’“”]/.test(text)) problems.push(`${label}: contains a curly quote`);
  // Semicolons inside code spans are fine; prose ones are not.
  const prose = text.replace(/`[^`]*`/g, '');
  if (prose.includes(';')) problems.push(`${label}: contains a prose semicolon`);
  return problems;
}

/**
 * Which pricing paragraph a guild gets.
 *
 * Not the same question as which trial band it is in. A paying guild is
 * `active` whatever its size, and telling a customer their service is "free
 * until 2027" is both wrong and the kind of thing that prompts a refund
 * request.
 */
type Variant = Exclude<TrialPolicy, 'hard_gate'> | 'active';

function renderFor(sections: Sections, policy: Variant, expiresAt: Date | null): string {
  let pricing = sections.pricing[policy]!;
  if (pricing.includes('{{EXPIRY}}')) {
    if (!expiresAt) {
      throw new Error(`policy ${policy} needs {{EXPIRY}} but the guild has no trial end date`);
    }
    const when = expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    pricing = pricing.replaceAll('{{EXPIRY}}', when);
  }
  return sections.body.replace('{{PRICING}}', pricing);
}

interface Target {
  guildId: string;
  policy: Variant;
  expiresAt: Date | null;
  content: string;
}

type Outcome = 'system_channel' | 'owner_dm' | 'failed';

/**
 * Posts to the guild's system channel, falling back to the owner's DM.
 *
 * Mirrors `DiscordBillingNotifier.deliver` deliberately, including the detail
 * that a DM names the guild first: a DM has no surrounding server, so wording
 * like "your server" would otherwise have no antecedent.
 */
async function deliver(
  rest: REST,
  guildId: string,
  content: string,
): Promise<{ outcome: Outcome; error?: string }> {
  let guild: { name: string; system_channel_id: string | null; owner_id: string };
  try {
    guild = (await rest.get(Routes.guild(guildId))) as typeof guild;
  } catch (err) {
    return { outcome: 'failed', error: `cannot read guild: ${(err as Error).message}` };
  }

  /**
   * System channel or owner DM. There is no third option, and the obvious one
   * is a trap.
   *
   * ~38% of guilds have no usable system channel, and nearly all of them do
   * have some other text channel the bot could post in. **Do not post in it.**
   * Picking "the first channel we can write to" is precisely what spam bots do,
   * and servers defend against it with honeypot channels that auto-ban anything
   * posting there. The upside is a nicer delivery surface; the downside is
   * getting the bot banned from the servers it is trying to talk to. Owner's
   * call, 2026-08-19, and it is not a close one.
   */
  if (guild.system_channel_id) {
    try {
      await rest.post(Routes.channelMessages(guild.system_channel_id), { body: { content } });
      return { outcome: 'system_channel' };
    } catch {
      // Usually a missing Send Messages. Fall through to the DM, but the caller
      // still counts this separately so a fleet-wide permissions problem is
      // visible rather than looking like DM-by-design.
    }
  }

  try {
    const dm = (await rest.post(Routes.userChannels(), {
      body: { recipient_id: guild.owner_id },
    })) as { id: string };
    await rest.post(Routes.channelMessages(dm.id), {
      body: { content: `**${guild.name}**\n\n${content}` },
    });
    return { outcome: 'owner_dm' };
  } catch (err) {
    return {
      outcome: 'failed',
      error: `system channel and owner DM both failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Where a guild's message would actually land, resolved without sending.
 *
 * The dry run used to print the message and the guild id, which is not the same
 * as knowing who reads it. A test send to "my two servers" delivered one of them
 * to a DIFFERENT PERSON, because the fallback targets the guild OWNER and the
 * tester was only an admin there. Correct behaviour, surprising result, so the
 * target is now shown before anything goes out.
 */
async function resolveTarget(rest: REST, guildId: string): Promise<string> {
  let guild: { name: string; system_channel_id: string | null; owner_id: string };
  try {
    guild = (await rest.get(Routes.guild(guildId))) as typeof guild;
  } catch (err) {
    return `UNREADABLE (${(err as Error).message})`;
  }
  if (guild.system_channel_id) {
    try {
      const ch = (await rest.get(Routes.channel(guild.system_channel_id))) as { name: string };
      return `${guild.name} -> #${ch.name} (system channel)`;
    } catch {
      // No View Channel, so it falls through to the DM. Showing that is the
      // entire point of this function.
    }
  }
  let who = guild.owner_id;
  try {
    const user = (await rest.get(Routes.user(guild.owner_id))) as { username: string };
    who = `${user.username} (${guild.owner_id})`;
  } catch {
    /* the id alone is still useful */
  }
  return `${guild.name} -> DM to owner ${who}`;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(rawArgv: string[]): Promise<number> {
  // pnpm 9 forwards a bare `--` as a literal argument, which turns every
  // positional here into nonsense. Documented in AGENTS.md; filtered here.
  const argv = rawArgv.filter((a) => a !== '--');

  const apply = argv.includes('--apply');
  const file = arg(argv, 'file') ?? '/tmp/announcement.md';
  const onlyGuild = arg(argv, 'guild');
  const limit = Number(arg(argv, 'limit') ?? '0') || 0;
  /** Idempotency key. Change it only for a genuinely different announcement. */
  const key = arg(argv, 'key') ?? 'rewrite_2026_08';
  const resend = argv.includes('--resend');

  const sections = parseCopy(readFileSync(file, 'utf8'));

  const problems = [
    ...checkCopyRules('body', sections.body),
    ...Object.entries(sections.pricing).flatMap(([p, t]) => checkCopyRules(`pricing:${p}`, t)),
  ];
  // Length is checked per rendered variant, not on the body, because the
  // pricing paragraph is what pushes it over.
  for (const policy of ['dormant', 'year', 'short', 'active'] as const) {
    const sample = renderFor(sections, policy, new Date('2027-08-28T00:00:00Z'));
    if (sample.length > MAX_MESSAGE) {
      problems.push(
        `pricing:${policy}: rendered message is ${sample.length} chars, max ${MAX_MESSAGE}`,
      );
    }
  }
  if (problems.length) {
    console.error('The copy has problems and nothing was sent:\n');
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }

  const config = loadConfig();
  const handle = createDatabase({ connectionString: config.databaseUrl, max: 4 });
  // `guilds` is a SHARED table across fleets, so the walk below has to be
  // intersected with the guilds THIS fleet is actually in. Without that, a
  // second fleet's guilds would be messaged by a bot that is not in them.
  const guilds = new GuildRepository(handle.db);
  const presence = new GuildFleetPresenceRepository(handle.db, config.fleet);
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  try {
    const present = await presence.presentGuildIds();
    const targets: Target[] = [];
    const skipped = {
      notEntitled: 0,
      alreadySent: 0,
      noMemberCount: 0,
      otherFleet: 0,
      hardGate: [] as string[],
    };

    // Keyset pagination, the same walk the billing reconcile job uses. A
    // thousand rows would fit in memory, but the batch method already skips
    // rows that fail their zod parse instead of aborting the whole sweep, and
    // a broadcast is exactly where one corrupt row should not stop the rest.
    const all: Awaited<ReturnType<typeof guilds.listBatch>>['rows'] = [];
    let cursor: string | undefined;
    for (;;) {
      const { rows, lastGuildId } = await guilds.listBatch(cursor, 500);
      all.push(...rows);
      if (!lastGuildId || rows.length === 0) break;
      cursor = lastGuildId;
    }

    for (const g of all) {
      if (onlyGuild && g.guildId !== onlyGuild) continue;
      if (!present.has(g.guildId)) {
        skipped.otherFleet++;
        continue;
      }
      /**
       * Auth status decides the pricing paragraph before size does.
       *
       * `blocked` is off. `grace` and `expired` are mid-conversation about a
       * failed payment and the leniency ladder is already messaging them on its
       * own schedule, so a cheerful "free until 2027" would contradict it and a
       * payment nag would duplicate it. Leave both to the ladder.
       */
      if (g.authStatus === 'blocked' || g.authStatus === 'grace' || g.authStatus === 'expired') {
        skipped.notEntitled++;
        continue;
      }
      if (!resend && announcedAlready(g.metadata, key)) {
        skipped.alreadySent++;
        continue;
      }
      if (g.memberCount === null || g.memberCount === undefined) {
        skipped.noMemberCount++;
        continue;
      }
      // Paying beats size. An XXL guild that already subscribed is a customer,
      // not a bespoke arrangement waiting to happen, so it gets the `active`
      // paragraph like any other subscriber. Only an unsubscribed XXL is left
      // out, because a form letter about a free trial is wrong for one.
      const policy: Variant | 'hard_gate' =
        g.authStatus === 'active' ? 'active' : trialPolicyFor(g.memberCount);
      if (policy === 'hard_gate') {
        skipped.hardGate.push(g.guildId);
        continue;
      }
      targets.push({
        guildId: g.guildId,
        policy,
        expiresAt: g.authExpiresAt ?? null,
        content: renderFor(sections, policy, g.authExpiresAt ?? null),
      });
      if (limit && targets.length >= limit) break;
    }

    const byPolicy = targets.reduce<Record<string, number>>((acc, t) => {
      acc[t.policy] = (acc[t.policy] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`copy       ${file}`);
    console.log(`fleet      ${config.fleet}`);
    console.log(`key        ${key}`);
    console.log(`targets    ${targets.length}  ${JSON.stringify(byPolicy)}`);
    console.log(
      `skipped    ${skipped.alreadySent} already sent, ${skipped.otherFleet} not this fleet, ` +
        `${skipped.notEntitled} blocked, ${skipped.noMemberCount} no member count, ` +
        `${skipped.hardGate.length} XXL`,
    );
    if (skipped.hardGate.length) {
      console.log(`\nXXL guilds, handle these by hand:\n  ${skipped.hardGate.join('\n  ')}`);
    }

    if (!apply) {
      /**
       * One real sample per band, not just the first target.
       *
       * Printing only `targets[0]` hides every variant the first guild does not
       * happen to use. That is not hypothetical: a draft of this announcement
       * told large servers they were on a "shorter trial" while the importer
       * had actually given them the same year window as everyone else, and the
       * first target was a small server, so the dry run never showed the
       * sentence that was wrong.
       */
      for (const policy of ['dormant', 'year', 'short', 'active'] as const) {
        const sample = targets.find((t) => t.policy === policy);
        if (!sample) {
          console.log(`
--- no ${policy} guilds in this run ---`);
          continue;
        }
        console.log(
          `
--- ${policy}: what ${sample.guildId} would receive ` +
            `(${sample.content.length} chars) ---
`,
        );
        console.log(sample.content);
      }
      /**
       * Resolve real delivery targets. Capped, because it is a REST call per
       * guild and a full dry run over a thousand of them would be slow for no
       * extra insight. A single --guild run always resolves, since that is the
       * test path where the recipient matters most.
       */
      const toResolve = onlyGuild ? targets : targets.slice(0, 15);
      if (toResolve.length) {
        console.log(`\n--- where ${toResolve.length} of ${targets.length} would land ---`);
        for (const t of toResolve) {
          console.log(`  ${await resolveTarget(rest, t.guildId)}`);
        }
        if (targets.length > toResolve.length) {
          console.log(`  ... ${targets.length - toResolve.length} more not resolved`);
        }
      }
      console.log('\nDRY RUN, nothing sent. Re-run with --apply.');
      return 0;
    }

    const counts: Record<Outcome, number> = { system_channel: 0, owner_dm: 0, failed: 0 };
    const failures: string[] = [];
    let done = 0;

    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (;;) {
        const target = queue.shift();
        if (!target) return;
        const { outcome, error } = await deliver(rest, target.guildId, target.content);
        counts[outcome]++;
        if (outcome === 'failed') {
          failures.push(`${target.guildId}: ${error ?? 'unknown'}`);
        } else {
          // Stamped only on success, so a re-run retries exactly the guilds
          // that did not get it rather than skipping them forever.
          await guilds.markAnnounced(target.guildId, key).catch(() => {});
        }
        done++;
        if (done % 50 === 0) console.log(`  ${done}/${targets.length}`);
        await new Promise((r) => setTimeout(r, outcome === 'owner_dm' ? DM_PAUSE_MS : PAUSE_MS));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(
      `\nsent ${counts.system_channel} to system channels, ${counts.owner_dm} to owner DMs, ` +
        `${counts.failed} failed`,
    );
    if (failures.length) {
      console.log('\nfailures (re-running will retry exactly these):');
      for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
      if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
    }
    return counts.failed > 0 ? 1 : 0;
  } finally {
    await handle.close().catch(() => {});
  }
}

function announcedAlready(metadata: unknown, key: string): boolean {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const announcements = meta.announcements;
  if (!announcements || typeof announcements !== 'object') return false;
  return Boolean((announcements as Record<string, unknown>)[key]);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('ops/announce.js');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
