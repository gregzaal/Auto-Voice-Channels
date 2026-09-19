import { describe, expect, it } from 'vitest';
import {
  buildControlPanel,
  buildLimitModal,
  buildMemberPicker,
  buildRenameModal,
  CONTROL_PANEL_PREFIX,
  controlPanelId,
  parseControlPanelId,
} from './controlPanel.js';
import {
  CONTROL_PANEL_CONTROLS,
  readControlPanel,
  type ControlPanelConfig,
} from './guildSettings.js';

/** Everything on by default, which is what an unconfigured guild reads as. */
const allOn = (): ControlPanelConfig => readControlPanel({});

/** The custom ids on a built panel's buttons, in render order. */
function buttonIds(panel: ReturnType<typeof buildControlPanel>): string[] {
  return (panel?.components ?? []).flatMap((row) =>
    (row.toJSON().components as { custom_id: string }[]).map((c) => c.custom_id),
  );
}

describe('control panel custom ids', () => {
  it('builds and round-trips', () => {
    const id = controlPanelId('lock', 'room-1');
    expect(id).toBe(`${CONTROL_PANEL_PREFIX}lock:room-1`);
    expect(parseControlPanelId(id)).toEqual({ action: 'lock', roomId: 'room-1' });
  });

  it('rejects foreign and malformed ids', () => {
    expect(parseControlPanelId('avc:kick:room-1')).toBeNull();
    expect(parseControlPanelId('avc:info:summary:room-1')).toBeNull();
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}bogus:room-1`)).toBeNull();
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}lock:`)).toBeNull();
    expect(parseControlPanelId(`${CONTROL_PANEL_PREFIX}:room-1`)).toBeNull();
  });
});

describe('buildControlPanel', () => {
  it('shows every control by default, each with its own id', () => {
    const panel = buildControlPanel('room-1', allOn());
    expect(buttonIds(panel)).toEqual(
      CONTROL_PANEL_CONTROLS.map((c) => controlPanelId(c, 'room-1')),
    );
  });

  /**
   * The deliberate departure from re-rendering: the panel never changes with
   * the room, so both states are always offered and pressing the wrong one is
   * answered by the command's own refusal.
   */
  it('shows Lock and Unlock together rather than tracking the room state', () => {
    const ids = buttonIds(buildControlPanel('room-1', allOn()));
    expect(ids).toContain(controlPanelId('lock', 'room-1'));
    expect(ids).toContain(controlPanelId('unlock', 'room-1'));
  });

  it('leaves a switched-off control out entirely rather than disabling it', () => {
    const config = allOn();
    config.controls.kick = false;
    const panel = buildControlPanel('room-1', config);
    expect(buttonIds(panel)).not.toContain(controlPanelId('kick', 'room-1'));
    expect(JSON.stringify(panel)).not.toContain('"disabled":true');
  });

  it('is nothing at all when the panel is off, or every button is', () => {
    expect(buildControlPanel('room-1', { ...allOn(), enabled: false })).toBeNull();
    const none = allOn();
    for (const c of CONTROL_PANEL_CONTROLS) none.controls[c] = false;
    expect(buildControlPanel('room-1', none)).toBeNull();
  });

  it('never exceeds five buttons in a row', () => {
    const rows = buildControlPanel('room-1', allOn())!.components;
    for (const row of rows) {
      expect((row.toJSON().components as unknown[]).length).toBeLessThanOrEqual(5);
    }
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  /**
   * `/setup`'s rule (rewrite.md decision 11) arriving at its limit: eight peer
   * actions and none of them the thing to press, so no Success, no Primary and
   * no Danger. A green Lock beside a green Kick is how a panel stops guiding
   * anybody.
   */
  it('uses only Secondary buttons', () => {
    const json = JSON.stringify(buildControlPanel('room-1', allOn()));
    // ButtonStyle.Secondary is 2; Primary 1, Success 3, Danger 4.
    expect(json).not.toMatch(/"style":(1|3|4)/);
    expect(json).toMatch(/"style":2/);
  });
});

describe('control panel modals and pickers', () => {
  it('prefills the limit modal only with a real limit', () => {
    const withLimit = JSON.stringify(buildLimitModal('room-1', 4).toJSON());
    expect(withLimit).toContain('"value":"4"');
    // Zero is "no limit", so it prefills an empty box rather than a literal 0
    // the member would have to clear before typing.
    expect(JSON.stringify(buildLimitModal('room-1', 0).toJSON())).not.toContain('"value"');
    expect(JSON.stringify(buildLimitModal('room-1').toJSON())).not.toContain('"value"');
  });

  /**
   * The rename modal PROMISES that a blank submit resets the name, and
   * Discord refuses to submit a required field left blank, so marking it
   * required would make the placeholder a lie and strand the only way a
   * member has of clearing an override from the panel.
   */
  it('lets the rename modal be submitted blank, which is how a reset is done', () => {
    const json = buildRenameModal('room-1', 'den').toJSON();
    const input = (json.components as [{ components: [{ required?: boolean }] }])[0].components[0];
    expect(input.required ?? true).toBe(false);
    expect(JSON.stringify(json)).toContain('Leave blank');
  });

  it('carries the room in each modal id', () => {
    expect(buildLimitModal('room-1').toJSON().custom_id).toBe(controlPanelId('limitset', 'room-1'));
    expect(buildRenameModal('room-1').toJSON().custom_id).toBe(
      controlPanelId('renameset', 'room-1'),
    );
  });

  it('offers the members it was given, capped at the 25 Discord allows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`,
      displayName: `Member ${i}`,
    }));
    const row = buildMemberPicker('kickpick', 'room-1', many).toJSON();
    const select = (row.components as [{ custom_id: string; options: { value: string }[] }])[0];
    expect(select.custom_id).toBe(controlPanelId('kickpick', 'room-1'));
    expect(select.options).toHaveLength(25);
    expect(select.options[0]!.value).toBe('u0');
  });

  it('survives a nickname longer than Discord allows in an option label', () => {
    const row = buildMemberPicker('transferpick', 'room-1', [
      { id: 'u1', displayName: 'x'.repeat(300) },
    ]).toJSON();
    const select = (row.components as [{ options: { label: string }[] }])[0];
    expect(select.options[0]!.label.length).toBeLessThanOrEqual(100);
  });
});

/**
 * AGENTS.md's copy rules, over everything this module renders. Sentence case
 * and the creator-channel/room vocabulary are review-only, but the punctuation
 * rules are mechanical and nothing else checks the strings a member actually
 * reads here.
 */
describe('copy rules', () => {
  const rendered = (): string =>
    JSON.stringify([
      buildControlPanel('room-1', allOn()),
      buildLimitModal('room-1', 3).toJSON(),
      buildRenameModal('room-1', 'den').toJSON(),
      buildMemberPicker('kickpick', 'room-1', [{ id: 'u1', displayName: 'Ana' }]).toJSON(),
      buildMemberPicker('transferpick', 'room-1', [{ id: 'u1', displayName: 'Ana' }]).toJSON(),
    ]);

  it('uses no em or en dashes, curly quotes, or prose semicolons', () => {
    const text = rendered();
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/[‘’“”]/);
    expect(text).not.toMatch(/;/);
  });

  it('never says primary or secondary to a member', () => {
    const text = rendered().toLowerCase();
    expect(text).not.toContain('secondary');
    expect(text).not.toContain('primary');
  });
});
