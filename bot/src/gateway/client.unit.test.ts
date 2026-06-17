import { ActivityType, GatewayIntentBits, Partials } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { buildGatewayClient } from './client.js';

describe('buildGatewayClient', () => {
  const client = buildGatewayClient({ totalShards: 1, shardIds: [0] });

  it('requests the presence + member intents the game-name feature needs', () => {
    expect(client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildVoiceStates)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
  });

  it('enables Partials.User so presence updates are not dropped with the user cache off', () => {
    // Regression: with UserManager cache disabled, discord.js's PRESENCE_UPDATE
    // handler bails unless it can construct the (partial) user — without this
    // partial, presence/game detection freezes at the GUILD_CREATE value.
    expect(client.options.partials).toContain(Partials.User);
  });

  it('advertises the /setup entry point in its presence', () => {
    const activity = client.options.presence?.activities?.[0];
    expect(activity?.type).toBe(ActivityType.Custom);
    // Custom-status text lives in `state`; assert the website + command are surfaced.
    expect(activity?.state).toContain('dotsbots.com');
    expect(activity?.state).toContain('/setup');
  });
});
