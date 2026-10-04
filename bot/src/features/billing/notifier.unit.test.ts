import { describe, expect, it } from 'vitest';
import type { Client, Guild } from 'discord.js';
import { fakeLogger } from '../../runtime/testUtils.js';
import { DiscordBillingNotifier } from './notifier.js';

const GUILD = '462606582367125509';
const SYSTEM_CHANNEL = '111111111111111111';
const CREATOR_A = '222222222222222222';
const CREATOR_B = '333333333333333333';
const OWNER = '444444444444444444';
const CONTACT = '555555555555555555';

interface Sent {
  where: string;
  content: string;
  /** What the send asked Discord to resolve. `undefined` = the default, which pings. */
  allowedMentions: unknown;
}

/**
 * A fake Discord surface stubbing only what the notifier touches. There is no
 * shared fake Client in this repo — each test file builds the shape it needs —
 * so this follows `permissionProblemNotifier.unit.test.ts`.
 */
function harness(
  over: {
    systemChannelId?: string | null;
    ownerId?: string | null;
    /** Channel ids whose `send` throws, as a permissions refusal would. */
    refuse?: string[];
    /** Channel ids that cannot be fetched at all, as a deleted one would. */
    missing?: string[];
    /** Channel ids that resolve to something with no text chat at all. */
    notTextBased?: string[];
    /** User ids whose DM throws. `true` fails every DM. */
    failDm?: string[] | true;
    contact?: string | null;
    contactIsMember?: boolean;
    /** The settings read itself throws, as a database outage would. */
    settingsThrow?: boolean;
    creators?: string[];
    /** Listing creator channels throws, as a database outage would. */
    creatorsThrow?: boolean;
    /** Omit the two optional seams, as a bare construction does. */
    bare?: boolean;
  } = {},
) {
  const sent: Sent[] = [];
  const refuse = new Set(over.refuse ?? []);
  const missing = new Set(over.missing ?? []);
  const notTextBased = new Set(over.notTextBased ?? []);
  const dmFailures = over.failDm === true ? null : new Set(over.failDm ?? []);
  const failsDm = (id: string): boolean => (dmFailures === null ? true : dmFailures.has(id));
  /** Every id `members.fetch` was asked about, so the contact check can be pinned. */
  const memberLookups: string[] = [];
  const systemChannelId =
    over.systemChannelId === undefined ? SYSTEM_CHANNEL : over.systemChannelId;

  const guild = {
    id: GUILD,
    name: 'Test Server',
    ownerId: over.ownerId === undefined ? OWNER : over.ownerId,
    systemChannelId,
    channels: {
      fetch: async (id: string) => {
        if (missing.has(id)) throw new Error('Unknown Channel');
        if (notTextBased.has(id)) return { isTextBased: () => false };
        return {
          isTextBased: () => true,
          send: async ({
            content,
            allowedMentions,
          }: {
            content: string;
            allowedMentions?: unknown;
          }) => {
            if (refuse.has(id)) throw new Error('Missing Permissions');
            sent.push({ where: id, content, allowedMentions });
          },
        };
      },
    },
    members: {
      fetch: async ({ user }: { user: string }) => {
        memberLookups.push(user);
        if (!over.contactIsMember) throw new Error('Unknown Member');
        return { id: user };
      },
    },
  } as unknown as Guild;

  const client = {
    guilds: { fetch: async () => guild },
    users: {
      fetch: async (id: string) => ({
        send: async ({
          content,
          allowedMentions,
        }: {
          content: string;
          allowedMentions?: unknown;
        }) => {
          if (failsDm(id)) throw new Error('Cannot send messages to this user');
          sent.push({ where: `dm:${id}`, content, allowedMentions });
        },
      }),
    },
  } as unknown as Client;

  const notifier = new DiscordBillingNotifier({
    client,
    logger: fakeLogger(),
    ...(over.bare
      ? {}
      : {
          guilds: {
            ensure: async () => {
              if (over.settingsThrow) throw new Error('database unavailable');
              return { settings: over.contact ? { contact_user_id: over.contact } : {} };
            },
          } as never,
          creatorChannels: {
            listByGuild: async () => {
              if (over.creatorsThrow) throw new Error('database unavailable');
              return (over.creators ?? []).map((channelId) => ({ channelId }));
            },
          },
        }),
  });
  return { notifier, sent, memberLookups };
}

/** A real billing notice, so the public rung's copy is the one under test. */
async function notify(notifier: DiscordBillingNotifier): Promise<boolean> {
  return notifier.notifyGuild(GUILD, { key: 'grace_nudge', kind: 'grace_nudge', daysLeft: 9 }, 500);
}

describe('DiscordBillingNotifier delivery ladder', () => {
  it('posts in the system channel and stops there', async () => {
    const { notifier, sent } = harness({ contact: CONTACT, creators: [CREATOR_A] });
    expect(await notify(notifier)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.where).toBe(SYSTEM_CHANNEL);
  });

  it('never lets a notice resolve a mention, on any rung', async () => {
    const { notifier, sent } = harness({ creators: [CREATOR_A] });
    await notify(notifier);
    const dm = harness({ refuse: [SYSTEM_CHANNEL], creators: [] });
    await notify(dm.notifier);
    const publicRung = harness({ refuse: [SYSTEM_CHANNEL], failDm: true, creators: [CREATOR_A] });
    await notify(publicRung.notifier);
    for (const message of [...sent, ...dm.sent, ...publicRung.sent]) {
      expect(message.allowedMentions).toEqual({ parse: [] });
    }
    expect([...sent, ...dm.sent, ...publicRung.sent]).toHaveLength(3);
  });

  it('DMs the recorded contact first when the system channel refuses', async () => {
    const { notifier, sent, memberLookups } = harness({
      refuse: [SYSTEM_CHANNEL],
      contact: CONTACT,
      contactIsMember: true,
      creators: [CREATOR_A],
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.where).toBe(`dm:${CONTACT}`);
    // The membership check has to be about the CONTACT, or preferring them is
    // just a second way to fail.
    expect(memberLookups).toEqual([CONTACT]);
    // The guild is named, because a DM has no surrounding server.
    expect(sent[0]?.content.startsWith('**Test Server**')).toBe(true);
  });

  it('falls back to the owner when the contact has left the server', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      contact: CONTACT,
      contactIsMember: false,
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent[0]?.where).toBe(`dm:${OWNER}`);
  });

  /**
   * The regression an adversarial review caught: preferring the contact by
   * REPLACING the owner meant a guild whose contact has DMs closed lost a
   * private route that worked, and went straight to a public channel.
   */
  it('still tries the owner when the contact refuses the DM', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      contact: CONTACT,
      contactIsMember: true,
      failDm: [CONTACT],
      creators: [CREATOR_A],
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.where).toBe(`dm:${OWNER}`);
  });

  it('queues the notice rather than guessing when the settings read fails', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      settingsThrow: true,
      creators: [CREATOR_A],
    });
    // False, so the caller leaves the dedupe key unstamped and retries: a
    // database blip must not permanently send this guild's notice to the
    // wrong person, or broadcast it publicly.
    expect(await notify(notifier)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('reaches a creator channel when both private routes are gone', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      failDm: true,
      contact: CONTACT,
      contactIsMember: true,
      creators: [CREATOR_A],
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.where).toBe(CREATOR_A);
  });

  /**
   * The public rung must not broadcast what the private ones say. Several
   * kinds tell an admin their payment failed or how many unpaid days are
   * left, and a creator channel's text chat is read by the whole server.
   */
  it('posts the public form in a creator channel, never the notice itself', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      failDm: true,
      creators: [CREATOR_A],
    });
    await notify(notifier);
    const posted = sent[0]?.content ?? '';
    expect(posted).toContain("AVC needs an admin's attention");
    // None of the private notice's specifics.
    expect(posted).not.toContain('grace');
    expect(posted).not.toContain('day');
    expect(posted).not.toContain('$');
  });

  it('tries the next creator channel when one sits in a category that refuses', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL, CREATOR_A],
      failDm: true,
      creators: [CREATOR_A, CREATOR_B],
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent[0]?.where).toBe(CREATOR_B);
  });

  it('skips a creator channel with no text chat rather than counting it as sent', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      failDm: true,
      notTextBased: [CREATOR_A],
      creators: [CREATOR_A, CREATOR_B],
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.where).toBe(CREATOR_B);
  });

  /**
   * The state both unreachable servers were in on 2026-09-21: no system
   * channel we may post in, a DM Discord refuses, and no creator channel
   * because they never configured one. Failing must stay `false`, because the
   * caller leaves the dedupe key unstamped and retries on that.
   */
  it('reports failure when every rung refuses', async () => {
    const { notifier, sent } = harness({ refuse: [SYSTEM_CHANNEL], failDm: true, creators: [] });
    expect(await notify(notifier)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('does not treat a failed creator-channel listing as a guild with none', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      failDm: true,
      creatorsThrow: true,
    });
    expect(await notify(notifier)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('skips a deleted system channel without counting it as a delivery', async () => {
    const { notifier, sent } = harness({ missing: [SYSTEM_CHANNEL], creators: [] });
    expect(await notify(notifier)).toBe(true);
    expect(sent[0]?.where).toBe(`dm:${OWNER}`);
  });

  it('keeps the owner-only ladder when neither seam is wired', async () => {
    const { notifier, sent } = harness({ refuse: [SYSTEM_CHANNEL], bare: true });
    expect(await notify(notifier)).toBe(true);
    expect(sent[0]?.where).toBe(`dm:${OWNER}`);
  });

  it('goes public when a guild somehow has no owner to DM', async () => {
    const { notifier, sent } = harness({
      refuse: [SYSTEM_CHANNEL],
      ownerId: null,
      creators: [CREATOR_A],
    });
    expect(await notify(notifier)).toBe(true);
    expect(sent[0]?.where).toBe(CREATOR_A);
  });

  it('stops after three creator channels rather than walking a whole server', async () => {
    const creators = ['1', '2', '3', '4', '5'];
    const { notifier, sent } = harness({
      // The fourth would accept the message. Reaching it is the failure.
      refuse: [SYSTEM_CHANNEL, '1', '2', '3'],
      failDm: true,
      creators,
    });
    expect(await notify(notifier)).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
