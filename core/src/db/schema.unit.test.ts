import { describe, expect, it } from 'vitest';
import { AUTH_STATUSES } from '../domain/auth.js';
import { FLEETS } from '../domain/fleets.js';
import { MEMBER_PREF_PRIVACIES } from '../domain/memberRoomPrefs.js';
import { MEMBER_ACCESS_KINDS } from '../domain/roomAccess.js';
import {
  guilds,
  guildAuthEvents,
  guildFleetPresence,
  identifyBuckets,
  memberAccessLists,
  memberRoomPrefs,
  opsAudit,
  runtimeFlags,
  secondaryChannels,
  shardLeases,
} from './schema.js';

/**
 * The schema inlines the auth-status literal (drizzle-kit's bundler can't follow
 * cross-file `.js` imports). This guards against the two definitions drifting.
 */
describe('schema auth-status enum', () => {
  it('guilds.authStatus matches domain AUTH_STATUSES', () => {
    expect([...guilds.authStatus.enumValues]).toEqual([...AUTH_STATUSES]);
  });

  it('guild_auth_events to/from status match domain AUTH_STATUSES', () => {
    expect([...guildAuthEvents.toStatus.enumValues]).toEqual([...AUTH_STATUSES]);
    expect([...guildAuthEvents.fromStatus.enumValues]).toEqual([...AUTH_STATUSES]);
  });
});

/**
 * Same drift guard as above, for the fleet literal. Getting these out of sync
 * would let config accept a fleet the database rejects, or worse, write a fleet
 * value no query filters on.
 */
describe('schema fleet enum', () => {
  it('every fleet-scoped column matches domain FLEETS', () => {
    for (const column of [
      shardLeases.fleet,
      identifyBuckets.fleet,
      runtimeFlags.fleet,
      guildFleetPresence.fleet,
      opsAudit.fleet,
    ]) {
      expect([...column.enumValues]).toEqual([...FLEETS]);
    }
  });

  /**
   * The default is what makes the migration additive: every row written before
   * fleets existed, and every row a self-host will ever write, is production.
   */
  it('defaults fleet-scoped columns to prod', () => {
    expect(shardLeases.fleet.default).toBe('prod');
    expect(runtimeFlags.fleet.default).toBe('prod');
    expect(guildFleetPresence.fleet.default).toBe('prod');
  });

  /**
   * ops_audit is the one exception: an action taken from the web console
   * originates outside any fleet, and stamping it 'prod' would be a lie.
   */
  it('leaves ops_audit.fleet nullable', () => {
    expect(opsAudit.fleet.notNull).toBe(false);
  });
});

/**
 * Saved trusted and blocked lists, and the column that records a room's access.
 * Both are expand-only additions an older build never reads or writes.
 */
describe('schema room access', () => {
  /** Same drift guard as the auth and fleet literals: the schema inlines the kinds. */
  it('member_access_lists.kind matches domain MEMBER_ACCESS_KINDS', () => {
    expect([...memberAccessLists.kind.enumValues]).toEqual([...MEMBER_ACCESS_KINDS]);
  });

  /**
   * Customer data shared by every fleet, like `aliases`: a per-fleet copy would
   * let a block hold on one bot and not on the other serving the same guild. The
   * decision is recorded in the doc comment on `memberAccessLists` in the schema.
   */
  it('keeps member_access_lists shared across fleets', () => {
    expect('fleet' in memberAccessLists).toBe(false);
  });

  /**
   * Null and no default is what makes the column additive: every room an older
   * build made has none, and an older build's insert never names it.
   */
  it('adds secondary_channels.access as nullable with no default', () => {
    expect(secondaryChannels.access.notNull).toBe(false);
    expect(secondaryChannels.access.hasDefault).toBe(false);
  });
});

/**
 * What members have remembered about their own rooms. An expand-only table an older build
 * never reads or writes.
 */
describe('schema remembered room settings', () => {
  /** Same drift guard as the access kinds: the schema inlines the privacy values. */
  it('member_room_prefs.privacy matches domain MEMBER_PREF_PRIVACIES', () => {
    expect([...memberRoomPrefs.privacy.enumValues]).toEqual([...MEMBER_PREF_PRIVACIES]);
  });

  /**
   * Keyed by a creator channel, which belongs to one fleet already, so a copy of the fleet
   * here could only disagree with it. The decision is recorded in the doc comment on
   * `memberRoomPrefs` in the schema.
   */
  it('keeps member_room_prefs shared across fleets', () => {
    expect('fleet' in memberRoomPrefs).toBe(false);
  });

  /**
   * Null on every setting is what "nothing remembered" means, and what lets one save write
   * one column without naming the others. A default on any of them would remember a value
   * nobody chose.
   */
  it('stores each remembered setting as nullable with no default', () => {
    for (const column of [
      memberRoomPrefs.nameTemplate,
      memberRoomPrefs.userLimit,
      memberRoomPrefs.privacy,
    ]) {
      expect(column.notNull).toBe(false);
      expect(column.hasDefault).toBe(false);
    }
  });

  /**
   * Null means a creator channel exists for the row, which is what an older build's insert
   * leaves and what the sweep restores a row to. A default would put every new row on the
   * grace clock the moment it was made.
   */
  it('stores the orphan stamp as nullable with no default', () => {
    expect(memberRoomPrefs.orphanedAt.notNull).toBe(false);
    expect(memberRoomPrefs.orphanedAt.hasDefault).toBe(false);
  });
});
