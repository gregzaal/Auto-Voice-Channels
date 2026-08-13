import { describe, expect, it } from 'vitest';
import { AUTH_STATUSES } from '../domain/auth.js';
import { FLEETS } from '../domain/fleets.js';
import {
  guilds,
  guildAuthEvents,
  guildFleetPresence,
  identifyBuckets,
  opsAudit,
  runtimeFlags,
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
