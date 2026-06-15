import { describe, expect, it } from 'vitest';
import { AUTH_STATUSES } from '../domain/auth.js';
import { guilds, guildAuthEvents } from './schema.js';

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
