import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, users } from '../db/schema.js';
import { startPostgres, type PgTestEnv } from '../test/pgContainer.js';
import { MemberPoolRepository } from './memberPools.js';
import { SubscriptionRepository } from './subscriptions.js';

/**
 * `listSupporterTiersFor` crosses three tables and the join it makes is the one
 * this codebase gets wrong most often: `subscriptions.purchaser_user_id` is an
 * Auth.js `users.id`, and the answer has to come out as a Discord snowflake
 * from `accounts.provider_account_id`. Comparing the wrong pair silently
 * returns nothing, which looks exactly like nobody paying.
 */
describe('SubscriptionRepository.listSupporterTiersFor (integration)', () => {
  let env: PgTestEnv;
  let subs: SubscriptionRepository;
  let pools: MemberPoolRepository;
  let seq = 0;

  /** An Auth.js user with a linked Discord account. Returns both ids. */
  async function makeUser(discordId: string): Promise<string> {
    const userId = `user-${discordId}`;
    await env.handle.db.insert(users).values({ id: userId, name: discordId });
    await env.handle.db.insert(accounts).values({
      userId,
      type: 'oauth',
      provider: 'discord',
      providerAccountId: discordId,
    });
    return userId;
  }

  async function guildSub(opts: {
    purchaserUserId: string;
    tier: string;
    status?: string;
  }): Promise<string> {
    const paddleId = `sub-${(seq += 1)}`;
    await subs.upsert({
      guildId: `g-${seq}`,
      paddleSubscriptionId: paddleId,
      paddleCustomerId: `cus-${seq}`,
      purchaserUserId: opts.purchaserUserId,
      tier: opts.tier,
      status: opts.status ?? 'active',
    });
    return paddleId;
  }

  beforeAll(async () => {
    env = await startPostgres();
    subs = new SubscriptionRepository(env.handle.db);
    pools = new MemberPoolRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  it('resolves an active subscription to its purchaser snowflake', async () => {
    const userId = await makeUser('100000000000000001');
    await guildSub({ purchaserUserId: userId, tier: 'm' });

    const map = await subs.listSupporterTiersFor(['100000000000000001']);
    expect(map.get('100000000000000001')).toBe('m');
  });

  it('answers only for the ids it was asked about', async () => {
    const userId = await makeUser('100000000000000002');
    await guildSub({ purchaserUserId: userId, tier: 'l' });

    const map = await subs.listSupporterTiersFor(['999999999999999999']);
    expect(map.size).toBe(0);
  });

  /** The bound that keeps this proportional to one guild, not to the customer base. */
  it('returns an empty map for an empty id list without querying for everyone', async () => {
    const map = await subs.listSupporterTiersFor([]);
    expect(map.size).toBe(0);
  });

  it('takes the highest tier when someone holds several subscriptions', async () => {
    const userId = await makeUser('100000000000000003');
    await guildSub({ purchaserUserId: userId, tier: 's' });
    await guildSub({ purchaserUserId: userId, tier: 'xl' });
    await guildSub({ purchaserUserId: userId, tier: 'm' });

    const map = await subs.listSupporterTiersFor(['100000000000000003']);
    expect(map.get('100000000000000003')).toBe('xl');
  });

  it('covers pool subscriptions, which are how nearly everyone buys', async () => {
    const userId = await makeUser('100000000000000004');
    const pool = await pools.create({
      id: 'pool-supporter-1',
      ownerUserId: userId,
      name: 'Subscription 1',
      billedTier: 'l',
    });
    await subs.upsertForPool({
      poolId: pool.id,
      paddleSubscriptionId: 'sub-pool-1',
      paddleCustomerId: 'cus-pool-1',
      purchaserUserId: userId,
      tier: 'l',
      status: 'active',
    });

    const map = await subs.listSupporterTiersFor(['100000000000000004']);
    expect(map.get('100000000000000004')).toBe('l');
  });

  /**
   * Dunning keeps the badge, and this is the one place the recognition rule
   * deliberately differs from the entitlement rule. The ladder keeps a
   * `past_due` customer's servers running for 60 more days, so a role
   * disappearing from a public member list on day one would be a bad way to
   * learn a card expired.
   */
  it('keeps the badge while a payment is being retried', async () => {
    const userId = await makeUser('100000000000000005');
    await guildSub({ purchaserUserId: userId, tier: 'm', status: 'past_due' });

    const map = await subs.listSupporterTiersFor(['100000000000000005']);
    expect(map.get('100000000000000005')).toBe('m');
  });

  it('excludes a cancelled subscription', async () => {
    const userId = await makeUser('100000000000000011');
    await guildSub({ purchaserUserId: userId, tier: 'm', status: 'canceled' });

    const map = await subs.listSupporterTiersFor(['100000000000000011']);
    expect(map.has('100000000000000011')).toBe(false);
  });

  /** Leniency is for a failed charge, not for money already given back. */
  it('excludes a refunded subscription even while it is in dunning', async () => {
    const userId = await makeUser('100000000000000012');
    const paddleId = await guildSub({
      purchaserUserId: userId,
      tier: 'l',
      status: 'past_due',
    });
    await subs.recordRefund(paddleId, { status: 'approved', total: '39900' });

    const map = await subs.listSupporterTiersFor(['100000000000000012']);
    expect(map.has('100000000000000012')).toBe(false);
  });

  /**
   * A refund does not cancel a Paddle subscription, so status alone would keep
   * badging someone whose money has been given back.
   */
  it('excludes a refunded subscription that Paddle still reports as active', async () => {
    const userId = await makeUser('100000000000000006');
    const paddleId = await guildSub({ purchaserUserId: userId, tier: 'xl' });
    await subs.recordRefund(paddleId, { status: 'approved', total: '1999' });

    const map = await subs.listSupporterTiersFor(['100000000000000006']);
    expect(map.has('100000000000000006')).toBe(false);
  });

  it('keeps the badge while a refund is only requested', async () => {
    const userId = await makeUser('100000000000000007');
    const paddleId = await guildSub({ purchaserUserId: userId, tier: 'xl' });
    await subs.recordRefund(paddleId, { status: 'pending_approval', total: '1999' });

    const map = await subs.listSupporterTiersFor(['100000000000000007']);
    expect(map.get('100000000000000007')).toBe('xl');
  });

  /** Subscriptions predating the purchaser column are unreachable, not crashes. */
  it('ignores a subscription with no purchaser recorded', async () => {
    await subs.upsert({
      guildId: 'g-orphan',
      paddleSubscriptionId: 'sub-orphan',
      paddleCustomerId: 'cus-orphan',
      tier: 'm',
      status: 'active',
    });
    const map = await subs.listSupporterTiersFor(['100000000000000008']);
    expect(map.size).toBe(0);
  });

  /** A non-Discord provider row must never resolve a snowflake. */
  it('only matches the discord provider', async () => {
    const userId = 'user-other-provider';
    await env.handle.db.insert(users).values({ id: userId, name: 'other' });
    await env.handle.db.insert(accounts).values({
      userId,
      type: 'oauth',
      provider: 'github',
      providerAccountId: '100000000000000009',
    });
    await guildSub({ purchaserUserId: userId, tier: 'm' });

    const map = await subs.listSupporterTiersFor(['100000000000000009']);
    expect(map.size).toBe(0);
  });

  /** Chunking must not drop or duplicate anyone across the boundary. */
  it('handles an id list larger than one chunk', async () => {
    const userId = await makeUser('100000000000000010');
    await guildSub({ purchaserUserId: userId, tier: 's' });
    const filler = Array.from({ length: 4_500 }, (_, i) => `2${String(i).padStart(17, '0')}`);

    const map = await subs.listSupporterTiersFor([...filler, '100000000000000010']);
    expect(map.get('100000000000000010')).toBe('s');
    expect(map.size).toBe(1);
  });
});
