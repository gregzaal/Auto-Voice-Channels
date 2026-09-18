import { describe, expect, it } from 'vitest';
import { DROPPED_FIELDS, planGuild } from './legacy.js';

const GUILD = '460459401086763010';
const PRIMARY = '605724722902204416';

/**
 * Restoring the legacy "voice context" settings on import.
 *
 * Legacy's `text_channels` was one per-guild switch on a Gold-only feature; the
 * rewrite's is per creator channel. Turning it on for every creator channel the
 * same plan writes is the only reading that gives a returning guild back what it
 * had, and several paying customers depended on it.
 */
describe('legacy companion text settings', () => {
  const base = (extra: Record<string, unknown> = {}) => ({
    auto_channels: { [PRIMARY]: { template: 'Room', secondaries: {} } },
    ...extra,
  });

  it('turns the opt-in on for every creator channel when the guild had it', () => {
    const plan = planGuild(GUILD, base({ text_channels: true }));
    expect(plan.primaries[0]!.template.textChannel).toBe(true);
  });

  /**
   * Eight years of hand-edited files with no validation on the way in, so the
   * value is not reliably a boolean. `1` and `"true"` are the shapes seen in
   * adjacent keys, and reading either as "off" would silently restore nothing
   * for the guilds this migration exists for, with no dropped-field note to say
   * so, because the key is no longer in `DROPPED_FIELDS`.
   */
  it.each([true, 1, '1', 'true', 'True'])('accepts %p as on', (value) => {
    const plan = planGuild(GUILD, base({ text_channels: value }));
    expect(plan.primaries[0]!.template.textChannel).toBe(true);
  });

  it.each([false, 0, '', 'false', null, undefined])('treats %p as off', (value) => {
    const plan = planGuild(GUILD, base({ text_channels: value }));
    expect(plan.primaries[0]!.template.textChannel).toBeUndefined();
  });

  /**
   * Nothing is written when the guild never had the feature. Writing `false`
   * everywhere would put an explicit opt-out on thousands of creator channels
   * that never had an opinion, which is noise in every export and a claim about
   * a decision the guild never made.
   */
  it('writes nothing at all for a guild that never had it', () => {
    const plan = planGuild(GUILD, base());
    expect('textChannel' in plan.primaries[0]!.template).toBe(false);
    expect(plan.settings.text_channel_name).toBeUndefined();
    expect(plan.settings.text_channel_role).toBeUndefined();
  });

  it('carries the channel name and the moderator role', () => {
    const plan = planGuild(
      GUILD,
      base({ text_channels: true, text_channel_name: 'war room', stct: 601015720200896512 }),
    );
    expect(plan.settings.text_channel_name).toBe('war room');
    // Legacy stored snowflakes as JSON numbers; they are text here.
    expect(plan.settings.text_channel_role).toBe('601015720200896512');
  });

  /**
   * The legacy command took a role by NAME as well as by mention, so a stored
   * value that is not a snowflake cannot be resolved without the live guild.
   * Dropped rather than guessed: a wrong role id here grants a real role read
   * access to every private room conversation in the server.
   */
  it('drops a moderator role that is not a snowflake rather than guessing', () => {
    const plan = planGuild(GUILD, base({ text_channels: true, stct: 'Moderators' }));
    expect(plan.settings.text_channel_role).toBeUndefined();
    expect(plan.primaries[0]!.template.textChannel).toBe(true);
  });

  it('no longer reports the three keys as dropped', () => {
    const dropped = DROPPED_FIELDS as readonly string[];
    expect(dropped).not.toContain('text_channels');
    expect(dropped).not.toContain('text_channel_name');
    expect(dropped).not.toContain('stct');

    const plan = planGuild(
      GUILD,
      base({ text_channels: true, text_channel_name: 'x', stct: '1', custom_bitrates: {} }),
    );
    expect(plan.droppedFields).toEqual(['custom_bitrates']);
  });
});
