import { describe, expect, it } from 'vitest';
import { mergeIntoExisting } from './merge.js';

/**
 * The first-writer-wins policy (`plans/migration.md` §3.6).
 *
 * These are the cases that only exist because the importer runs three times
 * into one shared `guilds` table (beta, then prod at the cutover, then Gold).
 * Every one of them is silent under the old last-writer-wins behaviour: the
 * write succeeds, the row validates, and the guild is quietly reconfigured or
 * re-entitled by whichever dump happened to be imported last.
 */

const SETTINGS = {
  enabled: true,
  general: 'General',
  channel_name_template: '## [@@game_name@@]',
  aliases: { valorant: 'Valorant' },
  log_level: 3,
};

describe('mergeIntoExisting', () => {
  it('passes everything through for a guild nobody has imported yet', () => {
    const plan = mergeIntoExisting(SETTINGS, undefined);
    expect(plan.settingsPatch).toEqual(SETTINGS);
    expect(plan.writeTrial).toBe(true);
    expect(plan.existed).toBe(false);
    expect(plan.keptStatus).toBeNull();
    expect(plan.keptSettingKeys).toEqual([]);
  });

  it('never overwrites a setting the guild already has', () => {
    const plan = mergeIntoExisting(SETTINGS, {
      authStatus: 'trial',
      settings: { channel_name_template: 'set through /template', log_level: 1 },
    });
    expect(plan.settingsPatch).not.toHaveProperty('channel_name_template');
    expect(plan.settingsPatch).not.toHaveProperty('log_level');
    expect(plan.keptSettingKeys).toContain('channel_name_template');
    expect(plan.keptSettingKeys).toContain('log_level');
  });

  it('still fills in the keys the guild has no value for', () => {
    const plan = mergeIntoExisting(SETTINGS, {
      authStatus: 'trial',
      settings: { channel_name_template: 'kept' },
    });
    expect(plan.settingsPatch.general).toBe('General');
    expect(plan.settingsPatch.enabled).toBe(true);
  });

  /**
   * `updateSettings` merges only at the top level, so treating `aliases` as a
   * scalar would drop every alias in the other dump the moment the guild had
   * one of its own. Both dumps are real configuration that a real admin typed.
   */
  it('unions aliases entry by entry, keeping the stored value on a clash', () => {
    const plan = mergeIntoExisting(
      { aliases: { valorant: 'From the dump', apex: 'Apex Legends' } },
      { authStatus: 'trial', settings: { aliases: { valorant: 'Already here' } } },
    );
    expect(plan.settingsPatch.aliases).toEqual({
      valorant: 'Already here',
      apex: 'Apex Legends',
    });
  });

  it('unions custom_nicks the same way', () => {
    const plan = mergeIntoExisting(
      { custom_nicks: { '1': 'dump', '2': 'new' } },
      { authStatus: 'trial', settings: { custom_nicks: { '1': 'stored' } } },
    );
    expect(plan.settingsPatch.custom_nicks).toEqual({ '1': 'stored', '2': 'new' });
  });

  /**
   * A no-op write is not free. This runs across thousands of guilds, twice at
   * the cutover (bulk then delta) and again for the next fleet.
   */
  it('writes nothing when the union would add nothing', () => {
    const plan = mergeIntoExisting(
      { aliases: { valorant: 'From the dump' } },
      { authStatus: 'trial', settings: { aliases: { valorant: 'Already here' } } },
    );
    expect(plan.settingsPatch).toEqual({});
    expect(plan.keptSettingKeys).toEqual(['aliases']);
  });

  it('treats a non-dict stored value as a scalar rather than unioning into it', () => {
    const plan = mergeIntoExisting(
      { aliases: { valorant: 'Valorant' } },
      { authStatus: 'trial', settings: { aliases: 'corrupt' } },
    );
    expect(plan.settingsPatch).toEqual({});
    expect(plan.keptSettingKeys).toEqual(['aliases']);
  });

  it('writes the trial clock for a guild that is already on trial', () => {
    const plan = mergeIntoExisting(SETTINGS, { authStatus: 'trial', settings: {} });
    expect(plan.writeTrial).toBe(true);
    expect(plan.keptStatus).toBeNull();
  });

  /**
   * The four statuses the importer must not overrule. Each is a different way
   * for a re-import to hand out something nobody decided to give:
   * `active` is a paying customer downgraded to a trial, `grace` and `expired`
   * are positions in the leniency ladder reset to a fresh year, and `blocked`
   * is the per-guild kill-switch turned off.
   */
  for (const status of ['active', 'grace', 'expired', 'blocked'] as const) {
    it(`leaves a ${status} guild's status and clock alone`, () => {
      const plan = mergeIntoExisting(SETTINGS, { authStatus: status, settings: {} });
      expect(plan.writeTrial).toBe(false);
      expect(plan.keptStatus).toBe(status);
    });
  }

  /**
   * Settings and status are independent axes. A blocked guild's config is still
   * worth filling in: unblocking is a separate decision, and when it happens
   * the guild should have its creator channels rather than nothing.
   */
  it('still fills settings gaps for a guild whose status it leaves alone', () => {
    const plan = mergeIntoExisting(SETTINGS, { authStatus: 'blocked', settings: {} });
    expect(plan.writeTrial).toBe(false);
    expect(plan.settingsPatch).toEqual(SETTINGS);
  });

  /**
   * An alias is a user-typed game name, so nothing stops one being called
   * `constructor`. Reading `existing[k] === undefined` resolves that up the
   * prototype chain, so the key looks present, the union looks empty, and the
   * dump's entry is discarded while the report claims the whole key was kept.
   */
  it('does not mistake a prototype property for a stored alias', () => {
    const plan = mergeIntoExisting(
      { aliases: { constructor: 'Constructor Simulator' } },
      { authStatus: 'trial', settings: { aliases: {} } },
    );
    expect(plan.settingsPatch.aliases).toEqual({ constructor: 'Constructor Simulator' });
  });

  /**
   * The delta pass (`migration.md` §6 step 3). Gap-filling makes it a no-op for
   * exactly the settings it exists to apply, because the bulk pass hours earlier
   * is now the first writer.
   */
  describe('overwrite (the delta pass)', () => {
    it('takes the dump over what is stored', () => {
      const plan = mergeIntoExisting(
        { general: 'Changed since the bulk pass' },
        { authStatus: 'trial', settings: { general: 'From the bulk pass' } },
        { overwrite: true },
      );
      expect(plan.settingsPatch.general).toBe('Changed since the bulk pass');
      expect(plan.keptSettingKeys).toEqual([]);
    });

    /**
     * The line `overwrite` must not cross. A dump is authoritative about
     * configuration and never about whether someone is paying.
     */
    for (const status of ['active', 'grace', 'expired', 'blocked'] as const) {
      it(`still refuses to touch a ${status} guild's status`, () => {
        const plan = mergeIntoExisting(
          SETTINGS,
          { authStatus: status, settings: {} },
          {
            overwrite: true,
          },
        );
        expect(plan.writeTrial).toBe(false);
        expect(plan.keptStatus).toBe(status);
      });
    }
  });

  /**
   * What actually survives any import order. The scalar *values* do not, and
   * first-writer-wins is order-dependent on a clash by construction -- it is
   * chosen for being unable to damage what a live fleet is serving, not for
   * commutativity. What no order can lose is a key or an alias.
   */
  it('loses no key and no alias whichever dump runs first', () => {
    const a = { general: 'A', aliases: { x: 'ax' }, log_level: 1 };
    const b = { general: 'B', aliases: { y: 'by' }, channel_name_template: 'T' };

    const applyBoth = (
      first: Record<string, unknown>,
      second: Record<string, unknown>,
    ): Record<string, unknown> => {
      const one = mergeIntoExisting(first, undefined).settingsPatch;
      // `updateSettings` is a shallow `||`, which is what this models.
      const two = mergeIntoExisting(second, { authStatus: 'trial', settings: one }).settingsPatch;
      return { ...one, ...two };
    };

    // The values differ by order (whoever is first wins, by design), but the
    // KEY SET does not, and no key is ever lost.
    const ab = applyBoth(a, b);
    const ba = applyBoth(b, a);
    expect(Object.keys(ab).sort()).toEqual(Object.keys(ba).sort());
    expect(ab.aliases).toEqual({ x: 'ax', y: 'by' });
    expect(ba.aliases).toEqual({ x: 'ax', y: 'by' });
  });
});
