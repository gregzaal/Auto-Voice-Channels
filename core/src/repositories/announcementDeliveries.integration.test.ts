import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { AnnouncementDeliveryRepository } from './announcementDeliveries.js';

const KEY = 'rewrite_2026_08';
const TOUCH = 'announcement';

describe('AnnouncementDeliveryRepository (integration)', () => {
  let env: PgTestEnv;
  let deliveries: AnnouncementDeliveryRepository;

  beforeAll(async () => {
    env = await startPostgres();
    deliveries = new AnnouncementDeliveryRepository(env.handle.db);
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(schema.announcementDeliveries);
  });

  it('is empty for a batch with no rows yet', async () => {
    expect(await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1', 'g-2'])).toEqual(new Set());
    expect(await deliveries.optedOut(KEY, ['g-1', 'g-2'])).toEqual(new Set());
  });

  it('records a delivery and reports it back in alreadyDelivered', async () => {
    await deliveries.recordDelivered('g-1', KEY, TOUCH, 'system_channel');
    const delivered = await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1', 'g-2']);
    expect(delivered).toEqual(new Set(['g-1']));
  });

  /**
   * The unique index on (guildId, key, touch) is what stops a redeploy
   * mid-broadcast re-sending a touch that already landed - a retried send
   * must update the same row, not insert a duplicate.
   */
  it('a retry after a failure updates the same row rather than duplicating it', async () => {
    await deliveries.recordFailed('g-1', KEY, TOUCH, 'missing Send Messages');
    let delivered = await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1']);
    expect(delivered).toEqual(new Set()); // a failure is not a delivery

    await deliveries.recordDelivered('g-1', KEY, TOUCH, 'owner_dm');
    delivered = await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1']);
    expect(delivered).toEqual(new Set(['g-1']));

    const rows = await env.handle.db.select().from(schema.announcementDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe('owner_dm');
    expect(rows[0]?.lastError).toBeNull();
  });

  /**
   * `--resend` exists to re-target an already-delivered guild. If that
   * second attempt fails, the row must stop reporting as delivered - a
   * stale `deliveredAt` from the first success would otherwise convince
   * `alreadyDelivered` that a touch landed when the most recent real
   * attempt actually failed.
   */
  it('a failure on resend clears a prior success, not just the target/error', async () => {
    await deliveries.recordDelivered('g-1', KEY, TOUCH, 'system_channel');
    expect(await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1'])).toEqual(new Set(['g-1']));

    await deliveries.recordFailed('g-1', KEY, TOUCH, 'Missing Access on resend');
    expect(await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1'])).toEqual(new Set());

    const rows = await env.handle.db.select().from(schema.announcementDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliveredAt).toBeNull();
    expect(rows[0]?.target).toBe('failed');
  });

  it('scopes delivery tracking to one (key, touch) - a different touch is not "already sent"', async () => {
    await deliveries.recordDelivered('g-1', KEY, 'heads_up', 'system_channel');
    expect(await deliveries.alreadyDelivered(KEY, 'heads_up', ['g-1'])).toEqual(new Set(['g-1']));
    expect(await deliveries.alreadyDelivered(KEY, TOUCH, ['g-1'])).toEqual(new Set());
  });

  it('opted-out guilds are reported across every touch of the same key', async () => {
    await env.handle.db.insert(schema.announcementDeliveries).values({
      guildId: 'g-1',
      key: KEY,
      touch: 'heads_up',
      optedOut: true,
    });
    // A later touch of the SAME key checks opted-out status, even though
    // this specific touch never recorded the opt-out itself.
    expect(await deliveries.optedOut(KEY, ['g-1', 'g-2'])).toEqual(new Set(['g-1']));
    expect(await deliveries.optedOut('a_different_key', ['g-1'])).toEqual(new Set());
  });
});
