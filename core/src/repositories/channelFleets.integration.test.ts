import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutoChannelRepository } from './autoChannels.js';
import { SecondaryChannelRepository } from './secondaryChannels.js';
import { ManagedChannelRepository } from './managedChannels.js';
import { JoinChannelRepository } from './joinChannels.js';
import type { PgTestEnv } from '../test/pgContainer.js';
import { startPostgres } from '../test/pgContainer.js';
import { autoChannels, joinChannels, managedChannels, secondaryChannels } from '../db/schema.js';

/**
 * Channel-table isolation between fleets (`plans/fleets.md` §2).
 *
 * This is the failure the fleet column exists to prevent, and it is the worst
 * one available: two bots in one guild, each reconciling from the same rows,
 * renaming and deleting channels the other created. Every assertion here is a
 * thing that silently worked before the column and must now be impossible.
 *
 * Note what is NOT asserted: that a channel id can exist twice. It cannot — the
 * primary key is still the channel id alone, because a Discord channel belongs
 * to exactly one bot's management. The isolation is about *visibility*, not
 * about duplicate rows.
 */
describe('channel repositories: fleet isolation (integration)', () => {
  let env: PgTestEnv;
  let prodAuto: AutoChannelRepository;
  let betaAuto: AutoChannelRepository;
  let prodSecondaries: SecondaryChannelRepository;
  let betaSecondaries: SecondaryChannelRepository;

  beforeAll(async () => {
    env = await startPostgres();
    prodAuto = new AutoChannelRepository(env.handle.db, 'prod');
    betaAuto = new AutoChannelRepository(env.handle.db, 'beta');
    prodSecondaries = new SecondaryChannelRepository(env.handle.db, 'prod');
    betaSecondaries = new SecondaryChannelRepository(env.handle.db, 'beta');
  });

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await env.handle.db.delete(joinChannels);
    await env.handle.db.delete(secondaryChannels);
    await env.handle.db.delete(managedChannels);
    await env.handle.db.delete(autoChannels);
  });

  const GUILD = 'guild-shared';

  it('does not leak a creator channel to the other fleet', async () => {
    await prodAuto.upsert(GUILD, 'chan-prod', { name: 'prod template' });

    expect(await betaAuto.get('chan-prod')).toBeUndefined();
    expect(await betaAuto.isPrimary(GUILD, 'chan-prod')).toBe(false);
    expect(await betaAuto.listByGuild(GUILD)).toEqual([]);
    expect(await betaAuto.countByGuild(GUILD)).toBe(0);
    // The sweep walks these ids; seeing the other fleet's guilds would make it
    // reconcile servers it is not even in.
    expect(await betaAuto.listGuildIds()).toEqual([]);
    expect(await prodAuto.listGuildIds()).toEqual([GUILD]);
  });

  it("cannot delete the other fleet's creator channel", async () => {
    await prodAuto.upsert(GUILD, 'chan-prod');

    await betaAuto.remove(GUILD, 'chan-prod');

    expect(await prodAuto.get('chan-prod')).toBeDefined();
  });

  /**
   * The one path that could still corrupt across fleets: the conflict target is
   * the channel id, so an upsert of a channel the other fleet owns finds its
   * row. It must refuse rather than rewrite the template.
   */
  it("refuses to upsert over the other fleet's creator channel", async () => {
    await prodAuto.upsert(GUILD, 'chan-prod', { name: 'prod template' });

    await expect(betaAuto.upsert(GUILD, 'chan-prod', { name: 'beta template' })).rejects.toThrow(
      /another fleet/,
    );
    expect((await prodAuto.get('chan-prod'))?.template.name).toBe('prod template');
  });

  it('does not leak a secondary to the other fleet, by any route', async () => {
    await prodSecondaries.create({
      channelId: 'sec-prod',
      guildId: GUILD,
      primaryChannelId: 'chan-prod',
      ownerId: 'user-1',
    });

    expect(await betaSecondaries.get('sec-prod')).toBeUndefined();
    expect(await betaSecondaries.isSecondary(GUILD, 'sec-prod')).toBe(false);
    expect(await betaSecondaries.listByGuild(GUILD)).toEqual([]);
    expect(await betaSecondaries.listByPrimary('chan-prod')).toEqual([]);
    expect(await betaSecondaries.listByOwner(GUILD, 'user-1')).toEqual([]);
    expect(await betaSecondaries.countByPrimary('chan-prod')).toBe(0);
    expect(await betaSecondaries.listGuildIds()).toEqual([]);
  });

  /**
   * The headline disaster: reconcile finds a room it believes is an orphan and
   * deletes it, except the room belongs to the other fleet and has people in it.
   */
  it("cannot remove or mutate the other fleet's secondary", async () => {
    await prodSecondaries.create({
      channelId: 'sec-prod',
      guildId: GUILD,
      primaryChannelId: 'chan-prod',
      ownerId: 'user-1',
    });

    await betaSecondaries.remove('sec-prod');
    await betaSecondaries.setOwner('sec-prod', 'user-hijack');
    await betaSecondaries.updateState('sec-prod', { name: 'hijacked' });

    const row = await prodSecondaries.get('sec-prod');
    expect(row).toBeDefined();
    expect(row?.ownerId).toBe('user-1');
    expect(row?.state.name).toBeUndefined();
  });

  it('keeps managed and join channels apart too', async () => {
    const prodManaged = new ManagedChannelRepository(env.handle.db, 'prod');
    const betaManaged = new ManagedChannelRepository(env.handle.db, 'beta');
    const prodJoin = new JoinChannelRepository(env.handle.db, 'prod');
    const betaJoin = new JoinChannelRepository(env.handle.db, 'beta');

    await prodManaged.create({ channelId: 'man-prod', guildId: GUILD });
    await prodSecondaries.create({
      channelId: 'sec-prod',
      guildId: GUILD,
      primaryChannelId: 'chan-prod',
    });
    await prodJoin.create({
      channelId: 'join-prod',
      guildId: GUILD,
      secondaryChannelId: 'sec-prod',
      creatorId: 'user-1',
    });

    expect(await betaManaged.get('man-prod')).toBeUndefined();
    expect(await betaManaged.isManaged(GUILD, 'man-prod')).toBe(false);
    expect(await betaManaged.listGuildIds()).toEqual([]);
    expect(await betaJoin.get('join-prod')).toBeUndefined();
    expect(await betaJoin.getBySecondary('sec-prod')).toBeUndefined();

    // And a removal aimed at the other fleet's companion is a no-op.
    await betaJoin.removeBySecondary('sec-prod');
    expect(await prodJoin.getBySecondary('sec-prod')).toBeDefined();
  });

  /**
   * The same conflict `autoChannels.upsert` guards above, on the adopt path
   * instead of the create-a-primary path: `create`'s conflict target is the
   * channel id, so adopting a channel the other fleet already manages finds
   * its row. It must say so, not throw a message that reads like the row
   * disappeared mid-write.
   */
  it("refuses to adopt the other fleet's managed channel", async () => {
    const prodManaged = new ManagedChannelRepository(env.handle.db, 'prod');
    const betaManaged = new ManagedChannelRepository(env.handle.db, 'beta');
    await prodManaged.create({ channelId: 'man-prod', guildId: GUILD });

    await expect(betaManaged.create({ channelId: 'man-prod', guildId: GUILD })).rejects.toThrow(
      /another fleet/,
    );
  });

  /**
   * The same shape one axis over: SAME fleet, DIFFERENT guild.
   *
   * Fleet was bound from the start and guild was not, because every writer
   * reached these tables through a service layer that checked
   * `row.guildId === guildId` first. `/import` writes channel ids straight from
   * a file an admin uploads, so the guild is bound in the repository now and
   * these are the cases that prove it. Without them the only thing standing
   * between an uploaded snowflake and another server's creator channel is a
   * caller remembering to check.
   */
  describe('across guilds within one fleet', () => {
    const OTHER = 'guild-other';

    it("refuses to upsert over another guild's creator channel", async () => {
      await prodAuto.upsert(GUILD, 'chan-a', { name: 'theirs' });

      await expect(prodAuto.upsert(OTHER, 'chan-a', { name: 'mine' })).rejects.toThrow(
        /another guild/,
      );
      const row = await prodAuto.get('chan-a');
      expect(row?.guildId).toBe(GUILD);
      expect(row?.template.name).toBe('theirs');
    });

    it("cannot delete another guild's creator channel", async () => {
      await prodAuto.upsert(GUILD, 'chan-a');

      await prodAuto.remove(OTHER, 'chan-a');

      expect(await prodAuto.get('chan-a')).toBeDefined();
    });

    it("refuses to adopt another guild's managed channel", async () => {
      const managed = new ManagedChannelRepository(env.handle.db, 'prod');
      await managed.create({ channelId: 'man-a', guildId: GUILD, template: { name: 'theirs' } });

      await expect(managed.create({ channelId: 'man-a', guildId: OTHER })).rejects.toThrow(
        /another guild/,
      );
      expect((await managed.get('man-a'))?.template.name).toBe('theirs');
    });

    it("cannot mutate or remove another guild's managed channel", async () => {
      const managed = new ManagedChannelRepository(env.handle.db, 'prod');
      await managed.create({
        channelId: 'man-a',
        guildId: GUILD,
        ownerId: 'user-1',
        template: { name: 'theirs' },
        state: { seed: 7, roster: ['user-1'] },
      });

      await managed.setTemplate(OTHER, 'man-a', { name: 'hijacked' });
      await managed.updateState(OTHER, 'man-a', { seed: 99 });
      await managed.setOwner(OTHER, 'man-a', 'user-hijack');
      await managed.remove(OTHER, 'man-a');

      const row = await managed.get('man-a');
      expect(row).toBeDefined();
      expect(row?.template.name).toBe('theirs');
      expect(row?.state.seed).toBe(7);
      expect(row?.state.roster).toEqual(['user-1']);
      expect(row?.ownerId).toBe('user-1');
    });
  });
});
